// The set-dressing lint (track L): checks a world layout the way a careful level dresser would, with no browser.
// Pure apart from loadSubject (reads the JSON files). Used by tools/dressing.mjs and tests/l-dressing.test.mjs.
//
//   const subject = await loadSubject('plaza' | '<game dir>' | '<layout.json>', { look: 'jelly-pastel' });
//   const report  = lintDressing(subject);   // { ok, errors, warnings, problems: [{ rule, severity, slot, pointer, prop, index, at, message, fix }], stats }
//   const svg     = planSvg(subject, report); // a top-down plan: footprints, spawns, zones, problems in red
//
// Every number it judges by is in T below; RULES says what each rule means. The geometry comes from the prop catalog
// (the asset library's props through builder/art/views.mjs, or a game's config/props.json): size, collider, tags and `real` (the real-world height range).
import { readFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { KIT, kitPath } from './paths.mjs';
import { pictureFile, propsCatalog } from '../../art/views.mjs';
import { expandLayout, footprint, placementYaw, placementScale, turn } from '../../../worlds/layout.js';
import { importLayer } from './kit-import.mjs';
// kit modules whose imports cross layers: through the hook (kit-import.mjs importLayer)
const { generateLayout } = await importLayer(kitPath(KIT, 'world/generate.js'));

// ---------- thresholds (metres unless noted; colour distances are OKLab ΔE) ----------
export const T = {
  overlap: 0.08,          // solid props may touch; deeper than this they interpenetrate (wall, fence and hedge pieces may join)
  restTolerance: 0.06,    // a prop above the ground must rest on a top within this
  itemHover: 1.2,         // pickups and items may hover this far above their support
  sunk: 0.02,             // below the ground by more than this
  tilt: 3,                // degrees of pitch or roll before a prop counts as tilted
  spawnBlocked: 0.6,      // a spawn this close to a solid is blocked (error)
  spawnClear: 1.0,        // ... and this close is cramped (warning)
  spawnEdge: 1.0,         // a spawn must be this far inside the play area
  spawnApart: 1.5,        // spawns closer than this
  sightLine: 6,           // metres from a spawn toward the middle that tall props keep clear of
  edgeBand: 2.0,          // the strip along the play-area edge where small decor belongs
  edgeSlack: 0.15,        // a prop may poke this far through the invisible wall
  looseNear: 0.8,         // a small thing within this of a solid prop belongs to it (not loose)
  looseErrors: 4,         // this many loose small things in the open is an error (clutter)
  scattered: 3,           // this many of one decor prop dotted across the open floor reads as random
  density: 4,             // decor and items per 100 m² of play area (grass and flat cover excluded)
  zoneBlocked: 0.4,       // a zone more covered than this by solids (warning; error when a mechanic uses it)
  pickupFree: 0.6,        // the pickup area must be at least this free
  centre: 0.25,           // the middle disc (radius 0.3 × the short side) more covered than this is crowded
  playFree: 0.65,         // the play area less free than this is cramped
  scaleWarn: 1.15,        // placed height outside real × (this) → warning
  scaleError: 1.6,        // ... outside real × (this) → error
  itemScale: 3.2,         // items may be exaggerated this much for readability
  itemMin: 0.18,          // ... but an item smaller than this (metres, longest side, at a 1.75 m character) is unreadable
  scaleMixed: 0.25,       // the same furniture at sizes this far apart
  stretched: 1.35,        // non-uniform scale ratio
  doubled: 1.5,           // lamps or tall props of a kind closer than this × their half width
  contrastError: 0.06,    // ground vs a player, paint or stream colour (OKLab ΔE)
  contrastWarn: 0.09,
  value: 0.06,            // median lightness gap between ground and player colours (OKLab L)
  groundPattern: 0.03,    // ground colour vs second colour, when there is no pattern texture
  palette: 0.08,          // two player colours closer than this
  faceCone: 40,           // degrees: a seat faces a target within this
  faceReach: 7,           // metres
  charHeight: 1.75,       // the real-world adult the `real` heights are for
  charRadius: 0.35,
};

export const RULES = {
  'unknown-prop': 'a placement names a prop the catalog lacks',
  overlap: 'two solid props interpenetrate',
  inside: 'a decor prop is hidden inside a solid one',
  floating: 'a prop hangs in the air with nothing under it',
  sunk: 'a prop is buried in the ground',
  tilted: 'a prop is pitched or rolled',
  duplicate: 'the same prop placed twice in the same spot',
  doubled: 'two lamps or tall props of a kind stand almost on top of each other',
  edge: 'a solid prop straddles the invisible wall at the play-area edge',
  'backdrop-intrudes': 'a backdrop building reaches into the play area',
  'spawn-count': 'fewer spawns than players',
  'spawn-blocked': 'a spawn is inside or against a solid prop',
  'spawn-edge': 'a spawn is at or beyond the play-area edge',
  'spawn-close': 'two spawns are almost on top of each other',
  'spawn-view': 'the third-person camera behind a spawn starts inside a prop, or a tall prop blocks the view from a spawn to the middle',
  'zone-blocked': 'a zone is mostly covered by solid props',
  'pickup-area': 'the area pickups appear in is mostly covered by props',
  'pickup-standin': 'pickups draw the stand-in gem: the game names no pickup prop',
  'pickup-size': 'pickups are too small to read at play distance',
  'looks-collectable': 'scenery that looks like a pickup (players will try to grab it)',
  scale: 'a prop is out of scale with the real thing and the character',
  'scale-mixed': 'the same furniture placed at clearly different sizes',
  stretched: 'a prop is scaled unevenly',
  clutter: 'a small loose thing in the open (reads as litter)',
  scattered: 'decor dotted across the open floor instead of grouped in beds, borders and corners',
  density: 'too much decor for the play area',
  'plants-on-paving': 'plants standing on paving or floor with no bed or planter',
  'faces-nothing': 'a seat faces nothing (or faces into a prop)',
  'crowded-centre': 'the middle of the play area is crowded',
  cramped: 'too little open floor to play on',
  'ground-flat': 'the ground is one flat colour with no visible pattern',
  contrast: 'a player, paint or stream colour is hard to see against the ground',
  value: 'players stand out from the ground by hue only (no light/dark difference)',
  palette: 'two player colours are hard to tell apart',
};

// real-world height ranges (metres, for a 1.75 m adult) when the catalog entry has no `real`: by id, then by tag
const REAL_ID = {
  bench: [0.75, 1.0], chair: [0.8, 1.05], 'chair-office': [0.95, 1.25], sofa: [0.7, 1.0], 'coffee-table': [0.35, 0.55],
  table: [0.68, 0.8], 'table-round': [0.68, 0.8], desk: [0.7, 0.8], 'desk-corner': [0.7, 0.8], 'picnic-table': [0.7, 0.85],
  'street-light': [3.5, 6.5], lantern: [2.5, 4.5], 'floor-lamp': [1.4, 1.9], 'desk-lamp': [0.3, 0.6],
  'vending-machine': [1.7, 2.05], fridge: [1.6, 2.0], 'arcade-machine': [1.6, 1.95], 'water-cooler': [1.0, 1.45], 'kitchen-counter': [0.85, 0.95],
  bookcase: [1.2, 2.2], 'bookcase-open': [1.2, 2.2], tv: [0.5, 1.3], trashcan: [0.6, 1.1], cone: [0.45, 0.8], crate: [0.4, 1.2], barrel: [0.85, 1.2],
  planter: [0.4, 0.9], fountain: [0.4, 1.5], 'stall-red': [2.2, 3.0], 'stall-green': [2.2, 3.0], 'parasol-cafe': [2.1, 2.8], parasol: [2.0, 2.8], cart: [0.8, 1.4],
  'swing-set': [2.0, 2.8], slide: [1.5, 2.8], grill: [0.85, 1.2], 'hose-reel': [0.5, 1.0], bucket: [0.25, 0.45],
  monitor: [0.35, 0.6], laptop: [0.2, 0.35], keyboard: [0.02, 0.06], 'computer-mouse': [0.03, 0.05], 'coat-rack': [1.5, 1.9],
  'plant-potted': [0.6, 1.6], 'plant-small': [0.15, 0.35], 'box-closed': [0.3, 0.7], 'box-open': [0.3, 0.7], 'coffee-machine': [0.3, 0.5],
  fence: [0.8, 1.8], 'hedge-tall': [1.2, 2.4], 'banner-red': [1.2, 3.0],
  'soda-can': [0.11, 0.13], 'soda-bottle': [0.2, 0.35], 'cup-coffee': [0.08, 0.16], watermelon: [0.25, 0.4], burger: [0.08, 0.15],
  donut: [0.04, 0.08], 'ice-cream': [0.15, 0.25], 'ball-red': [0.2, 0.3], 'ball-blue': [0.2, 0.3], 'ball-green': [0.2, 0.3], present: [0.2, 0.5],
};
const REAL_TAG = [['tree', [2.5, 9]], ['bush', [0.5, 2.0]], ['hedge', [0.8, 2.4]], ['flowers', [0.1, 0.7]], ['grass', [0.1, 0.9]],
  ['building', [4, 20]], ['wall', [0.8, 3.2]]];
const STRUCTURAL = new Set(['wall', 'fence', 'hedge', 'gate', 'column']);
const SEAT = new Set(['bench', 'chair', 'sofa']);
const SEAT_TARGET = new Set(['table', 'desk', 'centrepiece', 'screen', 'station', 'water', 'stage', 'fire', 'tv', 'cafe']);
const TERRAIN = new Set(['platform', 'ramp', 'block']);   // walkable or jumpable play features, not clutter
const PLANT = new Set(['flowers', 'grass', 'mushrooms']);
const PLANT_HOME = new Set(['planter', 'hedge', 'bush', 'tree', 'flowerbed']);
const LAMP = new Set(['lamp', 'light']);

// ---------- colour (sRGB hex → OKLab) ----------
const lin = c => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
export function oklab(hex) {
  const h = String(hex).replace('#', '');
  const [r, g, b] = [0, 2, 4].map(i => lin(parseInt(h.slice(i, i + 2), 16) / 255));
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s, 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s];
}
export const deltaE = (a, b) => { const A = oklab(a), B = oklab(b); return Math.hypot(A[0] - B[0], A[1] - B[1], A[2] - B[2]); };
const isHex = v => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);

