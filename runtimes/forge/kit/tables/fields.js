// gf-forge data tables: the field language every table is written in (research/gf-forge/core/ARCHITECTURE.md "Tables").
// One declaration per field gives its default, its range, its slot (label, unit, tier) and its check, so the defaults,
// the checker, the slots and the JSON Schema can never disagree. Pure: no DOM, no Node; create imports it in Node and the
// game vendors it as gf/forge/tables/.
//
//   num(default, min, max, unit, label, describe, tier)   a number          int(...)  an integer
//   bool(default, label, describe)                          a boolean          color('#rrggbb', label, describe)
//   text(default, label, describe, maxLength)               a string (not a slot: names, ids)
//   words(default, label, describe, maxLength)              a string a player reads (a text slot: a card's name, a prompt)
//   choice(default, options, label, describe)               one of options
//   sound(default, preset, label)                           a sound id: assets.json declares it with that gf-audio preset
//   ref(table, label)                                       an id from another table (checked)
//   obj(fields, label)                                      a nested object
//   list(fields, label, {min, max})                         a list of objects
//   id()                                                    a row's id (required, unique, [a-z0-9-])

export const num = (d, min, max, unit = '', label = '', describe = '', tier = 'advanced') => ({ type: 'number', default: d, min, max, unit, label, describe, tier });
export const int = (d, min, max, unit = '', label = '', describe = '', tier = 'advanced') => ({ type: 'integer', default: d, min, max, unit, label, describe, tier });
export const bool = (d, label = '', describe = '', tier = 'advanced') => ({ type: 'boolean', default: d, label, describe, tier });
export const color = (d, label = '', describe = '', tier = 'advanced') => ({ type: 'color', default: d, label, describe, tier });
export const text = (d, label = '', describe = '', maxLength = 120) => ({ type: 'text', default: d, label, describe, maxLength });
export const words = (d, label = '', describe = '', maxLength = 120, tier = 'advanced') => ({ type: 'text', slot: true, default: d, label, describe, maxLength, tier });
export const choice = (d, options, label = '', describe = '', tier = 'advanced') => ({ type: 'choice', default: d, options, label, describe, tier });
export const sound = (d, preset, label = '') => ({ type: 'sound', default: d, preset, label });
export const ref = (table, label = '', describe = '') => ({ type: 'ref', table, default: '', label, describe });
export const obj = (fields, label = '') => ({ type: 'object', fields, label });
export const list = (fields, label = '', { min = 0, max = 64 } = {}) => ({ type: 'list', fields, label, min, max, default: [] });
export const id = () => ({ type: 'id', label: 'Id', describe: 'A short name, unique in its table: lower case letters, digits and dashes' });

const ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const HEX = /^#[0-9a-fA-F]{6}$/;
const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);

/** Every field's default, as an object (a list's default is its own `default`, usually empty). */
export function defaultsOf(fields) {
  const out = {};
  for (const [k, f] of Object.entries(fields)) {
    if (f.type === 'object') out[k] = defaultsOf(f.fields);
    else if (f.type === 'id') continue;
    else out[k] = clone(f.default);
  }
  return out;
}

/** `value` over `base` (both objects), deep for objects, a list replaced whole (its items filled from `fields`). */
export function fillWith(fields, base, value) {
  const out = clone(base) ?? {};
  if (!isObj(value)) return out;
  for (const [k, v] of Object.entries(value)) {
    const f = fields[k];
    if (!f) { out[k] = clone(v); continue; }       // unknown keys are kept for check() to name
    if (f.type === 'object' && isObj(v)) out[k] = fillWith(f.fields, out[k] ?? defaultsOf(f.fields), v);
    else if (f.type === 'list' && Array.isArray(v)) out[k] = v.map(item => (isObj(item) ? fillWith(f.fields, defaultsOf(f.fields), item) : item));
    else out[k] = clone(v);
  }
  return out;
}

