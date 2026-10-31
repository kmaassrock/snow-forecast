// Page rendering. Forecast math lives in core.js; station history in history.js.

const POWDER_DAY_IN = 6; // a ski day with at least this much is flagged
const STALE_MS = 30 * 60e3; // refresh on reopen when the forecast is older than this
const SAVED_FORECASTS = 6; // how many forecasts to keep for instant open

const fmtIn = (x) => (x == null ? '–' : x < 0.05 ? '0"' : x < 1 ? `${x.toFixed(1)}"` : `${Math.round(x)}"`);
const fmtRange = (lo, hi) => `${fmtIn(lo).replace('"', '')}–${fmtIn(hi)}`;
const ftLabel = (m) => `${(Math.round(mToFt(m) / 10) * 10).toLocaleString()}′`;

function ago(ms) {
  const m = Math.round((Date.now() - ms) / 60e3);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  return `${Math.round(m / 60)} hr ago`;
}

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

const hash = location.hash.slice(1);
const state = {
  // The app opens on Purgatory unless a link names a mountain (#vail) or the favorites list.
  view: hash === 'favorites' ? 'favorites' : 'resort',
  resortId: hash && hash !== 'favorites' ? hash : DEFAULT_RESORT,
  elev: store.get('elev') || 'mid',
  tab: store.get('tab') || 'summary',
  favorites: loadFavorites(),
  calibration: null,
  days: [], ens: {}, todayStr: '', selected: null,
  fetchedAt: null, refreshing: false, hasEnsemble: true,
  station: null, // measured snapshot from the resort's SNOTEL station (stationReport)
  reports: null, // resort snow reports (data/reports.json)
};
if (!RESORTS.some((r) => r.id === state.resortId)) state.resortId = DEFAULT_RESORT;
const resort = () => RESORTS.find((r) => r.id === state.resortId);
const todayIndex = () => state.days.findIndex((d) => d.date === state.todayStr);
const upcoming = () => state.days.slice(Math.max(0, todayIndex()));

// ---------- saved forecasts (instant open) ----------

// Bump SAVED_VERSION when the forecast's shape changes, so older saves are ignored.
const SAVED_VERSION = 2;
const savedKey = (id, elev) => `fc${SAVED_VERSION}:${id}:${elev}`;

function saveForecast(id, elev, f) {
  store.set(savedKey(id, elev), JSON.stringify({ days: f.days, ens: f.ens, savedAt: Date.now() }));
  try {
    Object.keys(localStorage).filter((k) => /^fc\d*:/.test(k) && !k.startsWith(`fc${SAVED_VERSION}:`)).forEach((k) => localStorage.removeItem(k));
    const keys = Object.keys(localStorage).filter((k) => k.startsWith(`fc${SAVED_VERSION}:`));
    if (keys.length <= SAVED_FORECASTS) return;
    keys.map((k) => [k, JSON.parse(localStorage.getItem(k)).savedAt])
      .sort((a, b) => b[1] - a[1]).slice(SAVED_FORECASTS)
      .forEach(([k]) => localStorage.removeItem(k));
  } catch {}
}

// A saved forecast is only useful if it still covers today in the resort's time zone.
function savedForecast(r, elev) {
  try {
    const f = JSON.parse(store.get(savedKey(r.id, elev)));
    const todayStr = nowLocalHour(r.tz).slice(0, 10);
    return f && f.days.some((d) => d.date === todayStr) ? { ...f, todayStr } : null;
  } catch { return null; }
}

// ---------- header ----------

function renderPicker() {
  const fav = state.view === 'favorites';
  const opt = (r) => `<option value="${r.id}" ${!fav && r.id === state.resortId ? 'selected' : ''}>${r.name}</option>`;
  const favs = state.favorites.map((id) => RESORTS.find((r) => r.id === id)).filter(Boolean);
  let html = `<option value="favorites" ${fav ? 'selected' : ''}>★ All favorites</option>`;
  if (favs.length) html += `<optgroup label="★ Favorites">${favs.map(opt).join('')}</optgroup>`;
  for (const [code, label] of Object.entries(STATE_NAMES)) {
    const rs = RESORTS.filter((r) => r.state === code && !state.favorites.includes(r.id));
    if (rs.length) html += `<optgroup label="${label}">${rs.map(opt).join('')}</optgroup>`;
  }
  $('resortSel').innerHTML = html;
}

function renderHeader() {
  const r = resort();
  const fav = state.view === 'favorites';
  document.title = fav ? 'Favorites · Snow Forecast' : `${r.name} Snow Forecast`;
  $('resortName').textContent = fav ? '★ Favorites' : r.name;
  $('favBtn').hidden = fav;
  const starred = state.favorites.includes(r.id);
  $('favBtn').textContent = starred ? '★' : '☆';
  $('favBtn').classList.toggle('on', starred);
  $('favBtn').setAttribute('aria-label', starred ? 'Remove from favorites' : 'Add to favorites');
  $('resortSub').textContent = fav
    ? `${state.favorites.length} mountain${state.favorites.length === 1 ? '' : 's'} · tap one to open it`
    : `${ftLabel(r.elevations.base)}–${ftLabel(r.elevations.summit)} · ${r.region}`;
  $('elevSeg').innerHTML = ['base', 'mid', 'summit'].map((k) =>
    `<button data-elev="${k}" class="${k === state.elev ? 'on' : ''}" title="${fav ? '' : ftLabel(r.elevations[k])}">${k[0].toUpperCase() + k.slice(1)}</button>`).join('');
  renderPicker();
}

function renderStatus() {
  if (state.view !== 'resort' || !state.fetchedAt) return;
  $('status').className = 'status';
  $('status').textContent = `Updated ${ago(state.fetchedAt)}${state.refreshing ? ' · refreshing…' : ''}`
    + ` · ${state.elev} mountain ${ftLabel(resort().elevations[state.elev])}${state.hasEnsemble ? '' : ' · range unavailable'}`;
}

// ---------- snow summary (OpenSnow style) ----------

const QUALITY = { 't-wet': 'q-wet', 't-med': 'q-med', 't-light': 'q-light', 't-dry': 'q-dry' };