// ---------- 2D geometry on footprints ----------
const axesOf = f => { const [ax, az] = turn(1, 0, f.yaw ?? 0), [bx, bz] = turn(0, 1, f.yaw ?? 0); return [[ax, az], [bx, bz]]; };
function local(f, x, z) { const [[ax, az], [bx, bz]] = axesOf(f); const dx = x - f.cx, dz = z - f.cz; return [dx * ax + dz * az, dx * bx + dz * bz]; }
/** Distance from a point to a footprint (0 inside). */
export function distTo(f, x, z) {
  if (f.shape === 'circle') return Math.max(0, Math.hypot(x - f.cx, z - f.cz) - f.r);
  const [lx, lz] = local(f, x, z);
  return Math.hypot(Math.max(0, Math.abs(lx) - f.hx), Math.max(0, Math.abs(lz) - f.hz));
}
export const contains = (f, x, z, pad = 0) => distTo(f, x, z) <= pad + 1e-9;
/** How deep two footprints interpenetrate (metres; ≤ 0 means apart). */
export function penetration(a, b) {
  if (a.shape === 'circle' && b.shape === 'circle') return a.r + b.r - Math.hypot(a.cx - b.cx, a.cz - b.cz);
  if (a.shape === 'circle') return penetration(b, a);
  if (b.shape === 'circle') {
    const [lx, lz] = local(a, b.cx, b.cz);
    const qx = Math.max(-a.hx, Math.min(a.hx, lx)), qz = Math.max(-a.hz, Math.min(a.hz, lz));
    const d = Math.hypot(lx - qx, lz - qz);
    return d > 0 ? b.r - d : b.r + Math.min(a.hx - Math.abs(lx), a.hz - Math.abs(lz));
  }
  let best = Infinity;
  const A = axesOf(a), B = axesOf(b);
  for (const [ux, uz] of [...A, ...B]) {
    const rad = (f, F) => f.hx * Math.abs(F[0][0] * ux + F[0][1] * uz) + f.hz * Math.abs(F[1][0] * ux + F[1][1] * uz);
    const gap = Math.abs((a.cx - b.cx) * ux + (a.cz - b.cz) * uz);
    best = Math.min(best, rad(a, A) + rad(b, B) - gap);
  }
  return best;
}
const areaOf = f => (f.shape === 'circle' ? Math.PI * f.r * f.r : 4 * f.hx * f.hz);
const vOverlap = (a, b) => Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
/** Fraction of grid points in a region covered by any footprint (inflated by pad). region: {shape, cx, cz, hx, hz | r} */
function covered(region, fps, pad = 0, step = 0.25) {
  let n = 0, hit = 0;
  const R = region.shape === 'circle' ? region.r : Math.max(region.hx, region.hz);
  for (let x = region.cx - R; x <= region.cx + R; x += step) for (let z = region.cz - R; z <= region.cz + R; z += step) {
    if (!contains(region, x, z)) continue;
    n++; if (fps.some(f => contains(f, x, z, pad))) hit++;
  }
  return n ? hit / n : 0;
}

// ---------- loading ----------
async function readJson(p) { return JSON.parse(await readFile(p, 'utf8')); }
async function readJsonMaybe(p) { try { return await readJson(p); } catch { return null; } }

/**
 * target: a template id (backyard | office | plaza | arena; `office:medium` for another size class), a layout JSON file,
 * or a game directory (config/world.json). A template is its recipe expanded by kit/world/generate.js.
 * opts.look: the look preset for a template (default jelly-pastel, the house look).
 */
