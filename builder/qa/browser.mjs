// Portable Chrome launcher for trial qa.mjs scripts (Linux, macOS, Windows).
// Older trials hard-code a Windows Chrome path; new trials should use this instead:
//   import { launchChrome } from '../../qa/browser.mjs';
//   const browser = await launchChrome();            // headless by default
//   const browser = await launchChrome({ gpu: 'webgl' });    // WebGL on the real GPU (ANGLE on OpenGL; never Vulkan here, see below)
//   const browser = await launchChrome({ gpu: 'webgpu' });   // a WebGPU game (assets.json runtime.gpu), see below
// Playwright is imported by package name (`playwright`, then `playwright-core`: research/package.json pins it, and a
// checkout outside games.fun installs it at its own root), then from research/pipeline/node_modules, where this repo
// has always kept it (`cd research/pipeline && npm ci`). GF_PLAYWRIGHT names another copy (a package name or a file);
// or pass `chromium` (a Playwright BrowserType; the Studio worker's container has its own in /opt/deps).
// Override the binary with CHROME_PATH; set HEADED=1 to watch; CHROME_ARGS adds launch flags.
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path, { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Where Chrome, Chromium and Edge live on each system, most preferred first: [{path, kind}]. Pure: the platform, the
 * environment and the home folder come in, paths go out (so the Windows and macOS lists are checked from any system).
 *   Windows  Program Files, Program Files (x86) and the per-user install (%LOCALAPPDATA%): Chrome, Edge, Chromium
 *   macOS    /Applications and ~/Applications: Chrome, Edge, Chromium
 *   Linux    the distribution's packages, /opt and the snap: Chrome, Chromium, Edge
 */
export function chromeCandidates({ platform = process.platform, env = process.env, home = homedir() } = {}) {
  const out = [], add = (p, kind) => out.push({ path: p, kind });
  if (platform === 'win32') {
    const w = path.win32;
    const roots = [env.PROGRAMFILES ?? 'C:\\Program Files', env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)', env.LOCALAPPDATA ?? w.join(home, 'AppData', 'Local')];
    for (const r of roots) add(w.join(r, 'Google', 'Chrome', 'Application', 'chrome.exe'), 'chrome');
    for (const r of roots) add(w.join(r, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), 'edge');
    for (const r of roots) add(w.join(r, 'Chromium', 'Application', 'chrome.exe'), 'chromium');
  } else if (platform === 'darwin') {
    for (const base of ['/Applications', path.posix.join(home, 'Applications')]) {
      add(`${base}/Google Chrome.app/Contents/MacOS/Google Chrome`, 'chrome');
      add(`${base}/Microsoft Edge.app/Contents/MacOS/Microsoft Edge`, 'edge');
      add(`${base}/Chromium.app/Contents/MacOS/Chromium`, 'chromium');
    }
  } else {
    for (const p of ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome']) add(p, 'chrome');
    for (const p of ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium']) add(p, 'chromium');
    for (const p of ['/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable', '/opt/microsoft/msedge/msedge']) add(p, 'edge');
  }
  return out;
}
const isFile = p => { try { return statSync(p).isFile(); } catch { return false; } };

/** The browser to drive: CHROME_PATH when it exists, else the first installed candidate. → {path, kind, source} or null */
export function findChrome({ platform = process.platform, env = process.env, home = homedir(), exists = isFile } = {}) {
  if (env.CHROME_PATH && exists(env.CHROME_PATH)) return { path: env.CHROME_PATH, kind: 'chrome', source: 'CHROME_PATH' };
  for (const c of chromeCandidates({ platform, env, home })) if (exists(c.path)) return { ...c, source: 'installed' };
  for (const n of PATH_NAMES[platform] ?? PATH_NAMES.linux) { const p = onPath(n, { platform, env, exists }); if (p) return { path: p, kind: /edge/.test(n) ? 'edge' : /chromium/.test(n) ? 'chromium' : 'chrome', source: 'PATH' }; }
  return null;
}
/** Program names looked for on PATH when the usual places are empty (a Nix, Homebrew or portable install). */
const PATH_NAMES = { win32: ['chrome', 'msedge'], darwin: [], linux: ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge'] };
/** A program on PATH, found without a shell (PATHEXT on Windows). → its path or null */
export function onPath(name, { platform = process.platform, env = process.env, exists = isFile } = {}) {
  const impl = platform === 'win32' ? path.win32 : path.posix;
  const dirs = (env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : ':').filter(Boolean);
  const exts = platform === 'win32' ? (env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').filter(Boolean) : [''];
  for (const d of dirs) for (const e of exts) for (const p of new Set([impl.join(d, name + e.toLowerCase()), impl.join(d, name + e)])) if (exists(p)) return p;
  return null;
}

export function chromePath(opts) {
  return findChrome(opts)?.path; // undefined → Playwright's bundled chromium
}

/** Where Playwright is looked for, in order: [{spec, why}]. `here` is this module's URL. */
export function playwrightCandidates({ env = process.env, here = import.meta.url } = {}) {
  const out = [], named = env.GF_PLAYWRIGHT;
  if (named) out.push({ spec: /^\.|^\/|^[A-Za-z]:[\\/]/.test(named) ? pathToFileURL(path.resolve(named)).href : named, why: 'GF_PLAYWRIGHT' });
  out.push({ spec: 'playwright', why: 'the playwright package' }, { spec: 'playwright-core', why: 'the playwright-core package' });
  out.push({ spec: new URL('../../pipeline/node_modules/playwright/index.mjs', here).href, why: 'research/pipeline/node_modules (games.fun)' });
  return out;
}
let playwrightChromium = null;
/** Playwright's `chromium`, from the first candidate that is installed. `load` is import() (tests pass their own). */
export async function loadChromium({ env = process.env, load = null, here = import.meta.url } = {}) {
  if (!load && playwrightChromium) return playwrightChromium;
  const tried = [];
  for (const c of playwrightCandidates({ env, here })) {
    let m;
    try { m = await (load ?? (spec => import(spec)))(c.spec); }
    catch (e) {
      // only "not installed" moves on to the next place; a copy that is there and broken is reported as it is
      if (e?.code !== 'ERR_MODULE_NOT_FOUND' && e?.code !== 'MODULE_NOT_FOUND') throw e;
      tried.push(c.why); continue;
    }
    const chromium = m.chromium ?? m.default?.chromium;
    if (!chromium) throw new Error(`${c.why} loaded, but it has no \`chromium\` export`);
    if (!load) playwrightChromium = chromium;
    return chromium;
  }
  throw new Error(`Playwright is not installed (looked for: ${tried.join('; ')}). Run \`npm ci\` in research/ (it pins playwright-core) or in research/pipeline, or set GF_PLAYWRIGHT to a copy.`);
}

// WebGPU (manifest v1.3 `runtime.gpu: "webgpu"`, creator-studio/docs/asset-manifest.md). Measured 2026-10-01 on the
// desktop NVIDIA GPU host (driver 595.84, Linux, Playwright 1.63) by clearing a WebGPU canvas to red and reading the screenshot:
//   Chrome 148, any headless flags                   no adapter, or (--enable-unsafe-webgpu) only the CPU fallback
//                                                    adapter that tidewater hangs on; with --use-angle=vulkan
//                                                    --enable-features=Vulkan it gets the NVIDIA adapter, but
//                                                    headless Chrome composites in software and the canvas comes out
//                                                    empty (transparent in screenshots, zeros on readback)
//   chrome-headless-shell 151 / 1243 + WEBGPU_ARGS   NVIDIA "blackwell" adapter on the first try, canvas red in the
//                                                    screenshot (host, and the worker image with the GPU passed in)
//   headed Chrome 148 + --enable-features=Vulkan     works too (tidewater's pilot), but opens a window
// Both flags are needed (either alone: no adapter). --disable-vulkan-surface: with no X display (the worker's
// container) the shell finds no adapter without it. Playwright's own --enable-features=CDPScreenshotNewSurface is
// repeated because Chrome keeps only the last --enable-features. No display or Xvfb is needed.
export const WEBGPU_ARGS = ['--use-angle=vulkan', '--enable-features=Vulkan,CDPScreenshotNewSurface', '--disable-vulkan-surface'];
// WebGL on the real GPU (launchChrome({gpu: 'webgl'}), or these flags in CHROME_ARGS): ANGLE on OpenGL, which is what
// desktop Chrome on Linux uses by default. Do NOT add --use-angle=vulkan for WebGL. Measured 2026-10-02 on the desktop NVIDIA GPU
// host (driver 595.84, Chrome 148, headless and headless shell alike): with it, Chrome's GPU process segfaults
// (exit_code=139) while linking some three.js programs. The page logs "THREE.WebGLProgram: Shader Error 0 -
// VALIDATE_STATUS false" with an empty info log, then CONTEXT_LOST_WEBGL, and after repeated crashes "Web page caused
// context loss and was blocked". The scene renders white or black (starfall, leonida-stories; 0 errors on OpenGL or
// SwiftShader). Many Chromes sharing the GPU at once made it worse.
export const WEBGL_GPU_ARGS = ['--enable-gpu', '--ignore-gpu-blocklist'];
/** Console text that means Chrome's GPU process or driver failed WebGL, not the game (see WEBGL_GPU_ARGS). */
export const GPU_TROUBLE = /CONTEXT_LOST_WEBGL|context loss and was blocked|Could not create a WebGL context|Shader Error \d+ - VALIDATE_STATUS false[\s\S]*Program Info Log:\s*$/;
let warnedVulkan = false;
const WEBGPU_HEADED_ARGS = ['--enable-features=Vulkan,CDPScreenshotNewSurface'];   // + --use-angle=vulkan breaks WebGL headed here
/**
 * The launch flags and the kind of binary for a renderer on a system. Pure, so each system's row is checked anywhere.
 *   Linux    WebGL: ANGLE on OpenGL (WEBGL_GPU_ARGS). WebGPU: Vulkan, in chrome-headless-shell when headless
 *            (WEBGPU_ARGS, measured above); headed, the installed Chrome.
 *   Windows  WebGL: the same two flags (Chrome's own choice there is ANGLE on Direct3D 11). WebGPU: Chrome's default
 *            backend (Direct3D 12) in the installed Chrome or Edge. The Vulkan flags are never passed: they select a
 *            backend Chrome does not use on Windows.
 *   macOS    WebGL: the same two flags (ANGLE on Metal). WebGPU: Chrome's default backend (Metal), installed Chrome.
 * `measured` is false for Windows and macOS: those rows follow Chrome's documented defaults and have not been run on a
 * machine yet (research/open-builder, track M1-C runs them). → {args, binary: 'shell' | 'chrome', backend, measured}
 */
export function gpuLaunchPlan({ gpu, headless = true, platform = process.platform } = {}) {
  if (gpu !== 'webgl' && gpu !== 'webgpu') throw new Error(`gpu must be "webgl" or "webgpu" (got ${JSON.stringify(gpu)})`);
  const linux = platform !== 'win32' && platform !== 'darwin';
  if (gpu === 'webgl') return { args: [...WEBGL_GPU_ARGS], binary: 'chrome', backend: linux ? 'ANGLE on OpenGL' : platform === 'win32' ? 'ANGLE on Direct3D 11' : 'ANGLE on Metal', measured: linux };
  if (linux) return { args: [...(headless ? WEBGPU_ARGS : WEBGPU_HEADED_ARGS)], binary: headless ? 'shell' : 'chrome', backend: 'Vulkan', measured: true };
  return { args: [...WEBGL_GPU_ARGS], binary: 'chrome', backend: platform === 'win32' ? 'Direct3D 12' : 'Metal', measured: false };
}
/** What to tell a person whose Chrome found no hardware WebGPU adapter, by system. */
export function webgpuHelp(platform = process.platform) {
  if (platform === 'win32') return 'It needs a graphics card with a Direct3D 12 driver and a current Chrome or Edge (chrome://gpu shows "WebGPU: Hardware accelerated"); a remote desktop or a virtual machine without a graphics card has none.';
  if (platform === 'darwin') return 'It needs a current Chrome (Metal; chrome://gpu shows "WebGPU: Hardware accelerated"); a virtual machine without a graphics card has none.';
  return 'It needs a GPU with a Vulkan driver (vulkaninfo lists it); in Docker, pass the GPU through (--device nvidia.com/gpu=all).';
}
export class NoWebGPUError extends Error { constructor(message) { super(message); this.name = 'NoWebGPUError'; } }
/** The GPU a game's assets.json asks for: 'webgpu' (runtime.gpu) or null (any renderer, SwiftShader is fine). */
export const manifestGpu = m => (m?.runtime?.gpu === 'webgpu' ? 'webgpu' : null);

/** Playwright's chrome-headless-shell: CHROME_HEADLESS_SHELL, else the newest in the Playwright browser cache
 *  (`npx playwright install chromium-headless-shell`; /ms-playwright in the worker image), else undefined. */
export function headlessShellPath() {
  if (process.env.CHROME_HEADLESS_SHELL) return process.env.CHROME_HEADLESS_SHELL;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || (process.platform === 'darwin' ? join(homedir(), 'Library/Caches/ms-playwright')
    : process.platform === 'win32' ? join(process.env.LOCALAPPDATA ?? homedir(), 'ms-playwright') : join(homedir(), '.cache/ms-playwright'));
  let dirs = [];
  try { dirs = readdirSync(root).filter(d => /^chromium_headless_shell-\d+$/.test(d)).sort((a, b) => b.split('-')[1] - a.split('-')[1]); } catch { return undefined; }
  const bins = ['chrome-headless-shell-linux64/chrome-headless-shell', 'chrome-headless-shell-mac-arm64/chrome-headless-shell', 'chrome-headless-shell-mac-x64/chrome-headless-shell', 'chrome-headless-shell-win64/chrome-headless-shell.exe'];
  for (const d of dirs) for (const b of bins) if (existsSync(join(root, d, b))) return join(root, d, b);
  return undefined;
}

/**
 * Asks a fresh page of `browser` for a WebGPU adapter: {ok, vendor, architecture, description, fallback, tries, ms}.
 * ok is false, with `why`, when there is none or only a CPU fallback adapter. Right after launch the first
 * requestAdapter() can come back null while the GPU process starts (headless Chrome: "A valid external Instance
 * reference no longer exists"; the next call 250 ms later succeeds), so null is retried until `timeoutMs`.
 */
export async function webgpuAdapter(browser, { timeoutMs = Number(process.env.GF_WEBGPU_PROBE_MS ?? 3000) } = {}) {
  const t0 = Date.now(), page = await browser.newPage();
  try {
    // navigator.gpu exists only in a secure context; a routed loopback URL is one, with no server or HTTPS upgrade.
    await page.route('http://127.0.0.1/__gf-webgpu-probe', r => r.fulfill({ contentType: 'text/html', body: '<!doctype html><title>WebGPU probe</title>' }));
    await page.goto('http://127.0.0.1/__gf-webgpu-probe');
    const r = await page.evaluate(async ms => {
      if (!navigator.gpu) return { ok: false, tries: 0, why: 'navigator.gpu is missing (WebGPU is off in this browser)' };
      let a = null, tries = 0;
      for (const t0 = performance.now(); !a && (tries === 0 || performance.now() - t0 < ms);) { tries++; a = await navigator.gpu.requestAdapter(); if (!a) await new Promise(ok => setTimeout(ok, 250)); }
      if (!a) return { ok: false, tries, why: 'requestAdapter() returned no adapter' };
      const i = a.info ?? {}, fallback = !!(i.isFallbackAdapter ?? a.isFallbackAdapter) || i.architecture === 'swiftshader';
      return { ok: !fallback, tries, vendor: i.vendor, architecture: i.architecture, description: i.description, fallback, ...(fallback ? { why: `only a CPU fallback adapter (${i.vendor}/${i.architecture})` } : {}) };
    }, timeoutMs);
    return { ...r, ms: Date.now() - t0 };
  } finally { await page.close().catch(() => {}); }
}

/**
 * gf-forge's WebGL2 build (gf-forge, wave 3 track W): with GF_FORGE_BACKEND=webgl2 in the environment, every
 * tool that asks for a WebGPU Chrome gets a Chrome with WebGL on the real GPU instead, and every page it opens is told
 * there is no WebGPU, so a forge game's loader picks its WebGL2 build there. It is how a whole verify (and measure,
 * capture, the gate) runs on the WebGL2 build without a line changed in those tools. On this host it also needs
 * CHROME_ARGS="--use-gl=angle --use-angle=gl-egl" and __EGL_VENDOR_LIBRARY_FILENAMES=/usr/share/glvnd/egl_vendor.d/10_nvidia.json.
 */
export const forgeWebgl2 = () => /^webgl2?$/.test(process.env.GF_FORGE_BACKEND ?? '');
const HIDE_WEBGPU = () => { try { Object.defineProperty(Navigator.prototype, 'gpu', { get: () => undefined, configurable: true }); } catch {} };
function withoutWebgpu(browser) {
  const newContext = browser.newContext.bind(browser);
  browser.newContext = async (...a) => { const ctx = await newContext(...a); await ctx.addInitScript(HIDE_WEBGPU); return ctx; };
  // (a page asked of the browser itself lives in a context of its own that goes when the page does)
  browser.newPage = async (...a) => { const ctx = await browser.newContext(...a), page = await ctx.newPage(); page.once('close', () => ctx.close().catch(() => {})); return page; };
  browser.forgeBackend = 'webgl2';
  return browser;
}

/**
 * Two pages of one browser reach each other over WebRTC by a host candidate, and Chrome hides a machine's addresses
 * in those behind mDNS names (<uuid>.local) that the other side has to look up by multicast. Where that lookup does
 * not work, two players on one machine never connect: on GitHub's macOS runner (2026-10-11) the connection stayed
 * "new" until the kit gave up after 20 s, with every signaling message delivered, and the same two connections were
 * up in 0.1 s with real addresses. Every QA browser that plays two players on one machine launches with this feature
 * off (`launchChrome({ disableFeatures: LOCAL_WEBRTC_OFF })`). It changes nothing a page can see.
 */
export const LOCAL_WEBRTC_OFF = ['WebRtcHideLocalIpsWithMdns'];
/** The value of the last --disable-features of a command line (Chrome keeps only the last), as a list. Pure. */
export const disabledFeaturesIn = args => (args ?? []).filter(a => typeof a === 'string' && a.startsWith('--disable-features=')).at(-1)?.slice('--disable-features='.length).split(',').filter(Boolean) ?? [];
/** One --disable-features switch holding Playwright's features and ours, each once. Pure. */
export const disableFeaturesArg = (theirs, ours) => `--disable-features=${[...new Set([...(theirs ?? []), ...(ours ?? [])])].join(',')}`;
let playwrightDisabled = null;
/**
 * The features Playwright itself switches off in the Chrome it launches, read from a browser it launched (the list is
 * not part of its API and changes between versions). Chrome keeps only the LAST --disable-features switch, so a flag
 * of ours has to repeat Playwright's or it would switch them all back on (as with --enable-features, see WEBGPU_ARGS).
 * Asked once per process, from a plain launch that is closed again; [] when the browser will not say.
 */
async function playwrightDisabledFeatures(chromium, launch) {
  if (playwrightDisabled) return playwrightDisabled;
  let browser = null;
  try {
    browser = await chromium.launch(launch);
    const session = await browser.newBrowserCDPSession();
    playwrightDisabled = disabledFeaturesIn((await session.send('Browser.getBrowserCommandLine')).arguments);
  } catch { playwrightDisabled = []; }
  finally { await browser?.close().catch(() => {}); }
  return playwrightDisabled;
}

export async function launchChrome(options = {}) {
  const { disableFeatures = null, ...opts } = options;
  if (disableFeatures?.length) {
    const chromium = opts.chromium ?? await loadChromium();
    const theirs = await playwrightDisabledFeatures(chromium, { executablePath: 'executablePath' in opts ? opts.executablePath : chromePath(), headless: true });
    return launchChrome({ ...opts, args: [...(opts.args ?? []), disableFeaturesArg(theirs, disableFeatures)] });
  }
  const { gpu: asked = null, chromium: browserType, ...rest } = opts;
  const gpu = asked === 'webgpu' && forgeWebgl2() ? 'webgl' : asked;
  // (the same binary the WebGPU kind uses, chrome-headless-shell, so a run differs by the backend alone: installed
  // Chrome's headless mode asks for a favicon, which is a console error on a page without one, and slows hidden pages)
  if (gpu !== asked) return withoutWebgpu(await launchChrome({ ...((rest.headless ?? process.env.HEADED !== '1') && headlessShellPath() ? { executablePath: headlessShellPath() } : {}), ...options, gpu }));
  const chromium = browserType ?? await loadChromium();
  // CHROME_ARGS adds flags, e.g. "--enable-gpu --ignore-gpu-blocklist" for WebGL games that fail on software GL.
  const extra = (process.env.CHROME_ARGS ?? '').split(/\s+/).filter(Boolean);
  const headless = rest.headless ?? process.env.HEADED !== '1';
  if (gpu !== 'webgpu' && !warnedVulkan && [...extra, ...(rest.args ?? [])].includes('--use-angle=vulkan')) {
    warnedVulkan = true;
    console.warn('launchChrome: --use-angle=vulkan for WebGL crashes Chrome\'s GPU process on some shaders on this host (white or black page); use gpu: "webgl" or CHROME_ARGS="--enable-gpu --ignore-gpu-blocklist" (builder/qa/browser.mjs WEBGL_GPU_ARGS)');
  }
  if (!gpu) return chromium.launch({ executablePath: chromePath(), headless, ...rest, args: [...(rest.args ?? []), ...extra] });
  if (gpu !== 'webgl' && gpu !== 'webgpu') throw new Error(`launchChrome: gpu must be "webgl" or "webgpu" (got ${JSON.stringify(gpu)})`);
  const plan = gpuLaunchPlan({ gpu, headless });
  if (gpu === 'webgl') return chromium.launch({ executablePath: chromePath(), headless, ...rest, args: [...plan.args, ...(rest.args ?? []), ...extra] });
  // Linux headless: chrome-headless-shell (see above). Otherwise the installed Chrome. A binary the caller names wins.
  const executablePath = 'executablePath' in rest ? rest.executablePath : plan.binary === 'shell' ? headlessShellPath() : chromePath();
  const browser = await chromium.launch({ ...rest, executablePath, headless, args: [...plan.args, ...(rest.args ?? []), ...extra] });
  // A hardware adapter or nothing: a game that needs WebGPU fails here at once instead of hanging on its error card.
  const adapter = await webgpuAdapter(browser).catch(e => ({ ok: false, why: e.message.split('\n')[0] }));
  if (!adapter.ok) {
    await browser.close().catch(() => {});
    throw Object.assign(new NoWebGPUError(`needs WebGPU: Chrome found no hardware WebGPU adapter (${adapter.why}). ${webgpuHelp()}`), { why: adapter.why });
  }
  browser.webgpu = { ...adapter, executablePath: executablePath ?? 'playwright default' };   // for reports
  return browser;
}
