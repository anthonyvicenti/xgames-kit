// The vista runtime's seam to the shared system: what a spec may name on the vista runtime and how it becomes a game's
// config, with every value a slot. Pure and Node-safe (create, the
// catalog, the slot declarations and the tests import it; it touches no DOM and no GPU), and vendored into a game as
// gf/vista/kit/config.js, where the boot reads the same places.
//
//   templates            the worlds a vista spec may name: islands (1 to 5 generated islands; the only one)
//   presets              the looks (kit/look.js PRESETS) with a label and a sentence each
//   CAMERAS              first person only
//   PLACES               where players start: pier, beach, boat; one seat each for up to four players
//   lookConfig(spec)     config/look.json: the preset's values, then the spec's own over them
//   worldConfig(spec)    config/world.json: the template, the islands (each from its seed and words) and the start places
//   specIslands(spec)    the islands a spec asks for: world.islands, or one island of the game's own (its seed from
//                        world.seed or the title and prompt); never the reference island
//   islandLook(world, i) an island's look words as kit/look.js values (null: the game's look)
//   bodiesConfig(...)    config/characters.json → vista: the bodies friends see, one a seat, and the shared clips
//   slotsFor(cfg)        the slot declarations: the look values, the start place, each seat's body, the clips, the
//                        seat colours, every value of the data tables (config/game.json → vista), and every model,
//                        picture and data file the core reads from its public folder (coreSlots)
//   placeOf(world, start, seat, island?)   where a seat stands at a start place: {x, z, yaw} (the core's walker yaw); with
//                        islands, the island's own seats
//   seatsOf(recipe)      a place's start seats (kit/world/places.js placeSeats, plus the beach): every place its own
//   islandsConfig(list)  config/world.json → islands: [{ name, seed, words, places }] (the recipe is made again from the
//                        seed and words, the same on every copy); islandRecipes(world) the islands to sail between
import { PRESETS, DEFAULT_PRESET, SEAS, LOOKS } from './look.js';
import { CORE_FILES } from './core-files.js';
import { placeRecipe, placeSeats, placeLook, seedHash, WORDS, knownWord } from './world/places.js';

export const RUNTIME = 'vista';
export const templates = ['islands'];
export const TEMPLATE_INFO = {
  islands: { label: 'Islands', kind: 'outdoor', describe: 'one to five islands in the open sea, each generated from a seed and a few words (world.islands: size, shape, coast, coves, a river mouth, cliffs, peaks, beach, sand, rock, plants, reef, water, a pier, dock or jetty, a village or none, the time of day and the weather): a harbour with its pier and a moored boat, a fishing village or none, a reef, open sea where a whale passes. A player walks, swims, dives, takes the boat out, fishes from the pier, the beach or the deck, and sails to the next island' },
};
/** The most islands a game sails between (kit/islands.js MAX_ISLANDS). */
export const MAX_ISLANDS = 5;
export const CAMERAS = ['first'];

const LABELS = { 'clear-morning': 'Clear morning', 'bright-noon': 'Bright noon', 'golden-hour': 'Golden hour', 'sunset-glow': 'Sunset glow', 'moonlit-night': 'Moonlit night', 'storm-swell': 'Storm swell' };
/** The looks a spec may name: kit/look.js PRESETS, each with its words. */
export const presets = Object.fromEntries(Object.entries(PRESETS).map(([id, p]) => [id, { label: LABELS[id] ?? id, describe: p.why, hour: p.hour, sea: p.sea, exposure: p.exposure, ...(p.clouds !== undefined ? { clouds: p.clouds } : {}) }]));
export { DEFAULT_PRESET };

