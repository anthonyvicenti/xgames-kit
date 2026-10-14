// Scenery round a generated world (looks wave 2, 2026-10-14): what a look target asks of a place that the ground itself
// does not make. A terrain world (worlds/terrain: the ground's mesh, carved by blasts) takes it from its config's
// `scenery`; a look target writes that (builder/look/world.mjs terrainParams):
//   clouds    puff clouds (or flat cards) in a ring low over the horizon, by cover (sea.js cloudsOf, islands.js cloudMesh)
//   islands   islands out at sea toward the horizon, with their cliffs and beaches (sea.js ringIslands, islands.js)
//   props     the set dressing (library props: pines, rocks, crates…) standing on the ground's surface, on firm, gentle
//             ground above the sea, clear of the seats; solid by their catalog colliders (players and the camera meet
//             them, as a layout's props); a blast that carves under one takes it and its colliders away
//
//   const s = await addScenery(ctx, root, cfg, { groundAt, seaLevel, bounds, seats, onEdit, seed })
//   s.props (Map, as world.props), s.update(dt), s.meshes, s.placements
//
// Slots: the props are `prop.<id>` model slots (propSlots); the clouds' colour and the islands' colours are the
// scenery's own config values. Pure layout is in sea.js; this file draws.
import * as THREE from 'three';
import { adoptMaterials, material } from '../look/materials.js';
import { rng as makeRng } from './layout.js';
import { cloudsOf, ringIslands } from './sea.js';
import { cloudMesh, drawIsland } from './islands.js';
import { collidersOf, buildColliders, MATERIALS } from './colliders.js';

const r2 = v => Math.round(v * 100) / 100;

/** The props' model slots for a scenery config (as world.js gives a layout's): catalog = config/props.json. */
export function propSlots(scenery, catalog, licences = null, { group = 'props' } = {}) {
  const byId = new Map((catalog?.props ?? []).map(p => [p.id, p]));
  return [...new Set(scenery?.props ?? [])].filter(id => byId.has(id)).map(id => {
    const p = byId.get(id), lic = licences?.files?.[p.file];
    return {
      id: `prop.${id}`, label: p.describe ? p.describe.replace(/^an? /, '').replace(/^./, c => c.toUpperCase()) : id, group, type: 'model', facet: 'look', tier: 'advanced',
      source: { file: `assets/models/${id}.glb` }, constraints: { scale: 1, ...(p.size ? { size: p.size } : {}) },
      description: `Set dressing on the ground (scenery). Metres, Y up, base at y=0, centred; a replacement is fitted to ${p.size?.map(n => n.toFixed(1)).join(' x ') ?? 'the same'} m.`,
      generate: { prompt: p.describe ?? id, style: 'soft stylised low-poly, chunky shapes, game-ready' },
      ...(lic ? { license: { spdx: lic.spdx, author: lic.author, url: lic.page } } : {}),
    };
  });
}

const TREE = /tree|palm|pine/;
/** Metres a set piece's footprint keeps from every seat. */
export const BIG_CLEAR = 5;

/**
 * Where the scenery's props stand: on firm ground (the surface under them barely slopes) above the sea, inside the
 * ground's bounds, clear of each other and of the seats. Pure over groundAt. → [{prop, at, rot, scale}]
 */
