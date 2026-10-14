// What owning an item changes in the game: an item's `look` is a gf-three loadout fragment (gf-three CONTRACT §6e,
// kit/assets/loadout.js), { values: { slotId: value }, files: { slotId: url } }, limited to the game's player-look
// slots (`scope: "player"` in assets.json). The worn items' looks merge into one loadout, which the game applies:
//   window.__GF_LOADOUT = loadout   (gf-three's kit/net/looks.js listens; every copy in multiplayer then shows it)
// gf-three checks the loadout against the game's slots again and drops anything that does not fit, never fatally.
import { RARITIES } from './rules.js';

/** gf-three's budget for one loadout on the wire. */
export const MAX_LOADOUT_BYTES = 3000;
const SLOT_ID = /^[a-z][a-z0-9._-]{0,79}$/i;
const COLOR = /^#[0-9a-f]{6}$/i;
const MAX_VALUE_CHARS = 64;
const MAX_URL = 512;
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** A look value: a colour, a number, a toggle or a short option. */
function cleanValue(v) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string') {
    const s = v.trim();
    if (/^#[0-9a-f]{3}$/i.test(s)) return `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`.toLowerCase();
    if (COLOR.test(s)) return s.toLowerCase();
    return s && s.length <= MAX_VALUE_CHARS && !/[\u0000-\u001f<>]/.test(s) ? s : undefined;
  }
  return undefined;
}

/** A look file: an https URL or a path inside the game (every copy in multiplayer must be able to load it). */
function cleanFile(v) {
  const url = typeof v === 'string' ? v.trim() : isObject(v) && typeof v.url === 'string' ? v.url.trim() : '';
  if (!url || url.length > MAX_URL) return undefined;
  if (/^https:\/\//i.test(url)) {
    try {
      const u = new URL(url);
      return u.username || u.password || u.search ? undefined : u.toString();
    } catch {
      return undefined;
    }
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith('/') || url.includes('\\') || url.split(/[?#]/)[0].split('/').includes('..'))
    return undefined;
  return url.replace(/^\.\//, '');
}

/** A look with only well-formed entries: { values, files }. Unknown or broken entries are dropped. */
export function cleanLook(raw) {
  const look = { values: {}, files: {} };
  if (!isObject(raw)) return look;
  for (const [id, v] of Object.entries(isObject(raw.values) ? raw.values : {})) {
    const value = SLOT_ID.test(id) ? cleanValue(v) : undefined;
    if (value !== undefined) look.values[id] = value;
  }
  for (const [id, v] of Object.entries(isObject(raw.files) ? raw.files : {})) {
    const file = SLOT_ID.test(id) ? cleanFile(v) : undefined;
    if (file !== undefined) look.files[id] = file;
  }
  return JSON.stringify(look).length <= MAX_LOADOUT_BYTES ? look : { values: {}, files: {} };
}

export const lookSlots = (look) => [...Object.keys(look?.values ?? {}), ...Object.keys(look?.files ?? {})];
export const isEmptyLook = (look) => lookSlots(look).length === 0;

/**
 * One loadout from the items a player wears. One item per slot: the first item in `items` that sets a slot wins, so
 * pass them in the player's order of choice. `byRarity` sorts rarest first (the default when a player has not chosen).
 */
export function loadoutOf(items, { byRarity = false } = {}) {
  const list = [...items].filter((i) => i?.look);
  if (byRarity) list.sort((a, b) => RARITIES.indexOf(b.rarity) - RARITIES.indexOf(a.rarity) || a.id - b.id);
  const loadout = { values: {}, files: {} };
  const worn = [];
  for (const item of list) {
    const look = cleanLook(item.look);
    let used = false;
    for (const [id, v] of Object.entries(look.values)) if (!(id in loadout.values) && !(id in loadout.files)) ((loadout.values[id] = v), (used = true));
    for (const [id, v] of Object.entries(look.files)) if (!(id in loadout.values) && !(id in loadout.files)) ((loadout.files[id] = v), (used = true));
    if (used) worn.push(item.id);
  }
  while (JSON.stringify(loadout).length > MAX_LOADOUT_BYTES) {
    const file = Object.keys(loadout.files).pop();
    if (file) delete loadout.files[file];
    else delete loadout.values[Object.keys(loadout.values).pop()];
  }
  return { loadout, worn };
}

/** A short plain-words line about what a look changes ("Changes body colour, hat"). */
const NAMES = {
  'character.tint.player': 'body colour',
  'mechanic.projectile.color': 'shot colour',
  'character.hat.player': 'hat',
  'character.body.player': 'character',
};
export function describeLook(look, labels = {}) {
  const ids = lookSlots(look);
  if (!ids.length) return 'Collectible only (changes nothing in the game)';
  return `Changes ${ids.map((id) => labels[id] ?? NAMES[id] ?? id).join(', ')}`;
}
