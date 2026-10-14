// gf-forge data tables (PLAN §3.3; CONTRACT §8 forge "spec.forge"; research/gf-forge/core/ARCHITECTURE.md "Tables"):
// the schema of `spec.forge`, its defaults, its checker, its slots and its sounds, in one place. Vendored into a forge
// game as gf/forge/tables/ (never edited there); create imports it in Node.
//
//   spec.forge = { player: {…}, physics: {…}, deal: {…}, weapons: [{id, kind | preset, …}], enemies: [{id, archetype, …}],
//                  waves: [{id, enemies: [{type, count}], …}], cards: [{id, rarity, kind, …}], feel: {…}, endless: {…},
//                  families: [{id, label, at, bonus: {perk, power}, …}],
//                  elites: {…},
//                  shop: {on, seconds, every, from, items: [{id, kind, price, perLap, perBuy, stock, …}], …} }
//
//   check(spec.forge)  → {problems, notes}   create refuses a spec with problems (a value the core can't do, an unknown
//                                             field, a wave naming an enemy that does not exist)
//   fill(spec.forge)   → every table with every value (defaults, then a row's kind or preset, then the row's own);
//                        create writes it to config/game.json → forge, and each value is a slot there
//   slotsFor(cfg)      → the slot declarations (forge.player.walk, forge.weapons.<id>.damage, …)
//   soundsOf(tables)   → [{id, preset, label}]: every sound id the tables name, for assets.json
//   pack(tables)       → the JSON the host hands the core (forge.load_tables)
//
// Each table's fields live in its owner's file: player.js (forge-core and forge-feel), weapons.js and cards.js
// (forge-feel), enemies.js, waves.js, endless.js and elites.js (forge-ai), feel.js (forge-feel). A track adds a field there, with its default, range and label; the
// core reads rows generically (forge_core::tables::Row), so no Rust outside the track's crate changes.
import { defaultsOf, fillWith, checkFields, schemaOf, slotsOf, soundsOf as soundsIn } from './fields.js';
import { fields as PLAYER, physics as PHYSICS } from './player.js';
import * as W from './weapons.js';
import * as E from './enemies.js';
import * as V from './waves.js';
import * as C from './cards.js';
import * as F from './feel.js';
import * as N from './endless.js';
import * as X from './elites.js';
import * as SH from './shop.js';

export const VERSION = 1;

/** Every table: an object (one per game) or rows (a list of objects with ids). */
export const TABLES = {
  player: { kind: 'object', fields: PLAYER, group: 'controls', label: 'Player', rank: 58 },
  physics: { kind: 'object', fields: PHYSICS, group: 'mechanics', label: 'Physics', rank: 20 },
  deal: { kind: 'object', fields: C.deal, group: 'mechanics', label: 'Card deal', rank: 20 },
  weapons: { kind: 'rows', fields: W.fields, group: 'mechanics', label: 'Weapon', rank: 52 },
  enemies: { kind: 'rows', fields: E.fields, group: 'mechanics', label: 'Enemy', rank: 50 },
  waves: { kind: 'rows', fields: V.fields, group: 'mechanics', label: 'Wave', rank: 40 },
  cards: { kind: 'rows', fields: C.fields, group: 'mechanics', label: 'Card', rank: 30 },
  feel: { kind: 'object', fields: F.fields, group: 'mechanics', label: 'Feel', rank: 45 },
  endless: { kind: 'object', fields: N.fields, group: 'mechanics', label: 'Endless', rank: 41 },
  families: { kind: 'rows', fields: C.familyFields, group: 'mechanics', label: 'Family', rank: 30 },
  elites: { kind: 'object', fields: X.fields, group: 'mechanics', label: 'Elites', rank: 39 },
  shop: { kind: 'object', fields: SH.fields, group: 'mechanics', label: 'Pedlar\'s cart', rank: 25 },
};

