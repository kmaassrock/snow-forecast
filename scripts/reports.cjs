#!/usr/bin/env node
// Reads official snow reports from resort websites that allow automated access
// and writes data/reports.json. Runs on each deploy (every 3 hours). Resorts not
// listed here fall back to the nearest snow station on the site.
//
//   node scripts/reports.cjs
//
// Only add sites whose robots.txt allows it, and never work around bot blocking
// (Purgatory's site, for example, blocks automated requests).

const fs = require('fs');
const path = require('path');

const pageText = (html) => html
  .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;|&amp;nbsp;/g, ' ')
  .replace(/\s+/g, ' ');

const num = (text, re) => { const m = text.match(re); return m ? +m[1] : null; };

const PARSERS = {
  'wolf-creek': {
    url: 'https://wolfcreekski.com/',
    parse(text) {
      return {
        new24: num(text, /([\d.]+) " 24 HOURS/i),
        new48: num(text, /([\d.]+) " 48 HOURS/i),
        new72: num(text, /([\d.]+) " 72 HOURS/i),
        stormTotal: num(text, /([\d.]+) " STORM TOTAL/i),
        season: num(text, /([\d.]+) " SEASON/i),
        baseDepth: num(text, /([\d.]+) " midway depth/i),
        summitDepth: num(text, /([\d.]+) " summit depth/i),
        pctOpen: num(text, /([\d.]+) % Open/i),
        liftsOpen: num(text, /(\d+) lifts open/i),
      };
    },
  },
};

(async () => {
  const out = { generated: new Date().toISOString(), resorts: {} };
  for (const [id, p] of Object.entries(PARSERS)) {
    try {
      const r = await fetch(p.url, { headers: { 'User-Agent': 'snow-forecast (personal; github.com/kmaassrock/snow-forecast)' } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const report = p.parse(pageText(await r.text()));
      if (report.new24 == null && report.season == null) throw new Error('report not found on page');
      out.resorts[id] = { ...report, source: p.url, fetchedAt: out.generated };
      console.log(id, JSON.stringify(report));
    } catch (e) {
      console.error(`${id}: ${e.message}`);
    }
  }
  const file = path.join(__dirname, '..', 'data', 'reports.json');
  fs.writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
  console.log(`Wrote ${file}`);
})();