export function placeProps(scenery, { groundAt, seaLevel = 0, bounds, seats = [], seed = 1, sizeOf = () => null, sites = [] }) {
  const ids = scenery?.props ?? [], out = [];
  if (!ids.length || !bounds) return out;
  const R = makeRng((seed >>> 0) ^ 0x5ce4e);
  const dens = Math.max(0, Math.min(1, scenery.density ?? 0.5));
  const [x0, z0, x1, z1] = bounds, area = (x1 - x0) * (z1 - z0);
  const want = Math.round((area / 120) * (0.3 + dens));
  const taken = seats.map(s => ({ x: s.x, z: s.z, r: 2.2 }));
  const room = id => (/tree|palm|pine|tower/.test(id) ? 1.6 : /rock-large|crate|barrel|drum/.test(id) ? 1.1 : 0.6);
  // a big piece (a tower, a castle, a mesa: over 4 m tall or 3 m across) is a landmark: a few of each, never as many as
  // the crates and trees
  const isBig = id => { const z = sizeOf(id); return !!z && !TREE.test(id) && (z[1] > 4 || Math.max(z[0], z[2]) > 3); };
  // and no one small thing litters the ground: with three or more of them, each takes at most a third of the places
  const smallCap = Math.max(6, Math.ceil(want / Math.min(3, Math.max(1, ids.filter(id => !isBig(id)).length))));
  const bigCap = Math.max(1, Math.round(want / 20)), count = new Map();
  // a world that levelled sites for them (worlds/terrain sites) stands its landmarks there, one a site in turn, and
  // nowhere else
  const bigs = ids.filter(isBig);
  if (sites.length && bigs.length) {
    sites.forEach((site, k) => {
      const id = bigs[k % bigs.length];
      out.push({ prop: id, at: [r2(site.x), r2(site.y - 0.05), r2(site.z)], rot: Math.round(R() * 360), scale: r2(0.95 + R() * 0.15) });
      taken.push({ x: site.x, z: site.z, r: site.r ?? 4 });
      count.set(id, Infinity);
    });
    for (const id of bigs) count.set(id, Infinity);
  }
  // the mix stays even: each try asks for the id placed least so far; an id that finds no room in many tries in a row is
  // done (a landmark with no room left, a wide tree on narrow hills), so it never stalls the rest
  const placed = new Map(), misses = new Map(), done = new Set();
  const nextId = () => ids.filter(id => !done.has(id) && (!isBig(id) || (count.get(id) ?? 0) < bigCap))
    .reduce((a, id) => (a == null || (placed.get(id) ?? 0) < (placed.get(a) ?? 0) ? id : a), null);
  for (let tries = 0; out.length < want && tries < want * 25; tries++) {
    const id = nextId();
    if (id == null) break;
    const miss = () => { misses.set(id, (misses.get(id) ?? 0) + 1); if (misses.get(id) >= 60) done.add(id); };
    const x = x0 + R() * (x1 - x0), z = z0 + R() * (z1 - z0);
    let y = groundAt(x, z);
    if (y == null || y < seaLevel + 0.8) { miss(); continue; }
    // firm, gentle ground: the surface a metre round is within 0.6 m of here
    const around = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dz]) => groundAt(x + dx, z + dz));
    if (around.some(h => h == null || Math.abs(h - y) > 0.6)) { miss(); continue; }
    const size = sizeOf(id), r = size ? Math.max(0.5, Math.max(size[0], size[2]) * 0.55) : room(id);
    if (taken.some(t => Math.hypot(t.x - x, t.z - z) < t.r + r)) { miss(); continue; }
    let scale = null;
    if (isBig(id)) {
      // drawn near its made size (a landmark's size is part of its design), and its whole footprint stands back from
      // every seat: a player's camera behind the seat, or a close shot of them, never looks into its wall
      scale = r2(0.9 + R() * 0.25);
      if (seats.some(s => Math.hypot(s.x - x, s.z - z) < BIG_CLEAR + r * scale)) { miss(); continue; }
      // its whole footprint on land above the sea and nearly level; it sits at the footprint's lowest point, so no
      // corner hangs in the air
      const foot = [[0.7, 0], [-0.7, 0], [0, 0.7], [0, -0.7], [0.5, 0.5], [-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5]].map(([dx, dz]) => groundAt(x + dx * r, z + dz * r));
      if (foot.some(h => h == null || h < seaLevel + 0.5)) { miss(); continue; }
      const lo = Math.min(y, ...foot), hi = Math.max(y, ...foot);
      if (hi - lo > Math.max(1.5, size[1] * 0.25)) { miss(); continue; }
      y = lo;
      count.set(id, (count.get(id) ?? 0) + 1);
    }
    misses.set(id, 0); placed.set(id, (placed.get(id) ?? 0) + 1);
    if (!isBig(id) && placed.get(id) >= smallCap) done.add(id);
    taken.push({ x, z, r });
    out.push({ prop: id, at: [r2(x), r2(y - 0.05), r2(z)], rot: Math.round(R() * 360), scale: scale ?? r2(0.8 + R() * 0.6) });
  }
  return out;
}