/** What runs each table on forge today. A track updates its line when its systems land (create prints the "not yet"s). */
export const RUNS = {
  player: { now: 'forge-feel\'s controller (walk, first step, jump, evade, stamina, head bob, hurt) over forge-core\'s body and health', notYet: null },
  physics: { now: 'forge-core', notYet: null },
  deal: { now: 'forge-feel: the seeded three-card deal by rarity weight, different per player and the same on every copy; the reward\'s time; the kit\'s reward screen (gf/forge/cards.js) deals and flips to the table\'s rhythm', notYet: null },
  weapons: { now: 'forge-feel: hitscan, projectiles, pellets, held fire, magazines and reloads, recoil, melee and the quick melee; beam and charge in a first form', notYet: null },
  enemies: { now: 'forge-ai: every archetype (chaser, runner, caster, shield, brute, boss) from its row', notYet: null },
  waves: { now: 'forge-ai: the wave director (spawn mix and pacing, rule events, the reward pause, the boss wave)', notYet: null },
  cards: { now: 'forge-feel: upgrades (a table value of the player or a weapon: add, then multiply; a second value for a trade), weapon cards, heals and perks (blast, burst, shockwave, thorns, aura, fury, lifesteal, ambush, rush: run on the host), per player, stacking, carried by snapshots and predicted alike on a joiner', notYet: null },
  feel: { now: 'forge-feel: hit flashes, damage numbers, combos, kills into debris and coins, knock-downs and severing, aim help, low-health stages, the death recap', notYet: null },
  endless: { now: 'forge-ai: the wave director goes round again from `from` with the waves grown each lap (enemies, most at once up to aliveMost, health, damage, speed up to speedMost); the wave is numbered with no end', notYet: null },
  families: { now: 'forge-feel: a card\'s family counted per player (copies count), the set bonus unlocked once at `at` (a perk; rule event set-bonus), the deal leaning toward families held (deal.familyBias); the kit\'s badge, inspector line, build line and banner', notYet: null },
  elites: { now: 'forge-ai: elites from a lap or a wave on (burning, armoured, splitting, fast), decided by the host, drawn with their modifier\'s rim on every copy, their kills paying more coins', notYet: null },
  shop: { now: 'forge-feel (wave 7): each player\'s purse; the pedlar\'s cart between waves (a paid deal of three, a reroll of the reward, a heal, a hone of a card held, a paid revive), prices by lap and by purchase, checked by the host, carried by snapshots; the director waits for it; the kit\'s cart screen (gf/forge/shop.js) and the paid revive in a fight', notYet: null },
};

/** Gf-audio presets for sound ids a preset or archetype names that its field's own preset does not fit. */
const SOUND_PRESETS = { 'shot-heavy': 'explosion-small', 'weapon-shotgun-shot': 'explosion-small', 'weapon-mg-shot': 'laser-soft', ...C.PERK_SOUNDS };

const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
/** `b` over `a`, deep for plain objects. */
function deepMerge(a, b) {
  if (!isObj(a) || !isObj(b)) return b === undefined ? a : JSON.parse(JSON.stringify(b));
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = isObj(v) && isObj(a[k]) ? deepMerge(a[k], v) : JSON.parse(JSON.stringify(v));
  return out;
}

/** The values a row starts from before its own: the field defaults, then its kind's, preset's, archetype's or rarity's. */
export function rowBase(table, row = {}) {
  const T = TABLES[table];
  let base = defaultsOf(T.fields);
  if (table === 'weapons') {
    const preset = W.presets[row.preset];
    const kind = row.kind ?? preset?.kind ?? base.kind;
    base = deepMerge(base, W.kinds[kind] ?? {});
    if (preset) base = deepMerge(base, preset);
    base.kind = kind;
    if (!row.name) base.name = preset?.name ?? row.id ?? '';
  } else if (table === 'enemies') {
    base = deepMerge(base, E.archetypes[row.archetype ?? base.archetype] ?? {});
    if (!row.name) base.name = row.id ?? '';
  } else if (table === 'cards') {
    base.color = C.RARITY_COLORS[row.rarity ?? base.rarity] ?? base.color;
    if (!row.name) base.name = row.id ?? '';
    // a perk card's numbers are its perk's own (only those it reads); any other card has none (no slots for them)
    const perk = (row.kind ?? base.kind) === 'perk' ? C.perkBase(row.perk) : null;
    if (perk) { base.power = perk.power; base.sound = perk.sound; } else { delete base.perk; delete base.power; delete base.sound; }
  } else if (table === 'families') {
    if (!row.name) base.name = row.id ?? '';
    if (!row.label) base.label = row.name || row.id || '';
    const perk = C.perkBase(isObj(row.bonus) ? row.bonus.perk : undefined);
    if (perk) { base.bonus.power = perk.power; base.bonus.sound = perk.sound; } else delete base.bonus.power;
  }
  return base;
}