export async function loadSubject(target, opts = {}) {
  const [tid, tsize] = String(target).split(':');
  const templateFile = kitPath(KIT, 'world/templates', `${tid}.json`);
  let kind, dir = null, world, catalog, game = null, characters = null, look = null, file;
  if (!target.includes('/') && existsSync(templateFile)) { kind = 'template'; file = templateFile; }
  else if (existsSync(target) && statSync(target).isDirectory()) { kind = 'game'; dir = resolve(target); file = join(dir, 'config/world.json'); }
  else if (existsSync(target)) { kind = 'template'; file = resolve(target); }
  else throw new Error(`dressing: no template, layout file or game directory "${target}"`);
  world = await readJson(file);
  if (file === templateFile && (world.kind || tsize)) world = generateLayout(world, { size: tsize ?? 'small' });
  if (kind === 'game') {
    catalog = await readJsonMaybe(join(dir, 'config/props.json')) ?? propsCatalog('three');
    game = await readJsonMaybe(join(dir, 'config/game.json'));
    characters = await readJsonMaybe(join(dir, 'config/characters.json'));
    look = await readJsonMaybe(join(dir, 'config/look.json'));
  } else {
    catalog = propsCatalog('three');
    look = await readJsonMaybe(kitPath(KIT, 'look/presets', `${opts.look ?? 'jelly-pastel'}.json`));
  }
  const textures = [];
  const pat = world.ground?.pattern;
  if (pat?.file) textures.push(kind === 'game' ? join(dir, pat.file) : (pictureFile(pat.file) ?? ''));
  return { kind, target, file, dir, world, catalog, game, characters, look, patternFound: textures.every(t => existsSync(t)) && textures.length > 0 };
}