/** Instanced models for placements: one InstancedMesh per (prop, mesh part). → Map(id → [{prop, at, …, meshes, instance}]) */
async function drawProps(ctx, root, placements) {
  const groups = new Map(), DEG = Math.PI / 180, map = new Map();
  for (const p of placements) { if (!groups.has(p.prop)) groups.set(p.prop, []); groups.get(p.prop).push(p); }
  await Promise.all([...groups.entries()].map(async ([id, list]) => {
    let model = null;
    try { if (ctx.assets?.has?.(`prop.${id}`)) model = await ctx.assets.model(`prop.${id}`); } catch (e) { console.warn(`gf-three scenery: prop.${id}: ${e.message}`); }
    if (!model) return;
    adoptMaterials(model, 'prop');
    model.updateMatrixWorld(true);
    const parts = []; model.traverse(o => { if (o.isMesh) parts.push(o); });
    const mats = list.map(p => new THREE.Matrix4().compose(new THREE.Vector3(...p.at), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), (p.rot ?? 0) * DEG), new THREE.Vector3().setScalar(p.scale ?? 1)));
    const meshes = parts.map(part => {
      const im = new THREE.InstancedMesh(part.geometry, part.material, list.length);
      mats.forEach((m, k) => im.setMatrixAt(k, m.clone().multiply(part.matrixWorld)));
      im.instanceMatrix.needsUpdate = true; im.computeBoundingSphere();
      im.castShadow = true; im.receiveShadow = true; im.name = `prop:${id}`; im.userData.gfSlot = `prop.${id}`; im.userData.gfProp = id;
      root.add(im); return im;
    });
    map.set(id, list.map((p, k) => ({ ...p, matrix: mats[k], meshes, instance: k, locals: parts.map(x => x.matrixWorld.clone()) })));
  }));
  return map;
}

/**
 * The scenery into `root`. cfg: the world's config (its `scenery`, `materials` for the islands' colours, `sea`).
 * opts: groundAt(x, z) (the ground's top, or null), seaLevel, bounds [x0, z0, x1, z1] (where props may stand), seats
 * [{x, z}], sites [{x, y, z, r}] (level places for the landmarks), onEdit (a world's edit listener: a carve takes the props it undercuts), seed.
 */