/** Every table with every value: missing tables get their defaults (rows: none). */
export function fill(forge = {}) {
  const f = isObj(forge) ? forge : {};
  const out = {};
  for (const [name, T] of Object.entries(TABLES)) {
    if (T.kind === 'object') out[name] = fillWith(T.fields, defaultsOf(T.fields), f[name]);
    else out[name] = (Array.isArray(f[name]) ? f[name] : []).map(row => (isObj(row) ? fillWith(T.fields, rowBase(name, row), row) : row));
  }
  for (const k of Object.keys(f)) if (!(k in TABLES)) out[k] = f[k];   // unknown tables stay for check() to name
  return out;
}

/** The defaults of every table (what a spec without a forge block plays with). */
export const defaults = () => fill({});

/**
 * Check a spec's forge block (as written, before fill). → {problems, notes}. A problem is something the core cannot do or
 * the spec got wrong (create refuses it); a note says what does not run on forge yet.
 */
export function check(forge) {
  const problems = [], notes = [];
  if (forge === undefined || forge === null) return { problems, notes };
  if (!isObj(forge)) return { problems: ['forge: must be an object of tables (player, weapons, enemies, waves, cards, …)'], notes };
  for (const k of Object.keys(forge)) if (!(k in TABLES)) problems.push(`forge.${k}: not a table (tables: ${Object.keys(TABLES).join(', ')})`);
  const ids = t => (Array.isArray(forge[t]) ? forge[t].map(r => r?.id).filter(x => typeof x === 'string') : []);
  const refs = { weapons: ids('weapons'), enemies: ids('enemies'), waves: ids('waves'), cards: ids('cards'), families: ids('families') };
  for (const [name, T] of Object.entries(TABLES)) {
    const v = forge[name];
    if (v === undefined) continue;
    if (T.kind === 'object') {
      checkFields(T.fields, v, `forge.${name}`, refs, problems);
      // the pedlar's items: each id once (a purchase names its item by its row)
      if (name === 'shop' && Array.isArray(v?.items)) { const seen = new Set(); v.items.forEach((it, i) => { if (seen.has(it?.id)) problems.push(`forge.shop.items[${i}].id: "${it.id}" is used twice`); seen.add(it?.id); }); }
      continue;
    }
    if (!Array.isArray(v)) { problems.push(`forge.${name}: must be a list`); continue; }
    const seen = new Set();
    v.forEach((row, i) => {
      const at = `forge.${name}[${i}]`;
      if (!isObj(row)) { problems.push(`${at}: must be an object`); return; }
      if (seen.has(row.id)) problems.push(`${at}.id: "${row.id}" is used twice in ${name}`);
      seen.add(row.id);
      if (name === 'weapons' && row.preset && !W.presets[row.preset]) problems.push(`${at}.preset: "${row.preset}" is not a preset (${Object.keys(W.presets).join(', ')})`);
      checkFields(T.fields, row, at, refs, problems);
      if (name === 'cards' && row.kind === 'weapon' && !row.weapon) problems.push(`${at}.weapon: a weapon card names its weapon`);
      if (name === 'cards' && row.kind === 'perk' && !C.PERKS[row.perk]) problems.push(`${at}.perk: a perk card names its perk (${C.PERK_IDS.join(', ')})`);
      if (name === 'cards' && row.kind !== 'perk' && ['perk', 'power'].some(k => k in row)) problems.push(`${at}: a perk and its numbers are for kind "perk"`);
      if (name === 'cards') for (const k of ['stat', 'stat2']) {
        const kind = row.kind ?? 'upgrade', path = row[k];
        if (k === 'stat' && kind === 'upgrade' && !path) problems.push(`${at}.stat: an upgrade card names the value it changes ("player.walk", "weapons.sidearm.damage")`);
        if (typeof path === 'string' && path) { const why = cardPathProblem(path, refs.weapons); if (why) problems.push(`${at}.${k}: ${why}`); }
      }
    });
    if (v.length && RUNS[name]?.notYet) notes.push(`forge.${name}: ${RUNS[name].notYet}; its values are kept as slots`);
  }
  if (isObj(forge.player) && RUNS.player.notYet && ['evade', 'stamina', 'bob', 'hurt'].some(k => k in forge.player)) notes.push(`forge.player: ${RUNS.player.notYet}`);
  return { problems, notes };
}

