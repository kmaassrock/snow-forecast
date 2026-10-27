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
  const weekend = d.getDay() === 0 || d.getDay() === 6;
  if (diff === 0) return { short: 'Today', long: `Today ${md}`, wk, md, weekend };
  if (diff === 1) return { short: 'Tmw', long: `Tomorrow ${md}`, wk, md, weekend };
  return { short: wk, long: `${wk} ${md}`, wk, md, weekend };
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

function loadFavorites() {
  try { return JSON.parse(store.get('favorites')) || [DEFAULT_RESORT]; } catch { return [DEFAULT_RESORT]; }
}

const state = {
  // The app opens on Purgatory unless a link names a mountain (#vail).
  resortId: location.hash.slice(1) || DEFAULT_RESORT,
  elev: store.get('elev') || 'mid',
  favorites: loadFavorites(),
  calibration: null,
  days: [], ens: {}, todayStr: '', selected: null,
};
if (!RESORTS.some((r) => r.id === state.resortId)) state.resortId = DEFAULT_RESORT;
const resort = () => RESORTS.find((r) => r.id === state.resortId);
const todayIndex = () => state.days.findIndex((d) => d.date === state.todayStr);
const upcoming = () => state.days.slice(Math.max(0, todayIndex()));

// ---------- header ----------

function renderPicker() {
  const opt = (r) => `<option value="${r.id}" ${r.id === state.resortId ? 'selected' : ''}>${r.name}</option>`;
  const favs = state.favorites.map((id) => RESORTS.find((r) => r.id === id)).filter(Boolean);
  let html = favs.length ? `<optgroup label="★ Favorites">${favs.map(opt).join('')}</optgroup>` : '';
  for (const [code, label] of Object.entries(STATE_NAMES)) {
    const rs = RESORTS.filter((r) => r.state === code && !state.favorites.includes(r.id));
    if (rs.length) html += `<optgroup label="${label}">${rs.map(opt).join('')}</optgroup>`;
  }
  $('resortSel').innerHTML = html;
}

function renderHeader() {
  const r = resort();
  document.title = `${r.name} Snow Forecast`;
  $('resortName').textContent = r.name;
  const fav = state.favorites.includes(r.id);
  $('favBtn').textContent = fav ? '★' : '☆';
  $('favBtn').classList.toggle('on', fav);
  $('favBtn').setAttribute('aria-label', fav ? 'Remove from favorites' : 'Add to favorites');
  $('resortSub').textContent = `${ftLabel(r.elevations.base)}–${ftLabel(r.elevations.summit)} · ${r.region}`;
  $('elevSeg').innerHTML = ['base', 'mid', 'summit'].map((k) =>
    `<button data-elev="${k}" class="${k === state.elev ? 'on' : ''}" title="${ftLabel(r.elevations[k])}">${k[0].toUpperCase() + k.slice(1)}</button>`).join('');
  renderPicker();
}

// ---------- snow summary (OpenSnow style) ----------

