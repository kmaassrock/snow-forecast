// Forecast engine shared by the website (app.js) and the powder-alert job
// (scripts/alerts.cjs): fetches models from Open-Meteo, applies station-based
// calibration, converts snow water to snow depth with a temperature-based
// ratio, and groups it into ski days.

const CFG = typeof RESORTS !== 'undefined' ? { RESORTS, LIFTS_OPEN, LIFTS_CLOSE } : require('./resorts.js');

const PAST_DAYS = 3;
const FORECAST_DAYS = 15;

// weight(leadHours) is the prior; calibration multiplies it by measured skill.
const MODELS = [
  { id: 'ncep_hrrr_conus', name: 'HRRR', note: '3 km · 2 days', weight: (h) => (h < 24 ? 2 : 1.5) },
  { id: 'ncep_nbm_conus', name: 'NBM', note: '2.5 km · 11 days', weight: () => 1.5 },
  { id: 'ecmwf_ifs', name: 'ECMWF', note: '9 km · 15 days', weight: () => 1.5 },
  { id: 'gfs_global', name: 'GFS', note: '13 km · 16 days', weight: () => 1 },
  { id: 'gem_seamless', name: 'Canadian', note: '2.5–15 km · 10 days', weight: () => 1 },
  { id: 'icon_seamless', name: 'ICON', note: '13 km · 7 days', weight: () => 1 },
  { id: 'ukmo_seamless', name: 'UKMO', note: '10 km · 7 days', weight: () => 1 },
  // AI models: shown for reference but left out of the blend, because adding them
  // didn't improve backtested errors (AIFS since Feb 2025, AIGFS since Jan 2026).
  // AIGFS is hidden at Whistler: it has too little history to calibrate, and there it
  // runs ~2x wetter than the corrected models. Retest after the 2026–27 winter.
  { id: 'ecmwf_aifs025_single', name: 'ECMWF AI', note: 'AIFS · reference only', weight: () => 0, ref: true },
  { id: 'ncep_aigfs025', name: 'NOAA AI', note: 'AIGFS · reference only', weight: () => 0, ref: true, hideAt: ['whistler'] },
];

// Ensemble members borrow the calibration of their parent model.
const ENSEMBLE_PARENT = { ncep_gefs_seamless: 'gfs_global', ecmwf_ifs025_ensemble: 'ecmwf_ifs' };

const HOURLY_VARS = [
  'temperature_2m', 'precipitation', 'snowfall', 'temperature_700hPa', 'freezing_level_height',
  'cloud_cover', 'wind_speed_10m', 'wind_gusts_10m', 'wind_direction_10m', 'apparent_temperature',
  'relative_humidity_2m',
];

// ---------- snow physics ----------

// Kuchera snow-to-liquid ratio from the warmest temperature in the column (°C).
function snowRatio(tMaxC, windMph) {
  const tK = tMaxC + 273.15;
  let slr = tK > 271.16 ? 12 + (271.16 - tK) : 12 + 2 * (271.16 - tK);
  slr = Math.min(25, Math.max(4, slr));
  // Strong winds fracture flakes and pack snow denser.
  if (windMph > 15) slr *= Math.max(0.75, 1 - (windMph - 15) * 0.01);
  return slr;
}

// Open-Meteo's snowfall (cm) is snow water (mm) × 0.7, so this recovers the water.
const snowWaterMm = (snowfallCm, precipMm) => Math.min(snowfallCm / 0.7, precipMm ?? Infinity);

function snowType(slr) {
  if (slr < 8) return { label: 'Heavy, wet', cls: 't-wet' };
  if (slr < 11.5) return { label: 'Medium density', cls: 't-med' };
  if (slr < 15) return { label: 'Light', cls: 't-light' };
  return { label: 'Light & dry powder', cls: 't-dry' };
}

// ---------- helpers ----------

const cToF = (c) => (c * 9) / 5 + 32;
const mToFt = (m) => m * 3.28084;
const mmToIn = (mm) => mm / 25.4;
const sum = (a) => a.reduce((s, x) => s + x, 0);
const avg = (a) => (a.length ? sum(a) / a.length : null);
const addDays = (date, n) => new Date(Date.parse(date + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const i = (sorted.length - 1) * p;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

function nowLocalHour(tz) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date());
  const g = (t) => parts.find((p) => p.type === t).value;
  return `${g('year')}-${g('month')}-${g('day')}T${g('hour')}:00`;
}

// Snow after lifts close counts toward the next ski day.
const skiDate = (time) => (+time.slice(11, 13) >= CFG.LIFTS_CLOSE ? addDays(time.slice(0, 10), 1) : time.slice(0, 10));

