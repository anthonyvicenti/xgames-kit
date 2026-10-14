// gf-three fair play: the pure rules (no three.js, no DOM), so Node tests them. kit/core/fair.js runs them in a game.
// Node tests: research/gf-three/tests/f-fair.test.mjs.
//
// Fair play is the kit's, on by default (config/game.json → fair; creator feedback on Bladder Wars, 2026-10-06:
// "people kept knocking me down and I couldnt get up. The knock down timer was also pretty long"):
//   F1 a knock takes a player out of control for at most downSeconds, ragdoll and get-up included
//   F2 a player who is down (knocked, ragdolled, getting up, out) takes no damage, no knocks, and hits on them count
//      for nothing
//   F3 protectSeconds of protection once control returns (no knocks, no damage, no counted hits), shown on the body
//   F4 after a respawn the protection counts from when the player can move; the respawn point is the spawn farthest
//      from the other live players
//   F5 startGrace seconds at the start of a round with no counted hits; bots hold fire
//   F6 continuous attacks (stream ticks, contact damage) push but never knock over
//   F7 bots pick targets that can be hit, spread out, react like people (botSkill), and never gang up on one player
//   F8 hit and damage callbacks fire only for hits that counted

export const FAIR_DEFAULTS = Object.freeze({
  on: true,               // the whole of fair play (a game turns it off only when the creator asks)
  downSeconds: 1.2,       // F1: hit → walking again, ragdoll and get-up included
  protectSeconds: 1.5,    // F3/F4: protection once control returns
  startGrace: 2,          // F5: seconds at the start of a round with no counted hits; bots hold fire
  botSkill: 0.35,         // F7: 0 easy … 1 sharp (reaction time, aim error); 0.35 is friendly
  botsPerTarget: 1,       // F7: how many bots may hurt one human at a time (0: no limit)
  respawnFar: true,       // F4: respawn at the spawn farthest from the other live players
  protectColor: '#bff4ff', // F3: the shimmer on a protected body (a colour slot)
});

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** config/game.json → fair (any part missing takes its default) → the values the kit uses, clamped to sane ranges. */
export function fairConfig(cfg = {}) {
  const c = cfg && typeof cfg === 'object' ? cfg : {};
  return {
    on: c.on !== false,
    downSeconds: clamp(num(c.downSeconds, FAIR_DEFAULTS.downSeconds), 0.6, 8),
    protectSeconds: clamp(num(c.protectSeconds, FAIR_DEFAULTS.protectSeconds), 0, 10),
    startGrace: clamp(num(c.startGrace, FAIR_DEFAULTS.startGrace), 0, 30),
    botSkill: clamp(num(c.botSkill, FAIR_DEFAULTS.botSkill), 0, 1),
    botsPerTarget: Math.round(clamp(num(c.botsPerTarget, FAIR_DEFAULTS.botsPerTarget), 0, 8)),
    respawnFar: c.respawnFar !== false,
    protectColor: typeof c.protectColor === 'string' && /^#[0-9a-f]{6}$/i.test(c.protectColor) ? c.protectColor : FAIR_DEFAULTS.protectColor,
  };
}

/**
 * F1: a knock's whole budget (hit → walking) split into the ragdoll (the tumble) and the get-up (the clip, played
 * faster). → { total, ragdoll, getup } seconds
 */
export function knockSplit(total) {
  const T = clamp(num(total, FAIR_DEFAULTS.downSeconds), 0.6, 8);
  const ragdoll = clamp(T * 0.42, 0.3, 3);
  return { total: T, ragdoll, getup: T - ragdoll };
}

/** The anim words a player carries while not in control (kit/controller/controller.js). */
export const DOWN_WORDS = new Set(['knockdown', 'down', 'getup']);
/** In control from the pose alone (the only thing other copies have): alive and not knocked, ragdolled or getting up. */
export const inControl = (word, alive = true) => alive !== false && !DOWN_WORDS.has(word);

// A knock the host sent to a friend's copy shows in their pose about 0.1–0.3 s later; until it does, they count as down.
export const PENDING_KNOCK = 0.6;
// F7: hits from bots on one human within this window count as bots "on" that human.
export const GANG_WINDOW = 1.2;

/**
 * The referee: the host's record of every player's fairness (one per game). Time is passed in (seconds), so it is
 * deterministic. Per frame: observe(id, now, {control, alive}). When the host knocks someone: knocked(id, now).
 *   canHit(id, now, {from, fromBot, targetBot, clock}) → null when a hit counts, else why not:
 *     'out' | 'down' | 'protected' | 'grace' | 'busy' (enough bots are already on this human)
 */
