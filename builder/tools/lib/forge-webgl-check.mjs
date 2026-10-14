// verify check 32 on forge since wave 3 (track W; CONTRACT §8 forge; research/rust-engine/PLAN.md §9 decision 3): a
// forge game ships one core in two builds, and gf/forge/host.js gives a device the one it can draw with.
//
//   A  no WebGPU, WebGL2    the game plays on its WebGL2 build: it boots to the menu, a round starts, the player walks
//                           on real keys, frames are drawn, every drawn instance is tagged, the picture is not blank,
//                           the console is clean, and window.__game.forge.state().backend says "webgl2"
//   B  neither              the kit's own "open in your browser" screen with the link, never a blank canvas
//   C  the same picture     the look shots (check 9's: the first look, ?gf-show=world and ?gf-show=look at 1920×1080
//                           and 390×844) drawn by each build in the same Chrome, each forced with ?gf-forge-backend=,
//                           and the difference held inside PICTURE; a side-by-side sheet is written. Skipped with a
//                           note (never failed) in a Chrome that has only one of the two.
//
// How a Chrome is made to lack something: an init script hides it from the page before the game loads (navigator.gpu
// gone: "no WebGPU"; getContext('webgl2') giving null as well: "neither"). So the three legs run in whatever Chrome
// verify uses for a forge game, and A is the loader's own choice, not the QA query's. In verify's usual Chrome (WebGPU,
// chrome-headless-shell) the WebGL2 context is ANGLE's on the same GPU. With GF_FORGE_BACKEND=webgl2 the whole verify
// runs in a Chrome with real WebGL2 and no WebGPU (builder/qa/browser.mjs), and A is simply what happens.
//
//   const r = await checkForgeBackends({ dir, url, launchChrome, outDir, quick, log });   → { ok, detail, record }
//   node builder/tools/lib/forge-webgl-check.mjs <game> --out <dir> [--quick]    the same, alone
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from './main.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms) { const t0 = Date.now(); for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(150); } }

/** Before the page's own scripts: this browser has no WebGPU. */
export const HIDE_WEBGPU = () => { try { Object.defineProperty(Navigator.prototype, 'gpu', { get: () => undefined, configurable: true }); } catch {} };
/** Before the page's own scripts: no canvas gives a WebGL context. */
export const HIDE_WEBGL = () => {
  for (const C of [globalThis.HTMLCanvasElement, globalThis.OffscreenCanvas]) {
    if (!C) continue;
    const get = C.prototype.getContext;
    C.prototype.getContext = function (type, ...rest) { return /^(webgl2?|experimental-webgl2?)$/.test(String(type)) ? null : get.call(this, type, ...rest); };
  }
};
/** The page query that forces a build (gf/forge/host.js BACKEND_QUERY). */
export const BACKEND_QUERY = 'gf-forge-backend';
/** Check 9's look shots (runtimes/forge/lookdev/capture.mjs captureGame). */
export const LOOK_SHOTS = [['hero', '?seed=7&gf-autoplay=1&gf-ui=0'], ['wide', '?gf-show=world'], ['look', '?gf-show=look']];
export const LOOK_SIZES = [[1920, 1080], [390, 844]];
/**
 * What "the same picture" is held to. A view's picture is the mean of `frames` screenshots `every` ms apart, on copies
 * a sixth the size (each of their pixels the plain average of a 6 × 6 block of the shot): film grain, a flame's
 * flicker and a single spark count for little, what is always there counts in full. A pixel's difference is the mean
 * of its three channels' (0..255):
 *   mean      the mean difference over the picture
 *   changed   the share of pixels that differ by more than `step`
 *   luma      how far the two pictures' mean brightness may be apart (of 255)
 * Two pictures of ONE build taken a moment apart still differ (the fires, a round under way): `floor` is that
 * difference measured in the same run at each size (twice, the larger kept), and a limit is never under `overFloor`
 * times it.
 * Set from Bone Vigil on 2026-10-10 (gf-forge/evidence/wave3-W-2026-10-10/README.md has the runs): the two
 * builds are 0.3 to 1.0 apart, one build from itself 0.5 to 0.9, and with the WebGL2 build made to draw its 8-bit scene
 * (no bloom: `--break 8bit`) the four shots with a fire in view are 2.0 to 2.3 apart and the check fails. It is a
 * coarse hold: it sees a pass that is missing or a picture a few percent brighter, not a subtle shading difference.
 */
