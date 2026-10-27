// Page rendering. Forecast math lives in core.js; station history in history.js.

const POWDER_DAY_IN = 6; // a ski day with at least this much is flagged

const fmtIn = (x) => (x == null ? '–' : x < 0.05 ? '0"' : x < 1 ? `${x.toFixed(1)}"` : `${Math.round(x)}"`);
const fmtRange = (lo, hi) => `${fmtIn(lo).replace('"', '')}–${fmtIn(hi)}`;
const ftLabel = (m) => `${(Math.round(mToFt(m) / 10) * 10).toLocaleString()}′`;

function dayLabel(dateStr, todayStr) {
  const d = new Date(dateStr + 'T12:00:00');
  const diff = Math.round((d - new Date(todayStr + 'T12:00:00')) / 86400000);
  const wk = d.toLocaleDateString('en-US', { weekday: 'short' });
  const md = d.toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' });
  if (diff === 0) return { short: 'Today', long: `Today ${md}` };
  if (diff === 1) return { short: 'Tmrw', long: `Tomorrow ${md}` };
  return { short: wk, long: `${wk} ${md}` };
}

function compass(deg) {
  if (deg == null) return '';
  return ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(deg / 45) % 8];
}

function icon({ snow, rainIn, cloud }) {
  if (snow >= 0.5) return '🌨️';
  if (rainIn >= 0.05) return '🌧️';
  if (snow >= 0.1) return '🌨️';
  if (cloud == null) return '';
  if (cloud < 20) return '☀️';
  if (cloud < 45) return '🌤️';
  if (cloud < 75) return '⛅';
  return '☁️';
}

const $ = (id) => document.getElementById(id);
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
};

const state = {
  resortId: location.hash.slice(1) || store.get('resort') || 'purgatory',
  elev: store.get('elev') || 'mid',
  calibration: null,
  days: [], ens: {}, todayStr: '', selected: null,
};
if (!RESORTS.some((r) => r.id === state.resortId)) state.resortId = 'purgatory';
const resort = () => RESORTS.find((r) => r.id === state.resortId);
const todayIndex = () => state.days.findIndex((d) => d.date === state.todayStr);

// ---------- header ----------

function renderHeader() {
  const r = resort();
  document.title = `${r.name} Snow Forecast`;
  $('resortName').textContent = r.name;
  $('resortSub').textContent = `${r.region} · 14-day calibrated snow forecast`;
  $('resortNav').innerHTML = RESORTS.map((x) => `<button data-id="${x.id}" class="${x.id === r.id ? 'on' : ''}">${x.name}</button>`).join('');
  $('elevSeg').innerHTML = ['base', 'mid', 'summit'].map((k) =>
    `<button data-elev="${k}" class="${k === state.elev ? 'on' : ''}">${k[0].toUpperCase() + k.slice(1)} ${ftLabel(r.elevations[k])}</button>`).join('');
}

// ---------- forecast sections ----------

