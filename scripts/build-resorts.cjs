#!/usr/bin/env node
// Builds resorts.js from OpenSkiMap's ski area data (https://openskimap.org)
// and matches each resort to its best nearby NRCS SNOTEL station.
//
//   curl -o /tmp/ski_areas.geojson https://tiles.openskimap.org/geojson/ski_areas.geojson
//   node scripts/build-resorts.cjs /tmp/ski_areas.geojson

const fs = require('fs');
const path = require('path');

const STATES = { CO: 'Colorado', UT: 'Utah', CA: 'California' };
const TZ = { CO: 'America/Denver', UT: 'America/Denver', CA: 'America/Los_Angeles' };
const MIN_VERTICAL_M = 150;
const MIN_RUNS = 8;
// Not public ski resorts: private clubs, terrain park, training venue, sledding hill.
const EXCLUDE = [
  'Wasatch Peaks Ranch', 'Woodward', 'Utah Olympic Park', 'Hoedown Hill', 'Cimarron Mountain Club',
  'Three Forks Ranch', 'Black Mountain (formerly Evergreen Basin, now private)',
];
// Real public resorts whose mapped runs fall under the size filter (mostly ungroomed terrain).
const INCLUDE = ['Silverton Mountain', 'Echo Mountain'];

// Hand-checked details that OpenSkiMap lacks or that older links depend on (ids).
const OVERRIDES = {
  'Purgatory Resort': {
    region: 'Durango, CO', elevations: { base: 2680, mid: 2987, summit: 3298 },
    stations: [
      // First station is used for the history chart; Spud is closer to Purgatory's upper mountain.
      { source: 'snotel', id: '780:CO:SNTL', name: 'Spud Mountain', lat: 37.6988, lon: -107.7784, elev: 3250 },
      { source: 'snotel', id: '387:CO:SNTL', name: 'Cascade #2', lat: 37.6575, lon: -107.8029, elev: 2740 },
    ],
  },
  'Park City Mountain Resort': { name: 'Park City' },
  'Silverton Mountain': { region: 'Silverton, CO', elevations: { base: 3170, mid: 3640, summit: 4111 } },
  'Aspen Snowmass': { name: 'Snowmass' },
  'Howelson Hill Ski Area': { name: 'Howelsen Hill' },
  'Northstar at Tahoe Resort': { name: 'Northstar' },
};

const WHISTLER = {
  id: 'whistler', name: 'Whistler', region: 'Whistler, BC', state: 'BC',
  lat: 50.067, lon: -122.947, tz: 'America/Vancouver',
  elevations: { base: 675, mid: 1850, summit: 2182 },
  stations: [{ source: 'eccc', id: '1108906', name: 'Whistler Roundhouse', lat: 50.0678, lon: -122.9472, elev: 1835 }],
};

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const cleanName = (n) => n.replace(/\s*\(.*\)$/, '').replace(/ (Mountain Resort|Ski Resort|Downhill Ski Area|Ski Area|Ski Park|Resort)$/, '');
const km = (a, b, c, d) => 6371 * 2 * Math.asin(Math.sqrt(Math.sin(((c - a) * Math.PI) / 360) ** 2 + Math.cos((a * Math.PI) / 180) * Math.cos((c * Math.PI) / 180) * Math.sin(((d - b) * Math.PI) / 360) ** 2));
const r4 = (x) => Math.round(x * 1e4) / 1e4;

function centroid(geom) {
  if (geom.type === 'Point') return geom.coordinates;
  const rings = geom.type === 'Polygon' ? [geom.coordinates[0]] : geom.coordinates.map((p) => p[0]);
  const pts = rings.flat();
  return [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length];
}

