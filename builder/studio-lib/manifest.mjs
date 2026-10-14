// Asset manifest (assets.json) helpers shared by the Studio server and the Assets tab.
// Contract: docs/asset-manifest.md (§2 shape, §3 overrides, §4 Studio). Pure and browser-safe:
// no Node or DOM imports. The static validator in builder/asset-manifest/validate.mjs reads a
// folder with node:fs, so its value-type rules are ported here (keep them in step).
import {validateManifest as validateSounds} from '../gf-audio/source/sounds.mjs';
import {hash, canonical, sourcePath} from './source-record.mjs';
import {normalizeManifest, groupDefaultsProblems} from './manifest-normalize.mjs';
import {imageSize} from './image-size.mjs';
import {codeOf, codeLang, isCodeFile, codeShapeProblem, readCodeValue, locateCode, decodeCode, encodeCode, spliceCode, shiftAnchors, rangesOverlap, COLOR_INT, CODE_LANGS, STALE, isLiteralPathRef, pathLiterals} from './code-literals.mjs';
// v1.3 group defaults: every reader of slots sees them through normalizeManifest (dependency-free, so the validator can
// load it in the worker container); readArchiveManifest returns the normalized manifest, patchArchive edits the raw file.
export {normalizeManifest, applyGroupDefaults, groupDefaultsProblems, GROUP_DEFAULT_KEYS} from './manifest-normalize.mjs';
// v1.4 code value slots (source.code): the literal helpers live in a dependency-free module the validator also loads.
export {codeOf, isCodeSlot, codeLang, COLOR_INT, readCodeValue, formatCodeValue, locateCode, spliceCode} from './code-literals.mjs';

