#!/usr/bin/env node
// Core patch #7's proof (island hopping): an island rebuilt at runtime, five times back
// and forth, in one page. For each hop: the rebuild's time by stage (App.rebuildPlace), the GPU memory the page holds
// (every GPUBuffer and GPUTexture the device made and has not destroyed or let go, counted by an init script that wraps
// the device: the engine's own and the browser's view of them), the JS heap after a forced collection (CDP), the mesh
// pipelines and the console's errors. Pass: neither the GPU bytes nor the heap grow hop over hop (the same island
// measured again after a round trip holds within the tolerance), and no error.
//
//   gpu-run.sh node runtimes/vista/tools/hop-memory.mjs [--out <dir>] [--hops 5] [--a 101:...] [--b 117:...]
//      [--size 1280x720] [--shots]
// It serves runtimes/vista itself on a free port and opens sandbox/core-view/?noui&seed=<a>.
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { launchChrome } from '../../../builder/qa/browser.mjs';
import { serve } from './serve.mjs';
import { placeRecipe } from '../kit/world/places.js';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i < 0 ? d : (process.argv[i + 1] ?? true); };
const OUT = resolve(String(arg('out', join(tmpdir(), 'vista-hop-memory'))));
const HOPS = Number(arg('hops', 5));

const [W, H] = String(arg('size', '1280x720')).split('x').map(Number);
const parse = s => { const [seed, w = ''] = String(s).split(':'); return { seed: Number(seed), words: Object.fromEntries(w.split(';').filter(Boolean).map(kv => kv.split('='))) }; };
const A = parse(arg('a', '101:size=large;village=town;reef=large;river=yes'));
const B = parse(arg('b', '117:shape=archipelago;water=flat;houses=timber'));
const TOL = { gpuMB: 8, heapMB: 12 };   // what "the same island again" may differ by (caches warm, a few frames of streaming)

// The page's GPU memory, as the device sees it: every buffer and texture made and not yet destroyed (or collected).
const INSTRUMENT = () => {
  const BPP = { r8unorm: 1, rg8unorm: 2, r16float: 2, rg16float: 4, r32float: 4, rgba8unorm: 4, 'rgba8unorm-srgb': 4, bgra8unorm: 4, rgba16float: 8, rg32float: 8, rgba32float: 16, depth32float: 4, depth24plus: 4, 'depth24plus-stencil8': 4, r32uint: 4, rgba32uint: 16, rgba16uint: 8, rg11b10ufloat: 4, rgb10a2unorm: 4 };
  const rec = new Map();
  let id = 0;
  const fin = new FinalizationRegistry(i => rec.delete(i));
  const add = (o, r) => { const i = ++id; Object.defineProperty(o, '__memid', { value: i }); rec.set(i, r); fin.register(o, i); return o; };
  const D = GPUDevice.prototype, cb = D.createBuffer, ct = D.createTexture;
  D.createBuffer = function (d) { return add(cb.call(this, d), { kind: 'buffer', bytes: d.size, label: d.label ?? '' }); };
  D.createTexture = function (d) {
    const s = d.size, w = s.width ?? s[0], h = s.height ?? s[1] ?? 1, l = s.depthOrArrayLayers ?? s[2] ?? 1, m = d.mipLevelCount ?? 1;
    let px = 0; for (let k = 0; k < m; k++) px += Math.max(1, w >> k) * Math.max(1, h >> k) * (d.dimension === '3d' ? Math.max(1, l >> k) : l);
    const fmt = String(d.format), bpp = BPP[fmt] ?? (/^(bc|etc2|astc)/.test(fmt) ? 1 : 4);
    return add(ct.call(this, d), { kind: 'texture', bytes: px * bpp * (d.sampleCount ?? 1), label: d.label ?? '' });
  };
  for (const C of [GPUBuffer, GPUTexture]) { const d0 = C.prototype.destroy; C.prototype.destroy = function () { if (this.__memid) rec.delete(this.__memid); return d0.call(this); }; }
  window.__gpuMem = () => {
    const out = { buffers: 0, textures: 0, count: 0, byLabel: {} };
    for (const r of rec.values()) {
      out[r.kind === 'buffer' ? 'buffers' : 'textures'] += r.bytes; out.count++;
      const k = r.label.replace(/[0-9]+/g, '#').slice(0, 40) || '(no label)';
      out.byLabel[k] = (out.byLabel[k] ?? 0) + r.bytes;
    }
    return out;
  };
};