export const PICTURE = { block: 6, frames: 4, every: 250, step: 12, mean: 1.6, changed: 0.04, luma: 1.6, overFloor: 2 };

/** A PNG's mean luma and how much it varies (of 255), on a small copy: a blank canvas has no variation. */
async function pictureOf(page, png) {
  return page.evaluate(async b64 => {
    const im = new Image(); im.src = 'data:image/png;base64,' + b64; await im.decode();
    const c = new OffscreenCanvas(160, 90), g = c.getContext('2d'); g.drawImage(im, 0, 0, 160, 90);
    const d = g.getImageData(0, 0, 160, 90).data; let s = 0, s2 = 0; const n = d.length / 4;
    for (let i = 0; i < d.length; i += 4) { const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]; s += l; s2 += l * l; }
    const mean = s / n; return { mean: Math.round(mean * 10) / 10, spread: Math.round(Math.sqrt(Math.max(0, s2 / n - mean * mean)) * 10) / 10 };
  }, png.toString('base64'));
}

/**
 * Two shots of one view compared (PICTURE): {mean, p99, changed, luma: [a, b], lumaDelta, where, worst}. `where` names
 * the twelfth of the picture (a 4 × 3 grid) whose mean difference is largest, `worst` that mean.
 */
export async function comparePictures(page, pngA, pngB, { block = PICTURE.block, step = PICTURE.step } = {}) {
  const [ka, kb] = [`a${Math.random()}`, `b${Math.random()}`];
  for (const f of [].concat(pngA)) await addFrame(page, ka, f, block);
  for (const f of [].concat(pngB)) await addFrame(page, kb, f, block);
  return compareKept(page, ka, kb, step);
}

/** One frame of a view into the page's memory under `key`: its copy (each pixel the plain average of a block × block
 *  square of the shot) summed with the frames already there. A view's picture is the mean of its frames. */
async function addFrame(page, key, png, block = PICTURE.block) {
  await page.evaluate(async ([K, S, BLOCK]) => {
    const im = new Image(); im.src = 'data:image/png;base64,' + S; await im.decode();
    const W = Math.max(1, Math.floor(im.width / BLOCK)), H = Math.max(1, Math.floor(im.height / BLOCK));
    const c = new OffscreenCanvas(im.width, im.height), g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(im, 0, 0);
    const d = g.getImageData(0, 0, im.width, im.height).data, k2 = 1 / (BLOCK * BLOCK);
    const kept = ((window.__gfPictures ??= {})[K] ??= { W, H, n: 0, sum: new Float32Array(W * H * 3) });
    if (kept.W !== W || kept.H !== H) throw new Error('frames of one view have one size');
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      let r = 0, gg = 0, bb = 0;
      for (let v = 0; v < BLOCK; v++) { let at = ((y * BLOCK + v) * im.width + x * BLOCK) * 4; for (let u = 0; u < BLOCK; u++, at += 4) { r += d[at]; gg += d[at + 1]; bb += d[at + 2]; } }
      const o = (y * W + x) * 3; kept.sum[o] += r * k2; kept.sum[o + 1] += gg * k2; kept.sum[o + 2] += bb * k2;
    }
    kept.n++;
  }, [key, png.toString('base64'), block]);
}