// ---------- the lint ----------
export function lintDressing(subject) {
  const { world: cfg, catalog, game, characters, look } = subject;
  const t = cfg.template ?? 'world';
  const byId = new Map((catalog?.props ?? []).map(p => [p.id, p]));
  const [W, D] = cfg.size ?? [24, 24];
  const play = { shape: 'box', cx: 0, cz: 0, hx: W / 2, hz: D / 2, yaw: 0 };
  const charH = Object.values(characters?.roles ?? {})[0]?.height ?? 1.7;
  const k = charH / T.charHeight;
  const groundKind = cfg.ground?.kind ?? ({ plaza: 'paved', office: 'floor' }[t] ?? 'grass');
  const problems = [];
  const nProps = (cfg.props ?? []).length;
  const scatterIndex = [];   // placement index → scatter entry index for scattered props
  { let i = nProps; (cfg.scatter ?? []).forEach((s, si) => { const n = expandLayout({ ...cfg, props: [], scatter: [s] }).length; for (let j = 0; j < n; j++) scatterIndex[i++] = si; }); }
  const all = expandLayout(cfg);
  const pointer = i => (i < nProps ? `/props/${i}` : `/scatter/${scatterIndex[i]}`);
  const fmt = a => `(${(+a[0]).toFixed(1)}, ${(+a[2]).toFixed(1)})`;
  const add = (rule, severity, o) => problems.push({ rule, severity, slot: o.slot ?? `world.${t}.layout`, pointer: o.pointer ?? null, prop: o.prop ?? null, index: o.index ?? null, at: o.at ?? null, message: o.message, fix: o.fix ?? null });
  const name = i => `${all[i].prop} #${i}`;

  // every placement with its class and footprints
  const P = all.map((p, i) => {
    const meta = byId.get(p.prop);
    if (!meta) { add('unknown-prop', 'error', { slot: `world.${t}.layout`, pointer: pointer(i), prop: p.prop, index: i, at: p.at, message: `${p.prop} at ${fmt(p.at ?? [0, 0, 0])} is not in the prop catalog`, fix: 'use a library prop id (runtimes/three/library/props.json) or add the prop to config/props.json' }); return null; }
    const tags = new Set(meta.tags ?? []);
    const [sx, sy, sz] = placementScale(p);
    const h = (meta.size?.[1] ?? 1) * sy;
    const solid = !!(meta.collider && meta.collider !== 'none' && meta.collider.shape);
    let cls;
    // sky: clouds, anything high up, and what hangs from an indoor world's ceiling (lamps): none of it stands on the floor
    if (tags.has('sky') || tags.has('cloud') || (p.at?.[1] ?? 0) > 12 || (tags.has('ceiling') && cfg.ceiling)) cls = 'sky';
    else if (tags.has('backdrop') || tags.has('building')) cls = 'backdrop';
    else if (!solid && (h <= 0.06 || ['floor', 'tile', 'rug', 'path'].some(x => tags.has(x)))) cls = 'flat';
    else if (tags.has('item') || tags.has('pickup')) cls = 'item';
    else cls = solid ? 'solid' : 'decor';
    const vis = footprint(p, meta, 'visual');
    const col = solid ? footprint(p, meta, 'collider') : null;
    const inPlay = contains(play, p.at?.[0] ?? 0, p.at?.[2] ?? 0);
    return { i, p, meta, tags, cls, h, solid, vis, col, inPlay, sx, sy, sz, yaw: placementYaw(p), slot: `prop.${p.prop}` };
  });
  const live = P.filter(Boolean);
  const solids = live.filter(q => q.solid && (q.cls === 'solid' || q.cls === 'backdrop'));
  const structural = q => [...q.tags].some(x => STRUCTURAL.has(x));

  // --- stacking: what each prop rests on ---
  const restOn = new Map();
  for (const q of live) {
    if (q.cls === 'sky') continue;
    const y = q.p.at?.[1] ?? 0;
    if (y < -T.sunk) {
      const buried = q.cls === 'flat' ? y + q.h < 0.001 : true;
      if (buried) add('sunk', 'error', { pointer: pointer(q.i), prop: q.p.prop, index: q.i, at: q.p.at, slot: `world.${t}.layout`, message: `${name(q.i)} at ${fmt(q.p.at)} is ${(-y).toFixed(2)} m below the ground`, fix: `set its at[1] to 0` });
      continue;
    }
    if (y <= T.restTolerance) continue;
    const x = q.p.at[0], z = q.p.at[2];
    const support = live.find(s => s !== q && s.cls !== 'sky' && s.cls !== 'decor' && contains(s.vis, x, z, 0.05) && Math.abs(s.vis.y1 - y) <= T.restTolerance);
    if (support) { restOn.set(q, support); continue; }
    const under = live.filter(s => s !== q && s.cls !== 'sky' && contains(s.vis, x, z) && s.vis.y1 <= y + T.restTolerance).sort((a, b) => b.vis.y1 - a.vis.y1)[0];
    const gap = y - (under?.vis.y1 ?? 0);
    if (q.cls === 'item' && gap <= T.itemHover) { if (under) restOn.set(q, under); continue; }
    add('floating', 'error', { pointer: pointer(q.i), prop: q.p.prop, index: q.i, at: q.p.at, message: `${name(q.i)} at ${fmt(q.p.at)} floats ${gap.toFixed(2)} m above ${under ? name(under.i) : 'the ground'}`, fix: `set its at[1] to ${under ? under.vis.y1.toFixed(2) : 0} (the top of what is under it) or move it onto a support` });
  }

  // --- tilt, stretch ---
  for (const q of live) {
    if (q.cls === 'sky') continue;
    if (Array.isArray(q.p.rot) && (Math.abs(q.p.rot[0] ?? 0) > T.tilt || Math.abs(q.p.rot[2] ?? 0) > T.tilt))
      add('tilted', 'warning', { pointer: pointer(q.i), prop: q.p.prop, index: q.i, at: q.p.at, message: `${name(q.i)} is tilted (${q.p.rot.map(v => Math.round(v)).join(', ')} degrees)`, fix: 'use a yaw only (rot: degrees about Y)' });
    const sc = [q.sx, q.sy, q.sz];
    if (Math.max(...sc) / Math.min(...sc) > T.stretched)
      add('stretched', 'warning', { pointer: pointer(q.i), prop: q.p.prop, index: q.i, at: q.p.at, message: `${name(q.i)} is scaled unevenly (${sc.join(' x ')}): it looks squashed`, fix: 'use one number for scale' });
  }

  // --- overlaps ---
  for (let a = 0; a < solids.length; a++) for (let b = a + 1; b < solids.length; b++) {
    const A = solids[a], B = solids[b];
    if (restOn.get(A) === B || restOn.get(B) === A) continue;
    if (vOverlap(A.col, B.col) <= 0.05) continue;
    if (structural(A) && structural(B)) continue;   // wall, fence and hedge pieces join and cross by design
    if ((A.meta.hosts ?? []).includes(B.p.prop) || (B.meta.hosts ?? []).includes(A.p.prop)) continue;   // a parasol through a picnic table
    const pen = penetration(A.col, B.col);
    if (pen > T.overlap) add('overlap', 'error', { pointer: pointer(B.i), prop: B.p.prop, index: B.i, at: B.p.at, message: `${name(B.i)} at ${fmt(B.p.at)} is ${pen.toFixed(2)} m inside ${name(A.i)} at ${fmt(A.p.at)}`, fix: `move one of them ${(pen + 0.1).toFixed(1)} m apart, or remove one (config/world.json ${pointer(B.i)})` });
  }
  // exact duplicates (any class)
  const seen = new Map();
  for (const q of live) {
    const key = `${q.p.prop}|${q.p.at?.map(v => Math.round(v * 20)).join(',')}|${Math.round(q.yaw)}`;
    if (seen.has(key)) add('duplicate', 'error', { pointer: pointer(q.i), prop: q.p.prop, index: q.i, at: q.p.at, message: `${name(q.i)} is placed twice at ${fmt(q.p.at)} (also #${seen.get(key)})`, fix: `remove ${pointer(q.i)}` });
    else seen.set(key, q.i);
  }
  // decor hidden inside solids
  for (const q of live) {
    if (q.cls !== 'decor' && q.cls !== 'item') continue;
    if (restOn.has(q)) continue;
    const host = solids.find(s => s.cls === 'solid' && contains(s.col, q.p.at[0], q.p.at[2], -0.05) && s.col.y1 > q.vis.y0 + 0.05);
    if (host) add('inside', 'warning', { pointer: pointer(q.i), prop: q.p.prop, index: q.i, at: q.p.at, message: `${name(q.i)} is hidden inside ${name(host.i)}`, fix: 'move it beside the prop, or put it on top (at[1] = the top)' });
  }
  // doubled lamps and tall props
  for (let a = 0; a < live.length; a++) for (let b = a + 1; b < live.length; b++) {
    const A = live[a], B = live[b];
    if (A.cls === 'sky' || B.cls === 'sky' || A.cls === 'backdrop' || B.cls === 'backdrop') continue;
    const lampy = q => [...q.tags].some(x => LAMP.has(x));
    const tall = q => q.h > 2.5 && !q.tags.has('tree') && !structural(q);
    const kindA = lampy(A) ? 'lamp' : tall(A) ? A.p.prop : null, kindB = lampy(B) ? 'lamp' : tall(B) ? B.p.prop : null;
    if (!kindA || kindA !== kindB) continue;
    const d = Math.hypot(A.p.at[0] - B.p.at[0], A.p.at[2] - B.p.at[2]);
    const reach = T.doubled * Math.max(A.vis.hx, A.vis.hz, B.vis.hx, B.vis.hz, 0.6);
    if (d < reach && d > 0.01) add('doubled', 'warning', { pointer: pointer(B.i), prop: B.p.prop, index: B.i, at: B.p.at, message: `${name(B.i)} stands ${d.toFixed(1)} m from ${name(A.i)}: they read as one doubled ${kindA}`, fix: 'keep one, or space them along a path' });
  }

  // --- edges ---
  for (const q of solids) {
    if (q.cls === 'backdrop') {
      const pen = penetration(q.col, play);
      // a backdrop footprint inside the play box: how far does it reach in from the nearest edge?
      const inside = Math.min(W / 2 - Math.abs(q.col.cx), D / 2 - Math.abs(q.col.cz)) + (q.col.shape === 'circle' ? q.col.r : Math.max(q.col.hx, q.col.hz));
      if (pen > 0.25 && inside > 0.25) add('backdrop-intrudes', 'error', { pointer: pointer(q.i), prop: q.p.prop, index: q.i, at: q.p.at, message: `the backdrop ${name(q.i)} reaches ${Math.min(pen, inside).toFixed(1)} m into the play area`, fix: 'move it outward, beyond size/2 plus half its depth' });
      continue;
    }
    if (structural(q)) continue;
    const corners = q.col.shape === 'circle' ? [[q.col.cx - q.col.r, q.col.cz], [q.col.cx + q.col.r, q.col.cz], [q.col.cx, q.col.cz - q.col.r], [q.col.cx, q.col.cz + q.col.r]]
      : [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([u, v]) => { const [x, z] = turn(u * q.col.hx, v * q.col.hz, q.col.yaw); return [q.col.cx + x, q.col.cz + z]; });
    const ins = corners.filter(([x, z]) => contains(play, x, z, T.edgeSlack)).length;
    if (ins > 0 && ins < corners.length) add('edge', 'warning', { pointer: pointer(q.i), prop: q.p.prop, index: q.i, at: q.p.at, message: `${name(q.i)} at ${fmt(q.p.at)} straddles the play-area edge (the invisible wall cuts through it)`, fix: 'move it fully inside, or fully outside as scenery' });
  }

  // --- spawns ---
  // the middle the spawns face (world.js turns each spawn toward it): in a world with rooms the main room's centre zone,
  // else the origin
  const mid = (cfg.rooms?.length && cfg.zones?.centre?.at) || [0, 0, 0];
  const spawns = (cfg.spawns ?? []).map((s, i) => ({ i, x: s[0], y: s[1] ?? 0, z: s[2] }));
  const maxPlayers = game?.players?.max ?? 8;
  if (spawns.length < Math.min(maxPlayers, 8)) add('spawn-count', 'error', { slot: `world.${t}.spawns`, pointer: '/spawns', message: `${spawns.length} spawns for up to ${maxPlayers} players`, fix: `add spawns to config/world.json /spawns (one per player)` });
  const playSolids = solids.filter(q => q.cls === 'solid');
  const camDist = game?.controller?.camera?.third?.distance ?? 5.2;
  const thirdPerson = (game?.camera ?? 'third') === 'third';
  for (const s of spawns) {
    const edge = Math.min(W / 2 - Math.abs(s.x), D / 2 - Math.abs(s.z));
    if (edge < T.spawnEdge) add('spawn-edge', 'error', { slot: `world.${t}.spawns`, pointer: `/spawns/${s.i}`, at: [s.x, 0, s.z], message: `spawn ${s.i} at (${s.x}, ${s.z}) is ${edge.toFixed(1)} m from the play-area edge`, fix: `move it at least ${T.spawnEdge} m inside` });
    const near = playSolids.filter(q => q.col.y1 > s.y + 0.3 && q.col.y0 < s.y + 1.8).map(q => ({ q, d: distTo(q.col, s.x, s.z) })).sort((a, b) => a.d - b.d)[0];
    if (near && near.d < T.spawnClear) add('spawn-blocked', near.d < T.spawnBlocked ? 'error' : 'warning', { slot: `world.${t}.spawns`, pointer: `/spawns/${s.i}`, at: [s.x, 0, s.z], message: `spawn ${s.i} at (${s.x}, ${s.z}) is ${near.d.toFixed(2)} m from ${name(near.q.i)}`, fix: `move the spawn or the prop so there is ${T.spawnClear} m of clear floor around it` });
    for (const o of spawns) if (o.i > s.i && Math.hypot(o.x - s.x, o.z - s.z) < T.spawnApart) add('spawn-close', 'warning', { slot: `world.${t}.spawns`, pointer: `/spawns/${o.i}`, at: [o.x, 0, o.z], message: `spawns ${s.i} and ${o.i} are ${Math.hypot(o.x - s.x, o.z - s.z).toFixed(1)} m apart`, fix: `spread them at least ${T.spawnApart} m apart` });
    if (thirdPerson) {
      // world.js faces each spawn toward the middle; the camera trails behind it
      const len = Math.hypot(s.x - mid[0], s.z - mid[2]) || 1, fx = (mid[0] - s.x) / len, fz = (mid[2] - s.z) / len;
      const cx = s.x - fx * camDist, cz = s.z - fz * camDist;
      const inProp = solids.find(q => q.col.y1 > 1.8 && contains(q.col, cx, cz, 0.2));
      if (inProp) add('spawn-view', 'warning', { slot: `world.${t}.spawns`, pointer: `/spawns/${s.i}`, at: [s.x, 0, s.z], message: `at spawn ${s.i} the camera (${camDist} m behind) starts inside ${name(inProp.i)}`, fix: 'move the spawn toward the middle, or the prop back' });
      // the first view of the round: nothing tall standing in the line from the spawn to the middle (a lamp post
      // dead centre in front of the camera)
      const reach = Math.min(len, T.sightLine);
      const inLine = playSolids.find(q => q.col.y1 > 1.5 && !q.tags.has('centrepiece') && ![...q.tags].some(x => TERRAIN.has(x)) && [...Array(13).keys()].some(k => { const d = 1 + (reach - 1) * k / 12; return contains(q.col, s.x + fx * d, s.z + fz * d, 0.35); }));
      if (inLine) add('spawn-view', 'warning', { slot: `world.${t}.spawns`, pointer: `/spawns/${s.i}`, at: inLine.p.at, prop: inLine.p.prop, index: inLine.i, message: `${name(inLine.i)} stands in the line of sight from spawn ${s.i} to the middle: it fills the first view of the round`, fix: 'move it off the line (beside a bench or along an edge), or move the spawn' });
    }
  }

  // --- zones and the pickup area ---
  const mech = id => (game?.mechanics ?? []).find(m => m.id === id);
  // zones things get placed in: a mechanic's zone params, and 'centre' (the station mechanic's default). A zone that
  // only names an area ("desks", "market") may be full of furniture by design.
  const usedZones = new Set(['centre']);
  for (const m of game?.mechanics ?? []) for (const [kk, v] of Object.entries(m.params ?? {})) if (/zone$/i.test(kk) && typeof v === 'string' && v) usedZones.add(v);
  for (const m of game?.mechanics ?? []) for (const st of m.params?.stations ?? []) if (st?.zone) usedZones.add(st.zone);
  // what blocks standing room at height y: solids that rise above it (a zone on top of a block is not blocked by it)
  const blockersAt = (y = 0) => playSolids.filter(q => q.col.y1 > y + 0.3 && q.col.y0 < y + 1.8).map(q => q.col);
  const blockers = playSolids;
  for (const [zn, z] of Object.entries(cfg.zones ?? {})) {
    const at = z.at ?? [0, 0, 0], size = z.size ?? [1];
    const region = (z.shape ?? 'circle') === 'circle' ? { shape: 'circle', cx: at[0], cz: at[2], r: size[0] } : { shape: 'box', cx: at[0], cz: at[2], hx: size[0] / 2, hz: (size[2] ?? size[0]) / 2, yaw: 0 };
    const zy = (z.shape ?? 'circle') === 'circle' ? (at[1] ?? 0) : (at[1] ?? 0) - (size[1] ?? 0) / 2;
    // a zone drawn around a centrepiece names that centrepiece (the fountain zone is the fountain): not blocked by it
    const named = playSolids.filter(q => q.tags.has('centrepiece') && contains(q.col, at[0], at[2])).map(q => q.col);
    const used = usedZones.has(zn);
    if (!used) continue;
    const cov = covered(region, blockersAt(Math.max(0, zy)).filter(c => !named.includes(c)), 0);
    const onSpawn = spawns.filter(s => contains(region, s.x, s.z, 0.5));
    if (onSpawn.length) add('zone-blocked', 'warning', { slot: `world.${t}.zones`, pointer: `/zones/${zn}`, at, message: `zone "${zn}" covers spawn${onSpawn.length > 1 ? 's' : ''} ${onSpawn.map(s => s.i).join(', ')}: what is placed there lands on a player`, fix: 'move the zone or the spawns apart' });
    if (cov > T.zoneBlocked) add('zone-blocked', cov > 0.5 ? 'error' : 'warning', { slot: `world.${t}.zones`, pointer: `/zones/${zn}`, at, message: `zone "${zn}" is ${(cov * 100).toFixed(0)}% covered by solid props, and things are placed in it`, fix: 'move props out of the zone, or move or resize the zone' });
  }
  const pk = mech('pickup');
  if (pk) {
    const prm = pk.params ?? {};
    const z = prm.zone && cfg.zones?.[prm.zone];
    const region = z ? ((z.shape ?? 'circle') === 'circle' ? { shape: 'circle', cx: z.at[0], cz: z.at[2], r: z.size[0] } : { shape: 'box', cx: z.at[0], cz: z.at[2], hx: z.size[0] / 2, hz: (z.size[2] ?? z.size[0]) / 2, yaw: 0 })
      : { shape: 'box', cx: 0, cz: 0, hx: Math.max(1, W / 2 - 3), hz: Math.max(1, D / 2 - 3), yaw: 0 };
    const free = 1 - covered(region, blockers.map(q => q.col), 0.4);
    if (free < T.pickupFree) add('pickup-area', 'warning', { slot: 'mechanic.pickup.zone', at: [region.cx, 0, region.cz], message: `only ${(free * 100).toFixed(0)}% of the pickup area is open floor`, fix: 'pick a more open zone (mechanics[pickup].params.zone) or clear props from it' });
    const gameProps = game?.props ?? [];
    const named = prm.prop ? gameProps.find(p => p.name === prm.prop) ?? { name: prm.prop } : gameProps[0];
    if (!named) add('pickup-standin', 'error', { slot: 'mechanic.pickup.prop', message: 'pickups draw the stand-in gem: the game has no pickup prop (config/game.json props is empty and mechanics[pickup].params.prop is "")', fix: 'give the spec\'s pickup prop a role that says players pick it up (e.g. "pick up to refill"), or set mechanics[pickup].params.prop to a prop slot' });
    const size = prm.size ?? 0.5;
    if (size / k < 0.3) add('pickup-size', 'warning', { slot: 'mechanic.pickup.size', message: `pickups are ${size} m: hard to read from the third-person camera`, fix: 'set mechanics[pickup].params.size to about 0.5–0.7' });
  }
  // scenery that looks collectable: an item on the floor in the open (on a desk or in a stack it reads as furniture),
  // or, in a game with pickups, any item of the same kind as the pickup
  const pickupName = pk ? (pk.params?.prop || game?.props?.[0]?.name || '') : '';
  const pickupTags = new Set(pk ? (byId.get(pickupName)?.tags ?? []).filter(x => !['item', 'pickup'].includes(x)) : []);
  for (const q of live) {
    if (q.cls !== 'item' || !q.inPlay || q.tags.has('goal') || q.tags.has('centrepiece')) continue;
    const sameKind = pk && (q.p.prop === pickupName || [...pickupTags].some(x => q.tags.has(x)));
    const open = !restOn.has(q) && !playSolids.some(s => distTo(s.col, q.p.at[0], q.p.at[2]) < T.looseNear);
    if (!sameKind && !open) continue;
    const sev = pk ? 'error' : 'warning';
    add('looks-collectable', sev, { pointer: pointer(q.i), prop: q.p.prop, index: q.i, at: q.p.at, message: `${name(q.i)} at ${fmt(q.p.at)} looks like a pickup but is scenery${pk ? ' (this game has real pickups)' : ''}`, fix: 'remove it from the layout; a pickup belongs to the pickup mechanic (it draws and respawns them)' });
  }

  // --- scale ---
  const realOf = q => q.meta.real ?? REAL_ID[q.p.prop] ?? REAL_TAG.find(([tag]) => q.tags.has(tag))?.[1] ?? null;
  const scalesById = new Map();
  for (const q of live) {
    if (q.cls === 'sky' || q.cls === 'flat') continue;
    const real = realOf(q);
    if (real) {
      const [lo, hi] = real.map(v => v * k);
      const item = q.cls === 'item';
      const top = item ? hi * T.itemScale : hi;
      const h = q.h;
      const ratio = h > top ? h / top : h < lo ? lo / h : 1;
      const sev = ratio > T.scaleError ? 'error' : ratio > T.scaleWarn ? 'warning' : null;
      if (sev) add('scale', sev, { pointer: pointer(q.i), prop: q.p.prop, index: q.i, at: q.p.at, slot: `prop.${q.p.prop}`, message: `${name(q.i)} is ${h.toFixed(2)} m tall; a real one is ${real[0]}–${real[1]} m (${lo.toFixed(2)}–${top.toFixed(2)} m beside a ${charH} m character)`, fix: h > top ? `scale it to about ${((top + lo) / 2 / h * (q.sy)).toFixed(2)}, or fix the library model's size` : `scale it up to about ${((top + lo) / 2 / h * q.sy).toFixed(2)}` });
      if (item && Math.max(q.vis.hx, q.vis.hz, q.h / 2) * 2 < T.itemMin * k) add('scale', 'warning', { pointer: pointer(q.i), prop: q.p.prop, index: q.i, at: q.p.at, message: `${name(q.i)} is too small to read at play distance`, fix: 'scale it up' });
    }
    if (!q.tags.has('nature') && !q.tags.has('tree') && q.cls !== 'backdrop') {
      if (!scalesById.has(q.p.prop)) scalesById.set(q.p.prop, []);
      scalesById.get(q.p.prop).push(q);
    }
  }
  for (const [id, list] of scalesById) {
    const s = list.map(q => q.sy), lo = Math.min(...s), hi = Math.max(...s);
    if (hi / lo - 1 > T.scaleMixed) { const q = list.find(x => x.sy === lo); add('scale-mixed', 'warning', { pointer: pointer(q.i), prop: id, index: q.i, at: q.p.at, message: `${id} is placed at sizes from ${lo} to ${hi}: the same furniture should match`, fix: `use one scale for every ${id}` }); }
  }

  // --- clutter, density, plants on paving ---
  const edgeDist = q => Math.min(W / 2 - Math.abs(q.p.at[0]), D / 2 - Math.abs(q.p.at[2]));
  const loose = [];
  for (const q of live) {
    if (!q.inPlay || restOn.has(q) || (q.cls !== 'decor' && q.cls !== 'item')) continue;
    if (q.tags.has('grass') && groundKind === 'grass') continue;
    const small = q.h <= 0.7 && Math.max(q.vis.hx, q.vis.hz) * 2 <= 1.0;
    if (!small) continue;
    const nearSolid = playSolids.some(s => distTo(s.col, q.p.at[0], q.p.at[2]) < T.looseNear);
    if (nearSolid || edgeDist(q) < T.edgeBand) continue;
    loose.push(q);
  }
  // bigger decor (flower clumps, rocks) dotted across the open floor rather than in beds, borders and corners
  const scattered = new Map();
  for (const q of live) {
    if (!q.inPlay || restOn.has(q) || q.cls !== 'decor' || loose.includes(q)) continue;
    if (q.tags.has('grass') && groundKind === 'grass') continue;
    if (playSolids.some(s => distTo(s.col, q.p.at[0], q.p.at[2]) < 1.0) || edgeDist(q) < T.edgeBand) continue;
    if (!scattered.has(q.p.prop)) scattered.set(q.p.prop, []);
    scattered.get(q.p.prop).push(q);
  }
  for (const [id, list] of scattered) if (list.length >= T.scattered) add('scattered', 'warning', { pointer: pointer(list[0].i), prop: id, index: list[0].i, at: list[0].p.at, message: `${list.length} ${id} are dotted across the open floor (${list.slice(0, 4).map(q => fmt(q.p.at)).join(', ')}${list.length > 4 ? ', …' : ''}): it looks random`, fix: `group them in beds along the edges or beside props (or drop the ${id} scatter)` });
  for (const q of loose) add('clutter', loose.length >= T.looseErrors ? 'error' : 'warning', { pointer: pointer(q.i), prop: q.p.prop, index: q.i, at: q.p.at, message: `${name(q.i)} at ${fmt(q.p.at)} lies loose in the open (${loose.length} such things): it reads as litter`, fix: 'remove it, or put it beside a solid prop or along the edge' });
  // floor-standing decor only: things on desks and shelves are part of their furniture
  const decorCount = live.filter(q => q.inPlay && !restOn.has(q) && (q.cls === 'decor' || q.cls === 'item') && !(q.tags.has('grass'))).length;
  const perHundred = decorCount / (W * D / 100);
  if (perHundred > T.density) add('density', 'warning', { message: `${decorCount} decor props in ${W * D} m² (${perHundred.toFixed(1)} per 100 m²): busy`, fix: `keep it under ${T.density} per 100 m²: remove the smallest, or group them in beds and corners` });
  if (groundKind !== 'grass') {
    const homes = live.filter(q => [...q.tags].some(x => PLANT_HOME.has(x)));
    for (const q of live) {
      if (!q.inPlay || q.cls !== 'decor' || ![...q.tags].some(x => PLANT.has(x)) || restOn.has(q)) continue;
      const home = homes.some(h => penetration(h.vis, q.vis) > -0.6);   // the clump's edge within 0.6 m of a bed
      if (!home) add('plants-on-paving', 'warning', { pointer: pointer(q.i), prop: q.p.prop, index: q.i, at: q.p.at, message: `${name(q.i)} grows out of the ${groundKind === 'paved' ? 'paving' : 'floor'} with no bed or planter: it reads as litter`, fix: 'put it in or beside a planter or hedge, or remove it' });
    }
  }

  // --- seats ---
  const targets = live.filter(q => [...q.tags].some(x => SEAT_TARGET.has(x)));
  for (const q of live) {
    if (![...q.tags].some(x => SEAT.has(x)) || q.cls === 'sky' || !q.inPlay) continue;
    const [fx, fz] = turn(0, 1, q.yaw);
    const faces = (x, z, reach = T.faceReach) => { const dx = x - q.p.at[0], dz = z - q.p.at[2], d = Math.hypot(dx, dz); if (d < 0.05 || d > reach) return false; return (dx * fx + dz * fz) / d >= Math.cos(T.faceCone * Math.PI / 180); };
    const target = targets.find(o => o !== q && faces(o.p.at[0], o.p.at[2])) ?? (faces(0, 0, Infinity) ? { centre: true } : null);
    const block = playSolids.find(s => s !== q && distTo(s.col, q.p.at[0] + fx * (q.vis.hz + 0.45), q.p.at[2] + fz * (q.vis.hz + 0.45)) < 0.05 && !isTarget(s));
    if (block) add('faces-nothing', 'warning', { pointer: pointer(q.i), prop: q.p.prop, index: q.i, at: q.p.at, message: `${name(q.i)} faces straight into ${name(block.i)}`, fix: 'turn it (rot) toward the open floor or a table, or move it' });
    else if (!target) add('faces-nothing', 'warning', { pointer: pointer(q.i), prop: q.p.prop, index: q.i, at: q.p.at, message: `${name(q.i)} at ${fmt(q.p.at)} faces nothing (no table, centrepiece or the middle in front of it)`, fix: 'turn it (rot, degrees; seats face +z at 0) toward the middle, a table or a centrepiece' });
  }
  function isTarget(s) { return [...s.tags].some(x => SEAT_TARGET.has(x)); }

  // --- open floor ---
  const mainRoom = (cfg.rooms ?? []).find(r => r.main);
  const centreR = 0.3 * (mainRoom ? Math.min(mainRoom.rect[2] - mainRoom.rect[0], mainRoom.rect[3] - mainRoom.rect[1]) : Math.min(W, D));
  const centreCov = covered({ shape: 'circle', cx: mid[0], cz: mid[2], r: centreR }, playSolids.filter(q => !q.tags.has('centrepiece') && ![...q.tags].some(x => TERRAIN.has(x))).map(q => q.col), T.charRadius);
  if (centreCov > T.centre) add('crowded-centre', 'warning', { message: `the middle (${centreR.toFixed(1)} m around the centre) is ${(centreCov * 100).toFixed(0)}% blocked`, fix: 'move props out toward the edges; keep one centrepiece in the middle' });
  const playFree = 1 - covered({ shape: 'box', cx: 0, cz: 0, hx: W / 2 - 0.5, hz: D / 2 - 0.5, yaw: 0 }, playSolids.map(q => q.col), T.charRadius, 0.4);
  if (playFree < T.playFree) add('cramped', 'warning', { message: `only ${(playFree * 100).toFixed(0)}% of the play area is open floor`, fix: 'remove or shrink props in the play area' });

  // --- colour ---
  const g = cfg.ground ?? {};
  const gc = [g.color, g.color2].filter(isHex);
  const palette = (Array.isArray(characters?.palette) ? characters.palette : look?.palette?.players ?? []).filter(isHex).slice(0, Math.max(2, Math.min(maxPlayers, 8)));
  const groundL = gc.length ? oklab(gc[0])[0] : null;
  if (gc.length) {
    const pattern = !!g.pattern?.file;
    if (pattern && !subject.patternFound) add('ground-flat', 'warning', { slot: `world.${t}.ground.pattern`, message: `the ground pattern ${g.pattern.file} is missing`, fix: 'add the file, or remove ground.pattern' });
    if (!pattern && (gc.length < 2 || deltaE(gc[0], gc[1]) < T.groundPattern)) add('ground-flat', 'warning', { slot: `world.${t}.ground.color`, message: `the ground reads as one flat colour (${gc.join(' vs ')}, ΔE ${gc.length > 1 ? deltaE(gc[0], gc[1]).toFixed(3) : 0}) and has no pattern`, fix: 'give config/world.json ground a pattern texture (ground.pattern) or a second colour further from the first' });
    const check = (hex, what, slot) => {
      const d = Math.min(...gc.map(c => deltaE(c, hex)));
      if (d < T.contrastWarn) add('contrast', d < T.contrastError ? 'error' : 'warning', { slot, message: `${what} ${hex} is hard to see on the ground ${gc[0]} (ΔE ${d.toFixed(3)})`, fix: `change the ground colour (world.${t}.ground.color) or ${slot}` });
    };
    const roles = Object.keys(characters?.roles ?? { player: 1 });
    palette.forEach((c, i) => check(c, `player ${i + 1}'s colour${mech('paint') ? ' (and their paint)' : ''}`, `character.tint.${roles[0] ?? 'player'}`));
    const prj = mech('projectile');
    if (prj?.params?.color && isHex(prj.params.color)) check(prj.params.color, 'the stream colour', 'mechanic.projectile.color');
    if (palette.length) {
      const gaps = palette.map(c => Math.abs(oklab(c)[0] - groundL)).sort((a, b) => a - b);
      const median = gaps[Math.floor(gaps.length / 2)];
      if (median < T.value) add('value', 'warning', { slot: `world.${t}.ground.color`, message: `players differ from the ground by hue only (median lightness gap ${median.toFixed(3)}; ground L ${groundL.toFixed(2)})`, fix: 'make the ground clearly darker or lighter than the player colours' });
    }
  }
  for (let a = 0; a < palette.length; a++) for (let b = a + 1; b < palette.length; b++) {
    const d = deltaE(palette[a], palette[b]);
    if (d < T.palette) add('palette', 'warning', { slot: 'characters.palette', message: `player colours ${a + 1} (${palette[a]}) and ${b + 1} (${palette[b]}) are close (ΔE ${d.toFixed(3)})`, fix: 'pick a more distinct colour for one of them' });
  }

  const errors = problems.filter(p => p.severity === 'error').length, warnings = problems.length - errors;
  const count = cls => live.filter(q => q.cls === cls).length;
  return {
    tool: 'builder/tools/dressing.mjs', target: subject.target, kind: subject.kind, template: t, ok: errors === 0, errors, warnings,
    problems,
    stats: { placements: all.length, solid: count('solid'), decor: count('decor'), items: count('item'), flat: count('flat'), backdrop: count('backdrop'), sky: count('sky'),
      playArea: [W, D], groundKind, groundL: groundL && +groundL.toFixed(3), characterHeight: charH, openFloor: +playFree.toFixed(2), centreBlocked: +centreCov.toFixed(2), decorPer100m2: +perHundred.toFixed(1), loose: loose.length },
  };
}

