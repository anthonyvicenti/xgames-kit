// gf-scenic world generation (CONTRACT §8), pure: no three.js, no DOM. create calls worldConfig(spec, opts) in Node to
// write config/world.json; the browser's world module (world.js) and the tests share every function here, and the same
// seed (the title's hash) always gives the same world.
//
// Templates (kind):
//   island   one grassy island (one per level) in a sea, a stone plaza in the middle, trees and lanterns round it
//   isles    floating islands over a void, one per level (default 3), with cliff skirts that taper to a hanging point,
//            streams that fall off the edge as waterfalls, glowing crystals, small islets drifting round each one
//   ruins    a stone arena among trees: a large paved floor, broken pillars and walls, braziers, a wood round it
//   dungeon  rooms joined by doorways (walls, torches, a dark stone floor), one room set per level, over the void
//
// A level (CONTRACT §8 "Levels") is {id, at, radius, half, last, spawns, zones: {arena, portal}, shape, plaza, paths,
// water, falls, cliff, rooms?, doors?}. Its play box (world.bounds for that level) is a square of half-size `half`
// inside the island: what the waves mechanic clamps enemies to; players walk the whole island inside its rim.
// Terrain data (folio-2025's terrain texture, Terrain.js: r paths and slabs, g grass, b water depth) is not stored:
// terrainData(cfg) computes it from the levels' shapes, plazas, paths and water, the same way in Node and the browser.

import { outlineRadius, islandSdf, roundRectSdf, polylineDistance, walkRadius, playHalf } from '../../three/world/places/shapes.js';
import { placeContext, runSteps } from '../../three/world/places/index.js';
import { RECIPES } from './recipes.js';

export const templates = ['island', 'isles', 'ruins', 'dungeon'];
// Each template in its own words (its manifest; tools/catalog.mjs reads it): what a pitch is told, and what the world
// provides to the mechanics. Every scenic world lays out levels (CONTRACT §8 "Levels"), each with an arena and a
// portal zone; `levels` says whether a level is its own place.
export const templateInfo = {
  island: { label: 'Island', describe: 'one island in the sea: cliffs, grass, trees, paths and water round it', kind: 'outdoor', levels: 'one place', provides: ['levels', 'zone:centre', 'zone:arena', 'zone:portal'] },
  isles: { label: 'Floating isles', describe: 'floating islands over a void, one per level, joined by portals; cliff skirts below', kind: 'outdoor', levels: 'one island or room set per level (the levels mechanic)', defaultLevels: 3, provides: ['levels', 'zone:centre', 'zone:arena', 'zone:portal'] },
  ruins: { label: 'Ruins', describe: 'a stone arena among ruins and trees', kind: 'outdoor', levels: 'one place', provides: ['levels', 'zone:centre', 'zone:arena', 'zone:portal'] },
  dungeon: { label: 'Dungeon', describe: 'rooms joined by doors, one room set per level', kind: 'outdoor', levels: 'one island or room set per level (the levels mechanic)', provides: ['levels', 'zone:centre', 'zone:arena', 'zone:portal'] },
};
// an island's outline radius at each size class (m)
export const SIZE_RADIUS = { small: 15, medium: 19, large: 24 };

