// Chromasmith Batch — UI. All rendering goes through ./engine.js (the real Chromasmith renderer in
// a hidden frame); this file only owns the batch: which photos, which recipe, where files go.
import { Engine, PRIO } from './engine.js';
import { ZipWriter } from './zip.js';

const $ = (id) => document.getElementById(id);
const THUMB = 320, PREVIEW = 1600, SWATCH = 180, STORE = 'cs-batch-v1';
const ZIP_SPLIT = 1.5e9; // start a new archive part past this many bytes

// Effects whose amount slider doubles as the on/off switch here (0 = off). The editor keeps a
// non-zero resting amount behind a separate toggle; in a batch tool one control is clearer.
const EFFECT_OFF = { 'grain-a': 0, 'hal-a': 0, 'bloom-a': 0, vig: 0 };
const ev = (v) => (v > 0 ? '+' : '') + (v / 20).toFixed(2); // the editor maps ±100 to ±5 stops
const SECTIONS = [
  { title: 'Light', rows: [['adj-exp', 'Exposure', ev], ['adj-con', 'Contrast'], ['adj-hi', 'Highlights'], ['adj-sh', 'Shadows'], ['adj-wh', 'Whites'], ['adj-bl', 'Blacks']] },
  { title: 'Colour', rows: [['adj-temp', 'Temperature'], ['adj-tint', 'Tint'], ['adj-vib', 'Vibrance'], ['adj-sat', 'Saturation']] },
  { title: 'Film', rows: [['grain-a', 'Grain'], ['grain-sz', 'Grain size'], ['hal-a', 'Halation'], ['bloom-a', 'Bloom'], ['vig', 'Vignette']] },
  { title: 'Detail', rows: [['adj-clarity', 'Clarity'], ['adj-sharp', 'Sharpen']] },
];
const LOOK_ROWS = [['lut-mix', 'Strength']];

let engine = null;
let uid = 0;
const S = {
  photos: [], cur: null, sel: new Set(), anchor: null, scope: 'all',
  base: { sliders: {}, selects: { 'sel-lut': '', 'sel-print': '' } },
  exp: { format: 'jpg', quality: 92, size: '0', sharpen: '0', pattern: '{name}_edit', keepGps: true, dest: 'zip' },
  lookFx: true, dir: null, busy: false, cat: 'All', q: '', showOrig: false,
};
const specs = {};      // slider id -> {min,max,step,def}
const rows = {};       // slider id -> {el,input,out,fmt}
const lookEls = [];    // {value,key,name,cat,el,cv,visible,stamp}
const pvCache = new Map(); // photo id -> preview-size source canvas (small LRU)

// ── recipes ────────────────────────────────────────────────────────────────────────────────
const defOf = (id) => (id in EFFECT_OFF ? EFFECT_OFF[id] : specs[id] ? specs[id].def : 0);
const effective = (p) => (p && p.ov
  ? { sliders: { ...S.base.sliders, ...p.ov.sliders }, selects: { ...S.base.selects, ...p.ov.selects } }
  : S.base);
const selPhotos = () => S.photos.filter((p) => S.sel.has(p.id));
// What the controls currently show: the batch recipe, or the current photo's when editing a selection.
const viewRecipe = () => (S.scope === 'sel' && S.cur ? effective(S.cur) : S.base);
const sliderVal = (id) => { const v = viewRecipe().sliders[id]; return v === undefined ? defOf(id) : parseFloat(v); };

function edit(changes) { // [[kind,id,value],…] applied to the batch or to the selected photos
  if (S.scope === 'sel') {
    const t = selPhotos();
    for (const p of t) {
      p.ov = p.ov || { sliders: {}, selects: {} };
      for (const [k, id, v] of changes) p.ov[k][id] = v;
      paintCell(p);
    }
    touch(t);
  } else {
    for (const [k, id, v] of changes) S.base[k][id] = v;
    touch(S.photos); save();
  }
  refreshCounts();
}

function save() {
  try { localStorage.setItem(STORE, JSON.stringify({ base: S.base, exp: S.exp, lookFx: S.lookFx })); } catch (_) {}
}
function load() {
  try {
    const d = JSON.parse(localStorage.getItem(STORE) || 'null');
    if (!d) return;
    if (d.base && d.base.sliders && d.base.selects) {
      for (const k in d.base.sliders) if (specs[k]) S.base.sliders[k] = d.base.sliders[k];
      const lut = d.base.selects['sel-lut'] || '';
      if (!lut || lookEls.some((l) => l.value === lut)) S.base.selects['sel-lut'] = lut;
      const pr = d.base.selects['sel-print'] || '';
      if (!pr || engine.prints().some((x) => x.value === pr)) S.base.selects['sel-print'] = pr;
    }
    if (d.exp) for (const k of ['format', 'quality', 'size', 'sharpen', 'pattern', 'keepGps', 'dest']) if (d.exp[k] !== undefined) S.exp[k] = d.exp[k];
    if (typeof d.lookFx === 'boolean') S.lookFx = d.lookFx;
  } catch (_) {}
}

