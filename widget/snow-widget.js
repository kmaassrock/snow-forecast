// Snow Forecast widget for Scriptable (https://scriptable.app).
//
// Setup: paste this into a new Scriptable script, add a Scriptable widget to
// your Home Screen, long-press it → Edit Widget → choose this script.
// Parameter (optional): purgatory, wolf-creek, vail, park-city, whistler,
// or "all" for every mountain. Defaults to purgatory.

const SITE = 'https://kmaassrock.github.io/snow-forecast/';
const param = (args.widgetParameter || 'purgatory').trim().toLowerCase();

const C = {
  top: new Color('#1d3a66'),
  bottom: new Color('#0e1726'),
  text: Color.white(),
  muted: new Color('#93a4c0'),
  line: new Color('#2a3d5e'),
  night: new Color('#3d7fd6'),
  day: new Color('#9fd2ff'),
  good: new Color('#7be0a8'),
};

const fmt = (x) => (x == null ? '–' : x < 0.05 ? '0"' : x < 1 ? `${x.toFixed(1)}"` : `${Math.round(x)}"`);

// Latest snapshot from the site, falling back to the last good copy when offline.
async function loadSummary() {
  const fm = FileManager.local();
  const file = fm.joinPath(fm.cacheDirectory(), 'snow-summary.json');
  try {
    const req = new Request(SITE + 'data/summary.json');
    req.timeoutInterval = 15;
    const data = await req.loadJSON();
    if (!data.resorts) throw new Error('bad summary');
    fm.writeString(file, JSON.stringify(data));
    return data;
  } catch (e) {
    if (fm.fileExists(file)) return JSON.parse(fm.readString(file));
    throw e;
  }
}

// Stacked bars: before lifts open (dark) under while lifts open (light).
function barsImage(days, w, h, labels) {
  const ctx = new DrawContext();
  ctx.size = new Size(w, h);
  ctx.opaque = false;
  ctx.respectScreenScale = true;
  const labelH = labels ? 14 : 0, valH = labels ? 13 : 0;
  const max = Math.max(4, ...days.map((d) => d.snow));
  const slot = w / days.length, bw = Math.max(4, slot * 0.5);
  const base = h - labelH, plotH = base - valH;
  days.forEach((d, i) => {
    const x = i * slot + (slot - bw) / 2;
    const hn = (plotH * d.overnight) / max, hd = (plotH * d.lifts) / max;
    ctx.setFillColor(C.line);
    ctx.fillRect(new Rect(x, base - 1, bw, 1));
    ctx.setFillColor(C.night);
    ctx.fillRect(new Rect(x, base - hn, bw, hn));
    ctx.setFillColor(C.day);
    ctx.fillRect(new Rect(x, base - hn - hd, bw, hd));
    if (labels) {
      ctx.setTextAlignedCenter();
      ctx.setFont(Font.mediumSystemFont(9));
      ctx.setTextColor(i === 0 ? C.text : C.muted);
      ctx.drawTextInRect(d.label, new Rect(i * slot, base + 2, slot, labelH));
      if (d.snow >= 0.5) {
        ctx.setFont(Font.boldSystemFont(9));
        ctx.setTextColor(C.text);
        ctx.drawTextInRect(fmt(d.snow), new Rect(i * slot, base - hn - hd - valH, slot, valH));
      }
    }
  });
  return ctx.getImage();
}

function addText(stack, text, font, color) {
  const t = stack.addText(text);
  t.font = font;
  t.textColor = color;
  t.lineLimit = 1;
  t.minimumScaleFactor = 0.7;
  return t;
}

// Fixed-width column inside a row, so rows line up.
function cell(row, width) {
  const c = row.addStack();
  c.size = new Size(width, 0);
  return c;
}

function headline(stack, r) {
  const head = stack.addStack();
  head.centerAlignContent();
  addText(head, r.name.toUpperCase(), Font.boldSystemFont(11), C.muted);
  head.addSpacer();
  if (r.powder) addText(head, '❄️', Font.systemFont(11), C.text);
  stack.addSpacer(2);
  const m = r.nextMorning;
  addText(stack, fmt(m?.overnight), Font.boldRoundedSystemFont(34), r.powder ? C.good : C.text);
  addText(stack, m ? `by 9am ${m.label}` : 'by 9am', Font.mediumSystemFont(11), C.muted);
  stack.addSpacer(6);
  const stats = stack.addStack();
  for (const [label, v] of [['5 DAYS', r.next5?.snow], ['14 DAYS', r.next14?.snow]]) {
    const s = stats.addStack();
    s.layoutVertically();
    addText(s, label, Font.semiboldSystemFont(8), C.muted);
    addText(s, fmt(v), Font.boldSystemFont(13), C.text);
    stats.addSpacer(14);
  }
}

