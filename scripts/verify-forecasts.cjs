#!/usr/bin/env node
// Daily forecast scorekeeping (runs every morning, .github/workflows/verify.yml):
//  1. Logs today's raw (uncorrected) blend forecast of daily precipitation water at
//     every SNOTEL station, 1–15 days ahead: data/forecast-log/<date>.json.
//  2. Scores earlier logs against what each station measured, by days ahead.
//  3. Writes data/lead-bias.json: the correction factors core.js applies. A lead
//     time switches from the backtest starting factor to its measured factor once
//     it has MIN_DAYS snowy station-days scored.
//
//   node scripts/verify-forecasts.cjs

const fs = require('fs');
const path = require('path');
const { RESORTS } = require('../resorts.js');
const { getForecast, addDays, DEFAULT_LEAD_FACTORS } = require('../core.js');

const DATA = path.join(__dirname, '..', 'data');
const LOG_DIR = path.join(DATA, 'forecast-log');
const KEEP_DAYS = 75; // rolling window of logs kept and scored
const SNOWY_MM = 4; // a "snowy day": forecast of at least ~4 mm water (a few inches of snow)
const MIN_DAYS = 40; // snowy station-days needed before a lead's measured factor is used
const readJSON = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

async function withRetry(fn, tries = 3) {
  for (let i = 1; ; i++) {
    try { return await fn(); } catch (e) { if (i >= tries) throw e; await new Promise((ok) => setTimeout(ok, 2000 * i)); }
  }
}

// One forecast per SNOTEL station (several resorts share one), at the station itself,
// like the calibration: the raw blend's water per calendar day, 1–15 days ahead.
async function logToday() {
  const calibration = readJSON(path.join(DATA, 'calibration.json'))?.resorts || {};
  const byStation = new Map();
  for (const r of RESORTS) {
    const st = r.stations[0];
    if (st?.source === 'snotel' && !byStation.has(st.id)) byStation.set(st.id, { r, st });
  }
  const log = { made: null, stations: {} };
  for (const { r, st } of byStation.values()) {
    try {
      const f = await withRetry(() => getForecast({ ...r, lat: st.lat, lon: st.lon }, st.elev, calibration[r.id], { ensemble: false, lean: true, leanDays: 16, correct: false }));
      log.made ||= f.todayStr;
      const water = {}, hours = {};
      for (const h of f.days.flatMap((d) => d.hours)) {
        water[h.date] = (water[h.date] || 0) + h.swe + h.rain;
        hours[h.date] = (hours[h.date] || 0) + 1;
      }
      const days = {};
      for (const [date, mm] of Object.entries(water)) {
        const lead = Math.round((Date.parse(date) - Date.parse(f.todayStr)) / 86400e3);
        if (lead >= 1 && lead <= 15 && hours[date] === 24) days[date] = Math.round(mm * 10) / 10;
      }
      log.stations[st.id] = days;
    } catch (e) {
      console.error(`${st.name}: ${e.message.split('\n')[0]}`);
    }
  }
  if (!log.made) throw new Error('No forecasts logged');
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.writeFileSync(path.join(LOG_DIR, `${log.made}.json`), JSON.stringify(log) + '\n');
  console.log(`Logged ${Object.keys(log.stations).length} station forecasts for ${log.made}`);
  return log.made;
}

