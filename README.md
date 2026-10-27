# Snow Forecast

A static website (no build step, no API key) with calibrated 14-day snow forecasts for
Purgatory, Wolf Creek, Vail, Park City and Whistler. Installable on iPhone from Safari
(Share → Add to Home Screen).

## Run it locally

```bash
python3 -m http.server 8765
```

Then open http://localhost:8765.

## How it works

- `core.js`: forecast engine. Blends 7 models from [Open-Meteo](https://open-meteo.com/), applies
  calibration, converts snow water to inches with a temperature-based snow ratio, and splits
  each ski day into overnight (4 pm–9 am) and lifts-open (9 am–4 pm) snow.
- `resorts.js`: the mountains, their elevations and the weather stations used for each.
- `app.js`, `history.js`, `index.html`, `styles.css`: the page.
- `data/calibration.json`: per-model correction factors and weights, made by
  `node scripts/calibrate.cjs`, which compares archived model forecasts with what NRCS SNOTEL
  stations (US) and Environment Canada (Whistler) measured since Nov 2022.

## Adding a mountain

Add an entry to `resorts.js` (find the nearest SNOTEL station at
https://wcc.sc.egov.usda.gov/nwcc/inventory), then run `node scripts/calibrate.cjs`.

## Powder alerts

`scripts/alerts.cjs` checks each mountain and sends a push notification through
[ntfy](https://ntfy.sh) when tomorrow has ≥ 4" by 9 am, any of the next 3 days has ≥ 6",
or the 3-day total is ≥ 12". `.github/workflows/powder-alerts.yml` runs it every evening.

1. Install the free **ntfy** app on your iPhone and subscribe to a long, random topic name
   (anyone who knows the name can read it).
2. In the GitHub repo: Settings → Secrets and variables → Actions → add secret `NTFY_TOPIC`
   with that topic name. Optional variables: `SITE_URL`, `ALERT_RESORTS` (e.g. `purgatory,wolf-creek`),
   and thresholds `OVERNIGHT_IN`, `DAY_IN`, `STORM_IN` can be set as env in the workflow.

`.github/workflows/calibrate.yml` re-runs calibration monthly so it learns from each new winter.
