// The builder's tools: where things are. Every path is absolute; nothing depends on the working directory.
// The repository is laid out in layers (docs/LAYOUT.md): builder/ (the shared system and these tools), runtimes/ (three
// with its profiles, forge, vista), components/ (mechanics), loops/, worlds/. A game sees the three runtime's code as one
// tree, gf/three/, assembled from several of them: GAME_TREE maps each part of a game's tree to its folder here, and
// kitPath() and walkKit() read the three runtime's kit as a game sees it.
import { fileURLToPath, pathToFileURL } from 'node:url';
import pathImpl, { join, resolve, posix } from 'node:path';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';

export const REPO = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
export const BUILDER = join(REPO, 'builder');
export const RUNTIMES = join(REPO, 'runtimes');
export const GF3 = join(RUNTIMES, 'three');
// GF_KIT_DIR points every tool at another copy of the kit, laid out as a game's gf/three/ (a test that adds one throwaway
// mechanic folder and runs catalog, create and verify on it). Unset, the tools use this repository's layers.
export const KIT_DIR_OVERRIDE = process.env.GF_KIT_DIR ? resolve(process.env.GF_KIT_DIR) : null;
export const KIT = KIT_DIR_OVERRIDE ?? join(GF3, 'kit');
export const COMPONENTS = join(REPO, 'components');
export const LOOPS = join(REPO, 'loops');
export const WORLDS = join(REPO, 'worlds');
export const UI = join(BUILDER, 'ui');
export const FLAT_KIT = join(GF3, 'profiles', 'flat-2d');
export const TOOLS = join(BUILDER, 'tools');
export const TOOLS_LIB = join(TOOLS, 'lib');
export const STANDIN_ASSETS = join(TOOLS_LIB, 'standin-assets');
export const SPEC_SCHEMA = join(BUILDER, 'spec', 'game-spec.v2.schema.json');
// The registry: the catalog computed from the manifests (registry/build-catalog.mjs), which create checks a spec against
export const REGISTRY = join(REPO, 'registry');
export const CATALOG = join(REGISTRY, 'catalog.json');
export const KIT_VERSION = '0.1.0-dev';
// The three runtime's scenic-3d profile (CONTRACT §8): its look and world, vendored into a scenic-3d game as gf/scenic/
export const SCENIC = join(GF3, 'profiles', 'scenic-3d');
export const SCENIC_KIT = join(SCENIC, 'kit');
export const SCENIC_VERSION = '0.1.0-dev';
// The forge runtime (CONTRACT §8 forge): a Rust core on WebGPU (and WebGL2), vendored into a forge game as gf/forge/ (host, look, world, players, show, the data tables, the release wasm);
// no three.js, no Rapier (the core's own physics is rapier3d in Rust)
export const FORGE = join(RUNTIMES, 'forge');
export const FORGE_KIT = join(FORGE, 'kit');
export const FORGE_VERSION = '0.10.0-wave8';
// The vista runtime (CONTRACT §8 vista): a vendored WebGPU core (Tidewater at 4811ba48, MIT) for calm games where the
// place is the point, vendored into a vista game as gf/vista/ (kit/, hud/ and
// core/ with its public files, laid out as in gf-vista so every relative import holds); no three.js, no Rapier
export const VISTA = join(RUNTIMES, 'vista');
export const VISTA_KIT = join(VISTA, 'kit');
export const VISTA_VERSION = '0.2.0-thin';

/**
 * Where a game runs (spec v2, builder/spec/game-spec.v2.schema.json): its `runtime` and, for a runtime with profiles,
 * its `profile`. three has three profiles (standard-3d, scenic-3d, flat-2d); forge and vista have none. Which exist and
 * which are open to pitches is the registry's to say (runtimes/<id>/runtime.json); these are the runtimes and profiles
 * this checkout's create and verify can make and judge. → {runtime, profile}
 */
export const PROFILES = { three: ['standard-3d', 'scenic-3d', 'flat-2d'], forge: [], vista: [], godot: ['2d', '3d'] };
export const placeOf = spec => ({ runtime: spec?.runtime ?? null, profile: spec?.profile ?? null });
/** A place as the registry keys its rows: 'three/scenic-3d', 'forge'. */
export const rowOf = p => (p?.profile ? `${p.runtime}/${p.profile}` : p?.runtime ?? null);
/** The three runtime's profiles, by name, for the tools that branch on one. */
export const isScenic = p => p?.runtime === 'three' && p.profile === 'scenic-3d';
export const isFlat = p => p?.runtime === 'three' && p.profile === 'flat-2d';
/** The runtimes whose game carries no three.js: their core draws (gf/forge, gf/vista) and gf/three holds the shared system only. */
export const coreDrawn = p => p?.runtime === 'forge' || p?.runtime === 'vista';