export const SCHEMA = 'gf-assets/1';
export const MANIFEST_PATH = 'assets.json';
export const FILE_TYPES = {
  image: ['png', 'webp', 'jpg', 'jpeg', 'svg', 'gif', 'avif'],
  audio: ['ogg', 'mp3', 'wav', 'm4a', 'flac'],
  model: ['glb', 'gltf'],
  texture: ['ktx2', 'hdr'],   // v1.3: GPU textures (KTX2/Basis, Radiance HDR); same-format replacement only
  font: ['ttf', 'otf', 'woff', 'woff2'],
  data: ['json', 'ink', 'txt', 'svg', 'tmj', 'csv', 'pzl'],
};
export const VALUE_TYPES = ['color', 'colors', 'number', 'integer', 'boolean', 'enum', 'text', 'json'];
export const SLOT_ID = /^[a-z0-9][a-z0-9_.-]{0,79}$/;
export const SOUND_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
export const HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
// v1.1: a colour value is hex or rgb()/rgba() (same pattern as builder/asset-manifest/validate.mjs).
export const COLOR = /^(?:#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})|rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(?:,\s*(?:0|1|0?\.\d+)\s*)?\))$/i;
export const isFileSlot = slot => Object.hasOwn(FILE_TYPES, slot?.type);
export const isValueSlot = slot => VALUE_TYPES.includes(slot?.type);
const isNum = v => typeof v === 'number' && Number.isFinite(v);
const clone = v => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
const extOf = path => (/\.([a-z0-9]+)$/i.exec(path ?? '')?.[1] ?? '').toLowerCase();

// v1.2 facets (2026-09-29): what a slot *is* to a creator, which decides the Assets sub-tab it appears under.
// A slot may declare `facet`; otherwise slotFacet() infers it from the type (and, for enums, the id and label:
// a code-drawn "Monster skin" preset is Look, "Difficulty" is Gameplay). Sounds are always 'sound'.
/** @type {readonly ('look'|'sound'|'text'|'gameplay')[]} */
export const FACETS = ['look', 'sound', 'text', 'gameplay'];
/** @type {Record<string, string>} */
export const FACET_LABELS = {look: 'Look', sound: 'Sound', text: 'Text', gameplay: 'Gameplay'};
const LOOK_WORDS = /skin|style|pattern|palette|theme|texture|sprite|model|character|costume|outfit|hat|shape|look|font|sky|weather|light|colou?r|art|icon|avatar|decor|material|finish|mesh|appearance|visual|background|backdrop|tile|border|frame|particle|trail|effect/i;
const TYPE_FACET = {image: 'look', model: 'look', texture: 'look', font: 'look', color: 'look', colors: 'look', audio: 'sound', text: 'text', json: 'gameplay', data: 'gameplay', number: 'gameplay', integer: 'gameplay', boolean: 'gameplay'};
/** @returns {'look'|'sound'|'text'|'gameplay'} */
export function slotFacet(/** @type {any} */ slot) {
  if (FACETS.includes(slot?.facet)) return slot.facet;
  if (slot?.type === 'enum') return LOOK_WORDS.test(`${slot.id} ${slot.label ?? ''}`) ? 'look' : 'gameplay';
  return TYPE_FACET[slot?.type] ?? 'gameplay';
}
/**
 * An enum slot's options as {value, label, preview?: {file}} (options may be plain strings).
 * @returns {{value: string, label: string, preview?: {file: string}}[]}
 */
export const enumOptions = (/** @type {any} */ slot) => (slot?.constraints?.options ?? []).map(o => (typeof o === 'string' ? {value: o, label: o} : {...o, label: o.label ?? o.value}));
/** Every thumbnail file a manifest references: slot previews and enum option previews (v1.2), and (v1.5) the stills of
 *  `showcase` views (`showcase[i].preview: {file}`, written by asset-manifest/capture-previews.mjs --showcase). */
export const previewFiles = manifest => [...(manifest?.slots ?? []).flatMap(s => [s?.preview?.file, ...enumOptions(s).map(o => o.preview?.file)]),
  ...(Array.isArray(manifest?.showcase) ? manifest.showcase : []).map(x => x?.preview?.file)].filter(f => typeof f === 'string');

/** A preview query ("?a=1&b=2" or "a=1") merged into a URL or another query; later keys win. */
export function mergeQuery(base, ...queries) {
  const [path, search = ''] = String(base ?? '').split('?');
  const params = new URLSearchParams(search);
  for (const q of queries) for (const [k, v] of new URLSearchParams(String(q ?? '').replace(/^\?/, ''))) params.set(k, v);
  const out = params.toString();
  return path + (out ? '?' + out : '');
}

/**
 * The subjects a game can show on their own in a preview (v1.2): the manifest's `showcase` list
 * ([{id, label, query, groups?, slots?}]), plus one per distinct `?gf-show=` capture query on its slots. A subject
 * covers the slots it lists, the slots that capture with it, and, for capture-derived subjects that are the only subject
 * in a group, that whole group, so "The monster" group's colour and height slots show on the monster too.
 * @returns {{id: string, label: string, query: string, slots: string[], groups: string[]}[]}
 */
export function previewSubjects(manifest) {
  const slots = Array.isArray(manifest?.slots) ? manifest.slots : [], groups = new Map((manifest?.groups ?? []).map(g => [g.id, g.label]));
  const byId = new Map();
  for (const s of Array.isArray(manifest?.showcase) ? manifest.showcase : []) {
    if (!s || typeof s.query !== 'string') continue;
    const id = String(s.id ?? new URLSearchParams(s.query.replace(/^\?/, '')).get('gf-show') ?? s.query);
    byId.set(id, {id, label: String(s.label ?? id), query: s.query, slots: [...(s.slots ?? [])], groups: [...(s.groups ?? [])], exact: true});
  }
  for (const s of slots) {
    const q = s?.capture?.query;
    if (typeof q !== 'string') continue;
    const id = new URLSearchParams(q.replace(/^\?/, '')).get('gf-show');
    if (!id) continue;
    const e = byId.get(id) ?? {id, label: '', query: q, slots: [], groups: []};
    if (!e.slots.includes(s.id)) e.slots.push(s.id);
    byId.set(id, e);
  }
  const subjects = [...byId.values()];
  const inGroup = g => subjects.filter(x => x.groups.includes(g) || x.slots.some(id => slots.find(s => s.id === id)?.group === g));
  for (const x of subjects) {
    // Declared (showcase) subjects cover exactly what they list; subjects found from capture queries widen to their group.
    if (!x.exact) for (const id of x.slots) { const g = slots.find(s => s.id === id)?.group; if (g && inGroup(g).length === 1 && !x.groups.includes(g)) x.groups.push(g); }
    if (!x.label) {
      const own = x.slots.map(id => slots.find(s => s.id === id)).filter(Boolean);
      x.label = x.groups.length === 1 ? groups.get(x.groups[0]) ?? x.id : (own[0]?.label ?? x.id).replace(/:\s*[^:]+$/, '');
    }
  }
  return subjects.map(({exact, ...x}) => x);
}
/**
 * The subject that shows a slot best: one listing it; else one whose capture slot is in the same id family
 * (`texture.wall.style` covers `texture.wall.a`, `loot.1.shape` covers `loot.1.color`); else the only subject
 * covering the slot's group. A family is the parts of one thing (`<kind>.<thing>.<part>`); ids that only say where a
 * value is kept are not one: the scanner's `code.<file>.<name>` and `text.<list>.<name>` need a fourth segment.
 */
export function subjectForSlot(subjects, slot) {
  // Families need two segments before the last (loot.1.*, texture.wall.*): a bare 'text.' prefix spans unrelated slots.
  // Round 3 (swarm bugs 19, 36, 51): so does code.<file>. (every value scan-code.mjs found in one file) and text.<list>.
  // (text.ui.*, text.log.*): one view that listed one such slot became the view of all of them, so crops, the gate's
  // screens and "where it appears" showed the wrong screen. Under those two prefixes a family needs one more segment.
  const family = id => id.split('.').length >= (/^(?:code|text)\./.test(id) ? 4 : 3) ? id.slice(0, id.lastIndexOf('.') + 1) : null;
  return subjects.find(x => x.slots.includes(slot.id))
    ?? subjects.find(x => x.slots.some(id => family(id) && family(id) === family(slot.id)))
    ?? (subjects.filter(x => x.groups.includes(slot.group)).length === 1 ? subjects.find(x => x.groups.includes(slot.group)) : null)
    ?? null;
}

/** Joins a relative URI onto a folder the way a browser would ("a/b/" + "../c.png" -> "a/c.png"); used for .gltf resources. */
export function joinRelative(dir, uri) {
  const out = [];
  for (const part of (dir + decodeURIComponent(uri)).split('/')) { if (part === '..') out.pop(); else if (part && part !== '.') out.push(part); }
  return out.join('/');
}

// RFC 6901 JSON pointers, the same rules as the runtime (builder/gf-assets/source/gf-assets.js).
export function parsePointer(pointer) {
  if (pointer === '' || pointer === '/') return [];
  if (typeof pointer !== 'string' || !pointer.startsWith('/')) throw new Error(`Bad JSON pointer "${pointer}".`);
  return pointer.slice(1).split('/').map(s => s.replace(/~1/g, '/').replace(/~0/g, '~'));
}
export function getPointer(doc, pointer) {
  let v = doc;
  for (const k of parsePointer(pointer)) { if (v == null || typeof v !== 'object' || !Object.hasOwn(v, k)) return undefined; v = v[k]; }
  return v;
}
/** Writes value at an existing pointer (its parent must resolve). Returns the document (a new one for the root pointer). */
export function setPointer(doc, pointer, value) {
  const keys = parsePointer(pointer);
  if (!keys.length) return clone(value);
  let v = doc;
  for (const k of keys.slice(0, -1)) {
    if (v == null || typeof v !== 'object' || !Object.hasOwn(v, k)) throw new Error(`JSON pointer ${pointer} does not resolve.`);
    v = v[k];
  }
  if (v == null || typeof v !== 'object') throw new Error(`JSON pointer ${pointer} does not resolve.`);
  v[keys.at(-1)] = clone(value);
  return doc;
}
export const pointerDepth = pointer => (pointer ? parsePointer(pointer).length : 0);
/** Broad writes first, so an edit to /text/kicker survives an edit to /text in the same draft. Stable otherwise. */
export const sortPatches = patches => patches.map((p, i) => [p, i]).sort((a, b) => pointerDepth(a[0].pointer) - pointerDepth(b[0].pointer) || a[1] - b[1]).map(([p]) => p);

/** Why `value` can't go in `slot` (a value slot), or null. Mirrors builder/asset-manifest/validate.mjs checkValue. */
export function slotValueProblem(slot, v) {
  const c = slot.constraints ?? {};
  switch (slot.type) {
    case 'color':
      if (c.format === COLOR_INT) return typeof v === 'string' && /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(v) ? null : 'must be a colour like #ff8800 (no transparency: the game keeps it as a number)';
      return typeof v === 'string' && COLOR.test(v) ? null : 'must be a colour like #ff8800 or rgba(255, 136, 0, 0.5)';
    case 'colors': {
      const list = Array.isArray(v) ? v : v && typeof v === 'object' ? Object.values(v) : null;
      if (!list || !list.length || list.some(x => typeof x !== 'string' || !COLOR.test(x))) return 'must be a list of colours';
      if (Array.isArray(v) && ((isNum(c.min) && v.length < c.min) || (isNum(c.max) && v.length > c.max))) return `needs ${c.min ?? 1}–${c.max ?? '∞'} colours`;
      return null;
    }
    case 'number': case 'integer':
      if (!isNum(v) || (slot.type === 'integer' && !Number.isInteger(v))) return slot.type === 'integer' ? 'must be a whole number' : 'must be a number';
      if ((isNum(c.min) && v < c.min) || (isNum(c.max) && v > c.max)) return `must be between ${c.min ?? '−∞'} and ${c.max ?? '∞'}`;
      return null;
    case 'boolean': return typeof v === 'boolean' ? null : 'must be on or off';
    case 'enum':
      if (!Array.isArray(c.options) || !c.options.length) return 'has no options';
      return c.options.some(o => (o?.value ?? o) === v) ? null : 'must be one of its options';
    case 'text':
      if (typeof v !== 'string') return 'must be text';
      if (isNum(c.maxLength) && v.length > c.maxLength) return `must be at most ${c.maxLength} characters`;
      return null;
    case 'json': return v === undefined ? 'is empty' : null;
    default: return 'is not a value slot';
  }
}

// ---- Overrides (globalThis.__GF_ASSET_OVERRIDES) --------------------------------------------
export const OVERRIDES_ID = 'gf-asset-overrides';
const OVERRIDES_RE = /<script id="gf-asset-overrides">globalThis\.__GF_ASSET_OVERRIDES=([\s\S]*?);<\/script>/;
export const emptyOverrides = () => ({patches: [], files: {}, sounds: {}});
export const isEmptyOverrides = o => !o || (!(o.patches?.length) && !Object.keys(o.files ?? {}).length && !Object.keys(o.sounds ?? {}).length);
/** Later overrides win: patches append (the runtime applies them in order), files and sounds replace by key. */
export function mergeOverrides(a, b) {
  return {patches: [...(a?.patches ?? []), ...(b?.patches ?? [])], files: {...(a?.files ?? {}), ...(b?.files ?? {})}, sounds: {...(a?.sounds ?? {}), ...(b?.sounds ?? {})}};
}
// JSON inside <script>: escape "<" (no </script> or <!--) and the JS line separators.
const scriptJson = value => JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
export const overridesScript = o => `<script id="${OVERRIDES_ID}">globalThis.__GF_ASSET_OVERRIDES=${scriptJson(o)};</script>`;
/** Overrides a previous Studio save baked into this HTML, or null. */
export function readBakedOverrides(html) {
  const m = OVERRIDES_RE.exec(html ?? '');
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}
/**
 * Puts `overrides` into a game document as its first script, merged over any a previous save baked in.
 * In a gameDocument() page the script goes right after the CSP meta; in stored version HTML it goes
 * right after the doctype (gameDocument keeps it first when it later adds the meta). Classic inline
 * scripts run before the game's modules, so the runtime sees the overrides when it loads.
 */
export function withOverrides(html, overrides) {
  const baked = readBakedOverrides(html);
  const rest = html.replace(OVERRIDES_RE, '');
  const merged = baked ? mergeOverrides(baked, overrides) : overrides;
  if (isEmptyOverrides(merged)) return rest;
  const script = overridesScript(merged);
  const meta = /<meta http-equiv="Content-Security-Policy" content="[^"]*">/.exec(rest);
  if (meta) return rest.slice(0, meta.index + meta[0].length) + script + rest.slice(meta.index + meta[0].length);
  const doctype = /^\s*<!doctype[^>]*>/i.exec(rest);
  return doctype ? doctype[0] + script + rest.slice(doctype[0].length) : script + rest;
}
/**
 * Plays a preview as a variant. A srcdoc page's URL is about:srcdoc and can't carry a query (history
 * rewrites are refused), so this first script makes `new URLSearchParams(location.search)` (how games and
 * gf-assets read the query) see the variant's select.query. Games that parse location.search by hand
 * don't see it. Preview only: never baked into saved HTML.
 */
