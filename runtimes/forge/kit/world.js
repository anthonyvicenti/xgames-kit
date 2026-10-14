// gf-forge's world (CONTRACT §8 forge), vendored into a game as gf/forge/world.js: the arena or room a forge game is
// played in, every piece a model slot, the pictures they are painted with texture slots, fire with point lights,
// static box colliders for the core, spawns, zones, the enemies' emerge points and bodies, and the AI hooked up.
//
//   worldConfig(spec, opts)  pure (create calls it in Node with the library: research/gf-forge/tools/library.mjs
//                            forgeLibrary()): the layout → config/world.json, the files → assets/
//   slotsFor(cfg)            pure: the world's slots (and the enemies' bodies, clips and orb)
//   loadWorld(ctx, cfg)      the browser: every piece loaded as its slot's bytes, placed, its colliders and lights given
//                            to the core, the AI attached (gf/forge/ai.js: emerge points, the nav grid's bounds, the
//                            enemies' bodies, the director, bots) → ctx.world ({spawn(i), zone(name), bounds, props, …})
//
// Templates (world.json describes the layout as gf-scenic's does: a `template` and `kind`, then values):
//   crypt-room   (kind forge-room)  wave 0's torch-lit room of KayKit Dungeon pieces (research/gf-scenic/library), 3, 4
//                                   or 5 tiles of 3 m a side by size class; one stone texture slot
//   ruins-arena  (kind forge-arena) a moonlit ruined courtyard generated from `world.seed` out of the forge library
//                                   (kit/arena.js: tiled ground with a flagstone path, ferns and weeds, block walls
//                                   and a gatehouse, cover, a few fires with flames, the skyline, emerge mounds,
//                                   lanes, three rings of broad trees past the walls in the renderer's backdrop
//                                   layer, a sheet of cloud over it), 8, 10 or 12 tiles a side; a texture slot a
//                                   surface (ground, walls, flagstones, earth), the ground's tiling scale in metres
//                                   and the clouds' height value slots
//   town-street  (kind forge-arena) wave 5: a gaslit old-town street that opens into a small square, generated from
//                                   `world.seed` out of the forge library's town pieces (kit/town.js: wet cobbles and
//                                   pavements, house fronts of brick and timber frame with jettied storeys, tiled
//                                   roofs, lit windows and shop signs, gas lamps, carts, barrels, crates and a market
//                                   stall for cover, cellar hatches and drains the dead come up from, a barricade at
//                                   one end and railings at the other, four alleys, far roofs and a church tower in
//                                   the backdrop layer, the ruin's cloud): 9 m wide and 30, 36 or 42 m long, the square
//                                   21 × 12, 27 × 18 or 33 × 18 m; its play area is a floor plan (`floor`), not a box.
//                                   The spec's first prop stands in the middle of the square: the library's own piece
//                                   for the name (`pump`: the town pump) where it has one
// The art a game ships is the library's small variant of a file where there is one (catalog.json `small`: the same
// model with a 128 to 512 px picture, for phones and for the texel look); the full-size files stay in the library.
// Every forge world also carries `enemies` (each enemy type's body, the forge clip file, the caster's orb) when the
// game's tables name enemies, and `art` (wave 3; gf/forge/art.js): the hands on the first-person weapon, a rig a weapon
// family, and the picture on each reward card. They ride this module because create and the slot tools already call it.
import { generateArena, LABELS as ARENA_LABELS, PIECES as ARENA_PIECES, SURFACES, ARENA_SIZES, STREET_SIZES, footprint } from './arena.js';
import { generateTown, LABELS as TOWN_LABELS, PIECES as TOWN_PIECES, SURFACES as TOWN_SURFACES } from './town.js';
import { archetypes as ENEMY_ARCHETYPES } from './tables/enemies.js';
import { attachAi } from './ai.js';
import { artConfig, artFiles, slotsFor as artSlots, attachHands } from './art.js';
import { thrownFor } from './wear.js';

export const templates = ['crypt-room', 'ruins-arena', 'town-street'];
export const TILE = 3;
export const SIZES = { small: 3, medium: 4, large: 5 };
/** Each template's tiles a side by size class (the catalog reads it); a street's: its tiles from end to end. */
export const WORLD_SIZES = { 'crypt-room': SIZES, 'ruins-arena': ARENA_SIZES, 'town-street': Object.fromEntries(Object.entries(STREET_SIZES).map(([k, s]) => [k, s.long])) };
/** The metres [across, along] of the box round a world's play area where it is not a square (the catalog reads it). */
export const WORLD_FOOTPRINTS = { 'town-street': Object.fromEntries(Object.keys(STREET_SIZES).map(k => [k, footprint('town-street', k)])) };
/**
 * The worlds generated from a seed (kind forge-arena), each from its own part of the library: how it is generated, its
 * pieces' roles and labels, the pictures that tile over them, its files' prefix, and the words its slots are described
 * with. `goal`: where the spec's first prop stands (i: the prop's index, r: the plaza's radius) → [x, z].
 */
const OUTDOOR = {
  'ruins-arena': { generate: generateArena, pieces: ARENA_PIECES, labels: ARENA_LABELS, surfaces: SURFACES, prefix: 'ruins', place: 'arena', about: 'a moonlit graveyard ruin', layout: 'Arena layout', lights: 'Fire lights',
    goal: (i, r) => { const ang = i === 0 ? 0 : Math.PI + i * 0.9; return [Math.sin(ang) * (r - 1.2), Math.cos(ang) * (r - 1.2)]; } },
  // the street's first prop (the town pump) stands in the middle of the square, the spawns 8.5 m south of it; any
  // others round it
  'town-street': { generate: generateTown, pieces: TOWN_PIECES, labels: TOWN_LABELS, surfaces: TOWN_SURFACES, prefix: 'town', place: 'street', about: 'a gaslit old-town street at night', layout: 'Street layout', lights: 'Lamp lights',
    goal: i => (i === 0 ? [0, 0] : [Math.sin(Math.PI + i * 0.9) * 3.4, Math.cos(Math.PI + i * 0.9) * 3.4]) },
};
const WALL_T = 0.75;