// Pinned third-party sources (runtimes/three/README.md "Pinned"), copied byte for byte into a game's vendor/.
export const VENDOR = {
  // three 0.186.0: the WebGL build (byte-identical to the npm tarball); the curated addons sit in the same folder
  threeBuild: join(GF3, 'vendor', 'three@0.186.0'),
  threeAddons: [join(GF3, 'vendor', 'three@0.186.0')],
  rapier: join(GF3, 'vendor', 'rapier@0.19.2'),
  // three 0.186.0's WebGPU build (three.webgpu.js, three.tsl.js; byte-identical to the npm tarball, the same three.core.js)
  threeWebgpu: join(GF3, 'vendor', 'three@0.186.0'),
  postprocessing: join(GF3, 'vendor', 'postprocessing@6.39.5'),
  n8ao: join(GF3, 'vendor', 'n8ao'),
};
export const GF_ASSETS = join(BUILDER, 'gf-assets', 'source', 'gf-assets.js');
export const GF_AUDIO = join(BUILDER, 'gf-audio');
export const GF_MP = join(BUILDER, 'gf-multiplayer');
export const PARTY = join(BUILDER, 'multiplayer', 'party');

/**
 * The parts of a game's tree that are folders of this repository, longest game path first. A game's gf/three/ is the
 * three runtime's kit with the mechanics (components/), the loops (loops/), the world (worlds/), the menu and HUD
 * (builder/ui/) and the flat profile (runtimes/three/profiles/flat-2d/) inside it, at the places the kit's own relative
 * imports expect; gf/scenic/, gf/forge/ and gf/vista/ are the other runtimes' kits; gf/mp/, gf/gf-assets.js and audio/
 * the shared kits every game vendors.
 */
export const GAME_TREE = [
  ['gf/three/mechanics', COMPONENTS],
  ['gf/three/loops', LOOPS],
  ['gf/three/world', WORLDS],
  ['gf/three/ui', UI],
  ['gf/three/flat', FLAT_KIT],
  ['gf/three', join(GF3, 'kit')],
  ['gf/scenic', join(SCENIC, 'kit')],
  ['gf/forge', join(FORGE, 'kit')],
  ['gf/vista/kit', join(VISTA, 'kit')],
  ['gf/vista/hud', join(VISTA, 'hud')],
  ['gf/vista/core', join(VISTA, 'core')],
  ['gf/godot', join(RUNTIMES, 'godot', 'kit')],
  ['gf/mp', join(GF_MP, 'source')],
  ['gf/gf-assets.js', GF_ASSETS],
  ['audio', join(GF_AUDIO, 'source')],
];
/** The parts of gf/three/ that live in their own layer: [the folder under gf/three/, this repository's folder]. */
export const KIT_PARTS = GAME_TREE.filter(([g]) => g.startsWith('gf/three/')).map(([g, dir]) => [g.slice('gf/three/'.length), dir]);