export const VARIANT_ID = 'gf-variant-query';
export function withVariantQuery(html, query) {
  const rest = html.replace(/<script id="gf-variant-query">[\s\S]*?<\/script>/, '');
  if (!query) return rest;
  const script = `<script id="${VARIANT_ID}">(()=>{const Q=${scriptJson(String(query))},S=location.search,U=URLSearchParams;` +
    `globalThis.URLSearchParams=class URLSearchParams extends U{constructor(...a){super(...(a.length&&a[0]===S?[Q]:a));}};globalThis.__GF_VARIANT_QUERY=Q;})();</script>`;
  const meta = /<meta http-equiv="Content-Security-Policy" content="[^"]*">/.exec(rest);
  if (meta) return rest.slice(0, meta.index + meta[0].length) + script + rest.slice(meta.index + meta[0].length);
  const doctype = /^\s*<!doctype[^>]*>/i.exec(rest);
  return doctype ? doctype[0] + script + rest.slice(doctype[0].length) : script + rest;
}
/** Versions packed with manifest support embed their files, so baked overrides take effect without a fetch. */
export const hasManifestSupport = html => typeof html === 'string' && html.includes('__GF_FILES');

// ---- Source archives ---------------------------------------------------------------------------
export function fromBase64(content) { const bin = atob(content), out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; }
export function toBase64(bytes) { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s); }
const utf8 = bytes => new TextDecoder('utf-8', {fatal: true}).decode(bytes).replace(/^\uFEFF/, '');
function archiveJson(archive, path, cache) {
  if (cache.has(path)) return cache.get(path);
  const f = archive.files.find(x => x.path === path);
  let doc;
  try { doc = f ? JSON.parse(utf8(fromBase64(f.content))) : undefined; } catch { doc = {__invalid: true}; }
  cache.set(path, doc);
  return doc;
}
export const manifestSounds = m => (m?.sounds && typeof m.sounds === 'object' ? m.sounds.sounds ?? {} : {});
const srcList = def => (Array.isArray(def?.src) ? def.src : [def?.src]);
/** Every file a sound def plays, including files inside layers (gf-audio 1.2.0), and a sound built in code's recording
 *  (gf-audio 1.5.0 code.preview: Studio plays it, and it stays when a replacement takes over). */
export const soundFiles = def => [...srcList(def).flatMap(s => (Array.isArray(s?.layers) ? s.layers : [s])).flatMap(s => (s && typeof s.file === 'string' ? [s.file] : [])),
  ...(typeof def?.code?.preview === 'string' && !srcList(def).some(s => s?.file === def.code.preview) ? [def.code.preview] : [])];
export const hasLayers = def => srcList(def).some(s => Array.isArray(s?.layers));
export const variantFiles = v => [v?.files ?? v?.file].flat().filter(f => typeof f === 'string');
/** The gf-audio version the game vendored (its audio/VERSION), or null. */
export function audioVersion(archive) {
  const f = archive.files.find(x => x.path === 'audio/VERSION');
  if (!f) return null;
  try { return utf8(fromBase64(f.content)).trim() || null; } catch { return null; }
}
/** Layered sounds need gf-audio 1.2.0 or later in the game. */
export function supportsLayers(version) {
  const [a = 0, b = 0] = (/^(\d+)\.(\d+)/.exec(version ?? '') ?? []).slice(1).map(Number);
  return a > 1 || (a === 1 && b >= 2);
}
const dirOf = path => (path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '');
const pointerContains = (outer, inner) => outer === '' || outer === '/' || inner === outer || inner.startsWith(outer + '/');

/**
 * Value slots whose addresses overlap: the same file, and one pointer contains the other (/text and
 * /text/title). {slotId: [other slot ids]}. The runtime applies patches broadest first (sortPatches).
 * @param {any[]} [slots] @returns {Record<string,string[]>}
 */
export function slotOverlaps(slots = []) {
  const value = slots.filter(s => isValueSlot(s) && typeof s.source?.pointer === 'string'), out = {};
  for (const a of value) for (const b of value) {
    if (a === b || a.source.file !== b.source.file) continue;
    if (pointerContains(a.source.pointer, b.source.pointer) || pointerContains(b.source.pointer, a.source.pointer)) (out[a.id] ??= []).push(b.id);
  }
  // v1.4: code slots whose ranges in one file share characters (a table and a number inside it).
  const code = slots.filter(s => isValueSlot(s) && codeOf(s) && !codeShapeProblem(codeOf(s)));
  for (const a of code) for (const b of code) if (a !== b && a.source.file === b.source.file && rangesOverlap(codeOf(a), codeOf(b))) (out[a.id] ??= []).push(b.id);
  return out;
}

/**
 * What each variant changes, for the Assets tab (docs/asset-manifest.md §2 "Variants"). Slots point at the
 * default files; a variant's JSON file shadows the slot files in its folder (ip/desert-dusk.json shadows
 * ip/default.json) and overrides a slot when it has a value at that slot's pointer (a pack that `extends`
 * the default only overrides what it lists). Variant `sounds` override sounds by id.
 * Returns {variantId: {label, query, files, slots: {slotId: value}, sounds: [ids]}}.
 */
export function variantOverrides(manifest, docOf) {
  const out = {};
  for (const v of Array.isArray(manifest?.variants) ? manifest.variants : []) {
    if (!v || typeof v.id !== 'string') continue;
    const files = variantFiles(v), slots = {};
    for (const f of files.filter(f => /\.json$/i.test(f))) {
      const doc = docOf(f);
      if (!doc || typeof doc !== 'object' || doc.__invalid) continue;
      for (const s of manifest.slots ?? []) {
        if (!isValueSlot(s) || s.source?.file === f || dirOf(s.source?.file ?? '') !== dirOf(f) || !/\.json$/i.test(s.source.file)) continue;
        let value;
        try { value = getPointer(doc, s.source.pointer); } catch { value = undefined; }
        if (value !== undefined) slots[s.id] = value;
      }
    }
    out[v.id] = {label: v.label ?? v.id, query: v.select?.query ?? '', files, slots, sounds: v.sounds && typeof v.sounds === 'object' ? Object.keys(v.sounds) : []};
  }
  return out;
}

/** The path a replacement in another format is saved at: the slot's path with the new file's extension. */
export const retargetPath = (path, filename) => path.replace(/\.[^./]+$/, '') + '.' + extOf(filename).replace(/^jpeg$/, 'jpg');
const sameFormat = (a, b) => { const n = e => (e === 'jpeg' ? 'jpg' : e); return n(extOf(a)) === n(extOf(b)); };
/**
 * Where a replacement file for a file slot goes. Same format: the slot's own path. Another format needs
 * `source.pathRef` (the game reads the path from JSON): the file is saved beside it with the new extension
 * and the pointer is patched. {ok, path, changed, patch?} or {ok:false, reason}.
 * @param {any} slot @param {string} filename
 * @returns {{ok:true,path:string,changed:boolean,patch?:{file:string,pointer:string,value:string},reason?:undefined}|{ok:false,reason:string,path?:undefined,changed?:undefined,patch?:undefined}}
 */
export function replacementTarget(slot, filename) {
  const from = slot?.source?.file;
  if (typeof from !== 'string') return {ok: false, reason: 'This slot has no file.'};
  // v1.5: art the game draws in code. The capture (drawn.preview) is never overwritten: a replacement goes to its own path,
  // art/<slot-id>.<ext>, in any raster format, and the slot's source.file moves there when it is saved (lib/asset-drafts.mjs).
  if (drawnOf(slot)) {
    const problem = drawnFormatProblem(slot, filename);
    return problem ? {ok: false, reason: problem} : {ok: true, path: drawnPath(slot, filename), changed: false};
  }
  if (sameFormat(from, filename)) return {ok: true, path: from, changed: false};
  const ext = extOf(filename);
  if (!FILE_TYPES[slot.type]?.includes(ext)) return {ok: false, reason: `${slot.label ?? slot.id} can’t use a .${ext} file.`};
  const ref = slot.source.pathRef;
  // Round 2: the game reads the path from string literals in its code (unpack-data-urls.mjs): the new file goes beside the
  // old one and those literals are rewritten as a code edit (lib/asset-drafts.mjs, from readArchiveManifest's anchors).
  if (isLiteralPathRef(ref)) { const path = retargetPath(from, filename); return {ok: true, path, changed: true, literal: {file: ref.file, from, to: path}}; }
  if (!ref || typeof ref.file !== 'string' || typeof ref.pointer !== 'string')
    return {ok: false, reason: `${slot.label ?? slot.id} uses a .${extOf(from)} file and the game can’t switch formats here. Use Ask to change so the builder can switch formats.`};
  const path = retargetPath(from, filename);
  return {ok: true, path, changed: true, patch: {file: ref.file, pointer: ref.pointer, value: path}};
}

