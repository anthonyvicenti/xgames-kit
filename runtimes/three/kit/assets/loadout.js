// gf-three loadouts: what one player wears (CONTRACT §6e). Pure data: no three.js, no DOM, so Node tests and tools
// import it.
//
// A loadout is a look in Studio's shape (creator-studio/docs/web3.md "Variations"), for ONE player:
//   { values: { slotId: value }, files: { slotId: url | { url, revision } }, pass: <reserved> }
// Only the game's player-look slots count (slots with `scope: "player"` in assets.json: by default the player role's
// body, hat and body tint, and each aimed mechanic's colour). Everything else is dropped with a reason, never fatal.
//
//   validateLoadout(raw, slots)  → { loadout, dropped: [{slot, why}] }   (slots: assets.json's slot list or a Map)
//   loadoutKey(loadout)          → '' for an empty loadout, else a short stable hash (the pose carries it: `lk`)
//   encodeLoadout(l) / decodeLoadout(s)   base64url JSON, for ?gf-loadout= (QA only)
//
// `pass` is reserved for a signed, session-bound pass (wallet phase 2+): the play page proves that the wallet owns
// the items and that the pass belongs to this session, and the host may check it. Phase 1 trusts the client: the
// field is carried along (≤ 2 KB, opaque) and never read.

export const LOADOUT_SCHEMA = 'gf-loadout/1';
/** What one loadout may take on the wire (one gf-multiplayer message is at most 4096 bytes of JSON). */
export const MAX_LOADOUT_BYTES = 3000;
export const MAX_URL = 512, MAX_PASS = 2048;
const FILE_EXT = { model: ['glb', 'gltf'], texture: ['ktx2', 'png', 'jpg', 'jpeg', 'webp'], image: ['png', 'webp', 'jpg', 'jpeg', 'gif', 'avif'] };
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);

