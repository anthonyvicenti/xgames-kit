// Slots: everything a player sees or tunes is a slot in the game's assets.json (gf-assets/1, CONTRACT §2). A value slot
// points into a config file (`source.file` + `source.pointer`); a file slot is the file at `source.file`. Swapping
// either needs no code change: set the value, or put a new file of the same kind at the same path.
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { GF3, resolveInside } from './paths.mjs';

export const VALUE_TYPES = ['color', 'colors', 'number', 'integer', 'boolean', 'enum', 'text', 'json'];
export const FILE_TYPES = { model: ['glb'], image: ['png', 'jpg', 'jpeg', 'webp'], texture: ['ktx2', 'hdr'], audio: ['ogg', 'mp3', 'wav', 'm4a'], font: ['ttf', 'otf', 'woff', 'woff2'], data: ['json'] };
const HEX = /^(?:#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})|rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(?:,\s*(?:0|1|0?\.\d+)\s*)?\))$/i;

export async function readManifest(gameDir) {
  const file = path.join(gameDir, 'assets.json');
  try { return JSON.parse(await readFile(file, 'utf8')); } catch (e) { throw new Error(`assets.json: ${e.code === 'ENOENT' ? 'missing' : e.message}`); }
}

/** A path inside the game, given as the manifest writes it (forward slashes). Null when it would leave the game. */
const inGame = (gameDir, rel) => resolveInside(gameDir, '/' + String(rel ?? ''));

// JSON pointers (RFC 6901)
const unescape = s => s.replace(/~1/g, '/').replace(/~0/g, '~');
export function getPointer(doc, pointer) {
  if (pointer === '' || pointer === '/') return doc;
  let cur = doc;
  for (const raw of pointer.split('/').slice(1)) { const k = unescape(raw); if (cur == null || typeof cur !== 'object' || !(k in cur)) return undefined; cur = cur[k]; }
  return cur;
}
export function setPointer(doc, pointer, value) {
  const keys = pointer.split('/').slice(1).map(unescape);
  if (!keys.length) throw new Error('cannot replace a whole config file');
  let cur = doc;
  for (const k of keys.slice(0, -1)) {
    if (cur[k] == null || typeof cur[k] !== 'object') throw new Error(`pointer ${pointer}: ${k} does not exist in the config`);
    cur = cur[k];
  }
  const last = keys.at(-1);
  if (Array.isArray(cur) && !/^\d+$/.test(last)) throw new Error(`pointer ${pointer}: ${last} is not an array index`);
  cur[last] = value;
}

const isFileSlot = s => !s.source?.pointer && !!s.source?.file && !VALUE_TYPES.includes(s.type);

/** Every slot with its current value (value slots) or file facts (file slots). */
export async function listSlots(gameDir, { all = false } = {}) {
  const m = await readManifest(gameDir);
  const cache = new Map();
  const config = async rel => {
    if (!cache.has(rel)) { const f = inGame(gameDir, rel); cache.set(rel, f ? await readFile(f, 'utf8').then(JSON.parse).catch(() => null) : null); }
    return cache.get(rel);
  };
  const out = [];
  for (const s of m.slots ?? []) {
    if (!all && s.tier && s.tier !== 'main') continue;
    const row = { id: s.id, label: s.label ?? s.id, group: s.group ?? null, type: s.type, tier: s.tier ?? 'main', scope: s.scope ?? null, optional: !!s.optional, constraints: s.constraints ?? {}, description: s.description ?? null };
    if (isFileSlot(s)) {
      row.kind = 'file'; row.file = s.source.file;
      const f = inGame(gameDir, s.source.file);
      try { const st = await stat(f); row.bytes = st.size; } catch { row.bytes = null; row.missing = true; }
      if (s.license) row.license = s.license;
    } else if (s.source?.pointer) {
      row.kind = 'value'; row.file = s.source.file; row.pointer = s.source.pointer;
      row.value = getPointer(await config(s.source.file) ?? {}, s.source.pointer);
    } else { row.kind = 'other'; row.source = s.source; }
    out.push(row);
  }
  // items: each mechanic's things as slot ids (gf-three CONTRACT §2.4: a table's json slot, or a single item's fields);
  // null for a game made before items were data
  return { slots: out, groups: m.groups ?? [], showcase: m.showcase ?? [], items: Array.isArray(m.items) ? m.items : null, total: (m.slots ?? []).length };
}

export async function findSlot(gameDir, id) {
  const m = await readManifest(gameDir);
  const s = (m.slots ?? []).find(x => x.id === id);
  if (!s) {
    const near = (m.slots ?? []).map(x => x.id).filter(x => x.includes(id) || id.includes(x)).slice(0, 8);
    throw new Error(`no slot "${id}" in assets.json${near.length ? ` (did you mean ${near.join(', ')}?)` : ''}. List them: npx gamesfun slots list --all`);
  }
  return s;
}

/** A value as typed on a command line or posted from the studio → the typed value the slot accepts. Throws why not.
 *  limits: false leaves the slot's range, length and choices to the kit's own words (setValue asks the kit after this). */
export function coerceValue(slot, input, { limits = true } = {}) {
  const C = slot.constraints ?? {}, c = limits ? C : {};    // C: what a value is (choices, list length); c: its limits
  const text = typeof input === 'string' ? input.trim() : input;
  const range = (v) => {
    if (typeof c.min === 'number' && v < c.min) throw new Error(`${slot.id}: ${v} is under its minimum ${c.min}`);
    if (typeof c.max === 'number' && v > c.max) throw new Error(`${slot.id}: ${v} is over its maximum ${c.max}`);
    return v;
  };
  switch (slot.type) {
    case 'color': {
      if (typeof text !== 'string' || !HEX.test(text)) throw new Error(`${slot.id}: "${input}" is not a colour (use #rrggbb)`);
      return text.toLowerCase();
    }
    case 'colors': {
      const list = Array.isArray(text) ? text : String(text).startsWith('[') ? JSON.parse(text) : String(text).split(/[\s,]+/).filter(Boolean);
      if (!list.every(x => typeof x === 'string' && HEX.test(x))) throw new Error(`${slot.id}: every entry must be a colour (#rrggbb)`);
      if (typeof C.min === 'number' && list.length < C.min) throw new Error(`${slot.id}: at least ${C.min} colours`);
      if (typeof C.max === 'number' && list.length > C.max) throw new Error(`${slot.id}: at most ${C.max} colours`);
      return list.map(x => x.toLowerCase());
    }
    case 'number': {
      const v = typeof text === 'number' ? text : Number(text);
      if (!Number.isFinite(v)) throw new Error(`${slot.id}: "${input}" is not a number`);
      return range(v);
    }
    case 'integer': {
      const v = typeof text === 'number' ? text : Number(text);
      if (!Number.isInteger(v)) throw new Error(`${slot.id}: "${input}" is not a whole number`);
      return range(v);
    }
    case 'boolean': {
      if (typeof text === 'boolean') return text;
      const t = String(text).toLowerCase();
      if (['true', '1', 'yes', 'on'].includes(t)) return true;
      if (['false', '0', 'no', 'off'].includes(t)) return false;
      throw new Error(`${slot.id}: "${input}" is not true or false`);
    }
    case 'enum': {
      const opts = (C.options ?? []).map(o => (o && typeof o === 'object' ? o.value : o));
      const hit = opts.find(o => String(o) === String(text));
      if (hit === undefined) throw new Error(`${slot.id}: "${input}" is not one of ${opts.join(', ')}`);
      return hit;
    }
    case 'text': {
      const v = String(input);
      if (typeof c.maxLength === 'number' && v.length > c.maxLength) throw new Error(`${slot.id}: longer than ${c.maxLength} characters`);
      if (Array.isArray(c.enum) && !c.enum.includes(v)) throw new Error(`${slot.id}: "${v}" is not one of ${c.enum.join(', ')}`);
      return v;
    }
    case 'json': return typeof input === 'string' ? JSON.parse(input) : input;
    default: throw new Error(`${slot.id}: a ${slot.type} slot takes a file (--file), not a value`);
  }
}

async function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, text);
  // Windows refuses to rename over a file another process holds open (EPERM/EBUSY): write in place then
  try { await rename(tmp, file); } catch { await writeFile(file, text); await rm(tmp, { force: true }); }
}