// the crypt room's pieces: name → the scenic library's id (research/gf-scenic/library/props.json)
const PIECES = { floor: 'dungeon-floor', wall: 'dungeon-wall', pillar: 'dungeon-pillar', torch: 'dungeon-torch-wall', barrel: 'dungeon-barrel', crates: 'dungeon-crates' };
// the pieces the stone texture slot paints (every structural piece; props keep their own pictures)
const STONE = ['floor', 'wall', 'pillar'];
const LABELS = { floor: 'Floor tile', wall: 'Wall', pillar: 'Corner pillar', torch: 'Wall torch', barrel: 'Barrel', crates: 'Stacked crates' };

const r3 = v => Math.round(v * 1000) / 1000;
/** Where a library file came from, for the game's ATTRIBUTION.md: the forge library's own file, or the free stand-in
 *  create copied in its place (runtimes/forge/tools/stand-ins.mjs). */
const libName = (library, rel) => { const s = library?.standInOf?.(rel); return s ? `runtimes/forge/library/${s}, a free stand-in for ${rel}` : `runtimes/forge/library/${rel}`; };
/** The library file a game ships for `rel`: its small variant where there is one (catalog.json `small`). */
export const shipped = (catalog, rel) => catalog?.small?.[rel] ?? rel;

/** A collider box {size, offset} in a piece's frame, turned by a multiple of 90° and moved to `at` → {min, max}. */
export function colliderBox(collider, at, rotDeg, scale = 1) {
  if (!collider || collider === 'none' || collider.shape !== 'box') return null;
  const q = ((Math.round(rotDeg / 90) % 4) + 4) % 4;
  let [sx, sy, sz] = collider.size.map(v => v * scale), [ox, oy, oz] = (collider.offset ?? [0, 0, 0]).map(v => v * scale);
  // three.js's yaw: +90° takes +X to −Z
  for (let k = 0; k < q; k++) { [sx, sz] = [sz, sx]; [ox, oz] = [oz, -ox]; }
  const c = [at[0] + ox, at[1] + oy, at[2] + oz];
  return { min: [r3(c[0] - sx / 2), r3(c[1] - sy / 2), r3(c[2] - sz / 2)], max: [r3(c[0] + sx / 2), r3(c[1] + sy / 2), r3(c[2] + sz / 2)] };
}

/**
 * config/world.json for a forge spec (create calls it in Node). opts: {assets, notes, propFiles, named} as create's
 * specToConfig passes them (the files to copy are pushed onto `assets`, with their licences), and `library`: {props
 * (research/gf-scenic/library/props.json → props), licences (its LICENSES.json → files), forgeLicences (research/
 * runtimes/forge/library/LICENSES.json → files), forgeCatalog (research/gf-forge/library/catalog.json), scenicFile(rel),
 * forgeFile(rel) (absolute paths)}. Pure: no file is read here.
 */
export async function worldConfig(spec, opts = {}) {
  const { library = null } = opts;
  if (!library) throw new Error('worldConfig needs the library (research/gf-forge/tools/library.mjs forgeLibrary())');
  const T = spec.world?.template ?? 'crypt-room';
  if (!templates.includes(T)) throw new Error(`world.template "${T}" is not a forge world (${templates.join(', ')})`);
  const cfg = OUTDOOR[T] ? arenaConfig(spec, opts, T) : roomConfig(spec, opts);
  const enemies = enemiesConfig(spec, opts, cfg.__art);
  if (enemies) cfg.enemies = enemies;
  const art = artBlock(spec, opts, cfg.__art);
  if (art) cfg.art = art;
  return cfg;
}

/** The hands on the first-person weapon and the cards' pictures (gf/forge/art.js), their library files with their licences. */
function artBlock(spec, { assets = [], notes = [], library }, art) {
  const forge = spec.tables ?? {}, cat = library.forgeCatalog, own = library.forgeLicences;
  const cfg = artConfig(forge, cat);
  if (!cfg) return null;
  for (const f of artFiles(forge, cat)) {
    const l = own[f.from];
    if (!l) throw new Error(`research/gf-forge/library/LICENSES.json has no record for ${f.from}`);
    const license = { spdx: l.spdx, author: l.author, url: l.page ?? l.from ?? '' };
    assets.push({ to: f.to, from: library.forgeFile(f.from), license });
    art?.push({ file: f.to, what: `${f.what} (${libName(library, f.from)})`, license: `${license.spdx}, ${license.author}` });
  }
  const rigs = Object.keys(cfg.hands?.rigs ?? {}), cards = Object.keys(cfg.cards ?? {});
  notes.push(`art: ${rigs.length ? `hands on the first-person weapon (${rigs.join(', ')})` : 'no hands'}${cards.length ? `; a picture on each of ${cards.length} cards` : ''}; each a slot`);
  return cfg;
}