// Period totals + one bar per day for the next 15 days. Bars are colored by snow
// quality; powder days blend into orange at the top. Shared by the resort view
// and the favorites cards (interactive = tappable day columns).
function summaryHTML(days, ens, todayStr, { interactive = true, selected = null, barPx = 90 } = {}) {
  const ti = days.findIndex((d) => d.date === todayStr);
  const up = days.slice(Math.max(0, ti), Math.max(0, ti) + 15);
  const periods = [[0, 4, 'Next 1–5 Days'], [5, 9, 'Next 6–10 Days'], [10, 14, 'Next 11–15 Days']].map(([a, b, label]) => {
    const p = periodTotal(days, ens, ti + a, ti + b);
    return `<div class="period" style="flex:${Math.max(1, Math.min(b, up.length - 1) - a + 1)}">
      <div class="p-label">${label}</div>
      <div class="p-total"><span>${p ? fmtIn(p.snow) : '–'}</span></div>
      <div class="p-range">${p?.range ? `range ${fmtRange(p.range.lo, p.range.hi)}` : '&nbsp;'}</div>
    </div>`;
  }).join('');
  const max = Math.max(3, ...up.map((d) => d.snow));
  const tag = interactive ? 'button' : 'span';
  const bars = up.map((d) => {
    const lbl = dayLabel(d.date, todayStr);
    // Bar height in px, leaving room in the track for the total that sits on top of it.
    const h = d.snow < 0.05 ? 0 : Math.max(4, (d.snow / max) * barPx);
    const powder = d.snow >= POWDER_DAY_IN;
    const quality = d.slr ? QUALITY[snowType(d.slr).cls] : 'q-med';
    const cls = d.snow < 0.05 ? 'none' : `${quality}${powder ? ' pow' : ''}`;
    const type = d.slr && d.snow >= 0.5 ? `, ${snowType(d.slr).label.toLowerCase()}` : '';
    return `<${tag} class="col ${d.date === selected ? 'sel' : ''}" data-date="${d.date}" aria-label="${lbl.long}: ${fmtIn(d.snow)}${type}">
      <span class="b-track"><span class="b-val ${powder ? 'pow' : ''}">${d.snow >= 1 ? fmtIn(d.snow) : ''}</span><span class="b ${cls}" style="height:${h}px"></span></span>
      <span class="b-wk ${lbl.weekend ? 'wknd' : ''}">${lbl.weekend ? lbl.wk.slice(0, 2) : lbl.wk[0]}</span>
      <span class="b-dt ${lbl.weekend ? 'wknd' : ''} ${d.date === todayStr ? 'today' : ''}">${+d.date.slice(8)}</span>
      <span class="pq ${powderQuality(d) ? `pq-${powderQuality(d).key}` : ''}" title="${powderQuality(d)?.label || ''}"></span>
    </${tag}>`;
  }).join('');
  return `<div class="periods">${periods}</div><div class="bars">${bars}</div>`;
}

const QUALITY_LEGEND = `<div class="q-legend">
  <span><i class="q q-wet"></i>Heavy, wet</span><span><i class="q q-med"></i>Medium</span>
  <span><i class="q q-light"></i>Light</span><span><i class="q q-dry"></i>Dry powder</span>
  <span><i class="q q-dry pow"></i>Orange top = ${POWDER_DAY_IN}"+ powder day</span>
</div>
<div class="q-legend">Powder quality:
  <span><i class="pq pq-excellent"></i>Excellent</span><span><i class="pq pq-good"></i>Good</span><span><i class="pq pq-okay"></i>Okay</span>
</div>`;

// Powder quality for a ski day: snow by first chair counts most, drier snow scores
// higher, strong wind (wind-packed snow) scores lower.
function powderQuality(d) {
  if (!d || d.snow < 1) return null;
  const dryness = !d.slr ? 1 : d.slr >= 15 ? 1.25 : d.slr >= 11.5 ? 1.1 : d.slr >= 8 ? 1 : 0.7;
  const wind = d.gust >= 40 ? 0.7 : d.gust >= 30 ? 0.85 : 1;
  const score = (d.overnight + 0.5 * d.lifts) * dryness * wind;
  if (score >= 6) return { key: 'excellent', label: 'Excellent' };
  if (score >= 3) return { key: 'good', label: 'Good' };
  if (score >= 1) return { key: 'okay', label: 'Okay' };
  return null;
}

