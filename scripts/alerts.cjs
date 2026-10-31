#!/usr/bin/env node
// Checks each mountain's forecast and sends a phone notification through
// ntfy (https://ntfy.sh) when a powder day is coming. Run every evening.
//
//   NTFY_TOPIC=your-secret-topic node scripts/alerts.cjs
//
// Without NTFY_TOPIC it only prints what it would send.
// ALERT_RESORTS picks the mountains to watch (default: purgatory), e.g. purgatory,wolf-creek.
// Optional: SITE_URL=https://you.github.io/snow/

const fs = require('fs');
const path = require('path');
const { RESORTS, DEFAULT_RESORT } = require('../resorts.js');
const { getForecast, addDays } = require('../core.js');

const OVERNIGHT_IN = +(process.env.OVERNIGHT_IN || 4); // snow by 9 am tomorrow
const DAY_IN = +(process.env.DAY_IN || 6); // any single ski day in the next 3
const STORM_IN = +(process.env.STORM_IN || 12); // 3-day total

const fmt = (x) => `${x < 1 ? x.toFixed(1) : Math.round(x)}"`;
const weekday = (d) => new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });

async function check(resort, calib) {
  // Retry network hiccups so a blip on the build server doesn't skip an alert.
  let f;
  for (let i = 1; !f; i++) {
    try { f = await getForecast(resort, resort.elevations.mid, calib); } catch (e) {
      if (i >= 3) throw e;
      await new Promise((ok) => setTimeout(ok, 3000 * i));
    }
  }
  const tomorrow = addDays(f.todayStr, 1);
  const next3 = f.days.filter((d) => d.date >= tomorrow).slice(0, 3);
  const total = next3.reduce((s, d) => s + d.snow, 0);
  const hit = next3.some((d, i) => d.snow >= DAY_IN || (i === 0 && d.overnight >= OVERNIGHT_IN)) || total >= STORM_IN;
  if (!hit) return null;
  const days = next3.filter((d) => d.snow >= 0.5).map((d) => `${weekday(d.date)} ${fmt(d.snow)} (${fmt(d.overnight)} by 9am)`);
  return `${resort.name}: ${days.join(', ')}; 3-day ${fmt(total)}`;
}

(async () => {
  const calibration = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'calibration.json'), 'utf8'));
  const wanted = (process.env.ALERT_RESORTS || DEFAULT_RESORT).split(',').map((s) => s.trim()).filter(Boolean);
  const resorts = RESORTS.filter((r) => wanted.includes(r.id));

  const lines = [];
  for (const r of resorts) {
    try {
      const line = await check(r, calibration.resorts[r.id]);
      console.log(`${r.name}: ${line ? 'ALERT' : 'no alert'}`);
      if (line) lines.push(line);
    } catch (e) {
      console.error(`${r.name}: forecast failed`, e.message);
    }
  }
  if (!lines.length) return console.log('Nothing to send.');

  const msg = {
    title: '❄️ Powder alert',
    message: lines.join('\n'),
    tags: ['snowflake'],
    priority: 4,
  };
  const site = process.env.SITE_URL;
  if (site) msg.click = resorts.length === 1 ? `${site}#${resorts[0].id}` : site;
  console.log(msg.message);

  const topic = process.env.NTFY_TOPIC;
  if (!topic) return console.log('(NTFY_TOPIC not set; not sent)');
  const res = await fetch('https://ntfy.sh/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ topic, ...msg }),
  });
  if (!res.ok) throw new Error(`ntfy ${res.status}: ${await res.text()}`);
  console.log('Sent.');
})().catch((e) => { console.error(e); process.exit(1); });
