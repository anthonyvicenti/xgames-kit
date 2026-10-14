// levels: the pure logic (no three.js, no DOM): the run's state machine on the host. Node tests:
// research/gf-three/tests/k2-levels.test.mjs.
//
// A run is `count` levels. Each level is an encounter (the waves mechanic's enemies, more and tougher each level);
// when every enemy is down the level's portal opens; when every player who is up stands in it (or `portalSeconds`
// after the first one steps in) everyone moves to the next level. The last level is the boss's: beating it wins the
// run. Everyone down at once loses it (the spec's loseBy); a replay starts again at level 1.

/** Phases on the wire. */
export const PH = { fight: 'fight', open: 'open', travel: 'travel', won: 'won', lost: 'lost' };

/** What level i (0-based) of `count` asks of the waves mechanic: {level (1-based), waves, startCount, growth, hpScale, speedScale, boss}. */
export function encounterFor(i, { count = 3, wavesPerLevel = 2, startCount = 3, growth = 1, levelGrowth = 1, hpScale = 0.15, speedScale = 0.05, bossLevel = 'last' } = {}) {
  const boss = bossLevel === 'last' && i === count - 1;
  return {
    level: i + 1, boss,
    waves: boss ? 0 : Math.max(1, Math.round(Array.isArray(wavesPerLevel) ? (wavesPerLevel[i] ?? wavesPerLevel[wavesPerLevel.length - 1]) : wavesPerLevel)),
    startCount: Math.max(1, Math.round(startCount + levelGrowth * i)), growth,
    hpScale: 1 + hpScale * i, speedScale: 1 + speedScale * i,
  };
}

/**
 * One host frame. s: {l, ph, t, open, inPortal, travel}; o: {count, portalSeconds, travelSeconds, wonDelay};
 * w: {cleared (this level's enemies are all down), bossDown (the boss level's boss is down), alive (players up),
 * players (players in the round), inPortal (players up standing in the portal), wipe (everyone down at once)}.
 * Returns the edges: ['open'] | ['travel'] | ['next'] | ['won'] | ['lost'] (in order).
 */
export function stepRun(s, w, dt, o = {}) {
  const ev = [], count = o.count ?? 3, last = s.l >= count - 1;
  s.t = Math.max(0, (s.t ?? 0) - dt);
  if (s.ph === PH.won || s.ph === PH.lost) return ev;
  if (w.players > 0 && w.wipe) { s.ph = PH.lost; ev.push('lost'); return ev; }
  switch (s.ph) {
    case PH.fight:
      if (last && w.boss ? w.bossDown && w.cleared : w.cleared) {
        if (last) { s.ph = PH.won; s.t = o.wonDelay ?? 1.6; ev.push('won'); }
        else { s.ph = PH.open; s.t = 0; s.armed = false; ev.push('open'); }
      }
      break;
    case PH.open: {
      const all = w.alive > 0 && w.inPortal >= w.alive;
      if (w.inPortal > 0 && !s.armed) { s.armed = true; s.t = o.portalSeconds ?? 8; }
      if (all || (s.armed && s.t <= 0)) { s.ph = PH.travel; s.t = o.travelSeconds ?? 0.8; ev.push('travel'); }
      break;
    }
    case PH.travel:
      if (s.t <= 0) { s.l += 1; s.ph = PH.fight; s.armed = false; ev.push('next'); }
      break;
  }
  return ev;
}

/** Is a point inside a circle zone {at, size} (size[0] the radius)? */
export function inZone(zone, x, z, slack = 0) {
  if (!zone) return false;
  const at = zone.at ?? [0, 0, 0], cx = at.x ?? at[0] ?? 0, cz = at.z ?? at[2] ?? 0, r = [].concat(zone.size ?? 2)[0];
  return Math.hypot(x - cx, z - cz) <= r + slack;
}
