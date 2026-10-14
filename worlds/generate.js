// gf-three world generator (track D, "worlds"): a template's recipe + a size class + a seed → a concrete layout
// (config/world.json). Pure: no three.js, no DOM, no files; create, upgrade, the lint and verify (Node) and world.js
// (the browser) all expand a recipe the same way. Templates stay data (kit/world/templates/<id>.json).
//
//   generateLayout(recipe, { size: 'small' | 'medium' | 'large', seed })  → layout
//   SIZE_CLASSES, sizeClassOf(area), sizeOf(recipe, size)
//
// Two kinds of recipe:
//   indoor  (office, warehouse, school): a closed building. The size class picks the footprint and a room program
//           (bands of rooms along the outside walls, the main room in the middle). Rooms are joined by real doorways
//           (a spanning tree from the main room, plus loops from medium up); rooms marked `entry` get a door to the
//           outside, which is where enemies come in (`entries`). Walls stand on a 2 m module (windows on the outside,
//           glass where a room asks for it), a ceiling covers every room (world.js draws it as a cutaway: seen from
//           below, gone when the camera is above it), lamps hang from it, and each room is dressed by its zone
//           recipe from the template's furniture groups. Outside: a street (sidewalk, road, street lights) and city
//           blocks all round, so every window and doorway shows a place, not a plain.
//   sea     (sea-islands; recipe.generator 'sea', sea.js): islands in an open sea, shaped by the recipe's params (a look
//           target sets them: builder/look/world.mjs).
//   outdoor (backyard, plaza, arena): the template's own hand-dressed layout is the small world. Larger sizes push
//           everything near an edge out with that edge (the middle keeps its set-pieces), fill the new floor with the
//           recipe's groups, and close the edge again: the recipe's edge pieces run all round with gaps only at the
//           gates (`entries`), and the backdrop ring moves out with it.
import { rng as makeRng, turn } from './layout.js';
import { buildPlace } from './places/index.js';
import { fromYard } from './from-yard.js';
import { seaLayout } from './sea.js';

// ---------- size classes ----------
// The play area per class, for 1–4 players (bots fill seats) and the third-person camera (5.2 m behind the shoulder,
// 60° field of view, so about 10–12 m of floor reads clearly in front of a player; walking speed 5.2 m/s):
//   small   one main space a party can see across: 350–950 m² (crossing it takes about 5 s; every player in view)
//   medium  several spaces joined by doors or paths: 1000–1800 m² (about 7 s across; players split up and regroup,
//           enemies come from two or more sides, rooms break the sightlines)
//   large   a building or park to roam: 1900–3200 m² (about 9 s across; several routes between any two spaces)
export const SIZE_CLASSES = {
  small: { area: [350, 950], spaces: 1, entries: 1, describe: 'one main space everyone can see across (about 5 s to cross)' },
  medium: { area: [1000, 1800], spaces: 3, entries: 2, describe: 'several rooms or areas joined by doors and paths (about 7 s to cross)' },
  large: { area: [1900, 3200], spaces: 5, entries: 3, describe: 'a building or park to roam, with more than one route between spaces (about 9 s to cross)' },
};
export const SIZES = Object.keys(SIZE_CLASSES);
export function sizeClassOf(area) { for (const [k, c] of Object.entries(SIZE_CLASSES)) if (area >= c.area[0] && area <= c.area[1]) return k; return area < SIZE_CLASSES.small.area[0] ? 'tiny' : area > SIZE_CLASSES.large.area[1] ? 'huge' : 'between'; }
/** The footprint [W, D] a recipe gives a size class. */
export function sizeOf(recipe, size = 'small') { return recipe.sizes?.[size] ?? recipe.sizes?.small ?? recipe.size ?? [24, 24]; }

