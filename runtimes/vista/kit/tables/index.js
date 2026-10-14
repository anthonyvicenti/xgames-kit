// gf-vista data tables: `spec.vista` (research/super-scenic/THIN_E2E.md, interface I1). The core's fishing runs on
// two tables (core/src/game/FishTable.js FISH, Gear.js UPGRADES); a game gives its own through this block and the game
// bridge (kit/game.js) puts them into the core in place. Pure: Node imports it (create, the pitch checker, tests).
//
//   spec.vista = {
//     species: { <id>: { name, habitat: [...], minKg, maxKg, value, ... } },   // what bites, where, what it's worth
//     gear:    { <id>: { name, kind, price, ... } },                              // what the shop sells
//     vendors: { buyer: { name, greeting }, shop: { name, greeting } },         // who buys the catch, who sells gear
//     economy: { startMoney, fuelPrice },
//     start:   'pier' | 'pier-head' | 'beach' | 'boat'                                       // where players begin
//   }
// Every value is a slot (PLAN R1-R5): create fills the game's config from fill(), and Studio edits it there.
//
// species fields (all but name, habitat, minKg, maxKg and value are optional):
//   name           what the player reads (catch card, cooler, the buyer's board)
//   habitat        where it bites: an array of HABITATS (each weight 1), or { <habitat>: weight 0..1 }
//   habitatWeight  added: { <habitat>: 0..1 } weights for the array form (the defaults carry the core's own)
//   minKg, maxKg   weight range (most fish are small: the core skews toward minKg)
//   value          money per kg at the buyer (a trophy near maxKg fetches up to 25 % more)
//   look           added: which of the core's fish models draws it (LOOKS); left out, the id when it is one
//   fight 0..1     how hard it pulls        stamina (s)  how long it takes to tire
//   time           when it bites best: TIMES           rarity 0..1  how often it bites against the others
//   lw [a, b]      length-weight relation W(g) = a * L(cm)^b; left out, the look's own
// gear fields: name, kind (KINDS), price (0: the starting piece of its kind, owned from the start), and the kind's
//   stat (KINDS[kind].stat: lineKg, reelSpeed, castM, holdKg, fuelL, speedMul; finder and lights need none).
//   Pieces of one kind are levels, cheapest first; a kind with no price-0 piece starts at the core's own base.
// vendors: added field `sign` (the words painted on the stall; left out, the name in capitals).
import { FISH } from '../../core/src/game/FishTable.js';
import { UPGRADES, FUEL_PRICE } from '../../core/src/game/Gear.js';

export const VERSION = '0.1.0-thin';

/** Where fish bite (core/src/game/Bites.js habitatAt): sand under 3 m, the reef, the pier's piles, open water 3-20 m, offshore. */
export const HABITATS = ['shallows', 'reef', 'pier', 'bay', 'deep'];
/** When a species bites best (Bites.js activity). */
export const TIMES = ['day', 'dawnDusk', 'night', 'any'];
/** The fish the core can draw (world/fish/FishSpecies.js models with a catch pose): a species' `look`. */
export const LOOKS = ['silverside', 'mullet', 'needlefish', 'sergeant', 'grunt', 'yellowtail', 'chromis', 'tang', 'wrasse', 'parrot', 'angel', 'jack', 'barracuda', 'grouper', 'redSnapper', 'tuna', 'mahi', 'tarpon'];
/** Gear kinds the core reads (Gear.js gearStats), the stat each sets, its starting value, and the core's track name. */
export const KINDS = {
  line: { stat: 'lineKg', base: 7, track: 'line', why: 'breaking strain (kg) in the fight' },
  reel: { stat: 'reelSpeed', base: 1.1, track: 'reel', why: 'how fast the line comes in' },
  rod: { stat: 'castM', base: 22, track: 'rod', why: 'longest cast (m)' },
  hold: { stat: 'holdKg', base: 30, track: 'hold', why: 'how many kg of fish fit in the cooler' },
  tank: { stat: 'fuelL', base: 40, track: 'fuel', why: 'the boat\'s fuel tank (litres)' },
  engine: { stat: 'speedMul', base: 1, track: 'engine', why: 'boat speed (x the base)' },
  finder: { stat: 'finder', base: false, track: 'fishFinder', flag: true, why: 'depth and fish shown aboard' },
  lights: { stat: 'deckLights', base: false, track: 'lights', flag: true, why: 'deck floodlights for night fishing' },
};
export const STARTS = ['pier', 'pier-head', 'beach', 'boat'];
const TOP = ['species', 'gear', 'vendors', 'economy', 'start'];

