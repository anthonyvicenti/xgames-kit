// verify measure 9 (gate B): the contact sheet and the frame cost, on the real GPU, for a three runtime game (standard-3d
// and scenic-3d; a flat game has its own sheet, tools/lib/flat-sheet.mjs; forge its own, runtimes/forge/lookdev).
//
//   node builder/tools/lib/sheet-check.mjs <game-dir> [--out <dir>] [--quick] [--query "bots=3&seed=7&gf-autoplay=1&gf-ui=0"]
//
// Brought over from games.fun's research/gf-three/lookdev/capture.mjs (2026-10-13; its game mode, which verify called;
// the lookdev bench stays there as history). It ships here, beside verify, and finds everything from its own place, so
// it runs from any game folder: before, verify looked for runtimes/three/lookdev/capture.mjs, which this repository
// never had, and measure 9 was skipped in the first real build ("its capture tool is not in this checkout").
//
// Shots: the kit's cameras hero, four, wide and action (kit/look/shots.js through window.__gfLook.shot), at 1920×1080
// and 390×844 (--quick: 1920×1080 only), each frozen while it is taken, written as raw/game--game--day--<shot>--<w>x<h>.jpg
// (the names measure 23 reads), with sheet.jpg beside them. A page that renders on a software GPU is refused.
//
// The frame cost, judged so that a verdict depends on the game and not on how busy the machine is (2026-10-13: gates
// that failed only while another verify shared the GPU):
//   - what a frame asks of the GPU, at 1920×1080 on the high tier: draw calls ≤ CALLS and triangles ≤ TRIANGLES. These
//     are the game's own numbers; no load changes them.
//   - the frame rate, measured against a calibration page in the same browser at the same moment (a canvas that draws
//     almost nothing; tools/lib/sheet-check.mjs CALIBRATE): the game must keep HIGH_RATIO of the calibration's frame
//     rate on the high tier, and LOW_RATIO of it on the low tier under a THROTTLE× CPU throttle (where the old tool
//     asked 58 fps and 30 fps flat, which a busy machine failed on any game). Each is measured up to twice, game then
//     calibration, and the better pair counts: a moment of load that slows one and not the other is not the game's.
//   The frame rates themselves are in the record, always.
import { isMain } from './main.mjs';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { launchChrome, GPU_TROUBLE } from '../../qa/browser.mjs';
import { startParty } from '../../multiplayer/party/lib.mjs';
import { kitEditsOverlay } from './kit-check.mjs';
import { launchForGame } from './paths.mjs';

export const SHEET_LIMITS = { CALLS: 1500, TRIANGLES: 4e6, HIGH_RATIO: 0.85, LOW_RATIO: 0.45, THROTTLE: 4, PERF_MS: 3000, TRIES: 2 };
const SHOTS = ['hero', 'four', 'wide', 'action'];
const OPTIONAL = /favicon/;
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** The calibration page: a full-window WebGL2 canvas that clears and draws one triangle a frame, timed as __gfLook.perf times. */
export const CALIBRATE = `<!doctype html><meta charset="utf-8"><title>calibration</title><style>html,body{margin:0;height:100%;background:#000}canvas{display:block;width:100vw;height:100vh}</style>
<canvas id="c"></canvas><script>
const c = document.getElementById('c'); c.width = innerWidth; c.height = innerHeight;
const gl = c.getContext('webgl2');
const sh = (t, s) => { const o = gl.createShader(t); gl.shaderSource(o, s); gl.compileShader(o); return o; };
const p = gl.createProgram();
gl.attachShader(p, sh(gl.VERTEX_SHADER, '#version 300 es\\nin vec2 a; void main(){ gl_Position = vec4(a, 0., 1.); }'));
gl.attachShader(p, sh(gl.FRAGMENT_SHADER, '#version 300 es\\nprecision mediump float; out vec4 o; uniform float t; void main(){ o = vec4(fract(t), .3, .5, 1.); }'));
gl.linkProgram(p); gl.useProgram(p);
const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
const u = gl.getUniformLocation(p, 't');
const draw = now => { gl.uniform1f(u, now / 1000); gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT); gl.drawArrays(gl.TRIANGLES, 0, 3); requestAnimationFrame(draw); };
requestAnimationFrame(draw);
window.__cal = { perf: ms => new Promise(done => { const gaps = []; let last = null; const t0 = performance.now();
  const tick = now => { if (last !== null) gaps.push(now - last); last = now; if (now - t0 < ms) requestAnimationFrame(tick); else { const mean = gaps.reduce((a, x) => a + x, 0) / Math.max(1, gaps.length); done({ fps: +(1000 / mean).toFixed(1), frames: gaps.length }); } };
  requestAnimationFrame(tick); }) };
</script>`;

