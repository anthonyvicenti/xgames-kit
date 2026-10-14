// verify check 17, "the world is complete" (track D, after the creator's "Hang Up On Them" verdict, 2026-10-07: "The
// open world is small and feels way too similar to the baseline pee game ... we need to make the worlds actually
// complete and make sense"). Static, no browser: it reads config/world.json, the game's prop catalog, config/game.json
// and the spec, the way tools/lib/dressing.mjs (check 11) does. Runs in --quick.
//
//   const subject = await loadWorldSubject('<game dir>' | '<template>' | '<template>:<size>' | '<layout.json>');
//   const report  = checkWorld(subject);   // { ok, errors, warnings, problems: [{rule, severity, message, fix}], stats }
//
// It fails (errors) when:
//   size        the play area does not match the size class the spec asked for (kit/world/generate.js SIZE_CLASSES)
//   spaces      a medium or large world is one open space (medium: 3 rooms or areas, large: 5)
//   ceiling     an indoor world has no ceiling over its play area
//   walls       an indoor world's outside walls have gaps that are not doors (a doorway prop), or an outdoor world's
//               edge has gaps that are not gates (its fence, hedge, wall or buildings stop)
//   door        a doorway nobody can walk through (its collider closes the opening)
//   outside     an outside prop of an indoor world shows over the walls (a tree on a plain), not a street or skyline
//   continues   the view past the walls or edge shows nothing: too few directions from the middle meet a building
//               (indoor) or a building, tree or hill (outdoor) within 120 m
//   entries     enemies come in (waves) but the world names no real door or gate for them (entries), too few for the
//               size, an entry that is not at a door or gate, or a solid standing in an entry's way in
//   rooms       a room no door reaches
// and notes (warnings): reach (a spawn, zone or entry the character's own jump cannot get to: kit/world/reach.js over
// the colliders the loader builds, kit/world/colliders.js; a warning, never failing a game, until a corpus run has shown
// it on every delivered game: open builder wave 10), filled ground (of the floor, how much has something within 3 m) and the three scales of things
// per room (big, middle, small), after genex-desktop's liveness recipes (MIT; research bank).
// A scenic world (gf-scenic: island, isles, ruins, dungeon; 2026-10-08) is checked by checkScenicWorld instead: each
// level's size, a level for every one the game plays, spawns for every seat, a way on from every level but the last.
import { readFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { KIT, kitPath, SCENIC_KIT } from './paths.mjs';
import { propsCatalog } from '../../art/views.mjs';
import { flatOf } from './flat-reads.mjs';
import { expandLayout, footprint, placementScale, colliderParts, roomGraph, turn } from '../../../worlds/layout.js';
import { importLayer } from './kit-import.mjs';
// kit modules whose imports cross layers: through the hook (kit-import.mjs importLayer)
const { generateLayout, SIZE_CLASSES, sizeClassOf } = await importLayer(kitPath(KIT, 'world/generate.js'));
// the scenic-3d profile's templates and what each defaults to (its generator's own manifest)
const { templates: scenicTemplates, templateInfo: scenicInfo } = await importLayer(join(SCENIC_KIT, 'world/generate.js'));
const { reachOf, movementOf } = await importLayer(kitPath(KIT, 'world/reach.js'));
const { collidersOf } = await importLayer(kitPath(KIT, 'world/colliders.js'));

export const RULES = {
  size: 'the play area does not match its size class',
  spaces: 'a medium or large world is a single open space',
  ceiling: 'an indoor world has no ceiling',
  walls: 'an indoor world\'s walls (or an outdoor world\'s edge) have gaps that are not doors or gates',
  door: 'a doorway nobody can walk through',
  outside: 'an outside prop shows over an indoor world\'s walls',
  continues: 'the view past the walls or edge shows nothing (a void or a plain)',
  entries: 'enemies come in, but not through real doors or gates',
  rooms: 'a room no door reaches',
  filled: 'little of the floor has anything near it (warning)',
  scales: 'a room lacks big, middle or small things (warning)',
  reach: 'a spawn, zone or entry the character cannot get to with its own jump (warning)',
};
export const T = { gap: 0.6, outdoorGap: 3.0, sample: 0.25, wallPad: 0.3, continuesMin: 0.75, rays: 16, reach: 120, filled: 0.6, filledRadius: 3, doorMin: 0.8, entryNear: 0.5, gateNear: 1.6, wayIn: 2.5, wayFree: 0.9, wayStep: 0.5 };
const BACKDROP = new Set(['building', 'backdrop']);
const STREET = new Set(['lamp', 'light', 'street', 'sky', 'cloud']);
const EDGE = new Set(['wall', 'fence', 'hedge', 'gate', 'building', 'backdrop']);

async function readJson(p) { return JSON.parse(await readFile(p, 'utf8')); }
async function readJsonMaybe(p) { try { return await readJson(p); } catch { return null; } }

/** A game folder, a template id (optionally `id:size`), or a layout file → the subject check 17 reads. */
export async function loadWorldSubject(target) {
  const [tid, tsize] = String(target).split(':');
  const tfile = kitPath(KIT, 'world/templates', `${tid}.json`);
  if (!target.includes('/') && existsSync(tfile)) {
    const recipe = await readJson(tfile);
    const world = generateLayout(recipe, { size: tsize ?? 'small' });
    return { kind: 'template', target, world, recipe, catalog: propsCatalog('three'), game: null, spec: null, intent: tsize ?? 'small' };
  }
  if (existsSync(target) && statSync(target).isDirectory()) {
    const dir = resolve(target);
    const world = await readJson(join(dir, 'config/world.json'));
    const catalog = await readJsonMaybe(join(dir, 'config/props.json')) ?? propsCatalog('three');
    const game = await readJsonMaybe(join(dir, 'config/game.json'));
    const spec = await readJsonMaybe(join(dir, 'spec.json'));
    const recipe = await readJsonMaybe(kitPath(KIT, 'world/templates', `${world.template}.json`));
    // the size the creator agreed to: the spec's, else what the world says it is
    const intent = spec?.world?.size ?? world.sizeClass ?? (typeof world.size === 'string' ? world.size : null) ?? 'small';
    const profile = (await readJsonMaybe(join(dir, 'gf-three.json')))?.kit?.profile ?? null;
    return { kind: 'game', target, dir, world, recipe, catalog, game, spec, intent, profile };
  }
  if (existsSync(target)) {
    const world = await readJson(target);
    return { kind: 'layout', target, world, recipe: await readJsonMaybe(kitPath(KIT, 'world/templates', `${world.template}.json`)), catalog: propsCatalog('three'), game: null, spec: null, intent: world.sizeClass ?? 'small' };
  }
  throw new Error(`world check: no template, layout file or game directory "${target}"`);
}

const fmt = n => (Math.round(n * 10) / 10).toString();
const sideName = { '-z': 'back', '+z': 'front', '-x': 'left', '+x': 'right' };

// The scenic-3d profile's worlds (CONTRACT §8): islands, floating isles, ruins and dungeons generated by
// gf/scenic/world. They have no rectangle, walls or ceiling; what a player needs from them is the size they were asked for
// on every level, a level for each one the game plays, spawns for every seat, and a way on from every level but the last.
export const SCENIC_TEMPLATES = [...scenicTemplates];
export const SCENIC_RULES = {
  size: 'a level\'s walkable area does not match its size class',
  levels: 'the game plays more levels than the world has, or a level has no arena',
  spawns: 'a level has fewer spawns than seats, or a spawn off its ground',
  'way-on': 'a level before the last has no portal or door zone to the next',
  overlap: 'two levels overlap',
};
/** Is this subject a scenic-3d world? (its template, else the game's profile in gf-three.json) */
export const isScenic = subject => SCENIC_TEMPLATES.includes(subject.world?.template) || subject.profile === 'scenic-3d';

/**
 * The reach rule (open builder wave 10, track H): every spawn, zone and entry a player must get to (a scenic level's
 * spawns, arena and portal), from the first spawn, by walking and by the jump config/game.json gives the character,
 * over the colliders the world's loader builds. A WARNING for now (the parent's call, 2026-10-11): reported under check
 * 17, never failing a game, until a corpus run has shown it on every delivered game. → [{target, message}] and stats
 */
export function reachOfSubject(subject) {
  const cfg = subject.world;
  if (!cfg || !(Array.isArray(cfg.levels) || Array.isArray(cfg.props))) return { problems: [], stats: null };
  const r = reachOf(cfg, collidersOf(cfg, subject.catalog), movementOf(subject.game ?? {}));
  return { problems: r.problems, stats: { targets: r.stats.targets, refused: r.problems.length, jumps: r.jumps.length, up: r.numbers.up, across: r.numbers.across } };
}
const REACH_FIX = 'lower the step up to it or add a way up (a ramp or a block the jump reaches); node builder/tools/places-reach.mjs <game> drives the jumps with the character';

/** How many levels the game plays: the levels mechanic's count (config/game.json or the spec), else rules.params.levels. */
function levelsAsked(subject) {
  const fromList = list => (list ?? []).find(m => m?.id === 'levels')?.params?.count;
  const game = subject.game ?? {};
  const mech = Array.isArray(game.mechanics) ? fromList(game.mechanics) : game.mechanics?.levels?.count ?? game.mechanics?.levels?.params?.count;
  const n = Number(mech ?? fromList(subject.spec?.mechanics) ?? subject.spec?.rules?.params?.levels ?? (scenicInfo[subject.world?.template]?.defaultLevels ?? 1));
  return Math.max(1, Math.round(n) || 1);
}

/**
 * A scenic level's play area. An island is round: the disc of its radius. A level made of rooms (a dungeon: `box` is
 * the rectangle round its room set, with a 1 m margin) is measured like every other building here, by the rectangle
 * its rooms stand in. Before 2026-10-10 a dungeon was measured as a disc over the half-diagonal of that rectangle
 * (`radius`), which called a 39 x 27 m room set "1981 m² walkable" and failed every dungeon create made for "medium".
 * → {area (m²), size: [w, d], how (words for the message)}
 */
export function scenicLevelArea(L, r) {
  const b = Array.isArray(L?.box) && L.box.length === 4 && L.box.every(Number.isFinite) ? L.box : null;
  if (b && Array.isArray(L.rooms) && L.rooms.length) {
    const w = Math.max(0, b[2] - b[0] - 2), d = Math.max(0, b[3] - b[1] - 2);
    return { area: w * d, size: [+w.toFixed(1), +d.toFixed(1)], how: `${L.rooms.length} rooms in ${fmt(w)} x ${fmt(d)} m (${Math.round(w * d)} m²)` };
  }
  // an island with its outline (every island gf/scenic/world lays out): the ground inside its rim. Before wave 10 every
  // island was measured as the disc of its nominal radius, which under-counts the squarish outline by about a tenth:
  // a radius-24 island walks 1951-2017 m² inside its rim and was called 1810, under "large"'s 1900 (the places spike)
  const walk = islandWalkArea(L);
  if (walk !== null) return { area: walk, size: [+(r * 2).toFixed(1), +(r * 2).toFixed(1)], how: `${fmt(r * 2)} m across (${Math.round(walk)} m² walkable inside its rim)` };
  return { area: Math.PI * r * r, size: [+(r * 2).toFixed(1), +(r * 2).toFixed(1)], how: `${fmt(r * 2)} m across (${Math.round(Math.PI * r * r)} m² walkable)` };
}

/** An island level's outline radius at angle a (radians): runtimes/three/profiles/scenic-3d/kit/world/generate.js outlineRadius, a superellipse
 *  with a seeded wobble, read from the level's own `shape` (tests/d-worlds.test.mjs holds the two equal). */
export function islandOutline(shape, a) {
  const n = shape.n ?? 5, R = shape.radius, c = Math.abs(Math.cos(a - (shape.rot ?? 0))), s = Math.abs(Math.sin(a - (shape.rot ?? 0)));
  let w = 0;
  for (const [k, amp, ph] of shape.wobble ?? []) w += amp * Math.sin(k * a + ph);
  return R * Math.pow(Math.pow(c, n) + Math.pow(s, n), -1 / n) * (1 + w);
}
/** The ground inside an island level's rim (its outline less `rimInset`, gf/scenic/world's walkRadius), m²; null for a
 *  level with no outline. Shallow water (0.45 m) is ground a player wades through, so it counts. */
export function islandWalkArea(L, N = 720) {
  if (!(Number(L?.shape?.radius) > 0)) return null;
  let A = 0;
  for (let i = 0; i < N; i++) { const r = Math.max(0, islandOutline(L.shape, (i / N) * Math.PI * 2) - (L.rimInset ?? 1.2)); A += r * r * Math.PI / N; }
  return A;
}

/** Check 17 for a scenic world. Same report shape as checkWorld (stats.size is the first level's span). */
export function checkScenicWorld(subject) {
  const cfg = subject.world, t = cfg.template ?? 'world';
  const intent = SIZE_CLASSES[subject.intent] ? subject.intent : 'small';
  const cls = SIZE_CLASSES[intent];
  const problems = [];
  const add = (rule, severity, message, fix = null) => problems.push({ rule, severity, message, fix, slot: `world.${t}.layout` });
  const R = Number(cfg.radius ?? cfg.half ?? 0) || 0;
  const levels = Array.isArray(cfg.levels) && cfg.levels.length ? cfg.levels : [{ id: 'level-1', at: [0, 0, 0], radius: R, last: true, spawns: cfg.spawns ?? [], zones: cfg.zones ?? {} }];
  const seats = Math.max(1, Number(subject.spec?.players?.max ?? subject.game?.players?.max ?? 4) || 4);
  const asked = levelsAsked(subject);
  const regen = 'node builder/tools/create.mjs <game>/spec.json <game> --force, or create again: the scenic world module generates one island or room set per level';
  if (levels.length < asked) add('levels', 'error', `the game plays ${asked} levels but config/world.json has ${levels.length}`, regen);
  for (const [i, L] of levels.entries()) {
    const r = Number(L.radius ?? R) || 0, name = L.id ?? `level ${i + 1}`;
    const { area, how } = scenicLevelArea(L, r);
    if (area < cls.area[0] || area > cls.area[1]) add('size', 'error', `${name} is ${how}; the spec asks for "${intent}", which needs ${cls.area[0]}–${cls.area[1]} m² (${cls.describe})`, regen);
    const at = L.at ?? [0, 0, 0];
    const sp = L.spawns ?? [];
    if (sp.length < seats) add('spawns', 'error', `${name} has ${sp.length} spawns for ${seats} seats`, regen);
    const off = sp.filter(p => Math.hypot(p[0] - at[0], p[2] - at[2]) > r - 0.5);
    if (off.length) add('spawns', 'error', `${name}: ${off.length} spawn(s) at the edge or off the ground (more than ${fmt(r - 0.5)} m from its middle)`, 'move them inward in config/world.json → levels[].spawns');
    if (!L.zones?.arena && !(i === 0 && cfg.zones?.centre)) add('levels', 'error', `${name} has no arena zone (where its fight happens)`, regen);
    const last = L.last ?? i === levels.length - 1;
    if (!last && !['portal', 'door', 'exit', 'gate'].some(z => L.zones?.[z])) add('way-on', 'error', `${name} is not the last level, but has no portal, door or exit zone to the next`, regen);
    for (const M of levels.slice(i + 1)) {
      const d = Math.hypot((M.at?.[0] ?? 0) - at[0], (M.at?.[2] ?? 0) - at[2]);
      if (d < r + (Number(M.radius ?? R) || 0)) add('overlap', 'error', `${name} and ${M.id ?? 'the next level'} overlap (${fmt(d)} m apart)`, regen);
    }
  }
  const reachRule = reachOfSubject(subject);
  for (const p of reachRule.problems) problems.push({ rule: 'reach', severity: 'warning', message: p.message, fix: REACH_FIX, slot: `world.${t}.layout`, target: p.target });
  const notes = [`a scenic ${t}: the indoor and edge rules (walls, ceiling, doors, gates, entries, the view past the edge) do not apply; its edge is cliff, water or void, drawn by gf/scenic/world`];
  for (const n of notes) problems.push({ rule: 'scenic', severity: 'warning', message: n, fix: null, slot: `world.${t}.layout` });
  const errors = problems.filter(p => p.severity === 'error').length;
  const r0 = Number(levels[0].radius ?? R) || 0;
  const a0 = scenicLevelArea(levels[0], r0);
  return {
    tool: 'builder/tools/world.mjs', check: 17, target: subject.target, template: t, kind: cfg.kind ?? t, profile: 'scenic-3d', ok: errors === 0, errors, warnings: problems.length - errors, problems,
    stats: { size: a0.size, area: Math.round(a0.area), sizeClass: intent, measuredClass: sizeClassOf(a0.area), rooms: 0, levels: levels.length, levelsAsked: asked, radius: r0, entries: 0, ceiling: null, filledGround: 0, reach: reachRule.stats },
  };
}

/** The world check. → { ok, errors, warnings, problems, stats } */
export function checkWorld(subject) {
  if (isScenic(subject)) return checkScenicWorld(subject);
  const cfg = subject.world;
  const t = cfg.template ?? 'world';
  const byId = new Map((subject.catalog?.props ?? []).map(p => [p.id, p]));
  const [W, D] = Array.isArray(cfg.size) ? cfg.size : [24, 24];
  const kind = cfg.kind ?? subject.recipe?.kind ?? (cfg.ceiling ? 'indoor' : 'outdoor');
  const intent = SIZE_CLASSES[subject.intent] ? subject.intent : 'small';
  const cls = SIZE_CLASSES[intent];
  const problems = [];
  const add = (rule, severity, message, fix = null, extra = {}) => problems.push({ rule, severity, message, fix, slot: extra.slot ?? `world.${t}.layout`, ...extra });
  const all = expandLayout(cfg).map((p, i) => ({ p, i, meta: byId.get(p.prop) })).filter(q => q.meta);
  const tagsOf = q => new Set(q.meta.tags ?? []);
  const topOf = q => (q.p.at?.[1] ?? 0) + (q.meta.size?.[1] ?? 1) * placementScale(q.p)[1];
  const vis = q => footprint(q.p, q.meta, 'visual');
  const inPlay = (x, z, pad = 0) => Math.abs(x) <= W / 2 + pad && Math.abs(z) <= D / 2 + pad;
  const mid = cfg.zones?.centre?.at ?? [0, 0, 0];
  const area = W * D;

  // ---- size: the play area against the size class the spec asked for ----
  const got = sizeClassOf(area);
  if (area < cls.area[0] || area > cls.area[1])
    add('size', 'error', `the play area is ${fmt(W)} x ${fmt(D)} m (${Math.round(area)} m², ${['small', 'medium', 'large'].includes(got) ? `a ${got} world` : got}); the spec asks for "${intent}", which needs ${cls.area[0]}–${cls.area[1]} m² (${cls.describe})`,
      `re-lay the world at the spec's size: node builder/tools/create.mjs <game>/spec.json <game> --force (kit/world/generate.js), or set config/world.json size`, { slot: `world.${t}.layout` });

  // ---- spaces: rooms (indoor) or named areas (outdoor) ----
  const rooms = cfg.rooms ?? [];
  const areas = kind === 'indoor' ? rooms.length : Object.values(cfg.zones ?? {}).filter(z => z.shape === 'box').length;
  if (cls.spaces > 1 && Math.max(1, areas) < cls.spaces)
    add('spaces', 'error', `a ${intent} world needs at least ${cls.spaces} ${kind === 'indoor' ? 'rooms joined by doors' : 'areas'}; this one is ${areas <= 1 ? 'one open space' : `${areas} spaces`}`, 're-lay the world from the template (create again with --force): the generator gives a medium office five side rooms around the open floor');

  // the wall pieces and doorways
  const walls = all.filter(q => tagsOf(q).has('wall') && !tagsOf(q).has('hedge'));
  const wallTop = walls.length ? Math.max(...walls.map(topOf)) : 0;
  const isDoor = q => !!q.meta.door || tagsOf(q).has('door') || /doorway/.test(q.p.prop);
  const isGate = q => tagsOf(q).has('gate') || isDoor(q);

  // ---- doors you can walk through: a doorway's collider must leave the opening free ----
  for (const q of all.filter(isDoor)) {
    const parts = colliderParts(q.meta);
    const width = q.meta.door?.width ?? 0;
    const closed = parts.length === 1 && parts[0].shape === 'box' && (parts[0].size?.[0] ?? 0) >= (q.meta.size?.[0] ?? 0) - 0.05;
    if (closed || (parts.length > 1 && width < T.doorMin))
      add('door', 'error', `${q.p.prop} #${q.i} at (${fmt(q.p.at[0])}, ${fmt(q.p.at[2])}) is a doorway nobody can walk through: ${closed ? 'its collider is one solid box across the opening' : `its opening is ${width} m`}`, 'use the library\'s current doorway (office-wall-doorway-wide: two posts and a lintel, a 1.7 m opening); config/props.json may hold an old copy', { slot: `prop.${q.p.prop}`, prop: q.p.prop, at: q.p.at });
  }

  // ---- the perimeter: walls all round (indoor) or an edge all round (outdoor), openings only at doors or gates ----
  const edgeProps = kind === 'indoor' ? walls : all.filter(q => [...tagsOf(q)].some(x => EDGE.has(x)));
  // an outdoor edge may open where the world names an entry (a street into a square, a garden gate)
  const entryGap = (x, z) => kind !== 'indoor' && (cfg.entries ?? []).some(e => Math.hypot(e.at[0] - x, e.at[2] - z) <= (e.width ?? 2) / 2 + 0.75);
  const coverAt = (x, z, pad) => {
    if (entryGap(x, z)) return 'door';
    let hit = null;
    for (const q of edgeProps) {
      const f = vis(q);
      const [lx, lz] = turn(x - f.cx, z - f.cz, -(f.yaw ?? 0));
      if (Math.abs(lx) <= f.hx + pad && Math.abs(lz) <= f.hz + pad) { if (isGate(q)) return 'door'; hit = 'wall'; }
    }
    return hit ?? 'open';
  };
  const runs = [];
  const sides = [['-z', -W / 2, W / 2, u => [u, -D / 2]], ['+z', -W / 2, W / 2, u => [u, D / 2]], ['-x', -D / 2, D / 2, u => [-W / 2, u]], ['+x', -D / 2, D / 2, u => [W / 2, u]]];
  let openLen = 0, doorLen = 0, perim = 0;
  const pad = kind === 'indoor' ? T.wallPad : 2.5;                // an outdoor edge may stand a little inside or outside the line
  for (const [side, a, b, pt] of sides) {
    let run = null;
    for (let u = a + T.sample / 2; u < b; u += T.sample) {
      const [x, z] = pt(u);
      const c = coverAt(x, z, pad);
      perim += T.sample;
      if (c === 'door') doorLen += T.sample;
      if (c === 'open') { openLen += T.sample; if (!run) run = { side, from: u, to: u }; else run.to = u; }
      else if (run) { runs.push(run); run = null; }
    }
    if (run) runs.push(run);
  }
  const maxGap = kind === 'indoor' ? T.gap : T.outdoorGap;
  const gaps = runs.filter(r => r.to - r.from + T.sample > maxGap);
  if (gaps.length) {
    const say = r => `the ${sideName[r.side]} ${kind === 'indoor' ? 'wall' : 'edge'} (${r.side.endsWith('z') ? `z = ${fmt(r.side[0] === '-' ? -D / 2 : D / 2)}` : `x = ${fmt(r.side[0] === '-' ? -W / 2 : W / 2)}`}) is open for ${fmt(r.to - r.from + T.sample)} m (${r.side.endsWith('z') ? 'x' : 'z'} ${fmt(r.from)} to ${fmt(r.to)})`;
    add('walls', 'error', kind === 'indoor'
      ? `the building is not closed: ${gaps.slice(0, 4).map(say).join('; ')}${gaps.length > 4 ? `; and ${gaps.length - 4} more gaps` : ''}. Only doors may open to the outside`
      : `the edge does not go all round: ${gaps.slice(0, 4).map(say).join('; ')}${gaps.length > 4 ? `; and ${gaps.length - 4} more gaps` : ''}. Only gates may break it`,
    'close the edge with the template\'s wall or fence pieces (re-lay the world: create again with --force), leaving gaps only where entries are');
  }

  // ---- the ceiling ----
  if (kind === 'indoor') {
    const h = cfg.ceiling?.height;
    if (!h) add('ceiling', 'error', `no ceiling: the ${fmt(W)} x ${fmt(D)} m play area is open to the sky (config/world.json has no ceiling)`, 're-lay the world from the template (create again with --force): indoor worlds get a cutaway ceiling over every room', { slot: `world.${t}.ceiling.color` });
    else if (h < wallTop - 0.05) add('ceiling', 'error', `the ceiling (${fmt(h)} m) is lower than the walls (${fmt(wallTop)} m)`, 'raise config/world.json ceiling.height to the wall tops', { slot: `world.${t}.ceiling.color` });
  }

  // ---- outside an indoor world: a street or skyline, not a plain with trees over the walls ----
  if (kind === 'indoor') {
    const over = all.filter(q => {
      const at = q.p.at ?? [0, 0, 0], tags = tagsOf(q);
      if (inPlay(at[0], at[2], 0.3) || (at[1] ?? 0) > 12) return false;
      if ([...tags].some(x => BACKDROP.has(x) || STREET.has(x))) return false;
      return topOf(q) > Math.max(wallTop, 2.6) + 0.05;
    });
    const byProp = new Map(); for (const q of over) byProp.set(q.p.prop, [...(byProp.get(q.p.prop) ?? []), q]);
    if (over.length) add('outside', 'error', `outside props show over the ${fmt(Math.max(wallTop, 2.6))} m walls: ${[...byProp.entries()].map(([id, l]) => `${l.length} ${id} (${fmt(topOf(l[0]))} m, e.g. at ${fmt(l[0].p.at[0])}, ${fmt(l[0].p.at[2])})`).join(', ')}. An indoor world's outside is a street or a skyline, not a plain with trees`, 'remove them; the office template puts a street, street lights and city blocks outside', { prop: over[0].p.prop });
  }

  // ---- the world continues: from the middle, what lies past the walls or edge in each direction ----
  {
    const far = all.filter(q => {
      const tags = tagsOf(q);
      if (inPlay(q.p.at[0], q.p.at[2], 0.5) && !(tags.has('building') || tags.has('backdrop'))) return false;
      if (tags.has('sky') || tags.has('cloud') || (q.p.at?.[1] ?? 0) > 12) return false;
      if (kind === 'indoor') return [...tags].some(x => BACKDROP.has(x));
      return topOf(q) >= 1.5;                                     // a building, tree, hedge or hill: something to see
    });
    let seen = 0;
    const misses = [];
    const near = kind === 'indoor' ? 0.5 : 1.5;                   // a tree's crown fills more of the view than its trunk
    for (let k = 0; k < T.rays; k++) {
      const a = (k / T.rays) * Math.PI * 2, dx = Math.sin(a), dz = Math.cos(a);
      const hit = far.some(q => { const f = vis(q); for (let d = 2; d <= T.reach; d += 1.5) { const x = mid[0] + dx * d, z = mid[2] + dz * d; if (inPlay(x, z, 0.5)) continue; const [lx, lz] = turn(x - f.cx, z - f.cz, -(f.yaw ?? 0)); if (Math.abs(lx) <= f.hx + near && Math.abs(lz) <= f.hz + near) return true; } return false; });
      if (hit) seen++; else misses.push(Math.round(a * 180 / Math.PI));
    }
    const share = seen / T.rays;
    if (share < T.continuesMin) add('continues', 'error', `the world stops at the ${kind === 'indoor' ? 'walls' : 'edge'}: only ${seen} of ${T.rays} directions from the middle meet ${kind === 'indoor' ? 'a building (a street or skyline)' : 'a building, tree or hill'} within ${T.reach} m (nothing at ${misses.slice(0, 6).join('°, ')}°${misses.length > 6 ? ', …' : ''})`, kind === 'indoor' ? 'put city blocks round the building (the office template\'s outside recipe)' : 'ring the edge with backdrop buildings, trees or hills');
  }

  // ---- entries: where enemies come in ----
  // an entry nobody can come through: across the opening (less 0.2 m a side), from 0.5 m to T.wayIn inside, the widest
  // free run at some depth is narrower than a body (T.wayFree). A solid lower than a step (T.wayStep) is walked over.
  // → {q, f, d, free} (the first solid at that depth) | null
  const wayInBlocker = e => {
    const [nx, nz] = e.normal ?? [0, 0];
    if (!nx && !nz) return null;
    const half = Math.max(0, (e.width ?? 1.6) / 2 - 0.2);
    const inBox = (f, x, z) => { if (f.shape === 'circle') return Math.hypot(x - f.cx, z - f.cz) <= f.r; const [lx, lz] = turn(x - f.cx, z - f.cz, -(f.yaw ?? 0)); return Math.abs(lx) <= f.hx && Math.abs(lz) <= f.hz; };
    const solids = all.filter(q => !isGate(q) && ![...tagsOf(q)].some(x => EDGE.has(x))).map(q => ({ q, f: footprint(q.p, q.meta, 'collider') }))
      .filter(s => s.f && s.f.y0 < 1 && s.f.y1 > T.wayStep);
    for (let d = 0.5; d <= T.wayIn + 1e-6; d += T.sample) {
      let run = 0, best = 0, hit = null;
      for (let u = -half; u <= half + 1e-6; u += T.sample) {
        const x = e.at[0] - nx * d - nz * u, z = e.at[2] - nz * d + nx * u;
        const s = solids.find(({ f }) => (f.parts ?? [f]).some(pf => inBox(pf, x, z)));
        if (s) { hit ??= s; run = 0; } else { run += T.sample; best = Math.max(best, run); }
      }
      if (hit && best < T.wayFree) return { ...hit, d, free: best };
    }
    return null;
  };
  const enemies = (subject.game?.mechanics ?? []).some(m => m.id === 'waves');
  const entries = cfg.entries ?? [];
  if (enemies || (kind === 'indoor' && intent !== 'small')) {
    const need = Math.min(cls.entries, enemies ? cls.entries : 1);
    if (!entries.length) add('entries', 'error', enemies ? 'enemies come in anywhere along the play-area edge: the layout names no entries (real doors or gates for them)' : 'the building has no door to the outside (entries)', 're-lay the world from the template (create again with --force): its entries are real doors, and the waves mechanic brings enemies in through them');
    else if (entries.length < need) add('entries', 'error', `${entries.length} ${entries.length === 1 ? 'entry' : 'entries'} for a ${intent} world; enemies should come in from at least ${need} sides`, 'add entries (doors or gates) in config/world.json, or re-lay the world');
    for (const e of entries) {
      const near = all.filter(q => isGate(q) && Math.hypot(q.p.at[0] - e.at[0], q.p.at[2] - e.at[2]) <= (kind === 'indoor' ? T.entryNear : T.gateNear));
      let gapHere = false;
      if (kind !== 'indoor') { const saved = cfg.entries; cfg.entries = []; gapHere = coverAt(e.at[0], e.at[2], 0.2) !== 'wall'; cfg.entries = saved; }
      if (!near.length && !gapHere) add('entries', 'error', `entry "${e.name}" at (${fmt(e.at[0])}, ${fmt(e.at[2])}) is not at a door or gate: enemies would walk out of a wall`, 'move the entry to a doorway, or put a doorway there', { at: e.at });
      // the way in: where the waves mechanic brings enemies in (kit/world/layout.js entryPoint: 1 m inside, across
      // the opening) and their first steps from there. A solid standing in it is a gate nobody comes through: the
      // places spike found a large arena's statue moved into its north gate (wave 10)
      const blocker = wayInBlocker(e);
      if (blocker) add('entries', 'error', `entry "${e.name}" at (${fmt(e.at[0])}, ${fmt(e.at[2])}) is blocked: ${blocker.q.p.prop} #${blocker.q.i} at (${fmt(blocker.q.p.at[0])}, ${fmt(blocker.q.p.at[2])}) stands in its way in, ${fmt(blocker.d)} m inside; enemies would come in inside it`, 're-lay the world (create again with --force): the generator keeps every gate\'s way in clear; or move the prop aside in config/world.json', { prop: blocker.q.p.prop, at: blocker.q.p.at });
    }
  }

  // ---- rooms: every room is reached through the doors ----
  if (rooms.length > 1) {
    const main = rooms.find(r => r.main) ?? rooms[0];
    const reach = roomGraph(cfg, main.id);
    const lost = rooms.filter(r => !reach.has(r.id));
    if (lost.length) add('rooms', 'error', `${lost.map(r => r.label ?? r.id).join(', ')} ${lost.length === 1 ? 'has' : 'have'} no door from the ${main.label ?? main.id}`, 're-lay the world (the generator joins every room)');
    for (const d of cfg.doors ?? []) {
      const at = all.some(q => isDoor(q) && Math.hypot(q.p.at[0] - d.at[0], q.p.at[2] - d.at[2]) <= T.entryNear);
      if (!at) add('rooms', 'error', `the door between ${d.rooms.join(' and ')} at (${fmt(d.at[0])}, ${fmt(d.at[2])}) has no doorway: walkers would be routed into a wall`, 're-lay the world');
    }
  }

  // ---- notes: filled ground and the three scales (genex-desktop's liveness recipes) ----
  const things = all.filter(q => { const tags = tagsOf(q); return !(tags.has('sky') || tags.has('cloud') || tags.has('ceiling') || (q.p.at?.[1] ?? 0) > 12) && (q.meta.size?.[1] ?? 0) * placementScale(q.p)[1] > 0.08; });
  const solids = things.filter(q => q.meta.collider && q.meta.collider !== 'none');
  let pts = 0, filled = 0;
  for (let x = -W / 2 + 0.5; x < W / 2; x += 1) for (let z = -D / 2 + 0.5; z < D / 2; z += 1) {
    if (solids.some(q => { const f = vis(q); const [lx, lz] = turn(x - f.cx, z - f.cz, -(f.yaw ?? 0)); return Math.abs(lx) < f.hx && Math.abs(lz) < f.hz; })) continue;
    pts++;
    if (things.some(q => Math.hypot(q.p.at[0] - x, q.p.at[2] - z) <= T.filledRadius + Math.max(q.meta.size?.[0] ?? 0, q.meta.size?.[2] ?? 0) / 2)) filled++;
  }
  const filledShare = pts ? filled / pts : 0;
  if (filledShare < T.filled) add('filled', 'warning', `only ${Math.round(filledShare * 100)}% of the floor has something within ${T.filledRadius} m (aim for ${T.filled * 100}%): stretches of it are empty`, 'dress the empty stretches with the template\'s groups (desk pods, beds, stalls) along routes and around the middle');
  const scaleRows = [];
  for (const r of rooms.length ? rooms : [{ id: 'play area', rect: [-W / 2, -D / 2, W / 2, D / 2] }]) {
    const [x0, z0, x1, z1] = r.rect;
    if ((x1 - x0) * (z1 - z0) < 40) continue;
    const inside = things.filter(q => q.p.at[0] >= x0 && q.p.at[0] <= x1 && q.p.at[2] >= z0 && q.p.at[2] <= z1 && !tagsOf(q).has('wall'));
    const h = q => (q.meta.size?.[1] ?? 0) * placementScale(q.p)[1];
    const row = { room: r.id, big: inside.filter(q => h(q) >= 1.5).length, middle: inside.filter(q => h(q) >= 0.5 && h(q) < 1.5).length, small: inside.filter(q => h(q) < 0.5).length };
    scaleRows.push(row);
    const lack = ['big', 'middle', 'small'].filter(k => row[k] === 0);
    if (lack.length) add('scales', 'warning', `${r.label ?? r.id} has no ${lack.join(' or ')} things (big ≥ 1.5 m, middle 0.5–1.5 m, small < 0.5 m): it reads as bare`, 'add a group with things of that size (a bookcase or plant; a desk or sofa; things on the desks)');
  }

  // ---- reach: what the character's own jump cannot get to (a warning; reachOfSubject) ----
  const reachRule = reachOfSubject(subject);
  for (const p of reachRule.problems) add('reach', 'warning', p.message, REACH_FIX, { target: p.target });

  // the worst first: a missing ceiling or wall, then the size, the rooms, the doors for enemies, the outside
  const order = ['ceiling', 'walls', 'size', 'spaces', 'entries', 'outside', 'continues', 'door', 'rooms', 'reach', 'filled', 'scales'];
  problems.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1) || order.indexOf(a.rule) - order.indexOf(b.rule));
  const errors = problems.filter(p => p.severity === 'error').length;
  return {
    tool: 'builder/tools/world.mjs', check: 17, target: subject.target, template: t, kind, ok: errors === 0, errors, warnings: problems.length - errors, problems,
    stats: { size: [W, D], area: Math.round(area), sizeClass: intent, measuredClass: got, rooms: rooms.length, areas, entries: entries.length, ceiling: cfg.ceiling?.height ?? null, wallTop: +wallTop.toFixed(2), perimeterOpen: +openLen.toFixed(1), perimeterDoors: +doorLen.toFixed(1), perimeter: +perim.toFixed(1), filledGround: +filledShare.toFixed(2), scales: scaleRows, reach: reachRule.stats },
  };
}

