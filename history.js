// Season snow depth and new-snow history from the resort's primary station
// (NRCS SNOTEL in the US, Environment Canada for Whistler).

const histState = { season: null, resortId: null, seq: 0 };

// Season is named by the year it starts (Oct 1 – Jun 30).
function currentSeason() {
  const d = new Date();
  return d.getMonth() >= 7 ? d.getFullYear() : d.getFullYear() - 1;
}

async function stationDepths(st, from, to) {
  const out = {}; // date -> depth in inches
  if (st.source === 'snotel') {
    const q = new URLSearchParams({ stationTriplets: st.id, elements: 'SNWD', duration: 'DAILY', beginDate: from, endDate: to });
    const r = await fetch(`https://wcc.sc.egov.usda.gov/awdbRestApi/services/v1/data?${q}`);
    if (!r.ok) throw new Error(`SNOTEL ${r.status}`);
    const data = await r.json();
    for (const v of data[0]?.data?.[0]?.values || []) if (v.value != null) out[v.date] = v.value;
  } else {
    const q = new URLSearchParams({ f: 'json', CLIMATE_IDENTIFIER: st.id, datetime: `${from}/${to}`, limit: '1000', properties: 'LOCAL_DATE,SNOW_ON_GROUND' });
    const r = await fetch(`https://api.weather.gc.ca/collections/climate-daily/items?${q}`);
    if (!r.ok) throw new Error(`Environment Canada ${r.status}`);
    const data = await r.json();
    for (const f of data.features) {
      const v = f.properties.SNOW_ON_GROUND;
      if (v != null) out[f.properties.LOCAL_DATE.slice(0, 10)] = v / 2.54;
    }
  }
  return out;
}

// One entry per day of the season; values are end-of-day readings.
function seasonSeries(depths, startYear) {
  const start = `${startYear}-10-01`, end = `${startYear + 1}-06-30`;
  const today = new Date().toISOString().slice(0, 10);
  const days = [];
  for (let d = start, prev = null; d <= end; d = addDays(d, 1)) {
    const depth = d <= today ? depths[d] ?? null : null;
    const gain = depth != null && prev != null ? depth - prev : 0;
    // Depth sensors jitter by about an inch; very large jumps are sensor errors.
    days.push({ date: d, depth, newSnow: gain >= 1 && gain <= 36 ? gain : 0 });
    if (depth != null) prev = depth;
  }
  return days;
}