/** Two kept views compared, and let go. */
async function compareKept(page, keyA, keyB, step = PICTURE.step) {
  return page.evaluate(([KA, KB, STEP]) => {
    const A = window.__gfPictures[KA], B = window.__gfPictures[KB];
    delete window.__gfPictures[KA]; delete window.__gfPictures[KB];
    if (A.W !== B.W || A.H !== B.H) throw new Error('the two views are not one size');
    const { W, H } = A, n = W * H, a = A.sum.map(v => v / A.n), b = B.sum.map(v => v / B.n), diffs = new Float32Array(n);
    let sum = 0, changed = 0, la = 0, lb = 0; const cells = new Float64Array(12), counts = new Float64Array(12);
    for (let i = 0; i < n; i++) {
      const k = i * 3, d = (Math.abs(a[k] - b[k]) + Math.abs(a[k + 1] - b[k + 1]) + Math.abs(a[k + 2] - b[k + 2])) / 3;
      diffs[i] = d; sum += d; if (d > STEP) changed++;
      la += 0.2126 * a[k] + 0.7152 * a[k + 1] + 0.0722 * a[k + 2]; lb += 0.2126 * b[k] + 0.7152 * b[k + 1] + 0.0722 * b[k + 2];
      const cx = Math.min(3, Math.floor((i % W) * 4 / W)), cy = Math.min(2, Math.floor(Math.floor(i / W) * 3 / H));
      cells[cy * 4 + cx] += d; counts[cy * 4 + cx]++;
    }
    const sorted = Array.from(diffs).sort((x, y) => x - y), r = v => Math.round(v * 100) / 100;
    let worst = 0; for (let c = 1; c < 12; c++) if (cells[c] / counts[c] > cells[worst] / counts[worst]) worst = c;
    const names = [['top', 'middle', 'bottom'], ['far left', 'left of centre', 'right of centre', 'far right']];
    return { mean: r(sum / n), p99: r(sorted[Math.floor(n * 0.99)]), changed: Math.round(changed / n * 10000) / 10000, luma: [r(la / n), r(lb / n)], lumaDelta: r(Math.abs(la - lb) / n),
      where: `${names[0][Math.floor(worst / 4)]}, ${names[1][worst % 4]}`, worst: r(cells[worst] / counts[worst]), frames: [A.n, B.n] };
  }, [keyA, keyB, step]);
}

/** Of two measures of one build against itself, the larger in each number (the scene's own noise is at least that). */
export function largerFloor(a, b) {
  const big = a.mean >= b.mean ? a : b;
  return { ...big, mean: Math.max(a.mean, b.mean), changed: Math.max(a.changed, b.changed), lumaDelta: Math.max(a.lumaDelta ?? 0, b.lumaDelta ?? 0) };
}

/** Is a pair inside PICTURE, given the same-build floor? → {ok, limits, over: [what …]} */
export function pictureVerdict(m, floor = null) {
  const lim = { mean: Math.max(PICTURE.mean, (floor?.mean ?? 0) * PICTURE.overFloor), changed: Math.max(PICTURE.changed, (floor?.changed ?? 0) * PICTURE.overFloor), luma: Math.max(PICTURE.luma, (floor?.lumaDelta ?? 0) * PICTURE.overFloor) };
  const over = [];
  if (m.mean > lim.mean) over.push(`mean difference ${m.mean} over ${lim.mean.toFixed(2)}`);
  if (m.changed > lim.changed) over.push(`${(m.changed * 100).toFixed(1)}% of the picture changed, over ${(lim.changed * 100).toFixed(1)}%`);
  if (m.lumaDelta > lim.luma) over.push(`mean brightness ${m.luma[0]} against ${m.luma[1]}, over ${lim.luma.toFixed(1)} apart`);
  return { ok: over.length === 0, limits: lim, over };
}