/** Problems with `value` against `fields` (paths start at `at`); `refs` checks ids of other tables. */
export function checkFields(fields, value, at, refs, out) {
  if (!isObj(value)) { out.push(`${at}: must be an object`); return out; }
  for (const k of Object.keys(value)) if (!(k in fields)) out.push(`${at}.${k}: not a field here (fields: ${Object.keys(fields).join(', ')})`);
  for (const [k, f] of Object.entries(fields)) {
    const v = value[k], p = `${at}.${k}`;
    if (v === undefined) { if (f.type === 'id') out.push(`${p}: required`); continue; }
    switch (f.type) {
      case 'number': case 'integer':
        if (typeof v !== 'number' || !Number.isFinite(v) || (f.type === 'integer' && !Number.isInteger(v))) out.push(`${p}: must be ${f.type === 'integer' ? 'an integer' : 'a number'}`);
        else if (v < f.min || v > f.max) out.push(`${p}: ${v} is outside what the core can do (${f.min}–${f.max}${f.unit ? ` ${f.unit}` : ''})`);
        break;
      case 'boolean': if (typeof v !== 'boolean') out.push(`${p}: must be true or false`); break;
      case 'color': if (typeof v !== 'string' || !HEX.test(v)) out.push(`${p}: must be a colour "#rrggbb"`); break;
      case 'text': if (typeof v !== 'string' || v.length > (f.maxLength ?? 120)) out.push(`${p}: must be a string of at most ${f.maxLength ?? 120} characters`); break;
      case 'choice': if (!f.options.includes(v)) out.push(`${p}: must be one of ${f.options.join(', ')}`); break;
      case 'sound': if (typeof v !== 'string' || !(/^[a-z0-9][a-z0-9_.-]{0,63}$/.test(v) || (v === '' && f.default === ''))) out.push(`${p}: a sound id (lower case, digits, - _ .)${f.default === '' ? ', or "" for none' : ''}`); break;   // "" is no sound where the field's own default is none (a blade's dry fire): the kit fills it in, so a made game's config passes the check its spec did
      case 'id': if (typeof v !== 'string' || !ID.test(v)) out.push(`${p}: an id of lower case letters, digits and dashes (at most 32)`); break;
      case 'ref':
        if (v === '') break;
        if (typeof v !== 'string') out.push(`${p}: must be an id from ${f.table}`);
        else if (refs?.[f.table] && !refs[f.table].includes(v)) out.push(`${p}: "${v}" is not an id in ${f.table} (${refs[f.table].join(', ') || 'none'})`);
        break;
      case 'object': checkFields(f.fields, v, p, refs, out); break;
      case 'list':
        if (!Array.isArray(v)) { out.push(`${p}: must be a list`); break; }
        if (v.length < f.min || v.length > f.max) out.push(`${p}: ${f.min}–${f.max} items`);
        v.forEach((item, i) => checkFields(f.fields, item, `${p}[${i}]`, refs, out));
        break;
    }
  }
  return out;
}

/** The JSON Schema of `fields` (draft 2020-12 subset, as research/gf-three/tools/lib/schema.mjs reads it). */
export function schemaOf(fields) {
  const properties = {}, required = [];
  for (const [k, f] of Object.entries(fields)) {
    const d = f.describe || f.label || undefined;
    switch (f.type) {
      case 'number': properties[k] = { type: 'number', minimum: f.min, maximum: f.max, default: f.default, ...(d ? { description: `${d}${f.unit ? ` (${f.unit})` : ''}` } : {}) }; break;
      case 'integer': properties[k] = { type: 'integer', minimum: f.min, maximum: f.max, default: f.default, ...(d ? { description: d } : {}) }; break;
      case 'boolean': properties[k] = { type: 'boolean', default: f.default, ...(d ? { description: d } : {}) }; break;
      case 'color': properties[k] = { type: 'string', pattern: '^#[0-9a-fA-F]{6}$', default: f.default, ...(d ? { description: d } : {}) }; break;
      case 'text': properties[k] = { type: 'string', maxLength: f.maxLength ?? 120, ...(d ? { description: d } : {}) }; break;
      case 'choice': properties[k] = { enum: f.options, default: f.default, ...(d ? { description: d } : {}) }; break;
      case 'sound': properties[k] = { type: 'string', default: f.default, description: `a sound id (assets.json; gf-audio preset ${f.preset})` }; break;
      case 'ref': properties[k] = { type: 'string', description: `an id from ${f.table}` }; break;
      case 'id': properties[k] = { type: 'string', pattern: ID.source }; required.push(k); break;
      case 'object': properties[k] = schemaOf(f.fields); break;
      case 'list': properties[k] = { type: 'array', minItems: f.min, maxItems: f.max, items: schemaOf(f.fields) }; break;
    }
  }
  return { type: 'object', additionalProperties: false, properties, ...(required.length ? { required } : {}) };
}