const MB = b => Math.round(b / 1048576 * 10) / 10;
await mkdir(OUT, { recursive: true });
const server = await serve(resolve(new URL('..', import.meta.url).pathname), 0);
const PORT = server.address().port;
const browser = await launchChrome({ gpu: 'webgpu', args: ['--js-flags=--expose-gc'] });
const rec = { tool: 'runtimes/vista/tools/hop-memory.mjs', at: new Date().toISOString(), gpu: browser.webgpu ?? null, size: [W, H], a: A, b: B, tolerance: TOL, hops: [], errors: [], warnings: [] };
let exit = 1;
try {
  const ctx = await browser.newContext({ viewport: { width: W, height: H } });
  await ctx.addInitScript(INSTRUMENT);
  const page = await ctx.newPage();
  page.on('pageerror', e => rec.errors.push(e.message.slice(0, 300)));
  page.on('console', m => { if (m.type() === 'error') rec.errors.push(m.text().slice(0, 300)); else if (m.type() === 'warning') rec.warnings.push(m.text().slice(0, 200)); });
  const cdp = await ctx.newCDPSession(page);
  const t0 = Date.now();
  const q = p => `seed=${p.seed}&words=${Object.entries(p.words).map(([k, v]) => `${k}:${v}`).join(',')}`;
  await page.goto(`http://127.0.0.1:${PORT}/sandbox/core-view/?noui&${q(A)}`);
  await page.waitForFunction(() => window.__vista?.app?.engine, null, { timeout: 240000 });
  rec.bootMs = Date.now() - t0;
  await page.evaluate(() => document.getElementById('loader')?.remove());   // core-view's static loading card (ui: false never hides it)
  const settle = async () => { await page.waitForTimeout(1500); await cdp.send('HeapProfiler.collectGarbage'); await page.evaluate(() => window.gc?.()); await cdp.send('HeapProfiler.collectGarbage'); await page.waitForTimeout(500); };
  const measure = async (label, island, rebuild = null) => {
    await settle();
    const heap = await cdp.send('Runtime.getHeapUsage');
    const m = await page.evaluate(() => ({ mem: window.__gpuMem(), pipelines: window.__vista.app.engine.meshRenderer.pipelines.size, frame: window.__vista.app.gpu.frame }));
    const row = { label, island, gpuMB: MB(m.mem.buffers + m.mem.textures), buffersMB: MB(m.mem.buffers), texturesMB: MB(m.mem.textures), objects: m.mem.count, heapMB: MB(heap.usedSize), pipelines: m.pipelines, rebuild, byLabel: Object.fromEntries(Object.entries(m.mem.byLabel).sort((a, b) => b[1] - a[1]).slice(0, 40).map(([k, v]) => [k, MB(v)])) };
    rec.hops.push(row);
    console.log(`${label.padEnd(8)} island ${island}  GPU ${row.gpuMB} MB (${row.objects} objects)  heap ${row.heapMB} MB  pipelines ${row.pipelines}${rebuild ? `  rebuild ${rebuild.total} ms ${JSON.stringify(rebuild.ms)}` : ''}`);
    if (has('shots')) await page.screenshot({ path: join(OUT, `${label}.jpg`), type: 'jpeg', quality: 70 });
    return row;
  };
  await measure('boot', 'A');
  const recipes = { A: placeRecipe(A.seed, A.words), B: placeRecipe(B.seed, B.words) };
  for (let i = 1; i <= HOPS; i++) {
    const to = i % 2 ? 'B' : 'A';
    const r = await page.evaluate(async R => window.__vista.app.rebuildPlace(R), recipes[to]);
    await measure(`hop-${i}`, to, r);
  }
  // hop over hop: the same island measured again two hops later
  const rows = rec.hops, growth = [];
  for (let i = 3; i < rows.length; i++) growth.push({ at: rows[i].label, island: rows[i].island, gpuMB: Math.round((rows[i].gpuMB - rows[i - 2].gpuMB) * 10) / 10, heapMB: Math.round((rows[i].heapMB - rows[i - 2].heapMB) * 10) / 10, pipelines: rows[i].pipelines - rows[i - 2].pipelines });
  rec.growth = growth;
  const times = rows.filter(r => r.rebuild).map(r => r.rebuild.total);
  rec.rebuildMs = { min: Math.min(...times), max: Math.max(...times), mean: Math.round(times.reduce((a, b) => a + b, 0) / times.length) };
  const gpuOk = growth.every(g => g.gpuMB <= TOL.gpuMB), heapOk = growth.every(g => g.heapMB <= TOL.heapMB);
  const freedErr = rec.errors.filter(e => /gf-vista: (texture|storage buffer) .* freed/.test(e));
  rec.checks = [
    { name: 'gpu-flat-hop-over-hop', ok: gpuOk, detail: growth.map(g => `${g.at} ${g.gpuMB >= 0 ? '+' : ''}${g.gpuMB} MB`).join(', ') },
    { name: 'heap-flat-hop-over-hop', ok: heapOk, detail: growth.map(g => `${g.at} ${g.heapMB >= 0 ? '+' : ''}${g.heapMB} MB`).join(', ') },
    { name: 'nothing-freed-is-used-again', ok: freedErr.length === 0, detail: freedErr.slice(0, 3).join(' | ') },
    { name: 'no-console-errors', ok: rec.errors.length === 0, detail: rec.errors.slice(0, 5).join(' | ') },
  ];
  for (const c of rec.checks) console.log(`${c.ok ? 'PASS' : 'FAIL'} ${c.name}: ${c.detail}`);
  console.log(`rebuild ms: ${JSON.stringify(rec.rebuildMs)}`);
  exit = rec.checks.every(c => c.ok) ? 0 : 1;
} catch (e) {
  rec.errors.push('tool: ' + (e.stack ?? e.message));
  console.error(e);
} finally {
  await writeFile(join(OUT, 'record.json'), JSON.stringify(rec, null, 1));
  await browser.close();
  server.close();
}
process.exit(exit);
function has(k) { return process.argv.includes('--' + k); }