// ── small helpers ──────────────────────────────────────────────────────────────────────────
function blit(cv, src) { cv.width = src.width; cv.height = src.height; cv.getContext('2d').drawImage(src, 0, 0); }
function shrink(src, longEdge) {
  const k = Math.min(1, longEdge / Math.max(src.width, src.height));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(src.width * k)); c.height = Math.max(1, Math.round(src.height * k));
  const g = c.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(src, 0, 0, c.width, c.height);
  return c;
}
let toastTimer = 0;
function toast(msg, bad) {
  const t = $('toast'); t.textContent = msg; t.classList.toggle('bad', !!bad); t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, bad ? 6000 : 3200);
}
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

// At most three browser decodes at once: each one briefly holds a full-size bitmap.
const pool = { n: 0, q: [] };
function slot(fn) {
  return new Promise((res, rej) => {
    const go = async () => { pool.n++; try { res(await fn()); } catch (e) { rej(e); } finally { pool.n--; const nx = pool.q.shift(); if (nx) nx(); } };
    if (pool.n < 3) go(); else pool.q.push(go);
  });
}
async function bitmapProxy(file, longEdge) {
  return slot(async () => {
    const bmp = await createImageBitmap(file); // honours EXIF orientation
    try { return { canvas: shrink(bmp, longEdge), fullW: bmp.width, fullH: bmp.height }; } finally { bmp.close(); }
  });
}
// Browser decode when it can, engine decode (RAW, TIFF, HEIC outside Safari) when it cannot.
async function proxyFor(p, longEdge, prio, key) {
  if (!p.isRaw && !/\.tiff?$/i.test(p.name)) {
    try { return await bitmapProxy(p.file, longEdge); } catch (_) { /* fall through to the engine */ }
  }
  return engine.decodeProxy(p.file, longEdge, prio, key);
}

// ── photos / grid ──────────────────────────────────────────────────────────────────────────
const cellIO = new IntersectionObserver((entries) => {
  for (const e of entries) {
    const p = S.photos.find((x) => x.el === e.target); if (!p) continue;
    p.visible = e.isIntersecting;
    if (!p.visible) continue;
    if (!p.thumb) loadThumb(p); else if (p.dirty) gradeThumb(p);
  }
}, { root: $('grid'), rootMargin: '400px' });

function addFiles(files) {
  const have = new Set(S.photos.map((p) => p.sig));
  const sig = (f) => `${f.webkitRelativePath || f.name}|${f.size}|${f.lastModified}`;
  const all = [...files];
  const fresh = all.filter((f) => engine.accepts(f.name) && !have.has(sig(f)) && have.add(sig(f)));
  fresh.sort((a, b) => collator.compare(a.name, b.name));
  const skipped = all.filter((f) => !engine.accepts(f.name) && !/^\./.test(f.name)).length;
  if (!fresh.length) { toast(all.length ? 'No new photos in that selection' : 'Nothing to add', true); return; }
  const frag = document.createDocumentFragment();
  for (const file of fresh) {
    const p = { id: 'p' + (++uid), file, sig: sig(file), name: file.name, isRaw: engine.isRaw(file.name), ov: null, thumb: null, dirty: true, visible: false, status: null };
    const el = document.createElement('div');
    el.className = 'cell ph'; el.setAttribute('role', 'option'); el.dataset.id = p.id; el.title = p.name;
    const cv = document.createElement('canvas'); cv.width = cv.height = 1;
    const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = p.name;
    el.append(cv, nm);
    p.el = el; p.cv = cv;
    S.photos.push(p); frag.appendChild(el);
  }
  $('grid').appendChild(frag);
  for (const p of S.photos.slice(-fresh.length)) cellIO.observe(p.el);
  document.body.classList.remove('empty');
  if (!S.cur) { S.sel = new Set([S.photos[0].id]); S.anchor = S.photos[0]; setCur(S.photos[0]); }
  paintSelection(); refreshCounts();
  toast(`Added ${plural(fresh.length, 'photo')}` + (skipped ? ` — ${plural(skipped, 'file')} skipped (not a supported image)` : ''));
}

async function loadThumb(p) {
  if (p.loading || p.thumb || p.bad) return;
  p.loading = true;
  try {
    const r = await proxyFor(p, THUMB, PRIO.THUMB, 'decode:' + p.id);
    if (!r || !S.photos.includes(p)) return;
    p.thumb = r.canvas; p.fullW = r.fullW; p.fullH = r.fullH;
    blit(p.cv, p.thumb); p.el.classList.remove('ph');
    p.dirty = true; if (p.visible) gradeThumb(p);
    if (p === S.cur) { paintPreviewInfo(); schedulePreview(); scheduleSwatches(); }
  } catch (e) {
    p.bad = (e && e.message) || 'could not open';
    p.el.classList.remove('ph'); p.el.classList.add('bad');
    p.el.textContent = 'Cannot open ' + p.name; p.el.title = p.bad;
    if (p === S.cur) paintPreviewInfo();
  } finally { p.loading = false; }
}

