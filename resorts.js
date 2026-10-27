// Mountains the site knows about. Elevations are meters; stations are the
// nearby weather stations used for calibration and snowfall history.
const RESORTS = [
  {
    id: 'purgatory', name: 'Purgatory', region: 'Durango, CO',
    lat: 37.6303, lon: -107.8139, tz: 'America/Denver',
    elevations: { base: 2680, mid: 2987, summit: 3298 },
    stations: [
      // First station is used for the history chart; Spud is closer to Purgatory's upper mountain.
      { source: 'snotel', id: '780:CO:SNTL', name: 'Spud Mountain', lat: 37.6988, lon: -107.7784, elev: 3250 },
      { source: 'snotel', id: '387:CO:SNTL', name: 'Cascade #2', lat: 37.6575, lon: -107.8029, elev: 2740 },
    ],
  },
  {
    id: 'wolf-creek', name: 'Wolf Creek', region: 'Pagosa Springs, CO',
    lat: 37.4722, lon: -106.7933, tz: 'America/Denver',
    elevations: { base: 3139, mid: 3353, summit: 3628 },
    stations: [{ source: 'snotel', id: '874:CO:SNTL', name: 'Wolf Creek Summit', lat: 37.4790, lon: -106.8023, elev: 3331 }],
  },
  {
    id: 'vail', name: 'Vail', region: 'Vail, CO',
    lat: 39.616, lon: -106.372, tz: 'America/Denver',
    elevations: { base: 2475, mid: 3124, summit: 3527 },
    stations: [{ source: 'snotel', id: '842:CO:SNTL', name: 'Vail Mountain', lat: 39.6177, lon: -106.3802, elev: 3136 }],
  },
  {
    id: 'park-city', name: 'Park City', region: 'Park City, UT',
    lat: 40.637, lon: -111.53, tz: 'America/Denver',
    elevations: { base: 2073, mid: 2560, summit: 3056 },
    stations: [{ source: 'snotel', id: '814:UT:SNTL', name: 'Thaynes Canyon', lat: 40.6235, lon: -111.5332, elev: 2823 }],
  },
  {
    id: 'whistler', name: 'Whistler', region: 'Whistler, BC',
    lat: 50.067, lon: -122.947, tz: 'America/Vancouver',
    elevations: { base: 675, mid: 1850, summit: 2182 },
    stations: [{ source: 'eccc', id: '1108906', name: 'Whistler Roundhouse', lat: 50.0678, lon: -122.9472, elev: 1835 }],
  },
];

// Lift hours used for the overnight / lifts-open snow split.
const LIFTS_OPEN = 9;
const LIFTS_CLOSE = 16;

if (typeof module !== 'undefined') module.exports = { RESORTS, LIFTS_OPEN, LIFTS_CLOSE };
