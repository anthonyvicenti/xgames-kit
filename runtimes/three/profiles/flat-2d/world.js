// gf-three flat: the world of a flat (2D) game (CONTRACT §4.3's runtime shape: spawn, zone, raycast, bounds, props,
// root, update). It is built from ONE value, the tile map (config/world.json → map, the slot world.map; tilemap.js has
// the format), and one picture per tile kind (the slots world.tiles.<kind>):
//
//   field (plane 'top')   seen from above: the base kind under every cell, other kinds over it, solid kinds are walls
//   stage (plane 'side')  seen from the side: solid kinds are ground and blocks, "top" kinds are ledges you land on from
//                         above and jump up through, an empty cell is sky; every body is held at Z = 0
//
// What is drawn is pictures on quads. What is solid is Rapier's 3D boxes, so the kit's capsule, bots, knocks, pickups
// and rays work on them untouched: a top-down wall is a 3 m tall box seen from above; a side-on block is a box 2 m
// deep that nobody can walk round, because every body's Z is locked (controller.js). Past the map's edge the picture
// continues (the edge cells repeat), so no screen shape shows a void.
import * as THREE from 'three';
import { WORLD_GROUPS, GROUPS } from '../core/util.js';
import { pictureMaterial, standY, groundShadow } from './look.js';
import { drawPlan, PAD } from './drawplan.js';
import { readMap, rects, boxOf, reachOf, jumpReach } from './tilemap.js';
import { SIDE, STYLES } from './slots.js';
export { templates, worldConfig } from './slots.js';

/** The collision group of a ledge: nothing collides with it by default; a body's ground probe sees it only while that
 *  body is above it and not rising (controller.js). */
export const ONEWAY = 0x10;