// The core's world (core/src/world/WorldLayout.js): the pier head is x 48..62, z 33..40 (its middle 55, 36.5), the boat
// is moored on its east side at x 64.5; the bay's beach runs along z ≈ -42 to -60. Walker yaw: forward is
// (-sin yaw, 0, -cos yaw), so yaw π faces +z (the sea, south).
const ring = (cx, cz, offsets, face) => offsets.map(([dx, dz]) => ({ x: cx + dx, z: cz + dz, yaw: face(cx + dx, cz + dz) }));
const facing = (tx, tz) => (x, z) => Math.atan2(-(tx - x), -(tz - z));
export const PLACES = {
  // the pier's foot: seat 1 at the island's own opening view (the core's WORLD.start: the boardwalk down to the pier
  // gate, the beach hut and boat, a stall, the surf); friends a few metres ahead on the boardwalk, facing seat 1, so each
  // sees the others the moment the round starts. Before 2026-10-12 a game started on the pier head looking at open sea
  // (the plainest view on the island; the creator: "visually this is much much worse than the original")
  pier: { label: 'The pier\'s foot', describe: 'on the beach where the boardwalk runs down to the pier, looking out along it to the sea; friends a few steps ahead, facing you', seats: [{ x: 53.6, z: -77, yaw: Math.PI }, ...[[55.6, -72], [51.6, -72], [53.6, -70]].map(([x, z]) => ({ x, z, yaw: Math.atan2(-(53.6 - x), -(-77 - z)) }))] },
  'pier-head': { label: 'The pier head', describe: 'on the T-shaped head at the end of the pier, everyone facing its middle', seats: ring(55, 36.5, [[0, -1.8], [0, 1.8], [-1.8, 0], [1.8, 0]], facing(55, 36.5)) },
  beach: { label: 'The beach', describe: 'on the sand of the bay, in a row facing the sea', seats: [-3, -1, 1, 3].map(dx => ({ x: 18 + dx, z: -60, yaw: Math.PI })) },
  boat: { label: 'Beside the boat', describe: 'on the pier head beside the moored boat (E boards it), facing the boat', seats: [[0, -1.6], [0, 0], [0, 1.6], [-1.6, 0]].map(([dx, dz]) => ({ x: 61.2 + dx, z: 36.5 + dz, yaw: -Math.PI / 2 })) },
};
export const START_DEFAULT = 'pier';

const r3 = v => Math.round(v * 1000) / 1000;
const clone = v => JSON.parse(JSON.stringify(v));

/**
 * config/look.json: the named preset's values (hour, sea, exposure, clouds), then the first island's time and weather
 * words over them (a place asked for at night is seen at night).
 */
export function lookConfig(spec = {}) {
  const id = spec?.look?.preset ?? DEFAULT_PRESET;
  const p = PRESETS[id];
  if (!p) throw new Error(`look.preset "${id}" is not a vista look (${Object.keys(PRESETS).join(', ')})`);
  const out = { preset: id, hour: p.hour, sea: p.sea, exposure: p.exposure };
  if (p.clouds !== undefined) out.clouds = p.clouds;
  const first = specIslands(spec)[0];
  const words = placeLook(placeRecipe(first.seed, first.words));
  if (words) Object.assign(out, words);
  return out;
}

/** A game's own seed when the spec names none: from its title and prompt (two games, two places). */
export const seedOf = spec => seedHash(`${spec?.title ?? ''}|${spec?.prompt ?? ''}`, 'vista-place') % 2147483647;

/**
 * The islands a spec asks for (world.islands: 1 to 5 of { name, seed?, words? }), each with its seed (left out: the
 * game's own, one apart per island) and its words checked against kit/world/places.js WORDS. No islands listed: one
 * island of the game's own. A word the generator does not know is refused with the words it knows (never dropped).
 */
export function specIslands(spec = {}) {
  const list = spec?.world?.islands;
  if (list !== undefined && (!Array.isArray(list) || list.length < 1 || list.length > MAX_ISLANDS)) throw new Error(`world.islands: 1 to ${MAX_ISLANDS} islands (got ${Array.isArray(list) ? list.length : typeof list})`);
  const base = Number.isInteger(spec?.world?.seed) ? spec.world.seed : seedOf(spec);
  return (list ?? [{ name: spec?.title ?? 'Island' }]).map((it, i) => {
    const words = { ...(it.words ?? {}) };
    for (const [k, v] of Object.entries(words)) {
      if (k === 'bay' || k === 'facing') continue;   // a compass side or degrees
      if (!WORDS[k]) throw new Error(`world.islands[${i}].words.${k}: not a place word (${[...Object.keys(WORDS), 'bay'].join(', ')})`);
      if (!knownWord(k, v)) throw new Error(`world.islands[${i}].words.${k}: "${v}" is not one of ${WORDS[k].join(', ')}`);
    }
    return { name: String(it.name ?? `Island ${i + 1}`).slice(0, 40), seed: Number.isInteger(it.seed) ? it.seed : (base + i * 7919) % 2147483647, words };
  });
}