async function gradeThumb(p) {
  if (!p.thumb) return;
  p.dirty = false;
  const stamp = p.stamp = (p.stamp || 0) + 1;
  try {
    const out = await engine.render('thumb:' + p.id, PRIO.THUMB, p.thumb, effective(p), p.isRaw, p.fullW);
    if (!out) return;
    if (p.stamp === stamp && S.photos.includes(p)) blit(p.cv, out);
    out.width = out.height = 0;
  } catch (e) { console.warn('thumb', p.name, e); }
}

let thumbTimer = 0;
function touch(list) {
  for (const p of list) p.dirty = true;
  clearTimeout(thumbTimer);
  thumbTimer = setTimeout(() => { for (const p of S.photos) if (p.visible && p.dirty && p.thumb) gradeThumb(p); }, 140);
  if (S.cur && list.includes(S.cur)) { schedulePreview(); scheduleSwatches(); }
}

function paintCell(p) {
  let own = p.el.querySelector('.own');
  if (p.ov && !own) { own = document.createElement('span'); own.className = 'own'; own.title = 'Has its own settings'; p.el.appendChild(own); }
  if (!p.ov && own) own.remove();
  let st = p.el.querySelector('.st');
  if (p.status && !st) { st = document.createElement('span'); p.el.appendChild(st); }
  if (!p.status && st) st.remove();
  if (p.status) {
    st.className = 'st ' + p.status;
    st.textContent = p.status === 'done' ? '✓' : p.status === 'fail' ? '!' : '…';
    st.title = p.status === 'done' ? 'Exported as ' + (p.outName || '') : p.status === 'fail' ? 'Failed: ' + (p.err || '') : 'Exporting';
  }
}
function paintSelection() {
  for (const p of S.photos) {
    const on = S.sel.has(p.id);
    p.el.classList.toggle('sel', on && p !== S.cur);
    p.el.classList.toggle('cur', p === S.cur);
    p.el.setAttribute('aria-selected', on ? 'true' : 'false');
  }
}
function refreshCounts() {
  const n = S.photos.length, s = S.sel.size, own = S.photos.filter((p) => p.ov).length;
  $('gridcount').textContent = [plural(n, 'photo'), s > 1 ? `${s} selected` : '', own ? `${own} with own settings` : ''].filter(Boolean).join(' · ');
  $('scope-sel').textContent = s > 1 ? `Selected only (${s})` : 'This photo only';
  $('go-all').textContent = `Export all ${plural(n, 'photo')}`;
  $('go-sel').textContent = s > 1 ? `Export ${s} selected` : 'Export this photo';
  $('go-sel').hidden = n < 2;
  $('rm-sel').textContent = s > 1 ? `Remove ${s} selected` : 'Remove photo';
  $('reset').title = S.scope === 'sel' ? 'Put the selected photos back on the batch settings' : 'Reset the batch settings to neutral';
}

function setCur(p) {
  S.cur = p;
  engine.cancel('sw:');
  paintSelection(); paintPreviewInfo();
  if (p) p.el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  schedulePreview(); scheduleSwatches();
  refreshControls();
}
function clickCell(p, e) {
  if (e.shiftKey && S.anchor && S.photos.includes(S.anchor)) {
    const a = S.photos.indexOf(S.anchor), b = S.photos.indexOf(p);
    S.sel = new Set(S.photos.slice(Math.min(a, b), Math.max(a, b) + 1).map((x) => x.id));
  } else if (e.metaKey || e.ctrlKey) {
    if (S.sel.has(p.id) && S.sel.size > 1) {
      S.sel.delete(p.id);
      if (p === S.cur) p = S.photos.find((x) => S.sel.has(x.id));
    } else S.sel.add(p.id);
    S.anchor = p;
  } else { S.sel = new Set([p.id]); S.anchor = p; }
  setCur(p); refreshCounts();
}
function removeSelected() {
  if (!S.sel.size || S.busy) return;
  const firstIdx = S.photos.findIndex((p) => S.sel.has(p.id));
  for (const p of selPhotos()) {
    cellIO.unobserve(p.el); p.el.remove(); pvCache.delete(p.id);
    engine.cancel('thumb:' + p.id); engine.cancel('decode:' + p.id);
    if (p.thumb) p.thumb.width = p.thumb.height = 0;
  }
  S.photos = S.photos.filter((p) => !S.sel.has(p.id));
  const next = S.photos[Math.min(firstIdx, S.photos.length - 1)] || null;
  S.sel = new Set(next ? [next.id] : []); S.anchor = next;
  if (!next) { document.body.classList.add('empty'); S.scope = 'all'; }
  setCur(next); refreshCounts();
}