/** '#abc', '#aabbcc' or '#aabbccdd' → '#aabbcc' (lower case), else null. */
export function colorOf(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  if (/^#[0-9a-f]{3}$/.test(s)) return `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`;
  if (/^#[0-9a-f]{6}([0-9a-f]{2})?$/.test(s)) return s.slice(0, 7);
  return null;
}

/** The player-look slots of a manifest's slot list (or a Map id → slot): Map id → slot. */
export function playerLookSlots(slots) {
  const list = slots instanceof Map ? [...slots.values()] : Array.isArray(slots) ? slots : [];
  return new Map(list.filter(s => s && s.scope === 'player' && typeof s.id === 'string').map(s => [s.id, s]));
}

const isFileSlot = s => s.source?.pointer === undefined && s.type in FILE_EXT;

/** One value for one player-look value slot: → {ok, value} or {why}. */
function checkValue(s, v) {
  const c = s.constraints ?? {};
  switch (s.type) {
    case 'color': { const x = colorOf(v); return x ? { value: x } : { why: 'a colour is "#rrggbb"' }; }
    // a colours slot holds one colour per seat; one player's look is that player's own colour
    case 'colors': { const x = Array.isArray(v) ? v.map(colorOf).find(Boolean) : colorOf(v); return x ? { value: x } : { why: 'one colour, "#rrggbb" (the player\'s own entry)' }; }
    case 'number': case 'integer': {
      if (typeof v !== 'number' || !Number.isFinite(v)) return { why: 'a number' };
      if (s.type === 'integer' && !Number.isInteger(v)) return { why: 'a whole number' };
      if ((typeof c.min === 'number' && v < c.min) || (typeof c.max === 'number' && v > c.max)) return { why: `outside ${c.min ?? '-∞'}–${c.max ?? '∞'}` };
      return { value: v };
    }
    case 'boolean': return typeof v === 'boolean' ? { value: v } : { why: 'true or false' };
    case 'enum': return Array.isArray(c.options) && c.options.some(o => (o?.value ?? o) === v) ? { value: v } : { why: 'not one of the slot\'s options' };
    default: return { why: `${s.type} slots are never part of a look (Studio: text and JSON stay the game's)` };
  }
}

/** One file entry: a URL every copy can fetch (http(s), or a path inside the game). → {value} or {why}. */
function checkFile(s, v) {
  const url = typeof v === 'string' ? v : isObj(v) && typeof v.url === 'string' ? v.url : null;
  if (url === null) return { why: isObj(v) && v.revision ? 'a Studio revision with no url: the page resolves it to a URL before handing the loadout over' : 'a URL' };
  const u = url.trim();
  if (!u || u.length > MAX_URL) return { why: `a URL of at most ${MAX_URL} characters` };
  if (/^(data|blob):/i.test(u)) return { why: 'data: and blob: URLs live in one browser only; other players could not load it (give an https URL)' };
  if (/^https?:\/\//i.test(u)) return { value: u };
  if (/^[a-z][a-z0-9+.-]*:/i.test(u) || u.startsWith('/') || u.startsWith('//') || u.includes('\\') || u.split(/[?#]/)[0].split('/').includes('..')) return { why: 'an https URL or a path inside the game' };
  const ext = u.split(/[?#]/)[0].split('.').pop().toLowerCase();
  if (!FILE_EXT[s.type].includes(ext)) return { why: `a ${s.type} file (${FILE_EXT[s.type].join(', ')})` };
  return { value: u.replace(/^\.\//, '') };
}

/**
 * Check a loadout against the game's player-look slots. Unknown slots, wrong types, values outside a slot's range,
 * files no other copy could load and anything past the size budget are dropped (listed in `dropped`), never fatal.
 * raw: an object, a JSON string, or null. → { loadout: {values, files, pass?}, dropped: [{slot, why}] }
 */
export function validateLoadout(raw, slots, { maxBytes = MAX_LOADOUT_BYTES } = {}) {
  const looks = slots instanceof Map && [...slots.values()].every(s => s.scope === 'player') ? slots : playerLookSlots(slots);
  const dropped = [];
  const loadout = { values: {}, files: {} };
  if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch { return { loadout, dropped: [{ slot: null, why: 'not JSON' }] }; } }
  if (raw == null) return { loadout, dropped };
  if (!isObj(raw)) return { loadout, dropped: [{ slot: null, why: 'a loadout is an object {values, files}' }] };
  const values = isObj(raw.values) ? raw.values : {}, files = isObj(raw.files) ? raw.files : {};
  if (raw.values !== undefined && !isObj(raw.values)) dropped.push({ slot: null, why: 'values: an object {slotId: value}' });
  if (raw.files !== undefined && !isObj(raw.files)) dropped.push({ slot: null, why: 'files: an object {slotId: url}' });
  for (const id of Object.keys(values).sort()) {
    const s = looks.get(id);
    if (!s) { dropped.push({ slot: id, why: 'not a player look in this game' }); continue; }
    if (isFileSlot(s)) { dropped.push({ slot: id, why: `a ${s.type} slot: put it under files` }); continue; }
    const r = checkValue(s, values[id]);
    if ('value' in r) loadout.values[id] = r.value; else dropped.push({ slot: id, why: r.why });
  }
  for (const id of Object.keys(files).sort()) {
    const s = looks.get(id);
    if (!s) { dropped.push({ slot: id, why: 'not a player look in this game' }); continue; }
    if (!isFileSlot(s)) { dropped.push({ slot: id, why: 'a value slot: put it under values' }); continue; }
    const r = checkFile(s, files[id]);
    if ('value' in r) loadout.files[id] = r.value; else dropped.push({ slot: id, why: r.why });
  }
  if (raw.pass !== undefined && raw.pass !== null) {
    const n = JSON.stringify(raw.pass)?.length ?? 0;
    if ((typeof raw.pass === 'string' || isObj(raw.pass)) && n <= MAX_PASS) loadout.pass = JSON.parse(JSON.stringify(raw.pass));
    else dropped.push({ slot: null, why: `pass: reserved for a signed pass (a string or an object, at most ${MAX_PASS} bytes)` });
  }
  // the budget: one message on the wire. Files go first (longest first), then the pass, then values (last first).
  const size = () => JSON.stringify(loadout).length;
  while (size() > maxBytes) {
    const f = Object.keys(loadout.files).sort((a, b) => loadout.files[b].length - loadout.files[a].length)[0];
    if (f) { delete loadout.files[f]; dropped.push({ slot: f, why: `over the ${maxBytes}-byte budget` }); continue; }
    if (loadout.pass !== undefined) { delete loadout.pass; dropped.push({ slot: null, why: `pass: over the ${maxBytes}-byte budget` }); continue; }
    const v = Object.keys(loadout.values).pop();
    if (!v) break;
    delete loadout.values[v]; dropped.push({ slot: v, why: `over the ${maxBytes}-byte budget` });
  }
  return { loadout, dropped };
}

export const isEmpty = l => !l || (!Object.keys(l.values ?? {}).length && !Object.keys(l.files ?? {}).length && l.pass === undefined);

/** Stable JSON (sorted keys), the form the key is taken of. */
export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (isObj(v)) return `{${Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}
/** '' for an empty loadout; else 8 hex digits (FNV-1a of the canonical JSON). Equal loadouts give equal keys on every copy. */
export function loadoutKey(l) {
  if (isEmpty(l)) return '';
  const s = canonical({ values: l.values ?? {}, files: l.files ?? {}, ...(l.pass !== undefined ? { pass: l.pass } : {}) });
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
}

/** base64url of the JSON (UTF-8): ?gf-loadout=<this> (QA). */
export function encodeLoadout(l) {
  const bytes = new TextEncoder().encode(JSON.stringify(l));
  let bin = ''; for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
/** The object from encodeLoadout's text (base64url or plain JSON), or null. */
export function decodeLoadout(s) {
  if (typeof s !== 'string' || !s) return null;
  try { if (s.trim().startsWith('{')) return JSON.parse(s); } catch { return null; }
  try {
    const b = s.replace(/-/g, '+').replace(/_/g, '/'), bin = atob(b + '='.repeat((4 - b.length % 4) % 4));
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0))));
  } catch { return null; }
}