/** A path in a game's tree (gf/three/core/boot.js) → the file in this repository that a game's copy comes from, or null. */
export function repoFileOf(gameRel) {
  const r = posix.normalize(String(gameRel).split('\\').join('/')).replace(/^\.\//, '');
  for (const [g, dir] of GAME_TREE) if (r === g || r.startsWith(g + '/')) return r === g ? dir : join(dir, ...r.slice(g.length + 1).split('/'));
  return null;
}
/** A file in this repository → its path in a game's tree, or null when no game carries it. */
export function gameRelOf(file) {
  let best = null;
  for (const [g, dir] of GAME_TREE) {
    const rel = file === dir ? '' : below(dir, file);
    if (rel == null) continue;
    if (!best || dir.length > best.dir.length) best = { dir, g, rel };
  }
  return best ? (best.rel ? `${best.g}/${best.rel.split(pathImpl.sep).join('/')}` : best.g) : null;
}

/**
 * A path inside the three runtime's kit as a game sees it (gf/three/<rel>) → the file. `kit` is KIT (this repository's
 * layers) or another folder laid out as a game's gf/three/ (GF_KIT_DIR, a game's own copy), which is read as it is.
 */
export function kitPath(kit, ...rel) {
  const r = posix.normalize(rel.join('/')).replace(/^\.$/, '');
  if (kit !== KIT || KIT_DIR_OVERRIDE) return join(kit, r);
  for (const [part, dir] of KIT_PARTS) if (r === part || r.startsWith(part + '/')) return r === part ? dir : join(dir, r.slice(part.length + 1));
  return join(kit, r);
}

/** Every file of the three runtime's kit as a game sees it (paths under gf/three/), sorted; see walk() for `skip`. */
export async function walkKit(kit = KIT, { skip = () => false } = {}) {
  if (kit !== KIT || KIT_DIR_OVERRIDE) return walk(kit, { skip });
  const out = await walk(kit, { skip: (rel, e) => KIT_PARTS.some(([p]) => rel === p) || skip(rel, e) });
  for (const [part, dir] of KIT_PARTS) for (const rel of await walk(dir, { skip: (r, e) => skip(`${part}/${r}`, e) })) out.push(`${part}/${rel}`);
  return out.sort((a, b) => a.localeCompare(b));
}

export const sha256 = buf => createHash('sha256').update(buf).digest('hex');
export const sha256File = async p => sha256(await readFile(p));

/** Every file under dir (relative paths with /), sorted, skipping node_modules and .git. */
export async function walk(dir, { skip = () => false } = {}, base = dir, out = []) {
  let entries = [];
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return out; }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const p = join(dir, e.name), rel = p.slice(base.length + 1).split('\\').join('/');
    if (skip(rel, e)) continue;
    if (e.isDirectory()) await walk(p, { skip }, base, out);
    else if (e.isFile()) out.push(rel);
  }
  return out;
}

/** Stable JSON: two-space indent, a trailing newline (the same input always gives the same bytes). */
export const json = v => JSON.stringify(v, null, 2) + '\n';

/**
 * Where a made game runs: gf-three.json → kit.runtime and kit.profile (create's record), else what its gf/three/kit.js
 * records. A folder with neither is no game create made; the tools read it as the plain three boot (standard-3d).
 * → {runtime, profile}
 */
export async function placeOfGame(dir) {
  try { const k = JSON.parse(await readFile(join(dir, 'gf-three.json'), 'utf8'))?.kit; if (k?.runtime) return { runtime: k.runtime, profile: k.profile ?? null }; } catch {}
  try {
    const t = await readFile(join(dir, 'gf/three/kit.js'), 'utf8');
    const rt = /"runtime":\s*"([a-z0-9-]+)"/.exec(t)?.[1], pr = /"profile":\s*"([a-z0-9-]+)"/.exec(t)?.[1];
    if (rt) return { runtime: rt, profile: pr ?? null };
  } catch {}
  return { runtime: 'three', profile: 'standard-3d' };
}

/**
 * Chrome for a game's QA pages, on the renderer the game really uses: WebGPU for a scenic-3d game (WebGPURenderer;
 * builder/qa/browser.mjs's headless shell with Vulkan), WebGL on the real GPU for a standard-3d or flat-2d game, software
 * with GF_VERIFY_SOFTWARE=1. A scenic-3d game on a machine whose Chrome finds no WebGPU adapter runs on WebGL (the WebGL2
 * path inside WebGPURenderer) and `note` says so. Pass builder/qa/browser.mjs's launchChrome (this module stays free of
 * Playwright). `place` ({runtime, profile}) when the caller knows it, else the game's record says.
 * → {browser, gpu: 'webgpu' | 'webgl' | 'software', place, note}
 */
