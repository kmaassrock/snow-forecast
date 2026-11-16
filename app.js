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
const LIST_VIEWS = ['favorites', 'upcoming', 'compare', 'alerts']; // views that aren't one mountain
const state = {
  // The app opens on Purgatory unless a link names a mountain (#vail) or the favorites list.
  // Views: 'resort' (one mountain), 'favorites' (starred cards), 'upcoming' (ranking).
  view: LIST_VIEWS.includes(hash) ? hash : 'resort',
  resortId: hash && !LIST_VIEWS.includes(hash) ? hash : DEFAULT_RESORT,
  upcoming: null, // data/upcoming.json: every resort's next 7 days + last 48 hours
  upFilter: 'all',
  upSort: 'next7',
  // Always opens at mid-mountain; Base/Summit apply only to the page being viewed.
  elev: 'mid',
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
const SAVED_VERSION = 3;
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
  const onResort = state.view === 'resort';
  const opt = (r) => `<option value="${r.id}" ${onResort && r.id === state.resortId ? 'selected' : ''}>${r.name}</option>`;
  const favs = state.favorites.map((id) => RESORTS.find((r) => r.id === id)).filter(Boolean);
  let html = onResort ? '' : '<option value="" selected disabled>Choose a resort</option>';
  if (favs.length) html += `<optgroup label="★ Favorites">${favs.map(opt).join('')}</optgroup>`;
  for (const [code, label] of Object.entries(STATE_NAMES)) {
    const rs = RESORTS.filter((r) => r.state === code && !state.favorites.includes(r.id));
    if (rs.length) html += `<optgroup label="${label}">${rs.map(opt).join('')}</optgroup>`;
  }
  $('resortSel').innerHTML = html;
}

function renderHeader() {
  const r = resort();
  const fav = state.view === 'favorites', up = state.view === 'upcoming', cmp = state.view === 'compare', alr = state.view === 'alerts';
  document.title = fav ? 'Favorites · Snow Forecast' : up ? 'Upcoming Snow' : cmp ? 'Compare Resorts' : alr ? 'Powder Alerts' : `${r.name} Snow Forecast`;
  $('resortName').textContent = fav ? '★ Favorites' : up ? '❄ Upcoming Snow' : cmp ? '⚖ Compare' : alr ? '🔔 Powder Alerts' : r.name;
  $('favBtn').hidden = fav || up || cmp || alr;
  $('elevSeg').hidden = up || cmp || alr;
  document.querySelectorAll('#topnav [data-view]').forEach((b) => b.classList.toggle('on', b.dataset.view === state.view));
  const starred = state.favorites.includes(r.id);
  $('favBtn').textContent = starred ? '★' : '☆';
  $('favBtn').classList.toggle('on', starred);
  $('favBtn').setAttribute('aria-label', starred ? 'Remove from favorites' : 'Add to favorites');
  if (cmp) $('resortSub').textContent = 'Side by side at mid-mountain · pick 2 or 3 resorts';
  else if (alr) $('resortSub').textContent = 'Free phone notifications when a powder day is coming';
  else $('resortSub').textContent = fav
    ? `${state.favorites.length} mountain${state.favorites.length === 1 ? '' : 's'} · tap one to open it`
    : up ? `Next 7 days at mid-mountain, every resort · most snow first`
    : `${ftLabel(r.elevations.base)}–${ftLabel(r.elevations.summit)} · ${r.region}${driveTo(r.id) != null ? ` · 🚗 ${fmtDrive(driveTo(r.id))} drive` : ''}`;
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
      ${qualityMark(d)}
    </${tag}>`;
  }).join('');
  return `<div class="periods">${periods}</div><div class="bars">${bars}</div>`;
}

// Powder quality as 1–3 small snowflakes in the text color (no color, so it can't be
// confused with the snow-type bar colors or the orange powder-day top). SVG, not the ❄
// emoji, which iPhones draw blue.
const FLAKE = '<svg viewBox="-12 -12 24 24" aria-hidden="true"><path d="M0 0L10.5 0M8.5 2.5L6 0L8.5 -2.5M0 0L5.3 9.1M2.1 8.7L3 5.2L6.5 6.1M0 0L-5.2 9.1M-6.5 6.1L-3 5.2L-2.1 8.7M0 0L-10.5 0M-8.5 -2.5L-6 0L-8.5 2.5M0 0L-5.3 -9.1M-2.1 -8.7L-3 -5.2L-6.5 -6.1M0 0L5.3 -9.1M6.5 -6.1L3 -5.2L2.1 -8.7"/></svg>';
const flakesHTML = (n) => FLAKE.repeat(n);

const QUALITY_LEGEND = `<div class="q-legend">
  <span><i class="q q-wet"></i>Heavy, wet</span><span><i class="q q-med"></i>Medium</span>
  <span><i class="q q-light"></i>Light</span><span><i class="q q-dry"></i>Dry powder</span>
  <span><i class="q q-dry pow"></i>Orange top = ${POWDER_DAY_IN}"+ powder day</span>
</div>
<div class="q-legend">Powder quality:
  <span><i class="pq">${FLAKE.repeat(3)}</i>Excellent</span><span><i class="pq">${FLAKE.repeat(2)}</i>Good</span><span><i class="pq">${FLAKE}</i>Okay</span>
</div>`;

// Powder quality for a ski day: snow by first chair counts most, drier snow scores
// higher, strong wind (wind-packed snow) scores lower.
function powderQuality(d) {
  if (!d || d.snow < 1) return null;
  const dryness = !d.slr ? 1 : d.slr >= 15 ? 1.25 : d.slr >= 11.5 ? 1.1 : d.slr >= 8 ? 1 : 0.7;
  const wind = d.gust >= 40 ? 0.7 : d.gust >= 30 ? 0.85 : 1;
  const score = (d.overnight + 0.5 * d.lifts) * dryness * wind;
  if (score >= 6) return { key: 'excellent', label: 'Excellent', flakes: 3 };
  if (score >= 3) return { key: 'good', label: 'Good', flakes: 2 };
  if (score >= 1) return { key: 'okay', label: 'Okay', flakes: 1 };
  return null;
}

function qualityMark(d) {
  const q = powderQuality(d);
  return `<span class="pq" ${q ? `title="Powder quality: ${q.label}" aria-label="Powder quality: ${q.label}"` : 'aria-hidden="true"'}>${q ? flakesHTML(q.flakes) : ''}</span>`;
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
  $('snowSummary').innerHTML = outlookHTML() + bestDayHTML() + nowBoxHTML('banner')
    + `<div class="strip-wrap" data-resort="${state.resortId}"><div class="strip">${past}${nowBoxHTML('inline')}
        <div class="strip-part future">${summaryHTML(state.days, state.ens, state.todayStr, { selected: state.selected })}</div></div></div>`
    + QUALITY_LEGEND
    + `<p class="hint">${st ? `<span class="phone-only">Swipe the bars right for the past 15 days. </span>Past days measured at ${st.station} station. ` : ''}Each forecast day runs 4 pm the day before to 4 pm. Snowy days are adjusted down for typical over-forecasting, more so 8+ days out (Models → Forecast check).</p>`;
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

// Trail map, two ways: the resort's own published trail map (newest winter map on
// skimap.org, data/trail-maps.json; tap for the full-size original), or OpenSkiMap's
// interactive map (runs from OpenStreetMap). Loaded only when the Mountain tab is open.
let trailMaps = null;
state.mapMode = store.get('mapMode') === 'live' ? 'live' : 'resort';
state.mapIdx = 0; // which of a resort's area maps is shown (Vail: Front Side, Back Bowls, Blue Sky Basin)
async function showTrailMap() {
  if (state.view !== 'resort' || state.tab !== 'mountain') return;
  trailMaps ||= fetch('data/trail-maps.json', { cache: 'no-cache' }).then((r) => r.json()).then((d) => d.resorts).catch(() => ({}));
  const all = await trailMaps;
  const r = resort();
  const entry = all[r.id];
  const list = entry?.maps || (entry ? [entry] : []); // older files had one map per resort
  if (state.mapIdx >= list.length) state.mapIdx = 0;
  const mode = list.length ? state.mapMode : 'live';
  document.querySelectorAll('#mapSeg button').forEach((b) => b.classList.toggle('on', b.dataset.map === mode));
  $('mapSeg').hidden = !list.length;
  const box = $('trailMap');
  const key = `${r.id}:${mode}:${mode === 'resort' ? state.mapIdx : ''}`;
  if (box.dataset.key === key) return;
  box.dataset.key = key;
  box.classList.toggle('resort-map', mode === 'resort');
  const site = r.website ? ` · <a href="${r.website}" target="_blank" rel="noopener">${r.name} website →</a>` : '';
  if (mode === 'resort') {
    const m = list[state.mapIdx];
    const full = `https://skimap.org/skimaps/view/${m.id}`;
    const n = list.length;
    // More than one map: thumbnails to switch between the resort's areas.
    const thumbs = n > 1 ? `<div class="map-thumbs" role="group" aria-label="${r.name} maps">${list.map((t, i) =>
      `<button data-map-idx="${i}" class="${i === state.mapIdx ? 'on' : ''}" aria-label="Map ${i + 1} of ${n}" aria-pressed="${i === state.mapIdx}">
        <picture>${t.avif ? `<source srcset="${t.avif.split(' ')[0]}" type="image/avif">` : ''}<img src="${t.img}" alt="" width="${Math.round((56 * t.w) / t.h)}" height="56" decoding="async"></picture></button>`).join('')}</div>` : '';
    box.innerHTML = `${thumbs}<a href="${full}" target="_blank" rel="noopener" title="Open the full-size map">
      <picture>${m.avif ? `<source srcset="${m.avif}" sizes="(min-width: 900px) 860px, 100vw" type="image/avif">` : ''}
        <img class="map-main" src="${m.img}" width="${m.w}" height="${m.h}" alt="${r.name} trail map${n > 1 ? ` ${state.mapIdx + 1} of ${n}` : ''} (${m.year})" decoding="async"></picture></a>`;
    $('mapLinks').innerHTML = `${n > 1 ? `${r.name}'s ${m.year} trail maps: ${n} areas, tap a thumbnail to switch. ` : `${r.name}'s ${m.year} trail map. `}${m.artist ? `Art by ${m.artist}. ` : ''}<a href="${full}" target="_blank" rel="noopener">Open full size to zoom →</a>
      · via <a href="https://skimap.org/skiareas/view/${m.area}" target="_blank" rel="noopener">skimap.org</a>${site}`;
  } else {
    box.innerHTML = `<iframe src="https://openskimap.org/#13.6/${r.lat}/${r.lon}" title="${r.name} ski map" loading="lazy" allow="geolocation"></iframe>`;
    $('mapLinks').innerHTML = `Interactive map: <a href="https://openskimap.org/" target="_blank" rel="noopener">OpenSkiMap</a> (from OpenStreetMap; green easy,
      blue intermediate, black advanced; pinch or scroll to zoom)${site}`;
  }
}
$('mapSeg').addEventListener('click', (e) => {
  const mode = e.target.closest('button')?.dataset.map;
  if (!mode || mode === state.mapMode) return;
  state.mapMode = mode;
  store.set('mapMode', mode);
  showTrailMap();
});
$('trailMap').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-map-idx]');
  if (!b) return;
  state.mapIdx = +b.dataset.mapIdx;
  showTrailMap();
});

