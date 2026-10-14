// Static check of a game's assets.json. Contract: creator-studio/docs/asset-manifest.md §2, §6.
//   node builder/asset-manifest/validate.mjs <game-dir> [--json]
// Exit 0 when valid (warnings allowed), 1 when not.
import { readFile, readdir, stat } from 'node:fs/promises';
import { existsSync, openSync, readSync, closeSync, readFileSync } from 'node:fs';
import { resolve, relative, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPointer } from '../gf-assets/source/gf-assets.js';
import { kindForFilename, isAssetPath } from '../studio-lib/asset-kinds.mjs';
import { canonical } from '../studio-lib/source-record.mjs';
import { normalizeManifest, groupDefaultsProblems } from '../studio-lib/manifest-normalize.mjs';
import { imageSize } from '../studio-lib/image-size.mjs';
import { isCodeFile, codeShapeProblem, readCodeValue, locateCode, decodeCode, codeLang, rangesOverlap, COLOR_INT, COLOR_FORMATS, isLiteralPathRef, pathLiterals } from '../studio-lib/code-literals.mjs';
import { createHash } from 'node:crypto';
// Sounds are validated by the gf-audio kit this checkout carries (builder/gf-audio: one copy, its version in
// source/VERSION); a game that vendored another version (audio/VERSION) gets no sound validation, and the result says so.
const AUDIO_KIT = new URL('../gf-audio/source/', import.meta.url);
export const LATEST_AUDIO_KIT = (() => { try { return readFileSync(new URL('VERSION', AUDIO_KIT), 'utf8').trim().replace(/^gf-audio@?/, ''); } catch { return null; } })();
async function soundValidator(dir) {
  let v = LATEST_AUDIO_KIT;
  try { v = (await readFile(resolve(dir, 'audio/VERSION'), 'utf8')).trim().replace(/^gf-audio@?/, '') || v; } catch { /* no vendored kit */ }
  if (v !== LATEST_AUDIO_KIT || !existsSync(new URL('sounds.mjs', AUDIO_KIT))) return { version: v, validate: null };
  return { version: v, validate: (await import(new URL('sounds.mjs', AUDIO_KIT).href)).validateManifest };
}

export const SCHEMA = 'gf-assets/1';
const REPO = fileURLToPath(new URL('../../', import.meta.url));
export const FILE_TYPES = {
  image: ['png', 'webp', 'jpg', 'jpeg', 'svg', 'gif', 'avif'],
  audio: ['ogg', 'mp3', 'wav', 'm4a', 'flac'],
  model: ['glb', 'gltf'],
  texture: ['ktx2', 'hdr'],   // v1.3: KTX2 (Basis or raw) and Radiance HDR; replaced only by the same format
  font: ['ttf', 'otf', 'woff', 'woff2'],
  data: ['json', 'ink', 'txt', 'svg', 'tmj', 'csv', 'pzl'],
};
/** The main tier Studio shows first: more than this many main slots is a warning (main-tier.mjs keeps tools within it). */
export const MAIN_MAX = 40;
export const VALUE_TYPES = ['color', 'colors', 'number', 'integer', 'boolean', 'enum', 'text', 'json'];
const SLOT_ID = /^[a-z0-9][a-z0-9_.-]{0,79}$/;
const GROUP_ID = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const HEX = /^(?:#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})|rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(?:,\s*(?:0|1|0?\.\d+)\s*)?\))$/i;
const ext = p => extname(p).slice(1).toLowerCase();
const isNum = v => typeof v === 'number' && Number.isFinite(v);

// Minimal glob: ** = any depth, * = within one segment.
export function globToRegExp(glob) {
  const re = glob.split('**').map(part => part.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')).join('.*');
  return new RegExp(`^${re}$`);
}

async function walk(dir, root = dir, out = []) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const p = resolve(dir, e.name);
    if (e.isDirectory()) await walk(p, root, out);
    else out.push(relative(root, p).split(sep).join('/'));
  }
  return out;
}

function checkValue(slot, v, at, errors) {
  const c = slot.constraints ?? {};
  switch (slot.type) {
    case 'color': if (typeof v !== 'string' || !HEX.test(v)) errors.push(`${at}: value ${JSON.stringify(v)} is not a hex colour`); break;
    case 'colors': {
      const list = Array.isArray(v) ? v : v && typeof v === 'object' ? Object.values(v) : null;
      if (!list || !list.length || list.some(x => typeof x !== 'string' || !HEX.test(x))) errors.push(`${at}: value must be a non-empty array/object of hex colours`);
      break;
    }
    case 'number': case 'integer':
      if (!isNum(v) || (slot.type === 'integer' && !Number.isInteger(v))) errors.push(`${at}: value ${JSON.stringify(v)} is not ${slot.type === 'integer' ? 'an integer' : 'a number'}`);
      else if ((isNum(c.min) && v < c.min) || (isNum(c.max) && v > c.max)) errors.push(`${at}: value ${v} is outside ${c.min}..${c.max}`);
      break;
    case 'boolean': if (typeof v !== 'boolean') errors.push(`${at}: value is not a boolean`); break;
    case 'enum':
      if (!Array.isArray(c.options) || !c.options.length) errors.push(`${at}: enum needs constraints.options`);
      else if (!c.options.some(o => (o?.value ?? o) === v)) errors.push(`${at}: value ${JSON.stringify(v)} is not one of its options`);
      break;
    case 'text': if (typeof v !== 'string') errors.push(`${at}: value is not a string`); else if (isNum(c.maxLength) && v.length > c.maxLength) errors.push(`${at}: text longer than maxLength ${c.maxLength}`); break;
    case 'json': if (v === undefined) errors.push(`${at}: pointer resolves to nothing`); break;
  }
}