export async function launchForGame(launchChrome, dir, { software = !!process.env.GF_VERIFY_SOFTWARE, place = null, ...given } = {}) {
  // a check may play two players on this one machine: real addresses in their WebRTC candidates (builder/qa/browser.mjs
  // LOCAL_WEBRTC_OFF; where mDNS names cannot be looked up, as on a macOS CI runner, the two never connect)
  const rest = { disableFeatures: ['WebRtcHideLocalIpsWithMdns'], ...given };
  const at = place ?? (dir ? await placeOfGame(dir) : { runtime: 'three', profile: 'standard-3d' });
  const plan = rendererFor(at, { software });
  if (plan.gpu === 'software') return { browser: await launchChrome({ ...rest }), gpu: 'software', place: at, note: null };
  if (plan.gpu === 'webgl') return { browser: await launchChrome({ gpu: 'webgl', ...rest }), gpu: 'webgl', place: at, note: null };
  try { return { browser: await launchChrome({ gpu: 'webgpu', ...rest }), gpu: 'webgpu', place: at, note: null }; }
  catch (e) {
    if (e?.name !== 'NoWebGPUError') throw e;
    const why = e.why ?? e.message.split('(')[1]?.split(')')[0] ?? e.message;
    if (plan.withoutWebgpu !== 'webgl') { e.message = `${plan.result} ${e.message}`; throw e; }
    return { browser: await launchChrome({ gpu: 'webgl', ...rest }), gpu: 'webgl', place: at, note: `a scenic-3d game, but this Chrome has no WebGPU adapter (${why}); it ran on WebGL2 inside WebGPURenderer` };
  }
}

/**
 * Which renderer a game's QA pages run on, and what happens on a machine whose Chrome has no WebGPU adapter. The answer
 * is the same on Linux, Windows and macOS: the runtime and profile decide it, and builder/qa/browser.mjs's gpuLaunchPlan()
 * picks the flags and the binary that fit the system (Vulkan in the headless shell on Linux, Chrome's own Direct3D 12 or
 * Metal backend elsewhere). Pure. `place` is {runtime, profile}.
 *   three standard-3d, flat-2d  WebGL on the graphics card. WebGPU is never asked for.
 *   three scenic-3d             WebGPU; without an adapter it runs on WebGL2 inside WebGPURenderer and the verdict says so.
 *   forge                       WebGPU; without an adapter the launch fails with NoWebGPUError (its WebGL2 build is
 *                               measured by its own check, 32).
 *   vista                       WebGPU only (its core has no WebGL path; a browser without one gets the kit's screen).
 *   GF_VERIFY_SOFTWARE=1: any runtime on Chrome's software renderer (never for judging looks).
 * → {gpu: 'webgl' | 'webgpu' | 'software', withoutWebgpu: null | 'webgl' | 'error', result}
 */
export function rendererFor(place, { software = false } = {}) {
  if (software) return { gpu: 'software', withoutWebgpu: null, result: 'Runs on Chrome\'s software renderer (GF_VERIFY_SOFTWARE).' };
  if (place?.runtime === 'forge') return { gpu: 'webgpu', withoutWebgpu: 'error', result: 'A forge game is verified on WebGPU, which this machine\'s Chrome does not give, so it cannot be verified here.' };
  if (place?.runtime === 'vista') return { gpu: 'webgpu', withoutWebgpu: 'error', result: 'A vista game draws only with WebGPU and has no WebGL path, so it cannot be verified on this machine.' };
  if (isScenic(place)) return { gpu: 'webgpu', withoutWebgpu: 'webgl', result: 'A scenic-3d game without a WebGPU adapter runs on WebGL2 inside WebGPURenderer, and the verdict says so.' };
  return { gpu: 'webgl', withoutWebgpu: null, result: 'A three.js game on the standard-3d or flat-2d profile runs on WebGL and never asks for WebGPU.' };
}

/** A path as a verdict or a record writes it: relative to `base`, with forward slashes on every system. */
export const relPosix = (base, p, impl = pathImpl) => impl.relative(base, p).split(impl.sep).join('/');

/**
 * Is `file` inside the folder `base`? → the path below it, in the system's own form, or null (the folder itself, a
 * sibling whose name only starts the same, another drive). The one test for "under this folder": `file.startsWith(base
 * + '/')` is never true on Windows, where the paths Node hands out have backslashes (a scenic `create` failed there on
 * the first Windows run, 2026-10-11: kit-import.mjs never mapped gf-scenic/three/ to the kit).
 */
export function below(base, file, impl = pathImpl) {
  const rel = impl.relative(base, file);
  return rel && !impl.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + impl.sep) ? rel : null;
}

/**
 * Import a module of a part of the repository that a checkout may not carry (the forge runtime, the watch relay, the
 * world server, the character bench): by path at the moment it is needed, with a plain error when it is absent.
 * `what` names the part for the person ("the forge runtime").
 */
export async function importPart(file, what) {
  if (!existsSync(file)) { const e = new Error(`${what} is not in this checkout (${relPosix(REPO, file)} is missing)`); e.code = 'GF_PART_MISSING'; throw e; }
  return import(pathToFileURL(file).href);
}