/** A write the kit refused: `problems` holds its words, one sentence each. */
export class SlotRefused extends Error {
  constructor(id, problems) { super(`${id}: refused: ${problems.join('; ')}`); this.slot = id; this.problems = problems; }
}

let kitCheck;
/** The kit's own check of a value against its slot (gf-three kit/assets/items.js slotValueProblems: the words the game
 *  itself, verify and the slots tool use), or null for a kit that has none. */
async function kitItems() {
  if (kitCheck === undefined) {
    try { kitCheck = await import(pathToFileURL(path.join(GF3, 'kit', 'assets', 'items.js')).href); } catch { kitCheck = null; }
  }
  return kitCheck;
}

/**
 * Set a value slot. The value is checked by the kit first (its range, its type; a table of items entry by entry,
 * against what its mechanic says one is) and refused in those words with nothing written (SlotRefused). A table is
 * written by gf-three's own slot write (tools/slots.mjs --set: every new entry gets its own picture file, and
 * assets.json is written so a new entry gets its own slots).
 * → { id, file, pointer, before, after } (a table also: pictures, slots)
 */
export async function setValue(gameDir, id, input) {
  const s = await findSlot(gameDir, id);
  if (!s.source?.pointer) throw new Error(`${id} is a ${s.type} file slot: swap its file with --file <path>`);
  const kit = await kitItems();
  const value = coerceValue(s, input, { limits: !kit });
  if (kit) { const problems = kit.slotValueProblems(s, value); if (problems.length) throw new SlotRefused(id, problems); }
  if (s.type === 'json' && s.constraints?.item) return writeTable(gameDir, s, value);
  const file = inGame(gameDir, s.source.file);
  if (!file || !existsSync(file)) throw new Error(`${id}: its config file ${s.source.file} is missing`);
  const raw = await readFile(file, 'utf8');
  const doc = JSON.parse(raw);
  const before = getPointer(doc, s.source.pointer);
  setPointer(doc, s.source.pointer, value);
  const indent = /^\{\n( +)/.exec(raw)?.[1]?.length ?? 2;
  await writeAtomic(file, JSON.stringify(doc, null, indent) + '\n');
  return { id, file: s.source.file, pointer: s.source.pointer, before, after: value };
}

/** A table of items, through gf-three's own write (tools/slots.mjs --set, tools/lib/items-lib.mjs writeSlot). */
async function writeTable(gameDir, s, value) {
  const { runTool } = await import('./run-tool.mjs');
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'gamesfun-table-'));
  try {
    const file = path.join(tmp, 'value.json');
    await writeFile(file, JSON.stringify(value));
    const r = await runTool('slots', [path.resolve(gameDir), '--set', s.id, `@${file}`, '--json'], { stdio: 'pipe' });
    let out = null; try { out = JSON.parse(r.stdout); } catch {}
    if (!out) throw new Error(`${s.id}: the slot write failed: ${(r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ')}`);
    if (!out.ok) throw new SlotRefused(s.id, out.problems ?? ['refused']);
    return { id: s.id, file: s.source.file, pointer: s.source.pointer, before: out.before, after: out.after, pictures: out.pictures ?? [], slots: out.slots ?? null };
  } finally { await rm(tmp, { recursive: true, force: true }); }
}