function renderBanner() {
  const ti = todayIndex();
  const next = state.days.slice(ti, ti + 3).filter((d) => d.snow >= POWDER_DAY_IN || d.overnight >= 4);
  const el = $('alertBanner');
  if (!next.length) { el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML = '❄️ <b>Powder alert:</b> ' + next.map((d) =>
    `${dayLabel(d.date, state.todayStr).long}: ${fmtIn(d.snow)} (${fmtIn(d.overnight)} by 9 am)`).join(' · ');
}

function renderSummary() {
  const ti = todayIndex();
  const past = state.days.filter((d) => d.past);
  const cells = [
    { k: `Past ${past.length} days`, v: sum(past.map((d) => d.snow)), r: 'modeled' },
    { k: 'Next 5 days', p: periodTotal(state.days, state.ens, ti, ti + 4) },
    { k: 'Days 6–10', p: periodTotal(state.days, state.ens, ti + 5, ti + 9) },
    { k: 'Days 11–14', p: periodTotal(state.days, state.ens, ti + 10, ti + 13) },
    { k: 'Next 14 days', p: periodTotal(state.days, state.ens, ti, ti + 13) },
  ];
  $('summary').innerHTML = cells.map((c) => {
    const v = c.p ? c.p.snow : c.v;
    const r = c.p?.range ? `range ${fmtRange(c.p.range.lo, c.p.range.hi)}` : c.r || '';
    return `<div class="stat"><div class="k">${c.k}</div><div class="v">${fmtIn(v)}</div><div class="r">${r}</div></div>`;
  }).join('');
}

function renderChart() {
  const days = state.days;
  const W = Math.max(720, days.length * 46), H = 250, padL = 30, padB = 40, padT = 30;
  // Scale to the bars, with headroom; taller range whiskers are clipped with an arrow.
  const maxV = Math.max(4, ...days.map((d) => d.snow * 1.6));
  const step = maxV > 24 ? 6 : maxV > 12 ? 4 : maxV > 6 ? 2 : 1;
  const top = Math.ceil(maxV / step) * step;
  const y = (v) => padT + (H - padT - padB) * (1 - Math.min(v, top) / top);
  const bw = (W - padL - 10) / days.length;
  const ti = todayIndex();
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Daily snowfall chart">`;
  if (ti >= 0) s += `<rect class="today" x="${padL + ti * bw}" y="${padT - 26}" width="${bw}" height="${H - padT - padB + 60}" rx="6"/>`;
  for (let v = 0; v <= top; v += step) {
    s += `<line class="grid" x1="${padL}" x2="${W - 5}" y1="${y(v)}" y2="${y(v)}"/><text x="${padL - 6}" y="${y(v) + 4}" text-anchor="end">${v}"</text>`;
  }
  days.forEach((d, i) => {
    const x = padL + i * bw, cx = x + bw / 2;
    const cls = d.past ? 'past' : i - ti > 9 ? 'far' : '';
    const bx = x + bw * 0.28, bwid = bw * 0.44;
    const r = !d.past && d.range && d.range.hi - d.range.lo > 0.1 ? d.range : null;
    const tip = `${d.date}: ${fmtIn(d.snow)} total · ${fmtIn(d.overnight)} before lifts open, ${fmtIn(d.lifts)} while open${r ? ` · could be ${fmtRange(r.lo, r.hi)}` : ''}`;
    s += `<g class="bar ${cls}" data-date="${d.date}"><title>${tip}</title>`;
    s += `<rect class="hit" x="${x}" y="${padT}" width="${bw}" height="${H - padT - padB}"/>`;
    if (r) {
      // Whisker behind the bar: thin line from low to high with end caps.
      const clipped = r.hi > top;
      s += `<line class="whisker" x1="${cx}" x2="${cx}" y1="${y(r.lo)}" y2="${y(r.hi)}"/>`;
      s += `<line class="whisker" x1="${cx - 5}" x2="${cx + 5}" y1="${y(r.lo)}" y2="${y(r.lo)}"/>`;
      s += clipped
        ? `<path class="whisker-arrow" d="M${cx - 4},${y(top) + 5} L${cx},${y(top) - 1} L${cx + 4},${y(top) + 5} Z"/><text class="whisker-max" x="${cx}" y="${y(top) - 5}" text-anchor="middle">${fmtIn(r.hi)}</text>`
        : `<line class="whisker" x1="${cx - 5}" x2="${cx + 5}" y1="${y(r.hi)}" y2="${y(r.hi)}"/>`;
    }
    s += `<rect class="night" x="${bx}" y="${y(d.overnight)}" width="${bwid}" height="${Math.max(0, y(0) - y(d.overnight))}"/>`;
    s += `<rect class="day" x="${bx}" y="${y(d.snow)}" width="${bwid}" height="${Math.max(0, y(d.overnight) - y(d.snow))}"/></g>`;
    // Total sits on the bar; its halo (see .val in CSS) keeps the whisker from crossing the number.
    if (d.snow >= 0.1) s += `<text class="val" x="${cx}" y="${y(d.snow) - 5}" text-anchor="middle" paint-order="stroke">${fmtIn(d.snow)}</text>`;
    s += `<text class="${i === ti ? 'today-lbl' : ''}" x="${cx}" y="${H - padB + 16}" text-anchor="middle">${dayLabel(d.date, state.todayStr).short}</text>`;
    s += `<text x="${cx}" y="${H - padB + 30}" text-anchor="middle">${d.date.slice(5).replace('-', '/')}</text>`;
  });
  $('chart').innerHTML = s + '</svg>';
  $('chart').querySelectorAll('.bar').forEach((b) => b.addEventListener('click', () => selectDay(b.dataset.date)));
}

function renderDays() {
  const ti = todayIndex();
  $('days').innerHTML = state.days.map((d, i) => {
    const lbl = dayLabel(d.date, state.todayStr);
    const type = d.slr ? snowType(d.slr) : null;
    const conf = confidence(d, i - ti);
    const rng = d.range && !d.past && d.range.hi >= 0.2 ? `<small>(${fmtRange(d.range.lo, d.range.hi)})</small>` : '';
    const powder = !d.past && d.snow >= POWDER_DAY_IN ? '<span class="badge">Powder day</span>' : '';
    return `<button class="day ${d.past ? 'past' : ''} ${state.selected === d.date ? 'sel' : ''}" data-date="${d.date}">
      <div class="d-head"><span class="d-date">${lbl.long} ${powder}</span><span class="d-icon">${icon(d)}</span></div>
      <div class="d-snow">${fmtIn(d.snow)} ${rng}</div>
      <div class="split"><span><i class="sw sw-night"></i>Overnight ${fmtIn(d.overnight)}</span><span><i class="sw sw-day"></i>Lifts open ${fmtIn(d.lifts)}</span></div>
      <div class="d-type ${type ? type.cls : ''}">${type ? `${type.label} · ${Math.round(d.slr)}:1` : d.rainIn >= 0.05 ? `<span class="t-wet">Rain ${d.rainIn.toFixed(2)}"</span>` : '&nbsp;'}
        ${conf ? ` <span class="conf">${conf} confidence</span>` : d.past ? ' <span class="conf">past</span>' : ''}</div>
      <dl>
        <dt>High / Low</dt><dd>${Math.round(d.hi)}° / ${Math.round(d.lo)}°F</dd>
        <dt>Wind (lift hours)</dt><dd>${compass(d.dir)} ${Math.round(d.wind)} mph, gusts ${Math.round(d.gust)}</dd>
        <dt>Cloud cover</dt><dd>${Math.round(d.cloud)}%</dd>
        <dt>Snow water</dt><dd>${mmToIn(d.swe).toFixed(2)}"</dd>
        ${d.snowLevel != null ? `<dt>Snow level</dt><dd>${(Math.round(d.snowLevel / 100) * 100).toLocaleString()} ft</dd>` : ''}
        <dt>Models</dt><dd>${d.nModels} · ${fmtIn(d.modelMin)}–${fmtIn(d.modelMax)}</dd>
      </dl>
    </button>`;
  }).join('');
  $('days').querySelectorAll('.day').forEach((b) => b.addEventListener('click', () => selectDay(b.dataset.date)));
}

function heat(v) {
  if (v == null || v < 0.1) return '';
  return `style="background: rgba(95,179,255,${Math.min(0.85, 0.12 + v / 14).toFixed(2)})"`;
}

function renderModels() {
  const fut = state.days.filter((d) => !d.past);
  const head = `<tr><th class="name">Model</th>${fut.map((d) => `<th>${dayLabel(d.date, state.todayStr).short}<br>${d.date.slice(5).replace('-', '/')}</th>`).join('')}<th>Total</th></tr>`;
  const row = (name, note, vals, cls = '') => {
    const known = vals.filter((v) => v != null);
    return `<tr class="${cls}"><td class="name">${name}${note ? `<br><small class="muted">${note}</small>` : ''}</td>${vals.map((v) => `<td class="heat" ${heat(v)}>${v == null ? '' : fmtIn(v)}</td>`).join('')}<td><b>${fmtIn(sum(known))}</b></td></tr>`;
  };
  const rows = [
    row('Blend', 'weighted', fut.map((d) => d.snow), 'blend'),
    row('Ensemble median', '82 runs', fut.map((d) => d.range?.p50 ?? null)),
    ...MODELS.map((m) => row(m.name, m.note, fut.map((d) => d.perModel[m.id] ?? null))),
  ];
  $('models').innerHTML = `<table>${head}${rows.join('')}</table>`;
}

function renderDetail() {
  const day = state.days.find((d) => d.date === state.selected);
  if (!day) { $('detailCard').hidden = true; return; }
  $('detailCard').hidden = false;
  $('detailTitle').textContent = `Hourly · ${dayLabel(day.date, state.todayStr).long}`;
  const rows = day.hours.map((h) => {
    const slr = h.swe > 0.05 ? h.snow / mmToIn(h.swe) : null;
    const hr = new Date(`${h.time}:00`).toLocaleTimeString('en-US', { hour: 'numeric' });
    const open = h.date === day.date && h.hour >= LIFTS_OPEN && h.hour < LIFTS_CLOSE;
    const sep = h.date === day.date && (h.hour === 0 || h.hour === LIFTS_OPEN)
      ? `<tr class="sep"><td colspan="10">${h.hour === 0 ? dayLabel(day.date, state.todayStr).long : 'Lifts open'}</td></tr>` : '';
    return `${sep}<tr class="${open ? 'open' : ''}"><td>${hr}</td><td>${icon({ snow: h.snow * 6, rainIn: mmToIn(h.rain) * 6, cloud: h.cloud })}</td>
      <td class="heat" ${heat(h.snow * 6)}>${h.snow >= 0.05 ? h.snow.toFixed(1) + '"' : ''}</td>
      <td>${slr ? Math.round(slr) + ':1' : ''}</td>
      <td>${Math.round(h.tempF)}°</td><td>${compass(h.dir)} ${Math.round(h.wind)}</td><td>${Math.round(h.gust)}</td>
      <td>${Math.round(h.cloud)}%</td><td>${h.freezeFt ? (Math.round((h.freezeFt - 1000) / 100) * 100).toLocaleString() : ''}</td><td>${h.nModels}</td></tr>`;
  }).join('');
  const models = MODELS.filter((m) => day.perModel[m.id] != null).map((m) => `${m.name}: <b>${fmtIn(day.perModel[m.id])}</b>`).join(' · ');
  $('detail').innerHTML = `<p class="hint">${models}</p>
    <div class="table-wrap"><table>
    <tr><th>Time</th><th></th><th>Snow</th><th>Ratio</th><th>Temp</th><th>Wind mph</th><th>Gust</th><th>Cloud</th><th>Snow lvl ft</th><th>Models</th></tr>
    <tr class="sep"><td colspan="10">Overnight (from 4 pm the day before)</td></tr>
    ${rows}</table></div>`;
}

function renderCalibration() {
  const c = state.calibration?.resorts?.[state.resortId];
  if (!c) { $('calib').innerHTML = ''; return; }
  const rows = MODELS.filter((m) => c.models[m.id]).map((m) => {
    const x = c.models[m.id];
    const pct = Math.round((x.ratio - 1) * 100);
    return `<tr><td class="name">${m.name}</td><td>${pct >= 0 ? '+' : ''}${pct}%</td><td>${x.r.toFixed(2)}</td><td>${x.weight.toFixed(2)}</td></tr>`;
  }).join('');
  const k = c.check;
  $('calib').innerHTML = `<p class="hint">Calibration for ${resort().name} against ${c.stations.join(' + ')}, ${c.period}.
    Raw models forecast <b>${k.rawPctOfObserved}%</b> of the precipitation that fell; after calibration, <b>${k.calibratedPctOfObserved}%</b>.</p>
    <table><tr><th class="name">Model</th><th>Correction</th><th>Skill (r)</th><th>Weight</th></tr>${rows}</table>`;
}

function selectDay(date) {
  state.selected = state.selected === date ? null : date;
  renderDays();
  renderDetail();
  if (state.selected) $('detailCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ---------- loading ----------

async function loadCalibration() {
  try { state.calibration = await (await fetch('data/calibration.json')).json(); }
  catch (e) { console.warn('No calibration file', e); }
}

let loadSeq = 0;
async function load() {
  const seq = ++loadSeq;
  const r = resort();
  const elevM = r.elevations[state.elev];
  renderHeader();
  renderCalibration();
  $('status').className = 'status';
  $('status').textContent = 'Loading forecast models…';
  try {
    const f = await getForecast(r, elevM, state.calibration?.resorts?.[r.id]);
    if (seq !== loadSeq) return; // a newer request replaced this one
    Object.assign(state, { days: f.days, ens: f.ens, todayStr: f.todayStr });
    renderBanner();
    renderSummary();
    renderChart();
    renderDays();
    renderModels();
    renderDetail();
    const t = new Date().toLocaleString('en-US', { timeZone: r.tz, weekday: 'short', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
    $('status').textContent = `Updated ${t} · ${ftLabel(elevM)}${f.hasEnsemble ? '' : ' · ensemble range unavailable'}`;
  } catch (e) {
    console.error(e);
    $('status').className = 'status err';
    $('status').textContent = `Couldn't load the forecast: ${e.message}`;
  }
}

$('resortNav').addEventListener('click', (e) => {
  const id = e.target.closest('button')?.dataset.id;
  if (!id || id === state.resortId) return;
  state.resortId = id;
  state.selected = null;
  store.set('resort', id);
  history.replaceState(null, '', '#' + id);
  load();
  loadHistory(resort());
});
$('elevSeg').addEventListener('click', (e) => {
  const k = e.target.closest('button')?.dataset.elev;
  if (!k) return;
  state.elev = k;
  store.set('elev', k);
  load();
});
$('refresh').addEventListener('click', load);
$('closeDetail').addEventListener('click', () => selectDay(state.selected));

loadCalibration().then(load);
loadHistory(resort());

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