// ---- the defaults: the core's own tables, copied once at load (the bridge changes the core's objects in place later)
// Gear under generic names (the core's own labels are upstream's writing); species keep their common names (real fish).
const GEAR_NAMES = {
  line: ['Light line', 'Medium line', 'Heavy braid', 'Extra-heavy braid'],
  reel: ['Basic reel', 'Smooth reel', 'Power reel'],
  rod: ['Short rod', 'Graphite rod', 'Surf rod'],
  hold: ['Cooler', 'Ice chest', 'Insulated fish hold'],
  tank: ['Small fuel tank', 'Medium fuel tank', 'Large fuel tank'],
  engine: ['Old engine', 'Rebuilt engine', 'Turbo engine'],
  finder: [null, 'Fish finder'],
  lights: [null, 'Deck floodlights'],
};
function coreSpecies() {
  const out = {};
  for (const [id, f] of Object.entries(FISH)) {
    const w = Object.entries(f.habitat).sort((a, b) => b[1] - a[1]);
    out[id] = {
      name: f.name, habitat: w.map(([k]) => k), habitatWeight: Object.fromEntries(w),
      minKg: f.kg[0], maxKg: f.kg[1], value: f.price, look: f.model,
      fight: f.fight, stamina: f.stamina, time: f.time, rarity: f.rarity, lw: [...f.lw],
    };
  }
  return out;
}
function coreGear() {
  const out = {};
  for (const [kind, k] of Object.entries(KINDS)) {
    UPGRADES[k.track].levels.forEach((lv, i) => {
      const name = GEAR_NAMES[kind][i];
      if (!name) return;   // the "none" starting level of finder and lights: no piece, the base applies
      const item = { name, kind, price: lv.cost };
      if (!k.flag) item[k.stat] = lv[k.stat];
      out[`${kind}-${i}`] = item;
    });
  }
  return out;
}

/** The defaults: the core's own tables (core/src/game/FishTable.js, Gear.js) under generic names. */
export const DEFAULTS = deepFreeze({
  species: coreSpecies(),
  gear: coreGear(),
  vendors: {
    buyer: { name: 'Fish buyer', greeting: 'Let\'s see what you caught. Fair prices, paid in cash.', sign: 'FRESH FISH' },
    shop: { name: 'Tackle shop', greeting: 'Line, reels, a bigger cooler, fuel. What do you need?', sign: 'TACKLE SHOP' },
  },
  economy: { startMoney: 0, fuelPrice: FUEL_PRICE },
  start: 'pier',
});

// ---- check
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNum = v => typeof v === 'number' && Number.isFinite(v);
const str = v => typeof v === 'string' && v.trim().length > 0;
const list = a => a.map(x => `"${x}"`).join(', ');

/** Problems with a spec's vista block, as plain sentences ([] when fine): create refuses the spec when there are any. */
export function check(vista = {}) {
  const p = [];
  if (vista === undefined || vista === null) return p;
  if (!isObj(vista)) return ['The vista block must be an object of tables (species, gear, vendors, economy, start).'];
  if (vista.species !== undefined) checkSpecies(vista.species, p);
  if (vista.gear !== undefined) checkGear(vista.gear, p);
  if (vista.vendors !== undefined) {
    if (!isObj(vista.vendors)) p.push('vendors must be an object with a buyer and a shop.');
    else for (const [role, v] of Object.entries(vista.vendors)) {
      if (role !== 'buyer' && role !== 'shop') { p.push(`vendors has "${role}", but the core has only a buyer (who buys the catch) and a shop (who sells gear).`); continue; }
      if (!isObj(v)) { p.push(`vendors.${role} must be an object with a name and a greeting.`); continue; }
      for (const k of ['name', 'greeting', 'sign']) if (v[k] !== undefined && typeof v[k] !== 'string') p.push(`vendors.${role}.${k} must be words (a string).`);
      if (v.name !== undefined && !str(v.name)) p.push(`vendors.${role}.name is empty: the ${role} needs a name players can read.`);
      if (typeof v.name === 'string' && v.name.length > 40) p.push(`vendors.${role}.name is ${v.name.length} characters; keep it to 40 so it fits the stall's sign and the panel.`);
      if (typeof v.sign === 'string' && v.sign.length > 24) p.push(`vendors.${role}.sign is ${v.sign.length} characters; the painted sign holds 24.`);
    }
  }
  if (vista.economy !== undefined) {
    if (!isObj(vista.economy)) p.push('economy must be an object (startMoney, fuelPrice).');
    else for (const k of ['startMoney', 'fuelPrice']) {
      const v = vista.economy[k];
      if (v === undefined) continue;
      if (!isNum(v)) p.push(`economy.${k} must be a number.`);
      else if (v < 0) p.push(`economy.${k} is ${v}; it can't be negative.`);
    }
  }
  if (vista.start !== undefined && !STARTS.includes(vista.start)) p.push(`start is "${vista.start}", but players can only begin on the ${STARTS.join(', the ')} (${list(STARTS)}).`);
  for (const k of Object.keys(vista)) if (!TOP.includes(k) && !['boats', 'spots'].includes(k)) p.push(`The vista block has "${k}", which the core doesn't read (it reads ${list(TOP)}).`);
  return p;
}

