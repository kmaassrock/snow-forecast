#!/usr/bin/env node
// Finds each resort's newest official winter trail maps on skimap.org (an archive of the
// trail maps resorts publish, e.g. James Niehues' paintings) and writes data/trail-maps.json.
// The site shows the map image from skimap.org and links to the full-size original.
// Runs weekly (.github/workflows/calibrate.yml) to pick up new season maps.
//
//   node scripts/trail-maps.cjs
//   ONLY=vail,alta node scripts/trail-maps.cjs   # just these resorts

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
      uploader: body.match(/added by <a href="\/users\/(\d+)">/)?.[1] || null,
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

// The newest season's winter ski maps from the best-matching area. Big resorts publish
// one per area (Vail: Front Side, Back Bowls, Blue Sky Basin), so all of that year's maps
// count. Skip summer/nordic maps and master plans; when any map is tagged downhill, only
// those count (not touring, village or parking maps).
function pick(maps) {
  const winter = maps.filter((m) => m.year && !m.tags.some((t) => SKIP.includes(t)));
  const downhill = winter.filter((m) => m.tags.includes('downhill'));
  const untagged = winter.filter((m) => !m.tags.length);
  // Last resort: any winter map (Bear Mountain's only one is tagged village / base).
  const pool = downhill.length ? downhill : untagged.length ? untagged : winter;
  if (!pool.length) return [];
  const best = pool.reduce((a, b) => (b.match > a.match || (b.match === a.match && (b.year > a.year || (b.year === a.year && b.order < a.order))) ? b : a));
  const season = pool.filter((m) => m.area === best.area && m.year === best.year);
  // A resort's per-area maps get uploaded together, as one person's set; other people's
  // uploads of the same year are usually the same map again (often cropped differently).
  // So use the biggest set, the newest one on a tie.
  const sets = {};
  for (const m of season) (sets[m.uploader || `map${m.id}`] ||= []).push(m);
  const set = Object.values(sets).sort((a, b) => b.length - a.length || Math.max(...b.map((m) => m.id)) - Math.max(...a.map((m) => m.id)))[0];
  // In upload order, which is usually the resort's own (main mountain first).
  return set.sort((a, b) => a.id - b.id);
}

// Some uploaders add the same map twice, as a PDF and as an image (same shape, different
// file type). Drop the image copy; the PDF is the sharper full-size version.
async function dropFormatCopies(set) {
  if (set.length < 2) return set;
  for (const m of set) {
    try {
      const res = await fetch(`https://skimap.org/skimaps/view/${m.id}`, { method: 'HEAD', headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30e3) });
      m.pdf = (res.headers.get('content-type') || '').includes('pdf');
    } catch { m.pdf = null; }
    await sleep(500);
  }
  const ratio = (m) => m.h / m.w;
  return set.filter((m) => !(m.pdf === false && set.some((o) => o.pdf === true && Math.abs(ratio(o) - ratio(m)) < 0.015 * ratio(m))));
}

(async () => {
  const old = (() => { try { return JSON.parse(fs.readFileSync(OUT, 'utf8')).resorts; } catch { return {}; } })();
  // ONLY=vail,alta refreshes just those resorts and keeps the rest of the file.
  const only = process.env.ONLY?.split(',').map((x) => x.trim());
  const out = { updated: new Date().toISOString().slice(0, 10), resorts: only ? { ...old } : {} };
  for (const r of RESORTS.filter((x) => !only || only.includes(x.id))) {
    const maps = [];
    let failed = false;
    for (const [i, area] of (r.skimapIds || []).entries()) {
      try {
        const res = await fetch(`https://skimap.org/skiareas/view/${area}`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30e3) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const html = await res.text();
        const name = html.match(/<meta name="description" content="[^"]* for (.+?) in [^"]*"/)?.[1] || '';
        maps.push(...parseMaps(html).map((m) => ({ ...m, area, order: i, match: nameMatch(r.name, name) })));
      } catch (e) { failed = true; console.error(`${r.name} (area ${area}): ${e.message}`); }
      await sleep(1500); // be gentle with skimap.org
    }
    const picked = await dropFormatCopies(pick(maps));
    if (picked.length) out.resorts[r.id] = { maps: picked.map(({ tags, caption, order, match, uploader, pdf, ...m }) => m) };
    else if (failed && old[r.id]) out.resorts[r.id] = old[r.id];
    console.log(`${r.name.padEnd(32)} ${picked.length ? `${picked[0].year} ${picked[0].artist || ''} (area ${picked[0].area}): ${picked.length} map${picked.length > 1 ? 's' : ''} ${picked.map((m) => m.id).join(',')}` : 'no winter map'}`);
  }
  if (!Object.keys(out.resorts).length) throw new Error('No trail maps found');
  fs.writeFileSync(OUT, JSON.stringify(out, null, 1) + '\n');
  console.log(`Wrote ${Object.keys(out.resorts).length} trail maps`);
})().catch((e) => { console.error(e); process.exit(1); });