// ── preview ────────────────────────────────────────────────────────────────────────────────
let pvRaf = 0, pvGen = 0;
function schedulePreview() { if (!pvRaf) pvRaf = requestAnimationFrame(() => { pvRaf = 0; renderPreview(); }); }
function paintPreviewInfo() {
  const p = S.cur;
  $('pvname').textContent = p ? p.name : '';
  $('pvinfo').textContent = !p ? '' : p.bad ? 'cannot open: ' + p.bad : p.fullW ? `${p.fullW} × ${p.fullH}${p.isRaw ? ' · RAW' : ''}` : 'opening…';
}
async function previewSource(p) {
  const hit = pvCache.get(p.id);
  if (hit) { pvCache.delete(p.id); pvCache.set(p.id, hit); return hit; }
  if (!p.pvLoad) {
    p.pvLoad = proxyFor(p, PREVIEW, PRIO.PREVIEW, 'pvdecode:' + p.id).then((r) => {
      p.pvLoad = null;
      if (!r) return null;
      pvCache.set(p.id, r.canvas);
      while (pvCache.size > 5) { const k = pvCache.keys().next().value; const c = pvCache.get(k); pvCache.delete(k); c.width = c.height = 0; }
      return r.canvas;
    }, (e) => { p.pvLoad = null; throw e; });
  }
  return p.pvLoad;
}
async function renderPreview() {
  const p = S.cur, gen = ++pvGen, cv = $('pvc');
  $('pvtag').hidden = !S.showOrig;
  if (!p || p.bad) { cv.width = cv.height = 2; return; }
  let src = pvCache.get(p.id);
  if (!src) {
    if (p.thumb) blit(cv, S.showOrig ? p.thumb : p.cv); // sharp frame is on its way; show the thumbnail meanwhile
    try { src = await previewSource(p); } catch (e) { return; }
    if (gen !== pvGen || !src) return;
  }
  if (S.showOrig) { blit(cv, src); return; }
  try {
    const out = await engine.render('preview', PRIO.PREVIEW, src, effective(p), p.isRaw, p.fullW);
    if (!out) return;
    if (gen === pvGen) blit(cv, out);
    out.width = out.height = 0;
  } catch (e) { $('pvinfo').textContent = (e && e.message) || 'render failed'; }
}
function setOrig(on) { if (S.showOrig !== on) { S.showOrig = on; schedulePreview(); } }

// ── looks ──────────────────────────────────────────────────────────────────────────────────
const lookIO = new IntersectionObserver((entries) => {
  for (const e of entries) { const L = lookEls.find((x) => x.el === e.target); if (L) L.visible = e.isIntersecting; }
  scheduleSwatches(120);
}, { root: $('looks'), rootMargin: '120px' });

function buildLooks() {
  const groups = engine.looks();
  const mk = (value, key, name, cat) => {
    const el = document.createElement('button'); el.type = 'button'; el.className = 'look'; el.title = name;
    const sw = document.createElement('span'); sw.className = 'sw';
    const cv = document.createElement('canvas'); cv.width = 3; cv.height = 2; sw.appendChild(cv);
    const ln = document.createElement('span'); ln.className = 'ln'; ln.textContent = name;
    el.append(sw, ln);
    el.addEventListener('click', () => pickLook(value));
    $('looks').appendChild(el);
    const L = { value, key, name, cat, el, cv, visible: false, stamp: null };
    lookEls.push(L); lookIO.observe(el);
  };
  mk('', '', 'No look', 'All');
  for (const g of groups) for (const l of g.looks) mk(l.value, l.key, l.name, g.cat);
  $('looksearch').placeholder = `Search ${lookEls.length - 1} film looks`;
  for (const cat of ['All', ...groups.map((g) => g.cat)]) {
    const b = document.createElement('button'); b.type = 'button'; b.textContent = cat;
    b.addEventListener('click', () => { S.cat = cat; filterLooks(); });
    $('chips').appendChild(b);
  }
  $('looksearch').addEventListener('input', (e) => { S.q = e.target.value.trim().toLowerCase(); filterLooks(); });
  const pr = $('print');
  pr.append(new Option('None', ''), ...engine.prints().map((x) => new Option(x.name, x.value)));
  pr.addEventListener('change', () => edit([['selects', 'sel-print', pr.value]]));
  filterLooks();
}
function filterLooks() {
  let shown = 0;
  for (const L of lookEls) {
    const ok = (S.cat === 'All' || L.cat === S.cat || !L.value) && (!S.q || L.name.toLowerCase().includes(S.q));
    L.el.hidden = !ok; if (ok) shown++;
  }
  $('lookempty').hidden = shown > 0;
  for (const b of $('chips').children) b.setAttribute('aria-pressed', b.textContent === S.cat ? 'true' : 'false');
}
function pickLook(value) {
  const ch = [['selects', 'sel-lut', value]];
  const d = S.lookFx && value ? engine.lookDefaults(value.slice(2)) : null;
  if (d) ch.push(['sliders', 'grain-a', Math.round(d.grain)], ['sliders', 'hal-a', Math.round(d.halation)], ['sliders', 'bloom-a', Math.round(d.bloom)]);
  edit(ch); refreshControls();
}

