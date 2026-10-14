// waves: slow, dodgeable bolts (ranged enemies, the boss's volley). The host owns them: it moves them and tests them
// against the players; every copy draws them from the shared list and moves them between snapshots, so a player sees
// a bolt coming and can step out of its way (or dash through it: a dash's invulnerable frames count, melee.dodging).
//
//   const bolts = createBolts(ctx, { key: 'wb', slot: 'mechanic.waves.bolt-color', color, onHit })
//   bolts.fire({x, z, y}, yaw, {speed, radius, damage, knock})      host
//   bolts.update(dt)                                                 every copy (host: flight and hits)
// Shared state key (one per owner): {l: [[id, x, z, vx, vz, r]]} (about 30 B a bolt, at most 16).
import * as THREE from 'three';
import { physicsOf } from '../../core/util.js';

const r2 = v => Math.round(v * 100) / 100;
const MAX = 16;

export function createBolts(ctx, { key, slot, color = '#ff8a3d', height = 1.0, lifetime = 3.2, onHit = null }) {
  let S = null, nextId = 1, lastList = null, fired = 0, hits = 0;
  const host = new Map();             // id → {id, x, z, vx, vz, r, damage, knock, age, from}
  const view = new Map();             // id → {x, z, vx, vz, obj}
  const root = new THREE.Group(); root.name = `gf-bolts-${key}`; ctx.scene.add(root);
  const geo = new THREE.IcosahedronGeometry(1, 1);
  let mat = null;
  const matOf = () => (mat ??= new THREE.MeshBasicMaterial({ color, toneMapped: false }));
  function wallBetween(a, b) {
    const { RAPIER: R, world: W } = physicsOf(ctx);
    const dx = b.x - a.x, dz = b.z - a.z, d = Math.hypot(dx, dz);
    if (!R || !W || d < 1e-6) return false;
    const ray = new R.Ray({ x: a.x, y: height, z: a.z }, { x: dx / d, y: 0, z: dz / d });
    const h = W.castRay(ray, d, true, undefined, undefined, undefined, undefined, c => { const p = c.parent(); return !p || p.isFixed(); });
    return !!h;
  }
  const api = {
    get count() { return ctx.host ? host.size : view.size; },
    get stats() { return { fired, hits, flying: api.count }; },
    /** Host: a bolt from (x, z) along yaw. */
    fire(at, yaw, { speed = 7, radius = 0.28, damage = 1, knock = 3, from = null } = {}) {
      if (!ctx.host || host.size >= MAX) return false;
      const b = { id: nextId++, x: at.x, z: at.z, vx: Math.sin(yaw) * speed, vz: Math.cos(yaw) * speed, r: radius, damage, knock, age: 0, from };
      host.set(b.id, b); fired++;
      return true;
    },
    clear() { host.clear(); for (const v of view.values()) v.obj?.removeFromParent(); view.clear(); lastList = null; },
    update(dt) {
      if (!S) { if (!ctx.shared) return; S = ctx.shared.register(key, { l: [] }); }
      if (ctx.host) {
        const playing = ctx.round?.phase === 'playing';
        if (!playing) host.clear();
        for (const b of [...host.values()]) {
          const a = { x: b.x, z: b.z };
          b.age += dt; b.x += b.vx * dt; b.z += b.vz * dt;
          if (b.age > lifetime || wallBetween(a, b)) { host.delete(b.id); continue; }
          // the players where the host has them (its own, its bots, friends from their poses)
          for (const p of ctx.players.list()) {
            if (p.alive === false || !(p.owned || p.drawn)) continue;
            // swept: the closest the bolt came to the player this frame
            const sx = b.x - a.x, sz = b.z - a.z, l2 = sx * sx + sz * sz;
            const u = l2 > 1e-9 ? Math.max(0, Math.min(1, ((p.position.x - a.x) * sx + (p.position.z - a.z) * sz) / l2)) : 1;
            const d = Math.hypot(a.x + sx * u - p.position.x, a.z + sz * u - p.position.z);
            if (d > b.r + 0.4) continue;
            const counted = onHit?.(p, b) !== false;
            if (counted) hits++;
            host.delete(b.id);
            break;
          }
        }
        S.l = [...host.values()].map(b => [b.id, r2(b.x), r2(b.z), r2(b.vx), r2(b.vz), r2(b.r)]);
      }
      // every copy: draw (the host its own simulation; others move them between snapshots)
      const list = S.l;
      if (list !== lastList) {
        lastList = list;
        const seen = new Set();
        for (const e of list ?? []) {
          seen.add(e[0]);
          let v = view.get(e[0]);
          if (!v) {
            const obj = new THREE.Mesh(geo, matOf()); obj.scale.setScalar(e[5] ?? 0.28); obj.renderOrder = 3;
            ctx.assets?.tag?.(obj, slot); root.add(obj);
            v = { x: e[1], z: e[2], vx: e[3], vz: e[4], obj }; view.set(e[0], v);
          } else if (!ctx.host) { v.x += (e[1] - v.x) * 0.5; v.z += (e[2] - v.z) * 0.5; v.vx = e[3]; v.vz = e[4]; }
          if (ctx.host) { v.x = e[1]; v.z = e[2]; }
        }
        for (const [k, v] of view) if (!seen.has(k)) { v.obj.removeFromParent(); view.delete(k); }
      }
      for (const v of view.values()) {
        if (!ctx.host) { v.x += v.vx * dt; v.z += v.vz * dt; }
        v.obj.position.set(v.x, height + Math.sin((ctx.time?.now ?? 0) * 18 + v.x) * 0.04, v.z);
      }
    },
    dispose() { root.removeFromParent(); },
  };
  return api;
}