// Road-condition sites by state/province (closures, chain and traction laws, cams).
const ROAD_SITES = {
  CO: [['COtrip (CDOT)', 'https://www.cotrip.org/'], ['Colorado traction law', 'https://www.codot.gov/travel/winter-driving/tractionlaw']],
  UT: [['UDOT Traffic', 'https://udottraffic.utah.gov/']],
  CA: [['Caltrans QuickMap', 'https://quickmap.dot.ca.gov/'], ['Highway conditions by number', 'https://roads.dot.ca.gov/']],
  BC: [['DriveBC', 'https://www.drivebc.ca/']],
};
// Canyon roads with their own status page (closures for avalanche control, traction rules).
const COTTONWOODS = ['alta', 'snowbird', 'brighton', 'solitude'];

function renderGettingThere() {
  const r = resort();
  const [lat, lon] = r.base;
  const dt = driveTo(r.id);
  const link = ([label, url]) => `<a class="road-btn" href="${url}" target="_blank" rel="noopener">${label} →</a>`;
  const roads = [...(COTTONWOODS.includes(r.id) ? [['Cottonwood Canyons (UDOT)', 'https://cottonwoodcanyons.udot.utah.gov/']] : []), ...(ROAD_SITES[r.state] || [])];
  $('gettingThere').innerHTML = `
    <p class="drive-line">${dt != null ? `🚗 About <b>${fmtDrive(dt)}</b> from ${state.drive.label || 'your location'} in good conditions.` : '🚗 Set your location on Upcoming Snow to see the drive time.'}</p>
    <div class="road-links">
      <a class="road-btn primary" href="https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}" target="_blank" rel="noopener">Google Maps directions →</a>
      <a class="road-btn" href="https://maps.apple.com/?daddr=${lat},${lon}" target="_blank" rel="noopener">Apple Maps →</a>
    </div>
    <h3 class="sub-head">Road conditions</h3>
    <div class="road-links">${roads.map(link).join('')}</div>
    <p class="hint">Directions go to the main base area. Mountain roads close for storms and avalanche control; check before you leave on a powder day.</p>`;
}

// ---------- trends, model agreement, best day ----------