/**
 * config/world.json: the template, the islands (specIslands: each with its own seats, islandsConfig) and the start
 * places, which are island 1's: a game never starts on the reference island's numbers, and never builds it.
 */
export function worldConfig(spec = {}, { islands = null } = {}) {
  const template = spec?.world?.template ?? templates[0];
  if (!templates.includes(template)) throw new Error(`world.template "${template}" is not a vista world (${templates.join(', ')})`);
  const list = islandsConfig(islands ?? specIslands(spec));
  return { template, kind: 'vista-coast', islands: list, places: clone(list[0].places) };
}

/** An island's look words (time, weather) as kit/look.js values, or null: the game's own look. */
export function islandLook(world = {}, i = 0) {
  const it = world.islands?.[i];
  if (!it) return null;
  return placeLook(it.recipe ?? placeRecipe(it.seed, it.words ?? {}));
}

/**
 * A place's start seats (every place its own, never the reference island's numbers): placeSeats (the pier's foot, the
 * pier head, beside the boat) and the beach (a row on the sand at the recipe's spawn, facing the way it faces).
 */
export function seatsOf(recipe) {
  const S = placeSeats(recipe), sp = recipe.spawn ?? recipe.start;
  const fx = -Math.sin(sp.yaw), fz = -Math.cos(sp.yaw), rx = -fz, rz = fx;
  const beach = [-3, -1, 1, 3].map(d => ({ x: r3(sp.x + rx * d), z: r3(sp.z + rz * d), yaw: r3(sp.yaw) }));
  return { pier: S.pier, 'pier-head': S['pier-head'], beach, boat: S.boat };
}

/** config/world.json → islands: each island's name, its seed and words (its recipe is made again from them) and seats. */
export function islandsConfig(list = []) {
  return list.slice(0, 5).map((it, i) => {
    const recipe = it.schema ? it : it.recipe ?? placeRecipe(it.seed, it.words ?? {});
    const out = { name: String(it.name ?? `Island ${i + 1}`) };
    if (it.recipe || it.schema) out.recipe = recipe; else Object.assign(out, { seed: it.seed, words: { ...(it.words ?? {}) } });
    const seats = seatsOf(recipe);
    out.places = Object.fromEntries(Object.entries(seats).map(([id, list2]) => [id, { label: PLACES[id]?.label ?? id, seats: list2 }]));
    return out;
  });
}

/** The islands a world config lists, as { name, recipe } (the recipe from its seed and words); [] for one island. */
export function islandRecipes(world = {}) {
  return (world.islands ?? []).map(it => ({ name: it.name, recipe: it.recipe ?? placeRecipe(it.seed, it.words ?? {}) }));
}

/** Where seat `seat` stands at the start place `start` ({x, z, yaw}): the island's, the world config's, else the kit's. */
export function placeOf(world, start = START_DEFAULT, seat = 0, island = null) {
  const own = island !== null && island !== undefined ? world?.islands?.[island]?.places : null;
  const P = own?.[start] ?? own?.[START_DEFAULT] ?? world?.places?.[start] ?? world?.places?.[START_DEFAULT] ?? clone(PLACES[start] ?? PLACES[START_DEFAULT]);
  const seats = P.seats?.length ? P.seats : PLACES[START_DEFAULT].seats;
  const s = seats[((seat % seats.length) + seats.length) % seats.length];
  // a fifth player and on: the same four seats one step further out
  const out = Math.floor(seat / seats.length) * 0.8;
  const cx = seats.reduce((a, q) => a + q.x, 0) / seats.length, cz = seats.reduce((a, q) => a + q.z, 0) / seats.length;
  const dx = s.x - cx, dz = s.z - cz, l = Math.hypot(dx, dz) || 1;
  return { x: s.x + (dx / l) * out, z: s.z + (dz / l) * out, yaw: s.yaw };
}

// ---- the bodies friends see (I4: kit/bodies.json, track C; the Quaternius bodies until it exists) ----
/** The bodies when kit/bodies.json is not there yet: the wave 1 pier sandbox's four Quaternius bodies (CC0). */
export const FALLBACK_BODIES = ['quaternius-casual-man', 'quaternius-casual-woman', 'quaternius-hoodie', 'quaternius-adventurer-woman'];
export const SEATS = 4;
export const BODY = 'character.body.player';
export const CLIPS = 'character.clips.player';
export const TINT = 'character.tint.player';
/** The body slot of a seat (0-based): seat 0 keeps `character.body.player` (forge's names). */
export const bodySlot = seat => (seat > 0 ? `${BODY}.${seat + 1}` : BODY);
export const CLIPS_FILE = 'assets/clips/gf-humanoid-1.glb';
export const bodyFile = id => `assets/bodies/${id}.glb`;

