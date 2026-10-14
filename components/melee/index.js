// mechanic: melee (track M, gf-scenic wave 1). A weapon you swing: a combo chain of swings with windup, active and
// recover frames, a heavy attack, a dash with invulnerable frames and a dash strike, hit-stop and screen shake on a hit,
// a slash trail, a weapon in the hand. README.md has the network ownership and the API.
//
//   const melee = ctx.mechanics.get('melee');
//   // nothing to wire: primary swings, secondary is the heavy attack, jump (Space) dashes (params action,
//   // heavyAction, dashAction; '' leaves it to rules.js: melee.swing(p, 'light' | 'heavy'), melee.dash(p))
//   melee.onHit(h => { ... });                 // host: {attacker, target, kind ('enemy' | 'boss' | 'player'), damage, killed}
//
// Creator, 2026-10-08 (the roguelike miss): "Throwing snowballs at a horde is not a rogue like game similar to Lost
// Castle and Rampage Knights". The kit had no melee, so a sword slash became a projectile. Now a swing has weight: it
// winds up, hits during its active frames only (each target once a swing), commits the player to a recovery, lunges a
// step, and a hit stops the attacker's swing for a few hundredths of a second (hit-stop) and shakes this player's
// camera. Hit-stop and shake are this copy's own feel only: the shared world never pauses (CONTRACT §3).
//
// The combat model is ported from BUDDY: ROLLBACK (octobooth-4/buddy-rollback@db51978, MIT; logic.js and
// NOTICE-buddy-rollback beside this file).
import * as THREE from 'three';
import {
  normalizeWeapons, createSwing, stepSwing, holdSwing, resolveMove, arcHits, moveCode, moveKey, activeShare, trailSpan,
  plausibleHit, modsOf, NO_MODS, SWING_DEFAULTS, RARITIES, DEFAULT_WEAPONS, MOVE_DEFAULTS, UPGRADES,
} from './logic.js';
import { feelOf } from './feel.js';
import { hold, gripOf } from './held.js';
import { forSlot, onlyNumbers } from '../../assets/items.js';

export const id = 'melee';
export const examples = ['a sword you swing in combos', 'an axe with a heavy spin', 'a spear that thrusts', 'fists in a brawl'];

const D = {
  action: 'primary', heavyAction: 'secondary', dashAction: 'jump', weapon: 'sword', weapons: null,
  comboWindow: SWING_DEFAULTS.comboWindow, buffer: SWING_DEFAULTS.buffer, chainAt: SWING_DEFAULTS.chainAt, holdRepeat: true,
  moveWhileSwinging: 0.35, dashSpeed: 16, dashTime: SWING_DEFAULTS.dashTime, dashIframes: SWING_DEFAULTS.dashIframes,
  dashCooldown: SWING_DEFAULTS.dashCooldown, dashStrikeWindow: SWING_DEFAULTS.dashStrikeWindow,
  hitPlayers: 'auto', playerDamage: 1, trailColor: '#d6ecff', trailOpacity: 0.7, sparkColor: '#ffe7a8', blockColor: '#9fd8ff',
  rarityColors: ['#7d8799', '#3d8bff', '#a55cff', '#f29a12'], shake: 1, hitStopScale: 1,
  weaponRot: [90, 0, 0], weaponOffset: [0, 0, 0], weaponScale: 1, weaponColor: '#c9d3df', weaponGrip: null,
  soundSwing: 'melee-swing', soundHeavy: 'melee-heavy', soundHit: 'melee-hit', soundDash: 'melee-dash', soundBlock: 'melee-block',
};
const kebab = s => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
const num = (description, minimum, maximum, extra = {}) => ({ type: 'number', description, minimum, maximum, ...extra });
// one move's fields: each with its plain-words title, its range, its unit and the kit's default (MOVE_DEFAULTS); the
// weapon table's slots and its item declaration (WEAPON_ITEM) are read from here, so they cannot disagree
const mv = (title, description, minimum, maximum, unit, key) => ({ ...num(description, minimum, maximum), title, ...(unit ? { unit } : {}), default: MOVE_DEFAULTS[key] });
const MOVE_SCHEMA = {
  type: 'object', additionalProperties: true,
  properties: {
    damage: mv('Damage', 'Damage per target', 0, 100, '', 'damage'),
    windup: mv('Wind-up', 'Seconds the swing winds up (readable, before it can hit)', 0, 2, 's', 'windup'),
    active: mv('Active time', 'Seconds it can hit', 0.02, 1, 's', 'active'),
    recover: mv('Recovery', 'Seconds the player is committed after it', 0, 2, 's', 'recover'),
    arc: mv('Arc', 'Arc it covers (degrees)', 5, 360, '°', 'arc'),
    reach: mv('Reach', 'Reach (m)', 0.5, 8, 'm', 'reach'),
    knockback: mv('Knockback', 'Knockback (m/s)', 0, 30, 'm/s', 'knockback'),
    hitStop: mv('Hit-stop', 'Hit-stop on a hit (s, this player\'s own screen)', 0, 0.3, 's', 'hitStop'),
    lunge: mv('Lunge', 'Step forward as it lands (m/s)', 0, 20, 'm/s', 'lunge'),
    sweep: { type: 'integer', enum: [-1, 0, 1], title: 'Sweep', description: '1 right to left, -1 left to right, 0 a thrust', default: MOVE_DEFAULTS.sweep },
    tilt: mv('Trail tilt', 'Trail tilt (degrees)', -80, 80, '°', 'tilt'),
    clip: { type: 'string', title: 'Animation', description: 'gf-humanoid-1 clip (slash_1, slash_2, slash_3, heavy; falls back to punch)', maxLength: 40 },
    finisher: { type: 'boolean', title: 'Finisher', description: 'Ends the combo' },
    knockdown: { type: 'boolean', title: 'Knocks down', description: 'A hit knocks a player over (fair play decides) and staggers an enemy longer' },
    guardBreak: { type: 'boolean', title: 'Breaks a guard', description: 'Goes through a shielded enemy\'s guard' },
  },
};
/** One weapon of the table (config/game.json → mechanics[melee].params.weapons[i]): the item a page adds or edits. */
const WEAPON_SCHEMA = {
  type: 'object', additionalProperties: true,
  properties: {
    id: { type: 'string', title: 'Id', description: 'A short name, unique in the table: lower case letters, digits and dashes', pattern: '^[a-z0-9][a-z0-9_-]{0,23}$' },
    name: { type: 'string', title: 'Name', description: 'What the HUD and the drops call it', maxLength: 32 },
    kind: { type: 'string', enum: ['sword', 'axe', 'spear', 'hammer', 'fists'], title: 'Kind', description: 'Its shape when the kit draws it, and the kit weapon whose moves fill in what this one leaves out', default: 'sword' },
    rarity: { type: 'integer', minimum: 0, maximum: 3, title: 'Rarity', description: '0 common, 1 rare, 2 epic, 3 legendary: each step hits 25% harder', default: 0 },
    color: { type: 'string', format: 'color', title: 'Colour', description: 'Its colour when the kit draws it (no model)' },
    prop: { type: 'string', title: 'Prop', description: 'One of the game\'s props held as the weapon (prop.<name>), when it has no model of its own' },
    model: { type: 'string', title: 'Model', description: 'A file in assets/models/ (slot mechanic.melee.<id>.model), or "library:<id>" for a library model that the next slots --write copies in' },
    grip: { type: 'object', title: 'Grip', description: 'The model\'s place on the hand_r socket {position, quaternion}' },
    license: { type: 'object', title: 'Licence', description: 'The model\'s licence {spdx, author, url}' },
    combo: { type: 'array', minItems: 1, maxItems: 8, title: 'Swings', items: { ...MOVE_SCHEMA, title: 'Swing' } },
    heavy: { ...MOVE_SCHEMA, title: 'Heavy attack' },
    dashStrike: { ...MOVE_SCHEMA, title: 'Dash strike' },
  },
};
// The greatsword's own moves (the scenic library's third default weapon): two slow, wide, heavy swings
const GREATSWORD_COMBO = [
  { windup: 0.16, active: 0.12, recover: 0.3, arc: 150, reach: 2.7, damage: 2, knockback: 6, hitStop: 0.08, lunge: 3, sweep: 1, tilt: 18, clip: 'slash_1' },
  { windup: 0.22, active: 0.14, recover: 0.45, arc: 180, reach: 2.9, damage: 3, knockback: 10, hitStop: 0.12, lunge: 5, sweep: -1, tilt: -24, clip: 'heavy', finisher: true },
];
/**
 * The weapon table as an item (kit/assets/items.js, open builder wave 10): what one weapon is, what its card shows
 * first, where its picture goes, and the table a game gets when its spec names none (standard-3d: the kit's sword, axe and
 * spear, drawn by the kit; scenic-3d: the scenic library's KayKit sword, axe and greatsword, CC0).
 */