export function hashString(s) { let h = 2166136261; for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
export function rngOf(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const r2 = v => Math.round(v * 100) / 100;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

// ---------- shapes (pure) ----------
// The island's outline and the distances to it live with the places vocabulary (gf-three kit/world/places/shapes.js,
// open builder wave 10), so the levels' recipes, the one collider list and the reach model measure an island the same
// way; re-exported here for the terrain, the loader and the tools.
export { outlineRadius, islandSdf, roundRectSdf, polylineDistance, walkRadius, playHalf };
// a cheap seeded value noise (for grass patches in the terrain data)
function valueNoise(seed) {
  const h = (i, j) => { let k = Math.imul(i, 374761393) + Math.imul(j, 668265263) + seed; k = Math.imul(k ^ (k >>> 13), 1274126177); return ((k ^ (k >>> 16)) >>> 0) / 4294967296; };
  return (x, z) => {
    const i = Math.floor(x), j = Math.floor(z), fx = x - i, fz = z - j, u = fx * fx * (3 - 2 * fx), v = fz * fz * (3 - 2 * fz);
    return h(i, j) * (1 - u) * (1 - v) + h(i + 1, j) * u * (1 - v) + h(i, j + 1) * (1 - u) * v + h(i + 1, j + 1) * u * v;
  };
}


// ---------- palettes: the world's colours (world.<t>.* slots), chosen to sit in each look ----------
const PALETTES = {
  'dusk-isle': { grass: '#2e5a33', grass2: '#4b8240', dirt: '#3b3a37', path: '#666a78', slabLow: '#454957', slabHigh: '#7f8496', cliff: '#5d5c70', cliff2: '#363546', moss: '#437a3a', water: '#2b8aa5', bed: '#13304c', foam: '#d9f4ff', fall: '#9fe9ff', sea: '#173d5c',
    leaves: { oak: ['#2f5a33', '#5c8c3f'], birch: ['#5f8a3a', '#8fb352'], cherry: ['#a35ad0', '#d796ff'], pine: ['#1f4634', '#356a43'], bush: ['#2c5530', '#4f8037'] }, flowers: ['#d9c8ff', '#ffffff', '#ffd27a', '#a8f0ff'], stone: '#6a647a', wood: '#5e4334', crystal: 'crystal' },
  'night-ruins': { grass: '#2c4a36', grass2: '#466b42', dirt: '#2f2b33', path: '#5e5a66', slabLow: '#45414c', slabHigh: '#7f7884', cliff: '#3e3f52', cliff2: '#25263a', moss: '#36573a', water: '#1e4f78', bed: '#0b1a33', foam: '#cfe0ff', fall: '#9fc4ff', sea: '#0d1d36',
    leaves: { oak: ['#23412f', '#3c6338'], birch: ['#45663a', '#6a8a4a'], cherry: ['#7a4aa0', '#a77ad0'], pine: ['#1a3a2c', '#2c5238'], bush: ['#213d2d', '#3a5e36'] }, flowers: ['#c9d4ff', '#ffffff', '#ffe0a0'], stone: '#5a5d72', wood: '#4a3a33', crystal: 'crystal' },
  'golden-meadow': { grass: '#a7a332', grass2: '#d0c346', dirt: '#8a5e3c', path: '#d9b48a', slabLow: '#a87762', slabHigh: '#ffcf8b', cliff: '#9c7a68', cliff2: '#6e5148', moss: '#9a9a35', water: '#4fb8b0', bed: '#1f4f6a', foam: '#ffffff', fall: '#c8f4ff', sea: '#2f7f95',
    leaves: { oak: ['#b4b536', '#d8cf3b'], birch: ['#ff4f2b', '#ff903f'], cherry: ['#ff6d6d', '#ff9990'], pine: ['#5f7a35', '#8a9a40'], bush: ['#b4b536', '#d8cf3b'] }, flowers: ['#ffffff', '#fff2c0', '#ffb0c8'], stone: '#c9a58a', wood: '#8a5a3c', crystal: 'crystal' },
  'storm-coast': { grass: '#4a6447', grass2: '#6a8057', dirt: '#4f4a46', path: '#8a8e96', slabLow: '#5a5e68', slabHigh: '#9aa0aa', cliff: '#5e6470', cliff2: '#3d424c', moss: '#4f6a48', water: '#3f7f95', bed: '#1a2f40', foam: '#e8f4ff', fall: '#cfe8ff', sea: '#2a4a5c',
    leaves: { oak: ['#3f5a3c', '#5f7a4a'], birch: ['#6a7f45', '#8f9f5a'], cherry: ['#a06a8a', '#c890aa'], pine: ['#2f4a3c', '#466246'], bush: ['#3a5238', '#566e45'] }, flowers: ['#e8eeff', '#ffffff'], stone: '#7a7f8a', wood: '#5e4a3e', crystal: 'crystal' },
  'clear-day': { grass: '#8fb33a', grass2: '#b8c84a', dirt: '#a07a52', path: '#e0c49a', slabLow: '#a87762', slabHigh: '#ffcf8b', cliff: '#8a7f8f', cliff2: '#5f5668', moss: '#7fa83a', water: '#5bc2b9', bed: '#13375f', foam: '#ffffff', fall: '#d4f6ff', sea: '#3fa6c0',
    leaves: { oak: ['#7fa52e', '#b4c83a'], birch: ['#ff4f2b', '#ff903f'], cherry: ['#ff6d6d', '#ff9990'], pine: ['#3f6a35', '#5f8a40'], bush: ['#7fa52e', '#a8bd3a'] }, flowers: ['#ffffff', '#fff2c0', '#ffc0d8'], stone: '#b8a79a', wood: '#8a5a3c', crystal: 'crystal' },
};
export const palettes = PALETTES;
// the looks whose plazas carry glowing rune lines (the creator's reference art); a world.<t>.runes slot turns them on or off
const RUNES = new Set(['dusk-isle', 'night-ruins']);
export function paletteFor(preset) { return JSON.parse(JSON.stringify(PALETTES[preset] ?? PALETTES['dusk-isle'])); }

/** How many levels the spec asks for: the levels mechanic's `count`, else rules.params.levels, else the template's own
 *  default (templateInfo.<id>.defaultLevels), else 1. */
export function levelCount(spec) {
  const m = (spec.mechanics ?? []).find(x => x.id === 'levels');
  const n = Number(m?.params?.count ?? spec.rules?.params?.levels ?? templateInfo[spec.world?.template]?.defaultLevels ?? 1);
  return Math.max(1, Math.min(8, Math.round(n) || 1));
}

// ---------- island levels: recipes of the places vocabulary ----------
// Each island level (island, isles, ruins) is laid out by its recipe (recipes.js) over the world's one random stream:
// its island, plaza, portal, paths, spawns, zones and water, then its dressing (trees, bushes, flowers, lanterns,
// stones, rocks, a camp, crystals; islets and loose rocks round a floating one). Until open builder wave 10 this was
// code here (islandLevel and dress, a branch per template); the recipes take their random numbers in the same order.
const DIAG = [Math.SQRT1_2, Math.SQRT1_2];   // the follow camera looks along +x+z: "up the screen"

// ---------- dungeon rooms (KayKit Dungeon Remastered's 3 m modules, in the asset library's kaykit-dungeon-remastered pack) ----------
const M = 3;   // one wall or floor module
// room sizes per size class (all multiples of one module, an odd count of modules so a doorway has a middle one); the
// cell pitch keeps a one-module corridor between the hall and a side room. area = the class's range in m² (the same
// numbers as kit/world/generate.js SIZE_CLASSES, which check 17 holds a dungeon to)
const DUNGEON_SIZES = {
  small: { hall: 15, side: 9, pitch: 15, area: [350, 950], step: 44 },
  medium: { hall: 15, side: 9, pitch: 15, area: [1000, 1800], step: 44 },
  large: { hall: 21, side: 15, pitch: 21, area: [1900, 3200], step: 64 },
};
function dungeonLevel(i, L, at, rng, opts) {
  const [cx, , cz] = at;
  // the hall (the arena) in the middle of a 3 x 2 grid of cells, side rooms round it; every edge sits on the 1.5 m
  // half-module grid and every doorway in the middle module of its wall. The size class (small 350-950 m², medium
  // 1000-1800, large 1900-3200: the rectangle round the room set) picks the room sizes, and then WHICH side rooms:
  // a seeded pick among the sets (3 or 4 of the five cells round the hall; a back-row room needs the one in front of
  // it) whose rectangle lands inside the class.
  const sz = DUNGEON_SIZES[opts.size] ?? DUNGEON_SIZES.medium, H = sz.hall, S = sz.side, P = sz.pitch;
  const cand = [[0, 0], [2, 0], [1, 1], [0, 1], [2, 1]];
  const sets = [];
  for (let m = 1; m < 32; m++) {
    const pick = cand.filter((_, k) => m & (1 << k));
    if (pick.length < 3 || pick.length > 4) continue;
    if (pick.some(c => c[1] === 1 && c[0] !== 1 && !pick.some(o => o[0] === c[0] && o[1] === 0))) continue;
    const left = Math.min(-H / 2, ...pick.map(c => (c[0] - 1) * P - S / 2)), right = Math.max(H / 2, ...pick.map(c => (c[0] - 1) * P + S / 2));
    const front = Math.max(H / 2, ...pick.map(c => (c[1] === 0 ? 0 : P) + S / 2));
    sets.push({ pick, area: (right - left) * (front + H / 2) });
  }
  const inClass = sets.filter(s => s.area >= sz.area[0] && s.area <= sz.area[1]);
  const pool = inClass.length ? inClass : [sets.reduce((b, s) => (Math.abs(s.area - (sz.area[0] + sz.area[1]) / 2) < Math.abs(b.area - (sz.area[0] + sz.area[1]) / 2) ? s : b))];
  const chosen = pool[Math.floor(rng() * pool.length)];
  const order = [[1, 0], ...chosen.pick];
  const count = order.length;
  const rooms = [];
  for (let k = 0; k < count; k++) {
    const [gx, gz] = order[k], main = k === 0, w = main ? H : S;
    const x = cx + (gx - 1) * P, z = cz + (gz === 0 ? 0 : P);
    rooms.push({ id: main ? 'hall' : `room-${k}`, main, grid: [gx, gz], rect: [x - w / 2, z - w / 2, x + w / 2, z + w / 2] });
  }
  const byGrid = (gx, gz) => rooms.find(r => r.grid[0] === gx && r.grid[1] === gz);
  const centre = r => [(r.rect[0] + r.rect[2]) / 2, (r.rect[1] + r.rect[3]) / 2];
  const doors = [];
  for (const r of rooms.slice(1)) {
    const [gx, gz] = r.grid;
    const to = gz === 0 ? rooms[0] : (byGrid(gx, 0) ?? rooms[0]);
    const [ax, az] = centre(r), [bx, bz] = centre(to);
    doors.push({ rooms: [r.id, to.id], horiz: gz === to.grid[1], from: [ax, az], to: [bx, bz], width: M });
  }
  const xs = rooms.flatMap(r => [r.rect[0], r.rect[2]]), zs = rooms.flatMap(r => [r.rect[1], r.rect[3]]);
  const box = [Math.min(...xs) - 1, Math.min(...zs) - 1, Math.max(...xs) + 1, Math.max(...zs) + 1];
  const hall = rooms[0], [hx, hz] = centre(hall);
  const far = rooms.slice(1).reduce((b, r) => { const [x, z] = centre(r); const sc = (x - cx) * DIAG[0] + (z - cz) * DIAG[1]; return !b || sc > b.s ? { r, s: sc } : b; }, null)?.r ?? hall;
  const portal = centre(far);
  const n0 = opts.players ?? 4;
  const spawns = Array.from({ length: n0 }, (_, k) => [r2(hx - 4.2 + (k % 2) * 1.6), 0, r2(hz - 4.2 + Math.floor(k / 2) * 1.6)]);
  return {
    id: `level-${i + 1}`, at, radius: r2(Math.hypot(box[2] - box[0], box[3] - box[1]) / 2), half: r2(Math.max(box[2] - box[0], box[3] - box[1]) / 2), last: i === L - 1,
    box: box.map(r2), rooms, doors, spawns, tiles: true,
    zones: { arena: { shape: 'circle', at: [r2(hx), 0, r2(hz)], size: [6] }, portal: { shape: 'circle', at: [r2(portal[0]), 0, r2(portal[1])], size: [2.2] } },
    cliff: { depth: opts.depth, kind: 'float' },
  };
}

/** A dungeon level's KayKit pieces: floor tiles, walls with doorways (their doors open), low walls on the camera's
 *  side, corridors, wall torches, banners, and barrels, crates and chests in the corners. */
function dressDungeon(lv, rng, out) {
  const P = (prop, x, z, rot = 0, { y = 0, ...extra } = {}) => (/torch-wall|banner/.test(prop) ? out.fixtures : out.props).push({ prop, at: [r2(x), y, r2(z)], rot, scale: 1, level: lv.id, ...extra });
  const doorOn = (r, side) => lv.doors.find(d => d.rooms.includes(r.id) && (() => {
    const o = d.rooms[0] === r.id ? d.to : d.from, [x, z] = [(r.rect[0] + r.rect[2]) / 2, (r.rect[1] + r.rect[3]) / 2];
    return side === 'n' ? o[1] > z + 1 && d.horiz === false : side === 's' ? o[1] < z - 1 && d.horiz === false : side === 'e' ? o[0] > x + 1 && d.horiz : o[0] < x - 1 && d.horiz;
  })());
  const banners = ['dungeon-banner-green', 'dungeon-banner-blue', 'dungeon-banner-red'];
  const posts = new Set();
  const post = (x, z) => { const k = `${Math.round(x * 2)},${Math.round(z * 2)}`; if (!posts.has(k)) { posts.add(k); P('dungeon-column', x, z, 0); } };
  for (const r of lv.rooms) {
    const [x0, z0, x1, z1] = r.rect, w = x1 - x0, n = Math.round(w / M);
    for (let a = 0; a < n; a++) for (let b = 0; b < n; b++) P('dungeon-floor', x0 + M / 2 + a * M, z0 + M / 2 + b * M);
    // edges: s (z0, faces +z), n (z1, faces -z), w (x0, faces +x), e (x1, faces -x); s and w face the camera: low
    const edges = [['s', 0, (k) => [x0 + M / 2 + k * M, z0]], ['n', 180, (k) => [x0 + M / 2 + k * M, z1]], ['w', 90, (k) => [x0, z0 + M / 2 + k * M]], ['e', -90, (k) => [x1, z0 + M / 2 + k * M]]];
    for (const [side, rot, at] of edges) {
      const door = doorOn(r, side), low = side === 's' || side === 'w', mid = Math.floor(n / 2);
      for (let k = 0; k < n; k++) {
        const [x, z] = at(k);
        if (door && k === mid) { if (!low) P('dungeon-doorway', x, z, rot, { open: true }); continue; }
        if (low) { P('dungeon-barrier', x, z, rot); if (k > 0) post(...at(k - 0.5)); }
        else {
          P(rng() < 0.15 ? 'dungeon-wall-cracked' : 'dungeon-wall', x, z, rot);
          if (k % 2 === 1 && !(door && Math.abs(k - mid) === 1)) P('dungeon-torch-wall', x + (side === 'e' ? -0.375 : 0), z + (side === 'n' ? -0.375 : 0), rot, { y: 1.55 });
          else if (r.main && k % 2 === 0 && k !== mid) P(banners[k % banners.length], x, z, rot);
        }
      }
      // corner posts on the low sides
      if (low) { post(...at(-0.5)); post(...at(n - 0.5)); }
    }
    // the corners: a barrel, crates or a chest (not in the hall, where everyone fights)
    if (!r.main) {
      // each piece is placed by its own footprint: the wall's face (a cracked wall is 0.945 m thick, so 0.48 m reaches in
      // from the wall line) + the piece's half-extent (it may turn by a quarter) + 0.2 m, so no corner piece touches a wall
      const decor = [['dungeon-barrel', 1.35], ['dungeon-crates', 1.687], ['dungeon-keg', 1.5], ['dungeon-crate', 1.125], ['dungeon-barrels', 1.388]];
      const corners = [[1, 1], [-1, 1], [1, -1]];   // [x side, z side]: the three corners the camera does not look past
      corners.forEach(([sx, sz]) => {
        if (rng() >= 0.7) return;
        const [prop, ext] = decor[Math.floor(rng() * decor.length)], inset = 0.48 + ext / 2 + 0.2;
        P(prop, sx > 0 ? x1 - inset : x0 + inset, sz > 0 ? z1 - inset : z0 + inset, Math.round(rng() * 4) * 90);
      });
    }
  }
  // corridors: floor tiles and side walls across the gap between two rooms
  for (const d of lv.doors) {
    const ra = lv.rooms.find(r => r.id === d.rooms[0]), rb = lv.rooms.find(r => r.id === d.rooms[1]);
    if (d.horiz) {
      const [l, r] = ra.rect[2] < rb.rect[0] ? [ra.rect[2], rb.rect[0]] : [rb.rect[2], ra.rect[0]];
      for (let x = l + M / 2; x < r; x += M) { P('dungeon-floor', x, d.from[1]); P('dungeon-wall', x, d.from[1] + M / 2, 180); P('dungeon-barrier', x, d.from[1] - M / 2, 0); }
    } else {
      const [l, r] = ra.rect[3] < rb.rect[1] ? [ra.rect[3], rb.rect[1]] : [rb.rect[3], ra.rect[1]];
      for (let z = l + M / 2; z < r; z += M) { P('dungeon-floor', d.from[0], z); P('dungeon-wall', d.from[0] + M / 2, z, -90); P('dungeon-barrier', d.from[0] - M / 2, z, 90); }
    }
  }
  const last = lv.rooms.find(r => { const [x, z] = [(r.rect[0] + r.rect[2]) / 2, (r.rect[1] + r.rect[3]) / 2]; return Math.hypot(x - lv.zones.portal.at[0], z - lv.zones.portal.at[2]) < 1; });
  if (last) P('dungeon-chest-gold', last.rect[0] + 1.7, last.rect[1] + 1.9, 45);
}

/**
 * spec → config/world.json. opts (from gf-three's spec-config): {spawns, notes, assets, propFiles, named}; assets and
 * propFiles are filled with the folio models the layout uses (the asset library's folio-nature pack, MIT).
 */
export async function worldConfig(spec, opts = {}) {
  const { notes = [] } = opts;
  const T = templates.includes(spec.world?.template) ? spec.world.template : 'island';
  const size = spec.world?.size ?? 'medium';
  const R = SIZE_RADIUS[size] ?? SIZE_RADIUS.medium;
  const seed = hashString(`${spec.title}|world`);
  const preset = spec.look?.preset ?? 'dusk-isle';
  const cfg = generate({ template: T, size, seed, levels: levelCount(spec), players: Math.max(4, spec.players?.max ?? 4), preset });
  notes.push(`world: scenic ${T} at size ${size}, ${cfg.levels.length} level(s), island radius ${R} m, play box ${cfg.levels.map(l => (l.half * 2).toFixed(0)).join('/')} m (seed ${seed})`);
  if (spec.world?.props?.length) notes.push(`world: the scenic world dresses itself (trees, lanterns, crystals, rocks); the spec's props (${spec.world.props.map(p => p.name).join(', ')}) are placed by the game's mechanics or rules`);
  if (spec.world?.notes) cfg.notes = spec.world.notes;
  await attachCatalog(cfg, opts);
  return cfg;
}

/** The whole layout for a template, size, seed and level count. Pure. */
export function generate({ template = 'isles', size = 'medium', seed = 1, levels = null, players = 4, preset = 'dusk-isle' } = {}) {
  const T = templates.includes(template) ? template : 'island';
  const R = SIZE_RADIUS[size] ?? SIZE_RADIUS.medium;
  const rng = rngOf(seed);
  const L = Math.max(1, Math.min(8, levels ?? templateInfo[T]?.defaultLevels ?? 1));
  const isVoid = T !== 'island';
  const depth = T === 'dungeon' ? 9 : r2(R * 0.85);
  const pal = paletteFor(preset);
  // levels: the first at the origin, each next one on up the screen (+x+z) and a little to the side
  const gap = T === 'dungeon' ? 26 : 24;
  const step = (T === 'dungeon' ? (DUNGEON_SIZES[size] ?? DUNGEON_SIZES.medium).step : R * 2) + gap;
  const ats = Array.from({ length: L }, (_, i) => [r2(i * step * 0.82), 0, r2(i * step * 0.57)]);
  const out = {
    template: T, kind: T, size, seed, preset, void: isVoid, sizeClass: size,
    ground: { grass: pal.grass, grass2: pal.grass2, dirt: pal.dirt, path: pal.path, slabLow: pal.slabLow, slabHigh: pal.slabHigh, cliff: pal.cliff, cliff2: pal.cliff2, moss: pal.moss, slabs: { file: 'assets/textures/slabs.png', size: 5.7 } },
    water: { color: pal.water, bed: pal.bed, foam: pal.foam, fall: pal.fall, depth: 0.45, ...(isVoid ? {} : { sea: pal.sea, seaLevel: -0.55 }) },
    foliage: { ...pal.leaves, texture: 'assets/textures/foliage-sdf.png' },
    flowers: pal.flowers,
    stone: pal.stone,
    wood: pal.wood,
    grass: { density: 1, height: 0.55, width: 0.1 },
    runes: RUNES.has(preset),
    levels: [], props: [], fixtures: [], structures: [], crystals: [], islets: [], floaters: [],
    vegetation: { trees: [], bushes: [], flowers: [] },
  };
  for (let i = 0; i < L; i++) {
    if (T !== 'dungeon') {
      // an island level: its recipe's steps over the world's one stream (places vocabulary; recipes.js)
      const lv = { id: `level-${i + 1}`, at: ats[i], radius: R, last: i === L - 1 };
      const P = placeContext({ recipe: RECIPES[T], size: SIZE_RADIUS[size] ? size : 'medium', seed, players, preset, R: rng, out });
      Object.assign(P.vars, { R, depth });
      Object.assign(P, { level: lv, next: ats[i + 1] ?? null, index: i });
      runSteps(P, RECIPES[T].level);
      out.levels.push(lv);
    } else {
      const lv = dungeonLevel(i, L, ats[i], rng, { players, depth, size });
      out.levels.push(lv);
      dressDungeon(lv, rng, out);
      const p = lv.zones.portal.at;
      out.crystals.push({ at: [r2(p[0] + 2.2), 0, r2(p[2] - 2.2)], rot: 0, scale: 1, glow: 'crystal', level: lv.id }, { at: [r2(p[0] - 2.2), 0, r2(p[2] + 2.2)], rot: 0, scale: 0.8, glow: 'rune', level: lv.id });
    }
  }
  const first = out.levels[0];
  out.radius = R; out.half = first.half;
  out.spawns = first.spawns;
  out.zones = { centre: { shape: 'circle', at: [first.at[0], 0, first.at[2]], size: [2] } };
  // the terrain data's extent (folio's terrain texture): every island, 0.25 m a texel
  out.terrain = terrainExtent(out);
  return out;
}

/** The world box the terrain data covers: [x0, z0, x1, z1] and the texel size. */
export function terrainExtent(cfg) {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const lv of cfg.levels) {
    const r = lv.box ? 0 : lv.radius * 1.25 + 2;
    const b = lv.box ?? [lv.at[0] - r, lv.at[2] - r, lv.at[0] + r, lv.at[2] + r];
    x0 = Math.min(x0, b[0]); z0 = Math.min(z0, b[1]); x1 = Math.max(x1, b[2]); z1 = Math.max(z1, b[3]);
  }
  const span = Math.max(x1 - x0, z1 - z0);
  const texel = Math.max(0.25, span / 1024);
  return { box: [r2(x0), r2(z0), r2(x1), r2(z1)], texel: r2(texel) };
}

/**
 * folio-2025's terrain data, computed: an RGBA8 grid over cfg.terrain.box. r = path and slab (stone floor), g = grass,
 * b = water depth (0 dry, 1 deepest), a = 255 on an island (0 in the void or the sea). The glowing rune lines are drawn
 * by the floor shader from the levels' plazas and portals (terrain.js runeNode). → {data, width, height, box, texel}
 */
export function terrainData(cfg) {
  const { box, texel } = cfg.terrain ?? terrainExtent(cfg);
  const W = Math.max(2, Math.ceil((box[2] - box[0]) / texel)), H = Math.max(2, Math.ceil((box[3] - box[1]) / texel));
  const data = new Uint8Array(W * H * 4);
  const noise = valueNoise((cfg.seed ?? 1) | 0);
  for (const lv of cfg.levels) {
    const isl = !lv.box;
    const reach = isl ? lv.radius * 1.25 + 1 : 0;
    const bx = isl ? [lv.at[0] - reach, lv.at[2] - reach, lv.at[0] + reach, lv.at[2] + reach] : lv.box;
    const i0 = Math.max(0, Math.floor((bx[0] - box[0]) / texel)), i1 = Math.min(W - 1, Math.ceil((bx[2] - box[0]) / texel));
    const j0 = Math.max(0, Math.floor((bx[1] - box[1]) / texel)), j1 = Math.min(H - 1, Math.ceil((bx[3] - box[1]) / texel));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const x = box[0] + (i + 0.5) * texel, z = box[1] + (j + 0.5) * texel;
      let r = 0, g = 0, b = 0, a = 0;
      if (isl) {
        const sd = islandSdf(lv, x, z);
        if (sd > 0.6) continue;
        a = 1;
        // grass everywhere on the island, thinner in patches and toward the very edge
        const n = noise(x * 0.18, z * 0.18) * 0.65 + noise(x * 0.6 + 31, z * 0.6 + 7) * 0.35;
        g = smooth(0.08, 0.4, n) * smooth(0.4, -1.2, sd);
        // the plaza (crisp stone), paths (stone that breaks up at its sides)
        const pl = roundRectSdf(lv.plaza, x, z);
        r = Math.max(r, smooth(0.25, -0.25, pl));
        for (const p of lv.paths ?? []) { const d = polylineDistance(p.points, x, z) - p.width / 2; r = Math.max(r, smooth(0.45, -0.35, d + (n - 0.5) * 0.9)); }
        // water: the pond and the stream, deeper in the middle
        for (const w of lv.water ?? []) {
          const dp = Math.hypot(x - w.pond.at[0], z - w.pond.at[1]) - w.pond.radius;
          const ds = polylineDistance(w.stream.points, x, z) - w.stream.width / 2;
          const d = Math.min(dp, ds);
          b = Math.max(b, smooth(0.35, -1.4, d + (n - 0.5) * 0.5));
        }
        g *= 1 - r; g *= 1 - smooth(0.02, 0.2, b); r *= 1 - smooth(0.02, 0.15, b);
        a = 1;
      } else {
        // dungeon: stone floor in the rooms and the corridors, no grass
        const inRoom = lv.rooms.some(rm => x >= rm.rect[0] && x <= rm.rect[2] && z >= rm.rect[1] && z <= rm.rect[3]);
        const inDoor = (lv.doors ?? []).some(d => polylineDistance([d.from, d.to], x, z) < d.width / 2 + 0.2);
        if (!inRoom && !inDoor) continue;
        a = 1; r = 1;
      }
      const k = (j * W + i) * 4;
      data[k] = Math.max(data[k], Math.round(r * 255)); data[k + 1] = Math.max(data[k + 1], Math.round(g * 255)); data[k + 2] = Math.max(data[k + 2], Math.round(b * 255)); data[k + 3] = Math.max(data[k + 3], Math.round(a * 255));
    }
  }
  return { data, width: W, height: H, box, texel };
}