function renderBanner() {
  const next = upcoming().slice(0, 3).filter((d) => d.snow >= POWDER_DAY_IN || d.overnight >= 4);
  const el = $('alertBanner');
  if (!next.length) { el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML = '❄️ <b>Powder alert:</b> ' + next.map((d) =>
    `${dayLabel(d.date, state.todayStr).long}: ${fmtIn(d.snow)} (${fmtIn(d.overnight)} by 9 am)`).join(' · ');
}

// The resort's own report, if read within the last 36 hours (data/reports.json).
function currentReport() {
  const rep = state.reports?.resorts?.[state.resortId];
  return rep && Date.now() - Date.parse(rep.fetchedAt) < 36 * 3600e3 ? rep : null;
}
const currentStation = () => (state.station?.id === state.resortId ? state.station : null);
const fmtWhen = (ms) => new Date(ms).toLocaleString('en-US', { timeZone: resort().tz, weekday: 'short', hour: 'numeric', minute: '2-digit' });

// Measured new snow for the past 15 days, same layout as the forecast bars.
function pastHTML(past) {
  const periods = [[0, 4, 'Prev 11–15 Days'], [5, 9, 'Prev 6–10 Days'], [10, 14, 'Prev 1–5 Days']].map(([a, b, label]) =>
    `<div class="period" style="flex:5"><div class="p-label">${label}</div>
      <div class="p-total measured-total"><span>${fmtIn(sum(past.slice(a, b + 1).map((d) => d.newSnow)))}</span></div>
      <div class="p-range">&nbsp;</div></div>`).join('');
  const max = Math.max(3, ...past.map((d) => d.newSnow));
  const bars = past.map((d) => {
    const lbl = dayLabel(d.date, state.todayStr);
    const h = d.newSnow < 0.05 ? 0 : Math.max(4, (d.newSnow / max) * 90);
    return `<span class="col" aria-label="${lbl.long}: ${fmtIn(d.newSnow)} measured">
      <span class="b-track"><span class="b-val">${d.known ? fmtIn(d.newSnow).replace('"', '') : ''}</span><span class="b ${h ? 'b-measured' : 'none'}" style="height:${h}px"></span></span>
      <span class="b-wk ${lbl.weekend ? 'wknd' : ''}">${lbl.weekend ? lbl.wk.slice(0, 2) : lbl.wk[0]}</span>
      <span class="b-dt ${lbl.weekend ? 'wknd' : ''}">${+d.date.slice(8)}</span>
    </span>`;
  }).join('');
  return `<div class="periods">${periods}</div><div class="bars">${bars}</div>`;
}

// "Last 24 Hours": the resort's report when we have one, otherwise the station.
function nowBoxHTML(kind) {
  const rep = currentReport(), st = currentStation();
  let v = null, src = 'No recent measurement', when = '';
  if (rep?.new24 != null) { v = rep.new24; src = 'Resort report'; when = `checked ${fmtWhen(Date.parse(rep.fetchedAt))}`; }
  else if (st?.h24 != null) { v = st.h24; src = `${st.station} station`; when = fmtWhen(st.asOf); }
  return `<div class="now-box ${kind}"><div class="nb-label">Last 24 Hours</div><div class="nb-val">${v == null ? '–' : fmtIn(v)}</div>
    <div class="nb-src">${src}${when ? `<span class="nb-sep"> · </span><br class="nb-br">${when}` : ''}</div></div>`;
}

// A short written outlook built from the forecast (no AI, no cost).
function outlookHTML() {
  const up = upcoming();
  if (!up.length) return '';
  const dayName = (d) => {
    const l = dayLabel(d.date, state.todayStr);
    return l.short === 'Today' ? 'today' : l.short === 'Tmw' ? 'tomorrow' : new Date(d.date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long' });
  };
  const win = up.slice(0, 10);
  const storms = [];
  win.forEach((d, i) => {
    if (d.snow < 1) return;
    const last = storms[storms.length - 1];
    if (last && last.end === i - 1) { last.end = i; last.days.push(d); } else storms.push({ start: i, end: i, days: [d] });
  });
  const parts = [];
  if (!storms.length) {
    const later = sum(up.slice(10, 15).map((d) => d.snow));
    parts.push(`No significant snow in the next 10 days${later >= 1 ? `; about ${fmtIn(later)} possible after that` : ''}.`);
  } else {
    const s = storms[0];
    if (s.start >= 2) parts.push(`Dry through ${dayName(win[s.start - 1])}.`);
    const total = sum(s.days.map((d) => d.snow));
    // Range over the whole storm from ensemble members (adding daily extremes would overstate it).
    const ti = todayIndex();
    const pr = periodTotal(state.days, state.ens, ti + s.start, ti + s.end)?.range;
    const lo = pr?.lo ?? total, hi = pr?.hi ?? total;
    const swe = sum(s.days.map((d) => d.swe));
    const quality = swe > 0.25 ? snowType(total / mmToIn(swe)).label.toLowerCase() : null;
    const span = s.days.length === 1 ? dayName(s.days[0]) : `${dayName(s.days[0])} through ${dayName(s.days[s.days.length - 1])}`;
    parts.push(`Snow ${span}: about ${fmtIn(total)}${hi - lo >= 1 ? ` (${fmtRange(lo, hi)})` : ''}${quality ? `, ${quality}` : ''}.`);
    const best = s.days.reduce((a, d) => (d.overnight > a.overnight ? d : a));
    if (best.overnight >= 2) parts.push(`Best powder: ${dayName(best)} morning, ${fmtIn(best.overnight)} by 9 am.`);
    if (storms[1]) parts.push(`Another round ${dayName(storms[1].days[0])}, about ${fmtIn(sum(storms[1].days.map((d) => d.snow)))}.`);
  }
  const next3 = up.slice(0, 3);
  const his = next3.map((d) => Math.round(d.hi));
  const windy = next3.reduce((a, d) => (d.gust > a.gust ? d : a));
  parts.push(`Highs ${Math.min(...his)}–${Math.max(...his)}°F the next 3 days${windy.gust >= 35 ? `, gusts to ${Math.round(windy.gust)} mph ${dayName(windy)}` : ''}.`);
  return `<p class="outlook">${parts.join(' ')}</p>`;
}

// Where the past/forecast strip was scrolled, kept across re-renders of the same resort
// (only once its measured days are in place, so the first auto-scroll lands correctly).
let stripScroll = { resort: null, left: 0 };

function renderSnowSummary() {
  const st = currentStation();
  const keep = stripScroll.resort === state.resortId ? stripScroll.left : null;
  const past = st ? `<div class="strip-part past">${pastHTML(st.past)}</div>` : '';
  // The box sits between past and forecast on wide screens; phones show it as a banner above.
  $('snowSummary').innerHTML = outlookHTML() + nowBoxHTML('banner')
    + `<div class="strip-wrap" data-resort="${state.resortId}"><div class="strip">${past}${nowBoxHTML('inline')}
        <div class="strip-part future">${summaryHTML(state.days, state.ens, state.todayStr, { selected: state.selected })}</div></div></div>`
    + QUALITY_LEGEND
    + `<p class="hint">${st ? `<span class="phone-only">Swipe the bars right for the past 15 days. </span>Past days measured at ${st.station} station. ` : ''}Each forecast day runs 4 pm the day before to 4 pm.</p>`;
  $('snowSummary').querySelectorAll('button.col').forEach((b) => b.addEventListener('click', () => selectDay(b.dataset.date, true)));
  // On narrow screens the strip scrolls sideways; start at the forecast (past days are a swipe left).
  const wrap = $('snowSummary').querySelector('.strip-wrap');
  wrap.addEventListener('scroll', () => {
    if (wrap.querySelector('.past')) stripScroll = { resort: state.resortId, left: wrap.scrollLeft };
  }, { passive: true });
  if (keep != null) wrap.scrollLeft = keep;
  else if (wrap.scrollWidth > wrap.clientWidth) {
    const target = getComputedStyle(wrap.querySelector('.now-box.inline')).display === 'none'
      ? wrap.querySelector('.future') : wrap.querySelector('.now-box.inline');
    wrap.scrollLeft = target.offsetLeft - 2; // .strip-wrap is position: relative
  }
}

// Snow Report: last 24 hours, base, season, snowpack vs. normal, terrain open.
function renderSnowReport() {
  const rep = currentReport(), st = currentStation(), r = resort();
  const cell = (v, label, src) => `<div class="rp"><div class="rp-v">${v}</div><div class="rp-k">${label}</div><div class="rp-s">${src}</div></div>`;
  const cells = [];
  if (rep?.new24 != null) cells.push(cell(fmtIn(rep.new24), 'Last 24 hours', 'resort report'));
  else if (st?.h24 != null) cells.push(cell(fmtIn(st.h24), 'Last 24 hours', 'station'));
  if (rep?.baseDepth != null) cells.push(cell(fmtIn(rep.baseDepth), 'Base depth', 'resort · mid-mountain'));
  else if (st?.depth != null) cells.push(cell(fmtIn(st.depth), 'Snow depth', 'station'));
  if (rep?.season != null) cells.push(cell(fmtIn(rep.season), 'Season snowfall', 'resort report'));
  else if (st) cells.push(cell(fmtIn(st.season), 'Season snowfall', 'station, since Oct 1'));
  if (st?.pctNormal != null) cells.push(cell(`${st.pctNormal}%`, 'Snowpack vs. normal', 'snow water, 1991–2020'));
  if (rep?.pctOpen != null) cells.push(cell(`${rep.pctOpen}%`, 'Terrain open', rep.liftsOpen != null ? `${rep.liftsOpen} lifts` : 'resort report'));
  const notes = [];
  if (rep) notes.push(`<a href="${rep.source}" target="_blank" rel="noopener">${r.name} snow report</a>, checked ${fmtWhen(Date.parse(rep.fetchedAt))}`);
  if (st) notes.push(`${st.station} SNOTEL station (${Math.round(mToFt(r.stations[0].elev)).toLocaleString()} ft)`);
  $('snowReport').innerHTML = cells.length
    ? `<div class="report-grid">${cells.join('')}</div><p class="hint">Sources: ${notes.join(' · ')}.</p>`
    : `<p class="hint">${r.stations[0]?.source === 'eccc'
      ? `${r.stations[0].name} (Environment Canada) publishes about a month late, so there's no current report. Its season history is below.`
      : `No snow report or nearby snow station for ${r.name}.`}</p>`;
}

// ---------- hourly charts ----------

// Three stacked panels sharing one time axis (snow, temperature, wind), each with
// its own scale and units. Hover or tap shows the exact values for that hour.
const hourlyData = new Map(); // chart id -> { hours, padL, step }
let hourlySeq = 0;

function hourlyChart(hours) {
  if (!hours.length) return '';
  const id = `hc${++hourlySeq}`;
  for (const k of hourlyData.keys()) if (!document.querySelector(`[data-chart="${k}"]`)) hourlyData.delete(k);
  const W = 720, padL = 46, padR = 10, n = hours.length, step = (W - padL - padR) / n;
  hourlyData.set(id, { hours, padL, step });
  const x = (i) => padL + step * (i + 0.5);
  const P = { snow: { y: 48, h: 80 }, temp: { y: 158, h: 76 }, wind: { y: 264, h: 54 } };
  const H = P.wind.y + P.wind.h + 26;
  const nice = (v, steps) => steps.find((s) => s >= v) ?? Math.ceil(v);
  const snowMax = nice(Math.max(...hours.map((h) => h.snow)), [0.1, 0.2, 0.3, 0.5, 0.75, 1, 1.5, 2, 3]);
  const temps = hours.map((h) => h.tempF);
  let tLo = Math.floor(Math.min(...temps) / 10) * 10, tHi = Math.ceil(Math.max(...temps) / 10) * 10;
  if (tHi - tLo < 20) tHi = tLo + 20;
  const wMax = Math.ceil(Math.max(10, ...hours.map((h) => h.gust)) / 10) * 10;
  const ys = (v) => P.snow.y + P.snow.h * (1 - v / snowMax);
  const yt = (v) => P.temp.y + P.temp.h * (1 - (v - tLo) / (tHi - tLo));
  const yw = (v) => P.wind.y + P.wind.h * (1 - v / wMax);
  const left = x(0) - step / 2, right = x(n - 1) + step / 2;
  const hourLbl = (hr) => (hr === 0 ? '12a' : hr === 12 ? '12p' : hr < 12 ? `${hr}a` : `${hr - 12}p`);

  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Hourly snowfall, temperature and wind">`;
  // Lift hours, shaded behind all three panels.
  hours.forEach((h, i) => {
    if (h.hour >= LIFTS_OPEN && h.hour < LIFTS_CLOSE) s += `<rect class="lift-hrs" x="${x(i) - step / 2}" y="${P.snow.y}" width="${step}" height="${P.wind.y + P.wind.h - P.snow.y}"/>`;
  });
  // Day columns: separator line and a header with that day's snow total.
  const starts = hours.map((h, i) => (i === 0 || h.hour === 0 ? i : -1)).filter((i) => i >= 0);
  starts.forEach((a, k) => {
    const b = (starts[k + 1] ?? n) - 1;
    const dayHours = hours.slice(a, b + 1);
    const total = sum(dayHours.map((h) => h.snow));
    const x0 = x(a) - step / 2, x1 = x(b) + step / 2;
    if (a > 0) s += `<line class="day-sep" x1="${x0}" x2="${x0}" y1="6" y2="${P.wind.y + P.wind.h}"/>`;
    if (x1 - x0 > 60) {
      s += `<text class="day-lbl" x="${(x0 + x1) / 2}" y="16" text-anchor="middle">${dayLabel(hours[a].date, state.todayStr).long}</text>`;
      s += `<text class="day-tot ${total >= 0.1 ? 'has' : ''}" x="${(x0 + x1) / 2}" y="31" text-anchor="middle">${total >= 0.1 ? `❄ ${fmtIn(total)}` : 'no snow'}</text>`;
    }
  });
  // Panel titles and scales.
  const panel = (p, title, ticks, y, fmt) => {
    s += `<text class="panel-title" x="${padL}" y="${p.y - 6}">${title}</text>`;
    for (const v of ticks) s += `<line class="grid" x1="${left}" x2="${right}" y1="${y(v)}" y2="${y(v)}"/><text class="axis" x="${padL - 6}" y="${y(v) + 4}" text-anchor="end">${fmt(v)}</text>`;
  };
  panel(P.snow, 'Snow per hour', [0, snowMax / 2, snowMax], ys, (v) => (v ? `${+v.toFixed(2)}"` : '0'));
  panel(P.temp, 'Temperature', [tLo, (tLo + tHi) / 2, tHi], yt, (v) => `${Math.round(v)}°`);
  panel(P.wind, 'Wind', [0, wMax / 2, wMax], yw, (v) => `${v}`);
  // Snow bars.
  hours.forEach((h, i) => {
    if (h.snow >= 0.01) s += `<rect class="hr-snow" x="${x(i) - step * 0.42}" y="${ys(h.snow)}" width="${step * 0.84}" height="${ys(0) - ys(h.snow)}"/>`;
  });
  // Temperature, with the freezing line labeled.
  if (tLo < 32 && tHi > 32) s += `<line class="freeze" x1="${left}" x2="${right}" y1="${yt(32)}" y2="${yt(32)}"/><text class="freeze-lbl" x="${right - 2}" y="${yt(32) - 4}" text-anchor="end">32° freezing</text>`;
  const path = (vals, y) => vals.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
  s += `<path class="hr-temp" d="${path(temps, yt)}"/>`;
  // Wind and gusts.
  s += `<path class="hr-gust" d="${path(hours.map((h) => h.gust), yw)}"/><path class="hr-wind" d="${path(hours.map((h) => h.wind), yw)}"/>`;
  s += `<text class="panel-note" x="${right}" y="${P.wind.y - 6}" text-anchor="end">mph · solid = wind, dashed = gusts</text>`;
  // Time axis.
  hours.forEach((h, i) => { if (h.hour % 6 === 0) s += `<text class="axis" x="${x(i)}" y="${H - 8}" text-anchor="middle">${hourLbl(h.hour)}</text>`; });
  s += `<line class="hc-cursor" x1="0" x2="0" y1="${P.snow.y - 4}" y2="${P.wind.y + P.wind.h}"/>`;
  return `<div class="hourly-chart" data-chart="${id}"><div class="hc-scroll">${s}</svg></div><div class="hc-tip" hidden></div>
    <p class="legend"><i class="sw sw-snow"></i>Snow <i class="sw sw-temp"></i>Temperature <i class="sw sw-wind"></i>Wind
      <i class="sw sw-gust"></i>Gusts <i class="sw sw-lift"></i>Lifts open (9a–4p)</p></div>`;
}

// Hover (desktop) or tap (phone) a chart to see that hour's numbers.
function onHourlyPointer(e) {
  const wrap = e.target.closest?.('.hourly-chart');
  document.querySelectorAll('.hourly-chart').forEach((c) => {
    if (c === wrap) return;
    c.querySelector('.hc-tip').hidden = true;
    c.querySelector('.hc-cursor')?.classList.remove('on');
  });
  if (!wrap) return;
  const data = hourlyData.get(wrap.dataset.chart);
  const svg = wrap.querySelector('svg');
  if (!data || !svg) return;
  const pt = svg.createSVGPoint();
  pt.x = e.clientX; pt.y = e.clientY;
  const p = pt.matrixTransform(svg.getScreenCTM().inverse());
  const i = Math.floor((p.x - data.padL) / data.step);
  const h = data.hours[i];
  const tip = wrap.querySelector('.hc-tip'), cursor = wrap.querySelector('.hc-cursor');
  if (!h) { tip.hidden = true; cursor.classList.remove('on'); return; }
  const cx = data.padL + data.step * (i + 0.5);
  cursor.setAttribute('x1', cx); cursor.setAttribute('x2', cx); cursor.classList.add('on');
  const when = `${dayLabel(h.date, state.todayStr).short} ${new Date(`${h.time}:00`).toLocaleTimeString('en-US', { hour: 'numeric' })}`;
  tip.innerHTML = `<b>${when}</b><br>Snow ${h.snow >= 0.01 ? `${h.snow.toFixed(2)}"` : 'none'}${h.pop != null ? ` · ${h.pop}% chance` : ''}<br>
    ${Math.round(h.tempF)}°F, feels ${Math.round(h.feelsF)}°<br>Wind ${compass(h.dir)} ${Math.round(h.wind)}, gusts ${Math.round(h.gust)} mph`;
  tip.hidden = false;
  const box = wrap.getBoundingClientRect();
  const left = Math.min(Math.max(8, e.clientX - box.left + 14), box.width - tip.offsetWidth - 8);
  tip.style.left = `${left}px`;
  tip.style.top = `${Math.max(0, e.clientY - box.top - tip.offsetHeight - 14)}px`;
}
document.addEventListener('pointermove', onHourlyPointer);
document.addEventListener('pointerdown', onHourlyPointer);

function renderHourly() {
  const now = nowLocalHour(resort().tz);
  const hours = upcoming().flatMap((d) => d.hours).filter((h) => h.time >= now).slice(0, 72);
  $('hourly').innerHTML = hours.length ? hourlyChart(hours) : '';
}

// ---------- avalanche danger ----------

let avyLayer = null;
function insidePolygon(lon, lat, geom) {
  const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.type === 'MultiPolygon' ? geom.coordinates : [];
  const inRing = (ring) => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };
  return polys.some((p) => inRing(p[0]) && !p.slice(1).some(inRing));
}
// Distance (deg²) to the nearest zone vertex, for resorts just outside a zone's edge.
function nearZone(lon, lat, geom) {
  const pts = (geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates).flat(2);
  return Math.min(...pts.map(([x, y]) => (x - lon) ** 2 + (y - lat) ** 2));
}

async function loadAvalanche() {
  const r = resort();
  const el = $('avalanche');
  try {
    avyLayer ||= await (await fetch('https://api.avalanche.org/v2/public/products/map-layer')).json();
    if (r.id !== state.resortId) return;
    let zone = avyLayer.features.find((f) => insidePolygon(r.lon, r.lat, f.geometry));
    if (!zone) {
      const near = avyLayer.features.map((f) => [f, nearZone(r.lon, r.lat, f.geometry)]).sort((a, b) => a[1] - b[1])[0];
      if (near && near[1] < 0.3 ** 2) zone = near[0];
    }
    if (!zone) {
      el.innerHTML = r.state === 'BC'
        ? '<p class="hint">Avalanche Canada covers Whistler: <a href="https://avalanche.ca/map" target="_blank" rel="noopener">avalanche.ca</a>.</p>'
        : '<p class="hint">No avalanche forecast zone found near this resort.</p>';
      return;
    }
    const p = zone.properties;
    const names = { 1: 'Low', 2: 'Moderate', 3: 'Considerable', 4: 'High', 5: 'Extreme' };
    const level = p.danger_level >= 1 ? `${p.danger_level} – ${names[p.danger_level]}` : p.off_season ? 'Off season' : 'No rating';
    el.innerHTML = `<div class="avy"><span class="avy-level" style="background:${p.color};color:${p.font_color}">${level}</span>
      <span><b>${p.name}</b><br><small class="muted">${p.center}</small></span></div>
      ${p.travel_advice ? `<p class="avy-advice">${p.travel_advice}</p>` : ''}
      <p class="hint"><a href="${p.link}" target="_blank" rel="noopener">Full forecast</a> · Backcountry and sidecountry only; inbounds terrain is managed by ski patrol.</p>`;
  } catch (e) {
    console.warn('Avalanche data unavailable', e);
    el.innerHTML = '<p class="hint">Avalanche danger is unavailable right now.</p>';
  }
}

// ---------- trail map ----------

let trailMap = null;
function loadLeaflet() {
  if (window.L) return Promise.resolve();
  const css = document.createElement('link');
  css.rel = 'stylesheet';
  css.href = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css';
  document.head.append(css);
  return new Promise((ok, fail) => {
    const js = document.createElement('script');
    js.src = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js';
    js.onload = ok;
    js.onerror = fail;
    document.head.append(js);
  });
}

async function showTrailMap() {
  if (state.view !== 'resort' || state.tab !== 'mountain') return; // Leaflet needs a visible map
  const r = resort();
  try {
    await loadLeaflet();
    if (!trailMap) {
      trailMap = L.map('trailMap', { scrollWheelZoom: false });
      L.tileLayer('https://tile.opentopomap.org/{z}/{x}/{y}.png', {
        maxZoom: 17, attribution: '© OpenStreetMap contributors, SRTM · © OpenTopoMap (CC-BY-SA)',
      }).addTo(trailMap);
      L.tileLayer('https://tiles.opensnowmap.org/pistes/{z}/{x}/{y}.png', {
        maxZoom: 18, attribution: 'Runs & lifts © OpenSnowMap.org (CC-BY-SA)',
      }).addTo(trailMap);
    }
    trailMap.setView([r.lat, r.lon], 14);
    setTimeout(() => trailMap.invalidateSize(), 50);
  } catch (e) {
    $('trailMap').innerHTML = '<p class="hint">The map couldn\'t load.</p>';
  }
}

// ---------- daily list ----------

function dayDetail(d, lead) {
  const conf = confidence(d, lead);
  const r = d.range && !d.past ? d.range : null;
  const models = MODELS.filter((m) => d.perModel[m.id] != null).map((m) => `${m.name}${m.ref ? ' (ref)' : ''} <b>${fmtIn(d.perModel[m.id])}</b>`).join(' · ');
  const rows = d.hours.map((h) => {
    const slr = h.swe > 0.05 ? h.snow / mmToIn(h.swe) : null;
    const hr = new Date(`${h.time}:00`).toLocaleTimeString('en-US', { hour: 'numeric' });
    const open = h.date === d.date && h.hour >= LIFTS_OPEN && h.hour < LIFTS_CLOSE;
    const sep = h.date === d.date && (h.hour === 0 || h.hour === LIFTS_OPEN)
      ? `<tr class="sep"><td colspan="12">${h.hour === 0 ? dayLabel(d.date, state.todayStr).long : 'Lifts open'}</td></tr>` : '';
    return `${sep}<tr class="${open ? 'open' : ''}"><td>${hr}</td><td>${icon({ snow: h.snow * 6, rainIn: mmToIn(h.rain) * 6, cloud: h.cloud })}</td>
      <td class="heat" ${heat(h.snow * 6)}>${h.snow >= 0.05 ? h.snow.toFixed(1) + '"' : ''}</td>
      <td>${slr ? Math.round(slr) + ':1' : ''}</td>
      <td>${h.pop != null ? h.pop + '%' : ''}</td>
      <td>${Math.round(h.tempF)}°</td><td>${Math.round(h.feelsF)}°</td><td>${compass(h.dir)} ${Math.round(h.wind)}</td><td>${Math.round(h.gust)}</td>
      <td>${Math.round(h.rh)}%</td><td>${Math.round(h.cloud)}%</td><td>${h.freezeFt ? (Math.round((h.freezeFt - 1000) / 100) * 100).toLocaleString() : ''}</td></tr>`;
  }).join('');
  return `<div class="detail">
    <dl>
      <dt>Before lifts open</dt><dd>${fmtIn(d.overnight)}</dd>
      <dt>While lifts open</dt><dd>${fmtIn(d.lifts)}</dd>
      ${r ? `<dt>Could be</dt><dd>${fmtRange(r.lo, r.hi)}${conf ? ` · ${conf.toLowerCase()} confidence` : ''}</dd>` : ''}
      ${powderQuality(d) ? `<dt>Powder quality</dt><dd>${powderQuality(d).label}</dd>` : ''}
      ${d.pop != null ? `<dt>Chance of precip</dt><dd>${d.pop}%</dd>` : ''}
      <dt>Snow water</dt><dd>${mmToIn(d.swe).toFixed(2)}"</dd>
      ${d.rainIn >= 0.05 ? `<dt>Rain</dt><dd>${d.rainIn.toFixed(2)}"</dd>` : ''}
      <dt>Wind (lift hours)</dt><dd>${compass(d.dir)} ${Math.round(d.wind)} mph, gusts ${Math.round(d.gust)}</dd>
      <dt>Feels like</dt><dd>${Math.round(d.feelsLo)}° to ${Math.round(d.feelsHi)}°F</dd>
      <dt>Humidity (lift hours)</dt><dd>${Math.round(d.rh)}%</dd>
      <dt>Cloud cover</dt><dd>${Math.round(d.cloud)}%</dd>
      ${d.snowLevel != null ? `<dt>Snow level</dt><dd>${(Math.round(d.snowLevel / 100) * 100).toLocaleString()} ft</dd>` : ''}
    </dl>
    <p class="hint">${models}</p>
    ${hourlyChart(d.hours)}
    <details class="hour-table"><summary>Hourly table</summary>
      <div class="table-wrap"><table>
        <tr><th>Time</th><th></th><th>Snow</th><th>Ratio</th><th>Precip</th><th>Temp</th><th>Feels</th><th>Wind</th><th>Gust</th><th>RH</th><th>Cloud</th><th>Snow lvl</th></tr>
        <tr class="sep"><td colspan="12">From 4 pm the day before</td></tr>${rows}
      </table></div>
    </details>
  </div>`;
}

function renderDays() {
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
  if (!days.length) { $('chart').innerHTML = ''; return; }
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

// ---------- precipitation by model (12-hour blocks) ----------

const MODEL_COLORS = {
  ncep_hrrr_conus: '#e11d48', ncep_nbm_conus: '#16a34a', ecmwf_ifs: '#2563eb', gfs_global: '#f59e0b',
  gem_seamless: '#dc2626', icon_seamless: '#0891b2', ukmo_seamless: '#9333ea',
  ecmwf_aifs025_single: '#64748b', ncep_aigfs025: '#a16207',
};
let stormTotals = false; // table shows running totals instead of per-block amounts
let runTrend = null; // { resortId, elev, delta: { modelId: inches } } from the previous-runs API

// Each ski day splits into two 12-hour blocks: night (4 pm–4 am) and day (4 am–4 pm).
function blocks() {
  return upcoming().flatMap((d) => [
    { label: dayLabel(d.date, state.todayStr), part: 'Night', hours: d.hours.filter((h) => h.date !== d.date || h.hour < 4) },
    { label: dayLabel(d.date, state.todayStr), part: 'Day', hours: d.hours.filter((h) => h.date === d.date && h.hour >= 4) },
  ]).filter((b) => b.hours.length);
}

// Rain / mix / snow / heavy snow, from how much of the water fell as rain.
function precipClass(snowIn, rainIn) {
  if (snowIn < 0.05 && rainIn < 0.01) return '';
  const rainShare = rainIn / (rainIn + snowIn / 10);
  if (rainShare > 0.7) return 'p-rain';
  if (rainShare > 0.25) return 'p-mix';
  return snowIn >= 6 ? 'p-heavy' : 'p-snow';
}

function renderModels() {
  const bl = blocks();
  const head = `<tr><th class="name">Model</th>${bl.map((b) => `<th>${b.label.short}<br><small>${b.part === 'Night' ? 'night' : 'day'}</small></th>`).join('')}<th>Total</th><th title="Change in each model's next-7-day snow since its run 24 hours earlier">vs. yesterday</th></tr>`;
  const row = (name, note, cells, cls, trend) => {
    let run = 0;
    const tds = cells.map((c) => {
      if (!c) return '<td></td>';
      run += c.snow;
      const v = stormTotals ? run : c.snow;
      return `<td class="pcell ${precipClass(c.snow, c.rain)}" title="${fmtIn(c.snow)} snow, ${c.rain.toFixed(2)}&quot; rain">${v >= 0.05 ? v.toFixed(1) : c.rain >= 0.01 ? '0' : ''}</td>`;
    }).join('');
    const total = sum(cells.filter(Boolean).map((c) => c.snow));
    const t = trend == null ? '' : `<span class="${trend >= 0.5 ? 'up' : trend <= -0.5 ? 'down' : 'muted'}">${trend > 0 ? '+' : ''}${trend.toFixed(1)}"</span>`;
    return `<tr class="${cls}"><td class="name">${name}${note ? `<br><small class="muted">${note}</small>` : ''}</td>${tds}<td><b>${fmtIn(total)}</b></td><td>${t}</td></tr>`;
  };
  const blendCells = bl.map((b) => ({ snow: sum(b.hours.map((h) => h.snow)), rain: mmToIn(sum(b.hours.map((h) => h.rain))) }));
  const modelCells = (id) => bl.map((b) => {
    const hs = b.hours.filter((h) => h.perModel[id] != null);
    return hs.length >= 6 ? { snow: sum(hs.map((h) => h.perModel[id])), rain: sum(hs.map((h) => h.perRain?.[id] ?? 0)) } : null;
  });
  const trend = runTrend?.resortId === state.resortId && runTrend.elev === state.elev ? runTrend.delta : {};
  const rows = [
    row('Blend', 'weighted', blendCells, 'blend', null),
    ...MODELS.map((m) => row(`<i class="mdot" style="background:${MODEL_COLORS[m.id]}"></i>${m.name}`, m.note, modelCells(m.id), m.ref ? 'ref' : '', trend[m.id] ?? null)),
  ];
  $('models').innerHTML = `<table class="ptable">${head}${rows.join('')}</table>`;
}