export const WEAPON_ITEM = {
  key: 'weapons', noun: 'weapon', nouns: 'weapons', min: 1, max: 8, id: 'id', name: 'name',
  schema: WEAPON_SCHEMA,
  front: ['name', 'combo/0/damage', 'combo/0/reach', 'heavy/damage', 'rarity'],
  picture: { field: 'model', alias: ['prop'], type: 'model', dir: 'assets/models', file: 'melee-<id>.glb', slot: 'mechanic.melee.<id>.model', library: 'kaykit-sword', extra: { grip: 'grip' } },
  defaults: {
    'standard-3d': DEFAULT_WEAPONS,
    'scenic-3d': [
      { id: 'sword', name: 'Sword', kind: 'sword', model: 'library:kaykit-sword' },
      { id: 'axe', name: 'Axe', kind: 'axe', model: 'library:kaykit-axe' },
      { id: 'greatsword', name: 'Greatsword', kind: 'sword', model: 'library:kaykit-greatsword', combo: GREATSWORD_COMBO },
    ],
  },
};
export const params = {
  type: 'object', additionalProperties: true,
  properties: {
    action: { type: 'string', enum: ['', 'primary', 'secondary', 'interact', 'jump'], default: D.action, description: 'Input that swings the combo ("": rules call melee.swing(p))' },
    heavyAction: { type: 'string', enum: ['', 'primary', 'secondary', 'interact', 'jump'], default: D.heavyAction, description: 'Input for the heavy attack ("": none)' },
    dashAction: { type: 'string', enum: ['', 'primary', 'secondary', 'interact', 'jump'], default: D.dashAction, description: 'Input that dashes ("": none). With "jump", Space dashes instead of jumping' },
    weapon: { type: 'string', default: D.weapon, description: 'Id of the weapon every player starts with (from weapons)' },
    weapons: { type: ['array', 'null'], default: null, maxItems: 8, description: 'The weapon table: [{id, name, kind (sword|axe|spear|hammer|fists), rarity 0-3, color, prop, model, combo: [move...], heavy: move, dashStrike: move}]; null: the kit\'s sword, axe and spear. create writes the profile\'s own table when the spec gives none, so a game holds one (the slot mechanic.melee.weapons)', items: WEAPON_SCHEMA },
    comboWindow: { ...num('Seconds after a swing in which a press continues the combo', 0, 2), default: D.comboWindow },
    buffer: { ...num('Seconds an early press is remembered', 0, 1), default: D.buffer },
    chainAt: { ...num('Share of the recovery after which a remembered press chains', 0, 1), default: D.chainAt },
    holdRepeat: { type: 'boolean', default: D.holdRepeat, description: 'Holding the button keeps swinging the combo' },
    moveWhileSwinging: { ...num('Walking speed while swinging, as a share of the run speed', 0, 1), default: D.moveWhileSwinging },
    dashSpeed: { ...num('Dash speed (m/s)', 4, 40), default: D.dashSpeed },
    dashTime: { ...num('Seconds a dash lasts', 0.05, 1), default: D.dashTime },
    dashIframes: { ...num('Seconds a dash makes the player untouchable', 0, 1), default: D.dashIframes },
    dashCooldown: { ...num('Seconds between dashes', 0, 5), default: D.dashCooldown },
    dashStrikeWindow: { ...num('Seconds after a dash in which an attack is a dash strike', 0, 1), default: D.dashStrikeWindow },
    hitPlayers: { type: ['string', 'boolean'], enum: ['auto', true, false], default: D.hitPlayers, description: 'Swings hit other players: auto = when the game is not co-op' },
    playerDamage: { ...num('Damage scale against players', 0, 10), default: D.playerDamage },
    trailColor: { type: 'string', default: D.trailColor, description: 'Colour of the slash trail' },
    trailOpacity: { ...num('Slash trail opacity', 0, 1), default: D.trailOpacity },
    sparkColor: { type: 'string', default: D.sparkColor, description: 'Colour of the sparks a hit throws' },
    blockColor: { type: 'string', default: D.blockColor, description: 'Colour of the sparks a blocked hit throws' },
    rarityColors: { type: 'array', items: { type: 'string' }, default: D.rarityColors, description: 'Colours of common, rare, epic and legendary' },
    shake: { ...num('Screen shake on a hit (0 off)', 0, 3), default: D.shake },
    hitStopScale: { ...num('Hit-stop scale (0 off)', 0, 3), default: D.hitStopScale },
    weaponRot: { type: 'array', items: { type: 'number' }, default: D.weaponRot, description: 'Weapon rotation in the hand (degrees x, y, z)' },
    weaponOffset: { type: 'array', items: { type: 'number' }, default: D.weaponOffset, description: 'Weapon offset in the hand (m)' },
    weaponScale: { ...num('Weapon scale', 0.2, 5), default: D.weaponScale },
    weaponColor: { type: 'string', default: D.weaponColor, description: 'Colour of the kit\'s stand-in weapon (with the kit\'s own weapon table)' },
    weaponGrip: { type: ['object', 'null'], default: D.weaponGrip, description: 'The weapon model\'s place on the hand_r socket {position: [x, y, z] m, quaternion: [x, y, z, w]} (research/gf-scenic/library/props.json records it for each KayKit weapon); null: weaponRot and weaponOffset. A weapon in the table may carry its own `grip`' },
    soundSwing: { type: 'string', default: D.soundSwing }, soundHeavy: { type: 'string', default: D.soundHeavy }, soundHit: { type: 'string', default: D.soundHit },
    soundDash: { type: 'string', default: D.soundDash }, soundBlock: { type: 'string', default: D.soundBlock },
  },
};

const vs = (name, label, type, extra = {}) => ({ id: `mechanic.melee.${kebab(name)}`, label, group: 'mechanics', type, source: { pointer: `{base}/${name}` }, tier: 'advanced', facet: type === 'color' || type === 'colors' ? 'look' : 'gameplay', ...extra });
// the numbers of a move that are slots of their own: [field, label, min, max, unit], from the move's schema
const MOVE_FIELDS = ['damage', 'windup', 'active', 'recover', 'arc', 'reach', 'knockback', 'hitStop', 'lunge']
  .map(f => { const s = MOVE_SCHEMA.properties[f]; return [f, s.title.toLowerCase(), s.minimum, s.maximum, s.unit]; });
/**
 * Slots: the feel and dash values, the trail and spark colours, and the weapon table, one value slot per tuning number
 * (mechanic.melee.<weapon>.<move>.<field>, advanced) and its colour. A weapon model: mechanic.melee.weapon (the file
 * assets/models/melee-weapon.glb) or a weapon's own `model` file; else a weapon's `prop` slot; else the kit's stand-in
 * primitive drawn in mechanic.melee.<weapon>.color.
 */