// ---------- the prop catalog (config/props.json) and the files a game gets ----------
// The asset library (the repository's library/packs, the scenic profile's packs named in its art.json) is read in Node
// by attachCatalog (create); the browser reads the game's config/props.json. Kept out of the pure functions above so
// they stay importable anywhere.
let CATALOG = null;
async function readCatalog() {
  if (CATALOG) return CATALOG;
  const V = await import(new URL('../../../../../../builder/art/views.mjs', import.meta.url).href);
  const licence = a => { const l = V.licenceOf(a); return { spdx: l.spdx, author: l.author, url: l.url }; };
  const entries = new Map();
  for (const a of V.assetsIn('scenic', { category: 'prop' })) { const file = V.localFile(a); if (file) entries.set(a.id, { ...V.propEntry(a), path: file, license: licence(a) }); }
  const picture = id => { const a = V.findAsset(id, 'scenic', { anywhere: false }); return a && V.localFile(a) ? { path: V.localFile(a), license: licence(a) } : null; };
  CATALOG = { entries, picture };
  return CATALOG;
}
// the folio models every scenic world loads (trees and the shared textures), whatever it places
const ALWAYS = ['tree-oak', 'tree-birch', 'tree-cherry'];

/** create's half: config/props.json (the catalog entries the layout uses) and the model and texture files to copy. */
export async function attachCatalog(cfg, opts = {}) {
  cfg.__catalog = { schema: 'gf-scenic-props/1', about: 'The asset library\'s props this world uses (folio-2025 pieces, MIT; KayKit Dungeon modules, CC0), each with its licence and its library ref.', props: [] };
  {
    const { entries, picture } = await readCatalog();
    const used = new Set([...ALWAYS, ...cfg.props.map(p => p.prop), ...(cfg.fixtures ?? []).map(p => p.prop)]);
    for (const id of [...used].sort()) {
      const e = entries.get(id);
      if (!e) { opts.notes?.push(`world: prop "${id}" is not in the scenic profile's packs of the asset library; left out`); cfg.props = cfg.props.filter(p => p.prop !== id); cfg.fixtures = (cfg.fixtures ?? []).filter(p => p.prop !== id); continue; }
      const { path: from, ...entry } = e;
      // a flat floor tile carries no collider of its own: the world puts one floor under each room and corridor
      const flat = (e.tags ?? []).some(t => t === 'floor' || t === 'tile') && (e.size?.[1] ?? 1) < 0.2;
      cfg.__catalog.props.push(flat ? { ...entry, collider: 'none' } : entry);
      const to = `assets/models/${id}.glb`, license = e.license;
      if (opts.assets && !opts.assets.some(a => a.to === to)) opts.assets.push({ to, from, license });
      if (opts.propFiles) opts.propFiles[id] ??= { file: to, from: `library:${e.ref}`, license };
    }
    for (const [to, id] of [['assets/textures/slabs.png', 'slabs'], ['assets/textures/foliage-sdf.png', 'foliage-sdf']]) {
      const pic = picture(id);
      if (pic && opts.assets && !opts.assets.some(a => a.to === to)) opts.assets.push({ to, from: pic.path, license: pic.license });
    }
  }
  return cfg;
}