/** The field a dotted path names in `fields` (through nested objects), or null. */
function fieldAt(fields, path) {
  let f = { type: 'object', fields };
  for (const k of path.split('.')) { if (f?.type !== 'object' || !f.fields[k]) return null; f = f.fields[k]; }
  return f;
}

/**
 * A card's value path ("player.walk", "weapons.sidearm.damage", "weapons.*.reload") → the field it names:
 * {table: 'player' | 'weapons', id (a weapon id or '*'), key (the path inside the row), field} or null. The reward's
 * inspector reads the field's label and unit from here; forge-feel (cards.rs) applies the same paths.
 */
export function cardPath(path) {
  const [table, ...rest] = String(path ?? '').split('.');
  if (table === 'player' && rest.length) { const field = fieldAt(PLAYER, rest.join('.')); return field ? { table, id: null, key: rest.join('.'), field } : null; }
  if (table === 'weapons' && rest.length >= 2) { const key = rest.slice(1).join('.'), field = fieldAt(W.fields, key); return field ? { table, id: rest[0], key, field } : null; }
  return null;
}

/** Why a card cannot change the value at `path` (null: it can). */
function cardPathProblem(path, weaponIds) {
  const p = cardPath(path);
  if (!p) return `"${path}" is not a value in the player or weapons table (write "player.<value>" or "weapons.<id or *>.<value>")`;
  if (p.field.type !== 'number' && p.field.type !== 'integer') return `"${path}" is not a number a card can change`;
  if (p.table === 'weapons' && p.id !== '*' && !weaponIds.includes(p.id)) return `"${p.id}" is not an id in weapons (${weaponIds.join(', ') || 'none'})`;
  return null;
}

/** The JSON Schema of spec.forge. */
export function schema() {
  const properties = {};
  for (const [name, T] of Object.entries(TABLES)) properties[name] = T.kind === 'object' ? schemaOf(T.fields) : { type: 'array', items: schemaOf(T.fields) };
  return { type: 'object', additionalProperties: false, description: 'gf-forge data tables (research/gf-forge/kit/tables): every value a slot', properties };
}

/** Slot declarations for config/game.json → forge (the filled tables). */
export function slotsFor(cfg) {
  const forge = cfg?.game?.forge;
  if (!isObj(forge)) return [];
  const out = [];
  for (const [name, T] of Object.entries(TABLES)) {
    const v = forge[name];
    if (T.kind === 'object') { if (isObj(v)) slotsOf(T.fields, v, { id: `forge.${name}`, pointer: `/forge/${name}`, label: T.label, group: T.group, rank: T.rank }, out); continue; }
    (Array.isArray(v) ? v : []).forEach((row, i) => {
      if (!isObj(row) || typeof row.id !== 'string') return;
      const label = `${T.label} ${row.name || row.id}`;
      slotsOf(T.fields, row, { id: `forge.${name}.${row.id}`, pointer: `/forge/${name}/${i}`, label, group: T.group, rank: T.rank }, out);
    });
  }
  return out;
}

/** Every sound the filled tables name, once each: [{id, preset, label}]. */
export function soundsOf(tables) {
  const all = [];
  for (const [name, T] of Object.entries(TABLES)) {
    const v = tables?.[name];
    if (T.kind === 'object') soundsIn(T.fields, v, all);
    else for (const row of Array.isArray(v) ? v : []) soundsIn(T.fields, row, all);
  }
  const seen = new Map();
  for (const s of all) if (!seen.has(s.id)) seen.set(s.id, { ...s, preset: SOUND_PRESETS[s.id] ?? s.preset });
  return [...seen.values()];
}

/** The JSON the core loads (forge_core::tables::Tables::load). */
export const pack = tables => JSON.stringify(tables ?? defaults());

export { W as weapons, E as enemies, V as waves, C as cards, F as feel, X as elites, SH as shop };
