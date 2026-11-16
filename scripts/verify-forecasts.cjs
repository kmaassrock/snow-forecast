#!/usr/bin/env node
// Daily forecast scorekeeping (runs every morning, .github/workflows/verify.yml):
//  1. Logs today's raw (uncorrected) blend forecast of daily precipitation water at
//     every SNOTEL station, 1–15 days ahead: data/forecast-log/<date>.json.
//  2. Scores earlier logs against what each station measured, by days ahead.
//  3. Writes data/lead-bias.json: the correction factors core.js applies. Each
//     lead's factor blends its measured ratio with the backtest starting factor,
//     weighted by sample size (PRIOR_DAYS), so one storm can't swing it.
//  4. Writes data/forecast-trend.json: how each station's forecast for every
//     upcoming day has changed across the daily logs (trend arrows on the site).
//
//   node scripts/verify-forecasts.cjs
//   SCORE_ONLY=1 node scripts/verify-forecasts.cjs   # re-score without a new log

const fs = require('fs');
const path = require('path');
const { RESORTS } = require('../resorts.js');
const { getForecast, addDays, DEFAULT_LEAD_FACTORS } = require('../core.js');

const DATA = path.join(__dirname, '..', 'data');
const LOG_DIR = path.join(DATA, 'forecast-log');
const KEEP_DAYS = 75; // rolling window of logs kept and scored
const SNOWY_MM = 4; // a "snowy day": forecast of at least ~4 mm water (a few inches of snow)
const PRIOR_DAYS = 60; // the backtest factor counts as this many snowy station-days
const readJSON = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

async function withRetry(fn, tries = 3, waitMs = 2000) {
  for (let i = 1; ; i++) {
    try { return await fn(); } catch (e) { if (i >= tries) throw e; await new Promise((ok) => setTimeout(ok, waitMs * i)); }
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
  writeTrends(logs, today); // needs no station data, so it updates even if SNOTEL is down
  const yesterday = addDays(today, -1);
  const leads = {};
  for (let L = 1; L <= 15; L++) leads[L] = { snowyDays: 0, forecastMm: 0, measuredMm: 0, allForecastMm: 0, allMeasuredMm: 0 };
  const scorable = logs.filter((l) => l.made < yesterday);
  if (scorable.length) {
    const ids = [...new Set(scorable.flatMap((l) => Object.keys(l.stations)))];
    // SNOTEL's API has outages (502s) lasting minutes: 5 tries, waiting 15, 30, 45, 60 s.
    const obs = await withRetry(() => observed(ids, scorable.map((l) => l.made).sort()[0], yesterday), 5, 15000);
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
  // Blend measured and backtest factors by sample size: with n snowy days the
  // measured ratio gets weight n / (n + PRIOR_DAYS). Days 8–15 start from day 7's.
  const factors = {}, measuredShare = {};
  for (let L = 1; L <= 15; L++) {
    const s = leads[L];
    s.ratio = s.forecastMm ? Math.round((1000 * s.measuredMm) / s.forecastMm) / 1000 : null;
    for (const k of ['forecastMm', 'measuredMm', 'allForecastMm', 'allMeasuredMm']) s[k] = Math.round(s[k]);
    const prior = DEFAULT_LEAD_FACTORS[L] ?? factors[7];
    const w = s.ratio == null ? 0 : s.snowyDays / (s.snowyDays + PRIOR_DAYS);
    factors[L] = Math.round(1000 * Math.min(1.15, Math.max(0.5, w * s.ratio + (1 - w) * prior))) / 1000;
    measuredShare[L] = Math.round(100 * w);
  }
  const out = {
    updated: today, logsSince: logs.map((l) => l.made).sort()[0] || today, snowyMm: SNOWY_MM, priorDays: PRIOR_DAYS,
    factors, measuredShare, leads,
  };
  fs.writeFileSync(path.join(DATA, 'lead-bias.json'), JSON.stringify(out, null, 2) + '\n');
  console.log(`Scored ${scorable.length} logs; measured share by lead: ${Object.values(measuredShare).join(' ')}%`);
}

// For every station and upcoming day: the forecast water from each daily log,
// oldest first, so the site can show whether a day's snow is growing or fading.
function writeTrends(logs, today) {
  const out = { updated: today, stations: {} };
  for (const log of [...logs].sort((a, b) => (a.made < b.made ? -1 : 1))) {
    for (const [id, days] of Object.entries(log.stations)) {
      for (const [date, mm] of Object.entries(days)) {
        if (date <= today) continue;
        ((out.stations[id] ||= {})[date] ||= []).push([log.made, mm]);
      }
    }
  }
  fs.writeFileSync(path.join(DATA, 'forecast-trend.json'), JSON.stringify(out) + '\n');
}

// SCORE_ONLY=1 re-scores existing logs without logging a new forecast (local testing).
// If scoring fails (usually a SNOTEL outage), today's log and the trends are already
// written: the workflow still commits them, lead-bias.json keeps yesterday's factors,
// and the run is marked failed so it gets noticed.
(async () => {
  const today = process.env.SCORE_ONLY ? fs.readdirSync(LOG_DIR).sort().at(-1).slice(0, 10) : await logToday();
  try { await score(today); } catch (e) {
    console.error(`Scoring failed; kept today's log and yesterday's factors. ${e.message}`);
    process.exitCode = 1;
  }
})().catch((e) => { console.error(e); process.exit(1); });
