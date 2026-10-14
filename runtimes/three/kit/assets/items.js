// gf-three items as data (open builder wave 10, track I): a mechanic's things (melee weapons, a pickup, loot's drops,
// its upgrade cards) are described by the mechanic itself, so a page, a tool or verify can list, check, add and remove
// them without a list of mechanics or fields anywhere else. Pure: no three.js, no DOM, no Node, so the kit, the tools,
// verify and a studio page all import this one file.
//
// A mechanic's manifest carries `items: [declaration]`. Two kinds:
//
//   a table   { key: 'weapons', noun: 'weapon', nouns: 'weapons', min, max, id: 'id', name: 'name',
//               schema: <JSON Schema of ONE entry: each field's title (plain words), type, minimum, maximum, default,
//                        unit, enum>,
//               front: ['name', 'combo/0/damage', ...],     the fields the front of an item card shows (JSON pointers
//                                                          inside one entry, without the leading slash)
//               picture: { field: 'model', type: 'model', dir: 'assets/models', file: 'melee-<id>.glb',
//                          slot: 'mechanic.melee.<id>.model', library: 'kaykit-sword', extra: { grip: 'grip' } },
//               defaults: { 'standard-3d': [...], 'scenic-3d': [...] } } the table a game gets when its spec gives none, by profile
//             The table lives in config/game.json → mechanics[i].params.<key> and is ONE json value slot
//             (mechanic.<id>.<key>) whose constraints.item is this declaration (without `defaults`): adding, removing,
//             renaming or re-numbering an entry is a write of that slot. A new entry's picture is a library id
//             ("library:kaykit-sword", or the like entry's own file) until `slots --write` copies it to the entry's own
//             file (tools/lib/items-lib.mjs ensurePictures), so the game never draws nothing.
//   a single  { single: true, noun, fields: ['value', 'respawnSeconds', ...], front: [...], picture: params => slotId }
//             The mechanic's own params are the one item; each field is the slot that already points at that param.
//
//   checkItems(item, table)               → problems, in words ("Foam sword, swing 1: damage 500 is more than 100 …")
//   addLike(item, table, {like, name, id}) → { table, entry }   a copy of `like` with a new id and name, its picture a
//                                                              reference the write turns into its own file
//   removeItem(item, table, id)           → { table } | { problem }
//   onlyNumbers(item, before, after)      → true when two tables differ only in numbers, colours and words (the same
//                                           entries, ids and pictures): what a running game can take without a reload
//   forSlot(item)                          → the declaration as a slot carries it (JSON only: no defaults)
//   slotValueProblems(slot, value)        → any value slot's value against its type and range, in words (a json slot
//                                           with constraints.item: checkItems); assets.setValue, tools/slots.mjs --set
//                                           and a page's write all refuse with these words

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const typeOf = v => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);
const fits = (v, t) => (t === 'number' ? typeof v === 'number' && Number.isFinite(v) : t === 'integer' ? Number.isInteger(v) : typeOf(v) === t);
export const ITEM_ID = /^[a-z0-9][a-z0-9_-]{0,23}$/;

/** An id from words: "Foam sword!" → "foam-sword" (empty words → "item"). */
export const slug = s => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24).replace(/-+$/, '') || 'item';