/** One plain-words line per problem. */
export function worldLines(report) {
  return report.problems.map(p => `${p.severity === 'error' ? 'ERROR' : 'warn '} ${p.rule.padEnd(10)} ${p.message}${p.fix ? ` → ${p.fix}` : ''}`);
}

/** The report for any subject: a flat game's own world judge (its gf/three/flat/index.js → worldReport, the same report
 *  shape), else checkWorld. */
export async function reportFor(subject) {
  const flat = subject.kind === 'game' ? await flatOf(subject.dir) : null;
  return flat ? flat.part.worldReport(subject) : checkWorld(subject);
}

/** verify's call: → { ok, detail, report } */
export async function worldCheck(gameDir) {
  const report = await reportFor(await loadWorldSubject(gameDir));
  const ls = worldLines(report);
  const s = report.stats;
  const marks = m => Object.entries(m ?? {}).map(([k, n]) => `${n} ${k}`).join(', ');
  const detail = report.profile === 'flat-2d'
    ? (report.ok ? `complete: a flat ${report.template} seen from ${report.plane === 'side' ? 'the side' : 'above'}, ${s.cells.join(' x ')} cells of ${s.kinds} tile kinds, ${s.spawns} spawns${marks(s.marks) ? `, marks ${marks(s.marks)}` : ''}; ${report.warnings} notes` : `${report.errors} errors (node builder/tools/world.mjs <game>): ${report.problems.filter(p => p.severity === 'error').map(p => `${p.rule}: ${p.message}`).join(' | ')}`)
    : report.profile === 'scenic-3d'
    ? (report.ok ? `complete: a scenic ${report.template}, ${s.levels} level${s.levels === 1 ? '' : 's'} (${s.levelsAsked} played), each about ${s.size[0]} m across (${s.area} m², ${s.sizeClass}); ${report.warnings} notes` : `${report.errors} errors (node builder/tools/world.mjs <game>): ${report.problems.filter(p => p.severity === 'error').map(p => `${p.rule}: ${p.message}`).join(' | ')}`)
    : report.ok
    ? `complete: ${report.kind} ${s.size.join(' x ')} m (${s.area} m², ${s.sizeClass})${s.rooms ? `, ${s.rooms} rooms` : ''}${s.ceiling ? `, ceiling ${s.ceiling} m` : ''}, ${s.entries} entries, ${Math.round(s.filledGround * 100)}% of the floor filled; ${report.warnings} notes`
    : `${report.errors} errors (node builder/tools/world.mjs <game> lists them with their fixes): ${report.problems.filter(p => p.severity === 'error').map(p => `${p.rule}: ${p.message}`).join(' | ')}`;
  // what the character cannot get to is reported in the detail by name, never failing the check (the reach rule)
  const unreachable = report.profile === 'flat-2d' ? [] : report.problems.filter(p => p.rule === 'reach');
  const said = unreachable.length ? `; reach (warning): ${unreachable.map(p => p.message).join(' | ')}` : '';
  return { ok: report.ok, detail: detail + said, report, notes: ls.filter(l => l.startsWith('warn')) };
}