/**
 * config/characters.json → vista: {bodies: [{id, file, height}], clips} from the ids chosen for the seats (kit/bodies.json
 * `default`, else FALLBACK_BODIES) and what each body's record says (its height).
 */
export function bodiesConfig(ids, records = {}) {
  return { bodies: ids.slice(0, SEATS).map(id => ({ id, file: bodyFile(id), height: Number(records[id]?.height) > 1 ? Number(records[id].height) : 1.75 })), clips: CLIPS_FILE };
}

// ---- the slots ----
const LOOK_FILE = 'config/look.json', WORLD_FILE = 'config/world.json', GAME_FILE = 'config/game.json', CHAR_FILE = 'config/characters.json';
const esc = k => String(k).replace(/~/g, '~0').replace(/\//g, '~1');
const slotId = s => String(s).replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '') || 'x';
const words = k => String(k).replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[-_]+/g, ' ').toLowerCase();

/** The look values as slots (look.*): the preset's name, the hour, the sea state, the exposure and the cloud cover. */
export function lookSlots(look = {}) {
  const out = [
    { id: 'look.preset', group: 'look', label: 'Look', type: 'enum', source: { file: LOOK_FILE, pointer: '/preset' }, constraints: { options: Object.entries(presets).map(([value, p]) => ({ value, label: p.label })) }, tier: 'main', facet: 'look', rank: 80, description: 'The named look the hour, the sea and the light start from (a change here takes effect with the values below it)' },
    { id: 'look.hour', group: 'look', label: 'Time of day', type: 'number', source: { file: LOOK_FILE, pointer: '/hour' }, constraints: { min: LOOKS.hour.min, max: LOOKS.hour.max, step: 0.1, unit: 'h' }, tier: 'main', facet: 'look', rank: 79, description: 'The hour on a 24-hour clock: the sun, the sky and the light (6 dawn, 12.5 noon, 17.9 sunset, 21.5 night)' },
    { id: 'look.sea', group: 'look', label: 'Sea state', type: 'enum', source: { file: LOOK_FILE, pointer: '/sea' }, constraints: { options: Object.keys(SEAS) }, tier: 'main', facet: 'look', rank: 78, description: LOOKS.sea.why },
    { id: 'look.exposure', group: 'look', label: 'Exposure', type: 'number', source: { file: LOOK_FILE, pointer: '/exposure' }, constraints: { min: LOOKS.exposure.min, max: LOOKS.exposure.max, step: 0.1, unit: 'EV' }, tier: 'advanced', facet: 'look', rank: 30, description: LOOKS.exposure.why },
  ];
  if (look.clouds !== undefined) out.push({ id: 'look.clouds', group: 'look', label: 'Cloud cover', type: 'number', source: { file: LOOK_FILE, pointer: '/clouds' }, constraints: { min: 0, max: 1, step: 0.01 }, tier: 'advanced', facet: 'look', rank: 28, description: 'How much of the sky the cumulus fill (the most near 0.62; they thin above 0.7)' });
  if (look.haze !== undefined) out.push({ id: 'look.haze', group: 'look', label: 'Haze', type: 'number', source: { file: LOOK_FILE, pointer: '/haze' }, constraints: { min: 0.5, max: 8, step: 0.1 }, tier: 'advanced', facet: 'look', rank: 26, description: LOOKS.haze.why });
  if (look.veil !== undefined) out.push({ id: 'look.veil', group: 'look', label: 'Sky veil', type: 'number', source: { file: LOOK_FILE, pointer: '/veil' }, constraints: { min: 0, max: 1, step: 0.01 }, tier: 'advanced', facet: 'look', rank: 27, description: LOOKS.veil.why });
  return out;
}