// How each model's next-7-day snow changed since its run 24 hours earlier. The
// previous-runs API reports raw model snowfall, so the change is scaled into our
// calibrated inches using each model's current calibrated/raw ratio.
async function loadRunTrend() {
  if (state.view !== 'resort' || state.tab !== 'models') return;
  const r = resort(), elev = state.elev;
  if (runTrend?.resortId === r.id && runTrend.elev === elev) return;
  const ids = MODELS.map((m) => m.id);
  const q = new URLSearchParams({
    latitude: r.lat, longitude: r.lon, elevation: r.elevations[elev], hourly: 'snowfall,snowfall_previous_day1',
    models: ids.join(','), forecast_days: 7, timezone: r.tz,
  });
  try {
    const data = await (await fetch(`https://previous-runs-api.open-meteo.com/v1/forecast?${q}`)).json();
    const h = data.hourly, now = nowLocalHour(r.tz);
    const ours = Object.fromEntries(upcoming().flatMap((d) => d.hours).map((x) => [x.time, x]));
    const delta = {};
    for (const id of ids) {
      const cur = h[`snowfall_${id}`], prev = h[`snowfall_previous_day1_${id}`];
      if (!cur || !prev) continue;
      let curRaw = 0, prevRaw = 0, ourTotal = 0, n = 0;
      h.time.forEach((t, i) => {
        if (t < now || cur[i] == null || prev[i] == null) return;
        curRaw += cur[i]; prevRaw += prev[i]; ourTotal += ours[t]?.perModel[id] ?? 0; n++;
      });
      if (n < 24) continue;
      // Raw cm → our inches: use this model's own ratio when it has snow, else Open-Meteo's 7:1 → ~10:1.
      const f = curRaw >= 0.5 ? ourTotal / curRaw : (10 / 7) / 2.54;
      delta[id] = ourTotal - prevRaw * f;
    }
    if (r.id !== state.resortId) return;
    runTrend = { resortId: r.id, elev, delta };
    renderModels();
  } catch (e) { console.warn('Previous runs unavailable', e); }
}