function checkSpecies(species, p) {
  if (!isObj(species)) { p.push('species must be an object keyed by species id.'); return; }
  const ids = Object.keys(species);
  if (!ids.length) { p.push('species is empty: nothing would ever bite.'); return; }
  for (const id of ids) {
    const s = species[id], at = `species "${id}"`;
    if (!isObj(s)) { p.push(`${at} must be an object.`); continue; }
    if (!str(s.name)) p.push(`${at} has no name for players to read.`);
    const hab = Array.isArray(s.habitat) ? s.habitat : isObj(s.habitat) ? Object.keys(s.habitat) : null;
    if (!hab || !hab.length) p.push(`${at} needs a habitat: where it bites (${list(HABITATS)}).`);
    else for (const h of hab) if (!HABITATS.includes(h)) p.push(`${at} lives in "${h}", which the core doesn't know; it has ${list(HABITATS)}.`);
    const weights = isObj(s.habitat) ? s.habitat : s.habitatWeight;
    if (weights !== undefined) {
      if (!isObj(weights)) p.push(`${at}.habitatWeight must be an object of weights.`);
      else for (const [h, w] of Object.entries(weights)) {
        if (!HABITATS.includes(h)) p.push(`${at} has a weight for "${h}", which the core doesn't know.`);
        else if (!isNum(w) || w < 0 || w > 1) p.push(`${at}'s weight for ${h} must be a number from 0 to 1.`);
        else if (Array.isArray(s.habitat) && !s.habitat.includes(h)) p.push(`${at} has a weight for ${h} but ${h} isn't in its habitat.`);
      }
    }
    if (!isNum(s.minKg) || s.minKg <= 0) p.push(`${at}.minKg must be a weight above 0 kg.`);
    if (!isNum(s.maxKg) || s.maxKg <= 0) p.push(`${at}.maxKg must be a weight above 0 kg.`);
    else if (isNum(s.minKg) && s.maxKg < s.minKg) p.push(`${at} has maxKg ${s.maxKg} below minKg ${s.minKg}.`);
    if (isNum(s.maxKg) && s.maxKg > 200) p.push(`${at}.maxKg is ${s.maxKg} kg; the fight can't land anything over 200 kg.`);
    if (!isNum(s.value)) p.push(`${at}.value (money per kg at the buyer) must be a number.`);
    else if (s.value < 0) p.push(`${at}.value is ${s.value}; a price can't be negative.`);
    const look = s.look ?? (LOOKS.includes(id) ? id : undefined);
    if (look === undefined) p.push(`${at} has no look the core can draw: give it a "look", one of ${list(LOOKS)}.`);
    else if (!LOOKS.includes(look)) p.push(`${at} has the look "${look}", which the core can't draw; it draws ${list(LOOKS)}.`);
    for (const [k, lo, hi] of [['fight', 0, 1], ['rarity', 0, 1]]) if (s[k] !== undefined && (!isNum(s[k]) || s[k] < lo || s[k] > hi)) p.push(`${at}.${k} must be a number from ${lo} to ${hi}.`);
    if (s.rarity === 0) p.push(`${at}.rarity is 0, so it would never bite.`);
    if (s.stamina !== undefined && (!isNum(s.stamina) || s.stamina <= 0 || s.stamina > 120)) p.push(`${at}.stamina must be seconds above 0 (at most 120).`);
    if (s.time !== undefined && !TIMES.includes(s.time)) p.push(`${at} bites at "${s.time}", which the core doesn't know; it has ${list(TIMES)}.`);
    if (s.lw !== undefined && !(Array.isArray(s.lw) && s.lw.length === 2 && s.lw.every(v => isNum(v) && v > 0))) p.push(`${at}.lw must be two positive numbers [a, b] (weight in g = a x length in cm ^ b).`);
  }
}

function checkGear(gear, p) {
  if (!isObj(gear)) { p.push('gear must be an object keyed by gear id.'); return; }
  const starters = {};
  for (const [id, g] of Object.entries(gear)) {
    const at = `gear "${id}"`;
    if (id === 'fuel') p.push('gear can\'t use the id "fuel": the shop sells fuel itself (economy.fuelPrice).');
    if (!isObj(g)) { p.push(`${at} must be an object.`); continue; }
    if (!str(g.name)) p.push(`${at} has no name for players to read.`);
    const k = KINDS[g.kind];
    if (!k) { p.push(`${at} is of kind "${g.kind}", which the core can't use; it has ${list(Object.keys(KINDS))}.`); continue; }
    if (!isNum(g.price)) p.push(`${at}.price must be a number.`);
    else if (g.price < 0) p.push(`${at}.price is ${g.price}; a price can't be negative.`);
    else if (g.price === 0) (starters[g.kind] ??= []).push(id);
    if (!k.flag) {
      const v = g[k.stat];
      if (!isNum(v) || v <= 0) p.push(`${at} (a ${g.kind}) needs ${k.stat}: ${k.why}, a number above 0.`);
    }
  }
  for (const [kind, ids] of Object.entries(starters)) if (ids.length > 1) p.push(`gear has ${ids.length} free ${kind} pieces (${list(ids)}); a kind starts with at most one.`);
}