/**
 * Slot declarations (gf-assets/1, CONTRACT §2.2) for every value of a filled table: numbers, integers, booleans,
 * colours and choices (texts, ids, refs and sound ids are not slots: a sound is replaced in the sounds list).
 *   base: {id: 'forge.player', pointer: '/forge/player', label: 'Player', group, rank}
 */
export function slotsOf(fields, value, base, out = []) {
  for (const [k, f] of Object.entries(fields)) {
    const v = value?.[k];
    const id = `${base.id}.${k.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()}`, pointer = `${base.pointer}/${k}`;
    const label = `${base.label}: ${f.label || k}`;
    if (f.type === 'object') { slotsOf(f.fields, v, { ...base, id, pointer, label: f.label ? `${base.label} ${f.label.toLowerCase()}` : base.label }, out); continue; }
    if (f.type === 'list') { (Array.isArray(v) ? v : []).forEach((item, i) => slotsOf(f.fields, item, { ...base, id: `${id}.${i}`, pointer: `${pointer}/${i}`, label: `${base.label} ${f.label || k} ${i + 1}` }, out)); continue; }
    if (v === undefined) continue;
    const s = { id, group: base.group, label: label.slice(0, 80), source: { file: 'config/game.json', pointer }, tier: f.tier === 'main' ? 'main' : 'advanced', facet: f.type === 'color' ? 'look' : 'gameplay', rank: f.tier === 'main' ? (base.rank ?? 50) : 10 };
    if (f.describe) s.description = f.describe;
    if (f.type === 'number' || f.type === 'integer') out.push({ ...s, type: f.type, constraints: { min: f.min, max: f.max, ...(f.unit ? { unit: f.unit } : {}) } });
    else if (f.type === 'boolean') out.push({ ...s, type: 'boolean' });
    else if (f.type === 'color') out.push({ ...s, type: 'color' });
    else if (f.type === 'choice') out.push({ ...s, type: 'enum', constraints: { options: f.options } });
    // words a player reads (a card's name and line, the reward's and the revive's prompts): a text slot, as the kit's
    // own texts are (gf/three/ui/slots.js)
    else if (f.type === 'text' && f.slot && typeof v === 'string') out.push({ ...s, group: 'text', type: 'text', facet: 'text', constraints: { maxLength: f.maxLength ?? 120, ...((f.maxLength ?? 120) > 80 ? { multiline: true } : {}) } });
  }
  return out;
}

/** Every sound id a filled table names, with its preset and label: [{id, preset, label}]. */
export function soundsOf(fields, value, out = []) {
  for (const [k, f] of Object.entries(fields)) {
    const v = value?.[k];
    if (f.type === 'sound' && typeof v === 'string' && v) out.push({ id: v, preset: f.preset, label: f.label || k });
    else if (f.type === 'object') soundsOf(f.fields, v, out);
    else if (f.type === 'list' && Array.isArray(v)) for (const item of v) soundsOf(f.fields, item, out);
  }
  return out;
}
