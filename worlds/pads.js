// Launch pads (a connector, worlds/connect.mjs): a pad at each end of a gap no bridge, sandbar or ramp fits (too far,
// too high); stepping on one throws the body along a fixed arc to the other, so every copy and every bot lands in the
// same place. Any world can stand them (a terrain world levels a disc for each: worlds/terrain/connect.mjs); the walk grid
// knows them as links (worlds/walk.mjs), so placement, routes and the reach gate count the far side as reached.
//
//   const pads = addPads(ctx, root, list, { color, base, paint, slot })   list: [{id, from: [x, y, z], to: [x, y, z]}]
//                          (slot: the world slot its meshes belong to, the land's shape on a terrain world)
//   pads.update(dt)        each frame: a body this copy owns (the local player; the host's bots) standing on a pad is
//                          thrown (controller.carry along the arc); a body that landed on a pad must step off it first
//   pads.links()           [{from: {x, y, z}, to: {x, y, z}}] for the walk grid
//   pads.meshes, pads.observe() → [{id, at, to, launches}]
//
// Drawn from the look: a round base in the ground's rock colour, a domed top in the look's accent with three chevrons
// pointing the way, squashing as it throws. `paint(obj)` puts the look's prop material on it (adoptMaterials).
// Only three.js: a world with no look module stands pads too.
import * as THREE from 'three';
import { reachConfig, connectRegions, padArc, arcClearOf } from './connect.mjs';

export { padArc };

const R = 1.05;                 // the pad's radius (m): a body whose feet are this near its middle is on it

export function addPads(ctx, root, list = [], { color = '#ff5fa2', base = '#a89e5f', paint = null, slot = 'world.terrain.shape' } = {}) {
  const group = new THREE.Group(); group.name = 'gf-pads';
  root.add(group);
  const pads = list.map((p, k) => {
    const at = { x: p.from[0], y: p.from[1], z: p.from[2] }, to = { x: p.to[0], y: p.to[1], z: p.to[2] };
    const g = new THREE.Group(); g.name = `pad:${p.id ?? k + 1}`; g.position.set(at.x, at.y, at.z);
    g.rotation.y = Math.atan2(to.x - at.x, to.z - at.z);
    const rim = new THREE.Mesh(new THREE.CylinderGeometry(R + 0.12, R + 0.28, 0.3, 28), new THREE.MeshStandardMaterial({ color: base, roughness: 0.9 }));
    rim.position.y = 0.1;
    const top = new THREE.Mesh(new THREE.SphereGeometry(R, 28, 10, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshStandardMaterial({ color, roughness: 0.45 }));
    top.scale.y = 0.28; top.position.y = 0.22;
    const arrows = new THREE.Group();
    const shape = new THREE.Shape(); shape.moveTo(-0.32, -0.12); shape.lineTo(0, 0.16); shape.lineTo(0.32, -0.12); shape.lineTo(0.2, -0.12); shape.lineTo(0, 0.04); shape.lineTo(-0.2, -0.12); shape.closePath();
    const chevron = new THREE.ShapeGeometry(shape); chevron.rotateX(-Math.PI / 2);
    const white = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.5 });
    for (let i = 0; i < 3; i++) { const c = new THREE.Mesh(chevron, white); c.position.set(0, 0.52, -0.42 + i * 0.36); c.rotation.y = Math.PI; arrows.add(c); }
    // the chevrons point along +z of the pad (toward the far pad)
    arrows.rotation.y = Math.PI;
    g.add(rim, top, arrows);
    g.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; o.userData.gfSlot = slot; } });
    paint?.(g);
    group.add(g);
    return { id: p.id ?? `pad-${k + 1}`, at, to, obj: g, top, squash: 0, launches: 0, arc: padArc(at, to, { gravity: ctx.config?.gravity ?? 20 }) };
  });
  const landed = new Map();            // player id → the pad it landed on (thrown again only once it stepped off)
  const now = () => ctx.time?.now ?? performance.now() / 1000;
  return {
    meshes: [group],
    links: () => pads.map(p => ({ from: p.at, to: p.to })),
    update(dt) {
      for (const p of pads) { p.squash = Math.max(0, p.squash - dt * 3); p.top.scale.y = 0.28 * (1 - 0.5 * Math.sin(Math.min(1, p.squash) * Math.PI)); }
      for (const pl of ctx.players?.owned?.() ?? []) {
        const c = pl.controller; if (!c?.carry || c.carried || pl.alive === false) continue;
        const f = pl.position;
        const on = pads.find(p => { const dx = f.x - p.at.x, dz = f.z - p.at.z; return dx * dx + dz * dz < R * R && Math.abs(f.y - p.at.y) < 0.8; });
        if (!on) { landed.delete(pl.id); continue; }
        if (landed.get(pl.id) === on) continue;
        // thrown: the body rides the arc from the pad's middle; it lands on the far pad (and must step off it)
        const t0 = now(), arc = on.arc;
        c.carry(() => arc.at(now() - t0), arc.T + 0.05, { upright: true });
        landed.set(pl.id, pads.find(q => q.at.x === on.to.x && q.at.z === on.to.z) ?? null);
        on.squash = 1; on.launches++;
        if (pl.local) ctx.juice?.impact?.(0.35, { at: on.at, local: true });
      }
    },
    observe: () => pads.map(p => ({ id: p.id, at: [p.at.x, p.at.y, p.at.z], to: [p.to.x, p.to.y, p.to.z], seconds: +p.arc.T.toFixed(2), launches: p.launches })),
  };
}