// ---------- data fetch ----------

async function fetchJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json();
}

// lean: only what snow totals need (blend models, 5 variables, 8 days), about a
// quarter of the API cost, for ranking every resort in the background job.
const LEAN_VARS = ['temperature_2m', 'precipitation', 'snowfall', 'temperature_700hPa', 'wind_speed_10m'];
function fetchDeterministic(resort, elevM, lean = false) {
  const q = new URLSearchParams({
    latitude: resort.lat, longitude: resort.lon, elevation: elevM,
    hourly: (lean ? LEAN_VARS : HOURLY_VARS).join(','),
    models: MODELS.filter((m) => (!lean || !m.ref) && !m.hideAt?.includes(resort.id)).map((m) => m.id).join(','),
    forecast_days: lean ? 8 : FORECAST_DAYS, past_days: lean ? 1 : PAST_DAYS, timezone: resort.tz, wind_speed_unit: 'mph',
  });
  return fetchJSON(`https://api.open-meteo.com/v1/forecast?${q}`);
}

function fetchEnsemble(resort, elevM) {
  const q = new URLSearchParams({
    latitude: resort.lat, longitude: resort.lon, elevation: elevM,
    hourly: 'temperature_2m,precipitation,snowfall,wind_speed_10m', models: 'gfs_seamless,ecmwf_ifs025',
    forecast_days: FORECAST_DAYS, past_days: PAST_DAYS, timezone: resort.tz, wind_speed_unit: 'mph',
  });
  return fetchJSON(`https://ensemble-api.open-meteo.com/v1/ensemble?${q}`);
}

// ---------- processing ----------

function processModels(data, nowKey, calib) {
  const h = data.hourly;
  const times = h.time;
  const nowIdx = Math.max(0, times.indexOf(nowKey));
  const get = (v, m, i) => h[`${v}_${m}`]?.[i] ?? null;

  return times.map((t, i) => {
    const lead = Math.max(0, i - nowIdx);
    const perModel = {}, perRain = {};
    const acc = { w: 0, snow: 0, swe: 0, rain: 0, temp: 0, feels: 0, rh: 0, wind: 0, gust: 0, cloud: 0, u: 0, v: 0 };
    const fl = [];
    for (const m of MODELS) {
      const precipRaw = get('precipitation', m.id, i);
      const sf = get('snowfall', m.id, i);
      const t2 = get('temperature_2m', m.id, i);
      if (precipRaw == null || sf == null || t2 == null) continue;
      const cal = calib?.models?.[m.id];
      const k = cal?.ratio ?? 1;
      const precip = precipRaw * k;
      const t7 = get('temperature_700hPa', m.id, i);
      const wind = get('wind_speed_10m', m.id, i) ?? 0;
      const swe = snowWaterMm(sf, precipRaw) * k;
      const slr = snowRatio(t7 == null ? t2 : Math.max(t2, t7), wind);
      const snow = mmToIn(swe) * slr;
      perModel[m.id] = snow;
      perRain[m.id] = mmToIn(Math.max(0, precip - swe));
      if (m.ref) continue; // reference-only models don't feed the blend

      const w = m.weight(lead) * (cal?.weight ?? 1);
      acc.w += w;
      acc.snow += w * snow;
      acc.swe += w * swe;
      acc.rain += w * Math.max(0, precip - swe);
      acc.temp += w * t2;
      acc.feels += w * (get('apparent_temperature', m.id, i) ?? t2);
      acc.rh += w * (get('relative_humidity_2m', m.id, i) ?? 0);
      acc.wind += w * wind;
      acc.gust += w * (get('wind_gusts_10m', m.id, i) ?? wind);
      acc.cloud += w * (get('cloud_cover', m.id, i) ?? 0);
      const dir = get('wind_direction_10m', m.id, i);
      if (dir != null) {
        acc.u += w * wind * Math.sin((dir * Math.PI) / 180);
        acc.v += w * wind * Math.cos((dir * Math.PI) / 180);
      }
      const f = get('freezing_level_height', m.id, i);
      if (f != null) fl.push(f);
    }
    const base = { time: t, date: t.slice(0, 10), skiDate: skiDate(t), hour: +t.slice(11, 13), past: i < nowIdx, perModel, perRain };
    if (!acc.w) return { ...base, empty: true };
    const W = acc.w;
    return {
      ...base, nModels: MODELS.filter((m) => !m.ref && m.id in perModel).length,
      feelsF: cToF(acc.feels / W), rh: acc.rh / W,
      snow: acc.snow / W, swe: acc.swe / W, rain: acc.rain / W,
      tempF: cToF(acc.temp / W), wind: acc.wind / W, gust: acc.gust / W, cloud: acc.cloud / W,
      dir: ((Math.atan2(acc.u, acc.v) * 180) / Math.PI + 360) % 360,
      freezeFt: fl.length ? mToFt(avg(fl)) : null,
    };
  });
}