function renderHistoryChart(cur, prev, startYear) {
  const W = 760, padL = 34, padR = 10, depthH = 170, snowH = 70, gap = 26, top = 12;
  const H = top + depthH + gap + snowH + 22;
  const n = cur.length;
  const x = (i) => padL + ((W - padL - padR) * i) / (n - 1);
  const maxDepth = Math.max(24, ...cur.map((d) => d.depth ?? 0), ...prev.map((d) => d.depth ?? 0));
  const dStep = maxDepth > 120 ? 40 : maxDepth > 60 ? 20 : 12;
  const dTop = Math.ceil(maxDepth / dStep) * dStep;
  const yd = (v) => top + depthH * (1 - v / dTop);
  const maxNew = Math.max(6, ...cur.map((d) => d.newSnow));
  const nTop = Math.ceil(maxNew / 6) * 6;
  const sTop = top + depthH + gap;
  const ys = (v) => sTop + snowH * (1 - v / nTop);

  const line = (series) => {
    let p = '', pen = false;
    series.forEach((d, i) => {
      if (d.depth == null) { pen = false; return; }
      p += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${yd(d.depth).toFixed(1)}`;
      pen = true;
    });
    return p;
  };

  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Season snow depth and new snow">`;
  for (let v = 0; v <= dTop; v += dStep) s += `<line class="grid" x1="${padL}" x2="${W - padR}" y1="${yd(v)}" y2="${yd(v)}"/><text x="${padL - 6}" y="${yd(v) + 4}" text-anchor="end">${v}"</text>`;
  s += `<text x="${padL}" y="${top - 2}">Snow depth</text>`;
  for (let v = 0; v <= nTop; v += nTop / 2) s += `<line class="grid" x1="${padL}" x2="${W - padR}" y1="${ys(v)}" y2="${ys(v)}"/><text x="${padL - 6}" y="${ys(v) + 4}" text-anchor="end">${v}"</text>`;
  s += `<text x="${padL}" y="${sTop - 6}">New snow per day</text>`;
  // Month ticks
  cur.forEach((d, i) => {
    if (d.date.endsWith('-01')) {
      const mon = new Date(d.date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short' });
      s += `<line class="grid" x1="${x(i)}" x2="${x(i)}" y1="${top}" y2="${sTop + snowH}" stroke-dasharray="2 4"/><text x="${x(i) + 3}" y="${H - 6}">${mon}</text>`;
    }
  });
  s += `<path class="depth-prev" d="${line(prev)}"/><path class="depth" d="${line(cur)}"/>`;
  const bw = Math.max(1.5, (W - padL - padR) / n - 0.6);
  cur.forEach((d, i) => {
    if (d.newSnow > 0) s += `<rect class="newsnow" x="${x(i) - bw / 2}" y="${ys(d.newSnow)}" width="${bw}" height="${ys(0) - ys(d.newSnow)}"><title>${d.date}: +${Math.round(d.newSnow)}"</title></rect>`;
  });
  s += `<g class="hist-legend"><line class="depth" x1="${W - 250}" x2="${W - 230}" y1="${top + 6}" y2="${top + 6}"/><text x="${W - 226}" y="${top + 10}">${startYear}–${String(startYear + 1).slice(2)}</text>`;
  s += `<line class="depth-prev" x1="${W - 150}" x2="${W - 130}" y1="${top + 6}" y2="${top + 6}"/><text x="${W - 126}" y="${top + 10}">Prior season</text></g>`;
  return s + '</svg>';
}

async function loadHistory(resort) {
  const seq = ++histState.seq;
  const sel = document.getElementById('seasonSel');
  if (histState.resortId !== resort.id || histState.season == null) {
    histState.resortId = resort.id;
    histState.season ??= currentSeason();
  }
  const cs = currentSeason();
  sel.innerHTML = Array.from({ length: 8 }, (_, k) => cs - k)
    .map((y) => `<option value="${y}" ${y === histState.season ? 'selected' : ''}>${y}–${String(y + 1).slice(2)} season</option>`).join('');
  sel.onchange = () => { histState.season = +sel.value; loadHistory(resort); };

  const st = resort.stations[0];
  const y = histState.season;
  document.getElementById('historyStats').innerHTML = '';
  document.getElementById('historyNote').textContent = '';
  if (!st) {
    document.getElementById('history').innerHTML = `<p class="hint">There's no snow station near ${resort.name}, so no history is available.</p>`;
    return;
  }
  document.getElementById('history').innerHTML = '<p class="hint">Loading station history…</p>';
  try {
    const depths = await stationDepths(st, `${y - 1}-09-30`, `${y + 1}-06-30`);
    if (seq !== histState.seq) return;
    const cur = seasonSeries(depths, y), prev = seasonSeries(depths, y - 1);
    const total = sum(cur.map((d) => d.newSnow));
    const known = cur.filter((d) => d.depth != null);
    const last = known[known.length - 1];
    const peak = known.reduce((m, d) => (d.depth > (m?.depth ?? -1) ? d : m), null);
    const biggest = cur.reduce((m, d) => (d.newSnow > (m?.newSnow ?? 0) ? d : m), null);
    const sameDayPrev = last ? prev[cur.indexOf(last)] : null;
    const fmtDate = (d) => new Date(d + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const cells = [
      { k: 'Season new snow', v: `${Math.round(total)}"`, r: 'from depth gains' },
      { k: last ? `Depth ${fmtDate(last.date)}` : 'Depth', v: last ? `${Math.round(last.depth)}"` : '–', r: sameDayPrev?.depth != null ? `prior season: ${Math.round(sameDayPrev.depth)}"` : '' },
      { k: 'Peak depth', v: peak ? `${Math.round(peak.depth)}"` : '–', r: peak ? fmtDate(peak.date) : '' },
      { k: 'Biggest day', v: biggest ? `${Math.round(biggest.newSnow)}"` : '–', r: biggest ? fmtDate(biggest.date) : '' },
    ];
    document.getElementById('historyStats').innerHTML = cells.map((c) =>
      `<div class="stat"><div class="k">${c.k}</div><div class="v">${c.v}</div><div class="r">${c.r}</div></div>`).join('');
    document.getElementById('history').innerHTML = renderHistoryChart(cur, prev, y);
    const latest = Object.keys(depths).sort().at(-1);
    const stale = latest && (Date.now() - Date.parse(latest)) / 86400000 > 3 ? ` Latest station reading: ${fmtDate(latest)} ${latest.slice(0, 4)}.` : '';
    document.getElementById('historyNote').textContent =
      `Station: ${st.name} (${Math.round(mToFt(st.elev)).toLocaleString()} ft).${stale} Resorts measure new snow on a cleared board several times a day, so their reported totals usually run higher than this.`;
  } catch (e) {
    console.error(e);
    if (seq === histState.seq) document.getElementById('history').innerHTML = `<p class="status err">Couldn't load station history: ${e.message}</p>`;
  }
}
