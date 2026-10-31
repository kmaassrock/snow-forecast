#!/usr/bin/env node
// Compares each model's archived short-range forecasts against what nearby
// stations measured over past winters, then writes data/calibration.json with
// a per-model precipitation correction factor and a skill-based blend weight.
// Resorts without a station borrow the nearest calibrated resort's numbers.
//
//   node scripts/calibrate.cjs                  # every resort
//   CALIBRATE_MAX=15 node scripts/calibrate.cjs  # only the 15 stalest (stays within free API limits)

const fs = require('fs');
const path = require('path');
const { RESORTS } = require('../resorts.js');
const { MODELS } = require('../core.js');

const START = '2022-11-01';
const END = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10); // archive lags a day or two
const IN_SEASON = (d) => { const m = +d.slice(5, 7); return m >= 11 || m <= 4; };

async function getJSON(url) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetch(url);
    if (r.ok) return r.json();
    if (r.status === 429) { await new Promise((ok) => setTimeout(ok, 60000)); continue; }
    if (r.status >= 500) { await new Promise((ok) => setTimeout(ok, 5000 * (attempt + 1))); continue; }
    throw new Error(`${r.status} ${url}\n${await r.text()}`);
  }
  throw new Error(`rate limited: ${url}`);
}

const addDay = (d, n = 1) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);

// Observed daily precipitation (mm) keyed by local date.
async function observed(st) {
  const out = {};
  if (st.source === 'snotel') {
    const q = new URLSearchParams({ stationTriplets: st.id, elements: 'PREC,WTEQ', duration: 'DAILY', beginDate: addDay(START, -1), endDate: END });
    const data = await getJSON(`https://wcc.sc.egov.usda.gov/awdbRestApi/services/v1/data?${q}`);
    const series = {};
    for (const el of data[0].data) series[el.stationElement.elementCode] = Object.fromEntries(el.values.map((v) => [v.date, v.value]));
    // SNOTEL daily values are end-of-day readings, so day D's precip is reading(D) - reading(D-1).
    // The gauge undercatches wind-blown snow, so take the larger of gauge and snow-pillow gain.
    for (const d of Object.keys(series.PREC || {})) {
      const n = d, pv = addDay(d, -1);
      const g = series.PREC[pv] != null ? series.PREC[n] - series.PREC[pv] : null;
      const p = series.WTEQ?.[n] != null && series.WTEQ?.[pv] != null ? series.WTEQ[n] - series.WTEQ[pv] : null;
      if (g == null || g < 0 || g > 5) continue; // gauge resets / bad readings
      out[d] = Math.max(g, p > 0 && p < 5 ? p : 0) * 25.4;
    }
  } else if (st.source === 'eccc') {
    const q = new URLSearchParams({ f: 'json', CLIMATE_IDENTIFIER: st.id, datetime: `${START}/${END}`, limit: '10000', properties: 'LOCAL_DATE,TOTAL_PRECIPITATION' });
    const data = await getJSON(`https://api.weather.gc.ca/collections/climate-daily/items?${q}`);
    for (const f of data.features) {
      const v = f.properties.TOTAL_PRECIPITATION;
      if (v != null) out[f.properties.LOCAL_DATE.slice(0, 10)] = v;
    }
  }
  return out;
}

async function modeled(st, tz) {
  const q = new URLSearchParams({
    latitude: st.lat, longitude: st.lon, elevation: st.elev, start_date: START, end_date: END,
    daily: 'precipitation_sum', models: MODELS.map((m) => m.id).join(','), timezone: tz,
  });
  const data = await getJSON(`https://historical-forecast-api.open-meteo.com/v1/forecast?${q}`);
  const out = {};
  for (const m of MODELS) {
    const v = data.daily[`precipitation_sum_${m.id}`];
    if (!v) continue;
    out[m.id] = Object.fromEntries(data.daily.time.map((t, i) => [t, v[i]]).filter(([, x]) => x != null));
  }
  return out;
}

function pearson(a, b) {
  const n = a.length, ma = a.reduce((s, x) => s + x, 0) / n, mb = b.reduce((s, x) => s + x, 0) / n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2; }
  return sab / Math.sqrt(saa * sbb);
}

// Several resorts share a station, so fetch each station once per run.
const stationData = new Map();
function station(st, tz) {
  const key = `${st.id}|${tz}`;
  if (!stationData.has(key)) stationData.set(key, Promise.all([observed(st), modeled(st, tz)]));
  return stationData.get(key);
}

const km = (a, b, c, d) => 6371 * 2 * Math.asin(Math.sqrt(Math.sin(((c - a) * Math.PI) / 360) ** 2 + Math.cos((a * Math.PI) / 180) * Math.cos((c * Math.PI) / 180) * Math.sin(((d - b) * Math.PI) / 360) ** 2));
const BORROW_KM = 80;

