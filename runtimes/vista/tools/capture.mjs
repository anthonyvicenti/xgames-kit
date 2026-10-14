// Reference shots and frame times from a Tidewater-core page in bench mode (seeded random, render loop stopped,
// simulation clock held: the same code and the same sequence give the same pixels).
//   node runtimes/vista/tools/capture.mjs [--url http://127.0.0.1:5960/] [--out dir] [--size 3840x2160]
//        [--set matrix,extras] [--frames 64] [--bench] [--bench-size 3840x2160] [--tier high|low] [--headed]
// Drives the core's own Bench (src/core/Bench.js): pose → frames at dt 0 → read back the post output. A shot is named
// view~hour~sea; this tool wraps Bench.pose so the hour and the sea state (the panel's own preset buttons) apply after
// the view's pose. Writes <out>/<name>.png, <out>/shots.json, and with --bench <out>/frame-times-<tier>.json.
// GPU: chrome-headless-shell on Vulkan (qa/browser.mjs WEBGPU_ARGS). --tier low restricts Vulkan to the Intel iGPU
// (VK_ICD_FILENAMES), the low-tier test device named in super-scenic/evidence.
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { launchChrome } from '../../../builder/qa/browser.mjs';
import { fromReadback, writePng } from './img.mjs';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i < 0 ? d : (process.argv[i + 1] ?? true); };
const has = k => process.argv.includes('--' + k);
const URL_ = arg('url', 'http://127.0.0.1:5960/');
const OUT = resolve(arg('out', 'research/super-scenic/reference/shots'));
const [W, H] = String(arg('size', '3840x2160')).split('x').map(Number);
const FRAMES = Number(arg('frames', 64));
const SETS = String(arg('set', 'matrix,extras')).split(',');
const TIER = arg('tier', 'high');
const LOOK_API = has('look-api');
const DT = Number(arg('dt', 0));   // 0: the clock held (strict pixel comparison); 1/60: lived (auto exposure, temporal filters and clouds settle as in play)

// The look matrix: six hours (the pilot's names) × the four sea states the core's panel offers, from the pier camera.
export const HOURS = { dawn: 6.4, morning: 9.5, noon: 12.5, golden: 16.2, sunset: 18.4, night: 21.5 };
export const SEAS = ['Calm', 'Breezy', 'Choppy', 'Storm'];
// Places: the core's own review cameras (core/DebugViews.js) and Bench's boat poses, at their own hours, Breezy.
export const EXTRAS = ['beach', 'village', 'boatFish', 'underwater', 'surf', 'sunsetWest', 'palms', 'aerial', 'shallowSeabed', 'sunFlare'];
export function shotList(sets = SETS) {
  const out = [];
  if (sets.includes('matrix')) for (const [h, t] of Object.entries(HOURS)) for (const s of SEAS) out.push({ name: `pier~${h}~${s}`, view: 'pier', hour: t, sea: s });
  if (sets.includes('extras')) for (const v of EXTRAS) out.push({ name: `${v}~own~Breezy`, view: v, hour: null, sea: 'Breezy' });
  return out;
}

