#!/usr/bin/env node
// Writes data/upcoming.json: for every resort, the next 7 days of snow (lean
// model blend at mid-mountain), snow measured in the last 48 hours, and the
// season so far (the resort's own report when available, otherwise its SNOTEL
// station). Powers the Upcoming Snow page, snow map, season leaderboard and the
// 48-hour number on favorite cards.
// Runs on each deploy, after scripts/reports.cjs.
//
//   node scripts/upcoming.cjs

const fs = require('fs');
const path = require('path');
const { RESORTS } = require('../resorts.js');
const { getForecast, snowType } = require('../core.js');

const DATA = path.join(__dirname, '..', 'data');
const H = 3600e3;
const r1 = (x) => Math.round(x * 10) / 10;
const readJSON = (f) => { try { return JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8')); } catch { return null; } };

// New snow over the last 48 hours at every resort's primary SNOTEL station, in one request.
async function stationSnow() {
  const ids = [...new Set(RESORTS.map((r) => r.stations[0]).filter((s) => s?.source === 'snotel').map((s) => s.id))];
  // SNOTEL hours are local standard time: Pacific for CA/NV stations, Mountain otherwise.
  const offset = (id) => (/:(CA|NV):/.test(id) ? -8 : -7);
  const stamp = (ms) => new Date(ms - 7 * H).toISOString().slice(0, 16).replace('T', ' ');
  const q = new URLSearchParams({ stationTriplets: ids.join(','), elements: 'SNWD', duration: 'HOURLY', beginDate: stamp(Date.now() - 56 * H), endDate: stamp(Date.now() + H) });
  const r = await fetch(`https://wcc.sc.egov.usda.gov/awdbRestApi/services/v1/data?${q}`);
  if (!r.ok) throw new Error(`SNOTEL ${r.status}`);
  const out = {};
  for (const st of await r.json()) {
    const toMs = (s) => Date.parse(s.replace(' ', 'T') + ':00Z') - offset(st.stationTriplet) * H;
    const vals = (st.data?.[0]?.values || []).filter((v) => v.value != null);
    const last = vals.at(-1);
    if (!last || Date.now() - toMs(last.date) > 8 * H) continue;
    const from = vals.find((v) => toMs(v.date) >= toMs(last.date) - 48 * H);
    const g = from ? last.value - from.value : 0;
    out[st.stationTriplet] = g >= 1 ? g : 0; // depth sensors jitter by about an inch
  }
  return out;
}

// Season so far at every station, in one request: new snow (sum of daily depth
// gains since Oct 1), current depth, and snow water vs. the 1991–2020 median.
async function stationSeason() {
  const ids = [...new Set(RESORTS.map((r) => r.stations[0]).filter((s) => s?.source === 'snotel').map((s) => s.id))];
  const day = (ms) => new Date(ms).toISOString().slice(0, 10);
  const now = new Date();
  const seasonStart = `${now.getUTCMonth() >= 7 ? now.getUTCFullYear() : now.getUTCFullYear() - 1}-09-30`;
  const q = new URLSearchParams({ stationTriplets: ids.join(','), elements: 'SNWD,WTEQ', duration: 'DAILY', beginDate: seasonStart, endDate: day(Date.now()), centralTendencyType: 'MEDIAN' });
  const r = await fetch(`https://wcc.sc.egov.usda.gov/awdbRestApi/services/v1/data?${q}`);
  if (!r.ok) throw new Error(`SNOTEL ${r.status}`);
  const out = {};
  for (const st of await r.json()) {
    const el = (code) => (st.data || []).find((e) => e.stationElement.elementCode === code)?.values.filter((v) => v.value != null) || [];
    const depth = el('SNWD'), swe = el('WTEQ');
    let season = 0;
    // Daily values are end-of-day; jitter under 1" and jumps over 36" are ignored.
    for (let i = 1; i < depth.length; i++) { const g = depth[i].value - depth[i - 1].value; if (g >= 1 && g <= 36) season += g; }
    const last = swe.at(-1);
    out[st.stationTriplet] = {
      season, depth: depth.at(-1)?.value ?? null,
      pctNormal: last?.median > 0.1 ? Math.round((100 * last.value) / last.median) : null,
    };
  }
  return out;
}

async function inBatches(items, size, fn) {
  const results = [];
  for (let i = 0; i < items.length; i += size) results.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  return results;
}

(async () => {
  const calibration = readJSON('calibration.json')?.resorts || {};
  const reports = readJSON('reports.json')?.resorts || {};
  const [stations, seasons] = await Promise.all([
    stationSnow().catch((e) => { console.error(e.message); return {}; }),
    stationSeason().catch((e) => { console.error(e.message); return {}; }),
  ]);
  const out = { generated: new Date().toISOString(), resorts: {} };

  await inBatches(RESORTS, 4, async (r) => {
    const entry = {};
    const rep = reports[r.id], st = r.stations[0];
    if (rep?.new48 != null) entry.recent48 = { inches: rep.new48, source: 'resort report' };
    else if (st && st.id in stations) entry.recent48 = { inches: r1(stations[st.id]), source: `${st.name} station` };
    const ss = st && seasons[st.id];
    if (rep?.season != null) entry.season = { inches: rep.season, source: 'resort report' };
    else if (ss) entry.season = { inches: r1(ss.season), source: `${st.name} station` };
    if (rep?.baseDepth != null) entry.depth = { inches: rep.baseDepth, source: 'resort report' };
    else if (ss?.depth != null) entry.depth = { inches: ss.depth, source: `${st.name} station` };
    if (ss?.pctNormal != null) entry.pctNormal = ss.pctNormal;
    try {
      const f = await getForecast(r, r.elevations.mid, calibration[r.id], { ensemble: false, lean: true });
      const ti = f.days.findIndex((d) => d.date === f.todayStr);
      const days = f.days.slice(ti, ti + 7);
      entry.days = days.map((d) => ({ date: d.date, snow: r1(d.snow), q: d.slr && d.snow >= 0.5 ? snowType(d.slr).cls : null }));
      entry.next7 = r1(days.reduce((s, d) => s + d.snow, 0));
      entry.tomorrowBy9 = days[1] ? r1(days[1].overnight) : null;
      entry.todayStr = f.todayStr;
    } catch (e) {
      console.error(`${r.name}: ${e.message.split('\n')[0]}`);
    }
    out.resorts[r.id] = entry;
  });

  const ok = Object.values(out.resorts).filter((e) => e.days).length;
  if (!ok) throw new Error('No forecasts');
  fs.writeFileSync(path.join(DATA, 'upcoming.json'), JSON.stringify(out) + '\n');
  console.log(`Wrote data/upcoming.json: ${ok} forecasts, ${Object.values(out.resorts).filter((e) => e.recent48).length} with recent snow data`);
})().catch((e) => { console.error(e); process.exit(1); });
