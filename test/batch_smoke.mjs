#!/usr/bin/env node
// Smoke test for the batch page (batch.html): load three fixtures, pick a look, move a slider,
// give one photo its own setting, export everything as a ZIP and check the archive.
//   node test/batch_smoke.mjs            CHROMASMITH_CHROME=/path/to/chrome to pick a browser,
//                                        BATCH_SHOT=/path/out.png to keep a screenshot.
const { chromium } = await import(process.env.CHROMASMITH_PLAYWRIGHT_MODULE || 'playwright');
import { createServer } from 'node:http';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm', '.png': 'image/png' };
const server = createServer(async (req, res) => {
  try {
    const file = path.resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname));
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin'); res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    res.setHeader('Content-Type', TYPES[path.extname(file)] || 'application/octet-stream');
    res.end(await readFile(file));
  } catch { res.writeHead(404).end('nf'); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));

const fails = [];
const check = (ok, what, detail = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? ' — ' + detail : ''}`); if (!ok) fails.push(what); };
const browser = await chromium.launch({
  executablePath: process.env.CHROMASMITH_CHROME || undefined,
  args: ['--use-gl=swiftshader', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const out = await mkdtemp(path.join(tmpdir(), 'cs-batch-'));
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|404/.test(m.text())) errors.push(m.text()); });
  await page.goto(`http://127.0.0.1:${server.address().port}/batch.html`);
  await page.waitForFunction(() => window.__batch, null, { timeout: 60000 });
  check(true, 'engine booted');
  check(await page.evaluate(() => window.__batch.engine.looks().reduce((n, g) => n + g.looks.length, 0)) > 100, 'look catalogue loaded');

  const fx = (n) => path.join(root, 'test/fixtures', n);
  await page.setInputFiles('#in-files', [fx('portrait.png'), fx('chart.png'), fx('gradient.png')]);
  await page.waitForFunction(() => { const s = window.__batch.S; return s.photos.length === 3 && s.photos.every((p) => p.thumb && !p.dirty); }, null, { timeout: 30000 });
  check(await page.evaluate(() => window.__batch.S.photos.map((p) => p.name).join()) === 'chart.png,gradient.png,portrait.png', 'three photos added in name order');

  // Mean colour of a canvas, sampled on a coarse grid.
  const mean = (sel) => page.evaluate((sel) => {
    const c = typeof sel === 'string' ? document.querySelector(sel) : window.__batch.S.photos[sel].cv;
    const g = document.createElement('canvas'); g.width = 32; g.height = 32;
    const x = g.getContext('2d', { willReadFrequently: true }); x.drawImage(c, 0, 0, 32, 32);
    const d = x.getImageData(0, 0, 32, 32).data; const s = [0, 0, 0, 0];
    for (let i = 0; i < d.length; i += 4) { s[0] += d[i]; s[1] += d[i + 1]; s[2] += d[i + 2]; s[3] += Math.max(d[i], d[i + 1], d[i + 2]) - Math.min(d[i], d[i + 1], d[i + 2]); }
    return s.map((v) => v / (d.length / 4));
  }, sel);
  const dist = (a, b) => Math.max(...[0, 1, 2].map((i) => Math.abs(a[i] - b[i])));
  const settle = async (sel, before, what) => {
    const t0 = Date.now(); let now = before;
    while (Date.now() - t0 < 15000) { now = await mean(sel); if (dist(now, before) > 1.5) break; await page.waitForTimeout(100); }
    check(dist(now, before) > 1.5, what, `max channel change ${dist(now, before).toFixed(1)}`);
    return now;
  };

  await page.waitForFunction(() => document.querySelector('#pvc').width > 2, null, { timeout: 15000 });
  await page.waitForTimeout(400);
  let pv = await mean('#pvc');
  const thumb0 = await mean(1);

  await page.locator('.look', { hasText: /portra/i }).first().click();
  pv = await settle('#pvc', pv, 'picking a look changes the preview');
  await settle(1, thumb0, 'picking a look regrades the other thumbnails');
  const afterLook = await page.evaluate(() => window.__batch.S.base);
  check(/^p:.*portra/.test(afterLook.selects['sel-lut']), 'look stored in the batch recipe', afterLook.selects['sel-lut']);

  await page.evaluate(() => { const i = document.getElementById('s-adj-exp'); i.value = 40; i.dispatchEvent(new Event('input', { bubbles: true })); });
  const brighter = await settle('#pvc', pv, 'exposure slider changes the preview');
  check(brighter[1] > pv[1], 'more exposure is brighter');

  await page.waitForFunction(() => [...document.querySelectorAll('.look .sw canvas')].filter((c) => c.width > 3).length >= 3, null, { timeout: 20000 })
    .then(() => check(true, 'look swatches render from the current photo'), () => check(false, 'look swatches render from the current photo'));

  // One photo gets its own setting; the others keep the batch recipe.
  await page.locator('.cell').nth(2).click();
  await page.click('#scope-sel');
  await page.evaluate(() => { const i = document.getElementById('s-adj-sat'); i.value = -100; i.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.waitForFunction(() => { const s = window.__batch.S; return s.photos.every((p) => !p.dirty); }, null, { timeout: 15000 });
  await page.waitForTimeout(600);
  const own = await page.evaluate(() => window.__batch.S.photos.map((p) => !!p.ov));
  check(own.join() === 'false,false,true', 'override lands only on the selected photo', own.join());
  const sat = [await mean(0), await mean(2)];
  check(sat[1][3] < 3 && sat[0][3] > 8, 'the overridden photo is desaturated, the others are not', `spread ${sat[0][3].toFixed(1)} vs ${sat[1][3].toFixed(1)}`);

  // Export all three as a ZIP.
  await page.selectOption('#x-dest', 'zip');
  await page.selectOption('#x-fmt', 'jpg');
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 120000 }), page.click('#go-all')]);
  const zip = path.join(out, 'batch.zip');
  await dl.saveAs(zip);
  await page.waitForFunction(() => !document.getElementById('ovclose').hidden, null, { timeout: 30000 });
  check(/Exported 3 photos/.test(await page.textContent('#ovtitle')), 'export reports three photos', await page.textContent('#ovtitle'));
  let listing = '';
  try { execFileSync('unzip', ['-tq', zip]); listing = execFileSync('unzip', ['-Z1', zip]).toString().trim(); check(true, 'ZIP passes an integrity test'); }
  catch (e) { check(false, 'ZIP passes an integrity test', String(e.message).slice(0, 120)); }
  check(listing.split('\n').sort().join() === 'chart_edit.jpg,gradient_edit.jpg,portrait_edit.jpg', 'ZIP holds one named JPEG per photo', listing.replace(/\n/g, ', '));
  execFileSync('unzip', ['-oq', zip, '-d', out]);
  const jpg = await readFile(path.join(out, 'portrait_edit.jpg'));
  check(jpg[0] === 0xff && jpg[1] === 0xd8 && jpg[jpg.length - 2] === 0xff && jpg[jpg.length - 1] === 0xd9, 'exported file is a complete JPEG', `${jpg.length} bytes`);
  check((await page.evaluate(() => window.__batch.S.photos.map((p) => p.status).join())) === 'done,done,done', 'every photo marked exported');

  await page.click('#ovclose');

  // Folder export must never overwrite: aim it at a folder (the origin-private one stands in for a
  // picked folder — same handle API) that already holds a file with the name the export wants.
  if (await page.evaluate(() => !!(navigator.storage && navigator.storage.getDirectory && window.showDirectoryPicker))) {
    const names = await page.evaluate(async () => {
      const { S, runExport } = window.__batch;
      const dir = await navigator.storage.getDirectory();
      for await (const k of dir.keys()) await dir.removeEntry(k, { recursive: true });
      const h = await dir.getFileHandle('chart_edit.jpg', { create: true });
      const w = await h.createWritable(); await w.write(new Uint8Array([1, 2, 3])); await w.close();
      S.dir = dir; S.exp.dest = 'folder';
      await runExport(S.photos);
      const out = {};
      for await (const [k, fh] of dir.entries()) out[k] = (await fh.getFile()).size;
      return out;
    });
    check(names['chart_edit.jpg'] === 3, 'an existing file in the folder is left untouched', JSON.stringify(names));
    check(names['chart_edit_2.jpg'] > 1000 && names['gradient_edit.jpg'] > 1000 && names['portrait_edit.jpg'] > 1000, 'folder export writes every photo under a free name');
    await page.click('#ovclose');
  } else console.log('skip folder export (no File System Access API in this browser)');

  // Hold-for-original shows the unedited frame; removing a photo updates the batch.
  await page.locator('.cell').nth(1).click();
  await page.waitForTimeout(800);
  const graded = await mean('#pvc');
  await page.keyboard.down('\\');
  await settle('#pvc', graded, 'holding \\ shows the original');
  await page.keyboard.up('\\');
  await page.click('#rm-sel');
  check(await page.evaluate(() => window.__batch.S.photos.length) === 2 && await page.locator('.cell').count() === 2, 'removing a photo drops it from the batch');

  if (process.env.BATCH_SHOT) { await page.waitForTimeout(1500); await page.screenshot({ path: process.env.BATCH_SHOT }); }
  check(errors.length === 0, 'no page errors', errors.slice(0, 3).join(' | ').slice(0, 300));
} catch (e) {
  check(false, 'run completed', String(e && e.message || e).slice(0, 400));
} finally { await browser.close(); server.close(); await rm(out, { recursive: true, force: true }); }
console.log(fails.length ? `FAIL (${fails.length})` : 'PASS');
process.exit(fails.length ? 1 : 0);