// How this day's forecast has changed across the daily forecast logs (data/forecast-trend.json,
// blend water at the resort's SNOTEL station before the lead correction): latest vs ~3 days earlier.
function trendOf(d) {
  const st = resort().stations[0];
  const byDate = st && state.trend?.stations?.[st.id];
  // A ski day runs 4 pm the day before to 4 pm, so it spans two calendar days of the log;
  // add both, per log, for the logs that have both.
  const cur = byDate?.[d.date], prevDay = byDate?.[addDays(d.date, -1)];
  if (!cur || !prevDay) return null;
  const prevByMade = Object.fromEntries(prevDay);
  const series = cur.filter(([m]) => m in prevByMade).map(([m, mm]) => [m, mm + prevByMade[m]]);
  if (series.length < 2) return null;
  const [latestMade, latest] = series.at(-1);
  const cutoff = addDays(latestMade, -3);
  const [olderMade, older] = [...series].reverse().find(([m]) => m <= cutoff) || series[0];
  if (olderMade === latestMade || Math.max(latest, older) < 3) return null; // ~3 mm water ≈ an inch or two of snow
  const pct = older > 0 ? latest / older - 1 : 1;
  if (Math.abs(pct) < 0.25) return null;
  return { pct, olderMade, isNew: older < 1 };
}
const dayName = (date) => new Date(date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short' });
function trendText(t) {
  if (t.isNew) return `new since ${dayName(t.olderMade)}`;
  if (t.pct >= 1) return `${(t.pct + 1).toFixed(1).replace('.0', '')}× bigger than on ${dayName(t.olderMade)}`;
  return t.pct > 0 ? `up ${Math.round(t.pct * 100)}% since ${dayName(t.olderMade)}` : `down ${Math.round(-t.pct * 100)}% since ${dayName(t.olderMade)}`;
}
function trendChip(d) {
  const t = trendOf(d);
  // Rising trends only matter on days with real snow; tiny far-out amounts swing wildly.
  if (!t || (t.pct > 0 && d.snow < 1)) return '';
  const up = t.pct > 0;
  const amount = t.isNew ? 'new' : t.pct >= 1 ? `${(t.pct + 1).toFixed(1).replace('.0', '')}×` : `${Math.round(Math.abs(t.pct) * 100)}%`;
  return `<span class="chip ${up ? 'trend-up' : 'trend-down'}" title="Forecast for this day ${trendText(t)}">${up ? '↑' : '↓'} ${amount}</span>`;
}

// How many blend models show real snow this day (≥1" or ≥40% of the blend).
function agreementOf(d) {
  if (d.snow < 1) return null;
  const vals = MODELS.filter((m) => !m.ref && d.perModel[m.id] != null).map((m) => d.perModel[m.id]);
  if (vals.length < 2) return null;
  const need = Math.max(1, 0.4 * (d.rawSnow ?? d.snow));
  return { agree: vals.filter((v) => v >= need).length, total: vals.length };
}
function agreeChip(d) {
  const a = agreementOf(d);
  if (!a) return '';
  const share = a.agree / a.total;
  const cls = share <= 0.34 ? 'agree-low' : share < 0.67 ? 'agree-mid' : 'agree-high';
  return `<span class="chip ${cls}" title="${a.agree} of ${a.total} models show at least ${fmtIn(Math.max(1, 0.4 * (d.rawSnow ?? d.snow)))} this day">${a.agree}/${a.total} models</span>`;
}

// Best day to ski in the next 7: snow by first chair counts most, then snow while
// open; drier snow, lighter wind and fewer weekend crowds score higher, plus a
// bluebird bonus for a clear day right after a storm. Dry weeks fall back to weather.
function bestDayHTML() {
  const up = upcoming().slice(0, 7);
  const hour = +nowLocalHour(resort().tz).slice(11, 13);
  const days = up.filter((d, i) => !(i === 0 && hour >= LIFTS_CLOSE));
  if (days.length < 2) return '';
  const score = (d) => {
    const prev = state.days[state.days.indexOf(d) - 1];
    const dry = !d.slr ? 1 : d.slr >= 15 ? 1.25 : d.slr >= 11.5 ? 1.1 : d.slr >= 8 ? 1 : 0.75;
    const wind = d.gust >= 40 ? 0.6 : d.gust >= 30 ? 0.8 : 1;
    const cold = d.hi < 10 ? 0.85 : 1;
    const crowds = dayLabel(d.date, state.todayStr).weekend ? 0.9 : 1;
    const bluebird = prev && prev.snow >= 4 && d.cloud < 35 ? 2 : 0;
    const weather = ((100 - d.cloud) / 100) * 0.5 + (d.gust < 25 ? 0.5 : 0); // tie-breaker for dry weeks
    return (d.overnight + 0.5 * d.lifts) * dry * wind * cold * crowds + bluebird + weather;
  };
  const best = days.reduce((a, d) => (score(d) > score(a) ? d : a));
  const lbl = dayLabel(best.date, state.todayStr).long;
  const prev = state.days[state.days.indexOf(best) - 1];
  const parts = [];
  if (best.overnight >= 1) parts.push(`${fmtIn(best.overnight)} by 9 am${best.slr ? ` (${snowType(best.slr).label.toLowerCase()})` : ''}`);
  else if (best.snow >= 1) parts.push(`${fmtIn(best.snow)} during the day`);
  if (prev && prev.snow >= 4 && best.cloud < 35) parts.push('clearing after the storm');
  else if (best.snow < 1) parts.push(best.cloud < 30 ? 'sunny' : best.cloud < 70 ? 'partly cloudy' : 'cloudy');
  parts.push(best.gust < 20 ? 'light winds' : `gusts to ${Math.round(best.gust)} mph`);
  parts.push(`high ${Math.round(best.hi)}°F`);
  const noSnow = days.every((d) => d.snow < 1);
  return `<p class="best-day">⛷️ <b>Best day to ski${noSnow ? ' (no new snow this week)' : ''}: ${lbl}</b> · ${parts.join(', ')}</p>`;
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
      ${powderQuality(d) ? `<dt>Powder quality</dt><dd><span class="pq">${flakesHTML(powderQuality(d).flakes)}</span> ${powderQuality(d).label}</dd>` : ''}
      ${d.pop != null ? `<dt>Chance of precip</dt><dd>${d.pop}%</dd>` : ''}
      ${trendOf(d) ? `<dt>Forecast trend</dt><dd>${trendText(trendOf(d))}</dd>` : ''}
      ${agreementOf(d) ? `<dt>Models showing snow</dt><dd>${agreementOf(d).agree} of ${agreementOf(d).total}</dd>` : ''}
      ${d.leadFactor && d.leadFactor < 0.97 ? `<dt>Before over-forecast correction</dt><dd>${fmtIn(d.rawSnow)} <span class="muted">(shown ${Math.round((1 - d.leadFactor) * 100)}% lower)</span></dd>` : ''}
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
        <span class="d-type">${type ? `<span class="${type.cls}">${type.label}</span>` : d.rainIn >= 0.05 ? '<span class="t-wet">Rain</span>' : ''}${trendChip(d)}${agreeChip(d)}</span>
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
  const step = niceStep(maxV);
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

// A round axis step (inches) that gives at most 6 gridlines up to max.
function niceStep(max) {
  return [1, 2, 3, 4, 6, 12, 24, 36, 48, 60, 120, 240].find((st) => max / st <= 6) ?? Math.ceil(max / 6);
}

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
    // Models with no data here (hidden at this resort, or outside their coverage) get no row.
    ...MODELS.map((m) => [m, modelCells(m.id)]).filter(([, cells]) => cells.some(Boolean))
      .map(([m, cells]) => row(`<i class="mdot" style="background:${MODEL_COLORS[m.id]}"></i>${m.name}`, m.note, cells, m.ref ? 'ref' : '', trend[m.id] ?? null)),
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
  const step = niceStep(top_);
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

// Forecast check (Models tab): how much each lead time's forecasts over-promised,
// from the daily scoring (data/lead-bias.json), and the correction applied.
function renderLeadCheck() {
  const lb = state.leadBias;
  if (!lb) { $('leadCheck').innerHTML = '<p class="hint">Not available yet.</p>'; return; }
  const rows = Object.keys(lb.factors).map(Number).sort((a, b) => a - b).map((L) => {
    const s = lb.leads?.[L] || {}, f = lb.factors[L];
    const promised = s.ratio ? `${Math.round(100 / s.ratio)}%` : '–';
    return `<tr><td>${L} day${L > 1 ? 's' : ''}</td><td><b>${f < 1 ? '−' : '+'}${Math.abs(Math.round((1 - f) * 100))}%</b></td>
      <td>${lb.measuredShare?.[L] ? `${lb.measuredShare[L]}% this season, ${100 - lb.measuredShare[L]}% past winters` : L <= 7 ? 'Past winters' : 'Day 7 (not yet measured)'}</td>
      <td>${s.snowyDays || 0}</td><td>${promised}</td></tr>`;
  }).join('');
  $('leadCheck').innerHTML = `<p class="hint">On snowy days, forecasts tend to promise more snow than actually falls. Each day's snow is reduced by the
    amount below for how far ahead it is, and from day 8 on the forecast also leans toward the middle of the 82 ensemble runs.
    Scoring started ${new Date(lb.logsSince + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}. Each correction blends what this
    season's scoring has measured with past winters, leaning more on this season as snowy days add up (past winters count as ${lb.priorDays ?? 60} days).</p>
    <div class="table-wrap"><table><tr><th class="name">Days ahead</th><th>Correction</th><th>Based on</th><th>Snowy days scored</th><th>Forecast as % of what fell</th></tr>${rows}</table></div>`;
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
  renderLeadCheck();
}

// ---------- favorites overview ----------

function favCard(r, c) {
  const body = c?.days ? summaryHTML(c.days, c.ens || {}, c.todayStr, { interactive: false, barPx: 62 })
    : `<p class="hint">${c?.failed ? "Couldn't load this forecast." : 'Loading…'}</p>`;
  const when = c?.failed ? "couldn't refresh" : c?.savedAt ? ago(c.savedAt) : '';
  return `<div class="card fav-card" role="button" tabindex="0" data-id="${r.id}">
    <div class="fc-head">
      <span><b class="fc-name">${r.name}</b> <span class="muted">${ftLabel(r.elevations[state.elev])} · ${r.state}</span>${recentBadge(r.id)}</span>
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
    $('favView').innerHTML = `<div class="fav-storms">${stormsHTML(resorts.map((r) => r.id))}</div>`
      + resorts.map((r) => favCard(r, cards[r.id])).join('') + `<div class="card">${QUALITY_LEGEND}</div>`;
  };
  draw();
  loadUpcoming().then(draw); // fills in the last-48-hours badges
  // Each card refreshes on its own; ensembles are skipped to keep this light.
  await Promise.all(resorts.map(async (r) => {
    if (cards[r.id] && Date.now() - cards[r.id].savedAt < STALE_MS) return;
    try {
      const f = await getForecast(r, r.elevations[state.elev], state.calibration?.resorts?.[r.id], { ensemble: false, leadBias: state.leadBias });
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

// "❄ 4" last 48 hrs" from data/upcoming.json (resort report or station).
function recentBadge(id) {
  const rec = state.upcoming?.resorts?.[id]?.recent48;
  if (!rec) return '';
  return `<span class="fc-recent ${rec.inches >= 1 ? 'has' : ''}" title="${rec.source}">❄ ${fmtIn(rec.inches)} last 48 hrs</span>`;
}

// ---------- upcoming snow (every resort, ranked) ----------

let upcomingLoad = null;
function loadUpcoming(force) {
  if (!upcomingLoad || force) {
    upcomingLoad = fetch('data/upcoming.json', { cache: 'no-cache' }).then((r) => r.json())
      .then((d) => { state.upcoming = d; return d; })
      .catch((e) => { console.warn('No upcoming snow data', e); upcomingLoad = null; return null; });
  }
  return upcomingLoad;
}

// ---------- drive times (from the viewer's location) ----------

// Saved on this device only: { lat, lon, at, times: { resortId: seconds } }.
state.drive = (() => {
  try {
    const d = JSON.parse(store.get('drive2'));
    return d && Date.now() - d.at < 30 * 86400e3 ? d : null;
  } catch { return null; }
})();

const fmtDrive = (sec) => {
  if (sec == null) return '–';
  const m = Math.round(sec / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
};
const driveTo = (id) => state.drive?.times?.[id] ?? null;

// Ask for the location (rounded to ~1 km), then get driving times to every resort
// in one request from the public OSRM router. Estimates ignore winter road closures.
async function routeFrom(lat, lon, label, accuracy) {
  lat = +lat.toFixed(2); lon = +lon.toFixed(2);
  // Route to each resort's base area, not the ski-area center (which can snap to a back road).
  const coords = [[lon, lat], ...RESORTS.map((r) => (r.base ? [r.base[1], r.base[0]] : [r.lon, r.lat]))].map(([x, y]) => `${x},${y}`).join(';');
  const res = await fetch(`https://router.project-osrm.org/table/v1/driving/${coords}?sources=0&annotations=duration`);
  const data = await res.json();
  if (data.code !== 'Ok') throw new Error(data.message || 'routing failed');
  const times = Object.fromEntries(RESORTS.map((r, i) => [r.id, data.durations[0][i + 1]]));
  state.drive = { lat, lon, label, accuracy, at: Date.now(), times };
  // 'drive2': times to base areas (older 'drive' saves routed to ski-area centers).
  store.set('drive2', JSON.stringify(state.drive));
}

// Device location. Laptops often locate by Wi-Fi or internet provider, which can be
// miles off, so we keep the reported accuracy and show the place it resolved to.
async function locateAndRoute() {
  const pos = await new Promise((ok, fail) => navigator.geolocation.getCurrentPosition(ok, fail, { enableHighAccuracy: true, timeout: 15000, maximumAge: 600e3 }));
  const { latitude: lat, longitude: lon, accuracy } = pos.coords;
  let label = `${lat.toFixed(2)}, ${lon.toFixed(2)}`;
  try {
    const r = await (await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&zoom=12&lat=${lat.toFixed(3)}&lon=${lon.toFixed(3)}`)).json();
    const a = r.address || {};
    const place = a.city || a.town || a.village || a.hamlet || a.suburb || a.county;
    if (place) label = `${place}${a['ISO3166-2-lvl4'] ? `, ${a['ISO3166-2-lvl4'].split('-')[1]}` : ''}`;
  } catch {}
  await routeFrom(lat, lon, label, accuracy);
}

// Typed town or ZIP code (Open-Meteo geocoding). Returns the candidate places.
// Matches are ranked toward ski country: western US states, then the rest of the US,
// then Canada, then elsewhere.
const WEST = ['Colorado', 'Utah', 'California', 'New Mexico', 'Arizona', 'Wyoming', 'Nevada', 'Idaho', 'Montana', 'Oregon', 'Washington'];
async function findPlaces(query) {
  const q = new URLSearchParams({ name: query.trim(), count: 30, language: 'en' });
  const d = await (await fetch(`https://geocoding-api.open-meteo.com/v1/search?${q}`)).json();
  const rank = (p) => (p.country_code === 'US' ? (WEST.includes(p.admin1) ? 0 : 1) : p.country_code === 'CA' ? 2 : 3);
  return (d.results || []).map((p, i) => ({ p, i })).sort((a, b) => rank(a.p) - rank(b.p) || a.i - b.i).slice(0, 6).map(({ p }) => ({
    rank: rank(p),
    lat: p.latitude, lon: p.longitude,
    label: `${p.name}${p.admin1 ? `, ${p.admin1}` : ''}${p.country_code && p.country_code !== 'US' ? ` (${p.country_code})` : ''}`,
  }));
}

// ---------- storm tracker ----------

// Groups resorts whose biggest 3-day window (≥ 6") starts within a day of each
// other into storms, biggest first. Returns up to two storms.
function findStorms(ids) {
  const d = state.upcoming;
  if (!d) return [];
  const hits = [];
  for (const id of ids) {
    const days = d.resorts[id]?.days;
    if (!days || days.length < 3) continue;
    let best = null;
    for (let i = 0; i + 3 <= days.length; i++) {
      const win = days.slice(i, i + 3), total = sum(win.map((x) => x.snow));
      if (!best || total > best.total) best = { total, win };
    }
    if (best.total < 6) continue;
    const snowy = best.win.filter((x) => x.snow >= 0.5);
    hits.push({ id, total: best.total, start: snowy[0].date, end: snowy.at(-1).date, today: days[0].date });
  }
  hits.sort((a, b) => b.total - a.total);
  const storms = [];
  const gap = (a, b) => Math.abs(Date.parse(a) - Date.parse(b)) / 86400e3;
  for (const h of hits) {
    const s = storms.find((x) => gap(x.start, h.start) <= 1);
    if (s) { s.hits.push(h); if (h.end > s.end) s.end = h.end; } else storms.push({ start: h.start, end: h.end, today: h.today, hits: [h] });
  }
  return storms.filter((s) => s.hits.length >= 2 || s.hits[0].total >= 12).slice(0, 2);
}

function stormsHTML(ids) {
  return findStorms(ids).map((s) => {
    const day = (dt) => dayLabel(dt, s.today).short;
    const when = s.start === s.end ? day(s.start) : `${day(s.start)}–${day(s.end)}`;
    const names = s.hits.slice(0, 5).map((h) => `<a href="#${h.id}" data-open="${h.id}">${RESORTS.find((r) => r.id === h.id).name} <b>${fmtIn(h.total)}</b></a>`).join(' · ');
    const more = s.hits.length > 5 ? ` · +${s.hits.length - 5} more` : '';
    return `<div class="storm">🌨️ <b>Storm ${when}:</b> ${names}${more}</div>`;
  }).join('');
}

// ---------- upcoming snow page ----------

const UP_SORTS = {
  next7: { label: 'Next 7 days', value: (e) => e.next7 ?? -1 },
  tomorrow: { label: 'By 9 am tomorrow', value: (e) => e.tomorrowBy9 ?? -1 },
  recent48: { label: 'Last 48 hours', value: (e) => e.recent48?.inches ?? -1 },
  season: { label: 'Season so far', value: (e) => e.season?.inches ?? -1 },
  drive: { label: 'Drive time', value: (e, id) => -(driveTo(id) ?? Infinity) },
};
state.upPass = 'any';
state.upDrive = 0; // max drive hours, 0 = any
state.upMode = 'list'; // or 'map'

function upcomingRows() {
  const d = state.upcoming;
  return RESORTS
    .filter((r) => d.resorts[r.id]?.days)
    .filter((r) => state.upFilter === 'all' || (state.upFilter === 'fav' ? state.favorites.includes(r.id) : r.state === state.upFilter))
    .filter((r) => state.upPass === 'any' || PASSES[state.upPass].resorts.includes(r.id))
    .filter((r) => !state.upDrive || (driveTo(r.id) != null && driveTo(r.id) <= state.upDrive * 3600))
    .map((r) => ({ r, e: d.resorts[r.id] }))
    .sort((a, b) => UP_SORTS[state.upSort].value(b.e, b.r.id) - UP_SORTS[state.upSort].value(a.e, a.r.id) || a.r.name.localeCompare(b.r.name));
}

function passBadges(id) {
  return passesFor(id).map((k) => `<span class="pass pass-${k}">${PASSES[k].name}</span>`).join('');
}

function renderUpcoming() {
  const d = state.upcoming;
  if (!d) { $('upcomingView').innerHTML = '<p class="card hint">Loading every resort…</p>'; return; }
  const chip = (attr, k, label, on) => `<button data-${attr}="${k}" class="${on ? 'on' : ''}">${label}</button>`;
  const regions = [['all', 'All'], ['fav', '★ Favorites'], ['CO', 'Colorado'], ['UT', 'Utah'], ['CA', 'California']]
    .map(([k, l]) => chip('filter', k, l, state.upFilter === k)).join('');
  const passes = [['any', 'Any pass'], ...Object.entries(PASSES).map(([k, p]) => [k, p.name])]
    .map(([k, l]) => chip('pass', k, l, state.upPass === k)).join('');
  const sorts = Object.entries(UP_SORTS).filter(([k]) => k !== 'drive' || state.drive)
    .map(([k, v]) => `<option value="${k}" ${state.upSort === k ? 'selected' : ''}>${v.label}</option>`).join('');
  const drive = state.drive
    ? `<label class="up-sort">🚗 Within <select id="upDrive">${[[0, 'any time'], [1, '1 hour'], [2, '2 hours'], [3, '3 hours'], [5, '5 hours'], [8, '8 hours']]
      .map(([h, l]) => `<option value="${h}" ${state.upDrive === h ? 'selected' : ''}>${l}</option>`).join('')}</select></label>`
    : '';
  const approx = state.drive?.accuracy > 3000;
  const from = state.drive
    ? `<div class="drive-from ${approx ? 'warn' : ''}">🚗 Drive times from <b>${state.drive.label || 'your location'}</b>${state.drive.accuracy ? ` (±${state.drive.accuracy >= 1000 ? `${Math.round(state.drive.accuracy / 1000)} km` : `${Math.round(state.drive.accuracy)} m`})` : ''}
        ${approx ? ' · your device only knows your location roughly, so type your town for better times.' : ''}
        <button class="link-btn" id="changeLoc">Change</button></div>`
    : '';
  const locForm = `<form class="loc-form" id="locForm" ${state.drive && !state.locEditing ? 'hidden' : ''}>
      <button type="button" class="loc-btn" id="locate">📍 Use my location</button>
      <span class="muted">or</span>
      <input id="locQuery" type="text" inputmode="search" placeholder="Town or ZIP code" autocomplete="postal-code" value="">
      <button type="submit" class="loc-btn">Set</button>
      <span id="locResults" class="chips"></span>
    </form>`;
  const rows = upcomingRows();
  const ids = rows.map((x) => x.r.id);

  let body;
  if (state.upMode === 'map') {
    body = '<div id="snowMap" class="snow-map"></div><div id="mapLegend" class="q-legend"></div>';
  } else {
    const max = Math.max(3, ...rows.flatMap(({ e }) => e.days.map((x) => x.snow)));
    const first = rows[0]?.e;
    const dayHead = first ? first.days.map((x) => {
      const l = dayLabel(x.date, first.todayStr);
      return `<span class="${l.weekend ? 'wknd' : ''}">${l.short === 'Today' ? 'Tdy' : l.weekend ? l.wk.slice(0, 2) : l.wk[0]}</span>`;
    }).join('') : '';
    // Phones show one extra column: whatever the list is sorted by (or last 48h).
    const extraKey = state.upSort === 'next7' ? 'recent48' : state.upSort;
    const extra = (r, e) => ({
      tomorrow: [fmtIn(e.tomorrowBy9), 'by 9am'], recent48: [e.recent48 ? fmtIn(e.recent48.inches) : '–', 'last 48h'],
      season: [e.season ? fmtIn(e.season.inches) : '–', 'season'], drive: [fmtDrive(driveTo(r.id)), 'drive'],
    })[extraKey];
    const list = rows.map(({ r, e }, i) => {
      const bars = e.days.map((x) => {
        const h = x.snow < 0.05 ? 2 : Math.max(4, (x.snow / max) * 34);
        return `<span class="ub ${x.snow < 0.05 ? 'none' : QUALITY[x.q] || 'q-med'} ${x.snow >= POWDER_DAY_IN ? 'pow' : ''}" style="height:${h}px" title="${x.date}: ${fmtIn(x.snow)}"></span>`;
      }).join('');
      const [xv, xl] = extra(r, e);
      const dt = driveTo(r.id);
      return `<button class="up-row" data-id="${r.id}">
        <span class="up-rank">${i + 1}</span>
        <span class="up-name"><b>${state.favorites.includes(r.id) ? '★ ' : ''}${r.name}</b>
          <small>${r.state} · ${ftLabel(r.elevations.mid)}${dt != null ? ` · 🚗 ${fmtDrive(dt)}` : ''} ${passBadges(r.id)}</small></span>
        <span class="up-bars">${bars}</span>
        <span class="up-num ${state.upSort === 'next7' ? 'sorted' : ''}"><b>${fmtIn(e.next7)}</b><small>7 days</small></span>
        <span class="up-num wide ${state.upSort === 'tomorrow' ? 'sorted' : ''}"><b>${fmtIn(e.tomorrowBy9)}</b><small>by 9am tmw</small></span>
        <span class="up-num wide ${state.upSort === 'recent48' ? 'sorted' : ''}"><b>${e.recent48 ? fmtIn(e.recent48.inches) : '–'}</b><small>last 48h</small></span>
        <span class="up-num wide ${state.upSort === 'season' ? 'sorted' : ''}"><b>${e.season ? fmtIn(e.season.inches) : '–'}</b><small>${e.pctNormal != null ? `${e.pctNormal}% of normal` : 'season'}</small></span>
        <span class="up-num narrow sorted"><b>${xv}</b><small>${xl}</small></span>
      </button>`;
    }).join('');
    body = `<div class="up-head"><span></span><span>Resort</span><span class="up-bars">${dayHead}</span><span>7 days</span>
        <span class="wide">Tmw 9am</span><span class="wide">48h</span><span class="wide">Season</span><span class="narrow"></span></div>
      <div class="up-list">${list || '<p class="hint">No resorts match.</p>'}</div>`;
  }

  $('upcomingView').innerHTML = stormsHTML(ids) + `<section class="card">
    ${from}${locForm}
    <div class="up-tools">
      <div class="chips">${regions}</div>
      <div class="seg mode-seg"><button data-mode="list" class="${state.upMode === 'list' ? 'on' : ''}">List</button><button data-mode="map" class="${state.upMode === 'map' ? 'on' : ''}">Map</button></div>
    </div>
    <div class="up-tools">
      <div class="chips">${passes}</div>
      <div class="up-tools-right">${drive}<label class="up-sort">${state.upMode === 'map' ? 'Show' : 'Sort by'} <select id="upSort">${sorts}</select></label></div>
    </div>
    ${body}
    <p class="hint">Forecasts are the model blend at each resort's mid-mountain, updated ${ago(Date.parse(d.generated))}. Last 48 hours and season are measured: the resort's own report where available, otherwise the nearest snow station (station season totals count early snow that has since melted). Passes are 2025–26 lineups; check the pass site before you go. Drive times are estimates that ignore winter road closures.</p>
  </section>`;
  if (state.upMode === 'map') renderSnowMap(rows);
}

// ---------- snow map ----------

let snowMap = null, snowLayer = null;

async function renderSnowMap(rows) {
  try { await loadLeaflet(); } catch { $('snowMap').innerHTML = '<p class="hint">The map couldn\'t load.</p>'; return; }
  const metric = state.upSort === 'drive' ? 'next7' : state.upSort;
  const value = (e) => ({ next7: e.next7, tomorrow: e.tomorrowBy9, recent48: e.recent48?.inches, season: e.season?.inches })[metric];
  const dark = getComputedStyle(document.documentElement).colorScheme === 'dark';
  // The container is re-created on each render, so the map is too.
  if (snowMap) snowMap.remove();
  snowMap = L.map('snowMap', { scrollWheelZoom: false });
  // Standard OpenStreetMap tiles; in dark mode CSS inverts them (see .dark-tiles).
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 12, attribution: '© OpenStreetMap contributors' }).addTo(snowMap);
  $('snowMap').classList.toggle('dark-tiles', dark);
  snowLayer = L.layerGroup().addTo(snowMap);
  const vals = rows.map(({ e }) => value(e) ?? 0);
  const max = Math.max(6, ...vals);
  const color = (v) => (v >= 12 ? '#f28c28' : v >= 6 ? '#a78bfa' : v >= 2 ? '#3b82f6' : v >= 0.5 ? '#7dd3fc' : '#9ca3af');
  for (const { r, e } of rows) {
    const v = value(e) ?? 0;
    const m = L.circleMarker([r.lat, r.lon], {
      radius: 5 + 18 * Math.sqrt(v / max), color: '#fff', weight: 1.5, fillColor: color(v), fillOpacity: 0.85,
    }).addTo(snowLayer);
    m.bindTooltip(`${r.name} ${fmtIn(v)}`, { direction: 'top', permanent: v >= max * 0.35 && v >= 2, className: 'map-label' });
    m.bindPopup(`<b>${r.name}</b><br>Next 7 days: ${fmtIn(e.next7)}<br>By 9 am tomorrow: ${fmtIn(e.tomorrowBy9)}<br>
      Last 48 hours: ${e.recent48 ? fmtIn(e.recent48.inches) : '–'}<br>Season: ${e.season ? fmtIn(e.season.inches) : '–'}
      ${driveTo(r.id) != null ? `<br>Drive: ${fmtDrive(driveTo(r.id))}` : ''}<br><a href="#${r.id}" data-open="${r.id}">Open forecast →</a>`);
  }
  if (state.drive) L.circleMarker([state.drive.lat, state.drive.lon], { radius: 6, color: '#fff', weight: 2, fillColor: '#16a34a', fillOpacity: 1 }).addTo(snowLayer).bindTooltip('You');
  const pts = rows.map(({ r }) => [r.lat, r.lon]);
  if (pts.length) snowMap.fitBounds(pts, { padding: [30, 30], maxZoom: 9 });
  $('mapLegend').innerHTML = `${UP_SORTS[metric].label}: ` + [['#9ca3af', 'none'], ['#7dd3fc', '0.5"+'], ['#3b82f6', '2"+'], ['#a78bfa', '6"+'], ['#f28c28', '12"+']]
    .map(([c, l]) => `<span><i class="q" style="background:${c};border-radius:50%"></i>${l}</span>`).join('') + '<span class="muted">Bigger dot = more snow. Tap a dot for details.</span>';
}

async function loadUpcomingView() {
  renderHeader();
  renderUpcoming();
  await loadUpcoming(true);
  if (state.view === 'upcoming') renderUpcoming();
}

// ---------- compare resorts ----------

state.compare = (() => {
  try { const c = JSON.parse(store.get('compare')); if (Array.isArray(c) && c.length >= 2) return c; } catch {}
  return [state.favorites[0] || DEFAULT_RESORT, state.favorites.find((id) => id !== state.favorites[0]) || 'wolf-creek'];
})();
const compareData = {}; // resortId -> forecast (mid-mountain, no ensemble)

async function loadCompareView() {
  renderHeader();
  renderCompare();
  loadUpcoming().then(() => state.view === 'compare' && renderCompare());
  await Promise.all(state.compare.map(async (id) => {
    const r = RESORTS.find((x) => x.id === id);
    if (!r || compareData[id]?.fresh) return;
    compareData[id] ||= savedForecast(r, 'mid');
    try {
      const f = await getForecast(r, r.elevations.mid, state.calibration?.resorts?.[id], { ensemble: false, leadBias: state.leadBias });
      compareData[id] = { ...f, fresh: true };
    } catch (e) { console.warn(`Compare: ${r.name}`, e); }
    if (state.view === 'compare') renderCompare();
  }));
}

function renderCompare() {
  const picks = state.compare.map((id) => RESORTS.find((r) => r.id === id)).filter(Boolean);
  const options = (sel) => {
    const opt = (r) => `<option value="${r.id}" ${r.id === sel ? 'selected' : ''}>${r.name}</option>`;
    const favs = state.favorites.map((id) => RESORTS.find((r) => r.id === id)).filter(Boolean);
    let html = favs.length ? `<optgroup label="★ Favorites">${favs.map(opt).join('')}</optgroup>` : '';
    for (const [code, label] of Object.entries(STATE_NAMES)) html += `<optgroup label="${label}">${RESORTS.filter((r) => r.state === code).map(opt).join('')}</optgroup>`;
    return html;
  };
  const pickers = picks.map((r, i) => `<div class="cmp-pick"><select data-slot="${i}" aria-label="Resort ${i + 1}">${options(r.id)}</select>
      ${picks.length > 2 ? `<button class="link-btn" data-remove="${i}" aria-label="Remove">✕</button>` : ''}</div>`).join('')
    + (picks.length < 3 ? '<button class="loc-btn" id="cmpAdd">+ Add a third</button>' : '');

  // Per resort: the next 7 ski days from its forecast, plus measured numbers from upcoming.json.
  const info = picks.map((r) => {
    const f = compareData[r.id];
    const ti = f?.days?.findIndex((d) => d.date === f.todayStr) ?? -1;
    const days = ti >= 0 ? f.days.slice(ti, ti + 15) : [];
    const wk = days.slice(0, 7), next3 = days.slice(0, 3);
    const best = wk.slice(1).reduce((a, d) => (!a || d.overnight + 0.5 * d.lifts > a.overnight + 0.5 * a.lifts ? d : a), null);
    return {
      r, days, wk, todayStr: f?.todayStr, loaded: days.length > 0,
      snow7: sum(wk.map((d) => d.snow)), snow15: sum(days.map((d) => d.snow)),
      by9: days[1]?.overnight ?? null, best,
      wind: next3.length ? avg(next3.map((d) => d.wind)) : null, gust: next3.length ? Math.max(...next3.map((d) => d.gust)) : null,
      hiLo: next3.length ? [Math.min(...next3.map((d) => d.lo)), Math.max(...next3.map((d) => d.hi))] : null,
      up: state.upcoming?.resorts?.[r.id] || {}, drive: driveTo(r.id),
    };
  });
  const loaded = info.every((x) => x.loaded);
  // Highlight the best value in a row (most snow, least wind, shortest drive).
  const row = (label, vals, better) => {
    const nums = vals.map((v) => (typeof v === 'object' && v ? v.n : v));
    const valid = nums.filter((n) => n != null && !Number.isNaN(n));
    const winner = better && valid.length > 1 && new Set(valid).size > 1 ? (better === 'max' ? Math.max(...valid) : Math.min(...valid)) : null;
    return `<tr><th class="name">${label}</th>${vals.map((v, i) => `<td class="${winner != null && nums[i] === winner ? 'cmp-win' : ''}">${typeof v === 'object' && v ? v.t : v ?? '–'}</td>`).join('')}</tr>`;
  };
  const N = (n, t) => ({ n, t });
  const head = `<tr><th></th>${info.map((x) => `<th><a href="#${x.r.id}" data-open="${x.r.id}">${x.r.name}</a><br><small class="muted">${x.r.state} · ${passBadges(x.r.id) || 'no Epic/Ikon/Indy'}</small></th>`).join('')}</tr>`;
  const table = `<table class="cmp-table">${head}
    ${row('Next 7 days', info.map((x) => (x.loaded ? N(x.snow7, `<b>${fmtIn(x.snow7)}</b>`) : '…')), 'max')}
    ${row('Next 15 days', info.map((x) => (x.loaded ? N(x.snow15, fmtIn(x.snow15)) : '…')), 'max')}
    ${row('By 9 am tomorrow', info.map((x) => (x.by9 != null ? N(x.by9, fmtIn(x.by9)) : '–')), 'max')}
    ${row('Best powder day', info.map((x) => (x.best && x.best.overnight + x.best.lifts >= 1 ? `${dayLabel(x.best.date, x.todayStr).short}: ${fmtIn(x.best.overnight)} by 9 am` : 'none this week')))}
    ${row('Last 48 hours', info.map((x) => (x.up.recent48 ? N(x.up.recent48.inches, fmtIn(x.up.recent48.inches)) : '–')), 'max')}
    ${row('Season so far', info.map((x) => (x.up.season ? N(x.up.season.inches, fmtIn(x.up.season.inches)) : '–')), 'max')}
    ${row('Snow depth', info.map((x) => (x.up.depth ? N(x.up.depth.inches, fmtIn(x.up.depth.inches)) : '–')), 'max')}
    ${row('Wind, next 3 days', info.map((x) => (x.wind != null ? N(x.gust, `${Math.round(x.wind)} mph, gusts ${Math.round(x.gust)}`) : '–')), 'min')}
    ${row('Temps, next 3 days', info.map((x) => (x.hiLo ? `${Math.round(x.hiLo[0])}° to ${Math.round(x.hiLo[1])}°F` : '–')))}
    ${row('Drive', info.map((x) => (x.drive != null ? N(x.drive, fmtDrive(x.drive)) : '–')), 'min')}
    ${row('Summit / vertical', info.map((x) => `${ftLabel(x.r.elevations.summit)} / ${(Math.round(mToFt(x.r.elevations.summit - x.r.elevations.base) / 10) * 10).toLocaleString()}′`))}
  </table>`;

  // Day by day: snow, gusts and high for each resort; the snowiest cell each day is highlighted.
  const ref = info.find((x) => x.loaded);
  const grid = ref ? `<table class="cmp-table cmp-days"><tr><th></th>${info.map((x) => `<th>${x.r.name}</th>`).join('')}</tr>
    ${ref.wk.map((d0, k) => {
      const cells = info.map((x) => x.wk.find((d) => d.date === d0.date));
      const most = Math.max(...cells.map((d) => d?.snow ?? 0));
      const lbl = dayLabel(d0.date, ref.todayStr);
      return `<tr><th class="name">${lbl.short === 'Today' || lbl.short === 'Tmw' ? lbl.short : lbl.wk} <small class="muted">${lbl.md}</small></th>${cells.map((d) => (d
        ? `<td class="${most >= 1 && d.snow === most ? 'cmp-win' : ''}">${icon(d)} <b>${fmtIn(d.snow)}</b><br><small class="muted">gusts ${Math.round(d.gust)} · ${Math.round(d.hi)}°</small></td>`
        : '<td>–</td>')).join('')}</tr>`;
    }).join('')}</table>` : '';

  // One-line verdict.
  let verdict = '';
  if (loaded) {
    const bySnow = [...info].sort((a, b) => b.snow7 - a.snow7);
    const [a, b] = bySnow;
    verdict = a.snow7 - b.snow7 >= 1
      ? `<b>${a.r.name}</b> gets the most snow over the next 7 days (${fmtIn(a.snow7)} vs ${bySnow.slice(1).map((x) => `${fmtIn(x.snow7)} at ${x.r.name}`).join(', ')}).`
      : `Snow over the next 7 days is about even (${info.map((x) => `${x.r.name} ${fmtIn(x.snow7)}`).join(', ')}).`;
    const drives = info.filter((x) => x.drive != null).sort((p, q) => p.drive - q.drive);
    if (drives.length > 1 && drives[1].drive - drives[0].drive >= 20 * 60) verdict += ` ${drives[0].r.name} is ${fmtDrive(drives[1].drive - drives[0].drive)} closer than ${drives[1].r.name}.`;
  }
  $('compareView').innerHTML = `<section class="card">
      <div class="cmp-picks">${pickers}</div>
      ${verdict ? `<p class="best-day">${verdict}</p>` : '<p class="hint">Loading forecasts…</p>'}
      <div class="table-wrap">${table}</div>
      ${!state.drive ? '<p class="hint">Set your location on Upcoming Snow to see drive times here.</p>' : ''}
    </section>
    ${grid ? `<section class="card"><div class="card-head"><h2>Day by day</h2><span class="hint">Highlighted = most snow that day</span></div><div class="table-wrap">${grid}</div></section>` : ''}`;
}

// ---------- powder alerts (public per-resort ntfy channels) ----------

state.alertQuery = '';
function renderAlerts() {
  const q = state.alertQuery.trim().toLowerCase();
  const match = (r) => !q || `${r.name} ${r.region} ${STATE_NAMES[r.state]}`.toLowerCase().includes(q);
  const row = (r) => `<div class="alert-row">
      <span class="up-name"><a href="#${r.id}" data-open="${r.id}">${r.name}</a><small>${r.region}</small></span>
      <span class="alert-btns">${ALERT_TIERS.map((t) => `<a class="road-btn" href="https://ntfy.sh/${alertTopic(r.id, t)}" target="_blank" rel="noopener" title="${t}&quot; or more in a day">${t}"+</a>
        <button class="ghost small copy" data-copy="${alertTopic(r.id, t)}" aria-label="Copy the ${t}-inch channel name for ${r.name}" title="Copy channel name">⧉</button>`).join('')}</span>
    </div>`;
  const favs = RESORTS.filter((r) => state.favorites.includes(r.id) && match(r));
  const groups = Object.entries(STATE_NAMES).map(([code, label]) => {
    const rs = RESORTS.filter((r) => r.state === code && !state.favorites.includes(r.id) && match(r));
    return rs.length ? `<h3 class="sub-head">${label}</h3>${rs.map(row).join('')}` : '';
  }).join('');
  $('alertsView').innerHTML = `
    <section class="card">
      <div class="card-head"><h2>How it works</h2></div>
      <ol class="steps">
        <li>Get the free <b>ntfy</b> app: <a href="https://apps.apple.com/us/app/ntfy/id1625396347" target="_blank" rel="noopener">iPhone</a> ·
          <a href="https://play.google.com/store/apps/details?id=io.heckel.ntfy" target="_blank" rel="noopener">Android</a>. No account needed.</li>
        <li>Pick a mountain and a size below. <b>4"+</b> alerts on any day forecast to get 4 inches or more; <b>8"+</b> and <b>12"+</b> only on bigger days.
          Subscribe to one size per mountain.</li>
        <li>Tap the size to open the channel, then subscribe. Or tap ⧉ to copy its name, and in the ntfy app tap <b>+</b> and paste it.</li>
      </ol>
      <p class="hint">Alerts go out around 6–7 pm Mountain time and look at the next 3 ski days. You get a heads-up the first evening a powder day shows up,
        then a final call the evening before (with the amount by 9 am). Forecasts can change, so heads-ups can fade. Channels are public: share them with friends.
        To mute a channel for a while, long-press it in the ntfy app.</p>
    </section>
    <section class="card">
      <div class="up-tools"><input id="alertSearch" class="alert-search" type="search" placeholder="Find a mountain" value="${state.alertQuery.replace(/"/g, '&quot;')}" aria-label="Find a mountain"></div>
      ${favs.length ? `<h3 class="sub-head">★ Your favorites</h3>${favs.map(row).join('')}` : ''}
      ${groups || (favs.length ? '' : '<p class="hint">No mountains match.</p>')}
    </section>`;
}

function applyView() {
  document.body.classList.toggle('fav-mode', state.view === 'favorites');
  document.body.classList.toggle('list-mode', state.view !== 'resort');
  $('favView').hidden = state.view !== 'favorites';
  $('upcomingView').hidden = state.view !== 'upcoming';
  $('compareView').hidden = state.view !== 'compare';
  $('alertsView').hidden = state.view !== 'alerts';
}

// ---------- loading ----------

async function loadCalibration() {
  // no-cache: always revalidate, so a recalibration shows up right away.
  const get = (f) => fetch(f, { cache: 'no-cache' }).then((r) => r.json()).catch((e) => { console.warn(`No ${f}`, e); return null; });
  [state.calibration, state.leadBias, state.trend] = await Promise.all([get('data/calibration.json'), get('data/lead-bias.json'), get('data/forecast-trend.json')]);
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
  renderGettingThere();
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
    const f = await getForecast(r, elevM, state.calibration?.resorts?.[r.id], { leadBias: state.leadBias });
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
  if (LIST_VIEWS.includes(id)) {
    state.elev = 'mid'; // every mountain and view starts at mid-mountain
    state.view = id;
    history.replaceState(null, '', '#' + id);
    applyView();
    window.scrollTo(0, 0);
    if (id === 'favorites') loadFavView(); else if (id === 'upcoming') loadUpcomingView(); else if (id === 'compare') loadCompareView(); else renderAlerts();
    return;
  }
  if (!id || (id === state.resortId && state.view === 'resort')) return;
  state.elev = 'mid';
  state.view = 'resort';
  state.resortId = id;
  state.selected = null;
  state.mapIdx = 0;
  history.replaceState(null, '', id === DEFAULT_RESORT ? location.pathname : '#' + id);
  applyView();
  window.scrollTo(0, 0);
  load();
  loadResortExtras();
}

$('resortSel').addEventListener('change', (e) => switchResort(e.target.value));
$('topnav').addEventListener('click', (e) => {
  const v = e.target.closest('button[data-view]')?.dataset.view;
  if (v) switchResort(v);
});
// Links to a resort inside banners, map popups etc. (data-open="resortId").
document.addEventListener('click', (e) => {
  const a = e.target.closest('[data-open]');
  if (!a) return;
  e.preventDefault();
  switchResort(a.dataset.open);
});
$('upcomingView').addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.filter) { state.upFilter = b.dataset.filter; renderUpcoming(); return; }
  if (b.dataset.pass) { state.upPass = b.dataset.pass; renderUpcoming(); return; }
  if (b.dataset.mode) { state.upMode = b.dataset.mode; renderUpcoming(); return; }
  if (b.id === 'changeLoc') { state.locEditing = true; renderUpcoming(); $('locQuery')?.focus(); return; }
  if (b.id === 'locate') {
    b.disabled = true;
    b.textContent = 'Finding drive times…';
    try {
      await locateAndRoute();
      state.locEditing = false;
    } catch (err) {
      alert(err.code === 1 ? 'Location permission was denied. You can type your town or ZIP code instead.' : `Couldn't get drive times: ${err.message}`);
    }
    renderUpcoming();
    return;
  }
  if (b.dataset.place) {
    const p = JSON.parse(b.dataset.place);
    b.disabled = true;
    try { await routeFrom(p.lat, p.lon, p.label, null); state.locEditing = false; } catch (err) { alert(`Couldn't get drive times: ${err.message}`); }
    renderUpcoming();
    return;
  }
  if (b.classList.contains('up-row')) switchResort(b.dataset.id);
});
// Typed town / ZIP: one match routes straight away; several show as choices.
$('upcomingView').addEventListener('submit', async (e) => {
  if (e.target.id !== 'locForm') return;
  e.preventDefault();
  const q = $('locQuery').value;
  if (!q.trim()) return;
  const out = $('locResults');
  out.textContent = 'Searching…';
  try {
    const places = await findPlaces(q);
    if (!places.length) { out.textContent = 'No match. Try a town name or 5-digit ZIP.'; return; }
    // A US ZIP, a single match, or a single western-US match needs no choosing.
    const zip = /^\d{5}$/.test(q.trim()) && places.find((p) => p.rank <= 1);
    const west = places.filter((p) => p.rank === 0);
    const pick = zip || (places.length === 1 ? places[0] : west.length === 1 ? west[0] : null);
    if (pick) {
      await routeFrom(pick.lat, pick.lon, pick.label, null);
      state.locEditing = false;
      renderUpcoming();
      return;
    }
    out.innerHTML = places.map((p) => `<button type="button" data-place='${JSON.stringify(p).replace(/'/g, '&#39;')}'>${p.label}</button>`).join('');
  } catch (err) { out.textContent = `Search failed: ${err.message}`; }
});
$('compareView').addEventListener('change', (e) => {
  const slot = e.target.dataset.slot;
  if (slot == null) return;
  state.compare[+slot] = e.target.value;
  store.set('compare', JSON.stringify(state.compare));
  loadCompareView();
});
$('compareView').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.id === 'cmpAdd') {
    state.compare.push(RESORTS.find((r) => !state.compare.includes(r.id) && state.favorites.includes(r.id))?.id || RESORTS.find((r) => !state.compare.includes(r.id)).id);
  } else if (b.dataset.remove != null) state.compare.splice(+b.dataset.remove, 1);
  else return;
  store.set('compare', JSON.stringify(state.compare));
  loadCompareView();
});
$('alertsView').addEventListener('input', (e) => {
  if (e.target.id !== 'alertSearch') return;
  state.alertQuery = e.target.value;
  renderAlerts();
  const box = $('alertSearch');
  box.focus();
  box.setSelectionRange(box.value.length, box.value.length);
});
$('alertsView').addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-copy]');
  if (b) { // copy a channel name to paste into the ntfy app
    try { await navigator.clipboard.writeText(b.dataset.copy); b.textContent = '✓'; } catch { prompt('Channel name:', b.dataset.copy); }
    setTimeout(() => { b.textContent = '⧉'; }, 1500);
  }
});
$('upcomingView').addEventListener('change', (e) => {
  if (e.target.id === 'upSort') { state.upSort = e.target.value; renderUpcoming(); }
  if (e.target.id === 'upDrive') { state.upDrive = +e.target.value; renderUpcoming(); }
});
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
  loadRunTrend();
  if (state.view === 'favorites') loadFavView(); else if (state.view === 'resort') load();
});
$('refresh').addEventListener('click', load);