// ---------- forecast range (cumulative snowfall by model) ----------

function renderRange() {
  const up = upcoming().slice(0, 15);
  if (!up.length) { $('range').innerHTML = ''; return; }
  const W = 720, H = 240, padL = 34, padR = 12, top = 14, bottom = 30;
  const x = (i) => padL + ((W - padL - padR) * (i + 1)) / up.length;
  const cum = (vals) => { let t = 0; return vals.map((v) => (v == null ? null : (t += v))); };
  const blend = cum(up.map((d) => d.snow));
  const lines = MODELS.map((m) => {
    const vals = [];
    for (const d of up) { if (d.perModel[m.id] == null) break; vals.push(d.perModel[m.id]); }
    return { m, pts: cum(vals) };
  }).filter((l) => l.pts.length);
  // Likely range of the running total, from ensemble members that cover every day so far.
  const band = up.map((d, i) => {
    const days = up.slice(0, i + 1).map((x) => state.ens[x.date] || {});
    const keys = Object.keys(days[0]).filter((k) => days.every((e) => k in e));
    return scaledRangeOf(blend[i], Object.fromEntries(keys.map((k) => [k, sum(days.map((e) => e[k]))])));
  });
  const top_ = Math.max(4, ...blend, ...lines.flatMap((l) => l.pts), ...band.map((b) => b?.hi ?? 0));
  const step = top_ > 48 ? 12 : top_ > 24 ? 6 : top_ > 12 ? 4 : 2;
  const yMax = Math.ceil(top_ / step) * step;
  const y = (v) => top + (H - top - bottom) * (1 - v / yMax);
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Cumulative snowfall by model">`;
  for (let v = 0; v <= yMax; v += step) s += `<line class="grid" x1="${padL}" x2="${W - padR}" y1="${y(v)}" y2="${y(v)}"/><text x="${padL - 6}" y="${y(v) + 4}" text-anchor="end">${v}"</text>`;
  up.forEach((d, i) => { if (i % 2 === 0) s += `<text x="${x(i)}" y="${H - 12}" text-anchor="middle">${dayLabel(d.date, state.todayStr).short}</text>`; });
  const pts = band.map((b, i) => (b ? [x(i), b] : null)).filter(Boolean);
  if (pts.length > 1) s += `<path class="rng-band" d="M${pts.map(([px, b]) => `${px},${y(b.hi)}`).join('L')}L${pts.slice().reverse().map(([px, b]) => `${px},${y(b.lo)}`).join('L')}Z"/>`;
  const path = (vals) => vals.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
  for (const l of lines) s += `<path class="m-line ${l.m.ref ? 'ref' : ''}" style="stroke:${MODEL_COLORS[l.m.id]}" d="${path(l.pts)}"><title>${l.m.name}: ${fmtIn(l.pts.at(-1))}</title></path>`;
  s += `<path class="blend-line" d="${path(blend)}"/>`;
  // Legend under the chart, biggest total first.
  const legend = [{ name: 'Blend', v: blend.at(-1), cls: 'blend' }, ...lines.map((l) => ({ name: l.m.name, v: l.pts.at(-1), color: MODEL_COLORS[l.m.id], ref: l.m.ref }))]
    .sort((a, b) => b.v - a.v)
    .map((l) => `<span class="${l.ref ? 'muted' : ''}"><i class="mline ${l.cls || ''} ${l.ref ? 'ref' : ''}" ${l.color ? `style="border-color:${l.color}"` : ''}></i>${l.name} <b>${fmtIn(l.v)}</b></span>`).join('');
  $('range').innerHTML = s + `</svg><div class="q-legend range-legend">${legend}</div>`;
}