// Ski-day snow totals for each ensemble member: { skiDate: { memberKey: total } }
function processEnsemble(data, calib) {
  const h = data.hourly;
  const out = {};
  for (const key of Object.keys(h)) {
    const m = key.match(/^snowfall(_member\d+)?_(.+)$/);
    if (!m) continue;
    const suffix = (m[1] || '') + '_' + m[2];
    const k = calib?.models?.[ENSEMBLE_PARENT[m[2]]]?.ratio ?? 1;
    const sf = h[key], pr = h['precipitation' + suffix], t2 = h['temperature_2m' + suffix], ws = h['wind_speed_10m' + suffix];
    if (!pr || !t2) continue;
    const daily = {}, count = {};
    for (let i = 0; i < sf.length; i++) {
      if (sf[i] == null || t2[i] == null) continue;
      const d = skiDate(h.time[i]);
      daily[d] = (daily[d] || 0) + mmToIn(snowWaterMm(sf[i], pr[i]) * k) * snowRatio(t2[i], ws?.[i] ?? 0);
      count[d] = (count[d] || 0) + 1;
    }
    for (const d of Object.keys(daily)) {
      if (count[d] < 18) continue; // ignore partial days at the end of a member's range
      (out[d] ||= {})[suffix] = daily[d];
    }
  }
  return out;
}

// Chance of precipitation from the ensemble: share of members with measurable
// precipitation in each hour (≥ 0.1 mm) and in each ski day (≥ 0.25 mm, i.e. 0.01").
function ensembleChance(data) {
  const h = data.hourly;
  const members = Object.keys(h).filter((k) => /^precipitation(_member\d+)?_/.test(k));
  const hour = {}, day = {};
  h.time.forEach((t, i) => {
    const vals = members.map((k) => h[k][i]).filter((v) => v != null);
    if (vals.length >= 10) hour[t] = Math.round((100 * vals.filter((v) => v >= 0.1).length) / vals.length);
  });
  const totals = members.map((k) => {
    const byDay = {};
    h.time.forEach((t, i) => { if (h[k][i] != null) byDay[skiDate(t)] = (byDay[skiDate(t)] || 0) + h[k][i]; });
    return byDay;
  });
  for (const d of new Set(h.time.map(skiDate))) {
    const vals = totals.map((b) => b[d]).filter((v) => v != null);
    if (vals.length >= 10) day[d] = Math.round((100 * vals.filter((v) => v >= 0.25).length) / vals.length);
  }
  return { hour, day };
}

// The spread around the median is stretched by blend/median (capped) and centred on the blend.
function scaledRange(blend, members) {
  const vals = members ? Object.values(members) : [];
  if (vals.length < 10) return null;
  const s = vals.sort((a, b) => a - b);
  const p10 = percentile(s, 0.1), p50 = percentile(s, 0.5), p90 = percentile(s, 0.9);
  const f = p50 >= 0.3 ? Math.min(1.5, Math.max(0.5, blend / p50)) : 1;
  const lo = Math.max(0, blend - (p50 - p10) * f);
  const hi = blend + (p90 - p50) * f;
  return { lo, hi, p50, n: s.length };
}

