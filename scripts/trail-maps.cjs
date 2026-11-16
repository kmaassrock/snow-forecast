#!/usr/bin/env node
// Finds each resort's newest official winter trail map on skimap.org (an archive of the
// trail maps resorts publish, e.g. James Niehues' paintings) and writes data/trail-maps.json.
// The site shows the map image from skimap.org and links to the full-size original.
// Runs weekly (.github/workflows/calibrate.yml) to pick up new season maps.
//
//   node scripts/trail-maps.cjs

const fs = require('fs');
const path = require('path');
const { RESORTS } = require('../resorts.js');

const OUT = path.join(__dirname, '..', 'data', 'trail-maps.json');
const SKIP = ['summer', 'biking', 'nordic', 'hiking', 'snowshoe', 'backcountry', 'master plan'];
const UA = 'Mozilla/5.0 (compatible; snow-forecast-site)';
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const text = (html) => html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

// Every map on a skimap.org ski area page: id, year, tags, image, size, artist.
function parseMaps(html) {
  const maps = [];
  let year = null;
  const re = /<h2[^>]*id="maps-year-(\d{4})"|<figure class="figure" id="ski-map-(\d+)"([\s\S]*?)<\/figure>/g;
  for (let m; (m = re.exec(html));) {
    if (m[1]) { year = +m[1]; continue; }
    const body = m[3];
    const img = body.match(/<img[\s\S]*?width="(\d+)"[\s\S]*?height="(\d+)"[\s\S]*?src="([^"]+)"/);
    if (!img) continue;
    const avif = body.match(/srcSet="([^"]+)" type="image\/avif"/)?.[1];
    maps.push({
      id: +m[2], year,
      tags: [...body.matchAll(/class="badge[^"]*">([^<]+)</g)].map((t) => t[1].trim().toLowerCase()),
      img: img[3], avif: avif || null, w: +img[1], h: +img[2],
      artist: body.match(/created by <a href="\/artists\/\d+">([^<]+)<\/a>/)?.[1] || null,
      caption: text(body.match(/<figcaption[\s\S]*?<span>([\s\S]*?)<\/span>/)?.[1] || '') || null,
    });
  }
  return maps;
}

// How many words of the resort's name appear in a skimap.org area's name, so a linked
// neighbor (Snowbird for Alta, an old area for Deer Valley) doesn't win on recency.
function nameMatch(resortName, areaName) {
  const area = areaName.toLowerCase();
  return resortName.toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 2 && area.includes(w)).length;
}

// Newest winter ski map from the best-matching area: skip summer/nordic maps and master plans; when any map is
// tagged downhill, only those count (not touring, village or parking maps).
function pick(maps) {
  const winter = maps.filter((m) => m.year && !m.tags.some((t) => SKIP.includes(t)));
  const downhill = winter.filter((m) => m.tags.includes('downhill'));
  const pool = downhill.length ? downhill : winter.filter((m) => !m.tags.length);
  return pool.sort((a, b) => b.match - a.match || b.year - a.year || a.order - b.order)[0] || null;
}

(async () => {
  const old = (() => { try { return JSON.parse(fs.readFileSync(OUT, 'utf8')).resorts; } catch { return {}; } })();
  const out = { updated: new Date().toISOString().slice(0, 10), resorts: {} };
  for (const r of RESORTS) {
    const maps = [];
    let failed = false;
    for (const [i, area] of (r.skimapIds || []).entries()) {
      try {
        const res = await fetch(`https://skimap.org/skiareas/view/${area}`, { headers: { 'User-Agent': UA } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const html = await res.text();
        const name = html.match(/<meta name="description" content="[^"]* for (.+?) in [^"]*"/)?.[1] || '';
        maps.push(...parseMaps(html).map((m) => ({ ...m, area, order: i, match: nameMatch(r.name, name) })));
      } catch (e) { failed = true; console.error(`${r.name} (area ${area}): ${e.message}`); }
      await sleep(1500); // be gentle with skimap.org
    }
    const best = pick(maps);
    if (best) {
      const { tags, caption, order, match, ...m } = best;
      out.resorts[r.id] = m;
    } else if (failed && old[r.id]) out.resorts[r.id] = old[r.id];
    console.log(`${r.name.padEnd(32)} ${best ? `${best.year} ${best.artist || ''} (area ${best.area}; ${best.tags.join(', ') || 'untagged'})` : 'no winter map'}`);
  }
  if (!Object.keys(out.resorts).length) throw new Error('No trail maps found');
  fs.writeFileSync(OUT, JSON.stringify(out, null, 1) + '\n');
  console.log(`Wrote ${Object.keys(out.resorts).length} trail maps`);
})().catch((e) => { console.error(e); process.exit(1); });