// ---- fill
/** The full tables a game runs: the defaults with the spec's values over them. species and gear given by a spec replace
 *  the defaults' whole (a game's fish are its fish); vendors and economy merge key by key; every species and gear piece
 *  comes out complete (habitatWeight, look, fight, stamina, time, rarity, lw filled). */
export function fill(vista = {}) {
  const v = isObj(vista) ? structuredClone(vista) : {};
  const d = structuredClone(DEFAULTS);
  const out = {
    species: isObj(v.species) && Object.keys(v.species).length ? v.species : d.species,
    gear: isObj(v.gear) ? v.gear : d.gear,
    vendors: {
      buyer: { ...d.vendors.buyer, ...(isObj(v.vendors?.buyer) ? v.vendors.buyer : {}) },
      shop: { ...d.vendors.shop, ...(isObj(v.vendors?.shop) ? v.vendors.shop : {}) },
    },
    economy: { ...d.economy, ...(isObj(v.economy) ? v.economy : {}) },
    start: STARTS.includes(v.start) ? v.start : d.start,
  };
  for (const role of ['buyer', 'shop']) {
    const r = out.vendors[role];
    if (isObj(v.vendors?.[role]) && v.vendors[role].name && v.vendors[role].sign === undefined) r.sign = r.name.toUpperCase();
  }
  for (const k of Object.keys(v)) if (!(k in out)) out[k] = v[k];   // boats, spots: carried for later waves
  for (const [id, s] of Object.entries(out.species)) out.species[id] = fillSpecies(id, s);
  return out;
}

function fillSpecies(id, s) {
  const look = s.look ?? (LOOKS.includes(id) ? id : 'grunt');
  const base = FISH_SNAPSHOT[look] ?? FISH_SNAPSHOT.grunt;
  let habitat, weight;
  if (isObj(s.habitat)) { habitat = Object.keys(s.habitat); weight = { ...s.habitat }; }
  else { habitat = [...(s.habitat ?? [])]; weight = Object.fromEntries(habitat.map(h => [h, isObj(s.habitatWeight) && isNum(s.habitatWeight[h]) ? s.habitatWeight[h] : 1])); }
  return {
    ...s, habitat, habitatWeight: weight, look,
    fight: s.fight ?? 0.3, stamina: s.stamina ?? 5, time: s.time ?? 'any', rarity: s.rarity ?? 0.5, lw: s.lw ?? [...base.lw],
  };
}
const FISH_SNAPSHOT = Object.fromEntries(Object.entries(FISH).map(([k, f]) => [k, { lw: [...f.lw] }]));

/** The core's species table entry for a filled species (core/src/game/FishTable.js's shape). */
export function toCoreSpecies(s) {
  return { name: s.name, sci: '', lw: [...s.lw], model: s.look, habitat: { ...s.habitatWeight }, kg: [s.minKg, s.maxKg], price: s.value, fight: s.fight, stamina: s.stamina, time: s.time, rarity: s.rarity };
}

/** The core's upgrade tracks (Gear.js UPGRADES's shape) for filled tables: each kind's pieces as levels, cheapest first,
 *  level 0 the free piece or the kind's base. Levels carry `id` (the gear id; null for a base). */
export function toCoreUpgrades(gear) {
  const out = {};
  for (const [kind, k] of Object.entries(KINDS)) {
    const pieces = Object.entries(gear).filter(([, g]) => g.kind === kind).sort((a, b) => a[1].price - b[1].price);
    const stat = g => (k.flag ? { [k.stat]: true } : { [k.stat]: g[k.stat] });
    const levels = [];
    const free = pieces.find(([, g]) => g.price === 0);
    levels.push(free ? { id: free[0], cost: 0, label: free[1].name, ...stat(free[1]) } : { id: null, cost: 0, label: '', [k.stat]: k.base });
    for (const [id, g] of pieces) if (g.price > 0) levels.push({ id, cost: g.price, label: g.name, ...stat(g) });
    out[k.track] = { name: kind, levels };
  }
  return out;
}

function deepFreeze(o) { if (o && typeof o === 'object') { Object.freeze(o); for (const v of Object.values(o)) deepFreeze(v); } return o; }
