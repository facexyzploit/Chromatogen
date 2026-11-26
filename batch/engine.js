// Chromasmith Batch — engine bridge.
//
// The batch page does not copy the renderer. It hosts ONE hidden copy of the real app
// (chromasmith-22.html?csrender=1 — the render-only mode the desktop Library already uses for
// its edit previews) and drives it through the same functions the export harness uses:
// applyUISnapshot / getFXParams / processToCanvas for previews, exportFX({items}) for full-size
// output. Everything that reaches into the engine lives in this file, so an upstream rename
// breaks here (with a clear message at boot) and nowhere else.
//
// The engine has a single set of controls, so every call is serialised through one queue.

const FRAME_CSS = 'position:fixed;left:0;top:0;width:1280px;height:800px;border:0;opacity:0;pointer-events:none;z-index:-1';
const REQUIRED = ['getUISnapshot', 'applyUISnapshot', 'loadFXImages', 'processToCanvas', 'getFXParams',
  'geomCanvas', 'exportFX', 'saveFiles', 'defGeom', 'groupedLutKeys', 'prettyLUT'];
const READY = 'typeof _fxPristineDefault!=="undefined"&&!!_fxPristineDefault&&typeof FX!=="undefined"&&!!FX'
  + '&&!!document.getElementById("sel-lut")&&document.getElementById("sel-lut").options.length>1';