const r2 = v => Math.round(v * 100) / 100;
const norm = a => ((Math.round(a) % 360) + 360) % 360;
function hash(s) { let h = 2166136261; for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
function shuffle(list, R) { const a = [...list]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(R() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
const clone = v => JSON.parse(JSON.stringify(v));

/** A recipe + size + seed → a layout. The seed defaults to one per template and size (the same world every time). */
export function generateLayout(recipe, { size = 'small', seed = null } = {}) {
  if (!SIZE_CLASSES[size]) throw new Error(`gf-three world: unknown size "${size}" (${SIZES.join(', ')})`);
  const s = Number.isFinite(seed) ? seed >>> 0 : hash(`${recipe.template}|${size}`);
  const out = recipe.generator === 'sea' ? seaLayout(recipe, { size, seed: s }) : recipe.kind === 'indoor' ? building(recipe, size, s) : yard(recipe, size, s);
  out.generated = { by: 'kit/world/generate.js', recipe: recipe.template, size, seed: s };
  return out;
}

// ======================================================================================================== indoor
function building(recipe, size, seed) {
  const R = makeRng(seed);
  const [W, D] = sizeOf(recipe, size);
  const G = recipe.grid ?? 2;
  const shell = recipe.shell;
  const wallScale = shell.wallScale ?? [1, 1, 1];
  const wallTop = r2((shell.wallHeight ?? 2.579) * wallScale[1]);
  // the ceiling sits above the third-person camera's usual height (about 3.1 m), so the view under it shows the
  // ceiling; world.js closes the gap above the wall pieces with a band
  const H = Math.max(wallTop, recipe.ceiling?.height ?? wallTop);
  const prog = recipe.program[size];
  const flip = R() < 0.5 ? -1 : 1;                              // mirror left and right: same program, other hand

  // ---- rooms: bands along the outside walls, the main room in the middle ----
  let rest = [-W / 2, -D / 2, W / 2, D / 2];
  const rooms = [];
  const ids = new Map();
  const idFor = kind => { const n = (ids.get(kind) ?? 0) + 1; ids.set(kind, n); return n > 1 ? `${kind}-${n}` : kind; };
  for (const band of prog.bands ?? []) {
    let side = band.side;
    if (flip < 0 && (side === 'left' || side === 'right')) side = side === 'left' ? 'right' : 'left';
    const [x0, z0, x1, z1] = rest;
    const along = side === 'back' || side === 'front' ? x1 - x0 : z1 - z0;
    const d = band.depth;
    const brect = side === 'back' ? [x0, z0, x1, z0 + d] : side === 'front' ? [x0, z1 - d, x1, z1] : side === 'left' ? [x0, z0, x0 + d, z1] : [x1 - d, z0, x1, z1];
    rest = side === 'back' ? [x0, z0 + d, x1, z1] : side === 'front' ? [x0, z0, x1, z1 - d] : side === 'left' ? [x0 + d, z0, x1, z1] : [x0, z0, x1 - d, z1];
    // split the band along its length by the rooms' weights, on the grid (a room keeps at least 6 m)
    const list = band.order === 'fixed' ? band.rooms : shuffle(band.rooms, R);
    const total = list.reduce((n, r) => n + (r.weight ?? 1), 0);
    let at = 0;
    list.forEach((r, i) => {
      let len = i === list.length - 1 ? along - at : Math.max(6, Math.round((along * (r.weight ?? 1) / total) / G) * G);
      if (i < list.length - 1 && along - at - len < 6) len = along - at - 6;
      const a = at, b = at + len; at = b;
      const rect = side === 'back' || side === 'front' ? [brect[0] + a, brect[1], brect[0] + b, brect[3]] : [brect[0], brect[1] + a, brect[2], brect[1] + b];
      rooms.push({ id: idFor(r.kind), kind: r.kind, label: recipe.rooms[r.kind]?.label ?? r.kind, rect: rect.map(r2), ...(r.entry ? { entry: r.entry } : {}) });
    });
  }
  const main = { id: idFor(prog.main.kind), kind: prog.main.kind, label: recipe.rooms[prog.main.kind]?.label ?? prog.main.kind, rect: rest.map(r2), main: true, ...(prog.main.entry ? { entry: prog.main.entry } : {}) };
  rooms.unshift(main);

  // ---- walls: every room edge, split where rooms meet (a segment knows the rooms on its two sides) ----
  const segs = [];   // { axis: 'x' (runs along x at z = c) | 'z', c, a, b (from, to), rooms: [inside-or-low, high] }
  const edgesOf = r => { const [x0, z0, x1, z1] = r.rect; return [{ axis: 'x', c: z0, a: x0, b: x1, side: -1 }, { axis: 'x', c: z1, a: x0, b: x1, side: 1 }, { axis: 'z', c: x0, a: z0, b: z1, side: -1 }, { axis: 'z', c: x1, a: z0, b: z1, side: 1 }]; };
  const bx0 = -W / 2, bz0 = -D / 2, bx1 = W / 2, bz1 = D / 2;
  for (const r of rooms) for (const e of edgesOf(r)) {
    const outer = (e.axis === 'x' && (Math.abs(e.c - bz0) < 1e-6 || Math.abs(e.c - bz1) < 1e-6)) || (e.axis === 'z' && (Math.abs(e.c - bx0) < 1e-6 || Math.abs(e.c - bx1) < 1e-6));
    if (outer) { segs.push({ axis: e.axis, c: e.c, a: e.a, b: e.b, rooms: [r.id], outer: true, out: e.side }); continue; }
    // shared with the rooms across: one segment per overlap, recorded once (from the room on the low side)
    if (e.side !== 1) continue;
    for (const o of rooms) {
      if (o === r) continue;
      for (const f of edgesOf(o)) {
        if (f.axis !== e.axis || f.side !== -1 || Math.abs(f.c - e.c) > 1e-6) continue;
        const a = Math.max(e.a, f.a), b = Math.min(e.b, f.b);
        if (b - a >= G - 1e-6) segs.push({ axis: e.axis, c: e.c, a, b, rooms: [r.id, o.id], outer: false });
      }
    }
  }
  const modulesOf = s => { const n = Math.round((s.b - s.a) / G); return Array.from({ length: n }, (_, i) => s.a + G / 2 + i * G); };
  const doorModule = (s, prefer = null) => {
    const m = modulesOf(s);
    const ok = m.length >= 3 ? m.slice(1, -1) : m;                // keep doors off the corners
    if (prefer !== null) return ok.reduce((b, v) => (Math.abs(v - prefer) < Math.abs(b - prefer) ? v : b), ok[0]);
    return ok[Math.floor(R() * ok.length)];
  };
  // ---- doors between rooms: a spanning tree from the main room, then loops ----
  const inner = segs.filter(s => !s.outer && Math.round((s.b - s.a) / G) >= 2);
  const connected = new Set([main.id]);
  const doors = [];
  const doorOn = new Map();   // segment → module centre
  const addDoor = s => {
    const m = doorModule(s);
    doorOn.set(s, [...(doorOn.get(s) ?? []), m]);
    const at = s.axis === 'x' ? [r2(m), 0, s.c] : [s.c, 0, r2(m)];
    doors.push({ at, rooms: [...s.rooms], normal: s.axis === 'x' ? [0, 1] : [1, 0], width: shell.doorWidth ?? 1.71 });
  };
  for (let guard = 0; guard < 50 && connected.size < rooms.length; guard++) {
    // prefer a door into the main room; else into any room already reached
    const cands = inner.filter(s => connected.has(s.rooms[0]) !== connected.has(s.rooms[1]));
    if (!cands.length) break;
    const toMain = cands.filter(s => s.rooms.includes(main.id));
    const pick = (toMain.length ? toMain : cands)[Math.floor(R() * (toMain.length ? toMain.length : cands.length))];
    addDoor(pick);
    for (const id of pick.rooms) connected.add(id);
  }
  const loops = prog.loops ?? 0;
  for (const s of shuffle(inner.filter(x => !doorOn.has(x)), R).slice(0, loops)) addDoor(s);

  // ---- entries: a door to the outside for each room that asks (on its longest outside wall) ----
  const entries = [];
  for (const r of rooms) {
    if (!r.entry) continue;
    const outs = segs.filter(s => s.outer && s.rooms[0] === r.id).sort((a, b) => (b.b - b.a) - (a.b - a.a) || (a.axis === 'x' ? -1 : 1));
    const pref = r.entry === 'front' ? outs.find(s => s.axis === 'x' && s.out === 1) : r.entry === 'back' ? outs.find(s => s.axis === 'x' && s.out === -1) : null;
    const s = pref ?? outs[0];
    if (!s) continue;
    const [cx, cz] = [(r.rect[0] + r.rect[2]) / 2, (r.rect[1] + r.rect[3]) / 2];
    const m = doorModule(s, s.axis === 'x' ? cx : cz);
    doorOn.set(s, [...(doorOn.get(s) ?? []), m]);
    const at = s.axis === 'x' ? [r2(m), 0, s.c] : [s.c, 0, r2(m)];
    const normal = s.axis === 'x' ? [0, s.out] : [s.out, 0];
    const name = r.main ? 'entrance' : entries.some(e => e.name === 'entrance') || r.entry !== 'front' ? `door-${r.id}` : 'entrance';
    entries.push({ name, room: r.id, at, normal, width: shell.doorWidth ?? 1.71 });
  }

  // ---- wall pieces ----
  const props = [];
  const place = (prop, at, rot = 0, scale = 1) => props.push({ prop, at: at.map(r2), rot: norm(rot), scale });
  const roomById = new Map(rooms.map(r => [r.id, r]));
  for (const s of segs) {
    const mods = modulesOf(s);
    const doorsHere = doorOn.get(s) ?? [];
    const rr = s.rooms.map(id => recipe.rooms[roomById.get(id)?.kind] ?? {});
    const glass = !s.outer && rr.some(x => x.partition === 'glass');
    mods.forEach((m, i) => {
      let piece = shell.wall;
      if (doorsHere.some(d => Math.abs(d - m) < 1e-6)) piece = shell.door;
      else if (s.outer) { const pat = shell.windows ?? [1, 1, 0]; piece = pat[(i + (s.axis === 'x' ? 0 : 1)) % pat.length] && i > 0 && i < mods.length - 1 ? shell.window : shell.wall; }
      else if (glass && i > 0 && i < mods.length - 1) piece = shell.window;
      const at = s.axis === 'x' ? [m, 0, s.c] : [s.c, 0, m];
      place(piece, at, s.axis === 'x' ? 0 : 90, wallScale);
    });
  }
  if (shell.corner) for (const [x, z] of [[bx0, bz0], [bx1, bz0], [bx0, bz1], [bx1, bz1]]) place(shell.corner, [x, 0, z], 0, wallScale);

  // ---- dressing: each room by its zone recipe ----
  const occupied = [];   // axis-aligned rects [x0, z0, x1, z1] nothing else may enter (furniture, door lanes, the atrium)
  const free = (q, pad = 0) => occupied.every(o => q[2] + pad <= o[0] || q[0] - pad >= o[2] || q[3] + pad <= o[1] || q[1] - pad >= o[3]);
  const lane = (at, normal, width, depth) => { const [nx, nz] = normal; const hw = width / 2 + 0.45; for (const k of [1, -1]) { const ex = at[0] + nx * k * depth, ez = at[2] + nz * k * depth; occupied.push([Math.min(at[0], ex) - (nx ? 0 : hw), Math.min(at[2], ez) - (nz ? 0 : hw), Math.max(at[0], ex) + (nx ? 0 : hw), Math.max(at[2], ez) + (nz ? 0 : hw)]); } };
  for (const d of doors) lane(d.at, d.normal, d.width, 2.4);
  for (const e of entries) lane(e.at, e.normal, e.width, 2.8);
  if (shell.corner) for (const [x, z] of [[bx0, bz0], [bx1, bz0], [bx0, bz1], [bx1, bz1]]) occupied.push([x - 0.7, z - 0.7, x + 0.7, z + 0.7]);
  const C = [r2((main.rect[0] + main.rect[2]) / 2), r2((main.rect[1] + main.rect[3]) / 2)];
  const clearR = recipe.rooms[main.kind]?.keepClear ?? 4.5;
  occupied.push([C[0] - clearR, C[1] - clearR, C[0] + clearR, C[1] + clearR]);
  const groups = recipe.groups ?? {};
  const putGroup = (gid, cx, cz, yaw) => {
    const g = groups[gid];
    for (const q of g.props) {
      const [lx, lz] = turn(q.at[0], q.at[2], yaw);
      props.push({ prop: q.prop, at: [r2(cx + lx), r2(q.at[1] ?? 0), r2(cz + lz)], rot: norm((q.rot ?? 0) + yaw), scale: q.scale ?? 1 });
    }
  };
  const extent = (g, yaw) => (norm(yaw) % 180 === 0 ? [g.size[0], g.size[1]] : [g.size[1], g.size[0]]);
  const inset = 0.12;
  for (const room of rooms) {
    const zr = recipe.rooms[room.kind] ?? {};
    const [x0, z0, x1, z1] = room.rect;
    for (const f of zr.fill ?? []) {
      const g = groups[f.group]; if (!g) continue;
      // how many: a [min, max] range, or `per100` per 100 m² of the room's floor
      const area = (x1 - x0) * (z1 - z0);
      const [lo, hi] = f.per100 ? [Math.round(area / 100 * f.per100), Math.round(area / 100 * f.per100)] : Array.isArray(f.count) ? f.count : [f.count ?? 1, f.count ?? 1];
      const want = lo + Math.floor(R() * (hi - lo + 1));
      let n = 0;
      const tryAt = (cx, cz, yaw) => {
        const [w, d] = extent(g, yaw);
        const q = [cx - w / 2, cz - d / 2, cx + w / 2, cz + d / 2];
        if (q[0] < x0 + inset - 1e-6 || q[2] > x1 - inset + 1e-6 || q[1] < z0 + inset - 1e-6 || q[3] > z1 - inset + 1e-6) return false;
        if (!free(q, f.gap ?? 0.5)) return false;
        occupied.push(q); putGroup(f.group, cx, cz, yaw); n++; return true;
      };
      if (f.where === 'wall' || f.where === 'corner') {
        // the group's back against a wall, its front (+z in the group) into the room
        // `side`: only the room's back (−z), front (+z, the street side) or its two ends (left/right as built)
        const all4 = [{ yaw: 0, fixed: z0 + inset, axis: 'x', name: 'back' }, { yaw: 180, fixed: z1 - inset, axis: 'x', name: 'front' }, { yaw: 90, fixed: x0 + inset, axis: 'z', name: 'end' }, { yaw: 270, fixed: x1 - inset, axis: 'z', name: 'end' }];
        const sides = shuffle(f.side ? all4.filter(sd => sd.name === f.side) : all4, R);
        for (const sd of sides) {
          if (n >= want) break;
          const [w, d] = extent(g, sd.yaw);
          const half = sd.axis === 'x' ? w / 2 : d / 2, deep = sd.axis === 'x' ? d / 2 : w / 2;
          const lo2 = (sd.axis === 'x' ? x0 : z0) + inset + half, hi2 = (sd.axis === 'x' ? x1 : z1) - inset - half;
          if (hi2 < lo2) continue;
          const sign = sd.yaw === 0 || sd.yaw === 90 ? 1 : -1;
          const fixed = sd.fixed + sign * deep;
          const spots = f.where === 'corner' ? [lo2, hi2] : shuffle(Array.from({ length: Math.floor((hi2 - lo2) / 0.5) + 1 }, (_, k) => lo2 + k * 0.5), R);
          for (const v of spots) { if (n >= want) break; if (sd.axis === 'x' ? tryAt(v, fixed, sd.yaw) : tryAt(fixed, v, sd.yaw)) if (f.where === 'wall' && !f.spread) break; }
        }
      } else if (f.where === 'centre') {
        // the middle of the room, else slid along its long side until it clears the door lanes
        const yaw = f.yaw ?? ((x1 - x0) >= (z1 - z0) ? 0 : 90);
        const offs = [];
        for (const a of [0, 0.5, -0.5, 1, -1, 1.5, -1.5, 2, -2, 3, -3]) for (const b of [0, 0.5, -0.5, 1, -1, 1.5, -1.5]) offs.push([a, b]);
        offs.sort((p, q) => Math.hypot(...p) - Math.hypot(...q));
        for (const [a, b] of offs) if (n < want && tryAt((x0 + x1) / 2 + a, (z0 + z1) / 2 + b, yaw)) break;
      } else {   // 'grid': rows of groups in the open floor, aisles between
        const yaw = f.yaw ?? (R() < 0.5 ? 0 : 90);
        const [w, d] = extent(g, yaw);
        const aisle = f.aisle ?? 1.6;
        const nx = Math.floor((x1 - x0 - 2 * aisle + aisle) / (w + aisle)), nz = Math.floor((z1 - z0 - 2 * aisle + aisle) / (d + aisle));
        const ox = (x0 + x1) / 2 - ((nx - 1) * (w + aisle)) / 2, oz = (z0 + z1) / 2 - ((nz - 1) * (d + aisle)) / 2;
        const cells = [];
        for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) cells.push([ox + i * (w + aisle), oz + j * (d + aisle)]);
        for (const [cx, cz] of shuffle(cells, R)) { if (n >= want) break; tryAt(cx, cz, yaw); }
      }
    }
    // lamps hang from the ceiling on a grid
    if (recipe.ceiling?.lamp) {
      const every = recipe.ceiling.lampEvery ?? 4;
      const nx = Math.max(1, Math.round((x1 - x0) / every)), nz = Math.max(1, Math.round((z1 - z0) / every));
      const ls = recipe.ceiling.lampScale ?? 1;
      for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) place(recipe.ceiling.lamp, [x0 + (i + 0.5) * (x1 - x0) / nx, r2(H - (recipe.ceiling.lampDrop ?? 0.69) * ls), z0 + (j + 0.5) * (z1 - z0) / nz], 0, ls);
    }
  }

  // ---- spawns: a ring round the main room's middle (the atrium the goal stands in), facing it ----
  const spawns = [];
  const ringR = recipe.spawnRing ?? 3.2;
  for (let k = 0; k < 8; k++) { const a = (k + 0.5) * Math.PI / 4; spawns.push([r2(C[0] + Math.sin(a) * ringR), 0, r2(C[1] + Math.cos(a) * ringR)]); }

  // ---- zones: the middle, each room, the entrance ----
  const zones = { centre: { shape: 'circle', at: [C[0], 0, C[1]], size: [recipe.centreRadius ?? 1.4] } };
  for (const r of rooms) { const [a, b, c, d] = r.rect; zones[r.id] = { shape: 'box', at: [r2((a + c) / 2), 0, r2((b + d) / 2)], size: [r2(c - a - 1), 3, r2(d - b - 1)] }; }
  for (const e of entries) zones[e.name] = { shape: 'circle', at: [r2(e.at[0] - e.normal[0] * 1.6), 0, r2(e.at[2] - e.normal[1] * 1.6)], size: [1.2] };

  // ---- outside: a street and city blocks all round ----
  outsideStreet(recipe.outside, { W, D, R, place, props });

  const ground = clone(recipe.ground);
  return {
    template: recipe.template, label: recipe.label, describe: describeOf(recipe, size, rooms), kind: 'indoor', sizeClass: size, size: [W, D],
    ground, bounds: { walls: true, height: Math.max(4, H + 0.5) },
    ceiling: { height: H, ...clone(recipe.ceiling.look ?? {}) },
    bench: { stage: [C[0], 0, r2(C[1] + 2.4)], facing: 0 },
    rooms, doors, entries, props, scatter: [], spawns, zones,
  };
}

function describeOf(recipe, size, rooms) {
  const names = rooms.map(r => r.label.toLowerCase());
  return `${recipe.describe} ${size[0].toUpperCase()}${size.slice(1)}: ${names.length} ${names.length === 1 ? 'space' : 'rooms'} (${names.join(', ')}).`;
}

/** A street round a building: sidewalk slabs, a road ring with crossings at the corners, street lights, and city blocks. */
function outsideStreet(o, { W, D, R, place }) {
  if (!o) return;
  const sw = o.sidewalk?.width ?? 4, rw = o.road?.width ?? 8;
  // sidewalk slabs (4 m) round the walls
  if (o.sidewalk) {
    for (let x = -W / 2 - sw / 2; x <= W / 2 + sw / 2 + 1e-6; x += sw) for (const z of [-D / 2 - sw / 2, D / 2 + sw / 2]) place(o.sidewalk.prop, [x, 0, z], 0);
    for (let z = -D / 2 + sw / 2; z <= D / 2 - sw / 2 + 1e-6; z += sw) for (const x of [-W / 2 - sw / 2, W / 2 + sw / 2]) place(o.sidewalk.prop, [x, 0, z], 0);
  }
  // the road ring (8 m tiles; the footprints are multiples of 8 so the tiles meet)
  const ex = W / 2 + sw + rw / 2, ez = D / 2 + sw + rw / 2;
  if (o.road) {
    for (const [x, z] of [[-ex, -ez], [ex, -ez], [-ex, ez], [ex, ez]]) place(o.road.cross, [x, 0, z], 0);
    // the tile's lanes run along its x: roads along x stay at 0, roads along z turn 90
    for (let x = -ex + rw; x <= ex - rw + 1e-6; x += rw) for (const z of [-ez, ez]) place(o.road.prop, [x, 0, z], 0);
    for (let z = -ez + rw; z <= ez - rw + 1e-6; z += rw) for (const x of [-ex, ex]) place(o.road.prop, [x, 0, z], 90);
  }
  // street lights on the sidewalk's outer edge, arms over the road
  if (o.lights) {
    const every = o.lights.every ?? 12, off = sw - 0.5;
    for (let x = -W / 2 + every / 2; x <= W / 2; x += every) { place(o.lights.prop, [x, 0, -D / 2 - off], 180); place(o.lights.prop, [x, 0, D / 2 + off], 0); }
    for (let z = -D / 2 + every / 2; z <= D / 2; z += every) { place(o.lights.prop, [-W / 2 - off, 0, z], 270); place(o.lights.prop, [W / 2 + off, 0, z], 90); }
  }
  // city blocks across the road, fronts to the street; towers on the corners; a far skyline
  const b0 = rw / 2 + 2;                                   // from the road's centre line to the buildings' fronts
  const sizes = o.sizes ?? {};
  const pick = list => list[Math.floor(R() * list.length)];
  // a row of blocks along one side, between the corner towers: each block that still fits, a small gap between
  const row = (len, put) => {
    let at = -len / 2;
    for (let guard = 0; guard < 40 && at < len / 2 - 4; guard++) {
      const fits = o.buildings.filter(id => at + (sizes[id]?.[0] ?? 8) <= len / 2 + 0.5);
      if (!fits.length) break;
      const id = pick(fits);
      const [w, d] = sizes[id] ?? [8, 8];
      put(id, at + w / 2, d);
      at += w + 0.6 + R() * 1.4;
    }
  };
  const fx = ex + b0, fz = ez + b0;
  row(2 * fx - 2, (id, u, d) => { place(id, [u, 0, -(fz + d / 2)], 0); });
  row(2 * fx - 2, (id, u, d) => { place(id, [u, 0, fz + d / 2], 180); });
  row(2 * fz - 2, (id, u, d) => { place(id, [-(fx + d / 2), 0, u], 90); });
  row(2 * fz - 2, (id, u, d) => { place(id, [fx + d / 2, 0, u], 270); });
  if (o.towers) for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) { const id = pick(o.towers); const [w, d] = sizes[id] ?? [10, 10]; place(id, [sx * (fx + w / 2 + 1.5), 0, sz * (fz + d / 2 + 1.5)], sz < 0 ? 0 : 180); }
  if (o.skyline) {
    const n = o.skyline.count ?? 10, rad = Math.max(ex, ez) + (o.skyline.distance ?? 45);
    for (let k = 0; k < n; k++) { const a = (k + R() * 0.6) / n * Math.PI * 2; place(pick(o.skyline.props), [Math.sin(a) * rad, 0, Math.cos(a) * rad], norm(a * 180 / Math.PI + 180)); }
  }
}

// ======================================================================================================= outdoor
// The template's own layout is the small world. A bigger class keeps the middle's set-pieces where they are and moves
// what stands near an edge out with that edge; then the recipe's groups dress the new floor, the edge closes again
// and the backdrop ring follows it out. Built through the places vocabulary (kit/world/places/, open builder wave 10):
// from-yard.js turns the template into a recipe, one word a pass, and the world is the one this function gave before
// (tests/d-places.test.mjs, byte for byte).
function yard(recipe, size, seed) {
  const out = buildPlace(fromYard(recipe), { size, seed, R: makeRng(seed) });
  const [W, D] = out.size, gates = out.entries.length;
  out.describe = `${recipe.describe} ${size[0].toUpperCase()}${size.slice(1)}: ${W} x ${D} m${gates ? `, ${gates} ${gates === 1 ? 'gate' : 'gates'}` : ''}.`;
  return out;
}
