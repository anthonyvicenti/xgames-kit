// Headless Chrome for previews and measures (render/page.js does the drawing). One browser, one page, reused for a
// whole run: `const r = await openRenderer(); await r.model(file); …; await r.close()`.
// On Linux the GPU needs ANGLE on EGL; run under the machine's GPU wrapper (CHROME_ARGS and the EGL vendor file set).
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT } from './config.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
// the three.js the games run on (the kit's pinned copy), so a preview shows what a game will show
const THREE_DIR = path.join(REPO_ROOT, 'runtimes/three/vendor/three@0.186.0');
const ORIGIN = 'http://art.local';
const MIME = { '.js': 'text/javascript', '.html': 'text/html', '.wasm': 'application/wasm', '.json': 'application/json' };

export function findChrome(env = process.env) {
  const list = [env.CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].filter(Boolean);
  return list.find(p => existsSync(p)) ?? null;
}

const dataUrlBytes = u => Buffer.from(u.slice(u.indexOf(',') + 1), 'base64');

export async function openRenderer({ env = process.env, size = 256 } = {}) {
  const { chromium } = await import('playwright-core');
  const executablePath = findChrome(env) ?? undefined;
  const args = String(env.CHROME_ARGS ?? '').split(/\s+/).filter(Boolean);
  const browser = await chromium.launch({ executablePath, headless: true, args: [...args, '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  const files = new Map();
  let n = 0;
  await page.route(`${ORIGIN}/**`, async route => {
    const u = new URL(route.request().url());
    let file = null;
    if (u.pathname.startsWith('/three/')) file = path.join(THREE_DIR, u.pathname.slice('/three/'.length));
    else if (u.pathname.startsWith('/file/')) file = files.get(u.pathname.slice('/file/'.length).split('/')[0]) ?? null;
    else file = path.join(here, 'render', u.pathname.slice(1) || 'page.html');
    if (!file || !existsSync(file)) return route.fulfill({ status: 404, body: 'not found' });
    return route.fulfill({ status: 200, body: await readFile(file), headers: { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' } });
  });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`${m.type()}: ${m.text().slice(0, 300)}`); });
  await page.goto(`${ORIGIN}/page.html`);
  await page.waitForFunction(() => window.ready === true, null, { timeout: 30000 }).catch(() => { throw new Error(`the preview page did not start: ${errors.join('; ') || 'no error reported'}`); });
  const gpu = await page.evaluate(() => window.gpuInfo());
  const serve = (file, name) => { const k = `f${++n}`; files.set(k, file); return `${ORIGIN}/file/${k}/${encodeURIComponent(name ?? path.basename(file))}`; };
  return {
    gpu,
    /** A GLB → { png: Buffer, measures } */
    async model(file, opts = {}) {
      const r = await page.evaluate(([u, o]) => window.renderModel(u, o), [serve(file, opts.name ?? 'm.glb'), { size, ...opts }]);
      return { png: dataUrlBytes(r.png), measures: r.measures };
    },
    /** A clip file posed on a body GLB → { png: Buffer, measures: { clips, seconds } } */
    async clip(file, body, opts = {}) {
      const r = await page.evaluate(([u, b, o]) => window.renderClip(u, b, o), [serve(file, 'c.glb'), serve(body, 'b.glb'), { size, ...opts }]);
      return { png: dataUrlBytes(r.png), measures: r.measures };
    },
    /** A font → { png: Buffer } (a sample card) */
    async font(file) {
      const r = await page.evaluate(([u, s]) => window.renderFont(u, { size: s }), [serve(file, 'f.bin'), size]);
      return { png: dataUrlBytes(r.png) };
    },
    /** A KTX2 picture → { png: Buffer, width, height } */
    async ktx2(file) {
      const r = await page.evaluate(([u, s]) => window.renderKtx2(u, { size: s }), [serve(file, 'p.ktx2'), size]);
      return { png: dataUrlBytes(r.png), width: r.width, height: r.height };
    },
    /** A sound → { png: Buffer (waveform), sampleRate, seconds, channels: Float32Array[] } */
    async audio(file) {
      const r = await page.evaluate(([u, s]) => window.decodeAudio(u, { size: s }), [serve(file, 's.bin'), size]);
      const channels = r.channels.map(b => { const buf = Buffer.from(b, 'base64'); return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4); });
      return { png: dataUrlBytes(r.png), sampleRate: r.sampleRate, seconds: r.seconds, channels };
    },
    errors,
    page,
    async close() { await browser.close(); },
  };
}

/** A renderer that starts Chrome only when a model, a sound, a font or a KTX2 picture first needs it. */
export function lazyRenderer(opts) {
  let r = null;
  const get = async () => (r ??= await openRenderer(opts));
  const call = name => async (...a) => (await get())[name](...a);
  return { model: call('model'), clip: call('clip'), font: call('font'), ktx2: call('ktx2'), audio: call('audio'), get errors() { return r?.errors ?? []; }, async close() { if (r) await r.close(); } };
}