function single(w, r, family) {
  if (family === 'small') {
    headline(w, r);
    w.addSpacer();
    const img = w.addImage(barsImage(r.days, 130, 26, false));
    img.imageSize = new Size(130, 26);
    return;
  }
  const row = w.addStack();
  const left = row.addStack();
  left.layoutVertically();
  headline(left, r);
  left.addSpacer();
  row.addSpacer(12);
  const img = row.addImage(barsImage(r.days, 170, 100, true));
  img.imageSize = new Size(170, 100);

  if (family === 'large') {
    w.addSpacer(10);
    for (const d of r.days) {
      const line = w.addStack();
      line.centerAlignContent();
      addText(cell(line, 44), d.label, Font.semiboldSystemFont(12), C.text);
      addText(cell(line, 36), fmt(d.snow), Font.boldSystemFont(12), d.snow >= 6 ? C.good : C.text);
      const detail = d.snow >= 0.1 ? `${fmt(d.overnight)} before open · ${d.type || ''}` : '';
      addText(line, detail, Font.systemFont(11), C.muted);
      line.addSpacer();
      addText(line, `${d.hiF}° / ${d.loF}°`, Font.systemFont(11), C.muted);
      w.addSpacer(4);
    }
  }
}

// Right-aligned text in a fixed-width column.
function rightCell(row, width, text, font, color) {
  const c = cell(row, width);
  c.addSpacer();
  addText(c, text, font, color);
}

function all(w, resorts, family) {
  const small = family === 'small', large = family === 'large';
  const cols = small
    ? [['5 DAYS', (r) => r.next5?.snow]]
    : [['BY 9AM', (r) => r.nextMorning?.overnight], ['5 DAYS', (r) => r.next5?.snow], ['14 DAYS', (r) => r.next14?.snow]];
  const colW = small ? 44 : 50;
  const spark = (row, draw) => { row.addSpacer(10); if (draw) { const img = row.addImage(draw); img.imageSize = new Size(70, 20); } else cell(row, 70); };

  const head = w.addStack();
  addText(head, 'SNOW', Font.boldSystemFont(10), C.muted);
  head.addSpacer();
  for (const [label] of cols) rightCell(head, colW, label, Font.boldSystemFont(8), C.muted);
  if (large) spark(head, null);
  w.addSpacer(6);

  for (const r of resorts) {
    const line = w.addStack();
    line.centerAlignContent();
    addText(line, (r.powder ? '❄️ ' : '') + r.name, Font.semiboldSystemFont(small ? 11 : 13), r.powder ? C.good : C.text);
    line.addSpacer();
    for (const [, get] of cols) rightCell(line, colW, fmt(get(r)), Font.boldSystemFont(small ? 11 : 13), C.text);
    if (large) spark(line, barsImage(r.days, 70, 20, false));
    w.addSpacer(large ? 22 : 4);
  }
}

async function build(family) {
  const w = new ListWidget();
  const g = new LinearGradient();
  g.colors = [C.top, C.bottom];
  g.locations = [0, 1];
  w.backgroundGradient = g;
  w.setPadding(14, 14, 12, 14);
  w.refreshAfterDate = new Date(Date.now() + 30 * 60 * 1000);

  let data;
  try {
    data = await loadSummary();
  } catch (e) {
    addText(w, "Couldn't load the snow forecast.", Font.systemFont(12), C.muted);
    return w;
  }
  const resort = data.resorts.find((r) => r.id === param);
  if (param === 'all' || !resort) {
    all(w, data.resorts, family);
    w.url = SITE;
  } else {
    single(w, resort, family);
    w.url = SITE + '#' + resort.id;
  }
  w.addSpacer();
  if (family === 'small' && param !== 'all' && resort) return w; // no room for the footer
  const t = new Date(data.generated);
  addText(w, `Updated ${t.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`, Font.systemFont(9), C.muted);
  return w;
}

const family = config.widgetFamily || 'medium';
const widget = await build(family);
if (config.runsInWidget) Script.setWidget(widget);
else if (family === 'small') await widget.presentSmall();
else if (family === 'large') await widget.presentLarge();
else await widget.presentMedium();
Script.complete();