function roomConfig(spec, { assets = [], notes = [], propFiles = {}, named = {}, library }) {
  const lib = library.scenicFile, forgeLib = library.forgeFile;
  const catalog = new Map(library.props.map(p => [p.id, p]));
  const licences = library.licences, ownLicences = library.forgeLicences;
  const T = 'crypt-room';
  const size = spec.world?.size ?? 'small', n = SIZES[size] ?? SIZES.small, half = (n * TILE) / 2;
  const licenceOf = e => { const l = licences[e.file]; return l ? { spdx: l.spdx, author: l.author, url: l.page ?? l.from ?? '' } : null; };
  const art = [];
  const use = (name, id, to) => {
    const e = catalog.get(id);
    if (!e) throw new Error(`the scenic library has no "${id}"`);
    if (!assets.some(a => a.to === to)) { const license = licenceOf(e); assets.push({ to, from: lib(e.file), license }); art.push({ file: to, what: `${LABELS[name] ?? name} (KayKit Dungeon Remastered: ${id}, research/gf-scenic/library)`, license: license ? `${license.spdx}, ${license.author}` : 'see research/gf-scenic/library/LICENSES.json' }); propFiles[id] ??= { file: to, from: `library:${id}`, ...(license ? { license } : {}) }; }
    return e;
  };
  const pieces = [], colliders = [], lights = [], placedProps = [];
  const slotOf = name => `world.${T}.${name}`;
  const place = (name, at, rot = 0, scale = 1) => {
    const e = use(name, PIECES[name], `assets/models/${PIECES[name]}.glb`);
    pieces.push({ piece: name, slot: slotOf(name), at: at.map(r3), rot, scale });
    const box = colliderBox(e.collider, at, rot, scale); if (box) colliders.push(box);
  };
  const along = [];
  for (let k = 0; k < n; k++) along.push(r3(-half + TILE / 2 + k * TILE));
  // floor tiles, walls on the four sides (their inner face on the room's edge), pillars in the corners
  for (const x of along) for (const z of along) place('floor', [x, 0, z]);
  const wz = half + WALL_T / 2;
  for (const x of along) { place('wall', [x, 0, -wz], 0); place('wall', [x, 0, wz], 180); }
  for (const z of along) { place('wall', [-wz, 0, z], 90); place('wall', [wz, 0, z], -90); }
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) place('pillar', [sx * wz, 0, sz * wz]);
  // torches on the far (north) wall, either side of the middle, and one on the near wall: their flames light the room
  const torchAt = [[-TILE * 0.75, -half, 0], [TILE * 0.75, -half, 0], [0, half, 180]];
  for (const [x, z, rot] of torchAt) {
    place('torch', [x, 1.6, z], rot);
    const out = rot === 180 ? -0.36 : 0.36;
    lights.push({ at: [r3(x), 2.05, r3(z + out)], seed: lights.length + 1 });
  }
  // a little clutter in two corners (never on the spawns or the middle)
  place('barrel', [r3(half - 1.0), 0, r3(-half + 1.0)], 20);
  place('crates', [r3(-half + 1.1), 0, r3(-half + 1.2)], 0);   // the far corner: the near one crowded the first spawn (check 11, track A)
  // the spec's own props: the first at the middle of the far wall, facing the room; the rest along the side walls
  const own = spec.world?.props ?? [];
  own.forEach((p, i) => {
    const id = libraryId(catalog, p.name, p.describe);
    if (!id) { notes.push(`world: no library piece for prop "${p.name}"; not placed`); return; }
    const to = `assets/models/${p.name}.glb`, e = catalog.get(id), license = licenceOf(e);
    if (!assets.some(a => a.to === to)) { assets.push({ to, from: lib(e.file), license }); art.push({ file: to, what: `the game's ${p.name} (KayKit Dungeon Remastered: ${id})`, license: license ? `${license.spdx}, ${license.author}` : '' }); }
    propFiles[p.name] = { file: to, from: `library:${id}`, ...(license ? { license } : {}) };
    named[p.name] = `prop.${p.name}`;
    const at = i === 0 ? [0, 0, r3(-half + 1.4)] : [r3((i % 2 ? -1 : 1) * (half - 1.2)), 0, r3(-half + 1.2 + Math.floor(i / 2) * 2.2)];
    placedProps.push({ prop: p.name, at, rot: 0, scale: 1 });
    const box = colliderBox(e.collider, at, 0, 1); if (box) colliders.push(box);
    if (id !== p.name) notes.push(`world: "${p.name}" is the library's "${id}"`);
  });
  // spawns along the near wall, facing the far one (the kit's yaw: π faces −Z)
  const players = Math.max(2, Math.min(8, spec.players?.max ?? 4));
  const spawns = [];
  for (let i = 0; i < players; i++) { const t = players === 1 ? 0.5 : i / (players - 1); spawns.push([r3(-half * 0.55 + t * half * 1.1), 0.05, r3(half - 1.6), r3(Math.PI)]); }
  // the stone: one texture slot for every structural piece
  const stone = { slot: `world.${T}.stone`, file: 'assets/textures/crypt-stone.png', on: STONE.map(slotOf) };
  const sl = ownLicences['textures/kaykit-dungeon-atlas.png'];
  assets.push({ to: stone.file, from: forgeLib('textures/kaykit-dungeon-atlas.png'), license: { spdx: sl.spdx, author: sl.author, url: sl.page } });
  art.push({ file: stone.file, what: 'the stone every wall, floor and pillar is painted with (the KayKit Dungeon Remastered atlas, research/gf-forge/library)', license: `${sl.spdx}, ${sl.author}` });
  // emerge points when enemies come (the room's corners and the middle of the side walls, away from the spawns)
  const mounds = (spec.tables?.enemies ?? []).length ? [[-half + 1.2, 0, -half + 2.6], [half - 1.2, 0, -half + 2.6], [-half + 1.2, 0, 0], [half - 1.2, 0, 0]].map(m => m.map(r3)) : [];
  notes.push(`world: a forge ${T}, ${n} x ${n} tiles (${n * TILE} m a side), ${pieces.length} pieces, ${colliders.length} colliders, ${lights.length} torches`);
  return {
    template: T, kind: 'forge-room', size: [n * TILE, n * TILE], sizeClass: size, half,
    pieces, props: placedProps, colliders, lights, spawns, mounds,
    zones: { centre: { shape: 'circle', at: [0, 0, 0], size: [1.5] } },
    texture: stone, floorLimit: -10,
    nav: { min: [-half, -half], max: [half, half], cell: 0.5 },
    __art: art,
  };
}

/** A world generated from a seed: the ruins arena (kit/arena.js) or the town street (kit/town.js); every piece the
 *  forge library's, its licence carried along. */
