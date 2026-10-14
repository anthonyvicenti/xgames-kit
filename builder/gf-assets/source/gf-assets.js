// games.fun asset runtime, gf-assets/1. Contract: creator-studio/docs/asset-manifest.md §3.
// Every read of a file listed in assets.json goes through here, so the same game works
//   served from a folder  (json/text fetch the file; url returns the path),
//   packed for Studio     (the packer puts files in globalThis.__GF_FILES; nothing is fetched),
//   previewed in Studio   (globalThis.__GF_ASSET_OVERRIDES patches values and swaps files before boot).
// globalThis.__GF_ASSETS_SEEN records every path read, for QA and the worker's playtest.
// No dependencies, no DOM needed except for font().
export const VERSION = '1.1.0';

const G = globalThis;
const FILES = G.__GF_FILES || {};
const O = G.__GF_ASSET_OVERRIDES || {};
const SEEN = (G.__GF_ASSETS_SEEN = G.__GF_ASSETS_SEEN || []);
/** True when running packed (Studio): files come from __GF_FILES and fetch() is blocked. */
export const packed = !!G.__GF_FILES;
const clean = p => String(p).replace(/^\.\//, '').split(/[?#]/)[0];
const seen = p => { if (!SEEN.includes(p)) SEEN.push(p); };
const clone = v => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
const inlined = new Map();

// RFC 6901: "/a/0/b~1c" → ['a', '0', 'b/c']
export function parsePointer(pointer) {
  if (pointer === '' || pointer === '/') return [];
  if (!pointer.startsWith('/')) throw new Error(`gf-assets: bad JSON pointer "${pointer}"`);
  return pointer.slice(1).split('/').map(s => s.replace(/~1/g, '/').replace(/~0/g, '~'));
}
export function getPointer(doc, pointer) {
  let v = doc;
  for (const k of parsePointer(pointer)) { if (v == null || typeof v !== 'object' || !(k in v)) return undefined; v = v[k]; }
  return v;
}
export function setPointer(doc, pointer, value) {
  const keys = parsePointer(pointer);
  if (!keys.length) return clone(value);
  let v = doc;
  for (const k of keys.slice(0, -1)) {
    if (v == null || typeof v !== 'object' || !(k in v)) throw new Error(`gf-assets: pointer ${pointer} does not resolve`);
    v = v[k];
  }
  v[keys.at(-1)] = clone(value);
  return doc;
}
/** Apply pointer patches ({file, pointer, value}) for one file to a parsed JSON document. Returns a new object. */
export function applyPatches(doc, file, patches = O.patches || []) {
  let out = clone(doc);
  for (const p of patches) if (clean(p.file) === file) out = setPointer(out, p.pointer, p.value);
  return out;
}

const override = path => (O.files && path in O.files ? O.files[path] : undefined);
const embedded = path => (path in FILES ? FILES[path] : undefined);

// Studio's game policy has connect-src 'none': fetch() is blocked even for data: and blob: URLs,
// so embedded files are decoded here, never fetched.
function decodeDataUrl(u) {
  const comma = u.indexOf(','), meta = u.slice(5, comma), body = u.slice(comma + 1);
  if (!/;base64$/i.test(meta)) return new TextEncoder().encode(decodeURIComponent(body));
  const bin = atob(body), out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const toText = v => (typeof v === 'string' ? (v.startsWith('data:') ? new TextDecoder().decode(decodeDataUrl(v)) : v) : JSON.stringify(v));

async function load(path, as) {
  const v = override(path) ?? embedded(path);
  if (v !== undefined) {
    if (as === 'json') return typeof v === 'string' ? JSON.parse(toText(v)) : clone(v);
    if (as === 'bytes') return typeof v === 'string' && v.startsWith('data:') ? decodeDataUrl(v).buffer : new TextEncoder().encode(toText(v)).buffer;
    return toText(v);
  }
  const res = await fetch(path, { cache: 'no-store' });
  if (!res.ok) throw new Error(`gf-assets: ${path} → HTTP ${res.status}`);
  return as === 'json' ? res.json() : as === 'bytes' ? res.arrayBuffer() : res.text();
}

/** Parsed JSON for a manifest path, with Studio's pointer patches applied. Replaces fetch(path).json(). */
export async function json(path) {
  path = clean(path); seen(path);
  return applyPatches(await load(path, 'json'), path);
}

/** Parsed JSON synchronously, patches applied, when the file is embedded (packed) or overridden (Studio);
 *  undefined when served from a folder. For text that must show before async loading finishes. */
export function jsonSync(path) {
  path = clean(path);
  const v = override(path) ?? embedded(path);
  if (v === undefined) return undefined;
  seen(path);
  return applyPatches(typeof v === 'string' ? JSON.parse(toText(v)) : clone(v), path);
}

/** Whether a file exists: embedded/overridden files answer without the network; served games use a HEAD request.
 *  For optional file slots (e.g. a model that replaces a code-built mesh). */
export async function exists(path) {
  path = clean(path);
  if (override(path) !== undefined || embedded(path) !== undefined) return true;
  if (G.__GF_FILES) return false;   // packed: everything the manifest lists is embedded, so absent means absent
  try { return (await fetch(path, { method: 'HEAD', cache: 'no-store' })).ok; } catch { return false; }
}

/** Text content (ink stories, SVG markup, CSV). */
export async function text(path) {
  path = clean(path); seen(path);
  return load(path, 'text');
}

/** Raw bytes (ArrayBuffer) for loaders that parse buffers, e.g. GLTFLoader.parse(await gf.bytes('m.glb'), '', onLoad).
 *  Use this rather than url() for anything a loader would fetch(): Studio blocks fetch, even of data: URLs. */
export async function bytes(path) {
  path = clean(path); seen(path);
  return load(path, 'bytes');
}

/** A URL for things the browser loads without fetch(): <img>, Image, <audio>, Audio, CSS/FontFace. Synchronous. */
export function url(path) {
  path = clean(path); seen(path);
  const v = override(path) ?? embedded(path);
  if (v === undefined) return path;
  if (typeof v === 'string' && /^(data|blob):/.test(v)) return v;
  // Embedded JSON/text asked for as a URL: hand back a data: URL (fine for <img> of SVG text).
  if (!inlined.has(path)) inlined.set(path, 'data:' + (path.endsWith('.svg') ? 'image/svg+xml' : 'text/plain') + ';charset=utf-8,' + encodeURIComponent(toText(v)));
  return inlined.get(path);
}

/** Register a font file with the document. Resolves when it has loaded. */
export async function font(family, path, descriptors = {}) {
  const face = new FontFace(family, `url(${url(path)})`, descriptors);
  await face.load();
  document.fonts.add(face);
  return face;
}

let manifestPromise;
/** The game's assets.json with overrides applied; `sounds` has Studio's sound edits merged in. */
export function manifest() {
  manifestPromise ??= json('assets.json').then(m => {
    // The active variant (its select.query matches the page's query) may override sounds by id.
    const q = new URLSearchParams(G.location?.search ?? '');
    const active = (m.variants ?? []).find(v => [...new URLSearchParams(v.select?.query ?? '')].every(([k, val]) => q.get(k) === val));
    if (active?.sounds && m.sounds) m.sounds.sounds = { ...m.sounds.sounds, ...clone(active.sounds) };
    if (O.sounds && m.sounds) m.sounds.sounds = { ...m.sounds.sounds, ...clone(O.sounds) };
    return m;
  });
  return manifestPromise;
}

/** Apply every slot that has a `css` field (e.g. "--accent") as a custom property on <html>.
 *  Call once at boot, after the config files load. Returns the number of properties set. */
export async function applyCss(root = G.document?.documentElement) {
  const m = await manifest();
  let n = 0;
  for (const s of m.slots ?? []) {
    if (!s.css || !s.source?.pointer) continue;
    const v = getPointer(await json(s.source.file), s.source.pointer);
    if (v == null || typeof v === 'object') continue;
    root?.style.setProperty(s.css, s.type === 'text' ? JSON.stringify(String(v)) : String(v)); n++;
  }
  return n;
}

/** The audio kit's sounds section ({version, buses, sounds}), overrides applied. */
export async function sounds() { return (await manifest()).sounds ?? { version: 1, sounds: {} }; }

/** True when Studio (or a test) injected overrides; games can show nothing different, it's for debugging. */
export const overridden = !!(O.patches?.length || (O.files && Object.keys(O.files).length) || (O.sounds && Object.keys(O.sounds).length));