// scaledRange (core.js) for any total and its members.
const scaledRangeOf = (total, members) => (Object.keys(members).length >= 10 ? scaledRange(total, members) : null);

// ---------- webcams ----------

function renderCams() {
  const cams = CAMS[state.resortId];
  $('camsCard').hidden = !cams;
  if (!cams) return;
  const t = Math.floor(Date.now() / 300e3); // new image every 5 minutes, cached in between
  $('cams').innerHTML = cams.map((c) => `<a class="cam" href="${c.live}" target="_blank" rel="noopener">
      <img src="${c.img}?t=${t}" alt="${c.name} webcam" loading="lazy"><span>${c.name}</span></a>`).join('');
}

// ---------- right now ----------

function renderRightNow() {
  const now = nowLocalHour(resort().tz);
  const h = state.days.flatMap((d) => d.hours).find((x) => x.time === now);
  const st = currentStation();
  if (!h) { $('rightNow').innerHTML = '<p class="hint">Loading…</p>'; return; }
  const sky = h.snow >= 0.05 ? 'Snowing' : h.rain >= 0.1 ? 'Rain' : h.cloud < 20 ? 'Clear' : h.cloud < 45 ? 'Mostly sunny' : h.cloud < 75 ? 'Partly cloudy' : 'Cloudy';
  $('rightNow').innerHTML = `<div class="rn-main">
      <span class="rn-icon">${icon({ snow: h.snow * 6, rainIn: mmToIn(h.rain) * 6, cloud: h.cloud })}</span>
      <span class="rn-temp">${Math.round(h.tempF)}°</span>
      <span class="rn-desc"><b>${sky}</b><br><span class="muted">Feels like ${Math.round(h.feelsF)}°</span></span>
    </div>
    <dl class="rn-list">
      <dt>Wind</dt><dd>${compass(h.dir)} ${Math.round(h.wind)} mph, gusts ${Math.round(h.gust)}</dd>
      <dt>Humidity</dt><dd>${Math.round(h.rh)}%</dd>
      ${h.freezeFt ? `<dt>Snow level</dt><dd>${(Math.round((h.freezeFt - 1000) / 100) * 100).toLocaleString()} ft</dd>` : ''}
      ${h.pop != null ? `<dt>Precip chance</dt><dd>${h.pop}% this hour</dd>` : ''}
      ${st?.tempF != null ? `<dt>Measured</dt><dd>${Math.round(st.tempF)}°F at ${st.station}</dd>` : ''}
    </dl>
    <p class="hint">Model blend at ${ftLabel(resort().elevations[state.elev])} for ${new Date(`${now}:00`).toLocaleTimeString('en-US', { hour: 'numeric' })}.</p>`;
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

function renderResort() {
  renderBanner();
  renderSnowSummary();
  renderRightNow();
  renderSnowReport();
  renderDays();
  renderHourly();
  renderChart();
  renderRange();
  renderModels();
}

// ---------- favorites overview ----------

function favCard(r, c) {
  const body = c?.days ? summaryHTML(c.days, c.ens || {}, c.todayStr, { interactive: false, barPx: 62 })
    : `<p class="hint">${c?.failed ? "Couldn't load this forecast." : 'Loading…'}</p>`;
  const when = c?.failed ? "couldn't refresh" : c?.savedAt ? ago(c.savedAt) : '';
  return `<div class="card fav-card" role="button" tabindex="0" data-id="${r.id}">
    <div class="fc-head">
      <span><b class="fc-name">${r.name}</b> <span class="muted">${ftLabel(r.elevations[state.elev])} · ${r.state}</span></span>
      <span class="muted fc-when">${when}</span>
    </div>
    ${body}
  </div>`;
}

let favSeq = 0;
async function loadFavView() {
  const seq = ++favSeq;
  renderHeader();
  const resorts = state.favorites.map((id) => RESORTS.find((r) => r.id === id)).filter(Boolean);
  if (!resorts.length) {
    $('favView').innerHTML = '<p class="card hint">No favorites yet. Open a mountain and tap ☆ next to its name.</p>';
    return;
  }
  const cards = Object.fromEntries(resorts.map((r) => [r.id, savedForecast(r, state.elev)]));
  const draw = () => {
    if (seq !== favSeq) return;
    $('favView').innerHTML = resorts.map((r) => favCard(r, cards[r.id])).join('') + `<div class="card">${QUALITY_LEGEND}</div>`;
  };
  draw();
  // Each card refreshes on its own; ensembles are skipped to keep this light.
  await Promise.all(resorts.map(async (r) => {
    if (cards[r.id] && Date.now() - cards[r.id].savedAt < STALE_MS) return;
    try {
      const f = await getForecast(r, r.elevations[state.elev], state.calibration?.resorts?.[r.id], { ensemble: false });
      if (seq !== favSeq) return;
      saveForecast(r.id, state.elev, f);
      cards[r.id] = { ...f, savedAt: Date.now() };
    } catch (e) {
      console.error(e);
      cards[r.id] = { ...(cards[r.id] || {}), failed: true };
    }
    draw();
  }));
}

function applyView() {
  const fav = state.view === 'favorites';
  document.body.classList.toggle('fav-mode', fav);
  $('favView').hidden = !fav;
}

// ---------- loading ----------

async function loadCalibration() {
  // no-cache: always revalidate, so a recalibration shows up right away.
  try { state.calibration = await (await fetch('data/calibration.json', { cache: 'no-cache' })).json(); }
  catch (e) { console.warn('No calibration file', e); }
}

async function loadStation() {
  const r = resort();
  state.station = null;
  try {
    const st = await stationReport(r);
    if (r.id !== state.resortId) return;
    state.station = st && { ...st, id: r.id };
    renderSnowReport();
    renderRightNow();
    if (state.days.length) renderSnowSummary();
  } catch (e) { console.warn('No station data', e); }
}

async function loadReports() {
  try { state.reports = await (await fetch('data/reports.json', { cache: 'no-cache' })).json(); }
  catch (e) { console.warn('No resort reports', e); }
}

// Everything about the current resort that isn't the model forecast.
function loadResortExtras() {
  renderCams();
  loadHistory(resort());
  loadStation();
  loadAvalanche();
  showTrailMap();
  loadRunTrend();
}

// Draw the last saved forecast for the current resort, if any (no network).
function showSaved() {
  const r = resort();
  renderHeader();
  renderCalibration();
  const saved = savedForecast(r, state.elev);
  if (saved) {
    Object.assign(state, { days: saved.days, ens: saved.ens || {}, todayStr: saved.todayStr, fetchedAt: saved.savedAt, refreshing: true, hasEnsemble: !!Object.keys(saved.ens || {}).length });
    renderResort();
    renderStatus();
  } else {
    Object.assign(state, { days: [], ens: {}, fetchedAt: null, refreshing: true });
    renderResort();
    $('status').className = 'status';
    $('status').textContent = 'Loading forecast models…';
  }
}

let loadSeq = 0;
async function load({ redraw = true } = {}) {
  const seq = ++loadSeq;
  const r = resort();
  const elevM = r.elevations[state.elev];
  if (redraw) showSaved();
  else { renderCalibration(); state.refreshing = true; renderStatus(); }
  try {
    const f = await getForecast(r, elevM, state.calibration?.resorts?.[r.id]);
    if (seq !== loadSeq) return; // a newer request replaced this one
    saveForecast(r.id, state.elev, f);
    Object.assign(state, { days: f.days, ens: f.ens, todayStr: f.todayStr, fetchedAt: Date.now(), refreshing: false, hasEnsemble: f.hasEnsemble });
    renderResort();
    renderStatus();
  } catch (e) {
    if (seq !== loadSeq) return;
    console.error(e);
    state.refreshing = false;
    $('status').className = 'status err';
    $('status').textContent = state.fetchedAt
      ? `Showing the forecast from ${ago(state.fetchedAt)}; couldn't refresh (${e.message})`
      : `Couldn't load the forecast: ${e.message}`;
  }
}

function switchResort(id) {
  if (id === 'favorites') {
    state.view = 'favorites';
    history.replaceState(null, '', '#favorites');
    applyView();
    loadFavView();
    return;
  }
  if (!id || (id === state.resortId && state.view === 'resort')) return;
  state.view = 'resort';
  state.resortId = id;
  state.selected = null;
  history.replaceState(null, '', id === DEFAULT_RESORT ? location.pathname : '#' + id);
  applyView();
  window.scrollTo(0, 0);
  load();
  loadResortExtras();
}

$('resortSel').addEventListener('change', (e) => switchResort(e.target.value));
$('favView').addEventListener('click', (e) => {
  const card = e.target.closest('.fav-card');
  if (card) switchResort(card.dataset.id);
});
$('favView').addEventListener('keydown', (e) => {
  const card = e.target.closest('.fav-card');
  if (card && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); switchResort(card.dataset.id); }
});
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
  loadRunTrend();
  if (state.view === 'favorites') loadFavView(); else load();
});
$('refresh').addEventListener('click', load);