/** The verdict from the measurements (pure). m: {problems, coverage: [{untagged}], perf: [{quality, fps, cal, ratio, calls, triangles}], shots} */
export function judgeSheet(m, L = SHEET_LIMITS) {
  const fails = [...m.problems];
  if (!m.shots) fails.push('no shot was taken');
  for (const c of m.coverage) if (c.untagged?.length) fails.push(`untagged meshes in the ${c.size} shots: ${c.untagged.slice(0, 4).map(u => u.path ?? u.name).join(', ')}`);
  const hi = m.perf.find(r => r.quality === 'high'), lo = m.perf.find(r => r.quality === 'low');
  if (hi) {
    if (hi.calls > L.CALLS) fails.push(`${hi.calls} draw calls a frame at 1920×1080 on the high tier (at most ${L.CALLS})`);
    if (hi.triangles > L.TRIANGLES) fails.push(`${Math.round(hi.triangles / 1000)}k triangles a frame on the high tier (at most ${L.TRIANGLES / 1e6}M)`);
    if (hi.ratio < L.HIGH_RATIO) fails.push(`${hi.fps} fps on the high tier against ${hi.cal} fps for the calibration page beside it (${Math.round(hi.ratio * 100)}%; needs ${Math.round(L.HIGH_RATIO * 100)}%)`);
  }
  if (lo && lo.ratio < L.LOW_RATIO) fails.push(`${lo.fps} fps on the low tier under a ${L.THROTTLE}× CPU throttle against ${lo.cal} fps for the calibration page (${Math.round(lo.ratio * 100)}%; needs ${Math.round(L.LOW_RATIO * 100)}%)`);
  return { ok: fails.length === 0, fails };
}

/**
 * Measure 9 for one game. → {ok, detail, record} (the record is <out>/capture.json too). `launch`: a function that
 * returns {browser, gpu} (verify's launchForGame); `log` a progress line.
 */