function renderBanner() {
  const next = upcoming().slice(0, 3).filter((d) => d.snow >= POWDER_DAY_IN || d.overnight >= 4);
  const el = $('alertBanner');
  if (!next.length) { el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML = '❄️ <b>Powder alert:</b> ' + next.map((d) =>
    `${dayLabel(d.date, state.todayStr).long}: ${fmtIn(d.snow)} (${fmtIn(d.overnight)} by 9 am)`).join(' · ');
}

function renderSnowSummary() {
  const ti = todayIndex();
  const days = upcoming().slice(0, 15);
  const periods = [[0, 4, 'Next 1–5 Days'], [5, 9, 'Next 6–10 Days'], [10, 14, 'Next 11–15 Days']].map(([a, b, label]) => {
    const p = periodTotal(state.days, state.ens, ti + a, ti + b);
    return `<div class="period" style="flex:${Math.min(b, days.length - 1) - a + 1}">
      <div class="p-label">${label}</div>
      <div class="p-total"><span>${p ? fmtIn(p.snow) : '–'}</span></div>
      <div class="p-range">${p?.range ? `range ${fmtRange(p.range.lo, p.range.hi)}` : '&nbsp;'}</div>
    </div>`;
  }).join('');
  const max = Math.max(3, ...days.map((d) => d.snow));
  const bars = days.map((d) => {
    const lbl = dayLabel(d.date, state.todayStr);
    // Bar height in px, leaving room in the track for the total that sits on top of it.
    const h = d.snow < 0.05 ? 0 : Math.max(4, (d.snow / max) * 90);
    const cls = d.snow >= POWDER_DAY_IN ? 'big' : d.snow < 0.05 ? 'none' : '';
    return `<button class="col ${d.date === state.selected ? 'sel' : ''}" data-date="${d.date}" aria-label="${lbl.long}: ${fmtIn(d.snow)}">
      <span class="b-track"><span class="b-val">${d.snow >= 1 ? fmtIn(d.snow) : ''}</span><span class="b ${cls}" style="height:${h}px"></span></span>
      <span class="b-wk ${lbl.weekend ? 'wknd' : ''}">${lbl.weekend ? lbl.wk.slice(0, 2) : lbl.wk[0]}</span>
      <span class="b-dt ${lbl.weekend ? 'wknd' : ''} ${d.date === state.todayStr ? 'today' : ''}">${+d.date.slice(8)}</span>
    </button>`;
  }).join('');
  const past = state.days.filter((d) => d.past);
  $('snowSummary').innerHTML = `<div class="periods">${periods}</div><div class="bars">${bars}</div>
    <p class="hint">Past ${past.length} days (modeled): <b>${fmtIn(sum(past.map((d) => d.snow)))}</b> · Orange = powder day (${POWDER_DAY_IN}"+). Each day runs 4 pm the day before to 4 pm.</p>`;
  $('snowSummary').querySelectorAll('.col').forEach((b) => b.addEventListener('click', () => selectDay(b.dataset.date, true)));
}

// ---------- daily list ----------

function dayDetail(d, lead) {
  const conf = confidence(d, lead);
  const r = d.range && !d.past ? d.range : null;
  const models = MODELS.filter((m) => d.perModel[m.id] != null).map((m) => `${m.name} <b>${fmtIn(d.perModel[m.id])}</b>`).join(' · ');
  const rows = d.hours.map((h) => {
    const slr = h.swe > 0.05 ? h.snow / mmToIn(h.swe) : null;
    const hr = new Date(`${h.time}:00`).toLocaleTimeString('en-US', { hour: 'numeric' });
    const open = h.date === d.date && h.hour >= LIFTS_OPEN && h.hour < LIFTS_CLOSE;
    const sep = h.date === d.date && (h.hour === 0 || h.hour === LIFTS_OPEN)
      ? `<tr class="sep"><td colspan="9">${h.hour === 0 ? dayLabel(d.date, state.todayStr).long : 'Lifts open'}</td></tr>` : '';
    return `${sep}<tr class="${open ? 'open' : ''}"><td>${hr}</td><td>${icon({ snow: h.snow * 6, rainIn: mmToIn(h.rain) * 6, cloud: h.cloud })}</td>
      <td class="heat" ${heat(h.snow * 6)}>${h.snow >= 0.05 ? h.snow.toFixed(1) + '"' : ''}</td>
      <td>${slr ? Math.round(slr) + ':1' : ''}</td>
      <td>${Math.round(h.tempF)}°</td><td>${compass(h.dir)} ${Math.round(h.wind)}</td><td>${Math.round(h.gust)}</td>
      <td>${Math.round(h.cloud)}%</td><td>${h.freezeFt ? (Math.round((h.freezeFt - 1000) / 100) * 100).toLocaleString() : ''}</td></tr>`;
  }).join('');
  return `<div class="detail">
    <dl>
      <dt>Before lifts open</dt><dd>${fmtIn(d.overnight)}</dd>
      <dt>While lifts open</dt><dd>${fmtIn(d.lifts)}</dd>
      ${r ? `<dt>Could be</dt><dd>${fmtRange(r.lo, r.hi)}${conf ? ` · ${conf.toLowerCase()} confidence` : ''}</dd>` : ''}
      <dt>Snow water</dt><dd>${mmToIn(d.swe).toFixed(2)}"</dd>
      ${d.rainIn >= 0.05 ? `<dt>Rain</dt><dd>${d.rainIn.toFixed(2)}"</dd>` : ''}
      <dt>Wind (lift hours)</dt><dd>${compass(d.dir)} ${Math.round(d.wind)} mph, gusts ${Math.round(d.gust)}</dd>
      <dt>Cloud cover</dt><dd>${Math.round(d.cloud)}%</dd>
      ${d.snowLevel != null ? `<dt>Snow level</dt><dd>${(Math.round(d.snowLevel / 100) * 100).toLocaleString()} ft</dd>` : ''}
    </dl>
    <p class="hint">${models}</p>
    <div class="table-wrap"><table>
      <tr><th>Time</th><th></th><th>Snow</th><th>Ratio</th><th>Temp</th><th>Wind</th><th>Gust</th><th>Cloud</th><th>Snow lvl</th></tr>
      <tr class="sep"><td colspan="9">From 4 pm the day before</td></tr>${rows}
    </table></div>
  </div>`;
}

function renderDays() {
  const ti = todayIndex();
  $('days').innerHTML = upcoming().map((d, i) => {
    const lbl = dayLabel(d.date, state.todayStr);
    const type = d.slr && d.snow >= 0.5 ? snowType(d.slr) : null;
    const open = state.selected === d.date;
    return `<div class="drow ${open ? 'open' : ''}" data-date="${d.date}">
      <button class="dmain" aria-expanded="${open}">
        <span class="d-day"><b>${lbl.short === 'Today' || lbl.short === 'Tmw' ? lbl.short : lbl.wk}</b><small>${lbl.md}</small></span>
        <span class="d-icon">${icon(d)}</span>
        <span class="d-snow ${d.snow >= POWDER_DAY_IN ? 'big' : ''}">${fmtIn(d.snow)}</span>
        <span class="d-type">${type ? `<span class="${type.cls}">${type.label}</span>` : d.rainIn >= 0.05 ? '<span class="t-wet">Rain</span>' : ''}</span>
        <span class="d-temp">${Math.round(d.hi)}° <small>${Math.round(d.lo)}°</small></span>
        <span class="d-wind">${compass(d.dir)} ${Math.round(d.wind)}<small> mph</small></span>
        <span class="d-chev">›</span>
      </button>
      ${open ? dayDetail(d, i) : ''}
    </div>`;
  }).join('');
  $('days').querySelectorAll('.dmain').forEach((b) => b.addEventListener('click', () => selectDay(b.parentElement.dataset.date)));
}

function selectDay(date, scroll) {
  state.selected = state.selected === date && !scroll ? null : date;
  renderDays();
  renderSnowSummary();
  if (scroll && state.selected) document.querySelector(`.drow[data-date="${date}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ---------- lift-hours chart ----------

function renderChart() {
  const days = upcoming();
  const W = Math.max(720, days.length * 46), H = 250, padL = 30, padB = 40, padT = 30;
  // Scale to the bars, with headroom; taller range whiskers are clipped with an arrow.
  const maxV = Math.max(4, ...days.map((d) => d.snow * 1.6));
  const step = maxV > 24 ? 6 : maxV > 12 ? 4 : maxV > 6 ? 2 : 1;
  const top = Math.ceil(maxV / step) * step;
  const y = (v) => padT + (H - padT - padB) * (1 - Math.min(v, top) / top);
  const bw = (W - padL - 10) / days.length;
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Snow before and during lift hours">`;
  s += `<rect class="today" x="${padL}" y="${padT - 26}" width="${bw}" height="${H - padT - padB + 60}" rx="6"/>`;
  for (let v = 0; v <= top; v += step) {
    s += `<line class="grid" x1="${padL}" x2="${W - 5}" y1="${y(v)}" y2="${y(v)}"/><text x="${padL - 6}" y="${y(v) + 4}" text-anchor="end">${v}"</text>`;
  }
  days.forEach((d, i) => {
    const x = padL + i * bw, cx = x + bw / 2;
    const bx = x + bw * 0.28, bwid = bw * 0.44;
    const r = d.range && d.range.hi - d.range.lo > 0.1 ? d.range : null;
    const tip = `${d.date}: ${fmtIn(d.snow)} total · ${fmtIn(d.overnight)} before lifts open, ${fmtIn(d.lifts)} while open${r ? ` · could be ${fmtRange(r.lo, r.hi)}` : ''}`;
    s += `<g class="bar ${i > 9 ? 'far' : ''}" data-date="${d.date}"><title>${tip}</title>`;
    s += `<rect class="hit" x="${x}" y="${padT}" width="${bw}" height="${H - padT - padB}"/>`;
    if (r) {
      // Whisker behind the bar: thin line from low to high with end caps.
      s += `<line class="whisker" x1="${cx}" x2="${cx}" y1="${y(r.lo)}" y2="${y(r.hi)}"/>`;
      s += `<line class="whisker" x1="${cx - 5}" x2="${cx + 5}" y1="${y(r.lo)}" y2="${y(r.lo)}"/>`;
      s += r.hi > top
        ? `<path class="whisker-arrow" d="M${cx - 4},${y(top) + 5} L${cx},${y(top) - 1} L${cx + 4},${y(top) + 5} Z"/><text class="whisker-max" x="${cx}" y="${y(top) - 5}" text-anchor="middle">${fmtIn(r.hi)}</text>`
        : `<line class="whisker" x1="${cx - 5}" x2="${cx + 5}" y1="${y(r.hi)}" y2="${y(r.hi)}"/>`;
    }
    s += `<rect class="night" x="${bx}" y="${y(d.overnight)}" width="${bwid}" height="${Math.max(0, y(0) - y(d.overnight))}"/>`;
    s += `<rect class="day" x="${bx}" y="${y(d.snow)}" width="${bwid}" height="${Math.max(0, y(d.overnight) - y(d.snow))}"/></g>`;
    // Total sits on the bar; its halo (see .val in CSS) keeps the whisker from crossing the number.
    if (d.snow >= 0.1) s += `<text class="val" x="${cx}" y="${y(d.snow) - 5}" text-anchor="middle" paint-order="stroke">${fmtIn(d.snow)}</text>`;
    s += `<text class="${i === 0 ? 'today-lbl' : ''}" x="${cx}" y="${H - padB + 16}" text-anchor="middle">${dayLabel(d.date, state.todayStr).short}</text>`;
    s += `<text x="${cx}" y="${H - padB + 30}" text-anchor="middle">${d.date.slice(5).replace('-', '/')}</text>`;
  });
  $('chart').innerHTML = s + '</svg>';
  $('chart').querySelectorAll('.bar').forEach((b) => b.addEventListener('click', () => selectDay(b.dataset.date, true)));
}

// ---------- details ----------

function heat(v) {
  if (v == null || v < 0.1) return '';
  return `style="background: rgba(95,179,255,${Math.min(0.85, 0.12 + v / 14).toFixed(2)})"`;
}

function renderModels() {
  const fut = upcoming();
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

function renderCalibration() {
  const c = state.calibration?.resorts?.[state.resortId];
  const r = resort();
  if (!c) {
    $('calib').innerHTML = `<p class="hint">${r.stations.length
      ? `${r.name} hasn't been calibrated yet`
      : `${r.name} has no snow station within 80 km`}, so its forecast uses the models without correction.</p>`;
    return;
  }
  const rows = MODELS.filter((m) => c.models[m.id]).map((m) => {
    const x = c.models[m.id];
    const pct = Math.round((x.ratio - 1) * 100);
    return `<tr><td class="name">${m.name}</td><td>${pct >= 0 ? '+' : ''}${pct}%</td><td>${x.r.toFixed(2)}</td><td>${x.weight.toFixed(2)}</td></tr>`;
  }).join('');
  const k = c.check;
  const src = c.borrowedFrom
    ? `${r.name} has no station of its own, so it uses the calibration for <b>${c.borrowedFrom}</b> (${c.stations.join(' + ')}).`
    : `Calibration for ${r.name} against ${c.stations.join(' + ')}, ${c.period}.`;
  $('calib').innerHTML = `<p class="hint">${src}
    Raw models forecast <b>${k.rawPctOfObserved}%</b> of the precipitation that fell; after calibration, <b>${k.calibratedPctOfObserved}%</b>.</p>
    <table><tr><th class="name">Model</th><th>Correction</th><th>Skill (r)</th><th>Weight</th></tr>${rows}</table>`;
}

// ---------- loading ----------

async function loadCalibration() {
  // no-cache: always revalidate, so a recalibration shows up right away.
  try { state.calibration = await (await fetch('data/calibration.json', { cache: 'no-cache' })).json(); }
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
    renderSnowSummary();
    renderDays();
    renderChart();
    renderModels();
    const t = new Date().toLocaleString('en-US', { timeZone: r.tz, weekday: 'short', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
    $('status').textContent = `Updated ${t} · ${state.elev} mountain ${ftLabel(elevM)}${f.hasEnsemble ? '' : ' · range unavailable'}`;
  } catch (e) {
    console.error(e);
    $('status').className = 'status err';
    $('status').textContent = `Couldn't load the forecast: ${e.message}`;
  }
}

function switchResort(id) {
  if (!id || id === state.resortId) return;
  state.resortId = id;
  state.selected = null;
  history.replaceState(null, '', id === DEFAULT_RESORT ? location.pathname : '#' + id);
  load();
  loadHistory(resort());
}

$('resortSel').addEventListener('change', (e) => switchResort(e.target.value));
$('favBtn').addEventListener('click', () => {
  const id = state.resortId;
  state.favorites = state.favorites.includes(id) ? state.favorites.filter((x) => x !== id) : [...state.favorites, id];
  store.set('favorites', JSON.stringify(state.favorites));
  renderHeader();
});
$('elevSeg').addEventListener('click', (e) => {
  const k = e.target.closest('button')?.dataset.elev;
  if (!k) return;
  state.elev = k;
  store.set('elev', k);
  load();
});
$('refresh').addEventListener('click', load);

loadCalibration().then(load);
loadHistory(resort());

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