/** A sheet of pairs, one row a shot: the WebGPU build's picture beside the WebGL2 build's, with what was measured. */
async function sheet(browser, rows, title, file) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  try {
    const cell = r => `<figure><div class="pair"><div><img src="data:image/png;base64,${r.a.toString('base64')}"><span>WebGPU</span></div><div><img src="data:image/png;base64,${r.b.toString('base64')}"><span>WebGL2</span></div></div><figcaption>${r.caption}</figcaption></figure>`;
    await page.setContent(`<!doctype html><style>body{margin:0;background:#101216;color:#e8e6df;font:14px/1.4 system-ui,sans-serif;padding:18px}h1{font-size:18px;margin:0 0 12px}figure{margin:0 0 16px}.pair{display:flex;gap:8px;align-items:flex-start}.pair div{position:relative;flex:1}.pair.tall div{flex:none}img{display:block;width:100%;height:auto}span{position:absolute;left:8px;top:8px;background:#000a;padding:2px 8px;border-radius:4px;font-weight:700}figcaption{margin-top:5px;opacity:.85}.tall{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}</style><h1>${title}</h1><div class="${rows[0]?.tall ? 'tall' : ''}">${rows.map(cell).join('')}</div>`);
    await page.waitForFunction(() => [...document.images].every(i => i.complete && i.naturalWidth > 0), null, { timeout: 20000 }).catch(() => {});
    await page.screenshot({ path: file, type: 'jpeg', quality: 84, fullPage: true });
  } finally { await page.close().catch(() => {}); }
}

/**
 * Check 32's three legs on the game served at `url` (its file tree in `dir`), in a Chrome from `launchChrome` (verify's
 * for a forge game). → { ok, detail, record }: `record.legs` has each leg's facts, `record.pictures` each pair's
 * numbers, `record.sheets` the side-by-side sheets written into outDir.
 */