// v1.4 sounds built in code (gf-audio 1.5.0; audio/capture-code-sounds.mjs writes them). The kit's validateManifest
// checks the shape; here: the recording exists (and counts as referenced), the files the patterns name exist, the capture's
// bake hasn't drifted (the patterns are positions in those files), and the game loads the shim that plays them.
const versionAtLeast = (v, min) => { const [a = 0, b = 0, c = 0] = String(v ?? '').split('.').map(Number), [x, y, z] = min.split('.').map(Number); return a !== x ? a > x : b !== y ? b > y : c >= z; };
async function checkCodeSound(id, s, dir, kitVersion, { errors, warnings, referenced, codeFiles, drift }) {
  const at = `sounds.${id}`, c = s.code;
  if (!versionAtLeast(kitVersion, '1.5.0')) errors.push(`${at}: sounds built in code need gf-audio 1.5.0 or later (this game has ${kitVersion}); run audio/capture-code-sounds.mjs --write`);
  if (typeof c.preview === 'string') { if (!existsSync(resolve(dir, c.preview))) errors.push(`${at}.code.preview: ${c.preview} does not exist`); else referenced.add(c.preview); }
  const files = new Set((Array.isArray(c.sig) ? c.sig : []).flat().map(f => /^(.*):\d+:\d+$/.exec(String(f))?.[1]).filter(Boolean));
  for (const f of files) { codeFiles.set(f, true); if (!existsSync(resolve(dir, f))) warnings.push(`${at}.code.sig: ${f} is not in the game folder, so those patterns never match`); }
  const b = s.bake;
  if (b && b.sites !== undefined && (typeof b.sites !== 'string' || !SHA256.test(b.sites))) errors.push(`${at}.bake.sites: the sha256 of the text around the sound's frames (64 lowercase hex characters; validate.mjs bakeSites)`);
  else if (b && typeof b.from === 'string' && typeof b.hash === 'string' && existsSync(resolve(dir, b.from))) {
    const d = await bakeDrift(dir, b, (Array.isArray(c.sig) ? c.sig : []).flat());
    if (d.drift) drift.push({ at, from: b.from, now: d.now, what: 'sound', sites: d.sites });
  }
}
async function checkCodeShim(dir, errors, warnings) {
  if (!existsSync(resolve(dir, 'audio/code-sounds.js'))) { errors.push('sounds: sounds built in code need audio/code-sounds.js (gf-audio 1.5.0); run audio/capture-code-sounds.mjs --write'); return; }
  const html = await readFile(resolve(dir, 'index.html'), 'utf8').catch(() => '');
  const tag = /<script\b[^>]*\bsrc\s*=\s*["']?(?:\.\/)?audio\/code-sounds\.js["'\s>]/i.exec(html), first = html.search(/<script\b/i);
  if (!tag) warnings.push('sounds: index.html does not load audio/code-sounds.js, so Studio lists the sounds built in code but the game plays no replacement');
  // (v1.5) gf/code-art.js may come before it: both are kit scripts that must run before the game's.
  else if (first >= 0 && tag.index > first && [...html.slice(0, tag.index).matchAll(/<script\b[^>]*>/gi)].some(m => !KIT_SCRIPT.test(m[0]))) warnings.push('sounds: audio/code-sounds.js must be the first <script> in index.html, before any game code');
}

// v1.5 images built in code (gf-assets 1.2.0 gf/code-art.js; asset-manifest/capture-code-art.mjs writes them).
// The slot shows the game's own art while source.file equals drawn.preview; any other file is the creator's replacement,
// which the shim paints in at the place drawn.sig and drawn.rect name. The preview always stays referenced.
const DRAWN_KINDS = ['canvas', 'region', 'sprite'], DRAWN_USES = ['texture', 'drawImage', 'dataURL', 'pattern', 'bitmap', 'pixels'], DRAWN_FITS = ['stretch', 'contain', 'cover'];
const FRAME = /^(.*):(\d+):(\d+)$/;
const wholeInts = (a, n, min = 0) => Array.isArray(a) && a.length === n && a.every(x => Number.isInteger(x) && x >= min);
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** True/false when the file starts (or doesn't) with the PNG signature; null when it can't be read (missing: reported elsewhere). */
function isPngFile(path) {
  let fd = null;
  try { fd = openSync(path, 'r'); const b = Buffer.alloc(8); return readSync(fd, b, 0, 8, 0) === 8 && b.equals(PNG_SIGNATURE); }
  catch { return null; } finally { if (fd !== null) closeSync(fd); }
}
export const CODE_ART_PATH = 'gf/code-art.js', CODE_ART_MIN = '1.2.0', CODE_ART_ALSO_MIN = '1.2.1';
function checkDrawn(s, at, dir, safePath, { errors, warnings, referenced, drawnFiles }) {
  const d = s.drawn;
  if (!d || typeof d !== 'object' || Array.isArray(d)) return errors.push(`${at}.drawn: an object (v1.5 images built in code)`);
  if (s.type !== 'image') return errors.push(`${at}.drawn: image slots only`);
  if (s.facet !== undefined && s.facet !== 'look') errors.push(`${at}.facet: a picture drawn in code is on the Look tab ("look")`);
  if (!DRAWN_KINDS.includes(d.kind)) errors.push(`${at}.drawn.kind: ${DRAWN_KINDS.map(k => `"${k}"`).join(', ')}`);
  if (!Array.isArray(d.sig) || d.sig.some(p => !Array.isArray(p) || !p.length || p.some(f => typeof f !== 'string' || !FRAME.test(f)))) errors.push(`${at}.drawn.sig: a list of call-stack patterns, each a non-empty list of "file:line:col" frames`);
  else if (!d.sig.length && s.editable !== false && d.kind !== 'sprite') errors.push(`${at}.drawn.sig: an editable picture needs at least one pattern`);
  if (!wholeInts(d.size, 2, 1)) errors.push(`${at}.drawn.size: [width, height] in whole pixels`);
  if (d.kind === 'region' || d.kind === 'sprite') {
    if (!wholeInts(d.rect, 4) || d.rect[2] < 1 || d.rect[3] < 1) errors.push(`${at}.drawn.rect: [x, y, width, height] in whole pixels of the canvas`);
    else if (wholeInts(d.size, 2, 1) && (d.size[0] !== d.rect[2] || d.size[1] !== d.rect[3])) errors.push(`${at}.drawn.size: must be the rect's width and height`);
  }
  if (d.kind === 'region') {
    if (!wholeInts(d.canvas, 2, 1)) errors.push(`${at}.drawn.canvas: [width, height] of the canvas the region is in`);
    else if (wholeInts(d.rect, 4) && (d.rect[0] + d.rect[2] > d.canvas[0] || d.rect[1] + d.rect[3] > d.canvas[1])) errors.push(`${at}.drawn.rect: [${d.rect.join(', ')}] goes outside the ${d.canvas.join('x')} canvas`);
  } else if (d.canvas !== undefined && !wholeInts(d.canvas, 2, 1)) errors.push(`${at}.drawn.canvas: [width, height]`);
  // Round 2 (gf-assets 1.2.1): `also`, the other places of the same canvas that hold the same picture (identical atlas
  // tiles), each [x, y, w, h] the size of `rect`, inside `canvas`. The 1.2.1 shim paints a replacement at every one; a
  // 1.2.0 shim paints only `rect` (checkCodeArtShim requires 1.2.1 when a slot uses it).
  if (d.also !== undefined) {
    if (d.kind !== 'region') errors.push(`${at}.drawn.also: region slots only (the other places of the atlas that hold the same picture)`);
    else if (!Array.isArray(d.also) || !d.also.length || d.also.some(r => !wholeInts(r, 4))) errors.push(`${at}.drawn.also: a non-empty list of [x, y, width, height] places in whole pixels of the canvas`);
    else if (wholeInts(d.rect, 4) && wholeInts(d.canvas, 2, 1)) {
      const key = r => r.join(','), seen = new Set([key(d.rect)]);
      for (const r of d.also) {
        if (r[2] !== d.rect[2] || r[3] !== d.rect[3]) errors.push(`${at}.drawn.also: [${r.join(', ')}] must be the rect's size (${d.rect[2]}x${d.rect[3]})`);
        else if (r[0] + r[2] > d.canvas[0] || r[1] + r[3] > d.canvas[1]) errors.push(`${at}.drawn.also: [${r.join(', ')}] goes outside the ${d.canvas.join('x')} canvas`);
        else if (seen.has(key(r))) errors.push(`${at}.drawn.also: [${r.join(', ')}] is listed twice (or is the rect itself)`);
        seen.add(key(r));
      }
    }
  }
  if (typeof d.hash !== 'string' || !/^[0-9a-f]{64}$/.test(d.hash)) errors.push(`${at}.drawn.hash: the sha256 of the original RGBA pixels (64 lowercase hex characters)`);
  if (d.nth !== undefined && !(Number.isInteger(d.nth) && d.nth >= 0)) errors.push(`${at}.drawn.nth: a whole number (which of the canvases this code paints, in order)`);
  if (d.fit !== undefined && !DRAWN_FITS.includes(d.fit)) errors.push(`${at}.drawn.fit: ${DRAWN_FITS.map(k => `"${k}"`).join(', ')}`);
  if (d.uses !== undefined && (!Array.isArray(d.uses) || d.uses.some(u => !DRAWN_USES.includes(u)))) errors.push(`${at}.drawn.uses: a list of ${DRAWN_USES.join(', ')}`);
  if (d.from !== undefined && (typeof d.from !== 'string' || d.from.length > 200)) errors.push(`${at}.drawn.from: where it's made, for people ("index.html:245 texture")`);
  // The preview: the capture of the game's own art. Always kept and referenced, even after a replacement.
  if (!safePath(d.preview) || !/\.png$/i.test(d.preview)) errors.push(`${at}.drawn.preview: a .png path inside the game`);
  else if (!existsSync(resolve(dir, d.preview))) errors.push(`${at}.drawn.preview: ${d.preview} does not exist`);
  else referenced.add(d.preview);
  // Studio writes a replacement to art/<slot-id>.png, so a capture stored there would refuse every replacement (409).
  if (typeof d.preview === 'string' && typeof s.id === 'string' && new RegExp(`^art/${s.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.[a-z0-9]+$`, 'i').test(d.preview)) warnings.push(`${at}.drawn.preview: ${d.preview} is where Studio saves a replacement (art/<slot-id>.png), so a replacement would be refused; keep captures elsewhere (art/code/…)`);
  if (s.source?.rect !== undefined) errors.push(`${at}.source.rect: a picture drawn in code has drawn.rect, not source.rect (its preview is already the cropped picture)`);
  const replaced = s.source?.file !== d.preview;
  if (replaced && s.editable === false) errors.push(`${at}.source.file: a view-only picture can't be replaced (it must stay ${d.preview})`);
  if (replaced && d.kind === 'sprite') errors.push(`${at}.source.file: a sprite drawn every frame can't be replaced yet (it must stay ${d.preview})`);
  // PNG only: the shim decodes PNG synchronously while it starts; any other format decodes after the game's first paints,
  // so textures uploaded while it loads (and icons made from them) would keep the game's own art. Studio converts every
  // replacement (upload, generated or edited) to a PNG at drawn.size before it saves, and its server refuses anything else.
  if (replaced && typeof s.source?.file === 'string' && (!/\.png$/i.test(s.source.file) || isPngFile(resolve(dir, s.source.file)) === false)) errors.push(`${at}.source.file: ${s.source.file} is not a PNG. A replacement of a picture drawn in code must be a PNG (the shim decodes only PNG in time for the game's first paints); convert it, fitted to drawn.size`);
  for (const f of new Set((Array.isArray(d.sig) ? d.sig : []).flat().map(x => FRAME.exec(String(x))?.[1]).filter(Boolean))) if (!existsSync(resolve(dir, f))) warnings.push(`${at}.drawn.sig: ${f} is not in the game folder, so those patterns never match`);
  drawnFiles.push(s.id);
  if (Array.isArray(d.also) && d.also.length) (drawnFiles.also ??= []).push(s.id);
}
async function checkCodeArtShim(dir, errors, warnings, { also = [] } = {}) {
  const p = resolve(dir, CODE_ART_PATH);
  if (!existsSync(p)) { errors.push(`slots: pictures built in code need ${CODE_ART_PATH} (gf-assets ${also.length ? CODE_ART_ALSO_MIN : CODE_ART_MIN} or later); run asset-manifest/capture-code-art.mjs --write`); return; }
  const v = /^\/\/ games\.fun asset runtime, gf-assets\/(\d+\.\d+\.\d+)/.exec(await readFile(p, 'utf8').catch(() => ''))?.[1];
  if (!v || !versionAtLeast(v, CODE_ART_MIN)) errors.push(`slots: pictures built in code need gf-assets ${CODE_ART_MIN} or later (${CODE_ART_PATH} is ${v ?? 'not the kit’s file'}); copy gf-assets/${CODE_ART_MIN}/source/code-art.js`);
  // A slot with drawn.also needs the 1.2.1 shim: 1.2.0 ignores `also` and paints a replacement at the first place only.
  else if (also.length && !versionAtLeast(v, CODE_ART_ALSO_MIN)) errors.push(`slots: ${also.length} picture(s) built in code sit at several places (drawn.also: ${also.slice(0, 3).join(', ')}${also.length > 3 ? ', …' : ''}), which needs gf-assets ${CODE_ART_ALSO_MIN} or later (${CODE_ART_PATH} is ${v}, which paints a replacement at the first place only); copy gf-assets/${CODE_ART_ALSO_MIN}/source/code-art.js, or run asset-manifest/capture-code-art.mjs --write`);
  const html = await readFile(resolve(dir, 'index.html'), 'utf8').catch(() => '');
  const scripts = [...html.matchAll(/<script\b[^>]*>/gi)];
  const i = scripts.findIndex(m => /\bsrc\s*=\s*["']?(?:\.\/)?gf\/code-art\.js["'\s>]/i.test(m[0]));
  if (i < 0) warnings.push(`slots: index.html does not load ${CODE_ART_PATH}, so Studio shows the pictures built in code but the game draws no replacement`);
  else if (scripts.slice(0, i).some(m => !KIT_SCRIPT.test(m[0]))) warnings.push(`slots: ${CODE_ART_PATH} must be loaded before any game script (first in index.html)`);
}
// Scripts of the shared kits that may come before each other at the top of index.html.
const KIT_SCRIPT = /\bsrc\s*=\s*["']?(?:\.\/)?(?:gf\/code-art\.js|audio\/code-sounds\.js)["'\s>]/i;

// v1.3 baked images (builder/studio-lib/manifest.mjs bakeProblem/bakeHashOf; keep in step): bake: {from, hash, pointer?};
// v1.4 also model slots, with build: the builder in from.
const SHA256 = /^[0-9a-f]{64}$/;
const BAKE_FRAME = /^[^:\s][^\s]*:\d+:\d+$/;
const sha256 = data => createHash('sha256').update(data).digest('hex');
/** The hash a bake would have now: sha256 of bake.from's bytes, or of canonical JSON at bake.pointer. Null when unreadable. */
export async function bakeHash(dir, bake, cache = new Map()) {
  if (!cache.has(bake.from)) cache.set(bake.from, readFile(resolve(dir, bake.from)).then(buf => ({ buf, doc: undefined })).catch(() => null));
  const f = await cache.get(bake.from);
  if (!f) return null;
  if (bake.pointer === undefined) return f.hash ??= sha256(f.buf);
  let v; try { f.doc ??= JSON.parse(f.buf.toString('utf8')); v = getPointer(f.doc, bake.pointer); } catch { v = undefined; }
  return v === undefined ? null : sha256(canonical(v));
}
// Round 2 (2026-10-02, bug 43): drift per position. A picture or sound captured from code is matched by call-stack frames
// ("file:line:col"), so what must hold still is the text at those positions, not the whole file: one heart edit to a
// realistic-minecraft index.html gave 129 false "capture again" warnings. `bake.sites` (optional) is the sha256 of the text
// around the slot's (or sound's) own frames in `bake.from` (bakeSitesText below; the contract's "Bake drift per position"). With it, a file that
// changed elsewhere is no drift; without it (older manifests) the whole-file hash decides, as before, and many drifted
// items in one file are one warning. lib/manifest.mjs bakeStatus mirrors this for Studio: keep the two in step.
export const SITE_RADIUS = 64;
const SITE_LINES = /\r\n|[\n\r\u2028\u2029]/;
/** The text bake.sites hashes: for each distinct frame in `from` (sorted by line, then column), "line:col:" and up to
 *  SITE_RADIUS characters (UTF-16 code units) on each side of the 1-based column on that line ("\u0000" past the file's
 *  end), joined by "\n". Null when no frame is in `from`. */
export function bakeSitesText(text, frames, from) {
  const at = new Map();
  for (const f of frames ?? []) { const m = FRAME.exec(String(f)); if (m && m[1] === from) at.set(`${+m[2]}:${+m[3]}`, [+m[2], +m[3]]); }
  if (!at.size) return null;
  const lines = String(text).split(SITE_LINES);
  return [...at.values()].sort((a, b) => a[0] - b[0] || a[1] - b[1])
    .map(([l, c]) => `${l}:${c}:${lines[l - 1] === undefined ? '\u0000' : lines[l - 1].slice(Math.max(0, c - 1 - SITE_RADIUS), c - 1 + SITE_RADIUS)}`).join('\n');
}
/** bake.sites for these frames in this file's text: a sha256 hex, or null when no frame is in `from`. */
export function bakeSites(text, frames, from) { const t = bakeSitesText(text, frames, from); return t === null ? null : sha256(t); }
/** The frames a slot's bake.sites covers: a drawn picture's patterns, or a code-built model's creation site (bake.sig). */
export const siteFrames = s => [...(Array.isArray(s?.drawn?.sig) ? s.drawn.sig.flat() : []), ...(Array.isArray(s?.bake?.sig) ? s.bake.sig : [])];
/** The frames an item's bake.sites covers: a code sound's patterns (`code.sig`), else siteFrames. */
export const bakeFrames = x => (x?.code ? (Array.isArray(x.code.sig) ? x.code.sig.flat() : []) : siteFrames(x));
/** Every slot and sound of a manifest that can carry a bake. */
const bakeItems = m => [...(Array.isArray(m?.slots) ? m.slots : []), ...Object.values(m?.sounds?.sounds ?? {})].filter(x => x && typeof x === 'object');
/** The frames of every item, before a tool moves them (for restampBakes). */
export const framesBefore = m => new Map(bakeItems(m).map(x => [x, [...bakeFrames(x)]]));
/**
 * After a tool rewrote `from` (oldText → newText) without changing any code it captured (a shim tag inserted, a data URL
 * unpacked) and moved the frames that edit shifted, keep each bake from that file true (round-2 integration):
 *   - a bake that was current (bake.hash is oldText's) takes newText's hash, and bake.sites for its frames now;
 *   - a bake that had drifted elsewhere in the file but whose sites still held (per position) keeps its hash and gets
 *     its sites recomputed at the moved frames;
 *   - any other bake (drifted at its own positions, a pointer bake) is left as it was: a capture is still due.
 * `before`: framesBefore(m) taken before the frames moved (without it, frames are taken as unmoved). Changes m in place;
 * returns how many bakes it brought up to date.
 */
export function restampBakes(m, from, oldText, newText, before = null) {
  const was = sha256(Buffer.from(String(oldText), 'utf8')), now = sha256(Buffer.from(String(newText), 'utf8'));
  let n = 0;
  for (const x of bakeItems(m)) {
    const b = x.bake;
    if (!b || typeof b !== 'object' || b.from !== from || b.pointer !== undefined) continue;
    const cur = bakeFrames(x), old = before?.get(x) ?? cur;
    if (b.hash === was) {
      b.hash = now;
      const st = bakeSites(newText, cur, from);
      if (st) b.sites = st; else delete b.sites;
      n++;
    } else if (typeof b.sites === 'string' && b.sites === bakeSites(oldText, old, from)) {
      const st = bakeSites(newText, cur, from);
      if (st) { b.sites = st; n++; }
    }
  }
  return n;
}
/** {drift, now, sites}: whole-file hash first (unchanged file: no drift); then, when bake.sites is set, the positions. */
async function bakeDrift(dir, b, frames, cache = new Map()) {
  const now = await bakeHash(dir, b, cache);
  if (now === null || now === b.hash) return { drift: false, now };
  if (typeof b.sites !== 'string' || b.pointer !== undefined) return { drift: true, now, sites: false };
  const text = (await readFile(resolve(dir, b.from))).toString('utf8'), at = bakeSites(text, frames, b.from);
  return { drift: at !== b.sites, now, sites: true };
}
async function checkBake(s, at, dir, errors, warnings, cache, drift = null) {
  const b = s.bake;
  if (s.type !== 'image' && s.type !== 'model') return errors.push(`${at}.bake: image and model slots only`);
  // v1.4: a code-built model (export-glb.mjs) names its builder in bake.from (creator-studio/docs/asset-manifest.md "models built in code").
  if (b && b.build !== undefined && (s.type !== 'model' || typeof b.build !== 'string' || !b.build || b.build.length > 200)) return errors.push(`${at}.bake.build: the function or anchor in bake.from that builds the model (model slots only)`);
  // v1.5 (export-glb.mjs --auto): sig, the model's creation call site (frames "file:line:col", innermost first), and shape,
  // the 16-hex merge signature re-runs match slots by. Model slots only.
  if (b && b.sig !== undefined && (s.type !== 'model' || !Array.isArray(b.sig) || b.sig.length < 1 || b.sig.length > 8 || b.sig.some(f => typeof f !== 'string' || !BAKE_FRAME.test(f)))) return errors.push(`${at}.bake.sig: 1 to 8 call-stack frames "file:line:col", innermost first (model slots only)`);
  if (b && b.shape !== undefined && (s.type !== 'model' || typeof b.shape !== 'string' || !/^[0-9a-f]{16}$/.test(b.shape))) return errors.push(`${at}.bake.shape: 16 lowercase hex characters, the merge signature export-glb.mjs --auto matches re-runs by (model slots only)`);
  if (!b || typeof b.from !== 'string' || !b.from || b.from.startsWith('/') || b.from.includes('..') || /^[a-z]+:/i.test(b.from)) return errors.push(`${at}.bake.from: a path inside the game (the code or generator that drew the image)`);
  if (typeof b.hash !== 'string' || !SHA256.test(b.hash)) return errors.push(`${at}.bake.hash: the sha256 of bake.from at bake time (64 lowercase hex characters)`);
  if (b.pointer !== undefined && (typeof b.pointer !== 'string' || !b.pointer.startsWith('/') || !b.from.endsWith('.json'))) return errors.push(`${at}.bake.pointer: a JSON pointer into a .json bake.from`);
  if (b.sites !== undefined && (typeof b.sites !== 'string' || !SHA256.test(b.sites) || b.pointer !== undefined)) return errors.push(`${at}.bake.sites: the sha256 of the text around the slot's frames (64 lowercase hex characters; validate.mjs bakeSites), with no bake.pointer`);
  if (!existsSync(resolve(dir, b.from))) return warnings.push(`${at}.bake.from: ${b.from} is not in the game folder, so drift can't be checked`);
  const d = await bakeDrift(dir, b, siteFrames(s), cache);
  if (d.now === null) errors.push(`${at}.bake.pointer: ${b.pointer} does not resolve in ${b.from}`);
  else if (d.drift && (s.drawn || (Array.isArray(b.sig) && b.sig.length)) && drift) drift.push({ at, from: b.from, now: d.now, what: s.drawn ? 'picture' : 'model', sites: d.sites });
  else if (d.drift) warnings.push(s.drawn ? `${at}.bake: ${b.from} changed since the picture was captured (now ${d.now}); its patterns are positions in that file, so capture again (asset-manifest/capture-code-art.mjs --write)`
    : `${at}.bake: ${b.from}${b.pointer ?? ''} changed since the bake (now ${d.now}); re-bake the image, or update bake.hash if the file is kept on purpose`);
}
const DRIFT_TOOL = { picture: 'asset-manifest/capture-code-art.mjs --write', sound: 'audio/capture-code-sounds.mjs --write', model: 'asset-manifest/export-glb.mjs --auto --write' };
const DRIFT_WORD = { picture: 'the picture was captured', sound: 'the sound was captured', model: 'the model was exported' };
/** Drift warnings: per item when few or checked per position; one line per file for many whole-file drifts (bug 43). */
function driftWarnings(list, warnings) {
  const whole = new Map();
  for (const d of list) if (!d.sites) whole.set(d.from, [...(whole.get(d.from) ?? []), d]);
  for (const d of list) {
    const many = !d.sites && whole.get(d.from).length > 3;
    if (many) continue;
    warnings.push(d.sites ? `${d.at}.bake: the code at its positions in ${d.from} changed since ${DRIFT_WORD[d.what]} (bake.sites differs); capture again (${DRIFT_TOOL[d.what]})`
      : `${d.at}.bake: ${d.from} changed since ${DRIFT_WORD[d.what]} (now ${d.now}); its patterns are positions in that file, so capture again (${DRIFT_TOOL[d.what]})`);
  }
  for (const [from, items] of whole) if (items.length > 3) {
    const kinds = [...new Set(items.map(x => x.what))];
    warnings.push(`bake: ${from} changed since ${items.length} ${kinds.map(k => `${k}s`).join(', ').replace(/, ([^,]*)$/, ' and $1')} were captured (now ${items[0].now}): ${items.slice(0, 4).map(x => x.at.replace(/^.*\((.*)\)$/, '$1')).join(', ')} and ${items.length - 4} more. Their patterns are positions in that file, but these bakes have no bake.sites, so a change anywhere in it counts; capture again (${kinds.map(k => DRIFT_TOOL[k]).join('; ')}); a capture that records bake.sites is checked per position`);
  }
}

/** v1.4/v1.5 colour formats (lib/code-literals.mjs COLOR_FORMATS: "0xrrggbb", "rgb01", "rgb255"): only on colour slots in
 *  code; a colour slot may carry no other format, and a JSON colour slot none of them. Null when fine. */
function colorFormatProblem(s, inCode) {
  const f = s.constraints?.format;
  if (f === undefined) return null;
  if (COLOR_FORMATS.includes(f)) return s.type !== 'color' ? `"${f}" is for colour slots` : inCode ? null : `"${f}" is for colours kept as numbers in code`;
  return s.type === 'color' ? `${JSON.stringify(f)} is not a colour format (${COLOR_FORMATS.map(x => `"${x}"`).join(', ')}, or none for a CSS colour)` : null;
}

// v1.4 code value slots (builder/studio-lib/manifest.mjs codeSlotProblem; keep in step): source {file, code: {start, end,
// text, path, lang?}}. The literal must read as the slot's type, and the file must still hold it at the anchor (stale is an
// error; text and tables found again elsewhere in the file, once, are a warning: re-anchor with scan-code.mjs --write).
async function checkCodeSlot(s, at, dir, errors, warnings, texts, ranges) {
  const f = s.source.file, c = s.source.code;
  if (s.source.pointer !== undefined) return errors.push(`${at}.source: a code slot has source.code instead of source.pointer`);
  if (!isCodeFile(f)) return errors.push(`${at}.source.file: code slots point into .js, .mjs, .cjs, .css or .html files`);
  const shape = codeShapeProblem(c);
  if (shape) return errors.push(`${at}: ${shape}`);
  const fmt = colorFormatProblem(s, true);   // before reading: an unknown format is the problem, not the literal
  if (fmt) return errors.push(`${at}.constraints.format: ${fmt}`);
  const r = readCodeValue(s);
  if (!r.ok) return errors.push(`${at}.source.code.text: does not read as ${s.type}: ${r.reason}`);
  const numeric = s.type === 'color' && codeLang(s) === 'js' && /^[\d.]/.test(c.text.trim()) && !c.text.includes(',');   // round 2: `1, .97, .79` (uniform4f's numbers) is rgb01, not one number
  if (numeric !== (s.constraints?.format === COLOR_INT)) errors.push(numeric ? `${at}.constraints.format: a colour kept as a number in code needs "${COLOR_INT}"` : `${at}.constraints.format: "${COLOR_INT}" is for colours kept as numbers in code`);
  checkValue(s, r.value, at, errors);
  if (!texts.has(f)) texts.set(f, readFile(resolve(dir, f)).then(decodeCode).catch(e => ({ error: e.message })));
  const text = await texts.get(f);
  if (typeof text !== 'string') return errors.push(`${at}.source.file: ${f} is not readable UTF-8 (${text.error})`);
  const where = locateCode(text, s);
  if (!where) return errors.push(`${at}.source.code: stale: ${f} no longer has ${JSON.stringify(c.text.length > 40 ? c.text.slice(0, 40) + '…' : c.text)} at ${c.start}-${c.end} (${c.path}); re-anchor with scan-code.mjs --write`);
  if (where.moved) warnings.push(`${at}.source.code: the literal moved to ${where.start}-${where.end} in ${f}; Studio finds it, but re-anchor with scan-code.mjs --write`);
  const mine = { id: s.id, at, start: where.start, end: where.end };
  for (const o of ranges.get(f) ?? []) if (rangesOverlap(o, mine) && !(o.start <= mine.start && mine.end <= o.end) && !(mine.start <= o.start && o.end <= mine.end)) errors.push(`${at}.source.code: cuts through ${o.id} in ${f}`);
  ranges.set(f, [...(ranges.get(f) ?? []), mine]);
}

// v1.5 check.play (builder/asset-manifest/play-driver.mjs): {steps?, ready?, sound?}. Steps are check.mjs runSteps steps
// plus the driver's own ({text}, {fill}, {move}, {mouse}, {rclick}, {wheel}, {domClick}, {range}); `sound` is one such
// step that turns the game's sound on, or false when it has no toggle to press.
export const PLAY_STEP_KEYS = ['wait', 'click', 'key', 'down', 'up', 'hold', 'select', 'clickSelector', 'waitFor', 'text', 'fill', 'move', 'mouse', 'rclick', 'wheel', 'domClick', 'range'];
// Round 2 (agent DRIVE): a coordinate may be a share of the viewport ("50%"), or of the biggest canvas with {in: 'canvas'};
// a click or right click may be 'centre' or 'here' (where the mouse is, pointer-lock safe).
const coord = v => isNum(v) || (typeof v === 'string' && /^-?\d+(?:\.\d+)?%$/.test(v));
const point = v => Array.isArray(v) && v.length === 2 && v.every(coord);
const clickAt = v => v === 'centre' || v === 'center' || v === 'here' || point(v);
function playStepProblem(step) {
  if (!step || typeof step !== 'object' || Array.isArray(step)) return 'an object';
  const keys = PLAY_STEP_KEYS.filter(k => step[k] !== undefined);
  if (!keys.length) return `one of ${PLAY_STEP_KEYS.join(', ')}`;
  if (step.wait !== undefined && !(isNum(step.wait) && step.wait >= 0)) return 'wait: milliseconds';
  if (step.text !== undefined && (typeof step.text !== 'string' || !step.text)) return 'text: the words on the element to click';
  if (step.fill !== undefined && (typeof step.fill !== 'string' || (step.value !== undefined && typeof step.value !== 'string'))) return 'fill: a selector, with value: text';
  if (step.move !== undefined && !point(step.move)) return 'move: [x, y]';
  if (step.mouse !== undefined && !['down', 'up'].includes(step.mouse)) return 'mouse: "down" or "up"';
  for (const k of ['click', 'rclick']) if (step[k] !== undefined && !clickAt(step[k])) return `${k}: [x, y] (pixels or "50%"), "centre" or "here"`;
  if (step.domClick !== undefined && !point(step.domClick)) return 'domClick: [x, y]';
  if (step.in !== undefined && step.in !== 'canvas') return 'in: "canvas" (points measured from the game\'s biggest canvas)';
  if (step.wheel !== undefined && !isNum(step.wheel)) return 'wheel: a number (pixels)';
  if (step.range !== undefined && !(Array.isArray(step.range) && step.range.length === 3 && step.range.every(isNum))) return 'range: [x, y, value]';
  return null;
}
export function checkPlayProblems(play) {
  if (!play || typeof play !== 'object' || Array.isArray(play)) return ['check.play: {steps?: [...], ready?: "<expression>", sound?: {step} | false}'];
  const out = [];
  if (play.steps !== undefined) {
    if (!Array.isArray(play.steps)) out.push('check.play.steps: a list of steps');
    else play.steps.forEach((st, i) => { const p = playStepProblem(st); if (p) out.push(`check.play.steps[${i}]: ${p}`); });
  }
  if (play.ready !== undefined && (typeof play.ready !== 'string' || !play.ready.trim())) out.push('check.play.ready: a JavaScript expression that is true once play is reached');
  if (play.sound !== undefined && play.sound !== false) { const p = playStepProblem(play.sound); if (p) out.push(`check.play.sound: a step that turns the sound on (${p}), or false when the game has no toggle`); }
  // Round 2 (agent DRIVE): a URL query the tools load the game with to reach play (a test flag such as ?speed=12).
  if (play.query !== undefined && !(typeof play.query === 'string' && /^\??[^\s#?]+$/.test(play.query))) out.push('check.play.query: a URL query such as "?speed=12" (key=value pairs joined by &)');
  // Round 3 (agent DRIVE, swarm bug 6): keys the tools' own input never presses (R restarts the game, say).
  if (play.avoidKeys !== undefined && !(Array.isArray(play.avoidKeys) && play.avoidKeys.every(k => typeof k === 'string' && /^[A-Z][A-Za-z0-9]*$/.test(k)))) out.push('check.play.avoidKeys: a list of key codes the tools must not press, such as ["KeyR", "Escape"] (KeyboardEvent.code names)');
  // Round 4 (agent GATE, bug 157): the game has no play state to reach (a viewer, a page that is all one screen). A sentence saying why;
  // the coverage gate then does not fail on "play was not reached". It contradicts steps into play and a ready test.
  if (play.none !== undefined && !(typeof play.none === 'string' && play.none.trim().length >= 8)) out.push('check.play.none: a sentence saying why this game has no play state to reach ("A model viewer: the first screen is all there is.")');
  if (play.none !== undefined && (play.ready !== undefined || (Array.isArray(play.steps) && play.steps.length))) out.push('check.play.none: a game with check.play.steps or check.play.ready has a play state to reach; drop one or the other');
  for (const k of Object.keys(play)) if (!['steps', 'ready', 'sound', 'query', 'avoidKeys', 'none'].includes(k)) out.push(`check.play.${k}: not a field (steps, ready, sound, query, avoidKeys, none)`);
  return out;
}

/**
 * Round 2 (bug 47): a view that silently breaks a group's view coverage. Studio's previewSubjects widens a view found from
 * a slot's `capture.query` to that slot's whole group only while it is the group's only view; a `showcase` entry that lists
 * one slot of the group (Static Hall's "intro" lists the monster's name) makes it two, and the group's other Look and text
 * slots (the monster's colour and eyes) quietly lose their view. Warns with the slots left without one. Uses
 * builder/studio-lib/manifest.mjs (previewSubjects, subjectForSlot), loaded only here: the worker's job container has
 * no studio-lib/vendor, which that module imports, and there the check is skipped.
 */
// check.start (2026-10-05, play-compare.mjs): when the game's first screen is up, and how long it takes to come to
// rest. It presses nothing: {ready: "<expression>", settleMs?: 0..30000}.
export function checkStartProblems(start) {
  if (!start || typeof start !== 'object' || Array.isArray(start)) return ['check.start: {ready: "<expression that is true once the game\'s first screen is up>", settleMs?: <how long that screen takes to come to rest>}'];
  const out = [];
  if (typeof start.ready !== 'string' || !start.ready.trim()) out.push('check.start.ready: a JavaScript expression that is true once the game has started (its first screen is up)');
  if (start.settleMs !== undefined && !(typeof start.settleMs === 'number' && Number.isFinite(start.settleMs) && start.settleMs >= 0 && start.settleMs <= 30000)) out.push('check.start.settleMs: milliseconds from 0 to 30000 (how long the first screen takes to come to rest)');
  for (const k of Object.keys(start)) if (!['ready', 'settleMs'].includes(k)) out.push(`check.start.${k}: not a field (ready, settleMs); a start mark presses nothing`);
  return out;
}
export async function groupViewProblems(raw) {
  if (!Array.isArray(raw?.slots) || !Array.isArray(raw?.showcase) || !raw.showcase.length) return [];
  const lib = await import('../studio-lib/manifest.mjs').catch(() => null);
  if (!lib) return [];
  const m = normalizeManifest(raw), slots = m.slots.filter(s => s && typeof s === 'object');
  const subjects = lib.previewSubjects(m), declared = new Set(raw.showcase.filter(x => x && typeof x.query === 'string').map(x => String(x.id ?? new URLSearchParams(x.query.replace(/^\?/, '')).get('gf-show') ?? x.query)));
  const out = [];
  for (const g of [...new Set(slots.map(s => s.group))]) {
    const own = slots.filter(s => s.group === g), ids = new Set(own.map(s => s.id));
    // The one view found from a capture.query of this group's slots, which Studio would widen to the whole group, and the
    // declared views that list some of its slots without naming the group: those make it two, so it doesn't widen.
    const found = subjects.filter(x => !declared.has(x.id) && x.slots.some(id => ids.has(id)));
    const listing = raw.showcase.map((x, i) => ({ x, i })).filter(({ x }) => x && Array.isArray(x.slots) && x.slots.some(id => ids.has(id)) && !(x.groups ?? []).includes(g));
    if (found.length !== 1 || !listing.length || found[0].groups.includes(g)) continue;
    const orphans = own.filter(s => ['look', 'text'].includes(lib.slotFacet(s)) && !lib.subjectForSlot(subjects, s));
    if (!orphans.length) continue;
    const by = listing[0], label = by.x.label ?? by.x.id ?? by.x.query, theirs = by.x.slots.filter(id => ids.has(id));
    const from = own.find(s => found[0].slots.includes(s.id));
    out.push(`showcase[${by.i}] ("${label}") lists ${theirs.join(', ')} from group "${g}", so the "${found[0].label}" view (from ${from?.id ?? 'a slot'}'s capture.query) no longer covers the rest of that group: ${orphans.slice(0, 6).map(s => s.id).join(', ')}${orphans.length > 6 ? ` and ${orphans.length - 6} more` : ''} have no view in Studio. List them in a showcase view, or give one view groups: ["${g}"]`);
  }
  return out;
}

/** Validate the manifest in `dir`. Returns {ok, errors, warnings, stats}. */
export async function validateGame(dir) {
  dir = resolve(dir);
  const errors = [], warnings = [];
  const path = resolve(dir, 'assets.json');
  if (!existsSync(path)) return { ok: false, errors: ['assets.json is missing'], warnings, stats: {} };
  let m;
  try { m = JSON.parse(await readFile(path, 'utf8')); } catch (e) { return { ok: false, errors: [`assets.json is not valid JSON: ${e.message}`], warnings, stats: {} }; }
  if (m.schema !== SCHEMA) errors.push(`schema: expected "${SCHEMA}"`);
  if (m.draft) errors.push('draft: this is an uncurated draft from draft.mjs; curate it and remove "draft"');
  if (typeof m.game !== 'string' || !m.game) errors.push('game: required (demo id / slug)');
  if (typeof m.title !== 'string' || !m.title) errors.push('title: required');
  if (!['live', 'readonly'].includes(m.editing)) errors.push('editing: "live" or "readonly"');
  if (m.editing === 'readonly' && !m.readonlyReason) errors.push('readonlyReason: required when editing is readonly');
  // A read-only manifest for an immutable build (Godot package-N, PuzzleScript run-N) lives outside it, in
  // asset-manifest/readonly/<id>/, and names the served folder as `root` (repo-relative).
  const manifestDir = dir;
  if (m.root !== undefined) {
    if (m.editing !== 'readonly') errors.push('root: only read-only manifests may live outside the game folder');
    const root = typeof m.root === 'string' && !m.root.includes('..') ? resolve(REPO, m.root) : null;
    if (!root || !existsSync(root)) return { ok: false, errors: [...errors, `root: ${m.root} does not exist`], warnings, stats: {} };
    dir = root;
  }

  const groups = Array.isArray(m.groups) ? m.groups : (errors.push('groups: must be an array'), []);
  const groupIds = new Set();
  for (const [i, g] of groups.entries()) {
    if (!GROUP_ID.test(g?.id ?? '')) errors.push(`groups[${i}].id: lowercase letters, digits, - or _`);
    else if (groupIds.has(g.id)) errors.push(`groups[${i}].id: duplicate "${g.id}"`);
    groupIds.add(g?.id);
    if (!g?.label) errors.push(`groups[${i}].label: required`);
    for (const p of groupDefaultsProblems(g)) errors.push(`groups[${i}].${p}`);   // v1.3 group defaults
  }

  const referenced = new Set(manifestDir === dir ? ['assets.json'] : []);
  const jsonCache = new Map();
  const readJson = async f => {
    if (!jsonCache.has(f)) jsonCache.set(f, readFile(resolve(dir, f), 'utf8').then(JSON.parse).catch(e => ({ __error: e.message })));
    return jsonCache.get(f);
  };
  const safePath = f => typeof f === 'string' && f && !f.startsWith('/') && !f.includes('..') && !/^[a-z]+:/i.test(f);

  const slots = Array.isArray(m.slots) ? normalizeManifest(m).slots : (errors.push('slots: must be an array'), []);   // v1.3: with group defaults
  const ids = new Set(), usedGroups = new Set(), replacesRefs = [], bakeFiles = new Map(), frames = [], sheetSizes = new Map(), codeTexts = new Map(), codeRanges = new Map(), drawnFiles = [], drift = [];
  let mainCount = 0, codeCount = 0;
  for (const [i, s] of slots.entries()) {
    const at = `slots[${i}]${s?.id ? ` (${s.id})` : ''}`;
    if (!s || typeof s !== 'object') { errors.push(`${at}: must be an object`); continue; }
    if (!SLOT_ID.test(s.id ?? '')) errors.push(`${at}.id: lowercase letters, digits, dot, - or _`);
    else if (ids.has(s.id)) errors.push(`${at}.id: duplicate`);
    ids.add(s.id);
    if (!s.label || typeof s.label !== 'string') errors.push(`${at}.label: required`);
    if (!groupIds.has(s.group)) errors.push(`${at}.group: "${s.group}" is not in groups`);
    usedGroups.add(s.group);
    const isFile = s.type in FILE_TYPES, isValue = VALUE_TYPES.includes(s.type);
    if (!isFile && !isValue) { errors.push(`${at}.type: "${s.type}" is not a slot type`); continue; }
    const f = s.source?.file;
    if (!safePath(f)) { errors.push(`${at}.source.file: a relative path inside the game`); continue; }
    if (s.tier !== undefined && !['main', 'advanced'].includes(s.tier)) errors.push(`${at}.tier: "main" or "advanced"`);
    // v1.2: facet picks the Studio Assets sub-tab (builder/studio-lib/manifest.mjs slotFacet infers it when absent).
    if (s.facet !== undefined && !['look', 'sound', 'text', 'gameplay'].includes(s.facet)) errors.push(`${at}.facet: "look", "sound", "text" or "gameplay"`);
    if (s.loadedBy !== undefined && s.loadedBy !== 'page') errors.push(`${at}.loadedBy: only "page" (the HTML page loads the file itself)`);
    // v1.3: per-slot view-only (Studio shows it, never edits it); the reason is shown to the creator.
    if (s.editable !== undefined && typeof s.editable !== 'boolean') errors.push(`${at}.editable: true or false`);
    if (s.readonlyReason !== undefined && (typeof s.readonlyReason !== 'string' || s.editable !== false)) errors.push(`${at}.readonlyReason: text, with "editable": false`);
    // gf-three player looks (builder/CONTRACT.md §6e): a slot each player's own loadout may set for that player.
    // Text and JSON are never part of a look (creator-studio/docs/web3.md "Variations").
    if (s.scope !== undefined && (!['game', 'player'].includes(s.scope) || (s.scope === 'player' && ['text', 'json', 'audio', 'data', 'font'].includes(s.type)))) errors.push(`${at}.scope: "game" or "player" (a player look: colour, number, toggle, choice, model, texture or image slots)`);
    if (s.bake !== undefined) await checkBake(s, at, dir, errors, warnings, bakeFiles, drift);
    if (s.drawn !== undefined) checkDrawn(s, at, dir, safePath, { errors, warnings, referenced, drawnFiles });   // v1.5
    // v1.3 sprite-sheet frames: source.rect [x, y, w, h] in pixels, inside the sheet; see the overlap check below.
    const rect = s.source?.rect;
    if (rect !== undefined || s.source?.overlap !== undefined) {
      if (s.type !== 'image') errors.push(`${at}.source.rect: image slots only`);
      else if (!Array.isArray(rect) || rect.length !== 4 || rect.some(n => !Number.isInteger(n) || n < 0) || rect[2] < 1 || rect[3] < 1) errors.push(`${at}.source.rect: [x, y, width, height] in whole pixels`);
      else if (s.source.overlap !== undefined && typeof s.source.overlap !== 'boolean') errors.push(`${at}.source.overlap: true or false`);
      else { frames.push([s, at]); if (existsSync(resolve(dir, f))) { if (!sheetSizes.has(f)) sheetSizes.set(f, imageSize(await readFile(resolve(dir, f)))); const size = sheetSizes.get(f); if (size && (rect[0] + rect[2] > size.width || rect[1] + rect[3] > size.height)) errors.push(`${at}.source.rect: [${rect.join(', ')}] goes outside the ${size.width}x${size.height} ${f}`); } }
    }
    if (s.tier !== 'advanced') mainCount++;
    if (s.probe !== undefined && (typeof s.probe !== 'object' || (s.probe.query !== undefined && !/^\?/.test(s.probe.query)) || (s.probe.steps !== undefined && !Array.isArray(s.probe.steps)))) errors.push(`${at}.probe: {query: "?…", steps: [...]}`);
    if (s.css !== undefined && (typeof s.css !== 'string' || !/^--[a-z0-9-]+$/i.test(s.css) || !['color', 'text', 'number', 'integer'].includes(s.type))) errors.push(`${at}.css: a custom property name like "--accent", on color/text/number/integer slots`);
    if (s.optional !== undefined && (typeof s.optional !== 'boolean' || !(s.type in FILE_TYPES))) errors.push(`${at}.optional: true/false, file slots only`);
    if (s.replaces !== undefined && (!Array.isArray(s.replaces) || !s.optional)) errors.push(`${at}.replaces: an array of slot ids, on optional file slots`);
    else if (s.replaces) replacesRefs.push([at, s.replaces]);
    const pathRef = s.source?.pathRef;
    if (pathRef !== undefined) {
      if (!(s.type in FILE_TYPES)) errors.push(`${at}.source.pathRef: file slots only`);
      else if (s.type === 'texture') errors.push(`${at}.source.pathRef: texture slots keep their format (the game picks its loader by it), so no pathRef`);
      else if (isLiteralPathRef(pathRef)) {
        // Round 2 (unpack-data-urls.mjs): the code keeps the path as a string literal; a format change rewrites every one.
        if (!safePath(pathRef.file) || !isCodeFile(pathRef.file)) errors.push(`${at}.source.pathRef: {file: "<code file>", literal: true} names a .js, .mjs, .cjs, .css or .html file`);
        else if (!existsSync(resolve(dir, pathRef.file))) errors.push(`${at}.source.pathRef.file: ${pathRef.file} does not exist`);
        else if (!pathLiterals(decodeCode(await readFile(resolve(dir, pathRef.file))), f).length) errors.push(`${at}.source.pathRef: ${pathRef.file} has no string literal "${f}"`);
      }
      else if (!safePath(pathRef.file) || !pathRef.file.endsWith('.json') || typeof pathRef.pointer !== 'string') errors.push(`${at}.source.pathRef: {file: "<config>.json", pointer: "/…"}`);
      else if (!existsSync(resolve(dir, pathRef.file))) errors.push(`${at}.source.pathRef.file: ${pathRef.file} does not exist`);
      else {
        referenced.add(pathRef.file);
        const doc = await readJson(pathRef.file);
        let v; try { v = doc?.__error ? undefined : getPointer(doc, pathRef.pointer); } catch { v = undefined; }
        if (v !== f) errors.push(`${at}.source.pathRef: ${pathRef.file}#${pathRef.pointer} must hold the current path "${f}" (found ${JSON.stringify(v)})`);
      }
    }
    if (!existsSync(resolve(dir, f))) { if (!s.optional) errors.push(`${at}.source.file: ${f} does not exist`); continue; }
    referenced.add(f);
    const reqIds = s.constraints?.svg?.requiredIds;
    if (reqIds && ext(f) === 'svg') { const svg = await readFile(resolve(dir, f), 'utf8'); for (const id of reqIds) if (!new RegExp(`\\bid=["']${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']`).test(svg)) errors.push(`${at}: ${f} lacks required id "${id}"`); }
    if (s.preview?.file) { if (!safePath(s.preview.file) || !existsSync(resolve(dir, s.preview.file))) errors.push(`${at}.preview.file: missing`); else referenced.add(s.preview.file); }
    // v1.2: look-preset thumbnails (options[].preview, written by capture-previews.mjs) are Studio-only files.
    for (const [j, o] of (Array.isArray(s.constraints?.options) ? s.constraints.options : []).entries()) {
      const pf = o?.preview?.file;
      if (pf === undefined) continue;
      if (typeof pf !== 'string' || !safePath(pf) || !existsSync(resolve(dir, pf))) errors.push(`${at}.constraints.options[${j}].preview.file: missing`);
      else referenced.add(pf);
    }
    if (s.constraints?.schema) { if (!existsSync(resolve(dir, s.constraints.schema))) errors.push(`${at}.constraints.schema: missing file`); else referenced.add(s.constraints.schema); }
    if (isFile) {
      if (s.source.pointer !== undefined) errors.push(`${at}.source.pointer: file slots point at a whole file`);
      if (!FILE_TYPES[s.type].includes(ext(f))) errors.push(`${at}: .${ext(f)} is not a ${s.type} format (${FILE_TYPES[s.type].join(', ')})`);
      if (s.type !== 'data' && s.type !== 'font' && s.type !== 'texture' && s.editable !== false && !s.generate?.prompt) warnings.push(`${at}.generate.prompt: missing (generation will have no prefill)`);
    } else if (s.source.code !== undefined) {
      codeCount++;
      await checkCodeSlot(s, at, dir, errors, warnings, codeTexts, codeRanges);   // v1.4: a value in the game's code
    } else {
      if (ext(f) !== 'json') { errors.push(`${at}.source.file: value slots point into a .json file (or into code, with source.code)`); continue; }
      const fmt = colorFormatProblem(s, false);
      if (fmt) errors.push(`${at}.constraints.format: ${fmt}`);
      if (typeof s.source.pointer !== 'string') { errors.push(`${at}.source.pointer: required for ${s.type}`); continue; }
      const doc = await readJson(f);
      if (doc?.__error) { errors.push(`${at}: ${f} is not valid JSON (${doc.__error})`); continue; }
      let v;
      try { v = getPointer(doc, s.source.pointer); } catch (e) { errors.push(`${at}.source.pointer: ${e.message}`); continue; }
      if (v === undefined) { errors.push(`${at}.source.pointer: ${s.source.pointer} does not resolve in ${f}`); continue; }
      checkValue(s, v, at, errors);
    }
  }
  for (const g of groupIds) if (!usedGroups.has(g)) warnings.push(`groups: "${g}" has no slots`);
  if (drawnFiles.length) await checkCodeArtShim(dir, errors, warnings, { also: drawnFiles.also ?? [] });   // v1.5: the shim that paints replacements in
  // v1.3: frames of one sheet may not overlap unless one of them is flagged source.overlap: true.
  const hit = (a, b) => a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3];
  const loose = frames.filter(([s]) => s.source.overlap !== true);
  for (let i = 0; i < loose.length; i++) for (let j = i + 1; j < loose.length; j++) { const [a, at] = loose[i], [b] = loose[j];
    if (a.source.file === b.source.file && hit(a.source.rect, b.source.rect)) errors.push(`${at}.source.rect: overlaps ${b.id} in ${a.source.file} (set source.overlap: true on one if that is deliberate)`); }
  for (const [at, list] of replacesRefs) for (const id of list) if (!ids.has(id)) errors.push(`${at}.replaces: no slot "${id}"`);

  const variantSoundCheck = m.variants?.some(v => v?.sounds) ? (await soundValidator(dir)).validate : null;
  // Variants: alternate config/IP packs selected by a query string. Their files ship (the packer embeds them).
  const variantIds = new Set();
  for (const [i, v] of (Array.isArray(m.variants) ? m.variants : m.variants === undefined ? [] : (errors.push('variants: must be an array'), [])).entries()) {
    const at = `variants[${i}]`;
    if (!GROUP_ID.test(v?.id ?? '') || variantIds.has(v.id)) errors.push(`${at}.id: unique, lowercase letters, digits, - or _`);
    variantIds.add(v?.id);
    if (!v?.label) errors.push(`${at}.label: required`);
    if (typeof v?.select?.query !== 'string' || !v.select.query.startsWith('?')) errors.push(`${at}.select.query: e.g. "?ip=reef"`);
    if (v?.sounds !== undefined && (typeof v.sounds !== 'object' || Array.isArray(v.sounds))) errors.push(`${at}.sounds: sound overrides keyed by id`);
    else if (v?.sounds && variantSoundCheck) {
      const r = variantSoundCheck({ ...(m.sounds ?? {}), sounds: { ...(m.sounds?.sounds ?? {}), ...v.sounds } });
      errors.push(...r.errors.map(e => `${at}.sounds (merged): ${e}`));
      for (const sid of Object.keys(v.sounds)) if (!m.sounds?.sounds?.[sid]) warnings.push(`${at}.sounds.${sid}: no base sound with this id, so it only exists in this variant`);
    }
    if (v?.sounds && typeof v.sounds === 'object') for (const [sid, def] of Object.entries(v.sounds)) { const walk = src => { for (const x of [src].flat()) { if (!x || typeof x !== 'object') continue; if (x.layers) walk(x.layers); if (x.file) { if (!existsSync(resolve(dir, x.file))) errors.push(`${at}.sounds.${sid}: file ${x.file} does not exist`); else referenced.add(x.file); } } }; walk(def?.src); }
    for (const f of [v?.files ?? v?.file].flat().filter(x => x !== undefined)) {
      if (!safePath(f) || !existsSync(resolve(dir, f))) errors.push(`${at}.file: ${f} does not exist`); else referenced.add(f);
    }
  }

  let soundCount = 0;
  const codeFiles = new Map();
  if (m.sounds !== undefined) {
    const kit = await soundValidator(dir);
    if (!kit.validate) errors.push(`sounds: audio/VERSION says gf-audio ${kit.version}, which is not a frozen kit in gf-audio/`);
    const r = kit.validate ? kit.validate(m.sounds) : { errors: [], warnings: [] };
    errors.push(...r.errors.map(e => `sounds: ${e}`)); warnings.push(...r.warnings.map(w => `sounds: ${w}`));
    for (const [id, s] of Object.entries(m.sounds?.sounds ?? {})) {
      soundCount++;
      const walk = src => { for (const x of [src].flat()) { if (!x || typeof x !== 'object') continue; if (x.layers) walk(x.layers); if (!x.file) continue;
        if (!existsSync(resolve(dir, x.file))) errors.push(`sounds.${id}: file ${x.file} does not exist`); else referenced.add(x.file); } };
      walk(s?.src);
      if (s?.code && typeof s.code === 'object') await checkCodeSound(id, s, dir, kit.version, { errors, warnings, referenced, codeFiles, drift });
    }
    if (codeFiles.size) await checkCodeShim(dir, errors, warnings);
  }
  driftWarnings(drift, warnings);   // round 2: per position with bake.sites, else one line per file for many

  const ignore = Array.isArray(m.ignore) ? m.ignore : [];
  const ignoreRes = [];
  for (const [i, g] of ignore.entries()) {
    if (!g?.path) errors.push(`ignore[${i}].path: required`);
    else if (!g.reason) errors.push(`ignore[${i}].reason: required`);
    else ignoreRes.push(globToRegExp(g.path.replace(/\/$/, '/**')));
  }

  if (m.check !== undefined && (typeof m.check !== 'object' || (m.check.steps !== undefined && !Array.isArray(m.check.steps)))) errors.push('check: {steps: [...]} (default browser-check steps)');
  else if (m.check?.play !== undefined) errors.push(...checkPlayProblems(m.check.play));   // v1.5: how tools reach real play (play-driver.mjs)
  if (m.check && typeof m.check === 'object' && m.check.start !== undefined) errors.push(...checkStartProblems(m.check.start));   // 2026-10-05: where a frame-by-frame comparison begins (play-compare.mjs)
  // v1.3: runtime.gpu "webgpu" = needs a hardware WebGPU adapter (capture, worker playtests, Studio's player notice).
  if (m.runtime !== undefined && (!m.runtime || typeof m.runtime !== 'object' || Array.isArray(m.runtime))) errors.push('runtime: an object, e.g. {"gpu": "webgpu"}');
  else if (m.runtime?.gpu !== undefined && m.runtime.gpu !== 'webgpu') errors.push(`runtime.gpu: only "webgpu" (got ${JSON.stringify(m.runtime.gpu)}); leave it out for games that run on WebGL or 2D`);

  // Support files the game reads at runtime that aren't creator assets (schemas, room config): shipped, not shown.
  for (const [i, e] of (Array.isArray(m.embed) ? m.embed : []).entries()) {
    if (!safePath(e?.path) || !existsSync(resolve(dir, e.path))) errors.push(`embed[${i}].path: ${e?.path} does not exist`);
    else if (!e.reason) errors.push(`embed[${i}].reason: required`);
    else referenced.add(e.path);
  }

  // v1.2 preview subjects: showcase: [{id?, label, query: "?gf-show=<subject>", slots?, groups?}] (Studio "Show" picker).
  for (const [i, x] of (Array.isArray(m.showcase) ? m.showcase : []).entries()) {
    if (!x || typeof x.query !== 'string' || !/(^|[?&])gf-show=/.test(x.query)) { errors.push(`showcase[${i}]: query must set gf-show`); continue; }
    if (typeof x.label !== 'string' || !x.label.trim()) errors.push(`showcase[${i}]: needs a label`);
    for (const id of x.slots ?? []) if (!(m.slots ?? []).some(s => s.id === id)) errors.push(`showcase[${i}]: unknown slot "${id}"`);
    for (const g of x.groups ?? []) if (!(m.groups ?? []).some(gr => gr.id === g)) errors.push(`showcase[${i}]: unknown group "${g}"`);
    // v1.5: a still of the view (capture-previews.mjs --showcase): Studio-only, like look-preset thumbnails, and referenced.
    if (x.preview !== undefined) {
      const pf = x.preview?.file;
      if (!x.preview || typeof x.preview !== 'object' || Array.isArray(x.preview) || !safePath(pf) || !['png', 'jpg', 'jpeg', 'webp'].includes(ext(pf))) errors.push(`showcase[${i}].preview: {file: "previews/showcase/<id>.jpg"} (a PNG, JPEG or WebP still of the view)`);
      else if (!existsSync(resolve(dir, pf))) errors.push(`showcase[${i}].preview.file: ${pf} does not exist`);
      else referenced.add(pf);
    }
  }

  for (const w of await groupViewProblems(m)) warnings.push(w);   // round 2 (bug 47)

  // Coverage rule 1: every asset-extension file is referenced or ignored.
  const files = await walk(dir);
  // Files that belong to vendored kits (gf-audio's presets, the multiplayer kit in gf/mp/) are not creator assets, and
  // neither is multiplayer.json, the game's multiplayer manifest (multiplayer/STANDARD.md).
  const kitFile = f => (f === 'audio/presets.json' && files.includes('audio/VERSION')) || (f.startsWith('gf/mp/') && files.includes('gf/mp/kit.json')) || f === 'multiplayer.json';
  const uncovered = files.filter(f => isAssetPath(f) && !kitFile(f) && !referenced.has(f) && !ignoreRes.some(r => r.test(f)));
  for (const f of uncovered) errors.push(`coverage: ${f} is an asset file (${kindForFilename(f)}) with no slot, sound or ignore entry`);

  const byType = {};
  for (const s of slots) byType[s.type] = (byType[s.type] ?? 0) + 1;
  if (m.editing === 'live' && slots.length + soundCount < 5) warnings.push(`only ${slots.length + soundCount} slots and sounds; is every creator-facing asset described?`);
  if (mainCount > MAIN_MAX) warnings.push(`${mainCount} main-tier slots; mark detail slots "tier": "advanced" so Studio shows ~${MAIN_MAX} or fewer first`);
  return { ok: errors.length === 0, errors, warnings, stats: { slots: slots.length, mainSlots: mainCount, codeSlots: codeCount, drawnSlots: drawnFiles.length, variants: variantIds.size, sounds: soundCount, groups: groupIds.size, byType, files: files.length, referenced: referenced.size } };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2];
  if (!dir || !(await stat(dir).catch(() => null))?.isDirectory()) { console.error('usage: node validate.mjs <game-dir> [--json]'); process.exit(2); }
  const r = await validateGame(dir);
  if (process.argv.includes('--json')) console.log(JSON.stringify(r, null, 2));
  else {
    for (const e of r.errors) console.log(`  ✗ ${e}`);
    for (const w of r.warnings) console.log(`  ! ${w}`);
    console.log(`${r.ok ? 'valid' : 'INVALID'}: ${r.stats.slots ?? 0} slots, ${r.stats.sounds ?? 0} sounds, ${r.errors.length} errors, ${r.warnings.length} warnings`);
  }
  process.exit(r.ok ? 0 : 1);
}