// Each swatch is the current photo graded with that look on top of the current settings.
let swTimer = 0, swSrc = null;
function scheduleSwatches(ms = 350) { clearTimeout(swTimer); swTimer = setTimeout(pumpSwatches, ms); }
function pumpSwatches() {
  const p = S.cur; if (!p || !p.thumb) return;
  const r = effective(p), sel = { ...r.selects }; delete sel['sel-lut'];
  const stamp = p.id + '|' + S.lookFx + '|' + JSON.stringify([r.sliders, sel]);
  if (!swSrc || swSrc.id !== p.id) swSrc = { id: p.id, canvas: shrink(p.thumb, SWATCH) };
  for (const L of lookEls) if (L.visible && !L.el.hidden && L.stamp !== stamp) renderSwatch(L, stamp, p, r);
}
async function renderSwatch(L, stamp, p, r) {
  L.stamp = stamp;
  const rec = { sliders: { ...r.sliders, 'lut-mix': 100 }, selects: { ...r.selects, 'sel-lut': L.value } };
  const d = S.lookFx && L.key ? engine.lookDefaults(L.key) : null;
  if (d) Object.assign(rec.sliders, { 'grain-a': Math.round(d.grain), 'hal-a': Math.round(d.halation), 'bloom-a': Math.round(d.bloom) });
  try {
    const out = await engine.render('sw:' + L.value, PRIO.SWATCH, swSrc.canvas, rec, p.isRaw, p.fullW);
    if (!out) { if (L.stamp === stamp) L.stamp = null; return; }
    if (L.stamp === stamp) blit(L.cv, out);
    out.width = out.height = 0;
  } catch (e) { L.stamp = null; }
}

// ── controls ───────────────────────────────────────────────────────────────────────────────
function buildRow(host, [id, label, fmt]) {
  const sp = specs[id] = engine.sliderSpec(id);
  if (!sp) return; // an engine without this control simply does not show it
  const el = document.createElement('div'); el.className = 'row';
  const lb = document.createElement('label'); lb.textContent = label; lb.htmlFor = 's-' + id;
  const input = document.createElement('input'); input.type = 'range'; input.id = 's-' + id;
  input.min = sp.min; input.max = sp.max; input.step = sp.step;
  const out = document.createElement('output'); out.htmlFor = input.id;
  el.append(lb, input, out);
  el.title = 'Double-click to reset';
  input.addEventListener('input', () => { edit([['sliders', id, parseFloat(input.value)]]); paintRow(id); });
  el.addEventListener('dblclick', () => { edit([['sliders', id, defOf(id)]]); paintRow(id); });
  host.appendChild(el);
  rows[id] = { el, input, out, fmt: fmt || ((v) => String(Math.round(v))) };
}
function paintRow(id) {
  const r = rows[id]; if (!r) return;
  const v = sliderVal(id);
  if (parseFloat(r.input.value) !== v) r.input.value = v;
  r.out.textContent = r.fmt(v);
  r.el.classList.toggle('mod', v !== defOf(id));
}
function buildControls() {
  for (const row of LOOK_ROWS) buildRow($('lookrows'), row);
  for (const sec of SECTIONS) {
    const s = document.createElement('div'); s.className = 'sec';
    const h = document.createElement('h2'); h.textContent = sec.title; s.appendChild(h);
    for (const row of sec.rows) buildRow(s, row);
    if (s.children.length > 1) $('sliders').appendChild(s);
  }
  buildLooks();
  const fill = (sel, opts) => { for (const o of opts) sel.add(new Option(o.name, o.value)); };
  fill($('x-fmt'), engine.selectOptions('sel-exp-fmt'));
  fill($('x-size'), engine.selectOptions('sel-exp-size'));
  fill($('x-sharp'), engine.selectOptions('sel-exp-sharp'));
  const canDir = typeof window.showDirectoryPicker === 'function';
  if (canDir) $('x-dest').add(new Option('A folder on this computer', 'folder'));
  $('x-dest').add(new Option('One ZIP download', 'zip'));
  S.exp.dest = canDir ? 'folder' : 'zip';
}
function refreshControls() {
  for (const id in rows) paintRow(id);
  const r = viewRecipe();
  const lut = r.selects['sel-lut'] || '';
  for (const L of lookEls) L.el.setAttribute('aria-pressed', L.value === lut ? 'true' : 'false');
  $('print').value = r.selects['sel-print'] || '';
  $('lookfx').checked = S.lookFx;
  $('scope-all').setAttribute('aria-pressed', S.scope === 'all' ? 'true' : 'false');
  $('scope-sel').setAttribute('aria-pressed', S.scope === 'sel' ? 'true' : 'false');
  refreshCounts(); refreshExport();
}
function refreshExport() {
  const x = S.exp;
  $('x-fmt').value = x.format; $('x-q').value = x.quality; $('x-qv').textContent = x.quality;
  $('x-size').value = x.size; $('x-sharp').value = x.sharpen; $('x-name').value = x.pattern; $('x-gps').checked = !!x.keepGps;
  if (![...$('x-dest').options].some((o) => o.value === x.dest)) x.dest = 'zip';
  $('x-dest').value = x.dest;
  $('x-qrow').hidden = x.format === 'png';
  const p = S.cur || { name: 'IMG_0001.jpg' };
  const ext = x.format === 'auto' ? 'jpg' : x.format;
  $('x-namehint').textContent = `Tokens: {name} {seq} {date} {look}. Example: ${buildBase(p, 0, Math.max(1, S.photos.length))}.${ext}`;
  $('x-desthint').textContent = x.dest === 'folder'
    ? 'Files are written straight into the folder. Existing files are never overwritten — a number is added instead.'
    : 'Everything is collected into one ZIP and downloaded at the end. Very large batches are split into parts.';
  $('x-pick').hidden = x.dest !== 'folder';
  $('destline').textContent = x.dest === 'folder' ? (S.dir ? `Saving to “${S.dir.name}”` : 'You will be asked for a folder') : 'Saving as a ZIP download';
}