export function slotsFor(m = {}, cfg = {}) {
  const P = { ...D, ...(m.params ?? {}) };
  const out = [
    vs('trailColor', 'Slash trail colour', 'color', { tier: 'main', rank: 60 }),
    vs('dashCooldown', 'Dash cooldown', 'number', { tier: 'main', rank: 54, constraints: { min: 0, max: 5, unit: 's' } }),
    vs('sparkColor', 'Hit spark colour', 'color', { rank: 30 }), vs('blockColor', 'Blocked hit spark colour', 'color', { rank: 20 }),
    vs('trailOpacity', 'Slash trail opacity', 'number', { constraints: { min: 0, max: 1 } }),
    vs('rarityColors', 'Rarity colours (common, rare, epic, legendary)', 'colors', { rank: 24 }),
    vs('moveWhileSwinging', 'Walking speed while swinging', 'number', { constraints: { min: 0, max: 1 } }),
    vs('dashSpeed', 'Dash speed', 'number', { constraints: { min: 4, max: 40, unit: 'm/s' } }),
    vs('dashTime', 'Dash time', 'number', { constraints: { min: 0.05, max: 1, unit: 's' } }),
    vs('dashIframes', 'Dash invulnerable time', 'number', { constraints: { min: 0, max: 1, unit: 's' } }),
    vs('comboWindow', 'Combo window', 'number', { constraints: { min: 0, max: 2, unit: 's' } }),
    vs('shake', 'Screen shake on a hit', 'number', { constraints: { min: 0, max: 3 } }),
    vs('hitStopScale', 'Hit-stop scale', 'number', { constraints: { min: 0, max: 3 } }),
    vs('playerDamage', 'Damage scale against players', 'number', { constraints: { min: 0, max: 10 } }),
    vs('weaponScale', 'Weapon size in the hand', 'number', { constraints: { min: 0.2, max: 5 } }),
  ];
  for (const k of ['soundSwing', 'soundHeavy', 'soundHit', 'soundDash', 'soundBlock']) out.push(vs(k, `${k.slice(5)} sound id`, 'text', { facet: 'gameplay', constraints: { maxLength: 40 } }));
  const W = normalizeWeapons(P.weapons);
  const own = Array.isArray(P.weapons) && P.weapons.length;
  // a slot per number the game's own table holds (config/game.json → mechanics[melee].params.weapons): the kit's table
  // lives in the kit, so without the game's own there is nothing to point at
  if (own) W.forEach((w, i) => {
    const raw = P.weapons[i] ?? {}, base = `{base}/weapons/${i}`;
    if (typeof raw.color === 'string') out.push({ id: `mechanic.melee.${w.id}.color`, label: `${w.name}: colour`, group: 'mechanics', type: 'color', source: { pointer: `${base}/color` }, tier: i === 0 ? 'main' : 'advanced', rank: 52 - i, facet: 'look' });
    const moves = [...(Array.isArray(raw.combo) ? raw.combo : []).map((m, j) => [m, `combo/${j}`, `combo-${j + 1}`, `swing ${j + 1}`]), [raw.heavy, 'heavy', 'heavy', 'heavy attack'], [raw.dashStrike, 'dashStrike', 'dash-strike', 'dash strike']];
    for (const [m, ptr, sid, label] of moves) for (const [f, fl, min, max, unit] of MOVE_FIELDS) if (m && typeof m[f] === 'number')
      out.push({ id: `mechanic.melee.${w.id}.${sid}.${kebab(f)}`, label: `${w.name}, ${label}: ${fl}`, group: 'mechanics', type: 'number', source: { pointer: `${base}/${ptr}/${f}` }, tier: i === 0 && sid === 'combo-1' && f === 'damage' ? 'main' : 'advanced', rank: 50, facet: 'gameplay', constraints: { min, max, ...(unit ? { unit } : {}) } });
  });
  // the kit's own table: one colour slot per weapon would point nowhere, so the stand-in weapon is drawn in one colour
  out.push(vs('weaponColor', 'Stand-in weapon colour', 'color', { rank: 40 }));
  const files = new Set(cfg.files ?? []);
  if (files.has('assets/models/melee-weapon.glb')) out.push({ id: 'mechanic.melee.weapon', label: 'Weapon model', group: 'mechanics', type: 'model', source: { file: 'assets/models/melee-weapon.glb' }, tier: 'main', rank: 80, facet: 'look', constraints: { maxBytes: 4194304 }, description: 'Held in the right hand (hand_r socket), grip at its origin, blade toward +Y', generate: { prompt: 'a one-handed sword, the grip at the origin, the blade toward +Y', style: 'stylised low-poly game prop, clean silhouette' } });
  W.forEach((w, i) => { const lic = own ? P.weapons[i]?.license : null; if (w.model && files.has(`assets/models/${w.model}`)) out.push({ id: `mechanic.melee.${w.id}.model`, label: `${w.name}: model`, group: 'mechanics', type: 'model', source: { file: `assets/models/${w.model}` }, tier: 'advanced', facet: 'look', constraints: { maxBytes: 4194304 }, generate: { prompt: `a ${w.kind} (${w.name}), the grip at the origin, the blade toward +Y`, style: 'stylised low-poly game prop, clean silhouette' }, ...(lic && typeof lic === 'object' ? { license: lic } : {}) }); });
  // the table itself (items as data, open builder wave 10): one json slot whose value is the whole list, with what one
  // weapon is (WEAPON_ITEM) in its constraints, so a page adds, removes or renames a weapon with one slot write; and the
  // weapon everyone starts with, one of the table's ids
  const has = k => Object.prototype.hasOwnProperty.call(m.params ?? {}, k);
  if (has('weapons')) out.push({ id: 'mechanic.melee.weapons', label: 'Weapons (the whole table)', group: 'mechanics', type: 'json', source: { pointer: '{base}/weapons' }, tier: 'advanced', rank: 10, facet: 'gameplay',
    description: 'Every weapon in the game. Write the whole list to add, remove or rename one; each number must stay inside its range. A new weapon\'s model may be "library:<id>": the next slots --write copies it in',
    constraints: { item: forSlot(WEAPON_ITEM) } });
  if (has('weapon')) out.push({ id: 'mechanic.melee.start-weapon', label: 'Weapon everyone starts with', group: 'mechanics', type: 'text', source: { pointer: '{base}/weapon' }, tier: 'advanced', rank: 30, facet: 'gameplay',
    constraints: { enum: W.map(w => w.id), maxLength: 24 }, description: `One of the weapons' ids (${W.map(w => `${w.id}: ${w.name}`).join(', ')})` });
  return out;
}
export const slots = slotsFor({ params: {} });

const r2 = v => Math.round(v * 100) / 100;
const DEG = Math.PI / 180;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const unsub = (arr, fn) => () => { const i = arr.indexOf(fn); if (i >= 0) arr.splice(i, 1); };
const SEG = 22;