/** JSON pointer (RFC 6901) helpers, in place. */
const unescape = s => s.replace(/~1/g, '/').replace(/~0/g, '~');
export const partsOf = pointer => String(pointer ?? '').replace(/^\//, '').split('/').filter(x => x !== '').map(unescape);
export function getAt(doc, pointer) {
  let v = doc;
  for (const k of partsOf(pointer)) { if (v == null || typeof v !== 'object') return undefined; v = v[k]; }
  return v;
}
/** Set a value at a pointer inside doc (in place). Throws, in words, when a parent does not exist. */
export function setAt(doc, pointer, value) {
  const keys = partsOf(pointer);
  if (!keys.length) throw new Error('a pointer to a value inside the file is needed');
  let cur = doc;
  for (const k of keys.slice(0, -1)) { if (cur[k] == null || typeof cur[k] !== 'object') throw new Error(`${pointer}: "${k}" is not there`); cur = cur[k]; }
  cur[keys.at(-1)] = value;
  return doc;
}

/** The schema of a field inside one entry (pointer like 'combo/0/damage'), or null. */
export function fieldSchema(item, pointer) {
  let s = item?.schema;
  for (const k of partsOf(pointer)) {
    if (!s) return null;
    if (s.type === 'array' || (Array.isArray(s.type) && s.type.includes('array')) || s.items) s = /^\d+$/.test(k) ? s.items : null;
    else s = s.properties?.[k] ?? null;
  }
  return s ?? null;
}

/** An entry's name for people: its name field, else its id, else "the new <noun>". */
export function nameOf(item, entry, i = null) {
  if (!isObj(entry)) return typeof entry === 'string' ? (item?.words?.[entry]?.name ?? entry) : `${item?.noun ?? 'item'} ${i === null ? '' : i + 1}`.trim();
  return String(entry[item?.name ?? 'name'] ?? entry[item?.id ?? 'id'] ?? `${item?.noun ?? 'item'} ${i === null ? '' : i + 1}`).trim();
}

/** Plain words for a place inside one entry: ['combo', 0, 'damage'] → "swing 1: damage". */
export function placeWords(item, keys) {
  const out = [];
  let s = item?.schema;
  for (const k of keys) {
    if (!s) { out.push(String(k)); continue; }
    if (/^\d+$/.test(String(k)) && s.items) { s = s.items; out.push(`${(s.title ?? 'entry').toLowerCase()} ${Number(k) + 1}`); continue; }
    const f = s.properties?.[k];
    if (!f) { out.push(String(k)); s = null; continue; }
    // a list field names each of its entries ("swing 1"), so its own title is not said twice
    if (!(f.items && !f.properties)) out.push((f.title ?? String(k)).toLowerCase());
    s = f;
  }
  return out.join(', ');
}

function checkValue(schema, v, where, out, unitOf) {
  if (!schema) return;
  const types = schema.type ? [].concat(schema.type) : null;
  if (types && !types.some(t => fits(v, t))) {
    const want = types.map(t => ({ number: 'a number', integer: 'a whole number', string: 'words', boolean: 'yes or no', array: 'a list', object: 'a group of fields', null: 'empty' }[t] ?? t)).join(' or ');
    out.push(`${where} must be ${want} (it is ${JSON.stringify(v)?.slice(0, 40)})`); return;
  }
  if (schema.enum && !schema.enum.some(e => JSON.stringify(e) === JSON.stringify(v))) { out.push(`${where} must be one of ${schema.enum.map(e => JSON.stringify(e)).join(', ')} (it is ${JSON.stringify(v)})`); return; }
  const unit = schema.unit ? ` ${schema.unit}` : '';
  if (typeof v === 'number') {
    if (schema.minimum !== undefined && v < schema.minimum) out.push(`${where} is ${v}${unit}: less than ${schema.minimum}${unit}, the least it can be`);
    if (schema.maximum !== undefined && v > schema.maximum) out.push(`${where} is ${v}${unit}: more than ${schema.maximum}${unit}, the most it can be`);
  }
  if (typeof v === 'string') {
    if (schema.maxLength !== undefined && v.length > schema.maxLength) out.push(`${where} is ${v.length} letters long: at most ${schema.maxLength}`);
    if (schema.minLength !== undefined && v.length < schema.minLength) out.push(`${where} needs at least ${schema.minLength} letter${schema.minLength === 1 ? '' : 's'}`);
    if (schema.format === 'color' && v && !CSS_COLOR.test(v)) out.push(`${where} must be a colour like #ff8800 (it is "${v}")`);
  }
  if (Array.isArray(v)) {
    if (schema.minItems !== undefined && v.length < schema.minItems) out.push(`${where} needs at least ${schema.minItems}`);
    if (schema.maxItems !== undefined && v.length > schema.maxItems) out.push(`${where} holds at most ${schema.maxItems} (it has ${v.length})`);
    if (schema.items) v.forEach((x, i) => checkValue(schema.items, x, `${where}, ${(schema.items.title ?? 'entry').toLowerCase()} ${i + 1}`, out, unitOf));
  }
  if (isObj(v) && schema.properties) for (const [k, x] of Object.entries(v)) {
    const f = schema.properties[k];
    if (!f) { if (schema.additionalProperties === false) out.push(`${where}: "${k}" is not a field here (fields: ${Object.keys(schema.properties).join(', ')})`); continue; }
    checkValue(f, x, f.items && !f.properties ? where : `${where}: ${(f.title ?? k).toLowerCase()}`, out, unitOf);
  }
}

/**
 * Problems with a whole table against its declaration, in words a person reads (empty when it is fine). `null` is the
 * kit's own table (a game made before tables were written out). A single item has no table: [].
 */
export function checkItems(item, table) {
  if (!item || item.single) return [];
  const noun = item.noun ?? 'item', nouns = item.nouns ?? `${noun}s`;
  if (table === null || table === undefined) return item.nullable === false ? [`the ${nouns} are missing: a list of ${nouns} is needed`] : [];
  if (!Array.isArray(table)) return [`the ${nouns} must be a list (it is ${typeOf(table)})`];
  const out = [];
  if (item.min !== undefined && table.length < item.min) out.push(`there must be at least ${item.min} ${item.min === 1 ? noun : nouns} (there ${table.length === 1 ? 'is' : 'are'} ${table.length})`);
  if (item.max !== undefined && table.length > item.max) out.push(`there can be at most ${item.max} ${nouns} (there are ${table.length})`);
  const seen = new Set();
  table.forEach((entry, i) => {
    const who = nameOf(item, entry, i);
    if (item.schema?.type === 'object' || item.schema?.properties) {
      if (!isObj(entry)) { out.push(`${noun} ${i + 1} must be a group of fields (it is ${typeOf(entry)})`); return; }
      const id = entry[item.id ?? 'id'];
      if (typeof id !== 'string' || !ITEM_ID.test(id)) out.push(`${who}: its id ${JSON.stringify(id)} must be lower-case letters, digits and dashes (at most 24), like "foam-sword"`);
      else if (seen.has(id)) out.push(`${who}: the id "${id}" is used twice; each ${noun} needs its own`);
      else seen.add(id);
      checkValue(item.schema, entry, who, out);
    } else {
      checkValue(item.schema, entry, `${noun} ${i + 1}`, out);
      if (item.unique) { const k = JSON.stringify(entry); if (seen.has(k)) out.push(`${who} is in the list twice`); seen.add(k); }
    }
  });
  return out;
}

/** A field's value for the card's front (pointer inside one entry). */
export const valueAt = (entry, pointer) => getAt(entry, pointer);

/**
 * A new entry made like an existing one: a deep copy with its own id and name. Its picture field names where its own
 * picture comes from: the like entry's file (copied to the new entry's own file by the write) or, when the like has
 * none, the declaration's library default ("library:<id>"). → { table (a new list), entry }
 */
export function addLike(item, table, { like = null, name = '', id = '', set = {} } = {}) {
  if (!item || item.single || !item.key) throw new Error('only a table of items can take a new one');
  const list = Array.isArray(table) ? table : clone(item.defaults?.party ?? []) ?? [];
  const idKey = item.id ?? 'id', nameKey = item.name ?? 'name', noun = item.noun ?? 'item';
  if (item.max !== undefined && list.length >= item.max) throw new Error(`there can be at most ${item.max} ${item.nouns ?? `${noun}s`}; take one out first`);
  let entry;
  if (item.schema?.type === 'object' || item.schema?.properties) {
    const base = like == null ? list[0] : list.find(e => e?.[idKey] === like) ?? (Number.isInteger(like) ? list[like] : null);
    if (like != null && !base) throw new Error(`there is no ${noun} "${like}" to copy (there are: ${list.map(e => e?.[idKey]).join(', ')})`);
    entry = clone(base ?? {});
    const ids = new Set(list.map(e => e?.[idKey]));
    let nid = id ? slug(id) : slug(name || `${base?.[idKey] ?? noun}-2`);
    for (let n = 2; ids.has(nid); n++) nid = `${slug(id || name || base?.[idKey] || noun).slice(0, 21)}-${n}`;
    entry[idKey] = nid;
    entry[nameKey] = String(name || `${nameOf(item, base ?? {}, list.length)} 2`).slice(0, 32);
    const P = item.picture;
    if (P?.field) {
      const own = typeof base?.[P.field] === 'string' && base[P.field] ? base[P.field] : null;
      const alias = (P.alias ?? []).some(f => typeof base?.[f] === 'string' && base[f]);
      // the like's own picture (copied to the new entry's own file by the write), else one that draws it another way
      // (a weapon held as one of the game's props keeps that prop), else the library's default
      if (own || !alias) {
        entry[P.field] = own ?? (P.library ? `library:${P.library}` : '');
        for (const f of P.alias ?? []) delete entry[f];
        // a picture's extras (a weapon's grip on the hand) are the picture's own: the library's fill them in
        if (!own) for (const f of Object.values(P.extra ?? {})) delete entry[f];
        if (!own) delete entry.license;
      }
    }
  } else entry = like;
  for (const [ptr, v] of Object.entries(set ?? {})) setAt(entry, ptr, v);
  return { table: [...list, entry], entry };
}

/** The table without one entry (refused below the declaration's least). → { table } | { problem } */
export function removeItem(item, table, id) {
  if (!Array.isArray(table)) return { problem: `the ${item?.nouns ?? 'items'} are the kit's own; add one first` };
  const idKey = item.id ?? 'id', i = table.findIndex(e => (isObj(e) ? e[idKey] : e) === id);
  if (i < 0) return { problem: `there is no ${item.noun ?? 'item'} "${id}"` };
  if (item.min !== undefined && table.length - 1 < item.min) return { problem: `a game needs at least ${item.min} ${item.min === 1 ? item.noun : item.nouns}: this is the last one` };
  return { table: table.filter((_, j) => j !== i) };
}

/** What a running game can take without a reload: the same entries in the same order, the same ids and pictures. */
export function onlyNumbers(item, before, after) {
  if (!Array.isArray(before) || !Array.isArray(after) || before.length !== after.length) return false;
  const idKey = item?.id ?? 'id', pic = [item?.picture?.field, ...(item?.picture?.alias ?? [])].filter(Boolean);
  return before.every((b, i) => {
    const a = after[i];
    if (!isObj(a) || !isObj(b)) return JSON.stringify(a) === JSON.stringify(b);
    if (a[idKey] !== b[idKey]) return false;
    for (const f of pic) if ((a[f] ?? '') !== (b[f] ?? '')) return false;
    // a list that grew or shrank (a combo of three swings now four) is a new shape: a reload
    for (const [k, v] of Object.entries(a)) if (Array.isArray(v) && (!Array.isArray(b[k]) || b[k].length !== v.length)) return false;
    return true;
  });
}

/** The declaration as a slot carries it in assets.json (constraints.item): plain JSON, no defaults and no functions. */
export function forSlot(item) {
  const { defaults, ...rest } = item ?? {};
  return JSON.parse(JSON.stringify(rest));
}

/** A picture slot id for an entry ("mechanic.melee.<id>.model" → "mechanic.melee.foam-sword.model"). */
export const pictureSlot = (item, entry) => (item?.picture?.slot && isObj(entry) ? item.picture.slot.replace('<id>', entry[item.id ?? 'id']) : null);
/** The file an entry's picture goes in, inside the game ("assets/models/melee-foam-sword.glb"). */
export const pictureFile = (item, entry) => (item?.picture?.file && isObj(entry) ? `${item.picture.dir ?? 'assets/models'}/${item.picture.file.replace('<id>', entry[item.id ?? 'id'])}` : null);
/** A picture field's value that names a library entry, not a file: "library:kaykit-sword" → "kaykit-sword". */
export const libraryRef = v => (typeof v === 'string' && v.startsWith('library:') ? v.slice(8) : null);
const CSS_COLOR = /^(#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})|rgba?\([^)]*\))$/i;
/** A value against its slot's type and constraints, in words. A json slot that holds a table of items is checked
 *  against the item its mechanic declares (constraints.item: kit/assets/items.js). */
export function slotValueProblems(s, v) {
  const c = s.constraints ?? {}, out = [], name = s.label ?? s.id;
  switch (s.type) {
    case 'number': case 'integer':
      if (typeof v !== 'number' || !Number.isFinite(v) || (s.type === 'integer' && !Number.isInteger(v))) out.push(`${name} must be ${s.type === 'integer' ? 'a whole number' : 'a number'}`);
      else {
        const u = c.unit ? ` ${c.unit}` : '';
        if (typeof c.min === 'number' && v < c.min) out.push(`${name} is ${v}${u}: less than ${c.min}${u}, the least it can be`);
        if (typeof c.max === 'number' && v > c.max) out.push(`${name} is ${v}${u}: more than ${c.max}${u}, the most it can be`);
      }
      break;
    case 'color': if (typeof v !== 'string' || !CSS_COLOR.test(v)) out.push(`${name} must be a colour like #ff8800`); break;
    case 'colors': if (!Array.isArray(v) || !v.length || v.some(x => typeof x !== 'string' || !CSS_COLOR.test(x))) out.push(`${name} must be a list of colours`); break;
    case 'boolean': if (typeof v !== 'boolean') out.push(`${name} must be yes or no (true or false)`); break;
    case 'enum': { const o = (c.options ?? []).map(x => x?.value ?? x); if (!o.some(x => x === v)) out.push(`${name} must be one of ${o.join(', ')}`); break; }
    case 'text':
      if (typeof v !== 'string') out.push(`${name} must be words`);
      else if (typeof c.maxLength === 'number' && v.length > c.maxLength) out.push(`${name} is at most ${c.maxLength} letters`);
      else if (Array.isArray(c.enum) && !c.enum.includes(v)) out.push(`${name} must be one of ${c.enum.join(', ')}`);
      break;
    case 'json': if (v === undefined) out.push(`${name} needs a value`); else if (c.item) out.push(...checkItems(c.item, v)); break;
  }
  return out;
}