// ── export ─────────────────────────────────────────────────────────────────────────────────
const stem = (name) => name.replace(/\.[^.]+$/, '');
function lookSlug(p) {
  const v = effective(p).selects['sel-lut'] || '';
  return v ? v.slice(2) : 'nolook';
}
function buildBase(p, i, total) {
  const pat = (S.exp.pattern || '').trim() || '{name}';
  const seq = String(i + 1).padStart(Math.max(3, String(total).length), '0');
  let base = pat.replace(/\{name\}/g, stem(p.name)).replace(/\{seq\}/g, seq)
    .replace(/\{date\}/g, new Date().toISOString().slice(0, 10)).replace(/\{look\}/g, lookSlug(p));
  if (!/\{name\}|\{seq\}/.test(pat)) base += '_' + seq; // a fixed name would collide on every photo
  return base.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^\.+/, '').trim() || stem(p.name);
}
function download(blob, name) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}
class FolderSink {
  constructor(dir) { this.dir = dir; this.used = new Set(); this.where = `“${dir.name}”`; }
  async exists(name) {
    try { await this.dir.getFileHandle(name); return true; } catch (e) {
      if (e.name === 'NotFoundError') return false;
      if (e.name === 'TypeMismatchError') return true; // a folder with that name
      throw e;
    }
  }
  async write(base, ext, bytes) {
    let name = `${base}.${ext}`, n = 1;
    while (this.used.has(name.toLowerCase()) || await this.exists(name)) name = `${base}_${++n}.${ext}`;
    this.used.add(name.toLowerCase());
    const h = await this.dir.getFileHandle(name, { create: true });
    const w = await h.createWritable();
    try { await w.write(bytes); await w.close(); } catch (e) { try { await w.abort(); } catch (_) {} throw e; }
    return name;
  }
  async close() {}
}
class ZipSink {
  constructor() {
    const d = new Date(), z = (n) => String(n).padStart(2, '0');
    this.stem = `chromasmith-batch-${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}`;
    this.used = new Set(); this.zip = new ZipWriter(); this.part = 0; this.where = 'your downloads';
  }
  async write(base, ext, bytes) {
    let name = `${base}.${ext}`, n = 1;
    while (this.used.has(name.toLowerCase())) name = `${base}_${++n}.${ext}`;
    this.used.add(name.toLowerCase());
    this.zip.add(name, bytes);
    if (this.zip.size > ZIP_SPLIT) this.flush(false);
    return name;
  }
  flush(last) {
    if (!this.zip.count) return;
    this.part++;
    download(this.zip.finish(), last && this.part === 1 ? `${this.stem}.zip` : `${this.stem}-part${this.part}.zip`);
    this.zip = new ZipWriter();
  }
  async close() { this.flush(true); }
}

async function pickDir() {
  try { S.dir = await window.showDirectoryPicker({ mode: 'readwrite', id: 'cs-batch-out' }); refreshExport(); return true; }
  catch (e) { if (e.name !== 'AbortError') toast('Could not open that folder: ' + e.message, true); return false; }
}