export async function captureSheet({ dir, outDir, quick = false, query = 'bots=3&seed=7&gf-autoplay=1&gf-ui=0', log = () => {}, L = SHEET_LIMITS } = {}) {
  dir = resolve(dir); outDir = resolve(outDir);
  // the kit's capture hook (window.__gfLook) is in every three game's kit copy; a game without it is an older copy
  if (!['gf/three/look/capture-api.js', 'gf/scenic/look/capture-api.js'].some(f => existsSync(join(dir, f)))) throw new Error('the game\'s kit copy has no capture hook (gf/three/look/capture-api.js)');
  await mkdir(join(outDir, 'raw'), { recursive: true });
  const t0 = Date.now(), problems = [];
  const record = { tool: 'builder/tools/lib/sheet-check.mjs', game: basename(dir), started: new Date().toISOString(), quick, limits: L, shots: [], perf: [], coverage: [], gpu: null, problems };
  const overlay = (await kitEditsOverlay(dir)) ?? new Map();
  overlay.set('__gf-calibrate.html', Buffer.from(CALIBRATE));
  const srv = await startParty({ dir, port: 0, overlay });
  const { browser, gpu } = await launchForGame(launchChrome, dir);
  record.renderer = gpu; record.chrome = browser.version();
  const sizes = quick ? [[1920, 1080]] : [[1920, 1080], [390, 844]];
  const url = quality => `${srv.url}?quality=${quality}&${query}`;
  const frames = (page, n) => page.evaluate(n => new Promise(ok => { let k = 0; const f = () => (++k >= n ? ok() : requestAnimationFrame(f)); requestAnimationFrame(f); }), n);
  async function open(address, [w, h], { throttle = 1, game = true } = {}) {
    const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
    const errors = [];
    page.on('pageerror', e => errors.push(String(e.message ?? e)));
    page.on('console', m => { if (m.type() === 'error' && !/^Failed to load resource/.test(m.text())) errors.push(m.text()); });
    page.on('response', r => { if (r.status() >= 400 && !OPTIONAL.test(r.url())) errors.push(`HTTP ${r.status()} ${r.url()}`); });
    if (throttle > 1) { const cdp = await page.context().newCDPSession(page); await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle }); }
    await page.goto(address, { waitUntil: 'load' });
    if (!game) { await page.waitForFunction(() => !!window.__cal, null, { timeout: 30000 }); return { page, errors }; }
    // ?gf-autoplay=1 starts the round by itself; a game still in its lobby gets the lobby's start key
    const ready = '!!window.__gfLook && !!window.__game && ["playing", "show"].includes(window.__game.phase)';
    if (!(await page.waitForFunction(ready, null, { timeout: 15000 }).then(() => true, () => false))) await page.keyboard.press('Enter').catch(() => {});
    await page.waitForFunction(ready, null, { timeout: throttle > 1 ? 180000 : 90000 }).catch(e => { throw new Error(`the game never got to play (${errors.slice(0, 2).join(' | ') || e.message})`); });
    const info = await page.evaluate(() => window.__gfLook.info());
    if (/swiftshader|llvmpipe|software/i.test(info.gpu ?? '')) throw new Error(`rendering on a software GPU (${info.gpu}): looks and frame cost are not judged from it`);
    record.gpu ??= info.gpu;
    return { page, errors, info };
  }
  try {
    // ---- the shots ----
    for (const size of sizes) {
      const tag = `${size[0]}x${size[1]}`;
      let p = null;
      try {
        p = await open(url('high'), size);
        await frames(p.page, 20);
        for (const shot of SHOTS) {
          let r = await p.page.evaluate(s => window.__gfLook.shot(s), shot);
          // the hero is a player standing up: wait (a little) for someone knocked down to get up
          for (let k = 0; shot === 'hero' && r?.subjects && r.down >= r.subjects && k < 32; k++) { await sleep(250); r = await p.page.evaluate(s => window.__gfLook.shot(s), shot); }
          await sleep(700);
          await p.page.evaluate(s => window.__gfLook.shot(s), shot);     // the game kept moving: frame it again where everyone is now
          await p.page.evaluate(() => window.__gfLook.freeze(true));
          await frames(p.page, 3);
          const file = join('raw', `game--game--day--${shot}--${tag}.jpg`);
          await p.page.screenshot({ path: join(outDir, file), type: 'jpeg', quality: 88 });
          await p.page.evaluate(() => window.__gfLook.freeze(false));
          record.shots.push({ shot, size: tag, file });
        }
        const cov = await p.page.evaluate(() => window.__gfLook.coverage());
        record.coverage.push({ size: tag, meshes: cov.meshes, tagged: cov.tagged, untagged: cov.untagged ?? [] });
        const errs = p.errors.filter(e => !OPTIONAL.test(e));
        if (errs.length) problems.push(`console errors at ${tag}: ${[...new Set(errs)].slice(0, 3).join(' | ')}`);
        if (errs.some(e => GPU_TROUBLE.test(e))) problems.push('GPU trouble (context lost or a shader that did not compile)');
        log(`  sheet: ${SHOTS.length} shots at ${tag}`);
      } catch (e) { problems.push(`${tag}: ${e.message}`); }
      finally { await p?.page.close().catch(() => {}); }
    }
    // ---- the frame cost ----
    const perfRun = async (quality, throttle) => {
      let best = null;
      for (let i = 0; i < L.TRIES; i++) {
        const g = await open(url(quality), [1920, 1080], { throttle });
        let r;
        try { await frames(g.page, 30); await g.page.evaluate(() => window.__gfLook.shot('wide')); r = await g.page.evaluate(ms => window.__gfLook.perf(ms), L.PERF_MS); }
        finally { await g.page.close().catch(() => {}); }
        const c = await open(`${srv.url}__gf-calibrate.html`, [1920, 1080], { throttle, game: false });
        let cal;
        try { await frames(c.page, 30); cal = await c.page.evaluate(ms => window.__cal.perf(ms), L.PERF_MS); }
        finally { await c.page.close().catch(() => {}); }
        const row = { quality, throttle, size: '1920x1080', try: i + 1, fps: r.fps, p50: r.p50, p95: r.p95, renderCpuMs: r.renderCpuMs, calls: r.calls, triangles: r.triangles, cal: cal.fps, ratio: Math.round((r.fps / Math.max(1, cal.fps)) * 1000) / 1000 };
        if (!best || row.ratio > best.ratio) best = row;
        log(`  perf ${quality} ×${throttle}: ${r.fps} fps, calibration ${cal.fps} fps, ${r.calls} draws, ${Math.round(r.triangles / 1000)}k triangles`);
        if (row.ratio >= (quality === 'high' ? L.HIGH_RATIO : L.LOW_RATIO)) break;
      }
      record.perf.push(best);
    };
    try { await perfRun('high', 1); } catch (e) { problems.push(`frame cost, high tier: ${e.message}`); }
    if (!quick) { try { await perfRun('low', L.THROTTLE); } catch (e) { problems.push(`frame cost, low tier: ${e.message}`); } }
    // ---- the contact sheet: rows sizes, columns cameras ----
    record.sheet = await renderSheet(browser, outDir, record, sizes);
  } finally {
    await browser.close().catch(() => {});
    await srv.close().catch(() => {});
  }
  const j = judgeSheet({ problems, coverage: record.coverage, perf: record.perf, shots: record.shots.length }, L);
  record.verdict = j.ok ? 'pass' : 'fail'; record.fails = j.fails;
  record.finished = new Date().toISOString(); record.seconds = Math.round((Date.now() - t0) / 1000);
  await writeFile(join(outDir, 'capture.json'), JSON.stringify(record, null, 1) + '\n');
  const hi = record.perf.find(r => r.quality === 'high'), lo = record.perf.find(r => r.quality === 'low');
  const cost = hi ? `; 1920×1080 high: ${hi.calls} draws, ${Math.round(hi.triangles / 1000)}k triangles, ${hi.fps} fps against ${hi.cal} calibration${lo ? `; low ×${L.THROTTLE} CPU: ${lo.fps} against ${lo.cal}` : ''}` : '';
  const detail = j.ok ? `${record.shots.length} shots (${sizes.map(s => s.join('×')).join(', ')}), coverage 100%${cost}` : `${j.fails.slice(0, 4).join('; ')}${cost}`;
  return { ok: j.ok, detail, record };
}