async function calibrateResort(resort) {
  const rows = []; // { obs, mod: { modelId: mm } } per station-day
  for (const st of resort.stations) {
    const [obs, mod] = await station(st, resort.tz);
    for (const d of Object.keys(obs)) {
      if (!IN_SEASON(d)) continue;
      const row = { obs: obs[d], mod: {} };
      for (const [mid, series] of Object.entries(mod)) if (series[d] != null) row.mod[mid] = series[d];
      rows.push(row);
    }
  }
  const models = {};
  for (const m of MODELS) {
    const p = rows.filter((r) => m.id in r.mod);
    if (p.length < 120) continue;
    const obs = p.map((x) => x.obs), mod = p.map((x) => x.mod[m.id]);
    const ratio = Math.min(2, Math.max(0.6, obs.reduce((s, x) => s + x, 0) / mod.reduce((s, x) => s + x, 0)));
    const corrected = mod.map((x) => x * ratio);
    const wet = p.map((_, i) => i).filter((i) => obs[i] > 1 || mod[i] > 1);
    const mae = wet.reduce((s, i) => s + Math.abs(obs[i] - corrected[i]), 0) / wet.length;
    models[m.id] = { ratio: +ratio.toFixed(3), r: +pearson(obs, mod).toFixed(3), maeMm: +mae.toFixed(2), days: p.length };
  }
  // Skill weight: r² relative to the best model at this resort, floored so no model is ignored.
  const best = Math.max(...Object.values(models).map((x) => x.r ** 2));
  for (const x of Object.values(models)) x.weight = +Math.max(0.25, (x.r ** 2) / best).toFixed(3);

  // The archive keeps only HRRR's first forecast hour, when it is still spinning up
  // precipitation, so its measured ratio is too low. Use the other models' average instead.
  const hrrr = models.ncep_hrrr_conus;
  if (hrrr) {
    const refs = MODELS.filter((m) => m.ref).map((m) => m.id);
    const others = Object.entries(models).filter(([id]) => id !== 'ncep_hrrr_conus' && !refs.includes(id)).map(([, x]) => x.ratio);
    hrrr.measuredRatio = hrrr.ratio;
    hrrr.ratio = +(others.reduce((s, x) => s + x, 0) / others.length).toFixed(3);
  }

  return {
    updated: new Date().toISOString().slice(0, 10), stations: resort.stations.map((s) => s.name),
    period: `${START} to ${END} (Nov–Apr)`, models, check: blendCheck(rows, models),
  };
}

// Daily error of a plain equal-weight average of raw models vs the calibrated weighted blend.
function blendCheck(rows, models) {
  const ids = Object.keys(models).filter((id) => id !== 'ncep_hrrr_conus' && !MODELS.find((m) => m.id === id)?.ref);
  let n = 0, obsSum = 0, rawSum = 0, calSum = 0, rawErr = 0, calErr = 0;
  for (const r of rows) {
    const have = ids.filter((id) => id in r.mod);
    if (have.length < 3) continue;
    const raw = have.reduce((s, id) => s + r.mod[id], 0) / have.length;
    const W = have.reduce((s, id) => s + models[id].weight, 0);
    const cal = have.reduce((s, id) => s + models[id].weight * models[id].ratio * r.mod[id], 0) / W;
    obsSum += r.obs; rawSum += raw; calSum += cal;
    if (r.obs > 1 || raw > 1 || cal > 1) { n++; rawErr += Math.abs(raw - r.obs); calErr += Math.abs(cal - r.obs); }
  }
  return {
    wetDays: n,
    rawPctOfObserved: Math.round((100 * rawSum) / obsSum),
    calibratedPctOfObserved: Math.round((100 * calSum) / obsSum),
    rawMaeMm: +(rawErr / n).toFixed(2),
    calibratedMaeMm: +(calErr / n).toFixed(2),
  };
}

(async () => {
  const file = path.join(__dirname, '..', 'data', 'calibration.json');
  const prev = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).resorts : {};
  const out = { generated: new Date().toISOString().slice(0, 10), resorts: {} };
  for (const r of RESORTS) if (prev[r.id] && !prev[r.id].borrowedFrom && r.stations.length) out.resorts[r.id] = prev[r.id];

  // Never-calibrated resorts first, then the stalest.
  const max = +(process.env.CALIBRATE_MAX || Infinity);
  const todo = RESORTS.filter((r) => r.stations.length)
    .sort((a, b) => (out.resorts[a.id]?.updated || '').localeCompare(out.resorts[b.id]?.updated || ''))
    .slice(0, max);
  for (const r of todo) {
    try {
      out.resorts[r.id] = await calibrateResort(r);
      const k = out.resorts[r.id].check;
      console.log(`${r.name.padEnd(32)} raw ${k.rawPctOfObserved}% → calibrated ${k.calibratedPctOfObserved}% of observed`);
    } catch (e) {
      console.error(`${r.name}: ${e.message.split('\n')[0]}`);
    }
  }

  for (const r of RESORTS) {
    if (r.stations.length) continue;
    let best = null;
    for (const o of RESORTS) {
      const c = out.resorts[o.id];
      if (!c || c.borrowedFrom) continue;
      const d = km(r.lat, r.lon, o.lat, o.lon);
      if (d <= BORROW_KM && (!best || d < best.d)) best = { o, c, d };
    }
    if (best) {
      out.resorts[r.id] = { ...best.c, borrowedFrom: best.o.name };
      console.log(`${r.name.padEnd(32)} borrows ${best.o.name} (${Math.round(best.d)} km)`);
    } else console.log(`${r.name.padEnd(32)} no station within ${BORROW_KM} km: uncalibrated`);
  }

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
  process.stderr.write(`Wrote ${file}\n`);
})();