export async function checkForgeBackends({ dir = null, url, launchChrome, browser: given = null, outDir = null, quick = false, log = () => {}, errorFilter = null, breakQuery = '' } = {}) {
  const record = { legs: {}, pictures: [], sheets: [], limits: PICTURE, notes: [] };
  // `breakQuery` (the tool's own proof, `--break 8bit`): a query added to the WebGL2 build's look shots only, to make
  // its picture differ on purpose: the pictures leg must then fail, saying where
  if (breakQuery) record.notes.push(`BROKEN ON PURPOSE: the WebGL2 build's look shots carry "${breakQuery}"`);
  const browser = given ?? await launchChrome({ gpu: 'webgpu' });
  record.chrome = browser.version();
  if (outDir) mkdirSync(join(outDir, 'backends'), { recursive: true });
  const save = (name, buf) => { if (!outDir) return null; const f = join('backends', name); writeFileSync(join(outDir, f), buf); return f; };
  const open = async (label, { hide = [], viewport = { width: 1280, height: 720 } } = {}) => {
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 });
    for (const h of hide) await ctx.addInitScript(h);
    const page = await ctx.newPage(), errors = [];
    page.on('pageerror', e => errors.push(`${label}: ${e.message}`));
    page.on('console', m => { if (m.type() === 'error' && !(errorFilter?.test(m.text()))) errors.push(`${label}: ${m.text().slice(0, 300)}`); });
    return { ctx, page, errors };
  };
  // which build drew: the game's own word (window.__game.forge.state().backend), and in a preview (?gf-show=, which
  // has no forge state) the kind of context the game's canvas holds: a canvas gives one kind, ever
  const stateOf = page => page.evaluate(() => {
    const s = window.__game?.forge?.state?.();
    if (s) return { backend: s.backend ?? null, frames: s.frames, wasm: s.wasm, info: s.info, hdr: s.render?.hdr ?? null, tier: s.render?.tier ?? null, draws: s.draws, from: 'state' };
    const c = document.getElementById('gf-canvas');
    let backend = null; try { backend = !c ? null : c.getContext('webgpu') ? 'webgpu' : c.getContext('webgl2') ? 'webgl2' : null; } catch {}
    return { backend, hdr: null, from: 'canvas' };
  }).catch(() => null);
  const me = page => page.evaluate(() => window.__game?.snapshot?.()?.players?.find(p => p.local) ?? null).catch(() => null);
  try {
    // what this Chrome has, as a page sees it
    const facts = await (async () => {
      const T = await open('facts');
      try {
        await T.page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
        return await T.page.evaluate(async () => {
          let adapter = false; try { adapter = !!(navigator.gpu && await navigator.gpu.requestAdapter()); } catch {}
          const gl = document.createElement('canvas').getContext('webgl2'); let renderer = null;
          if (gl) { const d = gl.getExtension('WEBGL_debug_renderer_info'); renderer = String(d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)); gl.getExtension('WEBGL_lose_context')?.loseContext(); }
          return { webgpu: adapter, webgl2: !!gl, renderer };
        });
      } finally { await T.ctx.close().catch(() => {}); }
    })();
    record.chromeHas = facts;
    log(`backends: this Chrome has ${facts.webgpu ? 'a WebGPU adapter' : 'no WebGPU'} and ${facts.webgl2 ? `WebGL2 (${facts.renderer})` : 'no WebGL2'}`);

    // ---- A: no WebGPU, WebGL2 → the game plays on its WebGL2 build ----
    {
      const leg = (record.legs.webgl2 = { ok: false });
      if (!facts.webgl2) { leg.skipped = 'this Chrome has no WebGL2'; leg.detail = 'not run: this Chrome has no WebGL2 context to give'; }
      else {
        const T = await open('no-webgpu', { hide: [HIDE_WEBGPU] }), p = T.page;
        try {
          await p.goto(`${url}?seed=7`, { waitUntil: 'load' });
          const lobby = await until(() => p.evaluate(() => (window.__game?.ready ? window.__game.phase : null)), 90000);
          leg.phase = lobby;
          const st0 = await stateOf(p);
          leg.state = st0;
          if (lobby === 'lobby' && st0?.backend === 'webgl2') {
            const play = await p.locator('#gf-play').boundingBox().catch(() => null);
            if (play) await p.mouse.click(play.x + play.width / 2, play.y + play.height / 2);
            leg.playing = !!(await until(() => p.evaluate(() => window.__game?.phase === 'playing'), 20000));
            await p.mouse.click(640, 400);
            const start = await me(p);
            const f0 = (await stateOf(p))?.frames ?? 0, t0 = Date.now();
            await p.keyboard.down('KeyW'); await sleep(1400); await p.keyboard.up('KeyW');
            const end = await me(p), f1 = (await stateOf(p))?.frames ?? 0;
            leg.moved = start && end ? +Math.hypot(end.x - start.x, end.z - start.z).toFixed(2) : 0;
            leg.fps = Math.round((f1 - f0) / ((Date.now() - t0) / 1000));
            const cov = await p.evaluate(() => { const c = window.__game.coverage(); return { meshes: c.meshes, tagged: c.tagged, untagged: c.untagged.length }; }).catch(() => null);
            leg.coverage = cov;
            const png = await p.screenshot({ type: 'png' });
            leg.shot = save('webgl2-playing.png', png);
            leg.picture = await pictureOf(p, png);
            leg.errors = T.errors.slice(0, 4);
            leg.ok = leg.playing && leg.moved > 0.5 && leg.fps >= 5 && !!cov && cov.meshes > 0 && cov.untagged === 0 && leg.picture.spread > 4 && T.errors.length === 0;
            leg.detail = `with WebGPU hidden from the page the game drew with its WebGL2 build (${st0.info ?? ''}${st0.hdr === false ? '; the 8-bit scene' : ''}): ${leg.playing ? 'a round started' : 'NO round started'}, the player walked ${leg.moved} m on real keys, ${leg.fps} frames a second, ${cov ? `${cov.tagged}/${cov.meshes} instances tagged` : 'no coverage report'}, picture luma ${leg.picture.mean} ± ${leg.picture.spread}${T.errors.length ? `; console: ${T.errors.slice(0, 2).join(' | ')}` : ''}`;
          } else {
            leg.errors = T.errors.slice(0, 4);
            const un = await p.evaluate(() => window.__game?.unsupported?.reason ?? null).catch(() => null);
            leg.detail = lobby === 'unsupported' ? `with WebGPU hidden the game showed the kit's screen instead of playing on WebGL2 (${un ?? 'no reason given'})` : `with WebGPU hidden the game reached phase ${lobby ?? 'none'} on backend ${st0?.backend ?? 'none'}${T.errors.length ? `; console: ${T.errors[0]}` : ''}`;
          }
        } finally { await T.ctx.close().catch(() => {}); }
      }
      log(`${leg.skipped ? 'skip' : leg.ok ? 'pass' : 'FAIL'} backends A (no WebGPU, WebGL2): ${leg.detail}`);
    }

    // ---- B: neither → the kit's own screen ----
    {
      const leg = (record.legs.neither = { ok: false });
      const T = await open('neither', { hide: [HIDE_WEBGPU, HIDE_WEBGL] }), p = T.page;
      try {
        await p.goto(`${url}?seed=7`, { waitUntil: 'load' });
        const s = await until(() => p.evaluate(() => (window.__game?.ready ? { phase: window.__game.phase, unsupported: window.__game.unsupported ?? null } : null)), 30000);
        const screen = await p.evaluate(() => { const d = document.getElementById('gf-forge-unsupported'); if (!d) return null; const r = d.getBoundingClientRect(); const a = d.querySelector('#gf-forge-open'); return { w: r.width, h: r.height, text: d.innerText.slice(0, 300), link: a?.href ?? null, shown: getComputedStyle(d).display !== 'none' }; }).catch(() => null);
        leg.shot = save('neither.png', await p.screenshot({ type: 'png' }));
        leg.state = s; leg.screen = screen; leg.errors = T.errors.slice(0, 3);
        leg.ok = s?.phase === 'unsupported' && !!screen?.shown && screen.w > 200 && /WebGPU|WebGL/.test(screen.text) && !!screen.link && T.errors.length === 0;
        leg.detail = s?.phase === 'unsupported' ? `with WebGPU and WebGL2 both hidden the game shows the kit's screen: "${(screen?.text ?? '').split('\n').map(x => x.trim()).filter(Boolean).slice(0, 2).join(': ').slice(0, 150)}", with its link (${String(s.unsupported?.reason ?? '').slice(0, 90)})${T.errors.length ? `; console: ${T.errors[0]}` : ''}` : `phase ${s?.phase ?? 'none'}: no "open in your browser" screen (a blank canvas fails)`;
      } finally { await T.ctx.close().catch(() => {}); }
      // forced means forced (QA's query): asked for the WebGPU build in a browser without WebGPU, the game shows the
      // screen; it never quietly draws with the other build
      if (facts.webgl2) {
        const F = await open('forced-webgpu', { hide: [HIDE_WEBGPU] });
        try {
          await F.page.goto(`${url}?seed=7&${BACKEND_QUERY}=webgpu`, { waitUntil: 'load' });
          const s = await until(() => F.page.evaluate(() => (window.__game?.ready ? { phase: window.__game.phase, reason: window.__game.unsupported?.reason ?? null } : null)), 30000);
          leg.forced = s;
          const held = s?.phase === 'unsupported';
          leg.ok = leg.ok && held;
          leg.detail += held ? `; ?${BACKEND_QUERY}=webgpu without WebGPU: the screen too, not the other build` : `; ?${BACKEND_QUERY}=webgpu without WebGPU reached phase ${s?.phase ?? 'none'}: a forced build must never be swapped for the other`;
        } finally { await F.ctx.close().catch(() => {}); }
      }
      log(`${leg.ok ? 'pass' : 'FAIL'} backends B (neither): ${leg.detail}`);
    }

    // ---- C: the two builds' pictures on the look shots ----
    {
      const leg = (record.legs.pictures = { ok: true });
      if (!facts.webgpu || !facts.webgl2) { leg.skipped = `this Chrome has ${facts.webgpu ? 'no WebGL2' : 'no WebGPU'}`; leg.detail = `not compared: ${leg.skipped}, so only one build draws here`; record.notes.push(`pictures: ${leg.detail}`); }
      else {
        const take = async (q, [w, h], backend, hero) => {
          const T = await open(`${backend} ${q}`, { viewport: { width: w, height: h } });
          try {
            await T.page.goto(`${url}${q}&${BACKEND_QUERY}=${backend}${backend === 'webgl' ? breakQuery : ''}`, { waitUntil: 'load' });
            const ok = await until(() => T.page.evaluate(h2 => (h2 ? window.__game?.phase === 'playing' : window.__game?.ready === true), hero), 60000);
            await sleep(1500);
            const st = await stateOf(T.page);
            // PICTURE.frames frames of the view, PICTURE.every ms apart: its picture is their mean (a flame's flicker and a
            // drifting ember count for less than what is always there)
            const pngs = [];
            for (let k = 0; k < PICTURE.frames; k++) { if (k) await sleep(PICTURE.every); pngs.push(await T.page.screenshot({ type: 'png' })); }
            const png = pngs[0];
            return { png, pngs, ok: !!ok, backend: st?.backend ?? null, hdr: st?.hdr ?? null, errors: T.errors.slice(0, 2) };
          } finally { await T.ctx.close().catch(() => {}); }
        };
        const blank = await browser.newPage();
        const rows = [];
        try {
          leg.floors = {};
          for (const size of quick ? LOOK_SIZES.slice(0, 1) : LOOK_SIZES) {
            // the floor at this size: one build against itself a moment later, on the busiest shot
            // (twice, and the larger kept: one sample of a scene's own noise can come out low. The Forge Room's hero shot,
            // a round under way, read 0.67, 2.49 and 2.22 against itself in three runs on 2026-10-11, and the run with
            // 0.67 failed the two builds for being 2.36 apart)
            const [f1, f2, f3] = [await take(LOOK_SHOTS[0][1], size, 'webgpu', true), await take(LOOK_SHOTS[0][1], size, 'webgpu', true), await take(LOOK_SHOTS[0][1], size, 'webgpu', true)];
            const floor = largerFloor(await comparePictures(blank, f1.pngs, f2.pngs), await comparePictures(blank, f1.pngs, f3.pngs));
            leg.floors[size.join('x')] = floor; leg.floor ??= floor;
            log(`backends C floor (WebGPU against itself, hero ${size.join('×')}): mean ${floor.mean}, ${(floor.changed * 100).toFixed(1)}% changed, luma ${floor.luma.join(' / ')}`);
            for (const [shot, q] of LOOK_SHOTS) {
              const a = shot === 'hero' ? f1 : await take(q, size, 'webgpu', false);
              const b = await take(q, size, 'webgl', shot === 'hero');
              const m = await comparePictures(blank, a.pngs, b.pngs), v = pictureVerdict(m, floor);
              const drew = a.backend === 'webgpu' && b.backend === 'webgl2' && a.ok && b.ok, errors = [...a.errors, ...b.errors];
              const id = `${shot}-${size.join('x')}`;
              const files = [save(`${id}--webgpu.png`, a.png), save(`${id}--webgl2.png`, b.png)];
              const row = { shot, size, ...m, ok: v.ok && drew && errors.length === 0, over: v.over, limits: v.limits, drew: [a.backend, b.backend], hdr: [a.hdr, b.hdr], files, errors };
              if (!drew) row.over.push(`drawn by ${a.backend ?? 'nothing'} and ${b.backend ?? 'nothing'}, not webgpu and webgl2`);
              if (errors.length) row.over.push(`console: ${errors[0]}`);
              record.pictures.push(row);
              rows.push({ a: a.png, b: b.png, tall: size[1] > size[0], size, caption: `${shot} ${size.join('×')} · mean difference ${m.mean} of 255, ${(m.changed * 100).toFixed(1)}% of the picture over ${PICTURE.step}, brightness ${m.luma[0]} / ${m.luma[1]} · most in the ${m.where} (${m.worst})${row.ok ? '' : ` · OVER: ${row.over.join('; ')}`}` });
              log(`${row.ok ? 'pass' : 'FAIL'} backends C ${id}: mean ${m.mean}, ${(m.changed * 100).toFixed(1)}% changed, luma ${m.luma.join(' / ')}, most in the ${m.where} (${m.worst})${row.over.length ? ` · ${row.over.join('; ')}` : ''}`);
            }
          }
        } finally { await blank.close().catch(() => {}); }
        if (outDir) {
          for (const [name, pick, title] of [['sheet-backends-1920x1080.jpg', r => !r.tall, '1920×1080'], ['sheet-backends-390x844.jpg', r => r.tall, '390×844']]) {
            const part = rows.filter(pick); if (!part.length) continue;
            await sheet(browser, part, `gf-forge: the WebGPU build beside the WebGL2 build · ${title} · ${record.chrome} · ${facts.renderer ?? ''}`, join(outDir, 'backends', name)).then(() => record.sheets.push(join('backends', name))).catch(e => record.notes.push(`sheet ${name}: ${e.message}`));
          }
        }
        const bad = record.pictures.filter(r => !r.ok), worst = [...record.pictures].sort((x, y) => y.mean - x.mean)[0];
        leg.ok = record.pictures.length > 0 && bad.length === 0;
        leg.detail = `${record.pictures.length} look shots drawn by both builds: the mean difference is ${Math.min(...record.pictures.map(r => r.mean))} to ${worst?.mean} of 255 (most on ${worst?.shot} ${worst?.size.join('×')}, in the ${worst?.where}; one build against itself: ${leg.floor.mean})${bad.length ? `; OVER on ${bad.map(r => `${r.shot} ${r.size.join('×')}: ${r.over.join(', ')}`).join(' | ')}` : ''}`;
      }
      log(`${leg.skipped ? 'skip' : leg.ok ? 'pass' : 'FAIL'} backends C (the same picture): ${leg.detail}`);
    }
  } finally { if (!given) await browser.close().catch(() => {}); }
  const { webgl2: A, neither: B, pictures: C } = record.legs;
  // a leg that could not run in this Chrome is said, never passed off as held; A must run somewhere to pass
  const ok = !!A.ok && !!B.ok && (C.ok || !!C.skipped);
  const detail = [`no WebGPU, WebGL2: ${A.detail}`, `neither: ${B.detail}`, `the two builds' pictures: ${C.detail}`].join(' · ');
  return { ok, detail, record };
}

