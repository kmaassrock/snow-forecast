#!/usr/bin/env node
// Public per-resort powder alerts on ntfy (topics in alert-topics.js; subscribe from
// the site's Alerts page). Runs every evening after scripts/alerts.cjs.
//
// Reads the published data/upcoming.json (the same forecast as the Upcoming Snow page)
// and, for each resort and size channel (4", 8", 12"), alerts when a ski day in the
// next 3 reaches that size. At most two alerts per powder day per channel: a heads-up
// the first evening it shows up, and a final call the evening before.
// Remembers what it sent in ALERT_STATE (default data/alert-state.json; the workflow
// keeps it in the Actions cache, not the repo).
//
//   SITE_URL=https://you.github.io/snow/ node scripts/channel-alerts.cjs           # dry run
//   SEND=1 SITE_URL=https://you.github.io/snow/ node scripts/channel-alerts.cjs    # send

const fs = require('fs');
const path = require('path');
const { RESORTS } = require('../resorts.js');
const { ALERT_TIERS, alertTopic } = require('../alert-topics.js');

const SITE = (process.env.SITE_URL || 'https://kmaassrock.github.io/snow-forecast/').replace(/\/?$/, '/');
const STATE_FILE = process.env.ALERT_STATE || path.join(__dirname, '..', 'data', 'alert-state.json');
const PRIORITY = { 4: 3, 8: 4, 12: 4 }; // ntfy: 3 default, 4 high (subscribers can filter)
const addDays = (d, n) => new Date(Date.parse(d + 'T12:00:00Z') + n * 86400e3).toISOString().slice(0, 10);
const weekday = (d) => new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });
const fmt = (x) => `${x < 1 ? x.toFixed(1) : Math.round(x)}"`;
const readJSON = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

function save(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state) + '\n');
}

async function publish(msg) {
  for (let i = 1; ; i++) {
    const res = await fetch('https://ntfy.sh/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(msg) });
    if (res.ok) return;
    if (res.status !== 429 || i >= 4) throw new Error(`ntfy ${res.status}: ${await res.text()}`);
    await new Promise((ok) => setTimeout(ok, 6000 * i)); // rate limited: back off
  }
}

(async () => {
  const r = await fetch(`${SITE}data/upcoming.json`, { cache: 'no-store' });
  if (!r.ok) throw new Error(`upcoming.json ${r.status}`);
  const up = await r.json();
  if (Date.now() - Date.parse(up.generated) > 8 * 3600e3) throw new Error(`upcoming.json is stale (${up.generated})`);

  const state = readJSON(STATE_FILE) || {};
  const send = !!process.env.SEND;
  let sent = 0;
  for (const resort of RESORTS) {
    const e = up.resorts?.[resort.id];
    if (!e?.days || e.stale) continue;
    const tomorrow = addDays(e.todayStr, 1);
    const next3 = e.days.filter((d) => d.date >= tomorrow).slice(0, 3);
    for (const tier of ALERT_TIERS) {
      const topic = alertTopic(resort.id, tier);
      const seen = (state[topic] ||= {});
      const hits = next3.filter((d) => d.snow >= tier);
      if (!hits.length) continue;
      // New powder day on this channel, or tomorrow's powder day without its final call yet.
      const fresh = hits.filter((d) => !seen[d.date]);
      const finalCall = hits.find((d) => d.date === tomorrow && seen[d.date] !== 'eve');
      if (!fresh.length && !finalCall) continue;

      const parts = next3.filter((d) => d.snow >= 0.5).map((d) =>
        `${weekday(d.date)} ${fmt(d.snow)}${d.date === tomorrow && e.tomorrowBy9 >= 0.5 ? ` (${fmt(e.tomorrowBy9)} by 9 am)` : ''}`);
      const total = next3.reduce((s, d) => s + d.snow, 0);
      const big = hits.reduce((a, b) => (b.snow > a.snow ? b : a));
      const msg = {
        topic,
        title: `❄️ ${resort.name}: ${fmt(big.snow)} ${big.date === tomorrow ? 'tomorrow' : weekday(big.date)}`,
        message: `${parts.join(' · ')}\nNext 3 days: ${fmt(total)}${finalCall ? '' : ' (heads-up, forecasts can change)'}`,
        tags: ['snowflake'],
        priority: PRIORITY[tier] || 3,
        click: `${SITE}#${resort.id}`,
      };
      console.log(`${topic}: ${msg.title} | ${msg.message.replace('\n', ' | ')}`);
      if (send) { await publish(msg); sent++; }
      for (const d of hits) seen[d.date] = d.date === tomorrow ? 'eve' : seen[d.date] || 'first';
      if (send) save(state); // after every send, so a failure later doesn't repeat this one
    }
  }
  // Forget days that have passed.
  for (const t of Object.keys(state)) {
    for (const d of Object.keys(state[t])) if (d < addDays(new Date().toISOString().slice(0, 10), -2)) delete state[t][d];
    if (!Object.keys(state[t]).length) delete state[t];
  }
  if (send) save(state);
  console.log(send ? `Sent ${sent} channel alerts.` : '(dry run; set SEND=1 to send)');
})().catch((e) => { console.error(e); process.exit(1); });