// Reopening the app later (it stays in memory on iPhone) refreshes a stale forecast.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (state.view === 'favorites') loadFavView();
  else if (state.view === 'upcoming') loadUpcomingView();
  else if (state.view === 'compare') loadCompareView();
  else if (!state.fetchedAt || Date.now() - state.fetchedAt > STALE_MS) { load(); loadStation(); }
});
setInterval(renderStatus, 60e3);

applyView();
// Theme: Auto follows the phone's light/dark setting; the button cycles Auto → Light → Dark.
const THEMES = { auto: ['◐', 'Auto'], light: ['☀︎', 'Light'], dark: ['☾', 'Dark'] };
let theme = store.get('theme') || 'auto';
function applyTheme() {
  if (theme === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  const [icon_, label] = THEMES[theme];
  $('themeBtn').innerHTML = `${icon_}<span class="wide-only"> ${label}</span>`;
  $('themeBtn').setAttribute('aria-label', `Theme: ${label}`);
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
if (state.view === 'alerts') { renderHeader(); renderAlerts(); }
loadCalibration().then(() => (state.view === 'favorites' ? loadFavView() : state.view === 'upcoming' ? loadUpcomingView() : state.view === 'compare' ? loadCompareView() : state.view === 'alerts' ? null : load({ redraw: false })));
loadReports().then(() => { if (state.view === 'resort') { renderSnowReport(); if (state.days.length) renderSnowSummary(); } });
if (state.view === 'resort') loadResortExtras();

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