// ---- alone ----
if (isMain(import.meta)) {
  const a = process.argv.slice(2), arg = k => (a.includes(k) ? a[a.indexOf(k) + 1] : null);
  const dir = resolve(a[0] ?? ''), out = resolve(arg('--out') ?? 'forge-webgl-check');
  const { launchChrome, GPU_TROUBLE } = await import('../../qa/browser.mjs');
  const { startParty } = await import('../../multiplayer/party/lib.mjs');
  mkdirSync(out, { recursive: true });
  const srv = await startParty({ dir, port: 0 });
  try {
    // --break 8bit: the WebGL2 build draws its 8-bit scene (no bloom) on the look shots; the check must fail for it
    const brk = arg('--break');
    if (brk && brk !== '8bit') throw new Error('--break 8bit is the one way this tool breaks the picture on purpose');
    const r = await checkForgeBackends({ dir, url: srv.url, launchChrome, outDir: out, quick: a.includes('--quick'), log: m => console.log(m), errorFilter: GPU_TROUBLE, breakQuery: brk ? '&gf-forge-scene=8bit' : '' });
    writeFileSync(join(out, 'backends.json'), JSON.stringify({ game: dir, ok: r.ok, detail: r.detail, ...r.record }, null, 2) + '\n');
    console.log(`${r.ok ? 'PASS' : 'FAIL'} 32 the two builds: ${r.detail}`);
    process.exitCode = r.ok ? 0 : 1;
  } finally { await srv.close().catch(() => {}); }
}