let cancelExport = false, lastFailed = [];
async function runExport(list) {
  if (S.busy) return;
  const unreadable = list.filter((p) => p.bad).length;
  list = list.filter((p) => !p.bad);
  if (!list.length) { toast(unreadable ? 'None of these photos could be opened, so there is nothing to export' : 'Nothing to export', true); return; }
  let sink;
  if (S.exp.dest === 'folder') {
    if (!S.dir && !(await pickDir())) return;
    try {
      const o = { mode: 'readwrite' };
      if ((await S.dir.queryPermission(o)) !== 'granted' && (await S.dir.requestPermission(o)) !== 'granted') { toast('Permission to write into that folder was not given', true); return; }
    } catch (e) { toast('Cannot write into that folder: ' + e.message, true); return; }
    sink = new FolderSink(S.dir);
  } else sink = new ZipSink();

  S.busy = true; cancelExport = false; lastFailed = [];
  const N = list.length, t0 = performance.now();
  const ui = { title: $('ovtitle'), sub: $('ovsub'), bar: $('ovbar'), num: $('ovnum'), eta: $('oveta'), fail: $('ovfail') };
  $('ovl').hidden = false; $('ovcancel').hidden = false; $('ovcancel').disabled = false; $('ovclose').hidden = true; $('ovretry').hidden = true;
  ui.fail.hidden = true; ui.fail.textContent = '';
  ui.title.textContent = `Exporting ${plural(N, 'photo')}`;
  $('ovcancel').focus();
  let wake = null; try { wake = await navigator.wakeLock.request('screen'); } catch (_) {}
  let done = 0, tried = 0, sinkErr = '';
  const prog = () => {
    ui.bar.style.width = (tried / N * 100) + '%';
    ui.num.textContent = `${tried} of ${N}`;
    const left = tried ? (performance.now() - t0) / tried * (N - tried) / 1000 : 0;
    ui.eta.textContent = !tried || tried === N ? '' : left < 60 ? `about ${Math.max(1, Math.round(left))} s left` : `about ${Math.round(left / 60)} min left`;
  };
  for (const p of list) { p.status = null; paintCell(p); }
  prog();
  for (let i = 0; i < N; i++) {
    if (cancelExport) break;
    const p = list[i];
    p.status = 'work'; p.err = ''; paintCell(p);
    ui.sub.textContent = p.name;
    try {
      const r = await engine.exportOne(p.file, effective(p), S.exp);
      p.outName = await sink.write(buildBase(p, i, N), r.ext, r.bytes);
      p.status = 'done'; done++;
    } catch (e) {
      p.status = 'fail'; p.err = (e && e.message) || String(e); lastFailed.push(p);
      console.error('export', p.name, e);
    }
    tried++; paintCell(p); prog();
  }
  try { await sink.close(); } catch (e) { sinkErr = (e && e.message) || String(e); }
  try { if (wake) await wake.release(); } catch (_) {}
  for (const p of list) if (p.status === 'work') { p.status = null; paintCell(p); }
  S.busy = false;
  const stopped = cancelExport && tried < N;
  ui.title.textContent = sinkErr ? 'Export could not be saved' : stopped ? 'Export cancelled' : lastFailed.length ? `Exported ${done} of ${N}` : `Exported ${plural(done, 'photo')}`;
  ui.sub.textContent = sinkErr || (done ? `Saved to ${sink.where}` : 'Nothing was saved') + (unreadable ? ` · ${plural(unreadable, 'unreadable photo')} skipped` : '');
  ui.eta.textContent = `${Math.round((performance.now() - t0) / 1000)} s`;
  if (lastFailed.length) {
    ui.fail.hidden = false;
    for (const p of lastFailed) { const d = document.createElement('div'); const b = document.createElement('b'); b.textContent = p.name; d.append(b, ' — ' + p.err); ui.fail.appendChild(d); }
    $('ovretry').hidden = false;
  }
  $('ovcancel').hidden = true; $('ovclose').hidden = false; $('ovclose').focus();
}

// ── wiring ─────────────────────────────────────────────────────────────────────────────────
async function filesFromDrop(dt) {
  const entries = [...dt.items].filter((i) => i.kind === 'file').map((i) => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null));
  const plain = [...dt.files];
  if (!entries.some((e) => e && e.isDirectory)) return plain;
  const out = [];
  const walk = async (e) => {
    if (e.isFile) out.push(await new Promise((res, rej) => e.file(res, rej)));
    else if (e.isDirectory) {
      const rd = e.createReader();
      for (;;) { const b = await new Promise((res, rej) => rd.readEntries(res, rej)); if (!b.length) break; for (const c of b) await walk(c); }
    }
  };
  for (const e of entries) if (e) await walk(e).catch(() => {});
  return out;
}