/**
 * Checks a manifest against the archive it came from: shape, groups, slot ids and types, every
 * file exists (optional file slots may be absent), every value pointer resolves to a value of its
 * type, pathRef pointers hold the slot's path, replaces/variants/embed entries resolve, and the
 * sounds section (the audio kit's validator; layers need gf-audio 1.2.0 in the game).
 * Returns a list of problems (empty = valid).
 */
export function manifestProblems(manifest, archive) {
  const problems = [], paths = new Set(archive.files.map(f => f.path)), cache = new Map(), sizes = new Map();
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return ['assets.json must be an object'];
  const m = normalizeManifest(manifest);
  if (m.schema !== SCHEMA) problems.push(`schema must be "${SCHEMA}"`);
  if (!['live', 'readonly'].includes(m.editing)) problems.push('editing must be "live" or "readonly"');
  const groups = Array.isArray(m.groups) ? m.groups : (problems.push('groups must be a list'), []);
  const groupIds = new Set(groups.map(g => g?.id));
  for (const g of groups) for (const p of groupDefaultsProblems(g)) problems.push(`groups (${g?.id}): ${p}`);
  const slots = Array.isArray(m.slots) ? m.slots : (problems.push('slots must be a list'), []);
  const ids = new Set(slots.map(s => s?.id)), seen = new Set();
  for (const [i, s] of slots.entries()) {
    const at = `slots[${i}]${s?.id ? ` (${s.id})` : ''}`;
    if (!s || typeof s !== 'object') { problems.push(`${at} must be an object`); continue; }
    if (typeof s.id !== 'string' || !SLOT_ID.test(s.id)) problems.push(`${at}: invalid id`);
    else if (seen.has(s.id)) problems.push(`${at}: duplicate id`);
    seen.add(s.id);
    if (!groupIds.has(s.group)) problems.push(`${at}: group "${s.group}" is not listed`);
    if (s.tier !== undefined && !['main', 'advanced'].includes(s.tier)) problems.push(`${at}: tier must be "main" or "advanced"`);
    if (s.facet !== undefined && !FACETS.includes(s.facet)) problems.push(`${at}: facet must be one of ${FACETS.join(', ')}`);
    if (s.editable !== undefined && typeof s.editable !== 'boolean') problems.push(`${at}: editable must be true or false`);
    if (s.readonlyReason !== undefined && typeof s.readonlyReason !== 'string') problems.push(`${at}: readonlyReason must be text`);
    const bake = bakeProblem(s), rect = rectProblem(s), drawn = drawnProblem(s);
    if (bake) problems.push(`${at}: ${bake}`);
    // v1.5 art drawn in code: the capture stays in the version (and listed) even after a replacement takes over.
    if (drawn) problems.push(`${at}: ${drawn}`);
    else if (drawnOf(s) && !paths.has(s.drawn.preview)) problems.push(`${at}: drawn.preview ${s.drawn.preview} is not in this version`);
    if (rect) problems.push(`${at}: ${rect}`);
    else if (rectOf(s)) { const out = rectBoundsProblem(s, sheetSize(archive, s.source.file, sizes)); if (out) problems.push(`${at}: ${out}`); }
    for (const r of Array.isArray(s.replaces) ? s.replaces : []) if (!ids.has(r)) problems.push(`${at}: replaces unknown slot "${r}"`);
    const file = s.source?.file;
    if (typeof file !== 'string') { problems.push(`${at}: no source file`); continue; }
    const ref = s.source.pathRef;
    if (isLiteralPathRef(ref)) {   // round 2: the path is a string literal in a code file; whether it is still there is checked when a format changes
      if (!isFileSlot(s)) problems.push(`${at}: pathRef is for file slots`);
      else if (!isCodeFile(ref.file)) problems.push(`${at}: pathRef.file ${ref.file} is not a .js, .mjs, .cjs, .css or .html file`);
    } else if (ref !== undefined) {
      const doc = typeof ref?.file === 'string' ? archiveJson(archive, ref.file, cache) : undefined;
      let v;
      try { v = doc && !doc.__invalid ? getPointer(doc, ref.pointer) : undefined; } catch { v = undefined; }
      if (!isFileSlot(s)) problems.push(`${at}: pathRef is for file slots`);
      else if (v !== file) problems.push(`${at}: ${ref?.file}#${ref?.pointer} must hold "${file}"`);
    }
    if (!paths.has(file)) { if (!(isFileSlot(s) && s.optional === true)) problems.push(`${at}: ${file} is not in this version`); continue; }
    if (isFileSlot(s)) {
      if (!FILE_TYPES[s.type].includes(extOf(file))) problems.push(`${at}: .${extOf(file)} is not a ${s.type} format`);
    } else if (isValueSlot(s) && s.source.code !== undefined) {
      // v1.4: a value in the game's code. Its literal must read as the slot's type; whether the file still holds it at
      // the anchor is per slot (readArchiveManifest locks a stale one), so one moved literal never blocks every save.
      const problem = codeSlotProblem(s);
      if (problem) problems.push(`${at}: ${problem}`);
    } else if (isValueSlot(s)) {
      if (s.constraints?.format === COLOR_INT) problems.push(`${at}: constraints.format "${COLOR_INT}" is for colours kept as numbers in code`);
      const doc = archiveJson(archive, file, cache);
      if (doc?.__invalid) { problems.push(`${at}: ${file} is not valid JSON`); continue; }
      let v;
      try { v = getPointer(doc, s.source.pointer); } catch { problems.push(`${at}: bad pointer`); continue; }
      if (v === undefined) { problems.push(`${at}: ${s.source.pointer} does not resolve in ${file}`); continue; }
      const problem = slotValueProblem(s, v);
      if (problem) problems.push(`${at}: ${s.label ?? s.id} ${problem}`);
    } else problems.push(`${at}: unknown type "${s.type}"`);
  }
  for (const [a, b, file] of frameOverlaps(slots)) problems.push(`frames ${a} and ${b} overlap in ${file} (set source.overlap on one if that is deliberate)`);
  for (const [i, v] of (Array.isArray(m.variants) ? m.variants : []).entries())
    for (const f of variantFiles(v)) if (!paths.has(f)) problems.push(`variants[${i}] (${v?.id}): ${f} is not in this version`);
  for (const f of previewFiles(m)) if (!paths.has(f)) problems.push(`preview ${f} is not in this version`);
  for (const [i, x] of (Array.isArray(m.showcase) ? m.showcase : []).entries()) {
    if (!x || typeof x.query !== 'string' || !/(^|[?&])gf-show=/.test(x.query)) { problems.push(`showcase[${i}]: query must set gf-show`); continue; }
    if (x.preview !== undefined && (!x.preview || typeof x.preview !== 'object' || typeof x.preview.file !== 'string')) problems.push(`showcase[${i}] (${x.id ?? x.query}): preview must be {file}`);
    for (const id of x.slots ?? []) if (!ids.has(id)) problems.push(`showcase[${i}] (${x.id ?? x.query}): unknown slot "${id}"`);
    for (const g of x.groups ?? []) if (!groupIds.has(g)) problems.push(`showcase[${i}] (${x.id ?? x.query}): unknown group "${g}"`);
  }
  for (const [i, e] of (Array.isArray(m.embed) ? m.embed : []).entries()) if (!paths.has(e?.path)) problems.push(`embed[${i}]: ${e?.path} is not in this version`);
  if (m.sounds !== undefined) {
    const r = validateSounds(m.sounds);
    problems.push(...r.errors.map(e => `sounds: ${e}`));
    const layered = supportsLayers(audioVersion(archive));
    for (const [id, def] of Object.entries(manifestSounds(m))) {
      for (const f of soundFiles(def)) if (!paths.has(f)) problems.push(`sounds.${id}: ${f} is not in this version`);
      if (!layered && hasLayers(def)) problems.push(`sounds.${id}: layers need gf-audio 1.2.0 (this game has ${audioVersion(archive) ?? 'no audio/VERSION'})`);
    }
  }
  return problems;
}

/**
 * The manifest of a source archive with each value slot's current value, the files slots, sounds and
 * variants point at (not `embed` support files), the game's gf-audio version and what each variant
 * overrides. {manifest:null} when the version has no assets.json (not yet described).
 */
