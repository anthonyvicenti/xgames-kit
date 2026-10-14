// Declared engine overrides (CONTRACT §1.7). The creator chose, 2026-10-12, "Let the build write engine code"
// (research/foundations/evidence/creator-builds-write-engine-code-2026-10-12.json): when a game needs the engine itself to
// change (a vista core file, a kit module), the build edits the game's vendored kit file in place and declares the edit in
// the game's gf-three.json:
//
//   "overrides": { "gf/three/core/input.js": { "base": "<sha256 of the release's file>", "why": "<one sentence>" } }
//
// Gate A (measure 2, tools/lib/kit-check.mjs) holds every kit file to its release: the file matches the release, or it is a
// declared override whose base is the release's file. An undeclared edit fails, and so does a declared one whose base is
// no release's file; each failure names the file and the fix. create keeps a declared override's bytes; when
// the kit moved the file on since its base, they stop and name the override that needs a rebase (overrideConflicts).
// The kit's guard (kit/core/guard.js) counts a declared override as the kit's code and an undeclared edit as the game's.
//
// Some files are never overridable (NEVER): the guard and its refusals (the guard finds the game's folder, ROOT, from its
// own URL, so it is the one file that says what is the game's), the kit copy's own record, every licence, the multiplayer
// kit (gf/mp, held to gf-multiplayer's own frozen releases), and forge's prebuilt core (agents never run cargo: forge's
// overrides cover its JS layer only).
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** Where a game path's kit lives: [prefix, part] (part: a kit-releases part, or a vendored kit held to its own sums). */
export const KIT_ROOTS = [['gf/three/', 'three'], ['gf/scenic/', 'scenic'], ['gf/forge/', 'forge'], ['gf/vista/', 'vista'], ['gf/mp/', 'mp'], ['gf/gf-assets.js', 'gf-assets'], ['audio/', 'audio'], ['vendor/', 'vendor']];
/** Is this game path one of the kit's copies (gf/, audio/, vendor/)? The guard's KIT_DIRS. */
export const isKitPath = p => /^(gf|audio|vendor)\//.test(String(p));
/** The release part a game path belongs to, with its path inside the part: {part, rel} | null. */
export function partOf(path) {
  for (const [pre, part] of KIT_ROOTS) {
    if (pre.endsWith('/') ? path.startsWith(pre) : path === pre) return { part, rel: pre.endsWith('/') ? path.slice(pre.length) : path };
  }
  return null;
}