function buildDays(hours, ens, todayStr) {
  const bySki = new Map(), byCal = new Map();
  for (const h of hours) {
    if (h.empty) continue;
    if (!bySki.has(h.skiDate)) bySki.set(h.skiDate, []);
    bySki.get(h.skiDate).push(h);
    if (!byCal.has(h.date)) byCal.set(h.date, []);
    byCal.get(h.date).push(h);
  }
  const days = [];
  for (const [date, hs] of bySki) {
    const cal = byCal.get(date);
    if (hs.length < 18 || !cal || cal.length < 12) continue;
    const overnight = hs.filter((h) => h.date !== date || h.hour < CFG.LIFTS_OPEN);
    const lifts = hs.filter((h) => h.date === date && h.hour >= CFG.LIFTS_OPEN);
    const snow = sum(hs.map((h) => h.snow));
    const swe = sum(hs.map((h) => h.swe));
    const rainIn = mmToIn(sum(hs.map((h) => h.rain)));
    const slr = swe > 0.25 ? snow / mmToIn(swe) : null;

    // Weather uses the calendar day; wind and cloud focus on lift hours.
    const open = cal.filter((h) => h.hour >= CFG.LIFTS_OPEN && h.hour < CFG.LIFTS_CLOSE);
    const temps = cal.map((h) => h.tempF);
    const precipHours = hs.filter((h) => h.swe + h.rain > 0.1 && h.freezeFt != null);
    const flHours = (precipHours.length ? precipHours : cal).filter((h) => h.freezeFt != null);

    const perModel = {};
    for (const m of MODELS) {
      const vals = hs.map((h) => h.perModel[m.id]).filter((x) => x != null);
      if (vals.length >= 18) perModel[m.id] = sum(vals);
    }
    const mv = MODELS.filter((m) => !m.ref && m.id in perModel).map((m) => perModel[m.id]);

    days.push({
      date, hours: hs, past: date < todayStr, snow, swe, rainIn, slr,
      overnight: sum(overnight.map((h) => h.snow)), lifts: sum(lifts.map((h) => h.snow)),
      hi: Math.max(...temps), lo: Math.min(...temps),
      feelsHi: Math.max(...cal.map((h) => h.feelsF)), feelsLo: Math.min(...cal.map((h) => h.feelsF)),
      rh: avg(open.map((h) => h.rh)) ?? avg(cal.map((h) => h.rh)),
      wind: avg(open.map((h) => h.wind)) ?? avg(cal.map((h) => h.wind)),
      gust: Math.max(...cal.map((h) => h.gust)),
      dir: avg(open.map((h) => h.dir)) ?? avg(cal.map((h) => h.dir)),
      cloud: avg(open.map((h) => h.cloud)) ?? avg(cal.map((h) => h.cloud)),
      snowLevel: flHours.length ? avg(flHours.map((h) => h.freezeFt)) - 1000 : null,
      perModel, nModels: mv.length,
      modelMin: mv.length ? Math.min(...mv) : null, modelMax: mv.length ? Math.max(...mv) : null,
      range: scaledRange(snow, ens[date]),
    });
  }
  return days.sort((a, b) => (a.date < b.date ? -1 : 1));
}

function confidence(day, leadDays) {
  if (day.past) return null;
  const r = day.range;
  const spread = r ? (r.hi - r.lo) / Math.max(1, day.snow) : 1;
  if (leadDays <= 2 && spread < 1.2) return 'High';
  if (leadDays <= 6 && spread < 2) return 'Medium';
  return 'Low';
}

// Period totals with ranges from per-member sums.
function periodTotal(days, ens, from, to) {
  const ds = days.slice(Math.max(0, from), to + 1);
  if (!ds.length) return null;
  const snow = sum(ds.map((d) => d.snow));
  // Only members that cover every day in the period.
  const maps = ds.map((d) => ens[d.date] || {});
  const keys = Object.keys(maps[0]).filter((k) => maps.every((m) => k in m));
  const members = Object.fromEntries(keys.map((k) => [k, sum(maps.map((m) => m[k]))]));
  return { snow, range: scaledRange(snow, members), first: ds[0].date, last: ds[ds.length - 1].date };
}

// Full forecast for one resort and elevation. { ensemble: false } skips the
// ensemble request (no uncertainty ranges) for lightweight overviews; { lean: true }
// also trims the model request to snow totals only (see fetchDeterministic).
async function getForecast(resort, elevM, calib, { ensemble = true, lean = false } = {}) {
  const [det, ensRaw] = await Promise.all([
    fetchDeterministic(resort, elevM, lean),
    ensemble ? fetchEnsemble(resort, elevM).catch((e) => { console.warn('Ensemble failed', e); return null; }) : null,
  ]);
  const nowKey = nowLocalHour(resort.tz);
  const todayStr = nowKey.slice(0, 10);
  const hours = processModels(det, nowKey, calib);
  const ens = ensRaw ? processEnsemble(ensRaw, calib) : {};
  const chance = ensRaw ? ensembleChance(ensRaw) : { hour: {}, day: {} };
  for (const h of hours) h.pop = chance.hour[h.time] ?? null;
  const days = buildDays(hours, ens, todayStr);
  for (const d of days) d.pop = chance.day[d.date] ?? null;
  return { days, ens, todayStr, hasEnsemble: !!ensRaw };
}

if (typeof module !== 'undefined') {
  module.exports = { MODELS, FORECAST_DAYS, getForecast, periodTotal, snowType, mmToIn, sum, addDays, nowLocalHour };
}