/** One plain-words line per problem; more than `group` of one rule on one prop fold into a count line. */
export function lines(report, { group = 3 } = {}) {
  const line = p => `${p.severity === 'error' ? 'ERROR' : 'warn '} ${p.rule.padEnd(18)} ${p.message}${p.fix ? ` → ${p.fix}` : ''}  [${p.slot}${p.pointer ? ' ' + p.pointer : ''}]`;
  const out = [], seen = new Map();
  for (const p of report.problems) {
    const key = `${p.rule}|${p.prop ?? ''}|${p.severity}`;
    const n = (seen.get(key) ?? 0) + 1; seen.set(key, n);
    if (!p.prop || n <= group) out.push(line(p));
    else if (n === group + 1) out.push({ key });   // a count line, filled in below
  }
  return out.map(l => { if (typeof l === 'string') return l; const n = seen.get(l.key); const [rule, prop, sev] = l.key.split('|'); return `${sev === 'error' ? 'ERROR' : 'warn '} ${rule.padEnd(18)} … and ${n - group} more ${prop} with the same problem (--json lists them)`; });
}

// ---------- the plan view ----------
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export function planSvg(subject, report) {
  const cfg = subject.world;
  const byId = new Map((subject.catalog?.props ?? []).map(p => [p.id, p]));
  const [W, D] = cfg.size ?? [24, 24];
  const M = 9, S = 22;                                  // margin metres, pixels per metre
  const vw = (W + 2 * M) * S, vh = (D + 2 * M) * S + 60;
  const X = x => ((x + W / 2 + M) * S).toFixed(1), Z = z => ((z + D / 2 + M) * S).toFixed(1);
  const bad = new Map();
  for (const p of report.problems) if (p.index !== null && p.index !== undefined) bad.set(p.index, p.severity === 'error' ? '#e0204a' : '#ff9f1a');
  const shape = (f, fill, stroke, sw = 1, extra = '') => {
    if (!f) return '';
    if (f.shape === 'circle') return `<circle cx="${X(f.cx)}" cy="${Z(f.cz)}" r="${(f.r * S).toFixed(1)}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}" ${extra}/>`;
    const pts = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([u, v]) => { const [x, z] = turn(u * f.hx, v * f.hz, f.yaw ?? 0); return `${X(f.cx + x)},${Z(f.cz + z)}`; }).join(' ');
    return `<polygon points="${pts}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}" ${extra}/>`;
  };
  const fills = { solid: '#8d7fb0', backdrop: '#d8b98f', decor: '#7fc98f', item: '#ffd23f', flat: 'none', sky: 'none' };
  const out = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${vw} ${vh}" width="${vw}" height="${vh}" font-family="system-ui,sans-serif">`);
  out.push(`<rect width="${vw}" height="${vh}" fill="${cfg.ground?.outer ?? '#ddd'}"/>`);
  out.push(`<rect x="${X(-W / 2)}" y="${Z(-D / 2)}" width="${W * S}" height="${D * S}" fill="${cfg.ground?.color ?? '#ccc'}" stroke="#2b2140" stroke-width="2" stroke-dasharray="8 5"/>`);
  for (let x = -Math.floor(W / 2); x <= W / 2; x += 1) out.push(`<line x1="${X(x)}" y1="${Z(-D / 2)}" x2="${X(x)}" y2="${Z(D / 2)}" stroke="#000" stroke-opacity="${x % 5 === 0 ? 0.12 : 0.04}"/>`);
  for (let z = -Math.floor(D / 2); z <= D / 2; z += 1) out.push(`<line x1="${X(-W / 2)}" y1="${Z(z)}" x2="${X(W / 2)}" y2="${Z(z)}" stroke="#000" stroke-opacity="${z % 5 === 0 ? 0.12 : 0.04}"/>`);
  for (const [zn, z] of Object.entries(cfg.zones ?? {})) {
    const at = z.at ?? [0, 0, 0], s = z.size ?? [1];
    const f = (z.shape ?? 'circle') === 'circle' ? { shape: 'circle', cx: at[0], cz: at[2], r: s[0] } : { shape: 'box', cx: at[0], cz: at[2], hx: s[0] / 2, hz: (s[2] ?? s[0]) / 2, yaw: 0 };
    out.push(shape(f, 'none', '#3a6df0', 1.5, 'stroke-dasharray="4 4"'));
    out.push(`<text x="${X(at[0])}" y="${Z(at[2])}" font-size="11" fill="#3a6df0" text-anchor="middle">${esc(zn)}</text>`);
  }
  const all = expandLayout(cfg);
  const order = ['flat', 'backdrop', 'solid', 'decor', 'item'];
  const items = all.map((p, i) => ({ p, i, meta: byId.get(p.prop) })).filter(o => o.meta);
  const clsOf = o => { const tags = new Set(o.meta.tags ?? []); const solid = !!(o.meta.collider && o.meta.collider !== 'none' && o.meta.collider.shape); const h = o.meta.size[1] * placementScale(o.p)[1];
    if (tags.has('sky') || tags.has('cloud') || (o.p.at?.[1] ?? 0) > 12 || (tags.has('ceiling') && cfg.ceiling)) return 'sky'; if (tags.has('backdrop') || tags.has('building')) return 'backdrop';
    if (!solid && (h <= 0.06 || ['floor', 'tile', 'rug', 'path'].some(x => tags.has(x)))) return 'flat'; if (tags.has('item') || tags.has('pickup')) return 'item'; return solid ? 'solid' : 'decor'; };
  for (const cls of order) for (const o of items.filter(o => clsOf(o) === cls)) {
    const vis = footprint(o.p, o.meta, 'visual');
    const col = bad.get(o.i);
    out.push(`<g><title>${esc(`#${o.i} ${o.p.prop} (${cls})`)}</title>${shape(vis, cls === 'flat' ? 'none' : fills[cls], col ?? (cls === 'flat' ? '#00000030' : '#2b2140'), col ? 3 : 0.8, `fill-opacity="${cls === 'backdrop' ? 0.8 : 0.75}"`)}</g>`);
    if (SEAT_TAGS(o.meta)) { const [fx, fz] = turn(0, 1, placementYaw(o.p)); out.push(`<line x1="${X(o.p.at[0])}" y1="${Z(o.p.at[2])}" x2="${X(o.p.at[0] + fx * 0.9)}" y2="${Z(o.p.at[2] + fz * 0.9)}" stroke="#2b2140" stroke-width="2"/>`); }
  }
  (cfg.spawns ?? []).forEach((s, i) => {
    out.push(`<circle cx="${X(s[0])}" cy="${Z(s[2])}" r="${(0.45 * S).toFixed(1)}" fill="#ff5fa2" stroke="#fff" stroke-width="2"/><text x="${X(s[0])}" y="${(+Z(s[2]) + 4).toFixed(1)}" font-size="11" font-weight="700" fill="#fff" text-anchor="middle">${i}</text>`);
  });
  let n = 0;
  for (const p of report.problems) if (p.at) { n++; out.push(`<text x="${(+X(p.at[0]) + 6).toFixed(1)}" y="${(+Z(p.at[2]) - 6).toFixed(1)}" font-size="12" font-weight="700" fill="${p.severity === 'error' ? '#e0204a' : '#d07000'}">${esc(p.rule)}</text>`); }
  out.push(`<text x="10" y="${vh - 36}" font-size="16" font-weight="700" fill="#2b2140">${esc(`${cfg.template} (${subject.kind} ${basename(String(subject.target))}): ${report.ok ? 'pass' : 'FAIL'} · ${report.errors} errors · ${report.warnings} warnings · open floor ${(report.stats.openFloor * 100).toFixed(0)}%`)}</text>`);
  out.push(`<text x="10" y="${vh - 14}" font-size="12" fill="#2b2140">purple solid · tan backdrop · green decor · yellow item · outline flat cover · pink spawns · blue zones · red/orange outline = error/warning · ticks show which way seats face · grid 1 m</text>`);
  out.push('</svg>');
  return out.join('\n');
}
function SEAT_TAGS(meta) { return (meta.tags ?? []).some(x => SEAT.has(x)); }