function arenaConfig(spec, { assets = [], notes = [], propFiles = {}, named = {}, library }, T = 'ruins-arena') {
  const O = OUTDOOR[T], catalog = library.forgeCatalog, forgeLib = library.forgeFile, own = library.forgeLicences;
  if (!catalog?.roles) throw new Error(`the ${T === 'ruins-arena' ? 'ruins arena' : T} needs the forge library catalog (library.forgeCatalog)`);
  const seed = Number.isFinite(spec.world?.seed) ? spec.world.seed : 1;
  const players = Math.max(2, Math.min(4, spec.players?.max ?? 4));
  const a = O.generate({ seed, size: spec.world?.size ?? 'medium', players, catalog });
  const art = [];
  const licenceOf = rel => { const l = own[rel]; return l ? { spdx: l.spdx, author: l.author, url: l.page ?? l.from ?? '' } : null; };
  const fileOf = piece => `assets/models/${O.prefix}-${piece}.glb`;
  const drawn = [...new Set(['ground', ...(a.sky ? [a.sky.piece] : []), ...a.pieces.map(p => p.piece)])];
  for (const piece of drawn) {
    const rel = shipped(catalog, catalog.roles[O.pieces[piece]].file), to = fileOf(piece), license = licenceOf(rel);
    if (!license) throw new Error(`research/gf-forge/library/LICENSES.json has no record for ${rel}`);
    assets.push({ to, from: forgeLib(rel), license });
    art.push({ file: to, what: `${O.labels[piece] ?? piece} (${libName(library, rel)})`, license: `${license.spdx}, ${license.author}` });
  }
  // the pictures that tile over pieces: each a texture slot over the pieces built from it, the ground's first
  const textures = [];
  for (const [group, rel, label] of O.surfaces) {
    const g = a.textureGroups[group];
    if (!g?.on?.length) continue;
    const to = `assets/textures/${O.prefix}-${group}.png`, license = licenceOf(rel);
    if (!license) throw new Error(`research/gf-forge/library/LICENSES.json has no record for ${rel}`);
    assets.push({ to, from: forgeLib(rel), license });
    art.push({ file: to, what: `${label} (${libName(library, rel)})`, license: `${license.spdx}, ${license.author}` });
    textures.push({ slot: `world.${T}.${group}`, file: to, on: g.on, ...(g.metres ? { metres: g.metres } : {}) });
  }
  // the spec's own props: the forge library's own piece for the name when it has one (catalog role prop.<name>: the
  // chest is the grim reliquary), else the scenic library's KayKit piece as the crypt room's. The first stands at the
  // plaza's south edge, in front of the spawns (what a player first looks at), the rest round the plaza
  const scenic = new Map(library.props.map(p => [p.id, p]));
  const plazaR = a.zones.plaza.size[0];
  const props = [];
  (spec.world?.props ?? []).forEach((p, i) => {
    const ownRel = catalog.roles[`prop.${p.name}`]?.file ?? null;
    const id = ownRel ? null : libraryId(scenic, p.name, p.describe);
    if (!ownRel && !id) { notes.push(`world: no library piece for prop "${p.name}"; not placed`); return; }
    const to = `assets/models/${p.name}.glb`;
    let collider, license, what;
    if (ownRel) {
      const rel = shipped(catalog, ownRel), e = Object.values(catalog.sections ?? {}).map(sec => sec[ownRel]).find(Boolean);
      license = licenceOf(rel); collider = e?.collider ?? null; what = `the game's ${p.name} (${libName(library, rel)})`;
      if (!assets.some(x => x.to === to)) assets.push({ to, from: forgeLib(rel), license });
      propFiles[p.name] = { file: to, from: `forge-library:${ownRel}`, ...(license ? { license } : {}) };
      notes.push(`world: "${p.name}" is the forge library's ${ownRel}`);
    } else {
      const e = scenic.get(id), l = library.licences[e.file];
      license = l ? { spdx: l.spdx, author: l.author, url: l.page ?? l.from ?? '' } : null; collider = e.collider; what = `the game's ${p.name} (KayKit Dungeon Remastered: ${id})`;
      if (!assets.some(x => x.to === to)) assets.push({ to, from: library.scenicFile(e.file), license });
      propFiles[p.name] = { file: to, from: `library:${id}`, ...(license ? { license } : {}) };
      if (id !== p.name) notes.push(`world: "${p.name}" is the library's "${id}"`);
    }
    if (!art.some(x => x.file === to)) art.push({ file: to, what, license: license ? `${license.spdx}, ${license.author}` : '' });
    named[p.name] = `prop.${p.name}`;
    const [gx, gz] = O.goal(i, plazaR);
    const at = [gx, 0, gz].map(r3);
    // it faces the spawns (the library's props face +Z; the spawns are to the south, +Z)
    props.push({ prop: p.name, at, rot: 0, scale: 1 });
    const box = colliderBox(collider, at, 0, 1); if (box) a.colliders.push({ ...box, kind: 'prop', piece: p.name });
  });
  const { textureGroups, ...layout } = a;
  void textureGroups;
  layout.props = props;
  notes.push(T === 'ruins-arena'
    ? `world: a forge ruins-arena (seed ${seed}), ${a.size[0]} m a side, ${a.pieces.length} pieces (${a.pieces.filter(p => p.kind === 'backdrop').length} of them the backdrop past the walls), ${a.colliders.length} colliders, ${a.lights.length} fire lights, ${a.mounds.length} emerge mounds, ${a.cover.length} cover, ${a.lanes.length} lanes; the ground tiles every ${a.ground.metres} m${a.sky ? `; clouds ${a.sky.height} m up` : ''}`
    : `world: a forge ${T} (seed ${seed}), a street ${a.street.width} m wide and ${a.size[1]} m long through a square ${a.street.square.join(' by ')} m, ${a.street.alleys.length} alleys; ${a.pieces.length} pieces (${a.pieces.filter(p => p.kind === 'backdrop').length} of them the backdrop past the houses), ${a.colliders.length} colliders, ${a.lights.length} lamp lights, ${a.mounds.length} emerge points (cellar hatches and drains), ${a.cover.length} cover, ${a.lanes.length} lanes; the cobbles tile every ${a.ground.metres} m${a.sky ? `; clouds ${a.sky.height} m up` : ''}`);
  return { ...layout, files: Object.fromEntries(drawn.map(p => [p, fileOf(p)])), textures, __art: art };
}