export function readArchiveManifest(archive, {code = false} = {}) {
  const cache = new Map(), raw = archiveJson(archive, MANIFEST_PATH, cache);
  const none = {manifest: null, values: {}, files: [], problems: [], audioVersion: null, variants: {}, code: {}};
  if (raw === undefined) return none;
  if (raw?.__invalid) return {...none, problems: ['assets.json is not valid JSON']};
  const normalized = normalizeManifest(raw);   // v1.3: slots carry their group's defaults
  const values = {}, wanted = new Set(), anchors = {}, texts = new Map();
  for (const s of Array.isArray(normalized.slots) ? normalized.slots : []) {
    if (!s || typeof s.source?.file !== 'string') continue;
    if (isValueSlot(s) && s.source.code !== undefined) {
      // v1.4: read the literal where it is now (moved text and tables are found again; see locateCode).
      const at = codeSlotProblem(s) ? null : locateCode(archiveCode(archive, s.source.file, texts), s);
      if (at) { anchors[s.id] = at; const r = readCodeValue(s, at.text); if (r.ok) values[s.id] = r.value; }
    } else if (isValueSlot(s)) { try { const v = getPointer(archiveJson(archive, s.source.file, cache), s.source.pointer); if (v !== undefined) values[s.id] = v; } catch { /* reported by manifestProblems */ } }
    else {
      wanted.add(s.source.file);
      // Round 2: where the code names a literal pathRef's path now (lib/asset-drafts.mjs rewrites them for a format change).
      if (isLiteralPathRef(s.source.pathRef)) anchors[`pathRef:${s.id}`] = pathLiterals(archiveCode(archive, s.source.pathRef.file, texts) ?? '', s.source.file);
    }
    if (typeof s.preview?.file === 'string') wanted.add(s.preview.file);
    if (typeof drawnOf(s)?.preview === 'string') wanted.add(s.drawn.preview);   // v1.5: the game's own art, shown beside a replacement
  }
  const m = codeLocks(normalized, anchors, {code, readable: path => archiveCode(archive, path, texts) !== null});
  for (const f of previewFiles(m)) wanted.add(f);
  // A .gltf model loads its buffers and textures by relative URL: list its folder so the model viewer can resolve them.
  for (const s of (Array.isArray(m.slots) ? m.slots : []).filter(s => s?.type === 'model' && /\.gltf$/i.test(s.source?.file ?? ''))) {
    const dir = s.source.file.includes('/') ? s.source.file.replace(/\/[^/]*$/, '/') : '';
    // The model's folder and its subfolders (textures/), or only its own folder when it sits at the game root.
    for (const f of archive.files) if (f.path.startsWith(dir) && (dir || !f.path.includes('/')) && /\.(bin|png|jpe?g|webp|ktx2)$/i.test(f.path)) wanted.add(f.path);
  }
  for (const def of Object.values(manifestSounds(m))) for (const f of soundFiles(def)) wanted.add(f);
  for (const v of Array.isArray(m.variants) ? m.variants : []) for (const f of variantFiles(v)) wanted.add(f);
  for (const def of (Array.isArray(m.variants) ? m.variants : []).flatMap(v => Object.values(v?.sounds ?? {}))) for (const f of soundFiles(def)) wanted.add(f);
  const files = archive.files.filter(f => wanted.has(f.path)).map(f => ({path: f.path, bytes: f.bytes, sha256: f.sha256}));
  return {manifest: m, values, files, problems: manifestProblems(m, archive), audioVersion: audioVersion(archive),
    variants: variantOverrides(m, path => archiveJson(archive, path, cache)), code: anchors};
}

/**
 * A copy of `archive` with pointer patches written into its JSON files, files replaced or added
 * ({path: Uint8Array}) and sound defs merged into assets.json (null removes a sound). `retarget`
 * ([{slotId, from, to}]) records a format change: the slot's source.file becomes `to` (its
 * constraints.formats gains the new format) and `from` is removed unless something else still uses it;
 * the caller patches the slot's pathRef pointer. JSON files that change are written back
 * pretty-printed (2 spaces) with a trailing newline.
 */
export async function patchArchive(archive, {patches = [], files = {}, sounds = {}, retarget = [], code = []} = {}) {
  const docs = new Map(), cache = new Map();
  const doc = path => { if (!docs.has(path)) { const d = archiveJson(archive, path, cache); if (d === undefined || d?.__invalid) throw new Error(`${path} is not a JSON file in this version.`); docs.set(path, clone(d)); } return docs.get(path); };
  for (const p of sortPatches(patches)) docs.set(p.file, setPointer(doc(p.file), p.pointer, p.value));
  // v1.4 code value slots ([{slotId, file, start, end, text, replacement}]): splice each file's edits (stale text and
  // overlaps throw), then move the anchors of every code slot in that file in assets.json so they still match.
  const codeFiles = new Map(), byFile = new Map();
  for (const e of code) byFile.set(e.file, [...(byFile.get(e.file) ?? []), e]);
  for (const [file, edits] of byFile) {
    if (Object.hasOwn(files, file)) throw new Error(`${file} is both replaced and edited.`);
    const before = archiveCode(archive, file, new Map());
    if (before === null) throw new Error(`${file} is not a code file in this version.`);
    const after = spliceCode(before, edits);
    codeFiles.set(file, encodeCode(after));
    const m = doc(MANIFEST_PATH), mine = (Array.isArray(m.slots) ? m.slots : []).filter(s => s?.source?.file === file && codeOf(s) && !codeShapeProblem(codeOf(s)));
    const anchors = mine.flatMap(s => { const a = locateCode(before, s); return a ? [{id: s.id, start: a.start, end: a.end, text: a.text}] : []; });
    const moved = shiftAnchors(anchors, edits, after);
    for (const s of mine) if (moved[s.id]) s.source.code = {...s.source.code, ...moved[s.id]};
  }
  if (Object.keys(sounds).length) {
    const m = doc(MANIFEST_PATH);
    if (!m.sounds || typeof m.sounds !== 'object') m.sounds = {version: 1, sounds: {}};
    if (!m.sounds.sounds || typeof m.sounds.sounds !== 'object') m.sounds.sounds = {};
    for (const [id, def] of Object.entries(sounds)) { if (def === null) delete m.sounds.sounds[id]; else m.sounds.sounds[id] = clone(def); }
  }
  const removed = new Set();
  if (retarget.length) {
    const m = doc(MANIFEST_PATH);
    for (const {slotId, from, to} of retarget) {
      const s = (m.slots ?? []).find(x => x?.id === slotId);
      if (!s) throw new Error(`Unknown slot ${slotId}.`);
      s.source.file = to;
      const formats = s.constraints?.formats;
      if (Array.isArray(formats) && !formats.includes(extOf(to))) formats.push(extOf(to));
      removed.add(from);
    }
    // Keep a file that another slot, preview, sound or variant still points at. v1.5: a drawn slot's capture is never
    // removed (going from the game's own art to a replacement keeps it), and showcase stills count as previews.
    const still = new Set([...(m.slots ?? []).flatMap(s => [s?.source?.file, s?.drawn?.preview]), ...previewFiles(m), ...Object.values(manifestSounds(m)).flatMap(soundFiles),
      ...(m.variants ?? []).flatMap(variantFiles), ...(m.embed ?? []).map(e => e?.path)]);
    for (const p of [...removed]) if (still.has(p) || Object.hasOwn(files, p)) removed.delete(p);
  }
  const replaced = new Map([...Object.entries(files), ...codeFiles]);
  for (const [path, value] of docs) replaced.set(path, new TextEncoder().encode(JSON.stringify(value, null, 2) + '\n'));
  const out = [];
  for (const f of archive.files) {
    if (removed.has(f.path)) continue;
    const bytes = replaced.get(f.path);
    if (!bytes) { out.push(f); continue; }
    replaced.delete(f.path);
    out.push({path: f.path, bytes: bytes.length, sha256: await hash(bytes), content: toBase64(bytes)});
  }
  for (const [path, bytes] of replaced) out.push({path: sourcePath(path), bytes: bytes.length, sha256: await hash(bytes), content: toBase64(bytes)});
  return {...archive, files: out};
}

// ---- v1.3 (2026-10-01): view-only slots ----------------------------------------------------------
// `editable: false` keeps a slot visible in Studio (preview, model viewer, "Ask to change") but out of every edit
// path: the inline editors, replace, generate, the draft and instant saves (lib/asset-drafts.mjs), Web3 item looks,
// and the worker's direct edits (studio-worker/lib/job.mjs). `readonlyReason` says why, in the creator's words.
export const VIEW_ONLY = 'Studio shows this one but can’t change it.';
export const isEditable = (/** @type {any} */ slot) => slot?.editable !== false;
/** Why a slot is view only (its readonlyReason, or a plain default), or null when it is editable. */
export const viewOnlyReason = (/** @type {any} */ slot) => (isEditable(slot) ? null : (typeof slot.readonlyReason === 'string' && slot.readonlyReason.trim()) || VIEW_ONLY);
/**
 * Direct edits that would change a view-only slot: a pointer patch that overlaps a view-only value slot's pointer
 * (either contains the other) or writes into a view-only whole-file slot, and a file swap at a view-only file slot's
 * path. One creator-facing line per refused edit (empty = fine). Patches: [{file, pointer}]; swaps: [path].
 * @returns {string[]}
 */
