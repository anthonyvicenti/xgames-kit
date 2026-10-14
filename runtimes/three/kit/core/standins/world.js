// STAND-IN for track L's kit/world/world.js (CONTRACT §4.3), used until it lands. A flat ground (a slot-tagged plane:
// its texture and colour are slots), invisible walls at the edge, and the layout's props placed from their model
// slots with box colliders from their bounds. The kit picks the real module at boot when gf/three/kit.js lists it.
//
//   const world = await loadWorld(ctx, assets.config('world'));
//   world.spawn(i) → {x, y, z, yaw}   world.zone('centre') → {shape, at, size, contains(p), random(rng)}
//   world.props → Map(name → [Object3D])   world.raycast(from, dir, max) → {point, distance, normal, collider} | null
//   world.bounds → {half}   world.colliders → the fixed colliders (props and walls)
import * as THREE from 'three';
import { WORLD_GROUPS } from '../util.js';

export const templates = ['backyard', 'office', 'plaza', 'arena', 'store'];

export async function loadWorld(ctx, cfg) {
  const { scene, assets } = ctx;
  const W = ctx.physics, RAPIER = ctx.RAPIER;
  const T = cfg.template ?? 'backyard', half = cfg.half ?? 12;
  const group = new THREE.Group(); group.name = `gf-world-${T}`; scene.add(group);
  const fixed = W.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  const colliders = [];
  const addBox = (hx, hy, hz, x, y, z, rotY = 0, tag = 'wall') => {
    const d = RAPIER.ColliderDesc.cuboid(hx, hy, hz).setTranslation(x, y, z).setRotation({ x: 0, y: Math.sin(rotY / 2), z: 0, w: Math.cos(rotY / 2) }).setFriction(1).setCollisionGroups(WORLD_GROUPS);
    const c = W.createCollider(d, fixed); c.__gf = { tag }; colliders.push(c); return c;
  };

  // ---- the ground: a plane whose texture and colour are slots ----
  const g = cfg.ground ?? {};
  const groundSlot = `world.${T}.ground`;
  const size = half * 2 + 8;
  const mat = new THREE.MeshStandardMaterial({ color: assets.value(`${groundSlot}.color`, g.color ?? '#ffffff'), roughness: 0.95 });
  if (assets.has(groundSlot)) {
    const rep = assets.value(`${groundSlot}.repeat`, g.repeat ?? 8);
    mat.map = await assets.texture(groundSlot, { repeat: rep });
  }
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(size, size).rotateX(-Math.PI / 2), mat);
  ground.name = 'ground'; ground.receiveShadow = true;
  assets.tag(ground, groundSlot);
  group.add(ground);
  addBox(size / 2, 0.5, size / 2, 0, -0.5, 0, 0, 'ground');
  // walls: colliders only (nothing visible), just outside the play area
  if (cfg.walls !== false) for (const [x, z, hx, hz] of [[half + 0.5, 0, 0.5, half + 1], [-half - 0.5, 0, 0.5, half + 1], [0, half + 0.5, half + 1, 0.5], [0, -half - 0.5, half + 1, 0.5]]) addBox(hx, 3, hz, x, 3, z);

  // ---- props from the layout ----
  const props = new Map();
  for (const [i, p] of (cfg.props ?? []).entries()) {
    const slot = `prop.${p.prop}`;
    if (!assets.has(slot)) throw new Error(`gf-three world: the layout places "${p.prop}" but assets.json has no ${slot} slot`);
    const fit = p.size ?? null;
    const obj = await assets.model(slot, { fit, ground: true });
    const k = p.scale ?? 1; obj.scale.setScalar(k);
    const [x, y, z] = p.at ?? [0, 0, 0];
    obj.position.set(x, y, z); obj.rotation.y = p.rot ?? 0;
    obj.name = `${p.prop}#${i}`;
    group.add(obj);
    obj.updateMatrixWorld(true);
    // a box collider from the model's own bounds (before rotation), turned with it
    const inner = obj.children[0]; const box = new THREE.Box3().setFromObject(inner, true);
    const sz = box.getSize(new THREE.Vector3()).multiplyScalar(k), c = box.getCenter(new THREE.Vector3()).multiplyScalar(k);
    if (p.collide !== false && sz.x > 0.05 && sz.z > 0.05) {
      const cos = Math.cos(obj.rotation.y), sin = Math.sin(obj.rotation.y);
      addBox(sz.x / 2, sz.y / 2, sz.z / 2, x + c.x * cos + c.z * sin, y + c.y, z - c.x * sin + c.z * cos, obj.rotation.y, `prop:${p.prop}`);
    }
    if (!props.has(p.prop)) props.set(p.prop, []);
    props.get(p.prop).push(obj);
  }

  const spawns = (cfg.spawns ?? [[0, 0, 0]]).map(([x, y, z]) => ({ x, y, z, yaw: Math.atan2(-x, -z) }));   // facing the centre
  const zones = {};
  for (const [name, z] of Object.entries(cfg.zones ?? {})) {
    const at = z.at ?? [0, 0, 0], sz = [].concat(z.size ?? 2);
    zones[name] = {
      name, shape: z.shape ?? 'circle', at, size: sz,
      contains: p => (z.shape === 'box' ? Math.abs(p.x - at[0]) <= sz[0] / 2 && Math.abs(p.z - at[2]) <= (sz[2] ?? sz[0]) / 2 : Math.hypot(p.x - at[0], p.z - at[2]) <= sz[0]),
      random: rng => { if (z.shape === 'box') return { x: at[0] + (rng() - 0.5) * sz[0], y: at[1], z: at[2] + (rng() - 0.5) * (sz[2] ?? sz[0]) }; const a = rng() * Math.PI * 2, r = Math.sqrt(rng()) * sz[0]; return { x: at[0] + Math.cos(a) * r, y: at[1], z: at[2] + Math.sin(a) * r }; },
    };
  }
  const ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
  const isWorld = c => c.parent()?.handle === fixed.handle;
  return {
    template: T, root: group, group, bounds: new THREE.Box3(new THREE.Vector3(-half, 0, -half), new THREE.Vector3(half, 4, half)), half, colliders, props, spawns,
    spawn: i => spawns[((i % spawns.length) + spawns.length) % spawns.length],
    zone: name => zones[name] ?? null,
    zones,
    /** A ray against the world's fixed colliders (ground, walls, props): {point, distance, normal, collider} or null. */
    raycast(from, dir, max = 50) {
      const l = Math.hypot(dir.x, dir.y, dir.z) || 1;
      ray.origin = { x: from.x, y: from.y, z: from.z }; ray.dir = { x: dir.x / l, y: dir.y / l, z: dir.z / l };
      const h = W.castRayAndGetNormal(ray, max, true, undefined, undefined, undefined, undefined, isWorld);
      if (!h) return null;
      const d = h.timeOfImpact;
      return { point: { x: from.x + ray.dir.x * d, y: from.y + ray.dir.y * d, z: from.z + ray.dir.z * d }, distance: d, normal: h.normal, collider: h.collider, tag: h.collider.__gf?.tag ?? null };
    },
  };
}