/**
 * The connectors a world makes as it plays (any world on the walk grid: party, voxel, flat seen from above, scenic, and
 * what a terrain world's ground could not join): launch pads, planned on the walk grid the first time it is ready, so
 * every copy stands the same ones before anything is placed. walk: createWalk's API; extra: the links array the walk's
 * source reads (pads are added to it). → {list, pads} or null when there is nothing to join
 */
export function joinWithPads(world, ctx, walk, extra, { reach = {}, root = null, kinds = ['pad'] } = {}) {
  const R = reachConfig(reach);
  if (!R.connect || !kinds.includes('pad') || (R.kinds && !R.kinds.includes('pad'))) return null;
  // a part that lets players make their own way (building blocks, a grapple) reaches what the walk cannot: no pads
  if ((ctx.mechanics?.list?.() ?? []).some(m => !m.standin && typeof m.makesWay === 'string')) return null;
  const W = walk.walk, seats = W.seats().filter(s => s.ok).map(s => ({ x: s.at[0], y: s.at[1], z: s.at[2] }));
  if (!seats.length) return null;
  const boxes = (world.landmarks ?? []).map(L => L.box).filter(Boolean);
  const things = () => {
    const out = seats.slice(1).map((s, i) => ({ kind: 'seat', id: i + 2, ...s, r: 1 }));
    for (const L of world.landmarks ?? []) if (L.box) out.push(L.role === 'bridge'
      ? { kind: 'bridge', id: L.id, x: L.box.min[0], y: L.box.min[1], z: L.box.min[2], box: [L.box.min[0], L.box.min[1], L.box.min[2], L.box.max[0], L.box.max[1], L.box.max[2]] }
      : { kind: 'landmark', id: L.id, x: (L.box.min[0] + L.box.max[0]) / 2, y: L.box.min[1] + 0.3, z: (L.box.min[2] + L.box.max[2]) / 2, r: Math.hypot(L.box.max[0] - L.box.min[0], L.box.max[2] - L.box.min[2]) / 2 + 1.5 });
    for (const [id, list] of world.props ?? []) for (const p of list ?? []) { if (p.far) continue; const at = Array.isArray(p.at) ? p.at : [p.at?.x, p.at?.y, p.at?.z]; if (at.every(Number.isFinite)) out.push({ kind: 'prop', id, x: at[0], y: at[1] + 0.05, z: at[2], r: 1.2 }); }
    return out;
  };
  // a pad stands on open, level ground a body fits on, clear of the landmarks' footprints
  const level = (x, z, y0) => {
    if (boxes.some(b => x > b.min[0] - 1.6 && x < b.max[0] + 1.6 && z > b.min[2] - 1.6 && z < b.max[2] + 1.6)) return null;
    const y = walk.groundAt(x, z, y0 + 1.5); if (y == null || Math.abs(y - y0) > 1.2 || !walk.isWalkable(x, z, y + 0.1)) return null;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const q = walk.groundAt(x + dx, z + dz, y + 1.5); if (q == null || Math.abs(q - y) > 0.6 || !walk.isWalkable(x + dx, z + dz, q + 0.1)) return null; }
    return Math.round(y * 100) / 100;
  };
  const made = [];
  let mark = 0;
  const build = (kind, region, A, attempt = 0) => {
    // a cave nothing leads out of, on a world that can close one (terrain: world.close adds ground over it)
    if (kind === 'fill') {
      if (attempt || !region.places?.length || typeof world.close !== 'function') return null;
      const edits = world.close(region.places);
      const [x0, z0, x1, z1] = region.box; W.invalidate([x0 - 2, z0 - 2, x1 + 2, z1 + 2]);
      return edits.length ? { at: region.at, ends: [], filled: edits.length, runtime: true } : null;
    }
    if (kind !== 'pad') return null;
    const other = region.trap ? A.seats.back : A.seats.rim;
    const cand = [];
    for (const p of other ?? []) for (const q of region.rim ?? []) {
      const dx = q[0] - p[0], dz = q[2] - p[2], d = Math.sqrt(dx * dx + dz * dz), dy = q[1] - p[1];
      if (p[3] < 0.85 || q[3] < 0.85 || d > R.padMax || dy > R.padRise) continue;
      cand.push({ c: d + Math.max(0, dy) * 1.5, p, q, d });
    }
    cand.sort((u, v) => u.c - v.c);
    // the best first, each at least 3 m from those kept before it (another try is another place)
    const spread = [];
    for (const c of cand) { if (spread.length >= 40) break; const mx = (c.p[0] + c.q[0]) / 2, mz = (c.p[2] + c.q[2]) / 2; if (spread.every(o => (((o.p[0] + o.q[0]) / 2 - mx) ** 2 + ((o.p[2] + o.q[2]) / 2 - mz) ** 2) >= 9)) spread.push(c); }
    let skip = attempt;
    for (const c of spread) {
      // the way from one pad to the other: across the gap, or, where its two sides are one above the other (a cliff),
      // from the near side into the region (its middle)
      let ux = c.q[0] - c.p[0], uz = c.q[2] - c.p[2];
      if (c.d < 1.5) { ux = region.at[0] - c.p[0]; uz = region.at[2] - c.p[2]; }
      const ul = Math.sqrt(ux * ux + uz * uz) || 1; ux /= ul; uz /= ul;
      for (const inset of [2, 3, 1.4, 4.5, 0.8]) {
        const a = { x: c.p[0] - ux * inset, z: c.p[2] - uz * inset }, b = { x: c.q[0] + ux * inset, z: c.q[2] + uz * inset };
        a.y = level(a.x, a.z, c.p[1]); b.y = level(b.x, b.z, c.q[1]);
        if (a.y == null || b.y == null) continue;
        // the throw's arc in the open air both ways: no column with ground over it (a landmark's wall, a hill, a roof)
        const solid = (x, y, z) => { const top = walk.groundAt(x, z); return top != null && top > y - 1.1; };
        if (!arcClearOf(a, b, solid) || !arcClearOf(b, a, solid)) continue;
        if (skip-- > 0) break;
        extra.push({ from: a, to: b }, { from: b, to: a });
        W.relink();
        return { at: [(a.x + b.x) / 2, Math.max(a.y, b.y), (a.z + b.z) / 2].map(v => Math.round(v * 100) / 100), ends: [[a.x, a.y, a.z], [b.x, b.y, b.z]].map(e => e.map(v => Math.round(v * 100) / 100)), pads: [[a.x, a.y, a.z], [b.x, b.y, b.z]], gap: Math.round(c.d * 100) / 100, runtime: true };
      }
    }
    return null;
  };
  const res = connectRegions({
    analyse: () => W.regions({ things: things(), rims: true }),
    build,
    // a closed cave: its colliders are made again by the mesh worker after this frame, so the grid cannot read it yet;
    // the gate reads the regions again once they are
    joined: (r, kind) => kind === 'fill' ? true : (walk.reach({ x: r.start[0], y: r.start[1] + 0.1, z: r.start[2] }, seats[0], { radius: 1.2 }).ok && (r.trap || walk.reach(0, { x: r.start[0], y: r.start[1], z: r.start[2] }, { radius: 0.8 }).ok)),
    mark: () => { mark = extra.length; },
    undo: () => { if (extra.length > mark) { extra.length = mark; W.relink(); } },
  }, { ...R, can: ['pad', ...(typeof world.close === 'function' ? ['fill'] : [])], numbers: W.numbers });
  for (const c of res.made) made.push(c);
  const thrown = made.filter(c => c.pads);
  if (!thrown.length) return { list: made, kept: res.kept, left: res.left, tries: res.tries, pads: { update() {}, observe: () => [] } };
  const pairs = thrown.flatMap((c, k) => [{ id: `pad-r${k + 1}a`, from: c.pads[0], to: c.pads[1] }, { id: `pad-r${k + 1}b`, from: c.pads[1], to: c.pads[0] }]);
  const pads = addPads(ctx, root ?? world.root ?? world.group ?? ctx.scene, pairs, { color: ctx.look?.values?.palette?.accent ?? '#ff5fa2', base: '#8a7a5a', slot: world.template === 'terrain' ? 'world.terrain.shape' : 'world.ground' });
  return { list: made, kept: res.kept, left: res.left, tries: res.tries, pads };
}