export async function capture({ url = URL_, out = OUT, width = W, height = H, frames = FRAMES, dt = DT, shots = shotList(), bench = has('bench'), benchSize = arg('bench-size', `${W}x${H}`), tier = TIER, headed = has('headed'), lookApi = LOOK_API, log = console.log, onLoaded = null, benchViews = null } = {}) {
  await mkdir(out, { recursive: true });
  const env = tier === 'low' ? { env: { ...process.env, VK_ICD_FILENAMES: '/usr/share/vulkan/icd.d/intel_icd.json' } } : {};
  const browser = await launchChrome({ gpu: 'webgpu', headless: !headed, ...env });
  const rec = { tool: 'runtimes/vista/tools/capture.mjs', url, at: new Date().toISOString(), size: [width, height], frames, dt, tier, shots: [], console: [] };
  const t0 = Date.now();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    page.on('console', m => { if (['error', 'warning'].includes(m.type()) && rec.console.length < 60) rec.console.push({ t: Date.now() - t0, type: m.type(), text: m.text().slice(0, 300) }); });
    page.on('pageerror', e => rec.console.push({ t: Date.now() - t0, type: 'pageerror', text: String(e).slice(0, 300) }));
    const bodies = new Map();
    await page.route('http://127.0.0.1:5190/**', async r => { bodies.set(new URL(r.request().url()).pathname.slice(1), r.request().postDataBuffer()); await r.fulfill({ status: 200, body: 'ok' }); });
    await page.goto(url + (url.includes('?') ? '&' : '?') + 'bench', { waitUntil: 'load' });
    await page.waitForFunction(() => window.__bench || document.querySelector('.tw-loader-error, [class*=error]')?.textContent?.includes('wrong'), null, { timeout: 600000 });
    rec.loadMs = Date.now() - t0;
    rec.gpu = await page.evaluate(async () => {
      const a = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
      return { format: navigator.gpu.getPreferredCanvasFormat(), vendor: a?.info?.vendor, architecture: a?.info?.architecture, description: a?.info?.description, hasBench: !!window.__bench };
    });
    if (!rec.gpu.hasBench) throw new Error('the page did not reach bench mode: ' + JSON.stringify(rec.console.slice(-5)));
    log(`loaded in ${(rec.loadMs / 1000).toFixed(1)} s on ${rec.gpu.vendor}/${rec.gpu.architecture} (${rec.gpu.format})`);
    if (onLoaded) rec.extra = await onLoaded(page);   // a caller's own readings of the loaded page (places-gallery: the place's costs)
    // wrap pose: the view, then the hour and the sea state; and the output size
    await page.evaluate(({ width, height, lookApi }) => {
      window.__lookApi = lookApi;
      const b = window.__bench, pose = b.pose.bind(b), setSize = b.setSize.bind(b);
      b.setSize = (w, h) => setSize(window.__vistaSize?.[0] ?? width, window.__vistaSize?.[1] ?? height);
      window.__seaChip = label => {
        const chips = [...document.querySelectorAll('button.tw-chip')].filter(c => c.textContent.trim() === label);
        if (chips.length) chips[0].click();
        return chips.length;
      };
      b.pose = name => {
        const [view, hour, sea] = name.split('~');
        pose(view);
        if (hour && hour !== 'own') b.app.settings.timeOfDay = Number(hour);
        // a gf-vista page (kit/host.js) sets the sea through the kit's look slot when asked: the frame comparison
        // checks that look.set() and the core's own panel draw the same pixels
        if (sea) { if (window.__lookApi && window.__vista) window.__vista.look.set({ sea }); else window.__seaChip(sea); }
      };
    }, { width, height, lookApi });
    // one discarded shot first: the first image of a session comes out before the temporal filters and the cloud
    // reprojection have any history (blocky clouds), so every kept shot follows another
    await page.evaluate(a => window.__bench.shots(['pier~16.2~Breezy'], { tag: 'warm', frames: a.frames, dt: a.dt, url: 'http://127.0.0.1:5190/' }), { frames, dt });
    bodies.clear();
    for (const s of shots) {
      const t = Date.now();
      const key = `${s.view}~${s.hour ?? 'own'}~${s.sea}`;
      await page.evaluate(({ key, frames, dt }) => window.__bench.shots([key], { tag: 'v', frames, dt, url: 'http://127.0.0.1:5190/' }), { key, frames, dt });
      const body = bodies.get(`v-${key}.bgra`) ?? bodies.get(encodeURIComponent(`v-${key}.bgra`)) ?? [...bodies.values()].at(-1);
      bodies.clear();
      if (!body) throw new Error('no readback for ' + key);
      const img = fromReadback(body, { bgra: rec.gpu.format.startsWith('bgra') });
      writePng(join(out, s.name + '.png'), img);
      const sha = createHash('sha256').update(img.data).digest('hex').slice(0, 16);
      rec.shots.push({ ...s, file: s.name + '.png', ms: Date.now() - t, rgbaSha: sha });
      log(`${s.name}: ${img.width}x${img.height} ${Date.now() - t} ms`);
    }
    if (bench) {
      const [bw, bh] = String(benchSize).split('x').map(Number);
      await page.evaluate(([w, h]) => { window.__vistaSize = [w, h]; }, [bw, bh]);
      const views = benchViews ?? ['beach', 'pier', 'sunGlitter', 'village', 'underwater', 'aerial', 'palms', 'boatFish', 'boatHelm'];
      const r = await page.evaluate(v => window.__bench.run({ views: v, warm: 90, frames: 120 }), views);
      const times = { tool: rec.tool, tier, size: [bw, bh], gpu: rec.gpu, at: new Date().toISOString(), note: 'core/Bench.js run(): per view, wall = ms per frame back to back (CPU+GPU throughput, at most 2 in flight), gpu = timestamp span of the frame', views: r };
      await writeFile(join(out, `frame-times-${tier}-${bw}x${bh}.json`), JSON.stringify(times, null, 2) + '\n');
      log('frame times', JSON.stringify(r.total));
      rec.bench = r.total;
    }
  } finally { await browser.close(); }
  rec.totalMs = Date.now() - t0;
  await writeFile(join(out, 'shots.json'), JSON.stringify(rec, null, 2) + '\n');
  return rec;
}

if (import.meta.url === `file://${process.argv[1]}`) await capture();