export function create(ctx, params = {}) {
  const P = { ...D, ...params };
  const V = (k, f = P[k]) => { const sid = `mechanic.melee.${kebab(k)}`; try { return ctx.assets?.has(sid) ? ctx.assets.value(sid, f) : f; } catch { return f; } };
  const L = { hit: [], swing: [] };
  // the weapon table (its slot mechanic.melee.weapons when the game has one), with Studio's values for each number
  // (mechanic.melee.<weapon>.<move>.<field>)
  const val = (sid, f) => { try { return ctx.assets?.has(sid) ? ctx.assets.value(sid, f) : f; } catch { return f; } };
  const tableNow = () => val('mechanic.melee.weapons', P.weapons);
  const copyOf = t => (t == null ? null : JSON.parse(JSON.stringify(t)));
  const own = Array.isArray(tableNow()) && tableNow().length;
  const build = table => normalizeWeapons(table).map(w => {
    if (!own) return w;
    const fix = (m, sid) => { const o = { ...m }; for (const [f] of MOVE_FIELDS) o[f] = Number(val(`mechanic.melee.${w.id}.${sid}.${kebab(f)}`, m[f])); return o; };
    return { ...w, color: val(`mechanic.melee.${w.id}.color`, w.color), combo: w.combo.map((m, j) => fix(m, `combo-${j + 1}`)), heavy: fix(w.heavy, 'heavy'), dashStrike: fix(w.dashStrike, 'dash-strike') };
  });
  const WEAPONS = build(tableNow());
  let tableSeen = copyOf(tableNow());
  /** A slot changed while the game runs (kit/core/live-slots.js, dev only): a weapon's numbers are taken at once, the
   *  next swing uses them; a new, removed or renamed weapon, another picture, a colour or the start weapon reloads. */
  function slotChanged(id) {
    if (id !== 'mechanic.melee.weapons' && !/^mechanic\.melee\.[a-z0-9_-]+\.(combo-\d+|heavy|dash-strike)\.[a-z-]+$/.test(id)) {
      return /^mechanic\.melee\.([a-z0-9_-]+\.(color|model)|start-weapon|weapon)$/.test(id) ? 'reload' : undefined;
    }
    const now = tableNow();
    if (!own || !onlyNumbers(WEAPON_ITEM, tableSeen, now)) return 'reload';
    build(now).forEach((w, i) => { WEAPONS[i] = w; });
    tableSeen = copyOf(now);
    return 'live';
  }
  const startIndex = Math.max(0, WEAPONS.findIndex(w => w.id === P.weapon));
  const swingOpts = () => ({ ...SWING_DEFAULTS, comboWindow: V('comboWindow'), buffer: V('buffer'), chainAt: V('chainAt'), holdRepeat: V('holdRepeat'), dashTime: V('dashTime'), dashIframes: V('dashIframes'), dashCooldown: V('dashCooldown'), dashStrikeWindow: V('dashStrikeWindow') });
  const feel = feelOf(ctx);
  const root = new THREE.Group(); root.name = 'gf-melee'; ctx.scene.add(root);
  const R = new Map();                // player id → runtime {st (owned), weapon obj, trail, remote swing, ...}
  const hostSeen = new Map();         // host: player id → [{serial, keys: Set}] (each target once a swing)
  const counts = new Map();           // host: player id → {swings, hits}
  let S = null, hitsSeen = 0, swingsSeen = 0, lastSwing = null, lastHitAt = null;
  const targets = (ctx.meleeTargets ??= []);

  // ---------------------------------------------------------------- weapons in hand
  const weaponIndex = p => { const v = S?.w?.[p.id]; return Number.isInteger(v) && v >= 0 && v < WEAPONS.length ? v : startIndex; };
  const weaponOf = p => { const W = WEAPONS[weaponIndex(p)], r = S?.r?.[p.id]; return Number.isInteger(r) && r !== W.rarity ? { ...W, rarity: Math.max(0, Math.min(3, r)) } : W; };
  const modsFor = p => { const loot = ctx.mechanics?.get?.('loot'); return loot && !loot.standin && loot.modsOf ? loot.modsOf(p) : NO_MODS; };
  const matCache = new Map();
  function metal(color) {
    if (matCache.has(color)) return matCache.get(color);
    const m = ctx.modules?.look?.material?.('prop', { tint: color }) ?? new THREE.MeshStandardMaterial({ color, roughness: 0.32, metalness: 0.65 });
    matCache.set(color, m); return m;
  }
  /** The kit's stand-in weapon (a primitive; its colour is the weapon's colour slot): grip at the origin, blade up +Y. */
  function primitive(w) {
    const g = new THREE.Group(); g.name = `gf-melee-weapon-${w.id}`;
    const blade = metal(own && ctx.assets.has(`mechanic.melee.${w.id}.color`) ? w.color : V('weaponColor', w.color)), dark = metal('#4a3a2c');
    const add = (geo, mat, x, y, z) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.castShadow = true; g.add(m); return m; };
    if (w.kind === 'axe') { add(new THREE.CylinderGeometry(0.025, 0.03, 0.85, 8), dark, 0, 0.3, 0); add(new THREE.BoxGeometry(0.3, 0.22, 0.035), blade, 0.12, 0.64, 0); }
    else if (w.kind === 'spear') { add(new THREE.CylinderGeometry(0.02, 0.024, 1.8, 8), dark, 0, 0.45, 0); add(new THREE.ConeGeometry(0.055, 0.32, 4), blade, 0, 1.5, 0); }
    else if (w.kind === 'hammer') { add(new THREE.CylinderGeometry(0.025, 0.03, 0.8, 8), dark, 0, 0.28, 0); add(new THREE.BoxGeometry(0.28, 0.17, 0.17), blade, 0, 0.66, 0); }
    else if (w.kind === 'fists') { add(new THREE.BoxGeometry(0.11, 0.09, 0.12), blade, 0, 0.02, 0); }
    else { add(new THREE.BoxGeometry(0.05, 0.16, 0.05), dark, 0, 0, 0); add(new THREE.BoxGeometry(0.2, 0.035, 0.05), dark, 0, 0.09, 0); add(new THREE.BoxGeometry(0.06, 0.78, 0.016), blade, 0, 0.5, 0); }
    const slot = own && ctx.assets.has(`mechanic.melee.${w.id}.color`) ? `mechanic.melee.${w.id}.color` : 'mechanic.melee.weapon-color';
    g.traverse(o => { if (o.isMesh) ctx.assets.tag(o, slot); });
    g.userData.gfStandin = true;
    return g;
  }
  const modelCache = new Map();
  async function modelFor(w) {
    const key = w.id;
    if (!modelCache.has(key)) {
      modelCache.set(key, (async () => {
        try {
          if (ctx.assets.has(`mechanic.melee.${w.id}.model`)) return await ctx.assets.model(`mechanic.melee.${w.id}.model`);
          if (WEAPONS.indexOf(w) === startIndex && ctx.assets.has('mechanic.melee.weapon')) return await ctx.assets.model('mechanic.melee.weapon');
          if (w.prop && ctx.assets.has(`prop.${w.prop}`)) return await ctx.assets.model(`prop.${w.prop}`, { fit: w.kind === 'spear' ? 1.9 : 0.95, fitAxis: 'y' });
        } catch (e) { console.warn(`melee: weapon model for ${w.id} failed, drawing the stand-in`, e); }
        return null;
      })());
    }
    const m = await modelCache.get(key);
    if (!m) return primitive(w);
    const c = m.clone(true); c.userData = { ...c.userData, gfStandin: false };
    return c;
  }
  function holdWeapon(p, r) {
    const c = p.character; if (!c?.socket) return;
    const wi = weaponIndex(p);
    if (r.weaponFor === c && r.weaponIdx === wi && r.weaponObj?.parent) return;
    if (r.loadingWeapon) return;
    r.loadingWeapon = true;
    modelFor(WEAPONS[wi]).then(obj => {
      r.loadingWeapon = false;
      if (!p.character) return;
      r.weaponObj?.removeFromParent();
      // a model with a grip sits as its pack's characters hold it; a stand-in by weaponRot and weaponOffset
      const W = WEAPONS[wi], grip = obj.userData.gfStandin ? null : gripOf(W.grip) ?? (wi === startIndex ? gripOf(V('weaponGrip')) : null);
      hold(p.character.socket('hand_r'), obj, { grip, rot: V('weaponRot'), offset: V('weaponOffset'), scale: V('weaponScale') });
      r.weaponObj = obj; r.weaponFor = p.character; r.weaponIdx = wi;
    }).catch(e => { r.loadingWeapon = false; console.warn('melee: weapon', e); });
  }

  // ---------------------------------------------------------------- the slash trail (a kit primitive; colour: a slot)
  function makeTrail() {
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array((SEG + 1) * 2 * 3), col = new Float32Array((SEG + 1) * 2 * 3), idx = [];
    for (let i = 0; i < SEG; i++) { const a = i * 2, b = a + 1, c = a + 2, d = a + 3; idx.push(a, b, c, b, d, c); }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3)); geo.setAttribute('color', new THREE.BufferAttribute(col, 3)); geo.setIndex(idx);
    const mat = new THREE.MeshBasicMaterial({ color: V('trailColor'), vertexColors: true, transparent: true, opacity: V('trailOpacity'), blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false });
    const mesh = new THREE.Mesh(geo, mat); mesh.frustumCulled = false; mesh.renderOrder = 4; mesh.name = 'gf-melee-trail';
    ctx.assets.tag(mesh, 'mechanic.melee.trail-color');
    const g = new THREE.Group(); g.add(mesh); g.visible = false; root.add(g);
    return { g, mesh, geo, pos, col, fade: 0, move: null, share: 0 };
  }
  function drawTrail(T, p, move, yaw, share, fade) {
    T.g.visible = fade > 0.01;
    if (!T.g.visible) return;
    T.g.position.set(p.position.x, p.position.y + (move.sweep === 0 ? 1.05 : 0.95), p.position.z);
    T.g.rotation.set(0, yaw, 0); T.mesh.rotation.set(0, 0, -(move.tilt ?? 0) * DEG);
    const sp = trailSpan(move, share);
    // another player's trail is drawn fainter than your own (your swing is the one you read)
    const own = p.local ? 1 : 0.55;
    for (let i = 0; i <= SEG; i++) {
      const u = i / SEG, a = sp.a0 + (sp.a1 - sp.a0) * u;
      // h: 0 at the tail, 1 at the blade's head (the end the sweep is moving toward); the band tapers to the tail
      const h = move.sweep > 0 ? 1 - u : u, thrust = move.sweep === 0;
      const k = (thrust ? 1 - Math.abs(u - 0.5) * 1.4 : Math.pow(h, 1.6)) * fade * own;
      const w = thrust ? 1 : 0.18 + 0.82 * Math.pow(h, 0.8);
      const inner = sp.outer - (sp.outer - sp.inner) * w;
      const so = Math.sin(a), co = Math.cos(a);
      T.pos.set([so * inner, 0, co * inner], i * 6); T.pos.set([so * sp.outer, 0, co * sp.outer], i * 6 + 3);
      T.col.set([k * 0.15, k * 0.15, k * 0.15], i * 6); T.col.set([k, k, k], i * 6 + 3);
    }
    T.geo.attributes.position.needsUpdate = true; T.geo.attributes.color.needsUpdate = true;
  }

  // ---------------------------------------------------------------- clips (track C adds slash_1..3, heavy, dash)
  const clipInfo = { swing: null, fallback: false };
  function clipFor(c, want, kind) {
    const has = n => !!n && (c?.clips?.includes?.(n) ?? false);
    if (has(want)) return want;
    const fb = kind === 'dash' ? (has('dash') ? 'dash' : 'roll') : 'punch';
    if (kind !== 'dash') { clipInfo.swing = fb; clipInfo.fallback = true; }
    return has(fb) ? fb : null;
  }
  function playClip(p, clip, seconds) {
    const c = p.character; if (!c?.play || !clip) return;
    const dur = c.meta?.[clip]?.duration ?? 0.7;
    c.play(clip, { rate: clamp(dur / Math.max(0.12, seconds), 0.6, 3.2), fade: 0.05 });
  }

  // ---------------------------------------------------------------- the players provider (versus melee)
  const coop = () => (ctx.config?.players?.mode ?? '') === 'coop';
  const hitsPlayers = () => { const h = V('hitPlayers'); return h === true || (h === 'auto' && !coop()); };
  const teams = () => ctx.mechanics?.get?.('teams');
  const mates = (a, b) => { const t = teams(); if (!t || t.standin || !t.teamOf || t.friendlyFire !== false) return false; const x = t.teamOf(a); return x >= 0 && x === t.teamOf(b); };
  const playersProvider = {
    key: 'p',
    list: attacker => (hitsPlayers() ? ctx.players.list().filter(q => q !== attacker && q.alive !== false && (q.owned || q.drawn) && !mates(attacker, q)).map(q => ({ id: q.id, x: q.position.x, z: q.position.z, radius: 0.45, height: q.character?.height ?? 1.7 })) : []),
    hostFind: id => { const q = ctx.players.get(id); return q && q.alive !== false ? { x: q.position.x, z: q.position.z, radius: 0.45 } : null; },
    hit({ id, attacker, damage, dir, move }) {
      const t = ctx.players.get(id); if (!t || !hitsPlayers() || mates(attacker, t)) return { counted: false };
      if (api.dodging(t)) return { counted: false, dodged: true };
      const hm = ctx.mechanics?.get('health');
      const k = move.knockback, knock = move.knockdown || move.finisher;
      const imp = { x: dir.x * k, y: knock ? 3 : 0.5, z: dir.z * k };
      let counted = true;
      if (hm?.damage && !hm.standin) counted = hm.damage(t, damage * V('playerDamage'), { from: attacker, impulse: imp, source: 'melee', push: !knock }) !== false;
      else if (ctx.fair?.on) { const why = ctx.fair.blocked(t, { from: attacker }); if (why) { ctx.fair.refuse(why); counted = false; } else if (knock) t.knock?.(imp, 0.8); else t.push?.(imp); }
      else if (knock) t.knock?.(imp, 0.8); else t.push?.(imp);
      return { counted };
    },
    feel(id) { const q = ctx.players.get(id); if (q?.character) { feel.freeze(q.character, 0.05); q.character.express?.('hurt', 0.4); } },
  };

  // ---------------------------------------------------------------- hits
  /** Host: apply one swing's hits reported by `p`'s copy (or found here). list: [[providerKey, targetId]] */
  function applyHits(p, serial, code, yaw, list) {
    if (!p || p.alive === false || !Array.isArray(list)) return 0;
    let seen = hostSeen.get(p.id); if (!seen) { seen = []; hostSeen.set(p.id, seen); }
    let rec = seen.find(s => s.serial === serial);
    if (!rec) { rec = { serial, keys: new Set() }; seen.push(rec); if (seen.length > 6) seen.shift(); }
    const W = weaponOf(p), key = moveKey(code), move = resolveMove(W, key, modsFor(p));
    let n = 0;
    const c = counts.get(p.id) ?? { swings: 0, hits: 0 };
    for (const [pk, tid] of list.slice(0, 12)) {
      const tk = `${pk}:${tid}`; if (rec.keys.has(tk)) continue;
      const prov = pk === 'p' ? playersProvider : targets.find(t => t.key === pk); if (!prov) continue;
      const pos = prov.hostFind?.(tid); if (!pos) continue;
      if (!plausibleHit(p.position, pos, move)) continue;
      rec.keys.add(tk);
      const dx = pos.x - p.position.x, dz = pos.z - p.position.z, l = Math.hypot(dx, dz) || 1;
      const dir = l > 0.05 ? { x: dx / l, z: dz / l } : { x: Math.sin(yaw), z: Math.cos(yaw) };
      let r = null;
      try { r = prov.hit({ id: tid, attacker: p, damage: move.damage, dir, yaw, move, knockback: move.knockback, kind: 'melee' }) ?? {}; } catch (e) { console.error(e); r = {}; }
      if (r.counted === false) continue;
      n++; c.hits++;
      for (const fn of L.hit.slice()) try { fn({ attacker: p, target: tid, kind: pk === 'p' ? 'player' : pk === 'b' ? 'boss' : 'enemy', provider: pk, damage: move.damage, move: key, blocked: !!r.blocked, killed: !!r.killed }); } catch (e) { console.error(e); }
    }
    counts.set(p.id, c);
    return n;
  }

  /** This copy found hits for an owned player's swing: the feel here at once, the damage on the host. */
  function landHits(p, r, hits) {
    const st = r.st, move = st.move;
    const local = p.local, list = [];
    let any = false, blocked = false;
    for (const h of hits) {
      list.push([h.prov.key, h.id]);
      st.hit.add(`${h.prov.key}:${h.id}`);
      const t = h.target, at = { x: t.x - Math.sin(st.yaw) * (t.radius ?? 0.45) * 0.6, y: (t.height ?? 1.7) * 0.58, z: t.z - Math.cos(st.yaw) * (t.radius ?? 0.45) * 0.6 };
      const g = h.prov.guards?.(h.id, p, move) ?? false;
      blocked ||= g; any = true;
      if (local || p.isBot) {
        feel.sparks(at, { count: g ? 7 : move.finisher ? 16 : 10, color: g ? V('blockColor') : V('sparkColor'), slot: g ? 'mechanic.melee.block-color' : 'mechanic.melee.spark-color', speed: move.finisher ? 9 : 6.5, dir: { x: Math.sin(st.yaw), z: Math.cos(st.yaw) }, spread: 1.3, size: move.finisher ? 0.09 : 0.07 });
        h.prov.feel?.(h.id, { hitStop: move.hitStop * V('hitStopScale'), dir: { x: Math.sin(st.yaw), z: Math.cos(st.yaw) }, attacker: p, blocked: g });
      }
    }
    if (!any) return;
    hitsSeen++; lastHitAt = r2(ctx.time.now);
    // hit-stop: this player's swing stops for a moment (the world does not), and on their own screen the camera shakes
    const hs = move.hitStop * V('hitStopScale');
    if (hs > 0) { holdSwing(st, hs); if (p.character) feel.freeze(p.character, hs); }
    if (local) feel.shake((move.finisher ? 0.42 : 0.26) * V('shake') * (blocked ? 0.6 : 1));
    if (local || !ctx.net.active || p.isBot) ctx.audio?.play(blocked ? V('soundBlock') : V('soundHit'), { at: p.position, optional: true, pitch: move.finisher ? 0.85 : 1 + (st.serial % 3) * 0.06 });
    if (ctx.host) applyHits(p, st.serial, moveCode(st.key), st.yaw, list);
    else ctx.net.send('melee:hit', { s: st.serial, m: moveCode(st.key), y: Math.round(st.yaw / DEG), t: list }, 'host');
  }

  function findHits(p, r) {
    const st = r.st, move = st.move; if (!move) return [];
    const origin = { x: p.position.x, z: p.position.z };
    const out = [];
    for (const prov of [playersProvider, ...targets]) {
      let list = []; try { list = prov.list(p) ?? []; } catch { list = []; }
      for (const h of arcHits(origin, st.yaw, move, list)) if (!st.hit.has(`${prov.key}:${h.id}`)) out.push({ prov, id: h.id, target: h.target, d: h.d });
    }
    return out;
  }

  // ---------------------------------------------------------------- the owner's swings
  const yawOfAim = p => {
    const ap = p.aimPoint;
    if (ap && Math.hypot(ap.x - p.position.x, ap.z - p.position.z) > 0.35) return Math.atan2(ap.x - p.position.x, ap.z - p.position.z);
    const a = p.aim; if (p.isBot && Array.isArray(a) && Math.hypot(a[0], a[2]) > 0.05) return Math.atan2(a[0], a[2]);
    return p.controller?.state?.facing ?? p.yaw ?? 0;
  };
  function moveYaw(p) {
    if (p.local && ctx.input) {
      const m = ctx.input.move, f = p.controller?.rig?.yaw ?? 0;
      if (Math.hypot(m.x, m.y) > 0.2) return Math.atan2(Math.sin(f) * m.y - Math.cos(f) * m.x, Math.cos(f) * m.y + Math.sin(f) * m.x);
    } else if (Math.hypot(p.input?.x ?? 0, p.input?.z ?? 0) > 0.2) return Math.atan2(p.input.x, p.input.z);
    return yawOfAim(p);
  }
  const queued = new Map();         // rules' own presses (melee.swing / melee.dash) for players with action ''
  function ownedStep(p, r, dt) {
    const st = r.st ??= createSwing();
    const a = p.actions ?? {}, q = queued.get(p.id) ?? {};
    const pressed = act => !!act && !!a[act]?.pressed, held = act => !!act && !!a[act]?.down;
    const input = {
      light: pressed(V('action')) || !!q.light, lightHeld: held(V('action')), heavy: pressed(V('heavyAction')) || !!q.heavy,
      dash: pressed(V('dashAction')) || !!q.dash, aimYaw: yawOfAim(p), dashYaw: moveYaw(p),
    };
    queued.delete(p.id);
    const playing = ctx.round?.phase === 'playing' && p.alive !== false && !(ctx.fair?.on && ctx.fair.isDown?.(p));
    if (!playing) { input.light = input.heavy = input.dash = input.lightHeld = false; }
    const W = weaponOf(p), mods = modsFor(p);
    const ev = stepSwing(st, input, dt, W, mods, swingOpts());
    for (const e of ev) {
      if (e.type === 'swing') {
        swingsSeen++;
        const kind = e.key === 'h' ? 'heavy' : 'swing';
        playClip(p, clipFor(p.character, e.move.clip, kind), e.move.windup + e.move.active + e.move.recover);
        if (p.local || p.isBot || !ctx.net.active) ctx.audio?.play(e.key === 'h' ? V('soundHeavy') : V('soundSwing'), { at: p.position, optional: true, pitch: 0.92 + (e.serial % 3) * 0.07 });
        p.poseExtra.ms = [e.serial, moveCode(e.key), Math.round(e.yaw / DEG)];
        lastSwing = { player: p.id, serial: e.serial, key: e.key, yaw: r2(e.yaw), t: r2(ctx.time.now), aimYaw: r2(input.aimYaw), hits: 0 };
        for (const fn of L.swing.slice()) try { fn({ player: p, key: e.key, serial: e.serial }); } catch (er) { console.error(er); }
      } else if (e.type === 'active') {
        p.poseExtra.ms = [st.serial, moveCode(st.key), Math.round(e.yaw / DEG)];
        // a step into the swing, short of whatever stands in front
        let lunge = e.move.lunge;
        if (lunge > 0) {
          for (const h of findHits(p, r)) lunge = Math.min(lunge, Math.max(0, (h.d - 1.0) * 7));
          if (lunge > 0.05) p.controller?.capsule?.push?.({ x: Math.sin(e.yaw) * lunge, y: 0, z: Math.cos(e.yaw) * lunge }, 0.1);
        }
      } else if (e.type === 'dash') {
        p.poseExtra.md = e.serial;
        playClip(p, clipFor(p.character, 'dash', 'dash'), V('dashTime') * 1.6);
        if (p.local || p.isBot || !ctx.net.active) ctx.audio?.play(V('soundDash'), { at: p.position, optional: true });
        feel.sparks({ x: p.position.x, y: 0.15, z: p.position.z }, { count: 8, color: V('trailColor'), slot: 'mechanic.melee.trail-color', speed: 3, dir: { x: -Math.sin(e.yaw), z: -Math.cos(e.yaw) }, spread: 1.6, up: 0.2, size: 0.06 });
      }
    }
    // during a dash the body moves at the dash's speed along its direction (the capsule's own velocity, owned here)
    const body = p.controller?.body;
    if (st.state === 'dash' && body) {
      const v = body.linvel(), sp = V('dashSpeed');
      body.setLinvel({ x: Math.sin(st.dashYaw) * sp, y: Math.min(v.y, 0.5), z: Math.cos(st.dashYaw) * sp }, true);
      if (ctx.time.now - (r.dustAt ?? 0) > 0.05) { r.dustAt = ctx.time.now; feel.sparks({ x: p.position.x, y: 0.1, z: p.position.z }, { count: 2, color: V('trailColor'), slot: 'mechanic.melee.trail-color', speed: 1.5, up: 0.3, size: 0.05, life: 0.3 }); }
    }
    if (ev.some(e => e.type === 'dash-end') && body) { const v = body.linvel(); body.setLinvel({ x: v.x * 0.35, y: v.y, z: v.z * 0.35 }, true); }
    p.poseExtra.dg = st.iframes > 0 ? 1 : 0;
    // while swinging: the body turns to the swing and walks slowly (the swing commits); hit-stop holds it still
    const swinging = st.state === 'windup' || st.state === 'active' || st.state === 'recover';
    if (p.input) {
      p.input.face = swinging ? st.yaw : (p.local ? undefined : p.input.face);
      const run = p.controller?.capsule?.config?.move?.runSpeed ?? 5.2;
      p.input.speed = st.stopT > 0 ? 0.01 : swinging ? run * V('moveWhileSwinging') : st.state === 'dash' ? V('dashSpeed') : undefined;
    }
    // hits: every frame of the active window, each target once a swing
    if (st.state === 'active' && playing) { const h = findHits(p, r); if (h.length) { landHits(p, r, h); if (lastSwing && lastSwing.serial === st.serial && lastSwing.player === p.id) lastSwing.hits += h.length; } }
    if (ctx.host) { const c = counts.get(p.id) ?? { swings: 0, hits: 0 }; c.swings = st.serial; counts.set(p.id, c); }
    // the trail
    r.trail ??= makeTrail();
    if (st.move && (st.state === 'active' || st.state === 'recover')) { r.trailMove = st.move; r.trailYaw = st.yaw; r.trailFade = 1; }
    if (st.state === 'active') r.trailShare = activeShare(st);
    else if (st.state !== 'recover') r.trailFade = Math.max(0, (r.trailFade ?? 0) - dt * 7);
    else r.trailFade = Math.max(0, (r.trailFade ?? 0) - dt * 3.2), r.trailShare = 1;
    if (r.trailMove) drawTrail(r.trail, p, r.trailMove, r.trailYaw, r.trailShare ?? 1, r.trailFade ?? 0);
  }

  // ---------------------------------------------------------------- another copy's player: from the pose
  function remoteStep(p, r, dt) {
    const ms = p.pose?.extra?.ms, md = p.pose?.extra?.md;
    // what this copy first sees of a player is the past (a late join): later serials are new swings and dashes
    if (r.lastSerial === undefined) r.lastSerial = Array.isArray(ms) ? ms[0] : 0;
    if (r.lastDash === undefined) r.lastDash = md ?? 0;
    if (Array.isArray(ms) && ms[0] !== r.lastSerial) {
      r.lastSerial = ms[0];
      {
        const key = moveKey(ms[1]), move = resolveMove(weaponOf(p), key, modsFor(p));
        r.rs = { key, move, yaw: (ms[2] ?? 0) * DEG, t: 0 };
        swingsSeen++;
        playClip(p, clipFor(p.character, move.clip, key === 'h' ? 'heavy' : 'swing'), move.windup + move.active + move.recover);
        ctx.audio?.play(key === 'h' ? V('soundHeavy') : V('soundSwing'), { at: p.position, optional: true });
      }
    }
    if (md !== undefined && md !== r.lastDash) {
      r.lastDash = md;
      { playClip(p, clipFor(p.character, 'dash', 'dash'), V('dashTime') * 1.6); ctx.audio?.play(V('soundDash'), { at: p.position, optional: true }); }
    }
    r.trail ??= makeTrail();
    if (r.rs) {
      const s = r.rs; s.t += dt;
      if (Array.isArray(ms) && ms[0] === r.lastSerial) s.yaw = (ms[2] ?? 0) * DEG;
      const a = s.t - s.move.windup;
      if (a >= 0) { r.trailMove = s.move; r.trailYaw = s.yaw; r.trailShare = clamp(a / s.move.active, 0, 1); r.trailFade = a < s.move.active ? 1 : Math.max(0, 1 - (a - s.move.active) * 3.2); }
      if (a > s.move.active + s.move.recover) r.rs = null;
    } else r.trailFade = Math.max(0, (r.trailFade ?? 0) - dt * 7);
    if (r.trailMove) drawTrail(r.trail, p, r.trailMove, r.trailYaw, r.trailShare ?? 1, r.trailFade ?? 0);
    // the host: the swings it has seen from this player
    if (ctx.host && Array.isArray(ms)) { const c = counts.get(p.id) ?? { swings: 0, hits: 0 }; c.swings = Math.max(c.swings, ms[0]); counts.set(p.id, c); }
  }

  const sv = new THREE.Vector3();
  const screen = (x, y, z) => { if (!ctx.camera) return null; sv.set(x, y, z).project(ctx.camera); return { x: r2((sv.x * 0.5 + 0.5) * (globalThis.innerWidth ?? 0)), y: r2((-sv.y * 0.5 + 0.5) * (globalThis.innerHeight ?? 0)), front: sv.z > -1 && sv.z < 1 }; };

  const api = {
    id, params: P,
    /** An aimed mechanic (CONTRACT §6d): the reticle shows in third and first person, and the body turns to the aim. */
    aimed: true,
    weapons: WEAPONS,
    slotChanged,
    /** The weapon a player holds now (every copy, from the shared state): {id, name, kind, rarity, color, combo, heavy, dashStrike}. */
    weaponOf,
    /** Host: give a player a weapon (an id or an index into weapons), of a rarity (0-3; default the table's). → true when it changed. */
    setWeapon(p, w, rarity = null) {
      if (!ctx.host || !S || !p) return false;
      const i = typeof w === 'number' ? w : WEAPONS.findIndex(x => x.id === w);
      if (!(i >= 0 && i < WEAPONS.length)) return false;
      S.w = { ...S.w, [p.id]: i };
      S.r = { ...(S.r ?? {}), [p.id]: Number.isInteger(rarity) ? Math.max(0, Math.min(3, rarity)) : WEAPONS[i].rarity };
      return true;
    },
    /** A weapon's model (its slot's, its prop's, or the kit's stand-in): for drops on the ground (kit/mechanics/loot). */
    makeWeapon: index => modelFor(WEAPONS[Math.max(0, Math.min(WEAPONS.length - 1, index | 0))]),
    /** The rarity colours (common, rare, epic, legendary). */
    rarityColor: r => { const c = V('rarityColors'); return (Array.isArray(c) ? c : D.rarityColors)[Math.max(0, Math.min(3, r | 0))] ?? '#ffffff'; },
    /** A player is in a dash's invulnerable frames now (the host asks before an enemy's hit counts). */
    dodging(p) {
      if (!p) return false;
      const r = R.get(p.id);
      if (p.owned) return (r?.st?.iframes ?? 0) > 0;
      return (p.pose?.extra?.dg ?? 0) === 1;
    },
    /** rules.js, for a player this copy owns (with action ''): press a swing ('light' | 'heavy') or a dash. */
    swing(p, kind = 'light') { if (p?.owned) queued.set(p.id, { ...(queued.get(p.id) ?? {}), [kind === 'heavy' ? 'heavy' : 'light']: true }); },
    dash(p) { if (p?.owned) queued.set(p.id, { ...(queued.get(p.id) ?? {}), dash: true }); },
    /** What a player's swing is doing now (every copy that owns them): 'idle' | 'windup' | 'active' | 'recover' | 'dash'. */
    stateOf: p => R.get(p?.id)?.st?.state ?? 'idle',
    /** This copy's screen shake (local feel). */
    shake: a => feel.shake(a),
    /** Host: {attacker, target, kind: 'enemy' | 'boss' | 'player', damage, move, blocked, killed} for each hit that counted. */
    onHit(fn) { L.hit.push(fn); return unsub(L.hit, fn); },
    /** The copy that owns the player: {player, key, serial} as a swing starts. */
    onSwing(fn) { L.swing.push(fn); return unsub(L.swing, fn); },
    /** QA (window.__game.controls()): the local player's weapon and last swing on their own screen. */
    get stats() {
      const me = ctx.me, r = me ? R.get(me.id) : null, W = me ? weaponOf(me) : WEAPONS[startIndex];
      if (ctx.camera) ctx.camera.updateMatrixWorld();
      let ls = null;
      if (lastSwing && me && lastSwing.player === me.id) {
        const mv = resolveMove(W, lastSwing.key, modsFor(me)), d = mv.reach * 0.62;
        const at = { x: r2(me.position.x + Math.sin(lastSwing.yaw) * d), z: r2(me.position.z + Math.cos(lastSwing.yaw) * d) };
        ls = { ...lastSwing, reach: mv.reach, arc: mv.arc, at, screen: screen(at.x, 1, at.z), aimScreen: me.aimPoint ? screen(me.aimPoint.x, me.aimPoint.y ?? 0, me.aimPoint.z) : null, playerScreen: screen(me.position.x, 1, me.position.z) };
      }
      const players = [...counts.entries()].map(([pid, c]) => ({ id: pid, swings: c.swings, hits: c.hits, weapon: ctx.players?.get?.(pid) ? weaponOf(ctx.players.get(pid)).id : null }));
      return {
        weapon: { id: W.id, name: W.name, kind: W.kind, rarity: W.rarity, rarityName: RARITIES[W.rarity] }, clips: { swing: clipInfo.swing, fallback: clipInfo.fallback },
        state: r?.st?.state ?? 'idle', step: r?.st?.step ?? 0, swings: r?.st?.serial ?? 0, dashes: r?.st?.dashSerial ?? 0, iframes: r2(r?.st?.iframes ?? 0), dashCd: r2(r?.st?.dashCd ?? 0),
        swingsSeen, hitsSeen, lastHitAt, lastSwing: ls, trail: !!r?.trail?.g?.visible, players,
        controls: { swing: V('action'), heavy: V('heavyAction'), dash: V('dashAction') },
      };
    },
    reset() {
      for (const r of R.values()) { if (r.st) Object.assign(r.st, createSwing()); r.rs = null; r.trailFade = 0; r.lastSerial = undefined; r.lastDash = undefined; if (r.trail) r.trail.g.visible = false; }
      hostSeen.clear(); counts.clear(); lastSwing = null; queued.clear(); feel.reset();
    },
    update(dt) {
      if (!S) {
        if (!(ctx.shared && ctx.players && ctx.me)) return;
        S = ctx.shared.register('melee', { w: {}, r: {}, n: {} });
      }
      for (const p of ctx.players.list()) {
        let r = R.get(p.id); if (!r) { r = {}; R.set(p.id, r); }
        // Space dashes instead of jumping (dashAction "jump"): the players this copy owns jump at 0 m/s
        if (p.owned && V('dashAction') === 'jump' && p.controller?.capsule?.config?.jump && r.jumpWas === undefined) { r.jumpWas = p.controller.capsule.config.jump.velocity; p.controller.capsule.config.jump.velocity = 0; }
        holdWeapon(p, r);
        if (p.owned) ownedStep(p, r, dt); else remoteStep(p, r, dt);
      }
      for (const [pid, r] of R) if (!ctx.players.get(pid)) { r.trail?.g.removeFromParent(); r.weaponObj?.removeFromParent(); R.delete(pid); }
      if (ctx.host) { const n = {}; for (const [pid, c] of counts) n[pid] = [c.swings, c.hits]; S.n = n; }
    },
    /** `melee:hit` from a player's copy to the host: {s: swing serial, m: move code, y: yaw (degrees), t: [[provider, id]]}. */
    event(name, data, from) {
      if (name !== 'hit' || !ctx.host || !S || !data) return;
      const p = ctx.players.get(from); if (!p || p.isBot || (ctx.net.active && from !== p.id)) return;
      if (!Number.isFinite(data.s) || !Number.isFinite(data.m) || !Array.isArray(data.t)) return;
      applyHits(p, data.s, data.m, (Number(data.y) || 0) * DEG, data.t.filter(x => Array.isArray(x) && x.length === 2));
    },
    dispose() { root.removeFromParent(); for (const r of R.values()) r.weaponObj?.removeFromParent(); },
  };
  return api;
}