/** The enemies' bodies (one slot per enemy type), the forge clip file and the caster's orb, when the tables name enemies. */
function enemiesConfig(spec, { assets = [], notes = [], library }, art) {
  const rows = Array.isArray(spec.tables?.enemies) ? spec.tables.enemies.filter(r => r && typeof r.id === 'string') : [];
  if (!rows.length) return null;
  const own = library.forgeLicences, cat = library.forgeCatalog;
  // a game ships the library's small variant of a file where there is one
  const forgeLib = rel => library.forgeFile(shipped(cat, rel));
  const licenceOf = rel => { const l = own[rel]; return l ? { spdx: l.spdx, author: l.author, url: l.page ?? l.from ?? '' } : null; };
  const bodies = [], held = new Map();
  rows.forEach((r, row) => {
    let body = r.body || ENEMY_ARCHETYPES[r.archetype ?? 'chaser']?.body || 'skeleton-grim-chaser';
    if (!licenceOf(`bodies/${body}.glb`)) { notes.push(`enemies: no library body "${body}" for ${r.id}; the chaser's`); body = 'skeleton-grim-chaser'; }
    const rel = `bodies/${body}.glb`, to = `assets/models/enemy-${r.id}.glb`, license = licenceOf(rel);
    assets.push({ to, from: forgeLib(rel), license });
    art?.push({ file: to, what: `the ${r.name || r.id} enemy's body (${libName(library, rel)})`, license: `${license.spdx}, ${license.author}` });
    // what it holds (the art library's catalog: the enemy role whose body this is; the Meshy held weapons of track C3,
    // each with its grip on the hand's socket): one model slot per held file, shared by every enemy that holds it
    const role = Object.entries(library.forgeCatalog?.roles ?? {}).find(([k, v]) => k.startsWith('enemy.') && !k.endsWith('.kaykit') && v?.body === rel)?.[1] ?? null;
    const holds = [];
    for (const [hand, h] of Object.entries(role?.held ?? {})) {
      const name = String(h.file).replace(/^held\//, '').replace(/\.glb$/, ''), hl = licenceOf(h.file);
      if (!hl) { notes.push(`enemies: no licence record for ${h.file}; ${r.id} holds nothing in its ${hand}`); continue; }
      const hto = `assets/models/held-enemy-${name}.glb`;
      if (!held.has(name)) { held.set(name, { name, slot: `enemy.held.${name}`, file: hto, label: name.replace(/^grim-/, '').replace(/-/g, ' ') }); assets.push({ to: hto, from: forgeLib(h.file), license: hl }); art?.push({ file: hto, what: `what an enemy holds: ${name} (${libName(library, h.file)})`, license: `${hl.spdx}, ${hl.author}` }); }
      holds.push({ slot: `enemy.held.${name}`, socket: h.grip?.socket ?? hand, grip: { position: h.grip?.position ?? [0, 0, 0], quaternion: h.grip?.quaternion ?? [0, 0, 0, 1], scale: h.grip?.scale ?? 1 } });
    }
    bodies.push({ row, id: r.id, body, slot: `enemy.${r.id}.body`, file: to, label: r.name || r.id, ...(role?.describe ? { describe: role.describe } : {}), ...(holds.length ? { held: holds } : {}) });
  });
  const clipsRel = 'clips/forge-humanoid-1.glb', cl = licenceOf(clipsRel);
  assets.push({ to: 'assets/clips/forge-humanoid-1.glb', from: forgeLib(clipsRel), license: cl });
  art?.push({ file: 'assets/clips/forge-humanoid-1.glb', what: 'the enemies\' animations (the forge clip file on gf-humanoid-1, research/gf-forge/library)', license: `${cl.spdx}, ${cl.author}` });
  const out = { bodies, clips: { slot: 'enemy.clips', file: 'assets/clips/forge-humanoid-1.glb' }, ...(held.size ? { held: [...held.values()] } : {}) };
  if (rows.some(r => (r.archetype ?? 'chaser') === 'caster' || (r.ranged?.range ?? 0) > 0)) {
    // (wave 5, track Z) a caster whose body's catalog role names what it throws (gf/forge/wear.js thrownFor) throws that
    const thrown = thrownFor(rows, bodies, cat), rel = thrown ?? cat?.roles?.['ruins.skull']?.file ?? 'ruins/skull.glb', l = licenceOf(rel);
    assets.push({ to: 'assets/models/enemy-orb.glb', from: forgeLib(rel), license: l });
    art?.push({ file: 'assets/models/enemy-orb.glb', what: `what a caster throws (${thrown ? 'its own' : 'a skull'}, ${libName(library, rel)})`, license: `${l.spdx}, ${l.author}` });
    out.orb = { slot: 'enemy.orb', file: 'assets/models/enemy-orb.glb', scale: 1.4 };
  }
  notes.push(`enemies: ${bodies.length} bodies (${[...new Set(bodies.map(b => b.body))].join(', ')})${held.size ? ` holding ${[...held.keys()].join(', ')}` : ''}, the forge clip file${out.orb ? ', the caster\'s orb' : ''}`);
  return out;
}

/** The scenic library's piece for a spec prop name: the id itself, `dungeon-<name>`, or a tag. */
function libraryId(catalog, name, describe = '') {
  if (catalog.has(name)) return name;
  if (catalog.has(`dungeon-${name}`)) return `dungeon-${name}`;
  const words = String(describe).toLowerCase().split(/[^a-z0-9]+/);
  let best = null, score = 0;
  for (const [id, e] of catalog) {
    if (!(e.tags ?? []).includes(name) && !id.split('-').includes(name)) continue;
    const s = 1 + words.filter(w => (e.tags ?? []).includes(w) || id.includes(w)).length;
    if (s > score) { best = id; score = s; }
  }
  return best;
}

const MAIN_PIECES = new Set(['wall', 'floor', 'ground', 'wall-a', 'wall-broken-a', 'gate', 'brazier', 'oak', 'pillar', 'wall-brick', 'upper-timber', 'roof', 'lamp', 'window-lit', 'cart']);
/** A generated world's own words (OUTDOOR); a forge-arena with no template of its own reads as the ruins arena. */
const outdoor = w => (w.kind === 'forge-arena' ? OUTDOOR[w.template] ?? OUTDOOR['ruins-arena'] : null);
const pieceFile = (w, piece) => w.files?.[piece] ?? (outdoor(w) ? `assets/models/${outdoor(w).prefix}-${piece}.glb` : `assets/models/${PIECES[piece] ?? piece}.glb`);
const pieceLabel = (w, piece) => (outdoor(w) ? outdoor(w).labels[piece] : LABELS[piece]) ?? piece;

/** The world's slots (CONTRACT §2.2): a model per piece and per prop, the textures, the layout values, the enemies. */
export function slotsFor(cfg) {
  const w = cfg?.world ?? cfg ?? {}, T = w.template ?? 'crypt-room', out = [];
  const W = 'config/world.json';
  const arena = w.kind === 'forge-arena', O = outdoor(w);
  const pieceOf = new Map();
  if (w.ground?.slot) pieceOf.set(w.ground.slot, w.ground.piece ?? 'ground');
  for (const p of w.pieces ?? []) if (!pieceOf.has(p.slot)) pieceOf.set(p.slot, p.piece);
  if (w.sky?.slot) pieceOf.set(w.sky.slot, w.sky.piece ?? 'clouds');
  for (const [slot, piece] of pieceOf) {
    const label = pieceLabel(w, piece);
    const main = arena ? MAIN_PIECES.has(piece) : ['floor', 'wall'].includes(piece);
    out.push({ id: slot, group: 'world', label, type: 'model', source: { file: pieceFile(w, piece) }, constraints: { maxBytes: 8388608, scale: 1 },
      tier: main ? 'main' : 'advanced', facet: 'look', rank: piece === 'wall' || piece === 'wall-a' || piece === 'wall-brick' ? 78 : piece === 'floor' || piece === 'ground' ? 77 : main ? 60 : 30,
      description: `Every ${String(label).toLowerCase()} in the ${arena ? O.place : 'room'}`, generate: { prompt: `a ${String(label).toLowerCase()} for ${arena ? O.about : 'a dark stone crypt'}`, style: 'low-poly kit piece, painted texture' } });
  }
  const names = new Map();
  for (const p of cfg?.game?.props ?? []) names.set(p.name, p);
  for (const p of w.props ?? []) if (!names.has(p.prop)) names.set(p.prop, { name: p.prop });
  for (const [name, p] of names) {
    const rec = cfg?.propFiles?.[name] ?? {};
    out.push({ id: `prop.${name}`, group: 'props', label: name.replace(/^./, c => c.toUpperCase()), type: 'model', source: { file: rec.file ?? `assets/models/${name}.glb` }, constraints: { maxBytes: 8388608, scale: 1 },
      tier: 'main', facet: 'look', rank: 94, ...(p.describe ? { description: `${p.describe}${p.role ? ` (${p.role})` : ''}`, generate: { prompt: p.describe, style: 'low-poly dungeon prop, painted texture' } } : {}), ...(rec.license ? { license: rec.license } : {}) });
  }
  if (w.texture?.slot) out.push({ id: w.texture.slot, group: 'world', label: 'Stone texture', type: 'image', source: { file: w.texture.file }, constraints: { maxBytes: 4194304 },
    tier: 'main', facet: 'look', rank: 79, description: 'The picture every wall, floor and pillar is painted with (a texture atlas: the pieces sample their own corner of it)', generate: { prompt: 'a hand-painted stone dungeon texture atlas', style: 'painted, low-poly game texture' } });
  for (const [i, t] of (w.textures ?? []).entries()) {
    const known = (O?.surfaces ?? SURFACES).find(x => t.slot === `world.${T}.${x[0]}`);
    const label = known?.[2] ?? (t.slot.endsWith('.stone') ? 'Stone texture' : 'Texture'), m = t.metres;
    out.push({ id: t.slot, group: 'world', label, type: 'image', source: { file: t.file }, constraints: { maxBytes: 4194304 },
      tier: 'main', facet: 'look', rank: 84 - i, description: `${known?.[3] ?? 'A picture the world\'s pieces are painted with'}${m ? `; one repeat is ${m[0]} m by ${m[1]} m` : ''}`,
      generate: { prompt: `${label.toLowerCase()} for ${O?.about ?? 'a moonlit graveyard ruin'}, seamless, dark`, style: 'low-resolution pixel texture, square texels, about 32 texels a metre' } });
  }
  if (w.ground?.slot) out.push({ id: `world.${T}.ground.metres`, group: 'world', label: 'Ground tiling scale', type: 'number', source: { file: W, pointer: '/ground/metres' }, constraints: { min: 1, max: 64, unit: 'm' },
    tier: 'advanced', facet: 'look', rank: 31, description: 'How many metres one repeat of the ground texture covers (smaller: finer texels; the default shows about 32 texels a metre)' });
  if (w.sky?.slot) out.push({ id: `world.${T}.sky.height`, group: 'world', label: 'Cloud height', type: 'number', source: { file: W, pointer: '/sky/height' }, constraints: { min: 20, max: 160, unit: 'm' },
    tier: 'advanced', facet: 'look', rank: 30, description: `How high the clouds hang over the ${O?.place ?? 'arena'} (lower: larger and closer; a second layer hangs a third higher)` });
  const e = w.enemies;
  for (const b of e?.bodies ?? []) out.push({ id: b.slot, group: 'characters', label: `${b.label} (enemy)`, type: 'model', source: { file: b.file }, constraints: { maxBytes: 8388608, scale: 1, rig: 'gf-humanoid-1' },
    tier: 'main', facet: 'look', rank: 88, description: `The ${b.label} enemy's body: a gf-humanoid-1 character with a glow_eyes material (its eyes glow per state)`, generate: { prompt: `${b.describe ?? 'an enemy'}, ${b.label}`, style: 'stylised low-poly, hand-painted, rigged gf-humanoid-1' } });
  for (const h of e?.held ?? []) out.push({ id: h.slot, group: 'characters', label: `Enemy weapon: ${h.label}`, type: 'model', source: { file: h.file }, constraints: { maxBytes: 4194304, scale: 1 },
    tier: 'advanced', facet: 'look', rank: 41, description: `What an enemy holds (${h.label}): origin at the grip; a glow_tip material glows` });
  if (e?.clips) out.push({ id: e.clips.slot, group: 'characters', label: 'Enemy animations', type: 'model', source: { file: e.clips.file }, constraints: { maxBytes: 8388608, rig: 'gf-humanoid-1' },
    tier: 'advanced', facet: 'look', rank: 20, description: 'The clips every enemy plays (a gf-humanoid-1 clip file: emerge, idle, run, windup, lunge, hits, knockdown, death, …)' });
  if (e?.orb) out.push({ id: e.orb.slot, group: 'characters', label: 'Caster\'s missile', type: 'model', source: { file: e.orb.file }, constraints: { maxBytes: 4194304, scale: 1 },
    tier: 'advanced', facet: 'look', rank: 40, description: 'What a caster throws (it glows with the caster\'s shot colour)' });
  out.push({ id: `world.${T}.layout`, group: 'world', label: arena ? O.layout : 'Room layout', type: 'json', source: { file: W, pointer: '/pieces' }, tier: 'advanced', facet: 'gameplay', rank: 20, description: 'Every piece: [{piece, slot, at: [x, y, z], rot, scale, kind}]' });
  out.push({ id: `world.${T}.colliders`, group: 'world', label: 'Walls you bump into', type: 'json', source: { file: W, pointer: '/colliders' }, tier: 'advanced', facet: 'gameplay', rank: 19, description: 'Static boxes the walk collides with: [{min: [x, y, z], max: [x, y, z]}]' });
  out.push({ id: `world.${T}.lights`, group: 'world', label: arena ? O.lights : 'Torch lights', type: 'json', source: { file: W, pointer: '/lights' }, tier: 'advanced', facet: 'look', rank: 18, description: `Where each ${O?.place === 'street' ? 'lamp' : 'fire'}'s light is: [{at: [x, y, z], seed}] (colour, brightness and flicker: the look)` });
  out.push({ id: `world.${T}.spawns`, group: 'world', label: 'Spawn points', type: 'json', source: { file: W, pointer: '/spawns' }, tier: 'advanced', facet: 'gameplay', rank: 17 });
  if ((w.mounds ?? []).length) out.push({ id: `world.${T}.mounds`, group: 'world', label: 'Where enemies rise', type: 'json', source: { file: W, pointer: '/mounds' }, tier: 'advanced', facet: 'gameplay', rank: 16, description: 'Emerge points: [[x, y, z]] (the wave director raises enemies at the ones 7-10 m from a player)' });
  // the hands on the first-person weapon and the cards' pictures (gf/forge/art.js)
  out.push(...artSlots(w.art, cfg?.game?.forge));
  return out;
}

const mimeOf = f => (/\.jpe?g$/i.test(f) ? 'image/jpeg' : /\.webp$/i.test(f) ? 'image/webp' : 'image/png');

/**
 * The browser: every piece and prop loaded as its slot's bytes (Studio's swaps apply), placed with its slot, the
 * textures over their pieces, the colliders and the floor limit given to the core, the fires lit, the AI attached.
 * ctx: {forge (the host), gf (gf/gf-assets.js), assets, slotIndex(id)}. → ctx.world
 */
export async function loadWorld(ctx, cfg, { only = null, ai = true, hands = true } = {}) {
  const host = ctx.forge, gf = ctx.gf, A = ctx.assets;
  const models = new Map();
  const modelOf = id => {
    if (!models.has(id)) models.set(id, (async () => { try { return await host.model(await gf.bytes(A.file(id))); } catch (e) { throw new Error(`gf-forge: ${id} (${A.has(id) ? A.file(id) : 'no such slot'}) failed to load: ${e.message}`); } })());
    return models.get(id);
  };
  const want = slot => !only || only.includes(slot);
  const instances = [];
  const put = async (slot, place, extra = {}) => { const m = await modelOf(slot); const i = host.instance(m.id, ctx.slotIndex(slot), place); instances.push({ i, slot, model: m, place, ...extra }); return i; };
  // the pieces load in parallel (each model once), then are placed in order
  await Promise.all([...new Set([...(cfg.ground?.slot && A.has(cfg.ground.slot) ? [cfg.ground.slot] : []), ...(cfg.sky?.slot && A.has(cfg.sky.slot) ? [cfg.sky.slot] : []), ...(cfg.pieces ?? []).map(p => p.slot)])].filter(want).map(modelOf));
  // what stands beyond the walls and what hangs over them is drawn in the renderer's backdrop layer (gf/forge/render.js
  // `backdrop`: no shadow, the moon and the ambient light only, the look's backdrop fog and distance)
  const backdrop = i => { try { host.forge?.instance_backdrop?.(i, true); } catch { /* an older core: drawn as any piece */ } };
  // the ground: its sheet laid edge to edge out to its reach. The file is `span` metres across with its picture
  // repeated every `tile` metres; `metres` (the tiling scale, a value slot) is the repeat a game wants: the sheet is
  // scaled by metres / tile
  if (cfg.ground?.slot && want(cfg.ground.slot) && A.has(cfg.ground.slot)) {
    const g = cfg.ground, tile = g.tile || 8, m = Math.max(1, Number(g.metres) || tile), k = m / tile, span = (g.span || tile) * k, nT = Math.min(40, Math.max(1, Math.ceil((2 * (g.reach ?? 40)) / span)));
    for (let i = 0; i < nT; i++) for (let j = 0; j < nT; j++) await put(g.slot, { at: [(i - (nT - 1) / 2) * span, g.y ?? 0, (j - (nT - 1) / 2) * span], rot: 0, scale: k }, { piece: g.piece ?? 'ground' });
  }
  // the sky's clouds: the sheet hung `height` metres up, and again a third higher, larger and turned. Each layer is
  // slid so the sheet's gap (the model's origin) is where the moon stands as the middle of the arena sees it
  // (config/look.json → moon.dir), so the moon shows through the cloud
  if (cfg.sky?.slot && want(cfg.sky.slot) && A.has(cfg.sky.slot)) {
    const sky = cfg.sky, d = (() => { const v = A.config?.('look')?.moon?.dir; return Array.isArray(v) && v.length === 3 && v.every(Number.isFinite) ? v : [0.2, 0.45, -0.87]; })();
    const len = Math.hypot(d[0], d[1], d[2]) || 1, up = Math.max(0.12, d[1] / len);
    // (the low tier hangs one layer)
    for (let k = 0, n = ctx.quality?.name === 'low' ? 1 : Math.max(1, Math.min(3, Number(sky.layers) || 1)); k < n; k++) {
      const y = Math.max(20, Number(sky.height) || 64) * (1 + 0.3 * k), t = Math.min(220, (y - 1.7) / up);
      backdrop(await put(sky.slot, { at: [(d[0] / len) * t, y, (d[2] / len) * t], rot: k * 31, scale: 1 + 0.3 * k }, { piece: sky.piece ?? 'clouds' }));
    }
  }
  const flames = [], low = ctx.quality?.name === 'low';
  for (const p of cfg.pieces ?? []) {
    if (!want(p.slot)) continue;
    // a piece marked `thin` (every second small plant) is left out on the low tier
    if (low && p.thin) continue;
    const i = await put(p.slot, p, { piece: p.piece });
    if (p.tint) host.tint(i, p.tint, 1);
    if (p.kind === 'flame') flames.push({ i, p });
    if (p.kind === 'backdrop' || p.layer === 'backdrop') backdrop(i);
  }
  const props = new Map();
  for (const p of cfg.props ?? []) {
    const slot = `prop.${p.prop}`;
    if (!want(slot)) continue;
    const i = await put(slot, p, { prop: p.prop });
    (props.get(p.prop) ?? props.set(p.prop, []).get(p.prop)).push({ at: p.at, i });
  }
  // texture slots over their pieces' own pictures (the room's stone; the arena's stone and graveyard)
  const textures = [...(cfg.texture?.slot ? [cfg.texture] : []), ...(cfg.textures ?? [])];
  const painted = [];
  for (const t of textures) {
    if (!A.has(t.slot) || !(t.on ?? []).some(s => models.has(s))) continue;
    const file = A.file(t.slot);
    const id = await host.texture(await gf.bytes(file), mimeOf(file));
    for (const s of t.on ?? []) if (models.has(s)) host.modelTexture((await models.get(s)).id, id);
    painted.push({ slot: t.slot, on: t.on ?? [], id });
  }
  if (!only) {
    for (const b of cfg.colliders ?? []) host.cmd.box(b.min, b.max);
    host.cmd.floorLimit(cfg.floorLimit ?? -10);
  }
  const [W, D] = cfg.size ?? [9, 9];
  const spawns = (cfg.spawns ?? [[0, 0.05, 0, 0]]).map(s => ({ x: s[0], y: s[1] ?? 0, z: s[2], yaw: Number.isFinite(s[3]) ? s[3] : undefined }));
  const zones = Object.fromEntries(Object.entries(cfg.zones ?? {}).map(([k, z]) => [k, { name: k, shape: z.shape, x: z.at?.[0] ?? 0, y: z.at?.[1] ?? 0, z: z.at?.[2] ?? 0, at: { x: z.at?.[0] ?? 0, y: z.at?.[1] ?? 0, z: z.at?.[2] ?? 0 }, r: z.size?.[0] ?? 1, size: z.size }]));
  const world = {
    template: cfg.template, kind: cfg.kind ?? 'forge-room', sizeClass: cfg.sizeClass,
    spawns, zones, props, instances, models, stone: painted[0]?.id ?? -1,
    // the texture slots and the model slots each paints (slots() reports them on screen where those are)
    texture: painted[0] ? { slot: painted[0].slot, on: painted[0].on, id: painted[0].id } : null,
    textures: painted,
    lights: cfg.lights ?? [],
    mounds: (cfg.mounds ?? []).map(m => ({ x: m[0], y: m[1] ?? 0, z: m[2] })),
    bounds: { min: { x: -W / 2, y: 0, z: -D / 2 }, max: { x: W / 2, y: 3, z: D / 2 } },
    spawn: i => spawns[((i % spawns.length) + spawns.length) % spawns.length] ?? { x: 0, y: 0.05, z: 0 },
    zone: name => zones[name] ?? null,
    raycast: () => null,
  };
  // the fires' flames: the frames of one loop stand in each fire and one is shown at a time, eleven a second, so a flame
  // climbs and breaks with nothing drawn but slot models (the renderer has no animated picture; boot-forge.js flickers
  // the light). Each fire is at its own place in the loop, is mirrored or not from one turn of the loop to the next, and
  // breathes a little. No frame loop and no timer of its own: world.tick(dt) rides the game's frame (ctx.onFrame) and
  // the preview's (gf/forge/show.js), so a paused game's fires stand still and tools that count frames count one loop
  world.tick = () => {};
  if (flames.length) {
    const hash = v => { const x = Math.sin(v * 12.9898) * 43758.5453; return x - Math.floor(x); };
    const fires = new Map(), shown = new Map(), FPS = 11;
    for (const f of flames) { const k = f.p.light ?? f.i; (fires.get(k) ?? fires.set(k, []).get(k)).push(f); }
    for (const set of fires.values()) set.sort((a, b) => (a.p.frame ?? 0) - (b.p.frame ?? 0));
    let clock = 0;
    world.tick = dt => {
      clock += Number.isFinite(dt) ? Math.max(0, dt) : 0;
      for (const [li, set] of fires) {
        const step = Math.floor(clock * FPS + hash(li * 7.31 + 1) * set.length), on = step % set.length;
        if (shown.get(li) === step) continue;
        shown.set(li, step);
        set.forEach((f, k) => host.visible(f.i, k === on));
        const f = set[on], sc = f.p.scale ?? 1, turn = Math.floor(step / set.length), flip = hash(li * 17.3 + turn * 3.1) < 0.5 ? 1 : -1, g = 0.94 + 0.12 * hash(li * 5.9 + step * 13.1);
        host.move(f.i, { at: f.p.at, rot: f.p.rot ?? 0, scale: [sc * flip * g, sc * (0.93 + 0.14 * hash(li * 3.7 + step * 11.9)), sc * g] });
      }
    };
    world.tick(0);
    world.flames = fires.size;
    world.flameFrames = Math.max(...[...fires.values()].map(set => set.length));
    world.flameShown = () => Object.fromEntries([...shown].map(([li, step]) => [li, step % (fires.get(li)?.length || 1)]));
  }
  if (Array.isArray(ctx.onFrame)) ctx.onFrame.push(dt => world.tick(dt));
  // the hands on the first-person weapon (gf/forge/art.js): loaded beside the world, never waited for (the weapon is
  // drawn alone until its hands are there); not in a preview subject
  world.hands = null;
  if (!only && hands && cfg.art?.hands) attachHands(ctx, cfg.art).then(h => { world.hands = h; }).catch(e => console.warn(`gf-forge: the first-person hands did not load (${e?.message ?? e})`));
  // the AI (gf/forge/ai.js): the emerge points and the grid's bounds to the core, the enemies' bodies and clips, the
  // director with the round, bots for the session (ctx.makeBot) — never in a preview subject
  if (!only && ai) ctx.ai = await attachAi(ctx, cfg, world);
  return world;
}