/** The start places' seats as slots (world.place.<id>.<n>.x / z / yaw). */
export function worldSlots(world = {}) {
  const out = [];
  // each island: its name (the HUD shows it), its seed and its words (another seed or word is another place)
  (world.islands ?? []).forEach((it, i) => {
    if (it.seed === undefined) return;
    const n = i + 1, at = `/islands/${i}`;
    out.push({ id: `world.island.${n}.name`, group: 'world', label: `Island ${n}: name`, type: 'text', source: { file: WORLD_FILE, pointer: `${at}/name` }, constraints: { maxLength: 40 }, tier: 'main', facet: 'look', rank: 70 - i, description: `The name of island ${n}, as the HUD and the chart show it` });
    out.push({ id: `world.island.${n}.seed`, group: 'world', label: `Island ${n}: seed`, type: 'integer', source: { file: WORLD_FILE, pointer: `${at}/seed` }, constraints: { min: 0, max: 2147483647 }, tier: 'main', facet: 'look', rank: 69 - i, description: `The seed island ${n} is generated from: another seed is another island with the same words` });
    out.push({ id: `world.island.${n}.words`, group: 'world', label: `Island ${n}: words`, type: 'json', source: { file: WORLD_FILE, pointer: `${at}/words` }, tier: 'main', facet: 'look', rank: 68 - i, description: `The words island ${n} is made from (${Object.keys(WORDS).join(', ')}, bay)` });
  });
  for (const [id, P] of Object.entries(world.places ?? {})) (P.seats ?? []).forEach((s, i) => {
    for (const k of ['x', 'z', 'yaw']) out.push({ id: `world.place.${slotId(id)}.${i + 1}.${k}`, group: 'world', label: `${P.label ?? id}, seat ${i + 1}: ${k === 'yaw' ? 'facing' : k}`, type: 'number', source: { file: WORLD_FILE, pointer: `/places/${esc(id)}/seats/${i}/${k}` }, constraints: k === 'yaw' ? { min: -6.3, max: 6.3, unit: 'rad' } : { min: -1000, max: 1000, unit: 'm' }, tier: 'advanced', facet: 'gameplay', rank: 6, description: `Where seat ${i + 1} starts ${P.label ? `at ${P.label.toLowerCase()}` : ''} (${k === 'yaw' ? 'the way they face, radians; π faces the open sea' : `metres on the island's ${k} axis`})` });
  });
  return out;
}

/** Each seat's body friends see, the clips they play and the seat colours (characters.*). */
export function bodySlots(characters = {}) {
  const out = [], v = characters.vista ?? null;
  if (Array.isArray(characters.palette)) out.push({ id: TINT, group: 'characters', label: 'Player colours (one per seat)', type: 'colors', scope: 'player', source: { file: CHAR_FILE, pointer: '/palette' }, constraints: { min: 1, max: 8 }, tier: 'main', facet: 'look', rank: 90, description: 'Each player\'s colour: their clothes as friends see them, their name tag and their name on the HUD and in the friends room' });
  if (!v) return out;
  (v.bodies ?? []).forEach((b, i) => out.push({ id: bodySlot(i), group: 'characters', label: i ? `Player body, seat ${i + 1}` : 'Player body (what friends see)', type: 'model', source: { file: b.file }, constraints: { maxBytes: 16777216, rig: 'gf-humanoid-1' }, tier: i ? 'advanced' : 'main', facet: 'look', rank: i ? 60 - i : 88,
    description: `The body other players see ${i ? `the player in seat ${i + 1}` : 'you'} as (first person: never on your own screen). A gf-humanoid-1 body; its tint materials take the player's colour`,
    generate: { prompt: 'a person in light summer clothes for a day by the sea, full body, standing', style: 'realistic proportions, natural materials, soft daylight' } }));
  if (v.clips) out.push({ id: CLIPS, group: 'characters', label: 'Player animations', type: 'model', source: { file: v.clips }, constraints: { maxBytes: 8388608, animations: ['idle', 'walk', 'run', 'sprint'] }, tier: 'advanced', facet: 'look', rank: 20, editable: false, readonlyReason: 'The shared gf-humanoid-1 clips every body plays; replaced as part of the character standard', description: 'The clips the others\' bodies play (idle, walk, run, sprint)' });
  return out;
}

/**
 * Every value of the data tables (config/game.json → vista) as a slot (vista.<path>): a word a text slot, a number a
 * number slot, a switch a boolean, a list a json slot. Names, prices and values of what a player sees first are main.
 */
export function tableSlots(vista = {}) {
  const out = [];
  const MAIN = /^(species\.[^.]+\.(name|value)|gear\.[^.]+\.(name|price)|vendors\.[^.]+\.name|economy\.startMoney)$/;
  const walk = (v, path) => {
    if (v === null || v === undefined) return;
    const dotted = path.join('.'), pointer = `/vista/${path.map(esc).join('/')}`, id = `vista.${path.map(slotId).join('.')}`.slice(0, 80);
    const label = path.map(words).join(' · ');
    const main = MAIN.test(dotted);
    const base = { id, group: 'mechanics', label: label.replace(/^./, c => c.toUpperCase()).slice(0, 80), source: { file: GAME_FILE, pointer }, tier: main ? 'main' : 'advanced', facet: typeof v === 'string' ? 'text' : 'gameplay', rank: main ? 70 : 10, description: `The game's ${label} (config/game.json → vista)` };
    if (typeof v === 'string') out.push({ ...base, type: 'text', constraints: { maxLength: path.at(-1) === 'greeting' ? 200 : 60 } });
    else if (typeof v === 'number') out.push({ ...base, type: 'number', constraints: {} });
    else if (typeof v === 'boolean') out.push({ ...base, type: 'boolean' });
    else if (Array.isArray(v)) out.push({ ...base, type: 'json' });
    else if (typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, [...path, k]);
  };
  for (const [k, v] of Object.entries(vista ?? {})) walk(v, [k]);
  return out;
}

/** Where the core's public files are in a game (gf/vista/core/public: vendored, read through gf-assets by the boot). */
export const CORE_PUBLIC = 'gf/vista/core/public/';
const CORE_LABEL = { characters: 'Vendor', debris: 'Driftwood and shells', props: 'Stall props', whale: 'Whale', smaa: 'Anti-aliasing table' };
/**
 * The core's own files as slots (core.<folder>.<name>; kit/core-files.js): the stall props and their pictures, the
 * driftwood and shells on the beach, the whale, the two vendors, the anti-aliasing tables. Each is read through
 * gf-assets (Studio's swaps and overrides reach the core); kit/coverage.js tags what each draws. Advanced tier: a
 * creator changes the place's own pieces rarely, and the main tier stays the look, the bodies and the tables.
 */
export function coreSlots(files = CORE_FILES) {
  return files.map(f => {
    const folder = f.slot.split('.')[1], name = f.file.split('/').pop().replace(/\.[a-z0-9]+$/i, '').replace(/[_-]+/g, ' ');
    const base = { id: f.slot, group: 'world', label: `${CORE_LABEL[folder] ?? folder}: ${name}`.slice(0, 80), type: f.type, source: { file: CORE_PUBLIC + f.file }, tier: 'advanced', facet: 'look', rank: 20,
      constraints: { maxBytes: Math.max(262144, Math.ceil(f.bytes * 2)) }, description: `The vista core's own ${f.type === 'model' ? 'model' : f.type === 'image' ? 'picture' : 'data file'} ${f.file} (drawn by core/src/${f.by ?? '?'})` };
    if (f.type === 'model') return { ...base, generate: { prompt: `${name}, as on a quiet tropical island pier`, style: 'photoreal, natural materials' } };
    if (f.type === 'image') return { ...base, generate: { prompt: `${name} texture`, style: 'photoreal' } };
    return { ...base, editable: false };
  });
}

/** All of vista's slot declarations for a game's config ({look, world, characters, game}). */
export function slotsFor(cfg = {}) {
  return [...bodySlots(cfg.characters ?? {}), ...worldSlots(cfg.world ?? {}), ...lookSlots(cfg.look ?? {}), ...tableSlots(cfg.game?.vista ?? {}), ...coreSlots()];
}

/** The look values a game boots with: config/look.json, with a preset's values under any the config leaves out. */
export function bootLook(look = {}) {
  const p = PRESETS[look.preset] ?? PRESETS[DEFAULT_PRESET];
  const out = { hour: look.hour ?? p.hour, sea: look.sea ?? p.sea, exposure: look.exposure ?? p.exposure };
  const clouds = look.clouds ?? p.clouds;
  if (clouds !== undefined && clouds !== null) out.clouds = clouds;
  for (const k of ['veil', 'haze']) if (look[k] !== undefined && look[k] !== null) out[k] = look[k];
  return out;
}