function wire() {
  const pickFiles = () => $('in-files').click(), pickFolder = () => $('in-folder').click();
  for (const id of ['add-files', 'w-files']) { $(id).addEventListener('click', pickFiles); $(id).disabled = false; }
  for (const id of ['add-folder', 'w-folder']) { $(id).addEventListener('click', pickFolder); $(id).disabled = false; }
  for (const id of ['in-files', 'in-folder']) $(id).addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });

  let depth = 0;
  const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); depth++; document.body.classList.add('dragging'); });
  addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  addEventListener('dragleave', (e) => { if (!hasFiles(e)) return; if (--depth <= 0) { depth = 0; document.body.classList.remove('dragging'); } });
  addEventListener('drop', async (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault(); depth = 0; document.body.classList.remove('dragging');
    if (S.busy) return;
    addFiles(await filesFromDrop(e.dataTransfer));
  });

  $('grid').addEventListener('click', (e) => {
    const el = e.target.closest('.cell'); if (!el) return;
    const p = S.photos.find((x) => x.id === el.dataset.id); if (p) clickCell(p, e);
  });
  $('sel-all').addEventListener('click', () => { S.sel = new Set(S.photos.map((p) => p.id)); paintSelection(); refreshControls(); });
  $('rm-sel').addEventListener('click', removeSelected);

  const setScope = (s) => { S.scope = s; refreshControls(); };
  $('scope-all').addEventListener('click', () => setScope('all'));
  $('scope-sel').addEventListener('click', () => setScope('sel'));
  $('reset').addEventListener('click', () => {
    if (S.scope === 'sel') { const t = selPhotos(); for (const p of t) { p.ov = null; paintCell(p); } touch(t); }
    else { S.base = { sliders: {}, selects: { 'sel-lut': '', 'sel-print': '' } }; touch(S.photos); save(); }
    refreshControls();
  });
  $('lookfx').addEventListener('change', (e) => { S.lookFx = e.target.checked; save(); scheduleSwatches(0); });

  const hold = $('hold-orig');
  hold.addEventListener('pointerdown', () => setOrig(true));
  for (const t of ['pointerup', 'pointerleave', 'pointercancel', 'blur']) hold.addEventListener(t, () => setOrig(false));

  addEventListener('keydown', (e) => {
    if (S.busy) { if (e.key === 'Escape' && !$('ovclose').hidden) $('ovclose').click(); return; }
    const t = e.target, typing = t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA');
    if (e.key === '\\' && !typing) { setOrig(true); return; }
    if (typing || !S.photos.length) return;
    const i = S.photos.indexOf(S.cur);
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      const n = S.photos[Math.max(0, Math.min(S.photos.length - 1, i + (e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1)))];
      if (n && n !== S.cur) { e.preventDefault(); clickCell(n, { shiftKey: e.shiftKey }); }
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a') { e.preventDefault(); $('sel-all').click(); }
    else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); removeSelected(); }
  });
  addEventListener('keyup', (e) => { if (e.key === '\\') setOrig(false); });

  const x = S.exp, bind = (id, key, evt = 'change', cast = (v) => v) => $(id).addEventListener(evt, (e) => {
    x[key] = cast(e.target.type === 'checkbox' ? e.target.checked : e.target.value); save(); refreshExport();
  });
  bind('x-fmt', 'format'); bind('x-q', 'quality', 'input', (v) => parseInt(v, 10)); bind('x-size', 'size'); bind('x-sharp', 'sharpen');
  bind('x-name', 'pattern', 'input'); bind('x-gps', 'keepGps'); bind('x-dest', 'dest');
  $('x-pick').addEventListener('click', pickDir);
  $('go-all').addEventListener('click', () => runExport(S.photos));
  $('go-sel').addEventListener('click', () => runExport(selPhotos()));
  $('ovcancel').addEventListener('click', () => { cancelExport = true; $('ovcancel').disabled = true; $('ovtitle').textContent = 'Stopping after this photo…'; });
  $('ovclose').addEventListener('click', () => { $('ovl').hidden = true; });
  $('ovretry').addEventListener('click', () => { const again = lastFailed.slice(); $('ovl').hidden = true; runExport(again); });
  addEventListener('beforeunload', (e) => { if (S.busy) { e.preventDefault(); e.returnValue = ''; } });
}

async function main() {
  // The engine frame can only be cross-origin isolated (needed for RAW) once this page is. The
  // isolation shim reloads the page once on a first visit — give it a moment before booting.
  if (!window.crossOriginIsolated && window.isSecureContext && 'serviceWorker' in navigator) {
    const t0 = performance.now();
    while (!navigator.serviceWorker.controller && performance.now() - t0 < 4000) await new Promise((r) => setTimeout(r, 50));
  }
  try { engine = await Engine.boot(); } catch (e) {
    $('bootmsg').hidden = true; $('booterr').hidden = false; $('booterr').textContent = (e && e.message) || String(e);
    return;
  }
  engine.copyFonts(document);
  buildControls(); load(); wire(); refreshControls(); refreshExport();
  $('bootmsg').textContent = 'JPEG, PNG, WebP, HEIC, TIFF and camera RAW. Photos never leave this computer.';
  window.__batch = { S, engine, addFiles, runExport }; // for the smoke test and the console
}
main();