/** Never overridable: [pattern, why, fix]. */
export const NEVER = [
  [/^gf\/three\/core\/guard\.js$/, 'the kit\'s guard (it refuses what game code may not do to the kit, and finds the game\'s folder, ROOT, from its own URL)'],
  [/^gf\/three\/core\/refusals\.js$/, 'the kit\'s named refusals (what the guard and verify read)'],
  [/^gf\/three\/kit\.js$/, 'the kit copy\'s own record (create writes it)'],
  [/^gf\/mp\//, 'the multiplayer kit (gf/mp is held to gf-multiplayer\'s own frozen releases)'],
  [/^gf\/forge\/(wasm|wasm-webgl2)\/|\.wasm$|^gf\/forge\/BUILD\.json$/, 'forge\'s prebuilt core (one hash-pinned wasm per kit release, its glue and its build record; agents never run cargo, so forge overrides cover its JS layer only)'],
  [/(^|\/)(LICENSE|LICENSES\.md|ATTRIBUTION\.md|THIRD_PARTY\.md|UPSTREAM\.json)$/, 'a licence or attribution (licences travel with the code, unchanged)'],
];
/** Why a path can never be overridden, or null. */
export const neverWhy = p => NEVER.find(([re]) => re.test(String(p)))?.[1] ?? null;

const HEX64 = /^[0-9a-f]{64}$/;
const safe = p => typeof p === 'string' && p.length > 0 && p.length <= 400 && !p.startsWith('/') && !p.includes('\\') && !p.split('/').some(s => !s || s === '.' || s === '..');

/**
 * A game's declared overrides, checked for form (not against the kit: kit-check does that).
 * → {overrides: Map<path, {base, why}>, problems: [words]} (a malformed entry is a problem and is left out)
 */
export async function readOverrides(gameDir) {
  const overrides = new Map(), problems = [];
  let rec = null;
  try { rec = JSON.parse(await readFile(join(gameDir, 'gf-three.json'), 'utf8')); } catch { return { overrides, problems }; }
  const o = rec?.overrides;
  if (o === undefined || o === null) return { overrides, problems };
  if (typeof o !== 'object' || Array.isArray(o)) return { overrides, problems: ['gf-three.json → overrides: must be an object {"<path under the game>": {"base": "<sha256>", "why": "<one sentence>"}}'] };
  for (const [path, v] of Object.entries(o)) {
    const at = `gf-three.json → overrides["${path}"]`;
    if (!safe(path)) { problems.push(`${at}: not a path under the game (relative, with /)`); continue; }
    if (!isKitPath(path)) { problems.push(`${at}: ${path} is the game's own file, not a kit file (only a file under gf/, audio/ or vendor/ is an override; the game's own code needs none)`); continue; }
    const base = typeof v?.base === 'string' ? v.base.trim().toLowerCase() : '';
    if (!HEX64.test(base)) { problems.push(`${at}.base: the sha256 (64 hex) of the kit release's file before the edit (sha256sum it, or take it from the gate A failure)`); continue; }
    const why = typeof v?.why === 'string' ? v.why.trim() : '';
    if (!why) { problems.push(`${at}.why: one sentence on what the game needs from this change to the engine`); continue; }
    overrides.set(path, { base, why });
  }
  return { overrides, problems };
}

/**
 * Hold the declared overrides of one kit part: `have` ({rel: sha256} of the game's copy) with every declared override's
 * hash replaced by its base, so a release match holds each override to the release it was made from.
 * → {have (new object), declared: Map<rel, {path, base, why, actual}>}
 */
export function withBases(prefix, have, overrides) {
  const out = { ...have }, declared = new Map();
  for (const [path, o] of overrides) {
    if (!path.startsWith(prefix) || neverWhy(path)) continue;
    const rel = path.slice(prefix.length);
    if (!(rel in out)) continue;
    declared.set(rel, { path, base: o.base, why: o.why, actual: out[rel] });
    out[rel] = o.base;
  }
  return { have: out, declared };
}

/** The words for an undeclared edit: the file, and both fixes (undo it, or declare it with the base given). */
export const undeclaredWords = (path, base, what) => `${path}: edited (${what}) and not declared as an override. Undo the edit (creating the game again puts the kit's file back), or, when the game needs the engine changed, declare it in gf-three.json → overrides: {"${path}": {"base": "${base ?? '<sha256 of the release file>'}", "why": "<one sentence>"}}`;
/** The words for a declared override whose base is no release's file. */
export const wrongBaseWords = (path, base, want, what) => `${path}: a declared override whose base ${String(base).slice(0, 12)}… is not this file in ${what}${want ? `, whose file is ${want.slice(0, 12)}…` : ''}. Rebase the edit onto the release's file and set gf-three.json → overrides["${path}"].base to its sha256${want ? ` (${want})` : ''}`;

/**
 * Before create writes a kit copy: each declared override against the kit it is about to write. `kitNow`:
 * (path) → the sha256 the refresh would write there, or undefined when it writes no such file. → [{path, base, now,
 * words}] for every override whose base the kit has moved on from (it needs a rebase); [] when every one can be kept.
 */
export async function overrideConflicts(gameDir, kitNow) {
  const { overrides } = await readOverrides(gameDir);
  const out = [];
  for (const [path, o] of overrides) {
    if (neverWhy(path)) continue;                         // gate A fails it; a refresh puts the kit's file back
    const now = await kitNow(path);
    if (now === o.base) continue;
    out.push({ path, base: o.base, now: now ?? null, words: now ? `${path}: a declared override whose base (${o.base.slice(0, 12)}…) is not the kit's file now (${now.slice(0, 12)}…): the kit changed this file since the edit was made. Rebase the edit onto the kit's new file (its sha256 is ${now}), set gf-three.json → overrides["${path}"].base to it, then run this again; nothing was changed`
      : `${path}: a declared override of a file the kit no longer has: move the edit into the game's own src/ modules, or onto the kit file that replaced it, and remove the override; nothing was changed` });
  }
  return out;
}

/** Read the bytes of every keepable declared override now (before a refresh writes the kit). → Map<path, Buffer> */
export async function holdOverrides(gameDir) {
  const { overrides } = await readOverrides(gameDir), held = new Map();
  for (const path of overrides.keys()) {
    if (neverWhy(path) || !existsSync(join(gameDir, path))) continue;
    held.set(path, await readFile(join(gameDir, path)));
  }
  return held;
}
