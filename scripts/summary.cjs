#!/usr/bin/env node
// Writes data/summary.json: a small snapshot of selected mountains' mid-mountain
// forecast for the iPhone widget (widget/snow-widget.js). Runs on each deploy.
// Only the mountains in WIDGET_RESORTS are included, to stay within free API limits.
//
//   node scripts/summary.cjs

const fs = require('fs');
const path = require('path');
const { RESORTS, LIFTS_OPEN } = require('../resorts.js');
const { getForecast, periodTotal, snowType, mmToIn, addDays, nowLocalHour } = require('../core.js');

const r1 = (x) => Math.round(x * 10) / 10;
const weekday = (d) => new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });

async function summarize(resort, calib) {
  const f = await getForecast(resort, resort.elevations.mid, calib);
  const ti = f.days.findIndex((d) => d.date === f.todayStr);
  const now = nowLocalHour(resort.tz);
  // Before 9 am the next lift opening is today's; after, it's tomorrow's.
  const morningDate = +now.slice(11, 13) < LIFTS_OPEN ? f.todayStr : addDays(f.todayStr, 1);
  const morning = f.days.find((d) => d.date === morningDate);
  const p5 = periodTotal(f.days, f.ens, ti, ti + 4);
  const p14 = periodTotal(f.days, f.ens, ti, ti + 13);
  return {
    id: resort.id,
    name: resort.name,
    elevationFt: Math.round(resort.elevations.mid * 3.28084),
    nextMorning: morning && {
      date: morning.date,
      label: morning.date === f.todayStr ? 'today' : weekday(morning.date),
      overnight: r1(morning.overnight),
    },
    next5: p5 && { snow: r1(p5.snow), lo: p5.range ? r1(p5.range.lo) : null, hi: p5.range ? r1(p5.range.hi) : null },
    next14: p14 && { snow: r1(p14.snow) },
    powder: f.days.slice(ti, ti + 3).some((d) => d.snow >= 6 || d.overnight >= 4),
    days: f.days.slice(ti, ti + 7).map((d) => ({
      date: d.date,
      label: d.date === f.todayStr ? 'Today' : weekday(d.date),
      snow: r1(d.snow),
      overnight: r1(d.overnight),
      lifts: r1(d.lifts),
      type: d.slr ? snowType(d.slr).label : null,
      hiF: Math.round(d.hi),
      loF: Math.round(d.lo),
      swe: Math.round(mmToIn(d.swe) * 100) / 100,
    })),
  };
}

const WIDGET_RESORTS = (process.env.WIDGET_RESORTS || 'purgatory,wolf-creek,vail,park-city,whistler').split(',').map((s) => s.trim());

(async () => {
  const calibration = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'calibration.json'), 'utf8'));
  const out = { generated: new Date().toISOString(), resorts: [] };
  for (const r of WIDGET_RESORTS.map((id) => RESORTS.find((x) => x.id === id)).filter(Boolean)) {
    try {
      out.resorts.push(await summarize(r, calibration.resorts[r.id]));
    } catch (e) {
      console.error(`${r.name}: forecast failed`, e.message);
    }
  }
  if (!out.resorts.length) throw new Error('No forecasts');
  const file = path.join(__dirname, '..', 'data', 'summary.json');
  fs.writeFileSync(file, JSON.stringify(out) + '\n');
  console.log(`Wrote ${file} (${out.resorts.length} mountains)`);
})().catch((e) => { console.error(e); process.exit(1); });