// Reopening the app later (it stays in memory on iPhone) refreshes a stale forecast.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (state.view === 'favorites') loadFavView();
  else if (!state.fetchedAt || Date.now() - state.fetchedAt > STALE_MS) { load(); loadStation(); }
});
setInterval(renderStatus, 60e3);

applyView();
// Theme: Auto follows the phone's light/dark setting; the button cycles Auto → Light → Dark.
const THEMES = { auto: '◐ Auto', light: '☀︎ Light', dark: '☾ Dark' };
let theme = store.get('theme') || 'auto';
function applyTheme() {
  if (theme === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  $('themeBtn').textContent = THEMES[theme];
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => {
    if (theme === 'auto') m.content = m.media.includes('dark') ? '#0e0e10' : '#f2f4f7';
    else m.content = bg;
  });
}
$('themeBtn').addEventListener('click', () => {
  const keys = Object.keys(THEMES);
  theme = keys[(keys.indexOf(theme) + 1) % keys.length];
  store.set('theme', theme);
  applyTheme();
});
// Tabs: Summary · Daily · Hourly · Models · History · Mountain (remembered per device).
function applyTab() {
  document.querySelectorAll('main [data-tab]').forEach((el) => el.classList.toggle('tab-off', el.dataset.tab !== state.tab));
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === state.tab));
  if (state.view !== 'resort') return;
  if (state.tab === 'summary' && state.days.length) renderSnowSummary(); // strip needs to be visible to scroll
  if (state.tab === 'mountain') showTrailMap();
  if (state.tab === 'models') loadRunTrend();
}
$('tabs').addEventListener('click', (e) => {
  const t = e.target.closest('button')?.dataset.tab;
  if (!t || t === state.tab) return;
  state.tab = t;
  store.set('tab', t);
  applyTab();
  const top = $('tabs').getBoundingClientRect().top + window.scrollY;
  if (window.scrollY > top) window.scrollTo({ top, behavior: 'smooth' });
});
applyTab();
$('stormToggle').addEventListener('change', (e) => { stormTotals = e.target.checked; renderModels(); });
applyTheme();

// Saved forecast first so the app opens instantly; calibration and fresh data follow.
if (state.view === 'resort') showSaved();
loadCalibration().then(() => (state.view === 'favorites' ? loadFavView() : load({ redraw: false })));
loadReports().then(() => { if (state.view === 'resort') { renderSnowReport(); if (state.days.length) renderSnowSummary(); } });
if (state.view === 'resort') loadResortExtras();

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
