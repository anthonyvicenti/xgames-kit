// Where things are in an xgames-kit checkout, and path helpers that behave the same on Windows, macOS and Linux.
// Every path here is absolute and built with node:path; nothing depends on the working directory.
// The layers (docs/LAYOUT.md): builder/ the shared system (this CLI, the MCP server, the studio page, the tools that
// create and verify a game, the kits every game vendors), registry/ the catalog, runtimes/ what runs a game (three with its profiles, forge,
// vista), components/ the mechanics, loops/, worlds/, examples/, and games/ (yours).
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const KIT_ROOT = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
export const BUILDER = path.join(KIT_ROOT, 'builder');
export const RUNTIMES = path.join(KIT_ROOT, 'runtimes');
export const GF3 = path.join(RUNTIMES, 'three');
export const GF3_TOOLS = path.join(BUILDER, 'tools');
export const FLAT_KIT = path.join(GF3, 'profiles', 'flat-2d');
export const SPEC_DIR = path.join(BUILDER, 'spec');
export const SPEC_SCHEMA = path.join(SPEC_DIR, 'game-spec.v2.schema.json');
export const PITCH_SCHEMA = path.join(SPEC_DIR, 'pitch.v2.schema.json');
// the registry: the catalog computed from the manifests (registry/build-catalog.mjs writes it)
export const REGISTRY = path.join(KIT_ROOT, 'registry');
export const CATALOG = path.join(REGISTRY, 'catalog.json');
export const GF_MP = path.join(BUILDER, 'gf-multiplayer');
export const SIGNAL_SERVER = path.join(BUILDER, 'multiplayer', 'p2p', 'signal-server.mjs');
export const QA_BROWSER = path.join(BUILDER, 'qa', 'browser.mjs');
export const TEMPLATES = path.join(BUILDER, 'templates');
export const EXAMPLES_ROOT = path.join(KIT_ROOT, 'examples');
/** The example folders, each holding one folder per example: minimal (one idea, one check) and showcase (a quality bar). */
export const EXAMPLE_SETS = ['minimal', 'showcase'].map(set => path.join(EXAMPLES_ROOT, set));
export const EXAMPLES = EXAMPLE_SETS[0];
export const GAME_TEMPLATE = path.join(TEMPLATES, 'game');
export const GAMES = path.join(KIT_ROOT, 'games');
export const STATE = path.join(KIT_ROOT, '.gamesfun');
export const STUDIO = path.join(BUILDER, 'studio');
export const BIN = path.join(KIT_ROOT, 'bin', 'gamesfun.mjs');

/** A path with forward slashes (for display, JSON and comparisons across platforms). */
export const toPosix = p => String(p).split(path.sep).join('/').split('\\').join('/');

/** Is `p` the folder `base` or inside it? Both are resolved first; `impl` is node:path or path.win32 (tests). */
export function isInside(base, p, impl = path) {
  const rel = impl.relative(impl.resolve(base), impl.resolve(p));
  return rel === '' || (!rel.startsWith('..') && !impl.isAbsolute(rel));
}

// Windows device names: opening one (even as "con.txt") talks to a device, not a file.
const DEVICE = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)(\..*)?$/i;

/**
 * Map a URL path (the part after the mount point, e.g. "/gf/three/core/boot.js") to a file inside `base`, or null.
 * Refuses anything that could escape `base` or reach something it shouldn't, on any platform:
 *   - "..", "." and empty-after-decoding segments, encoded slashes or backslashes (%2f, %5c), NUL;
 *   - drive letters, UNC and alternate data streams (anything with ":"), Windows device names, names ending in a dot
 *     or a space (Windows strips them, so "index.html." would be "index.html");
 *   - dotfiles and dot-folders (.env, .git): never served.
 * `impl` is node:path (default) or path.win32 / path.posix, so tests can check Windows behaviour on any machine.
 */
export function resolveInside(base, urlPath, impl = path) {
  if (typeof urlPath !== 'string') return null;
  const raw = urlPath.split('/');
  const parts = [];
  for (const seg of raw) {
    if (seg === '') continue;
    let s;
    try { s = decodeURIComponent(seg); } catch { return null; }
    if (s === '' || s === '.' || s === '..') return null;
    if (/[\\/\0:]/.test(s)) return null;
    if (s.startsWith('.')) return null;
    if (/[. ]$/.test(s)) return null;
    if (DEVICE.test(s)) return null;
    if (/[<>"|?*\x00-\x1f]/.test(s)) return null;
    parts.push(s);
  }
  const root = impl.resolve(base);
  const file = impl.join(root, ...parts);
  return isInside(root, file, impl) ? file : null;
}