export function createReferee(params = {}) {
  const P = fairConfig(params);
  const rec = new Map();
  const get = id => { let r = rec.get(id); if (!r) rec.set(id, r = { state: 'control', protectUntil: -1, knockAt: -1e9, sawDown: true, downAt: 0, bots: new Map() }); return r; };
  const api = {
    params: P,
    has: id => rec.has(id),
    /** Every frame, for every player: is it in control (from its controller, or its pose) and alive. */
    observe(id, now, { control = true, alive = true } = {}) {
      const r = get(id);
      if (alive === false) { if (r.state !== 'out') r.downAt = now; r.state = 'out'; r.sawDown = true; return r.state; }
      if (!control) { if (r.state === 'control') r.downAt = now; r.state = 'down'; r.sawDown = true; return r.state; }
      if (r.state !== 'control') {
        // a knock the host sent is not in the pose yet: still down
        if (!r.sawDown && now - r.knockAt < PENDING_KNOCK) return r.state;
        r.state = 'control';
        if (P.on) r.protectUntil = now + P.protectSeconds;     // F3/F4: protection counts from control
      }
      return r.state;
    },
    /** The host knocked this player (it may not show in their pose yet); out: taken out (until a respawn). */
    knocked(id, now, { out = false } = {}) { const r = get(id); if (r.state === 'control') r.downAt = now; r.state = out || r.state === 'out' ? 'out' : 'down'; r.knockAt = now; r.sawDown = false; },
    /** Protect for `seconds` from now (a game's own reason, e.g. a power-up). */
    protect(id, now, seconds) { const r = get(id); r.protectUntil = Math.max(r.protectUntil, now + Math.max(0, seconds)); },
    stateOf(id, now) { const r = get(id); return r.state !== 'control' ? r.state : now < r.protectUntil ? 'protected' : 'control'; },
    isDown: id => get(id).state !== 'control',
    isOut: id => get(id).state === 'out',
    isProtected: (id, now) => { const r = get(id); return r.state === 'control' && now < r.protectUntil; },
    protectLeft: (id, now) => Math.max(0, get(id).protectUntil - now),
    /** Can the player be knocked over right now (not down, not out, not protected). */
    canKnock(id, now) { if (!P.on) return true; const r = get(id); return r.state === 'control' && now >= r.protectUntil; },
    /** Does a hit on this player count right now. → null, or the reason it does not. */
    canHit(id, now, { from = null, fromBot = false, targetBot = false, clock = Infinity } = {}) {
      if (!P.on) return null;
      const r = get(id);
      if (r.state === 'out') return 'out';
      if (r.state === 'down') return 'down';
      if (now < r.protectUntil) return 'protected';
      if (clock < P.startGrace) return 'grace';
      if (fromBot && !targetBot && P.botsPerTarget > 0 && from !== null) {
        let on = 0;
        for (const [b, t] of r.bots) if (b !== from && now - t < GANG_WINDOW) on++;
        if (on >= P.botsPerTarget) return 'busy';
      }
      return null;
    },
    /** A hit on `id` counted: remember a bot's (for the gang limit). */
    noteHit(id, now, { from = null, fromBot = false } = {}) { if (fromBot && from !== null) get(id).bots.set(from, now); },
    remove: id => rec.delete(id),
    reset() { rec.clear(); },
  };
  return api;
}

/**
 * F4: the spawn point farthest from the other live players (the largest distance to the nearest of them).
 * spawns: [{x, z, ...}], others: [{x, z}] → the index (0 when there is nobody else).
 */
export function farthestSpawn(spawns, others) {
  if (!spawns?.length) return -1;
  if (!others?.length) return 0;
  let best = 0, bestD = -1;
  for (let i = 0; i < spawns.length; i++) {
    const s = spawns[i]; let d = Infinity;
    for (const o of others) d = Math.min(d, Math.hypot(s.x - o.x, s.z - o.z));
    if (d > bestD + 1e-9) { bestD = d; best = i; }
  }
  return best;
}

/**
 * F7: pick a target for a bot. cands: [{id, x, z, score, ok (can be hit), claims (other bots on it)}].
 * Only hittable candidates within `range`; fewest claims first (no two bots on one target while another is in range),
 * then the nearest, with a small pull toward the score leader (a catch-up bias) or a strong one for prefer 'leader'.
 * → the chosen candidate, or null.
 */
export function pickTarget(from, cands, { range = 10, prefer = 'spread' } = {}) {
  const live = cands.filter(c => c.ok && Math.hypot(c.x - from.x, c.z - from.z) <= range);
  if (!live.length) return null;
  const top = Math.max(...live.map(c => c.score ?? 0)), low = Math.min(...live.map(c => c.score ?? 0));
  const pull = prefer === 'leader' ? 4 : prefer === 'nearest' ? 0 : 1.5;     // metres of distance the leader is worth
  let best = null, bestK = Infinity;
  for (const c of live) {
    const d = Math.hypot(c.x - from.x, c.z - from.z);
    const lead = top > low ? ((c.score ?? 0) - low) / (top - low) : 0;
    const k = (prefer === 'nearest' ? 0 : (c.claims ?? 0) * 1000) + d - lead * pull;
    if (k < bestK) { bestK = k; best = c; }
  }
  return best;
}

/** F7: how a bot of this skill (0..1) reacts: seconds before it fires at a new target, aim error (radians), fire duty. */
export function botTraits(skill) {
  const s = clamp(num(skill, FAIR_DEFAULTS.botSkill), 0, 1);
  return { reaction: 0.95 - 0.7 * s, aimError: 0.3 - 0.26 * s, duty: 0.55 + 0.4 * s };
}