export function viewOnlyEditProblems(manifest, {patches = [], swaps = []} = {}) {
  const m = normalizeManifest(manifest), locked = (Array.isArray(m?.slots) ? m.slots : []).filter(s => s && !isEditable(s) && typeof s.source?.file === 'string');
  if (!locked.length) return [];
  const out = [], name = s => `${s.label ?? s.id} is view only`;
  for (const p of patches) {
    const s = locked.find(x => x.source.file === p?.file && (typeof x.source.pointer !== 'string' || pointerContains(x.source.pointer, String(p.pointer)) || pointerContains(String(p.pointer), x.source.pointer)));
    if (s) out.push(`${name(s)}, so ${p.file}${p.pointer} can’t be changed here. ${viewOnlyReason(s)}`);
  }
  for (const path of swaps) { const s = locked.find(x => x.source.file === path); if (s) out.push(`${name(s)}, so ${path} can’t be replaced here. ${viewOnlyReason(s)}`); }
  return out;
}

// ---- v1.3: sprite-sheet frames -------------------------------------------------------------------
// An image slot with `source.rect: [x, y, w, h]` (pixels) is one frame of the sheet at `source.file`. Studio shows it
// cropped and saves a frame replacement by compositing it into the sheet (components/studio/assets/slots/frames.ts), so
// the sheet stays one file and the packer lists it once. Frames of one sheet may not overlap unless one of them says
// `source.overlap: true`.
/** A slot's frame rect, or null when it has none (or a malformed one; rectProblem says why). @returns {[number,number,number,number]|null} */
export const rectOf = (/** @type {any} */ slot) => { const r = slot?.source?.rect; return Array.isArray(r) && r.length === 4 && r.every(n => Number.isInteger(n) && n >= 0) && r[2] > 0 && r[3] > 0 ? /** @type {[number,number,number,number]} */ (r) : null; };
/** What's wrong with a slot's `source.rect` / `source.overlap`, or null. */
export function rectProblem(/** @type {any} */ slot) {
  const r = slot?.source?.rect;
  if (r === undefined) return slot?.source?.overlap !== undefined ? 'source.overlap goes with source.rect' : null;
  if (slot.type !== 'image') return 'source.rect is for image slots';
  if (!rectOf(slot)) return 'source.rect must be [x, y, width, height] in whole pixels';
  if (slot.source.overlap !== undefined && typeof slot.source.overlap !== 'boolean') return 'source.overlap must be true or false';
  return null;
}
/** A frame that goes outside its sheet ({width, height} from the file header), or null. */
export function rectBoundsProblem(/** @type {any} */ slot, /** @type {{width:number,height:number}|null} */ size) {
  const r = rectOf(slot);
  return r && size && (r[0] + r[2] > size.width || r[1] + r[3] > size.height) ? `source.rect [${r.join(', ')}] goes outside the ${size.width}×${size.height} ${slot.source.file}` : null;
}
const intersects = (a, b) => a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3];
/** Frames of one sheet whose rects overlap, unless either is flagged `source.overlap: true`: [[slotA, slotB, file]]. */
export function frameOverlaps(slots = []) {
  const bySheet = new Map(), out = [];
  for (const s of slots) { const r = rectOf(s); if (r && s.source.overlap !== true) bySheet.set(s.source.file, [...(bySheet.get(s.source.file) ?? []), [s.id, r]]); }
  for (const [file, list] of bySheet) for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) if (intersects(list[i][1], list[j][1])) out.push([list[i][0], list[j][0], file]);
  return out;
}
// A sheet's size from the first 64 KB of its archived bytes (file-tree archives carry no binary content: then unknown).
function sheetSize(archive, path, sizes) {
  if (!sizes.has(path)) { const f = archive.files.find(x => x.path === path); let size = null; try { size = f?.content ? imageSize(fromBase64(f.content.slice(0, 87384))) : null; } catch { size = null; } sizes.set(path, size); }
  return sizes.get(path);
}

// ---- v1.3: baked images ----------------------------------------------------------------------------
// `bake: {from, hash, pointer?}` on an image slot: the game's own code or generator (`from`, a path in the game) drew
// the image and it was saved to a file. `hash` is the sha256 (hex) of `from` at bake time; with `pointer` (a .json
// `from`) it is the sha256 of canonical JSON (lib/source-record.mjs `canonical`) of the value there, so one monster's
// shape list drifts on its own instead of the whole table. Replacing the file overrides the generated art.
const SHA256 = /^[0-9a-f]{64}$/;
/** What's wrong with a slot's `bake`, or null (shape only: `from` may live outside the served folder). */
export function bakeProblem(/** @type {any} */ slot) {
  const b = slot?.bake;
  if (b === undefined) return null;
  if (slot.type !== 'image' && slot.type !== 'model') return 'bake is for image and model slots';
  // v1.4: a model the game builds in code (export-glb.mjs) names the builder, so a later code-fallback hook knows what it replaces.
  if (b && typeof b === 'object' && b.build !== undefined && (slot.type !== 'model' || typeof b.build !== 'string' || !b.build || b.build.length > 200)) return 'bake.build is the builder in bake.from (a model slot only)';
  if (!b || typeof b !== 'object' || typeof b.from !== 'string' || !b.from || b.from.startsWith('/') || b.from.includes('..') || /^[a-z]+:/i.test(b.from)) return 'bake.from must be a path inside the game';
  if (typeof b.hash !== 'string' || !SHA256.test(b.hash)) return 'bake.hash must be a sha256 (64 lowercase hex characters)';
  if (b.pointer !== undefined && (typeof b.pointer !== 'string' || !b.pointer.startsWith('/') || !/\.json$/i.test(b.from))) return 'bake.pointer must be a JSON pointer into a .json bake.from';
  if (b.sites !== undefined && (typeof b.sites !== 'string' || !SHA256.test(b.sites) || b.pointer !== undefined)) return 'bake.sites must be a sha256 (64 lowercase hex characters) of the text around the slot\'s frames, with no bake.pointer';
  return null;
}
// v1.5 round 2 (2026-10-02): `bake.sites`, drift per position. A drawn picture's patterns (and a code-built model's bake.sig)
// are positions in bake.from, so drift is the text around those positions changing, not any edit to the file (one edit to
// a 3 MB index.html made 129 pictures "drifted"). Same rule as builder/asset-manifest/validate.mjs bakeSitesText: keep in step.
const SITE_RADIUS = 64, SITE_LINES = /\r\n|[\n\r\u2028\u2029]/, SITE_FRAME = /^(.*):(\d+):(\d+)$/;
/** The text bake.sites hashes for these frames in `from` (null when none is in it). */
export function bakeSitesText(/** @type {string} */ text, /** @type {any[]} */ frames, /** @type {string} */ from) {
  const at = new Map();
  for (const f of frames ?? []) { const m = SITE_FRAME.exec(String(f)); if (m && m[1] === from) at.set(`${+m[2]}:${+m[3]}`, [+m[2], +m[3]]); }
  if (!at.size) return null;
  const lines = String(text).split(SITE_LINES);
  return [...at.values()].sort((a, b) => a[0] - b[0] || a[1] - b[1])
    .map(([l, c]) => `${l}:${c}:${lines[l - 1] === undefined ? '\u0000' : lines[l - 1].slice(Math.max(0, c - 1 - SITE_RADIUS), c - 1 + SITE_RADIUS)}`).join('\n');
}
const siteFrames = (/** @type {any} */ s) => [...(Array.isArray(s?.drawn?.sig) ? s.drawn.sig.flat() : []), ...(Array.isArray(s?.bake?.sig) ? s.bake.sig : [])];
/** The hash a bake would have now: sha256 of the file's bytes, or of canonical JSON at `pointer`. Null when it can't be read. */
export async function bakeHashOf(archive, bake, cache = new Map()) {
  const f = archive.files.find(x => x.path === bake.from);
  if (!f) return null;
  if (bake.pointer === undefined) return typeof f.sha256 === 'string' && SHA256.test(f.sha256) ? f.sha256 : null;
  const doc = archiveJson(archive, bake.from, cache);
  let v; try { v = doc && !doc.__invalid ? getPointer(doc, bake.pointer) : undefined; } catch { v = undefined; }
  return v === undefined ? null : hash(canonical(v));
}
/**
 * Drift of every baked image slot: {slotId: {from, pointer?, drift, by?}}. drift is true when the generator changed since
 * the bake (re-bake, or keep the file on purpose), false when it matches, null when `from` isn't in this version.
 * v1.5 round 2: a slot with `bake.sites` whose file changed is judged by the text around its own frames (`by: 'sites'`)
 * when the archive carries that file's text; file-tree archives carry it only for files code slots point into, so
 * otherwise the whole-file hash decides, as before.
 */
