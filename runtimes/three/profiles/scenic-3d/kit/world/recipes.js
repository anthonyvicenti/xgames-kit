// The scenic-3d profile's island levels as recipes of the places vocabulary (gf-three kit/world/places/, open builder wave
// 10, track H; the places spike's recipes). generate.js lays out the levels (where each one is, the palette, the
// terrain) and runs one level's steps for each island level over the world's one random stream; the steps take their
// random numbers in the order islandLevel and dress took them before, so every world is the same, byte for byte
// (research/gf-three/tests/d-places.test.mjs). Data in a module so the browser and Node load it with no fetch.
//
// A level's steps: its island (a superellipse with a seeded wobble), plaza, portal, paths, spawns and zones, its water,
// then its dressing: trees, bushes and flowers picked at random spots that keep clear of the plaza, the paths, the
// water and the spawns; lanterns, lights, stones, benches, rocks, a camp and crystals; on a floating level, islets
// and loose rocks. Quantities: R (the island's radius), half (its play box), plazaHalf, depth (its rock).
const base = (n, plazaShare, cornerShare) => [
  { do: 'island', n, wobble: 4, rimInset: 1.2 },
  { do: 'plaza', half: { $: 'half', mul: plazaShare, clamp: [4, 11] }, corner: { $: 'plazaHalf', mul: cornerShare } },
  { do: 'portal', distance: { $: 'half', add: -2.6, min: 4 } },
  { do: 'paths', list: [{ width: 2.2, from: 'rim-back', to: 'plaza-back' }, { width: 2.4, from: 'plaza-on', to: 'portal' }] },
  { do: 'spawn-line', distance: { $: 'plazaHalf', add: 1.5, max: { $: 'half', add: -2.5 }, min: 3 }, spacing: 1.6 },
  { do: 'arena-zones', arena: { $: 'half', add: -1 }, portal: 2.2 },
];
const trees = (cycle, mul, band) => ({ do: 'pick', into: 'trees', count: { $: 'R', mul }, prop: { cycle }, rot: 'any', scale: { byProp: { pine: 0.75, else: 0.55 }, rand: 0.35 }, keep: 1.6,
  where: [['sdf', '<', -1.6], ...(band ? [['sdf', '>', -7]] : []), ['plaza', 2.5], ['path', 1.4], ['water', 1.2], ['spawn', 3], ['taken', 2.6], ['or', ['box', 2.5, 'out'], ['chance', 0.12]]] });
const bushes = { do: 'pick', into: 'bushes', count: { $: 'R', mul: 1.3 }, order: ['spot', 'scale'], scale: { base: 0.75, rand: 0.7 }, keep: 0.7, where: [['sdf', '<', -0.6], ['sdf', '>', -6], ['plaza', 1], ['path', 0.6], ['water', 0.4], ['spawn', 2], ['taken', 0.9]] };
const flowers = { do: 'pick', into: 'flowers', count: { $: 'R', mul: 1.4 }, order: ['spot', 'scale'], scale: { base: 0.7, rand: 0.5 }, where: [['sdf', '<', -1], ['plaza', 0.8], ['path', 0.4], ['water', 0.4]] };
const lanterns = { do: 'put', prop: 'lantern', rot: 'any', scale: 0.8, keep: 0.8, spots: { corners: { out: { $: 'plazaHalf', add: 0.8 }, order: [[1, 1], [1, -1], [-1, 1], [-1, -1]] } }, when: [['path', 0.3], ['spawn', 1.6]] };
const poleLights = { do: 'put', prop: 'pole-light', rot: 'any', scale: 0.8, keep: 0.6, spots: { along: { from: 0.3, to: 0.95, every: 0.45, out: 0.7 } }, when: [['sdf', '<', -0.8], ['taken', 0.8], ['plaza', 0.6]] };
const runeCrystals = { do: 'put', into: 'crystals', rot: 'any', scale: 1.15, keep: 0.9, glow: { every: 2, at: 1, then: 'rune', else: 'crystal' }, spots: { corners: { out: { $: 'plazaHalf', add: 2.5 }, order: [[1, 1], [-1, -1], [1, -1], [-1, 1]] } }, when: [['runes'], ['sdf', '<', -1], ['path', 0.8], ['taken', 0.8], ['spawn', 1.6]] };
const borderStones = { do: 'put', prop: 'dungeon-column', rot: 0, scale: 1.25, keep: 0.5, spots: { corners: { out: { $: 'plazaHalf', add: 0.45 }, order: [[1, 1], [1, -1], [-1, 1], [-1, -1], [1, 0], [-1, 0], [0, 1], [0, -1]] } }, when: [['path', 0.5], ['taken', 0.5], ['spawn', 1]] };
const benches = { do: 'put', prop: 'bench', rot: 'face-out', scale: 0.62, keep: 1.2, spots: { round: { count: 2, out: { $: 'plazaHalf', add: 2.2 } } }, when: [['path', 1], ['taken', 1.2], ['spawn', 2]] };
const rocks = { do: 'pick', count: { $: 'R', mul: 0.35 }, order: ['prop', 'scale', 'foot', 'spot', 'rot'], prop: { pattern: 'rock-{n}', from: 1, count: 3 }, scale: { base: 0.22, rand: 0.22 }, foot: { 'rock-1': 5.6, 'rock-2': 3.8, 'rock-3': 4.5 }, rot: 'any', keep: 'foot',
  where: [['sdf', '<', { foot: -0.6 }], ['sdf', '>', -6], ['plaza', { foot: 1, add: 0.5 }], ['path', { foot: 1 }], ['water', { foot: 1 }], ['spawn', { foot: 1, add: 2 }], ['taken', { foot: 1, add: 0.4 }]] };