export async function loadWorld(ctx, cfg) {
  const { scene, assets } = ctx, W = ctx.physics, RAPIER = ctx.RAPIER;
  const side = cfg.plane === 'side', T = cfg.template ?? (side ? 'stage' : 'field');
  const style = ctx.flat?.style ?? cfg.style ?? 'pixel';
  const M = readMap(assets.has('world.map') ? assets.value('world.map', cfg.map) : cfg.map);
  if (!M.ok) console.error(`gf-three flat world: the tile map has problems: ${M.problems.join('; ')}`);
  const tile = M.tile, group = new THREE.Group(); group.name = `gf-world-${T}`; scene.add(group);
  const fixed = W.createRigidBody(RAPIER.RigidBodyDesc.fixed()), colliders = [], shapes = [];
  const box = (hx, hy, hz, x, y, z, tag, groups = WORLD_GROUPS) => {
    const c = W.createCollider(RAPIER.ColliderDesc.cuboid(hx, hy, hz).setTranslation(x, y, z).setFriction(1).setCollisionGroups(groups), fixed);
    c.__gf = { tag }; colliders.push(c); return c;
  };
  const A = M.area, w = M.size.w, h = M.size.h, ledges = [];
  if (side) {
    for (const q of rects(M, true)) { const b = boxOf(M, q); box(b.w / 2, b.h / 2, 1, b.x, b.y, 0, 'block'); }
    for (const q of rects(M, 'top')) {
      const b = boxOf(M, q), top = b.y + tile / 2, thick = tile * 0.25;
      box(b.w / 2, thick / 2, 1, b.x, top - thick / 2, 0, 'ledge', ((ONEWAY << 16) | 0xffff) >>> 0);
      ledges.push({ x0: b.x - b.w / 2, x1: b.x + b.w / 2, top });
    }
    // the map is closed: a floor under its bottom row, a wall past each end, however the rows were drawn
    box(w / 2 + 4, 2, 1, 0, A.minY - 2, 0, '#floor');
    for (const s of [-1, 1]) box(2, h + 20, 1, s * (w / 2 + 2), h / 2, 0, '#edge');
  } else {
    box(w / 2 + 8, 0.5, h / 2 + 8, 0, -0.5, 0, 'ground');
    for (const q of rects(M, true)) { const b = boxOf(M, q); box(b.w / 2, 1.5, b.d / 2, b.x, 1.5, b.z, 'wall'); shapes.push({ shape: 'box', prop: 'wall', position: [b.x, 0, b.z], size: [b.w, 3, b.d] }); }
    for (const [x, z, hx, hz] of [[w / 2 + 2, 0, 2, h / 2 + 4], [-w / 2 - 2, 0, 2, h / 2 + 4], [0, h / 2 + 2, w / 2 + 4, 2], [0, -h / 2 - 2, w / 2 + 4, 2]]) box(hx, 3, hz, x, 3, z, '#edge');
  }

  // ---- the picture ----
  const tileSlots = cfg.tiles ?? {}, edgeSlots = cfg.edges ?? {}, dressSlots = cfg.dress ?? {};
  const textures = new Map();
  const load = async slot => { if (!textures.has(slot)) textures.set(slot, assets.has(slot) ? await assets.texture(slot) : null); return textures.get(slot); };
  /** Quads of one picture → one mesh. quads: [{ x, y, z (centre), w, h (metres), frame: [col, row], grid: [cols, rows] }] */
  const meshOf = (slot, tex, quads, { y = null, order = 1 } = {}) => {
    const map = tex.clone(); map.userData.gfSlot = slot; map.wrapS = map.wrapT = THREE.ClampToEdgeWrapping; map.needsUpdate = true;
    const iw = tex.image?.width || 1, ih = tex.image?.height || 1, insetU = style === 'pixel' ? 0 : 0.5 / iw, insetV = style === 'pixel' ? 0 : 0.5 / ih;
    const n = quads.length, pos = new Float32Array(n * 12), uv = new Float32Array(n * 8), idx = new Uint32Array(n * 6);
    quads.forEach((q, i) => {
      const [fc, fr] = q.frame, [gc, gr] = q.grid, u0 = fc / gc + insetU, u1 = (fc + 1) / gc - insetU, v0 = 1 - (fr + 1) / gr + insetV, v1 = 1 - fr / gr - insetV;
      const hw = q.w / 2, hh = q.h / 2, Y = y ?? q.y;
      const corners = side ? [[q.x - hw, q.y - hh, q.z], [q.x + hw, q.y - hh, q.z], [q.x + hw, q.y + hh, q.z], [q.x - hw, q.y + hh, q.z]]
        : [[q.x - hw, Y, q.z + hh], [q.x + hw, Y, q.z + hh], [q.x + hw, Y, q.z - hh], [q.x - hw, Y, q.z - hh]];
      corners.forEach((k, j) => pos.set(k, i * 12 + j * 3));
      uv.set([u0, v0, u1, v0, u1, v1, u0, v1], i * 8);
      idx.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3], i * 6);
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3)); geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2)); geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeBoundingSphere(); geo.computeBoundingBox();
    const mesh = new THREE.Mesh(geo, pictureMaterial(map, { style, order }));
    mesh.renderOrder = order; mesh.frustumCulled = false;
    assets.tag(mesh, slot); group.add(mesh);
    return mesh;
  };
  const missing = new Set(), pieces = [];
  if (side) {
    // side-on: one mesh per kind, a quad a cell; the cap where the cell above is another kind
    const clampAt = (c, r) => (r < 0 ? null : M.at(Math.max(0, Math.min(M.cols - 1, c)), Math.max(0, Math.min(M.rows - 1, r))));
    const quads = new Map();
    for (let r = 0; r < M.rows + PAD; r++) for (let c = -PAD; c < M.cols + PAD; c++) {
      const kind = clampAt(c, r), inside = r < M.rows;
      if (!kind) continue;
      if (!quads.has(kind)) quads.set(kind, []);
      quads.get(kind).push({ c, r, cap: inside && clampAt(c, r - 1) !== kind });
    }
    for (const [kind, cells] of quads) {
      const slot = `world.tiles.${kind}`, tex = tileSlots[kind] ? await load(slot) : null;
      if (!tex) { missing.add(kind); continue; }
      const frames = (tex.image?.width || 1) >= (tex.image?.height || 1) * 2 ? 2 : 1, solid = M.kinds[kind]?.solid ?? false;
      const z = solid === true ? -0.3 : -0.35;
      const mesh = meshOf(slot, tex, cells.map(q => { const p = M.centre(q.c, q.r); return { x: p.x, y: p.y, z, w: tile, h: tile, frame: [frames === 2 && !q.cap ? 1 : 0, 0], grid: [frames, 1] }; }), { order: 1 });
      mesh.name = `tiles:${kind}`;
    }
  } else {
    // from above: drawplan.js lays out the base, the kinds, their edges, the dressing and the set pieces
    const has = { tiles: new Set(), edges: new Set(), dress: new Set() }, sizes = {};
    for (const [key, slots, prefix] of [['tiles', tileSlots, 'world.tiles.'], ['edges', edgeSlots, 'world.edges.'], ['dress', dressSlots, 'world.dress.']]) {
      for (const kind of Object.keys(slots)) {
        const tex = await load(prefix + kind);
        if (tex) { has[key].add(kind); sizes[prefix + kind] = [tex.image?.width || 1, tex.image?.height || 1]; }
      }
    }
    for (const kind of Object.keys(M.kinds)) if (!has.tiles.has(kind) && !has.edges.has(kind) && [...M.cells.flat(), M.base].includes(kind)) missing.add(kind);
    const items = drawPlan(M, { ...has, sizes, ppm: STYLES[style].ppm });
    const at = it => { const p = M.centre(it.c, it.r); return { x: p.x, z: p.z, w: it.w * tile, h: it.h * tile, frame: it.frame, grid: it.grid }; };
    // how far toward the eye a layer sits: the base, a kind, its edge, what lies on it, a fence; a piece stands (standY)
    const LIFT = { 0: 0, 1: 0.015, 2: 0.02, 3: 0.035, 4: 0.04 };
    const groups = new Map();
    for (const it of items) {
      if (it.shadow) { pieces.push({ shadow: at(it), slot: `world.tiles.${it.kind}` }); continue; }
      if (it.layer === 5) { pieces.push({ slot: it.slot, q: at(it), near: M.centre(0, it.near).z, footprint: it.footprint }); continue; }
      const key = `${it.slot}|${it.layer}|${it.sub ?? 0}`;
      if (!groups.has(key)) groups.set(key, { slot: it.slot, layer: it.layer, y: LIFT[it.layer] + (it.sub ?? 0) * 0.001 + (M.kinds[it.kind]?.solid === true && it.layer === 1 ? 0.015 : 0), quads: [] });
      groups.get(key).quads.push(at(it));
    }
    for (const g of groups.values()) { const mesh = meshOf(g.slot, textures.get(g.slot), g.quads, { y: g.y, order: g.layer === 0 ? 0 : 1 }); mesh.name = `${g.layer === 0 ? 'base' : g.layer === 2 ? 'edges' : g.layer === 3 ? 'dress' : g.layer === 4 ? 'connect' : 'tiles'}:${g.slot.split('.').pop()}`; }
    // set pieces stand: each its own quad, sorted near over far by the row of its near edge, a shadow under it
    for (const p of pieces) {
      if (p.shadow) { const s = groundShadow(p.shadow.w, p.shadow.h, style); s.position.set(p.shadow.x, 0.045, p.shadow.z); assets.tag(s, p.slot); group.add(s); continue; }
      const mesh = meshOf(p.slot, textures.get(p.slot), [p.q], { y: standY(p.near), order: 3 });
      mesh.name = `piece:${p.slot.split('.').pop()}`;
    }
  }
  for (const kind of missing) console.error(`gf-three flat world: the map uses the kind "${kind}", which has no picture (slot world.tiles.${kind})`);

  const mid = side ? { x: 0, y: 0, z: 0 } : { x: 0, y: 0, z: 0 };
  const spawns = (M.spawns.length ? M.spawns : [{ c: M.cols >> 1, r: M.rows >> 1 }]).map(s => { const p = M.feet(s.c, s.r); return { x: p.x, y: p.y, z: p.z, yaw: side ? (p.x <= mid.x ? Math.PI / 2 : -Math.PI / 2) : Math.atan2(mid.x - p.x, mid.z - p.z) }; });
  const zones = {};
  for (const [name, z] of Object.entries((assets.has('world.zones') ? assets.value('world.zones', cfg.zones) : cfg.zones) ?? {})) {
    const at = z.at ?? [0, 0, 0], sz = [].concat(z.size ?? 2);
    zones[name] = {
      name, shape: z.shape ?? 'circle', at, size: sz,
      contains: p => (z.shape === 'box' ? Math.abs(p.x - at[0]) <= sz[0] / 2 && Math.abs(p.z - at[2]) <= (sz[2] ?? sz[0]) / 2 : Math.hypot(p.x - at[0], p.z - at[2]) <= sz[0]),
      random: rng => { if (z.shape === 'box') return { x: at[0] + (rng() - 0.5) * sz[0], y: at[1], z: side ? 0 : at[2] + (rng() - 0.5) * (sz[2] ?? sz[0]) }; const a = rng() * Math.PI * 2, r = Math.sqrt(rng()) * sz[0]; return { x: at[0] + Math.cos(a) * r, y: at[1], z: side ? 0 : at[2] + Math.sin(a) * r }; },
    };
  }
  const ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
  const isWorld = c => c.parent()?.handle === fixed.handle && !(c.__gf?.tag === 'ledge');
  // the play area. Side-on it is a strip: nothing is ever placed off Z = 0.
  const bounds = side ? new THREE.Box3(new THREE.Vector3(A.minX, 0, -0.05), new THREE.Vector3(A.maxX, A.maxY, 0.05)) : new THREE.Box3(new THREE.Vector3(A.minX, 0, A.minZ), new THREE.Vector3(A.maxX, 4, A.maxZ));
  const world = {
    template: T, plane: side ? 'side' : 'top', flat: true, root: group, group, bounds, half: w / 2, colliders, shapes, props: new Map(), spawns, map: M, ledges, tile,
    // the whole picture, edge to edge: what the camera may show (the map itself; the repeated edge is only for odd screens)
    view: side ? { minX: A.minX, maxX: A.maxX, minY: A.minY, maxY: A.maxY } : { minX: A.minX, maxX: A.maxX, minZ: A.minZ, maxZ: A.maxZ },
    spawn: i => spawns[((i % spawns.length) + spawns.length) % spawns.length],
    zone: name => zones[name] ?? null,
    zones,
    /** The places the map marks with a name (legend "mark:<name>"): [{x, y, z}], where a thing would stand. */
    marks: name => (M.marks[name] ?? []).map(m => M.feet(m.c, m.r)),
    /** The cell a point is in, and what is there: { c, r, kind, solid }. */
    cell: p => { const q = M.cellAt(p), kind = M.at(q.c, q.r) ?? null; return { ...q, kind, solid: kind ? M.kinds[kind]?.solid ?? false : false }; },
    /** Side-on: what a jump reaches with this game's numbers, and what the map needs of it (tilemap.js reachOf). */
    reach() { const C = ctx.config?.controller ?? {}, R = jumpReach({ gravity: ctx.config?.gravity ?? 20, jump: C.jump ?? SIDE.jump, speed: C.speed ?? SIDE.speed, fallScale: SIDE.fallScale }); return side ? { ...R, ...reachOf(M, R) } : R; },
    raycast(from, dir, max = 50) {
      const l = Math.hypot(dir.x, dir.y, dir.z) || 1;
      ray.origin = { x: from.x, y: from.y, z: from.z }; ray.dir = { x: dir.x / l, y: dir.y / l, z: dir.z / l };
      const hit = W.castRayAndGetNormal(ray, max, true, undefined, undefined, undefined, undefined, isWorld);
      if (!hit) return null;
      const d = hit.timeOfImpact;
      return { point: { x: from.x + ray.dir.x * d, y: from.y + ray.dir.y * d, z: from.z + ray.dir.z * d }, distance: d, normal: hit.normal, collider: hit.collider, tag: hit.collider.__gf?.tag ?? null };
    },
  };
  return world;
}
export { GROUPS };