export const PRIO = { EXPORT: 0, PREVIEW: 1, THUMB: 2, SWATCH: 3 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Engine {
  constructor(frame) {
    this.frame = frame;
    this.w = frame.contentWindow;
    this._tasks = new Map(); // key -> task (a newer task with the same key replaces a pending one)
    this._seq = 0;
    this._running = false;
    this._applied = null;
    this._captured = null;
    this.lastLog = '';
  }

  static async boot(src = 'chromasmith-22.html?csrender=1', timeoutMs = 45000) {
    const f = document.createElement('iframe');
    f.setAttribute('aria-hidden', 'true'); f.tabIndex = -1; f.title = 'Chromasmith render engine';
    f.style.cssText = FRAME_CSS;
    f.src = src;
    document.body.appendChild(f);
    const t0 = performance.now();
    for (;;) {
      let ok = false;
      try { ok = !!f.contentWindow.eval(READY); } catch (_) { /* script not parsed yet */ }
      if (ok) break;
      if (performance.now() - t0 > timeoutMs) { f.remove(); throw new Error('The render engine did not start (chromasmith-22.html failed to load).'); }
      await sleep(40);
    }
    const eng = new Engine(f);
    eng._init();
    return eng;
  }

  _ev(code) { return this.w.eval(code); }

  _init() {
    const w = this.w;
    const missing = REQUIRED.filter((n) => typeof w[n] !== 'function');
    if (missing.length) throw new Error('Engine API changed — missing: ' + missing.join(', '));
    if (!this._ev('FX.ok')) throw new Error('WebGL2 is not available in this browser, so the film engine cannot render.');
    this._lockHistory();
    this.pristine = JSON.parse(JSON.stringify(this._ev('_fxPristineDefault')));
    // Output never goes through the engine's own download path: exportFX hands the encoded file
    // to saveFiles(), which is replaced here so the batch page decides where it is written.
    w.saveFiles = async (items) => { this._captured = (this._captured || []).concat(items); return null; };
    // exportFX awaits a frame before the heavy GL work. A hidden tab gets no frames, which would
    // stall a long batch the moment the user looks at something else — fall back to a timer there.
    const raf = w.requestAnimationFrame.bind(w);
    w.requestAnimationFrame = (cb) => (document.hidden ? w.setTimeout(() => cb(w.performance.now()), 16) : raf(cb));
    // Keep the engine's last warning/error so a failed photo can say why.
    if (typeof w.log === 'function') {
      const log = w.log;
      w.log = (m, t) => { if (t === 'err' || t === 'warn') this.lastLog = String(m); return log(m, t); };
    }
    this.imgRe = this._ev('typeof IMG_EXT_RE!=="undefined"?IMG_EXT_RE:null') || /\.(png|jpe?g|gif|webp|avif|bmp|heic|heif)$/i;
    this.rawRe = this._ev('typeof RAW_FILE_EXT_RE!=="undefined"?RAW_FILE_EXT_RE:null') || /\.(dng|rw2|arw|cr2|cr3|nef|raf|orf)$/i;
  }

  _lockHistory() { try { this._ev('_fxHistLocked=true'); } catch (_) {} }

  // ── catalogue ────────────────────────────────────────────────────────────────────────────
  looks() {
    const w = this.w;
    return w.groupedLutKeys().map(([cat, keys]) => ({ cat, looks: keys.map((k) => ({ key: k, value: 'p:' + k, name: w.prettyLUT(k) })) }));
  }
  prints() {
    const keys = this._ev('typeof PRINT_PRESETS!=="undefined"?Object.keys(PRINT_PRESETS):[]');
    return keys.map((k) => ({ value: k, name: this.w.prettyLUT(k) }));
  }
  // Calibrated grain/halation/bloom starting point a look ships with (same table the editor applies
  // the first time a look is picked), or null.
  lookDefaults(key) {
    const d = this._ev('typeof LUT_FX_DEFAULTS!=="undefined"?LUT_FX_DEFAULTS:{}')[key];
    return d ? { grain: d.grain, halation: d.halation, bloom: d.bloom } : null;
  }
  sliderSpec(id) {
    const el = this.w.document.getElementById('sl-' + id);
    if (!el) return null;
    return { min: parseFloat(el.min), max: parseFloat(el.max), step: parseFloat(el.step) || 1, def: parseFloat(this.pristine.sliders[id]) };
  }
  selectOptions(id) {
    const el = this.w.document.getElementById(id);
    return el && el.options ? [...el.options].map((o) => ({ value: o.value, name: o.textContent.trim() })) : [];
  }
  accepts(name) { return this.imgRe.test(name) || this.rawRe.test(name) || /\.tiff?$/i.test(name); }
  isRaw(name) { return this.rawRe.test(name); }

  // The app's typeface is embedded in the engine page; reuse it instead of shipping a second copy.
  copyFonts(doc) {
    try {
      let css = '';
      for (const sheet of this.w.document.styleSheets) {
        let rules; try { rules = sheet.cssRules; } catch (_) { continue; }
        for (const r of rules) if (r.type === 5 /* FONT_FACE_RULE */) css += r.cssText + '\n';
      }
      if (!css) return;
      const st = doc.createElement('style'); st.textContent = css; doc.head.appendChild(st);
    } catch (_) {}
  }

  // ── queue ────────────────────────────────────────────────────────────────────────────────
  // run(key, prio, fn): lowest prio number first, FIFO within a priority. A pending task with the
  // same key is superseded (its promise resolves to undefined) — that is how a slider drag keeps
  // only the latest preview render alive.
  run(key, prio, fn) {
    return new Promise((resolve, reject) => {
      const old = this._tasks.get(key);
      if (old) old.resolve(undefined);
      this._tasks.set(key, { key, prio, fn, resolve, reject, seq: this._seq++ });
      this._pump();
    });
  }
  cancel(prefix) {
    for (const [k, t] of this._tasks) if (k.startsWith(prefix)) { this._tasks.delete(k); t.resolve(undefined); }
  }
  async _pump() {
    if (this._running) return;
    this._running = true;
    try {
      while (this._tasks.size) {
        let best = null;
        for (const t of this._tasks.values()) if (!best || t.prio < best.prio || (t.prio === best.prio && t.seq < best.seq)) best = t;
        this._tasks.delete(best.key);
        try { best.resolve(await best.fn()); } catch (e) { best.reject(e); }
        if (best.prio > PRIO.PREVIEW) await sleep(0); // let input events in between background renders
      }
    } finally { this._running = false; }
  }

  // ── recipes ──────────────────────────────────────────────────────────────────────────────
  // A recipe is { sliders:{id:value}, selects:{id:value} } in the engine's own snapshot vocabulary,
  // holding only what differs from factory defaults. Section switches are derived: an amount of 0
  // means that effect is off.
  toSnapshot(recipe) {
    const s = JSON.parse(JSON.stringify(this.pristine));
    const sl = (recipe && recipe.sliders) || {}, se = (recipe && recipe.selects) || {};
    for (const k in sl) s.sliders[k] = String(sl[k]);
    for (const k in se) s.selects[k] = se[k];
    // Read the amounts from the recipe, not the snapshot: the factory snapshot carries non-zero
    // grain/halation/bloom amounts behind switched-off sections.
    const n = (id) => parseFloat(sl[id]) || 0;
    s.toggles.adjust = Object.keys(sl).some((k) => k.startsWith('adj-') && parseFloat(sl[k]) !== parseFloat(this.pristine.sliders[k]));
    s.toggles.grain = n('grain-a') > 0;
    s.toggles.hal = n('hal-a') > 0;
    s.toggles.bloom = n('bloom-a') > 0;
    s.toggles.vig = n('vig') > 0;
    return s;
  }

  async _apply(recipe, isRaw) {
    const snap = this.toSnapshot(recipe);
    const key = JSON.stringify(snap) + (isRaw ? '|raw' : '');
    if (key === this._applied) return;
    this._applied = null;
    this._lockHistory();
    const w = this.w;
    await w.applyUISnapshot(snap, { skipRender: true, noRawReload: true });
    if (isRaw && typeof w.applyRawDefaults === 'function') w.applyRawDefaults();
    // applyUISnapshot resolves with the look's load, but a failed fetch only logs — confirm.
    const want = snap.selects['sel-lut'] || '', wantPrint = snap.selects['sel-print'] || '';
    const t0 = performance.now();
    while ((want ? !this._ev('fxState.lut') : !!this._ev('fxState.lut')) && performance.now() - t0 < 8000) await sleep(20);
    if (want && !this._ev('fxState.lut')) throw new Error('Look could not be loaded: ' + want.slice(2));
    if (wantPrint && this._ev('fxState.print') !== wantPrint) throw new Error('Print profile could not be loaded: ' + wantPrint);
    this._applied = key;
  }

  // ── decode / render ──────────────────────────────────────────────────────────────────────
  _file(file) { // the engine tests its own realm's File/Blob, so hand it one (no byte copy)
    return new this.w.File([file], file.name, { type: file.type, lastModified: file.lastModified });
  }
  async _decode(file) {
    const entries = await this.w.loadFXImages([this._file(file)], { privateEntries: true });
    if (!entries || !entries[0] || !entries[0].img) throw new Error(this.lastLog || 'could not decode ' + file.name);
    return entries[0];
  }
  static _release(img) { if (img && img.tagName === 'CANVAS') { img._rgbaSrc = null; img.width = img.height = 0; } }

  // Decode with the engine (RAW, TIFF, HEIC — anything the browser cannot open itself) and return
  // a canvas no larger than `longEdge`. Only used when createImageBitmap is not enough.
  decodeProxy(file, longEdge, prio = PRIO.THUMB, key = 'decode:' + file.name) {
    return this.run(key, prio, async () => {
      const it = await this._decode(file);
      const src = it.img, iw = src.naturalWidth || src.width, ih = src.naturalHeight || src.height;
      const k = Math.min(1, longEdge / Math.max(iw, ih));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(iw * k)); c.height = Math.max(1, Math.round(ih * k));
      const g = c.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(src, 0, 0, c.width, c.height);
      Engine._release(src);
      return { canvas: c, fullW: iw, fullH: ih };
    });
  }

  // Grade a (small) source canvas with a recipe, as the full-size export will look at this size.
  // `fullW` is the width the export renders at: the renderer uses it (opts.truncRefW, the same
  // option the editor's fit-to-screen preview passes) to lay grain out on the export's cell grid
  // and attenuate it the way downscaling would, and to match the glow kernel. Without it a proxy
  // shows grain several times coarser and stronger than the exported file.
  render(key, prio, src, recipe, isRaw, fullW) {
    return this.run(key, prio, async () => {
      await this._apply(recipe, isRaw);
      const w = this.w, iw = src.width, ih = src.height;
      const P = w.getFXParams(); P.redEyeOps = [];
      const FX = this._ev('FX');
      if (typeof FX.setImage !== 'function' || typeof FX.render !== 'function' || !FX.cv) return await w.processToCanvas(P, src, iw, ih, () => {});
      const prev = FX._maskReferenceSize; FX._maskReferenceSize = { w: iw, h: ih };
      try {
        if (typeof w.fxDrcApplyFor === 'function') await w.fxDrcApplyFor(FX, P, src);
        FX.setImage(src);
        FX.render(P, iw, ih, { glowScale: typeof w.fxGlowScale === 'function' ? w.fxGlowScale() : 1, truncRefW: fullW > iw ? fullW : 0 });
        // Copy out in the same task as the draw, while the GL back buffer is still valid.
        const c = document.createElement('canvas'); c.width = iw; c.height = ih;
        c.getContext('2d').drawImage(FX.cv, 0, 0, iw, ih);
        return c;
      } finally { FX._maskReferenceSize = prev; }
    });
  }

  // Full-resolution export of one file through the engine's real export path (RAW promotion,
  // tiling, borders, resize + output sharpening, metadata carry-over). Resolves to
  // { bytes: Uint8Array, ext, mime }.
  exportOne(file, recipe, out) {
    return this.run('export:' + this._seq, PRIO.EXPORT, async () => {
      const w = this.w, d = w.document, isRaw = this.isRaw(file.name);
      await this._apply(recipe, isRaw);
      const set = (id, v) => { const el = d.getElementById(id); if (el) el.value = String(v); };
      set('sel-exp-fmt', out.format); set('sl-exp-q', out.quality); set('sel-exp-size', out.size); set('sel-exp-sharp', out.sharpen);
      const gps = d.getElementById('tg-exp-gps'); if (gps) gps.checked = !!out.keepGps;
      let ext = (file.name.split('.').pop() || '').toLowerCase(); if (ext === 'jpeg') ext = 'jpg'; if (ext === 'tiff') ext = 'tif';
      const stub = d.createElement('canvas'); stub.width = stub.height = 1;
      const item = { img: stub, name: file.name.replace(/\.[^.]+$/, ''), ext, dpi: 240, bytes: null, geom: w.defGeom() };
      item._exportLoad = async () => ({ ...(await this._decode(file)), geom: item.geom });
      this._captured = null; this.lastLog = ''; w._expFail = [];
      this._lockHistory();
      try { await w.exportFX({ items: [item] }); } finally { this._applied = null; } // the export path may move controls
      const got = this._captured && this._captured[0];
      this._captured = null;
      if (!got) {
        const f = (w._expFail || [])[0];
        throw new Error((f && f.err) || this.lastLog || 'render failed');
      }
      const bytes = got.content instanceof Uint8Array ? got.content : new Uint8Array(got.content);
      return { bytes, ext: (got.fname.split('.').pop() || 'jpg').toLowerCase(), mime: got.mime };
    });
  }
}