async function snotelStations() {
  const all = [];
  for (const st of ['CO', 'UT', 'CA', 'NV']) {
    const q = new URLSearchParams({ stationTriplets: `*:${st}:SNTL`, returnForecastPointMetadata: 'false', returnReservoirMetadata: 'false', returnStationElements: 'false' });
    const r = await fetch(`https://wcc.sc.egov.usda.gov/awdbRestApi/services/v1/stations?${q}`);
    all.push(...(await r.json()));
  }
  // Active stations with data covering the calibration period.
  return all.filter((s) => s.endDate.startsWith('2100') && s.beginDate < '2022-10-01').map((s) => ({
    source: 'snotel', id: s.stationTriplet, name: s.name, lat: r4(s.latitude), lon: r4(s.longitude), elev: Math.round(s.elevation * 0.3048),
  }));
}

// Closest station within 25 km whose elevation is within the resort's skiable range.
function bestStation(r, stations) {
  let best = null;
  for (const s of stations) {
    const d = km(r.lat, r.lon, s.lat, s.lon);
    if (d > 25 || s.elev < r.elevations.base - 250 || s.elev > r.elevations.summit + 150) continue;
    const score = d + Math.abs(s.elev - r.elevations.mid) / 150;
    if (!best || score < best.score) best = { s, score };
  }
  return best ? [best.s] : [];
}

(async () => {
  const geo = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const stations = await snotelStations();
  const resorts = [];
  for (const f of geo.features) {
    const p = f.properties;
    const place = (p.places || []).find((x) => ['US-CO', 'US-UT', 'US-CA'].includes(x.iso3166_2));
    if (!place || !p.name || p.status !== 'operating' || !(p.activities || []).includes('downhill') || EXCLUDE.includes(p.name)) continue;
    const s = p.statistics || {};
    const runs = Object.values(s.runs?.byActivity?.downhill?.byDifficulty || {}).reduce((n, x) => n + (x.count || 0), 0);
    const big = runs >= MIN_RUNS && (s.maxElevation || 0) - (s.minElevation || 0) >= MIN_VERTICAL_M;
    if (!big && !INCLUDE.includes(p.name)) continue;
    const st = place.iso3166_2.slice(3);
    const o = OVERRIDES[p.name] || {};
    const name = o.name || cleanName(p.name);
    const [lon, lat] = centroid(f.geometry);
    const locality = place.localized?.en?.locality;
    const r = {
      id: slug(name), name, region: o.region || (locality ? `${locality}, ${st}` : STATES[st]), state: st,
      lat: r4(lat), lon: r4(lon), tz: TZ[st],
      elevations: o.elevations || { base: Math.round(s.minElevation), mid: Math.round((s.minElevation + s.maxElevation) / 2), summit: Math.round(s.maxElevation) },
    };
    r.stations = o.stations || bestStation(r, stations);
    resorts.push(r);
  }
  resorts.sort((a, b) => a.state.localeCompare(b.state) || a.name.localeCompare(b.name));
  resorts.push(WHISTLER);

  const lines = resorts.map((r) => `  ${JSON.stringify(r)},`).join('\n');
  const out = `// Mountains the site knows about, generated by scripts/build-resorts.cjs from
// OpenSkiMap data. Elevations are meters; stations are the nearby weather
// stations used for calibration and snowfall history (first = history chart).
const RESORTS = [
${lines}
];

const STATE_NAMES = { CO: 'Colorado', UT: 'Utah', CA: 'California', BC: 'British Columbia' };
const DEFAULT_RESORT = 'purgatory';

// Lift hours used for the overnight / lifts-open snow split.
const LIFTS_OPEN = 9;
const LIFTS_CLOSE = 16;

if (typeof module !== 'undefined') module.exports = { RESORTS, STATE_NAMES, DEFAULT_RESORT, LIFTS_OPEN, LIFTS_CLOSE };
`;
  fs.writeFileSync(path.join(__dirname, '..', 'resorts.js'), out);
  console.log(`${resorts.length} resorts, ${resorts.filter((r) => r.stations.length).length} with a station`);
  for (const r of resorts) console.log(`${r.state} ${r.name.padEnd(32)} ${r.id.padEnd(30)} ${r.stations.map((s) => s.name).join(' + ') || '—'}`);
})();
