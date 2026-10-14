// health: the pure rules (no three.js, no DOM). A `Pool` is one host-side record of every player's hit points.
// Node tests: research/gf-three/tests/k2-health.test.mjs.

/**
 * Hit points for a set of ids. hp0 = 0 means "no meter": hits never kill (knock only).
 * Time is passed in (seconds, the round's clock) so the pool is deterministic.
 */
export function createPool({ hp = 3, regen = 0, regenDelay = 3, respawnSeconds = 3, respawnInvuln = 1.5, getUpSeconds = 1.5 } = {}) {
  const rec = new Map();
  const get = id => { let r = rec.get(id); if (!r) rec.set(id, r = { hp, lastHit: -1e9, downUntil: 0, deadUntil: null, invulnUntil: 0 }); return r; };
  return {
    hp: id => get(id).hp,
    has: id => rec.has(id),
    max: () => hp,
    isDown: (id, now) => now < get(id).downUntil,
    isDead: id => get(id).deadUntil !== null,
    invulnerable: (id, now) => now < get(id).invulnUntil,
    makeInvulnerable(id, now, secs) { get(id).invulnUntil = now + secs; },
    /** → { applied, hp, lethal, knocked } (knocked: this hit knocks the body, i.e. it was not already down) */
    damage(id, amount, now, { knock = true } = {}) {
      const r = get(id);
      if (r.deadUntil !== null || now < r.invulnUntil) return { applied: false, hp: r.hp, lethal: false, knocked: false };
      const knocked = knock && now >= r.downUntil;
      if (knocked) r.downUntil = now + getUpSeconds;
      r.lastHit = now;
      if (hp <= 0) return { applied: true, hp: 0, lethal: false, knocked };
      r.hp = Math.max(0, r.hp - Math.max(0, amount));
      const lethal = r.hp <= 0;
      if (lethal) r.deadUntil = respawnSeconds > 0 ? now + respawnSeconds : Infinity;
      return { applied: true, hp: r.hp, lethal, knocked };
    },
    heal(id, amount) { const r = get(id); if (r.deadUntil !== null) return r.hp; r.hp = Math.min(hp, r.hp + amount); return r.hp; },
    kill(id, now) { const r = get(id); if (r.deadUntil !== null) return false; r.hp = 0; r.deadUntil = respawnSeconds > 0 ? now + respawnSeconds : Infinity; r.downUntil = now + getUpSeconds; return true; },
    /** Ids whose respawn time has come. */
    deadLeft(id, now) { const r = rec.get(id); if (!r || r.deadUntil === null) return null; return Number.isFinite(r.deadUntil) ? Math.max(0, r.deadUntil - now) : Infinity; },
    due(now) { const out = []; for (const [id, r] of rec) if (r.deadUntil !== null && r.deadUntil <= now) out.push(id); return out; },
    revive(id, now) { const r = get(id); r.hp = hp; r.deadUntil = null; r.downUntil = 0; r.invulnUntil = now + respawnInvuln; },
    /** Regenerate everyone who has been left alone for regenDelay. → ids whose hp changed */
    regen(dt, now) {
      const out = [];
      if (regen <= 0 || hp <= 0) return out;
      for (const [id, r] of rec) if (r.deadUntil === null && r.hp < hp && now - r.lastHit >= regenDelay) { r.hp = Math.min(hp, r.hp + regen * dt); out.push(id); }
      return out;
    },
    remove: id => rec.delete(id),
    reset() { rec.clear(); },
    snapshot: () => Object.fromEntries([...rec].map(([id, r]) => [id, r.hp])),
  };
}