async function renderSheet(browser, outDir, record, sizes) {
  const cells = await Promise.all(sizes.map(async s => Promise.all(SHOTS.map(async shot => {
    const r = record.shots.find(x => x.shot === shot && x.size === `${s[0]}x${s[1]}`);
    return r ? `data:image/jpeg;base64,${(await readFile(join(outDir, r.file))).toString('base64')}` : null;
  }))));
  const esc = v => String(v).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const html = `<!doctype html><meta charset=utf-8><style>body{margin:0;background:#17121f;color:#f4eefa;font:600 15px/1.25 system-ui,sans-serif;padding:14px}
  .g{display:grid;grid-template-columns:110px repeat(${SHOTS.length},440px);gap:6px;align-items:center}.h{font-size:13px;opacity:.75;text-align:center}
  img{width:440px;height:248px;object-fit:cover;border-radius:6px;display:block;background:#000}.x{width:440px;height:248px;border-radius:6px;background:#2a2335}</style>
  <h1 style="font-size:20px;margin:0 0 10px">${esc(record.game)} · rows: sizes, columns: cameras</h1><div class=g><div></div>${SHOTS.map(s => `<div class=h>${s}</div>`).join('')}
  ${sizes.map((s, i) => `<div>${s[0]}×${s[1]}</div>${cells[i].map(c => (c ? `<img src="${c}">` : '<div class=x></div>')).join('')}`).join('')}</div>`;
  const page = await browser.newPage({ viewport: { width: 1940, height: 400 }, deviceScaleFactor: 1 });
  try { await page.setContent(html, { waitUntil: 'load' }); await page.screenshot({ path: join(outDir, 'sheet.jpg'), type: 'jpeg', quality: 86, fullPage: true }); }
  finally { await page.close().catch(() => {}); }
  return 'sheet.jpg';
}

if (isMain(import.meta)) {
  const a = process.argv.slice(2), opt = n => { const i = a.indexOf(n); return i >= 0 ? a[i + 1] : null; };
  const dir = a.find(x => !x.startsWith('--') && a[a.indexOf(x) - 1] !== '--out' && a[a.indexOf(x) - 1] !== '--query');
  if (!dir) { console.error('usage: sheet-check.mjs <game-dir> [--out <dir>] [--quick] [--query "…"]'); process.exit(2); }
  const out = resolve(opt('--out') ?? join(dir, 'evidence', `sheet-${new Date().toISOString().replace(/[:.]/g, '-')}`));
  const r = await captureSheet({ dir, outDir: out, quick: a.includes('--quick'), query: opt('--query') ?? undefined, log: console.log });
  console.log(`${r.ok ? 'PASS' : 'FAIL'} contact sheet and frame cost — ${r.detail}\n  ${out}`);
  process.exitCode = r.ok ? 0 : 1;
}
