#!/usr/bin/env node
// Weekend outlook on ntfy, sent Thursday evenings (.github/workflows/weekend-alert.yml).
//
// Reads the published data/upcoming.json and ranks resorts for the coming Saturday and
// Sunday. Snow that falls Friday is on the ground for first chair Saturday, so it counts
// fully toward Saturday; Saturday's snow counts half toward Sunday (some of it gets
// skied off). Posts to the public weekend channels in alert-topics.js (one per region
// plus all regions) and, if NTFY_TOPIC is set, to the owner's private topic for the
// resorts in ALERT_RESORTS (default purgatory).
//
//   SITE_URL=https://you.github.io/snow/ node scripts/weekend-alert.cjs           # dry run
//   SEND=1 SITE_URL=https://you.github.io/snow/ node scripts/weekend-alert.cjs    # send

const { RESORTS, STATE_NAMES, DEFAULT_RESORT } = require('../resorts.js');
const { WEEKEND_REGIONS, weekendTopic } = require('../alert-topics.js');

const SITE = (process.env.SITE_URL || 'https://kmaassrock.github.io/snow-forecast/').replace(/\/?$/, '/');
const TOP = 5;
const QUIET_IN = 2; // below this Fri–Sun total everywhere in a region, it's a quiet weekend
const addDays = (d, n) => new Date(Date.parse(d + 'T12:00:00Z') + n * 86400e3).toISOString().slice(0, 10);
const dow = (d) => new Date(d + 'T12:00:00Z').getUTCDay();
const fmt = (x) => (x < 0.05 ? '0"' : `${x < 1 ? x.toFixed(1) : Math.round(x)}"`);

async function publish(msg) {
  for (let i = 1; ; i++) {
    const res = await fetch('https://ntfy.sh/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(msg) });
    if (res.ok) return;
    if (res.status !== 429 || i >= 4) throw new Error(`ntfy ${res.status}: ${await res.text()}`);
    await new Promise((ok) => setTimeout(ok, 6000 * i)); // rate limited: back off
  }
}

// Fri/Sat/Sun snow and a score for each ski day; null when the weekend isn't in the forecast.
function weekend(resort, e) {
  if (!e?.days || e.stale || !e.todayStr) return null;
  const sat = addDays(e.todayStr, (6 - dow(e.todayStr) + 7) % 7); // today if it's Saturday
  const snow = (d) => e.days.find((x) => x.date === d)?.snow;
  const s = { fri: snow(addDays(sat, -1)) || 0, sat: snow(sat), sun: snow(addDays(sat, 1)) };
  if (s.sat == null || s.sun == null) return null;
  const days = [
    { day: 'Sat', score: s.sat + s.fri, on: s.sat, prev: s.fri, prevDay: 'Fri' },
    { day: 'Sun', score: s.sun + s.sat / 2, on: s.sun, prev: s.sat, prevDay: 'Sat' },
  ];
  const best = days[0].score >= days[1].score ? days[0] : days[1];
  return {
    resort, ...s, best, total: s.fri + s.sat + s.sun,
    score: best.score + (days[0] === best ? days[1] : days[0]).score / 2, // the other day adds a little
    depth: e.depth?.inches,
  };
}

const label = (w, withState) => (withState ? `${w.resort.name} (${w.resort.state})` : w.resort.name);
function bestText(w, withState) {
  const { day, on, prev, prevDay } = w.best;
  const amount = on < 0.5 ? `${fmt(prev)} from ${prevDay}` : `${fmt(on)}${prev >= 0.5 ? ` + ${fmt(prev)} ${prevDay}` : ''}`;
  return `${label(w, withState)} ${day}, ${amount}`;
}

// One notification for a ranked list of resorts (best first).
function message(topic, area, ranked, withState) {
  const top = ranked[0];
  const base = { topic, tags: ['snowflake'], priority: 3, click: `${SITE}#upcoming` };
  if (!ranked.some((w) => w.total >= QUIET_IN)) {
    const depth = top.depth != null ? `base ${fmt(top.depth)}` : 'base depth not reported';
    return { ...base, title: `🌤️ ${area}: quiet weekend`,
      message: `No mountain expects ${QUIET_IN}"+ Fri–Sun. Best bet: ${label(top, withState)} (${fmt(top.total)}, ${depth}).` };
  }
  const lines = ranked.slice(0, TOP).map((w, i) =>
    `${i + 1}. ${label(w, withState)}: Sat ${fmt(w.sat)}, Sun ${fmt(w.sun)}${w.fri >= 0.5 ? ` (+${fmt(w.fri)} Fri)` : ''}`);
  return { ...base, title: `❄️ ${area} weekend outlook`, message: `Best: ${bestText(top, withState)}\n${lines.join('\n')}` };
}

(async () => {
  const r = await fetch(`${SITE}data/upcoming.json`, { cache: 'no-store', headers: { 'User-Agent': 'snow-forecast-weekend-alert' } });
  if (!r.ok) throw new Error(`upcoming.json ${r.status}`);
  const up = await r.json();
  if (Date.now() - Date.parse(up.generated) > 8 * 3600e3) throw new Error(`upcoming.json is stale (${up.generated})`);

  const all = RESORTS.map((res) => weekend(res, up.resorts?.[res.id])).filter(Boolean)
    .sort((a, b) => b.score - a.score || b.total - a.total);
  if (!all.length) throw new Error('No resort has a weekend forecast');

  const msgs = WEEKEND_REGIONS.map((region) => {
    const ranked = region === 'all' ? all : all.filter((w) => w.resort.state.toLowerCase() === region);
    return ranked.length && message(weekendTopic(region), region === 'all' ? 'All regions' : STATE_NAMES[region.toUpperCase()], ranked, region === 'all');
  }).filter(Boolean);

  const wanted = (process.env.ALERT_RESORTS || DEFAULT_RESORT).split(',').map((s) => s.trim()).filter(Boolean);
  const mine = all.filter((w) => wanted.includes(w.resort.id));
  const priv = process.env.NTFY_TOPIC;
  if (mine.length) msgs.push(message(priv, 'Your mountains', mine, false));

  const send = process.env.SEND === '1';
  let sent = 0;
  for (const m of msgs) {
    // Never print the private topic name: it's the only thing keeping that channel private.
    const name = m.topic === priv ? `(private${priv ? '' : ', NTFY_TOPIC not set'})` : m.topic;
    console.log(`${name}: ${m.title} | ${m.message.replace(/\n/g, ' | ')}`);
    if (send && m.topic) { await publish(m); sent++; }
  }
  console.log(send ? `Sent ${sent} weekend alerts.` : '(dry run; set SEND=1 to send)');
})().catch((e) => { console.error(e); process.exit(1); });