// Measured daily precipitation (mm) per station, same method as calibration: the
// larger of the gauge and the snow-pillow gain (the gauge undercatches wind-blown snow).
async function observed(ids, from, to) {
  const q = new URLSearchParams({ stationTriplets: ids.join(','), elements: 'PREC,WTEQ', duration: 'DAILY', beginDate: addDays(from, -1), endDate: to });
  const r = await fetch(`https://wcc.sc.egov.usda.gov/awdbRestApi/services/v1/data?${q}`);
  if (!r.ok) throw new Error(`SNOTEL ${r.status}`);
  const out = {};
  for (const st of await r.json()) {
    const series = {};
    for (const el of st.data || []) series[el.stationElement.elementCode] = Object.fromEntries(el.values.map((v) => [v.date, v.value]));
    const days = (out[st.stationTriplet] = {});
    for (const d of Object.keys(series.PREC || {})) {
      const pv = addDays(d, -1);
      if (series.PREC[pv] == null || series.PREC[d] == null) continue;
      const g = series.PREC[d] - series.PREC[pv];
      const p = series.WTEQ?.[d] != null && series.WTEQ?.[pv] != null ? series.WTEQ[d] - series.WTEQ[pv] : 0;
      if (g < 0 || g > 5) continue; // gauge resets / bad readings
      days[d] = Math.max(g, p > 0 && p < 5 ? p : 0) * 25.4;
    }
  }
  return out;
}

async function score(today) {
  // Drop logs past the window, then load the rest.
  const files = fs.readdirSync(LOG_DIR).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  for (const f of files) if (f.slice(0, 10) < addDays(today, -KEEP_DAYS)) fs.unlinkSync(path.join(LOG_DIR, f));
  const logs = fs.readdirSync(LOG_DIR).filter((f) => f.endsWith('.json')).map((f) => readJSON(path.join(LOG_DIR, f))).filter(Boolean);
  const yesterday = addDays(today, -1);
  const leads = {};
  for (let L = 1; L <= 15; L++) leads[L] = { snowyDays: 0, forecastMm: 0, measuredMm: 0, allForecastMm: 0, allMeasuredMm: 0 };
  const scorable = logs.filter((l) => l.made < yesterday);
  if (scorable.length) {
    const ids = [...new Set(scorable.flatMap((l) => Object.keys(l.stations)))];
    const obs = await withRetry(() => observed(ids, scorable.map((l) => l.made).sort()[0], yesterday));
    for (const log of scorable) {
      for (const [id, days] of Object.entries(log.stations)) {
        for (const [date, fc] of Object.entries(days)) {
          const o = obs[id]?.[date];
          if (date > yesterday || o == null) continue;
          const L = Math.round((Date.parse(date) - Date.parse(log.made)) / 86400e3);
          const s = leads[L];
          if (!s) continue;
          s.allForecastMm += fc; s.allMeasuredMm += o;
          if (fc >= SNOWY_MM) { s.snowyDays++; s.forecastMm += fc; s.measuredMm += o; }
        }
      }
    }
  }
  // Measured factor once a lead has enough snowy days; otherwise the backtest
  // starting factor (days 8–15 fall back to day 7's, the furthest one tested).
  const factors = {}, source = {};
  for (let L = 1; L <= 15; L++) {
    const s = leads[L];
    s.ratio = s.forecastMm ? Math.round((1000 * s.measuredMm) / s.forecastMm) / 1000 : null;
    for (const k of ['forecastMm', 'measuredMm', 'allForecastMm', 'allMeasuredMm']) s[k] = Math.round(s[k]);
    if (s.snowyDays >= MIN_DAYS) { factors[L] = Math.min(1.1, Math.max(0.4, s.ratio)); source[L] = 'measured'; }
    else { factors[L] = DEFAULT_LEAD_FACTORS[L] ?? factors[7] ?? DEFAULT_LEAD_FACTORS[7]; source[L] = 'backtest'; }
  }
  const out = {
    updated: today, logsSince: logs.map((l) => l.made).sort()[0] || today, snowyMm: SNOWY_MM, minDays: MIN_DAYS,
    factors, source, leads,
  };
  fs.writeFileSync(path.join(DATA, 'lead-bias.json'), JSON.stringify(out, null, 2) + '\n');
  const measured = Object.values(source).filter((x) => x === 'measured').length;
  console.log(`Scored ${scorable.length} logs; ${measured} of 15 lead times now use measured factors`);
}

(async () => {
  const today = await logToday();
  await score(today);
})().catch((e) => { console.error(e); process.exit(1); });
