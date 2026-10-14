// gf-vista's JS host (research/super-scenic/PLAN.md §3): boots the vendored core (core/, a WebGPU engine credited in UPSTREAM.json
// at 4811ba48, MIT) and is the one seam between it and the shared system: where the core reads its files from
// (vista-io), the look values as slots (look.js), the observation interface verify reads (observe.js), and the
// remote players drawn as gf-humanoid-1 characters (players.js). Vendored into a game as gf/vista/ (never edited there).
//
//   const vista = await createVista({ base, reader, look: { hour: 'golden', sea: 'calm' } });
//   vista.look.set({ hour: 18.4 }); vista.observe.snapshot(); vista.app (the core's App)
//
// WebGPU only (creator, 2026-10-12): without an adapter createVista throws NoWebGPU and draws nothing; the boot shows
// the kit's "open in a browser with WebGPU" screen (noWebGPUScreen below).
//
// ?bench (the core's own reference mode: seeded random, the render loop stopped, core/src/core/Bench.js on
// window.__bench) works here exactly as in the upstream page, so tools/ref-capture.mjs and tools/frame-compare.mjs
// drive this host and the reference build with the same sequence.
import '../core/src/core/BenchSeed.js';   // first: seeds Math.random under ?bench before any module draws from it
import { App } from '../core/src/App.js';
import { UI } from '../core/src/ui/UI.js';
import { AppUI } from '../core/src/ui/AppUI.js';
import { setBase, setReader, setClouds, setPlace } from '../core/src/vista-io.js';
import { createLook } from './look.js';
import { createObserve } from './observe.js';
import { NoWebGPU, MIN_LIMITS, probeWebGPU, noWebGPUScreen } from './gpu.js';

export { NoWebGPU, MIN_LIMITS, probeWebGPU, noWebGPUScreen };

export const VERSION = '0.1.0-wave1';
/** Where the core comes from: its own record (name, link, commit, licence), beside the kit. */
export { default as UPSTREAM } from '../UPSTREAM.json' with { type: 'json' };

/** The most canvas pixels a frame draws (a 3840x2160 screen at 1:1): above it the canvas stays at this budget. */
export const MAX_PIXELS = 3840 * 2160;
/**
 * The canvas follows the screen's real pixels. The core sizes its canvas from the window in CSS pixels times its own
 * scale (core/src/engine/Engine.js resize: `renderScale`, 1), never the device pixel ratio, so on a zoomed page or a
 * scaled display it drew a small picture the browser stretched (the creator's Glass Bay screenshot, 2026-10-12, had a
 * tenth of the reference's fine detail; the same camera at 1:1 matched it). Here each resize first sets the scale to the
 * device pixel ratio, capped so a frame never draws more than MAX_PIXELS. No core change: the engine's own resize runs.
 */
export function pixelScale(w = innerWidth, h = innerHeight, dpr = globalThis.devicePixelRatio || 1) {
  return Math.max(0.25, Math.min(dpr, Math.sqrt(MAX_PIXELS / Math.max(1, w * h))));
}
function followPixelRatio(app) {
  const eng = app.engine, resize = eng.resize.bind(eng);
  eng.resize = () => { eng.renderScale = pixelScale(); resize(); };
  // a zoom or a move to another screen changes the ratio; a resize event does not always follow
  const watch = () => { const m = matchMedia(`(resolution: ${globalThis.devicePixelRatio || 1}dppx)`); m.addEventListener?.('change', () => { eng.resize(); watch(); }, { once: true }); };
  watch();
  eng.resize();
}

/**
 * Boot the core. Options:
 *   base     where the core's files live (default: this kit's core/public/, beside host.js)
 *   reader   fn(path) → Promise<Response>: read every core file through it instead (gf-assets in a game)
 *   look     initial look values {hour, sea, exposure} (look.js); left out: the core's defaults
 *   panel    true: the core's own settings panel and HUD (AppUI); the sandbox keeps it, games get the shared HUD
 *   ui       true: the core's own DOM layer (UI.js: its loader, brand, HUD shell). false: none of it is built, so
 *            nothing of the upstream game's own interface (or its name) reaches the page; loading progress goes to
 *            onProgress only, and `panel` is ignored. Games made by create use ui: false (the shared menu and HUD).
 *   start    true: run the render loop when ready (false under ?bench: the bench drives the frames)
 *   clouds   'volumetric' (sky-pro-webgpu's cumulus, the default) or 'basic' (the core's own MIT Clouds.js: a copy of
 *            the core that ships without the sky-pro files, e.g. the open-source kit)
 *   place    the island to build: a place recipe (kit/world/places.js placeRecipe(seed, words)); null: the core's own
 *            island (the reference, unchanged)
 *   onProgress(p 0..1, text)
 */
export async function createVista({ base = new URL('../core/public/', import.meta.url).pathname, reader = null, look = null, panel = true, ui: withUi = true, start = true, clouds = 'volumetric', place = null, onProgress = null } = {}) {
  const gpu = await probeWebGPU();
  if (!gpu.ok) throw new NoWebGPU(gpu.why, gpu.kind);
  setBase(base);
  if (reader) setReader(reader);
  setClouds(clouds);
  setPlace(place);
  const bench = /[?&]bench\b/.test(location.search);
  if (bench) {
    // the upstream page's background-tab shim: rAF does not fire in a hidden page (automation)
    const raf = window.requestAnimationFrame.bind(window), caf = window.cancelAnimationFrame.bind(window);
    window.requestAnimationFrame = cb => document.visibilityState === 'hidden' ? setTimeout(() => cb(performance.now()), 16) : raf(cb);
    window.cancelAnimationFrame = id => (clearTimeout(id), caf(id));
  }
  const t0 = performance.now();
  const ui = withUi ? new UI() : null;
  const app = new App();
  await app.init((p, text, until) => { ui?.setLoading(p, text, until); onProgress?.(p, text); });
  if (ui && panel) app.ui = new AppUI(app, ui);
  followPixelRatio(app);
  const lk = createLook(app);
  if (look) lk.set(look);
  if (ui) { ui.setLoading(1, 'Ready'); await ui.hideLoader(); }
  onProgress?.(1, 'Ready');
  const vista = { VERSION, app, ui, look: lk, gpu: gpu.info, bench, readyMs: Math.round(performance.now() - t0), started: false };
  vista.observe = createObserve(vista);
  if (bench) window.__bench = new (await import('../core/src/core/Bench.js')).Bench(app);
  else if (start) { app.start(); vista.started = true; }
  return vista;
}