export async function bakeStatus(manifest, archive) {
  const out = {}, cache = new Map();
  for (const s of Array.isArray(manifest?.slots) ? manifest.slots : []) {
    if (!s?.bake || bakeProblem(s)) continue;
    const now = await bakeHashOf(archive, s.bake, cache);
    let drift = now === null ? null : now !== s.bake.hash, by = null;
    if (drift && typeof s.bake.sites === 'string') {
      const f = archive.files.find(x => x.path === s.bake.from);
      let text = null; try { text = f?.content ? utf8(fromBase64(f.content)) : null; } catch { text = null; }
      const t = text === null ? null : bakeSitesText(text, siteFrames(s), s.bake.from);
      if (t !== null) { drift = (await hash(t)) !== s.bake.sites; by = 'sites'; }
    }
    out[s.id] = {from: s.bake.from, ...(s.bake.pointer ? {pointer: s.bake.pointer} : {}), drift, ...(by ? {by} : {})};
  }
  return out;
}

// ---- v1.5 (2026-10-02): images the game draws in its own code --------------------------------------
// An image slot with `drawn: {kind, sig, rect?, size, hash, preview, from, uses?, fit?}` is art the game paints in code
// (a canvas, a region of one, or a sprite drawn into another). `drawn.preview` is the capture of the game's own art: the
// slot shows it while `source.file === drawn.preview` ("own"). A replacement is written to art/<slot-id>.<ext> and
// `source.file` moves to it ("replaced"); "Use the game's own art" moves it back. The capture is never overwritten or
// removed. A draft may change only `source.file`; `drawn` and `bake` always come from the saved manifest, and a drawn
// slot can't be removed. The game side (gf/code-art.js, gf-assets 1.2.0) paints the replacement in by `drawn.sig` and
// `drawn.hash`. Contract: asset-manifest/code-art-2026-10-02/BUILD_BRIEF.md, merged into docs/asset-manifest.md.
export const DRAWN_KINDS = ['canvas', 'region', 'sprite'];
export const DRAWN_FITS = ['stretch', 'contain', 'cover'];
/** What a replacement can be: a PNG. The game's shim (gf/code-art.js) decodes PNG synchronously while it starts, so the
 *  replacement is ready for the game's first paints; any other format would decode too late for textures the game
 *  uploads while it loads. The Assets tab converts every upload, generated picture and edit to a PNG fitted to
 *  `drawn.size` by `drawn.fit` (frames.ts drawnPng) before it saves, and the server refuses anything else. */
export const DRAWN_FORMATS = ['png'];
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** True when the bytes start with the PNG signature. @param {Uint8Array} bytes */
export const isPngBytes = bytes => !!bytes && bytes.length >= 8 && PNG_SIGNATURE.every((b, i) => bytes[i] === b);
/** A slot's `drawn` block (image slots only), or null. */
export const drawnOf = (/** @type {any} */ slot) => (slot?.type === 'image' && slot.drawn && typeof slot.drawn === 'object' && !Array.isArray(slot.drawn) && typeof slot.drawn.preview === 'string' ? slot.drawn : null);
export const isDrawnSlot = (/** @type {any} */ slot) => !!drawnOf(slot);
/** 'own' while the slot shows the game's own art, 'replaced' when another file takes over; null for other slots. */
export const drawnState = (/** @type {any} */ slot) => { const d = drawnOf(slot); return d ? (slot.source?.file === d.preview ? 'own' : 'replaced') : null; };
const normExt = ext => (ext === 'jpeg' ? 'jpg' : ext);
/** Where a replacement for a drawn slot is saved: art/<slot-id>.<ext>. */
export const drawnPath = (/** @type {any} */ slot, /** @type {string} */ filename) => `art/${slot.id}.${normExt(extOf(filename))}`;
/** Why `filename` can't replace a drawn slot's art, or null. */
export function drawnFormatProblem(/** @type {any} */ slot, /** @type {string} */ filename) {
  const ext = normExt(extOf(filename));
  return DRAWN_FORMATS.includes(ext) ? null : `${slot?.label ?? slot?.id ?? 'This picture'} is drawn by the game’s code, so its replacement is saved as a PNG the size the game draws it (only a PNG is ready in time for the game’s first paints). This file is a .${ext || '?'} file: pick it in the Assets tab, which converts it to PNG for you.`;
}
const posInts = (v, n) => Array.isArray(v) && v.length === n && v.every(x => Number.isInteger(x) && x >= 0);
/** What's wrong with a slot's `drawn` block, or null (the shape Studio relies on; builder/asset-manifest/validate.mjs checks the rest). */
export function drawnProblem(/** @type {any} */ slot) {
  const d = slot?.drawn;
  if (d === undefined) return null;
  if (slot.type !== 'image') return 'drawn is for image slots';
  if (!d || typeof d !== 'object' || Array.isArray(d)) return 'drawn must be an object';
  if (!DRAWN_KINDS.includes(d.kind)) return `drawn.kind must be one of ${DRAWN_KINDS.join(', ')}`;
  if (typeof d.preview !== 'string' || !d.preview) return 'drawn.preview must be the path of the captured picture';
  try { sourcePath(d.preview); } catch { return 'drawn.preview must be a path inside the game'; }
  if (!FILE_TYPES.image.includes(extOf(d.preview)) || extOf(d.preview) === 'svg') return 'drawn.preview must be a PNG, WebP, JPEG or GIF';
  if (d.size !== undefined && !(posInts(d.size, 2) && d.size[0] > 0 && d.size[1] > 0)) return 'drawn.size must be [width, height] in whole pixels';
  if (d.rect !== undefined && !(posInts(d.rect, 4) && d.rect[2] > 0 && d.rect[3] > 0)) return 'drawn.rect must be [x, y, width, height] in whole pixels';
  if (d.fit !== undefined && !DRAWN_FITS.includes(d.fit)) return `drawn.fit must be one of ${DRAWN_FITS.join(', ')}`;
  if (d.sig !== undefined && !Array.isArray(d.sig)) return 'drawn.sig must be a list of call-stack patterns';
  if (d.from !== undefined && typeof d.from !== 'string') return 'drawn.from must be text';
  if (slot.source?.rect !== undefined) return 'a drawn slot has drawn.rect, not source.rect (its preview is already the cropped picture)';
  return null;
}
/**
 * Direct edits that would break a drawn slot's rules: a file written over any capture (`drawn.preview` is never
 * overwritten), and a patch into assets.json that reaches a drawn slot (its `drawn` and `bake` come from the capture).
 * One creator-facing line per refused edit (empty = fine). Patches: [{file, pointer}]; swaps: [path].
 * @returns {string[]}
 */
export function drawnEditProblems(manifest, {patches = [], swaps = []} = {}) {
  const slots = Array.isArray(manifest?.slots) ? manifest.slots : [], out = [];
  const drawn = slots.map((s, i) => [s, i]).filter(([s]) => drawnOf(s));
  if (!drawn.length) return out;
  for (const path of swaps) { const hit = drawn.find(([s]) => s.drawn.preview === path); if (hit) out.push(`${path} is the game’s own art for ${hit[0].label ?? hit[0].id}, captured from its code, so it can’t be overwritten. A replacement is saved beside it.`); }
  for (const p of patches) {
    if (p?.file !== MANIFEST_PATH) continue;
    const hit = drawn.find(([, i]) => pointerContains(String(p.pointer), `/slots/${i}`) || pointerContains(`/slots/${i}`, String(p.pointer)));
    if (hit) out.push(`${hit[0].label ?? hit[0].id} is drawn by the game’s code; only its file can change here.`);
  }
  return out;
}