const camp = { do: 'put', keep: 1.8, spots: { flip: { x: { $: 'plazaHalf', add: 2 }, z: { $: 'plazaHalf', mul: 0.4 } } }, when: [['sdf', '<', -2], ['path', 1], ['water', 1], ['taken', 1.6], ['spawn', 2]],
  group: [{ prop: 'dungeon-barrel', rot: 'any', scale: 0.75 }, { prop: 'dungeon-crates', at: [0.9, 0, 1.1], rot: 'any', scale: 0.75 }] };
const crystals = count => ({ do: 'pick', into: 'crystals', count, tries: 120, order: ['spot', 'rot', 'scale'], rot: 'any', scale: { base: 0.9, rand: 0.9 }, keep: 1, glow: { every: 3, at: 2, then: 'rune', else: 'crystal' },
  where: [['sdf', '<', -0.8], ['sdf', '>', -7], ['plaza', 1], ['path', 0.8], ['water', 0.6], ['taken', 1.2], ['spawn', 2.5]] });
const portalPair = { do: 'put', into: 'crystals', rot: 'any', scale: 1.35, keep: 1, glow: { side: ['crystal', 'rune'] }, spots: { beside: { zone: 'portal', sides: [-1, 1], out: 3.1 } }, when: [['sdf', '<', -0.6]] };
const floating = [{ do: 'islets', count: [4, 3] }, { do: 'floaters', count: 7 }];

export const RECIPES = {
  island: {
    place: 'island', profile: 'scenic-3d', rng: 'scenic',
    about: 'one grassy island in a sea: a stone plaza, paths, a pond and a stream, trees, lanterns, a camp and crystals',
    level: [...base(5, 0.48, 0.32), { do: 'water' }, trees(['oak', 'birch', 'cherry', 'pine'], 0.8, false), bushes, flowers, lanterns, poleLights, runeCrystals, borderStones, benches, rocks, camp, crystals(3), portalPair],
  },
  isles: {
    place: 'isles', profile: 'scenic-3d', rng: 'scenic',
    about: 'floating islands over a void, one per level, with islets and loose rocks round each',
    level: [...base(5, 0.48, 0.32), { do: 'water' }, trees(['pine', 'oak', 'pine', 'cherry'], 0.62, true), bushes, flowers, lanterns, poleLights, runeCrystals, borderStones, rocks, camp, crystals(6), portalPair, ...floating],
  },
  ruins: {
    place: 'ruins', profile: 'scenic-3d', rng: 'scenic',
    about: 'a stone arena among ruins and trees on a floating island: pillars round the plaza, broken walls, torches',
    level: [...base(4.2, 0.62, 0.15), { do: 'water', when: 'even-levels' }, trees(['oak', 'pine', 'birch', 'oak'], 0.95, false), bushes, flowers, lanterns, poleLights, benches, rocks,
      { do: 'put', prop: { chain: [['dungeon-column', 0.3], ['dungeon-pillar-decorated', 0.4], ['dungeon-pillar']] }, rot: 'quarter', scale: 1, keep: 1, spots: { ring: { n: 10, phase: 0.2, r: { $: 'plazaHalf', add: 1.6 } } }, when: [['path', 0.8], ['spawn', 2], ['taken', 0.9]] },
      { do: 'pick', count: 5, prop: { cycle: ['dungeon-wall-broken', 'dungeon-wall-cracked', 'dungeon-rubble-small'] }, rot: 'quarter-jitter', scale: 1, keep: 2.2, order: ['spot', 'prop', 'rot', 'scale'], where: [['sdf', '<', -2.2], ['box', -1, 'out'], ['plaza', 2], ['path', 1.6], ['water', 1.5], ['taken', 2.4]] },
      { do: 'put', prop: 'dungeon-torch', rot: 0, scale: 1.4, keep: 0.5, spots: { corners: { out: { $: 'plazaHalf', add: -0.9 }, order: [[1, 1], [-1, 1], [1, -1], [-1, -1]] } }, when: [['path', 0.4], ['taken', 0.6], ['spawn', 1.2]] },
      crystals(4), portalPair, ...floating],
  },
};
