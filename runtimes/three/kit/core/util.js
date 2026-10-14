// gf-three core: small helpers shared by the kit's modules, written against the CONTRACT so they work with the real
// world module (track L) and the stand-in alike: ctx.physics is the Rapier World, ctx.RAPIER the Rapier module,
// ctx.world.bounds a THREE.Box3 of the play area, ctx.world.spawn(i) a point (a yaw is added when it has none).

/**
 * Rapier collision groups (kit/character/RIG.md §6), as InteractionGroups: membership << 16 | filter.
 * A player's capsule is a PLAYER that meets the world, props and other players, never a ragdoll (its own included);
 * ragdoll parts meet WORLD | PROPS only.
 */
export const GROUPS = { WORLD: 0x1, PLAYERS: 0x2, PROPS: 0x4, RAGDOLL: 0x8 };
export const groups = (member, filter) => ((member & 0xffff) << 16) | (filter & 0xffff);
export const CAPSULE_GROUPS = groups(GROUPS.PLAYERS, GROUPS.WORLD | GROUPS.PLAYERS | GROUPS.PROPS);
export const WORLD_GROUPS = groups(GROUPS.WORLD, 0xffff);
/** For queries (ground casts, the camera): what a player stands on or a camera stops at; never a ragdoll. */
export const SOLID_QUERY = groups(GROUPS.PLAYERS, GROUPS.WORLD | GROUPS.PROPS);

/** The play area: {minX, maxX, minZ, maxZ, cx, cz, hx, hz} (hx/hz: half sizes). */
export function areaOf(world) {
  const b = world?.bounds;
  if (b && b.min && b.max) return { minX: b.min.x, maxX: b.max.x, minZ: b.min.z, maxZ: b.max.z, cx: (b.min.x + b.max.x) / 2, cz: (b.min.z + b.max.z) / 2, hx: (b.max.x - b.min.x) / 2, hz: (b.max.z - b.min.z) / 2 };
  const h = b?.half ?? world?.half ?? 12;
  return { minX: -h, maxX: h, minZ: -h, maxZ: h, cx: 0, cz: 0, hx: h, hz: h };
}

/** Spawn point i as {x, y, z, yaw}; with no yaw of its own it faces the middle of the play area. */
export function spawnOf(world, i) {
  const s = world.spawn(i) ?? { x: 0, y: 0, z: 0 };
  const a = areaOf(world);
  const x = s.x ?? s[0] ?? 0, y = s.y ?? s[1] ?? 0, z = s.z ?? s[2] ?? 0;
  return { x, y, z, yaw: Number.isFinite(s.yaw) ? s.yaw : Math.atan2(a.cx - x, a.cz - z) };
}

/**
 * ctx.physics in either shape → { RAPIER, world } (either may be null). K1's boot sets ctx.physics to the bare Rapier
 * World and ctx.RAPIER to the module (CONTRACT §6b); benches, fixtures and older callers pass { RAPIER, world }
 * (CONTRACT §4.4 accepts both). Every kit module that touches Rapier reads it through this, never ctx.physics directly.
 */
export function physicsOf(ctx) {
  const p = ctx?.physics ?? null;
  const world = p && typeof p.createRigidBody === 'function' ? p : p?.world && typeof p.world.createRigidBody === 'function' ? p.world : null;
  const RAPIER = ctx?.RAPIER ?? p?.RAPIER ?? null;
  return { RAPIER: RAPIER && typeof RAPIER.Ray === 'function' ? RAPIER : null, world };
}

/** A ray against fixed colliders only (the ground, walls, props; never a player's capsule). → distance or null. */
export function fixedRay(ctx, from, dir, max) {
  const { RAPIER: R, world: W } = physicsOf(ctx);
  if (!R || !W) return null;
  const l = Math.hypot(dir.x, dir.y, dir.z) || 1;
  const ray = new R.Ray({ x: from.x, y: from.y, z: from.z }, { x: dir.x / l, y: dir.y / l, z: dir.z / l });
  const hit = W.castRay(ray, max, true, undefined, undefined, undefined, undefined, c => { const b = c.parent(); return !b || b.isFixed(); });
  return hit ? (hit.timeOfImpact ?? hit.toi) : null;
}