// ---- v1.3: big values load when their card opens -------------------------------------------------
// pokemon-red's manifest route sent 855 KB of values, mostly whole `json` tables. The route keeps json values over
// DEFER_VALUE_BYTES out of `values` and lists them in `deferred` with a summary; the Assets tab fetches one
// (GET …/manifest?slot=<id>) when its card's editor opens or it is attached to a message.
export const DEFER_VALUE_BYTES = 2048;
/** Plain-language summary of a JSON value for a card ("12 items", "“Pallet Town” · 40 rows · 3 fields: …"). */
export function jsonSummary(value) {
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? '' : 's'}`;
  if (value && typeof value === 'object') {
    const name = typeof value.name === 'string' ? value.name : null, keys = Object.keys(value);
    const rows = Array.isArray(value.rows) ? ` · ${value.rows.length} rows` : '';
    return (name ? `“${name}”${rows} · ` : '') + `${keys.length} field${keys.length === 1 ? '' : 's'}: ${keys.slice(0, 5).join(', ')}${keys.length > 5 ? '…' : ''}`;
  }
  return JSON.stringify(value);
}
/**
 * Splits a manifest's values into the ones sent with it and the big json ones that load on demand.
 * @returns {{values: Record<string, unknown>, deferred: Record<string, {bytes: number, summary: string}>}}
 */
export function deferValues(manifest, values, limit = DEFER_VALUE_BYTES) {
  const json = new Set((Array.isArray(manifest?.slots) ? manifest.slots : []).filter(s => s?.type === 'json').map(s => s.id));
  /** @type {Record<string, unknown>} */ const kept = {};
  /** @type {Record<string, {bytes: number, summary: string}>} */ const deferred = {};
  for (const [id, v] of Object.entries(values ?? {})) {
    const bytes = json.has(id) ? JSON.stringify(v).length : 0;
    if (bytes > limit) deferred[id] = {bytes, summary: jsonSummary(v)}; else kept[id] = v;
  }
  return {values: kept, deferred};
}

// ---- v1.4 (2026-10-02): values in code ------------------------------------------------------------
// A value slot may point into the game's own code: `source: {file, code: {start, end, text, path, lang?}}` (offsets in
// UTF-16 code units of the decoded file; lib/code-literals.mjs). Studio reads its value from the literal and writes an
// edit back in the literal's own style. Saving needs the file itself, so code slots are edited in file-tree versions:
// in an inline (single packed page) version the code is bundled into the page, and the slot is view only there.
export const CODE_TREE_ONLY = 'This value is in the game’s code, and this version is one packed page, so Studio can’t change it here. Ask to change, and the builder will edit the code.';
export const CODE_STALE = `${STALE} Ask to change, or re-scan the game’s code (asset-manifest/scan-code.mjs --write).`;
/** A code file's text from an archive (null when the file or its bytes aren't there, or it isn't UTF-8). */
export function archiveCode(archive, path, cache = new Map()) {
  if (cache.has(path)) return cache.get(path);
  const f = archive.files.find(x => x.path === path);
  let t = null;
  try { t = f?.content ? decodeCode(fromBase64(f.content)) : null; } catch { t = null; }
  cache.set(path, t);
  return t;
}
/** What's wrong with a code value slot's address and literal, or null. The file's current text is checked by locateCode. */
export function codeSlotProblem(/** @type {any} */ slot) {
  if (!isValueSlot(slot)) return 'source.code is for value slots';
  if (slot.source.pointer !== undefined) return 'a code slot has source.code instead of source.pointer';
  if (!isCodeFile(slot.source.file)) return `source.code points into ${slot.source.file}, which is not a .js, .mjs, .cjs, .css or .html file`;
  const shape = codeShapeProblem(slot.source.code);
  if (shape) return shape;
  const r = readCodeValue(slot);
  if (!r.ok) return `source.code.text does not read as ${slot.type}: ${r.reason}`;
  const numeric = slot.type === 'color' && codeLang(slot) === 'js' && /^[\d.]/.test(slot.source.code.text.trim()) && !slot.source.code.text.includes(',');   // round 2: `1, .97, .79` (uniform4f's numbers) is a colour kept as numbers, not one number
  if (numeric !== (slot.constraints?.format === COLOR_INT)) return numeric ? `a colour kept as a number needs constraints.format "${COLOR_INT}"` : `constraints.format "${COLOR_INT}" is for colours kept as numbers in code`;
  const v = slotValueProblem(slot, r.value);
  return v ? `${slot.label ?? slot.id} ${v}` : null;
}
/**
 * The manifest as Studio offers it for editing: code slots are view only (with the reason) when the version can't take
 * code edits (`code: false`, an inline version) or when their literal can't be found (stale). Others are unchanged.
 */
export function codeLocks(manifest, anchors, {code = false, readable = () => true} = {}) {
  const slots = Array.isArray(manifest?.slots) ? manifest.slots : [];
  if (!slots.some(s => s?.source?.code !== undefined && isEditable(s))) return manifest;
  const lock = (s, readonlyReason) => ({...s, editable: false, readonlyReason});
  return {...manifest, slots: slots.map(s => (s?.source?.code === undefined || !isEditable(s) ? s
    : !code ? lock(s, CODE_TREE_ONLY)
    : !anchors[s.id] ? lock(s, readable(s.source.file) ? CODE_STALE : `${s.source.file} can’t be read in this version, so Studio can’t change this value.`) : s))};
}

// ---- Slot targets on messages ("Ask to change") --------------------------------------------------
export const MAX_SLOT_TARGETS = 12;
const SLOT_VALUE_BYTES = 16 * 1024;
const bad = message => Object.assign(new Error(message), {status: 400});
const text = (value, name, max, required = false) => {
  if (value == null || value === '') { if (required) throw bad(`${name} is required.`); return undefined; }
  if (typeof value !== 'string' || value.length > max || /\u0000/.test(value)) throw bad(`${name} must be at most ${max} characters.`);
  return value.trim() || undefined;
};
/**
 * Validates the optional `slots` of a message (docs/asset-manifest.md §4, "Ask to change").
 * Each item: {slot:{id,type,source:{file,pointer?},label,description?,constraints?}, value? | revisionId?, note?}.
 * Returns the normalized list (null when absent). Revision ownership is checked by the caller.
 */
export function normalizeSlotTargets(list) {
  if (list == null) return null;
  if (!Array.isArray(list)) throw bad('Slots must be a list.');
  if (list.length > MAX_SLOT_TARGETS) throw bad(`A message can target at most ${MAX_SLOT_TARGETS} slots.`);
  const seen = new Set();
  return list.map(item => {
    const s = item?.slot;
    if (!s || typeof s !== 'object' || typeof s.id !== 'string' || !SLOT_ID.test(s.id)) throw bad('Invalid slot.');
    if (seen.has(s.id)) throw bad('Each slot can be targeted once per message.');
    seen.add(s.id);
    if (!isFileSlot(s) && !isValueSlot(s) && s.type !== 'sound') throw bad('Unknown slot type.');
    let file;
    try { file = sourcePath(s.source?.file); } catch { throw bad('Invalid slot source.'); }
    const pointer = s.source?.pointer;
    if (pointer !== undefined && (typeof pointer !== 'string' || pointer.length > 300)) throw bad('Invalid slot pointer.');
    if (s.constraints !== undefined && (typeof s.constraints !== 'object' || s.constraints === null || JSON.stringify(s.constraints).length > 4096)) throw bad('Invalid slot constraints.');
    // v1.4: a code slot tells the builder where its literal is (offsets, the readable anchor, and short literals' text).
    const c = s.source?.code;
    if (c !== undefined && (!c || typeof c !== 'object' || !Number.isInteger(c.start) || !Number.isInteger(c.end) || c.start < 0 || c.end <= c.start || typeof c.path !== 'string' || c.path.length > 200 || (c.lang !== undefined && !CODE_LANGS.includes(c.lang)) || (c.text !== undefined && typeof c.text !== 'string'))) throw bad('Invalid slot code anchor.');
    const code = c === undefined ? null : {start: c.start, end: c.end, path: c.path, ...(c.lang ? {lang: c.lang} : {}), ...(typeof c.text === 'string' && c.text.length <= 1000 ? {text: c.text} : {})};
    const slot = {id: s.id, type: s.type, source: {file, ...(pointer === undefined ? {} : {pointer}), ...(code ? {code} : {})}, label: text(s.label, 'Slot label', 120, true)};
    const description = text(s.description, 'Slot description', 500);
    if (description) slot.description = description;
    if (s.constraints !== undefined) slot.constraints = clone(s.constraints);
    const out = {slot};
    if (item.revisionId != null) {
      if (typeof item.revisionId !== 'string' || !/^[-a-z0-9]{12,64}$/.test(item.revisionId)) throw Object.assign(new Error('Attachment not found.'), {status: 404});
      out.revisionId = item.revisionId;
    } else if (item.value !== undefined) {
      if (JSON.stringify(item.value).length > SLOT_VALUE_BYTES) throw bad(`${slot.label}: the current value is too large to attach.`);
      out.value = clone(item.value);
    }
    const note = text(item.note, 'Slot note', 500);
    if (note) out.note = note;
    return out;
  });
}