export { DEFAULT_WEAPONS, MOVE_DEFAULTS, UPGRADES, modsOf };

// ---------------------------------------------------------------------------------------------------------------------
// The part's manifest (tools/catalog.mjs MANIFEST lists the fields): what `create` composes and refuses by, what the
// catalog tells a pitch, the handlers and traps of the rules.js stub, and verify check 15's sign of life. The tools
// read it in Node; nothing in play does.
// ---------------------------------------------------------------------------------------------------------------------
export const manifest = {
  id, examples, params,
  describe: 'Swords, axes and fists: combo chains (windup, active, recover), arc and reach, damage, knockback and hit-stop; a dash with invulnerable frames; slash trails',
  rank: 110,
  needs: { parts: [], world: [] },
  uses: ['waves', 'boss', 'health', 'loot'],
  // its things (kit/assets/items.js): the weapon table, one json slot a page adds to and edits
  items: [WEAPON_ITEM],
  // the inputs it reads by itself, and the right hand (the weapon model). research/open-builder/findings/
  // x3-narrow-controller.md lists what it reaches for inside the player controller (the dash and the lunge).
  owns: p => [
    { res: 'player.socket.hand_r', why: 'the weapon is held on the hand_r socket', free: 'a game with melee holds nothing else in the right hand' },
    ...[['action', 'swings the combo', 'melee.swing(p)'], ['heavyAction', 'is the heavy attack', 'melee.swing(p, \'heavy\')'], ['dashAction', 'dashes', 'melee.dash(p)']]
      .filter(([k]) => p[k]).map(([k, does, call]) => ({ res: `input.${p[k]}`, why: `${p[k]} ${does} (params.${k})`, free: `set melee params.${k} to another input, or to "" and call ${call} from rules.js` })),
  ],
  state: { key: 'melee', fields: { w: '{ playerId: [weapon index, rarity] }', r: 'the last reported hit per player', n: '{ playerId: [swings, hits] }' } },
  events: [
    { name: 'onHit', on: 'host', args: '{ attacker, target, kind: \'enemy\' | \'boss\' | \'player\', damage, move, blocked, killed }', when: 'a swing hit something (each target once a swing)' },
    { name: 'onSwing', on: 'the copy that owns the player', args: '{ player, key, serial }', when: 'a swing started' },
  ],
  sync: { owner: 'copy', how: 'the copy that owns a player runs their swings and finds the hits; the host checks each hit and applies the damage' },
  note: [
    'Nothing to wire: primary swings the combo, secondary is the heavy attack, jump (Space) dashes, and bots fight with it by themselves.',
    'Swings hurt the waves mechanic\'s enemies, the boss, and other players unless the game is co-op (hitPlayers "auto").',
    'With dashAction "jump" the players cannot jump: move the dash to another input in a game that needs jumping.',
  ],
  stub: {
    as: 'melee',
    worked: 'melee.onHit(h => { if (h.kind === \'player\' && h.attacker) h.attacker.score += 1; });',
    traps: [
      'a kill of an enemy already scores the waves mechanic\'s killPoints: score only what is yours in onHit',
      'hit-stop and camera shake are this copy\'s own feel: never pause or slow the shared world for a hit',
    ],
  },
  signs: {
    sample: sh => { if (!sh.melee) return null; let sw = 0, hi = 0; for (const x of Object.values(sh.melee.n ?? {})) { sw += x?.[0] ?? 0; hi += x?.[1] ?? 0; } return { melee: [sw, hi] }; },
    judge: v => {
      const a = v.action, sw = v.aim?.melee ? v.aim : null;
      if (sw?.hit) v.add('a swing hurts an enemy', 'ok', 'shared.waves.e hp and w[1] kills, while the player swung', `the player walked up to an enemy, aimed and swung: ${sw.kill ? 'it died' : `its hit points went ${sw.hpBefore} → ${sw.hpAfter}`}`);
      if (a.hits > 0) v.add('swings land', 'ok', 'shared.melee.n (swings, hits per player)', `${a.hits} hits from ${a.swings} swings on the busiest page`);
      else if (!sw?.hit) v.add('swings land', a.swings > 0 || sw?.measured ? 'dead' : 'unmeasured', 'shared.melee.n (swings, hits per player)', `${a.swings} swings and no hit on any page (${v.names})${sw ? `; the player's own swing: ${sw.why}` : ''}`,
        'check the melee mechanic\'s reach and arc against the enemies, that waves hittable is on, and that rules.bot (or the kit\'s melee bots) walks up and swings');
    },
  },
};