const MAGIC = {
  glb: b => b.subarray(0, 4).toString('latin1') === 'glTF',
  png: b => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  jpg: b => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  jpeg: b => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  webp: b => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
  ktx2: b => b.subarray(1, 7).toString('latin1') === 'KTX 20',
  ogg: b => b.subarray(0, 4).toString('latin1') === 'OggS',
  wav: b => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WAVE',
  mp3: b => b.subarray(0, 3).toString('latin1') === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0),
};

/** Check new bytes for a file slot: same kind as the file it replaces, within the slot's byte budget. */
export function checkFileFor(slot, bytes, name = 'the new file') {
  const cur = String(slot.source.file);
  const ext = path.posix.extname(cur).slice(1).toLowerCase();
  const newExt = path.extname(name).slice(1).toLowerCase();
  if (newExt && newExt !== ext && !(ext === 'jpg' && newExt === 'jpeg') && !(ext === 'jpeg' && newExt === 'jpg')) throw new Error(`${slot.id} holds a .${ext} file; ${name} is .${newExt}. Convert it to .${ext} first (the slot keeps its path, so nothing else changes)`);
  if (MAGIC[ext] && !MAGIC[ext](bytes)) throw new Error(`${name} is not a valid .${ext} file`);
  const max = slot.constraints?.maxBytes;
  if (typeof max === 'number' && bytes.length > max) throw new Error(`${name} is ${bytes.length} bytes; ${slot.id} allows at most ${max}`);
  return true;
}

/** Swap a file slot: the new bytes go to the slot's own path. → { id, file, bytes, before } */
export async function setFile(gameDir, id, { from = null, bytes = null, name = null } = {}) {
  const s = await findSlot(gameDir, id);
  if (s.source?.pointer || !s.source?.file) throw new Error(`${id} is a ${s.type} value slot: set it with a value, not a file`);
  const target = inGame(gameDir, s.source.file);
  if (!target) throw new Error(`${id}: its path ${s.source.file} is outside the game`);
  const buf = bytes ?? await readFile(from);
  checkFileFor(s, buf, name ?? (from ? path.basename(from) : 'the new file'));
  const before = existsSync(target) ? (await stat(target)).size : null;
  await writeFile(target, buf);
  return { id, file: s.source.file, bytes: buf.length, before };
}

/**
 * Is assets.json what the slot declarations give? The declarations are assembled in a scratch copy of the game
 * (gf-three keeps the game's own ignore entries and adds this kit's, builder/lib/manifest-ignore.json) and compared.
 * → { same }
 */
export async function slotsUpToDate(gameDir) {
  const { cp, mkdtemp, rm: remove } = await import('node:fs/promises');
  const os = await import('node:os');
  const { runTool } = await import('./run-tool.mjs');
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'gamesfun-slots-'));
  try {
    const copy = path.join(tmp, 'game');
    const skip = new Set(['evidence', 'node_modules', '.git']);
    await cp(gameDir, copy, { recursive: true, filter: src => !skip.has(path.relative(gameDir, src).split(/[\\/]/)[0]) });
    const r = await runTool('slots', [copy, '--write'], { stdio: 'pipe' });
    if (r.code !== 0) throw new Error(`slots --write failed: ${r.stderr.trim()}`);
    const [a, b] = await Promise.all([readFile(path.join(gameDir, 'assets.json')), readFile(path.join(copy, 'assets.json'))]);
    return { same: a.equals(b) };
  } finally { await remove(tmp, { recursive: true, force: true }); }
}