export async function addScenery(ctx, root, cfg, { groundAt, seaLevel = 0, bounds = null, seats = [], sites = [], onEdit = null, seed = 1, slot = 'world.terrain.shape', physics = null, catalog = null, track = null } = {}) {
  const S = cfg.scenery ?? {}, R = makeRng((seed >>> 0) || 1), meshes = [];
  // ---- islands toward the horizon ----
  const inner = bounds ? Math.hypot(bounds[2] - bounds[0], bounds[3] - bounds[1]) / 2 : 60;
  const M = cfg.materials ?? {};
  const isles = ringIslands({ islands: S.islands ?? 0, beach: S.beach ?? 0.5 }, R, { inner, sea: seaLevel, cliff: S.cliff ?? 5, relief: S.relief ?? 0.5 });
  if (isles.length) {
    const top = M.top?.color ?? '#7cc444', rock = M.cliff?.color ?? M.soil?.color ?? '#c9a473';
    const strata = S.strata?.length ? S.strata : [rock, shadeOf(rock, 0.85), shadeOf(rock, 1.08), shadeOf(rock, 0.92)];
    const groundMat = material('ground', { color: top, color2: shadeOf(top, 0.9) });
    const cliffMat = material('prop', { color: '#ffffff', vertexColors: true, roughness: 0.95 });
    const beachMat = material('ground', { color: M.sand?.color ?? '#e9cf8f', color2: shadeOf(M.sand?.color ?? '#e9cf8f', 0.95) });
    for (const isl of isles) meshes.push(...drawIsland(root, isl, seaLevel, { groundMat, cliffMat, beachMat, strata, slot }));
  }
  // ---- clouds ----
  const clouds = cloudsOf({ clouds: S.clouds ?? 0, cloudStyle: S.cloudStyle ?? 'puff' }, R, { base: seaLevel });
  let cloudObj = null;
  if (clouds.length) { cloudObj = cloudMesh(clouds, { color: S.cloudColor ?? '#f4f7ff', style: S.cloudStyle ?? 'puff' }); cloudObj.userData.gfSlot = slot; root.add(cloudObj); meshes.push(cloudObj); }
  // ---- props: on the ground, and on the islands out at sea ----
  let cat = catalog;
  if (!cat) { try { cat = ctx.assets?.config?.('props') ?? null; } catch { cat = null; } }
  const sizeOf = id => cat?.props?.find(e => e.id === id)?.size ?? null;
  const placements = placeProps(S, { groundAt, seaLevel, bounds, seats, seed, sizeOf, sites });
  const trees = (S.props ?? []).filter(id => TREE.test(id));
  // the look's landmarks (a castle, a domed tower, a mesa) crown the islands out at sea in turn, so the horizon reads
  // as the level's place; they are far off, with no collider
  const marks = (S.props ?? []).filter(id => { const z = sizeOf(id); return !!z && (z[1] > 4 || Math.max(z[0], z[2]) > 3) && !TREE.test(id); });
  isles.forEach((isl, j) => {
    if (!marks.length || isl.shape.radius < 7) return;
    const x = isl.at[0], z = isl.at[2];
    placements.push({ prop: marks[j % marks.length], at: [r2(x), r2(isl.at[1] + hillAt(isl, x, z) - 0.3), r2(z)], rot: Math.round(R() * 360), scale: r2(1 + R() * 0.3), far: true });
  });
  for (const isl of isles) {
    if (!trees.length) break;
    const n = Math.round(isl.shape.radius / 6), inner = marks.length && isl.shape.radius >= 7 ? 0.3 : 0;
    for (let k = 0; k < n; k++) {
      const a = R() * Math.PI * 2, d = (inner + R() * (0.6 - inner)) * isl.shape.radius, x = isl.at[0] + Math.cos(a) * d, z = isl.at[2] + Math.sin(a) * d;
      placements.push({ prop: trees[k % trees.length], at: [r2(x), r2(isl.at[1] + hillAt(isl, x, z) - 0.1), r2(z)], rot: Math.round(R() * 360), scale: r2(1.2 + R() * 1.2), far: true });
    }
  }
  const props = await drawProps(ctx, root, placements);
  // colliders: each prop on the play ground by its catalog collider (a tree's trunk, a rock's body), on the world's body;
  // the props out at sea have none
  const phys = physics?.world, RAPIER = physics?.RAPIER;
  if (phys && RAPIER && cat?.props?.length) {
    for (const list of props.values()) for (const p of list) {
      if (p.far) continue;
      const descs = collidersOf({ bounds: { walls: false }, size: [0, 0], props: [p] }, cat).filter(c => c.prop !== '#ground');
      // a tree's canopy too (its catalog collider is the trunk): a ball above head height, so a camera pulled in by a
      // wall stops at the leaves instead of inside them
      const meta = cat.props.find(e => e.id === p.prop);
      if (/tree|palm|pine/.test(p.prop) && meta?.size) {
        const sc = p.scale ?? 1, r = Math.min(meta.size[0], meta.size[2]) * 0.42 * sc;
        descs.push({ prop: p.prop, tag: `prop:${p.prop}`, shape: 'sphere', radius: r, position: [p.at[0], p.at[1] + Math.max(2.2 + r, meta.size[1] * 0.62 * sc), p.at[2]], rotationY: 0 });
      }
      p.colliders = buildColliders(RAPIER, phys, descs, MATERIALS.party, physics.body);
      for (const c of p.colliders) track?.add?.(c);
    }
  }
  // a carve takes the props it undercuts (the ground they stood on is gone)
  if (onEdit) onEdit(e => {
    if (e.op !== 'carve') return;
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    for (const list of props.values()) for (const p of list) {
      if (p.gone || Math.hypot(p.at[0] - e.at.x, p.at[2] - e.at.z) > e.r + 0.4 || Math.abs(p.at[1] - e.at.y) > e.r + 1) continue;
      p.gone = true;
      p.meshes.forEach(im => { im.setMatrixAt(p.instance, zero); im.instanceMatrix.needsUpdate = true; });
      for (const c of p.colliders ?? []) { phys?.removeCollider(c, false); track?.remove?.(c); }
      p.colliders = [];
    }
  });
  return { props, placements, meshes, update(dt) { if (cloudObj) cloudObj.rotation.y += dt * 0.004; } };
}

const shadeOf = (hex, k) => `#${new THREE.Color(hex).multiplyScalar(k).getHexString()}`;
const hillAt = (isl, x, z) => { let y = 0; for (const h of isl.hills ?? []) { const q = Math.hypot(x - h.at[0], z - h.at[1]) / h.r; if (q < 1) { const k = 1 - q * q; y += h.h * k * k; } } return y; };
