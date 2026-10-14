// melee: the pure logic (no three.js, no DOM): the weapon table, a player's swing state machine, the arc test and the
// dash. Node tests: research/gf-three/tests/k2-melee.test.mjs.
//
// gf-three port of BUDDY: ROLLBACK (octobooth-4/buddy-rollback@db51978, MIT, Copyright (c) 2026 BUDDY: ROLLBACK
// contributors; LICENSE-buddy-rollback and NOTICE-buddy-rollback beside this file): src/weapons.js's combo table (arc,
// range, damage, lunge, knock, finisher, a dash strike) and src/player.js's startSwing / updateSwing (a press during a
// swing is queued and chains the next step; a combo window after it), hitArc (the angle test widened by the target's
// radius, a point-blank pass) and startDash (invulnerable frames, a cooldown). Rewritten for gf-three as data plus a
// step function with windup, active and recover phases, so every move has weight: it winds up (readable), hits during
// its active frames only, and leaves a recovery the player commits to.

const DEG = Math.PI / 180;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** One swing. Times in seconds, arc in degrees, reach in metres, knockback in m/s, lunge in m/s, hitStop in seconds. */
export const MOVE_DEFAULTS = Object.freeze({
  windup: 0.1, active: 0.1, recover: 0.24, arc: 110, reach: 2.1, damage: 1, knockback: 4, hitStop: 0.05, lunge: 3,
  sweep: 1, tilt: 0, clip: '', finisher: false, knockdown: false, guardBreak: false,
});
const M = o => ({ ...MOVE_DEFAULTS, ...o });

/** Rarity tiers: a weapon of rarity r hits (1 + RARITY_STEP × r) times as hard. */
export const RARITIES = ['common', 'rare', 'epic', 'legendary'];
export const RARITY_STEP = 0.25;

/**
 * The kit's weapon table. Each weapon: a combo chain (light presses), a heavy attack, a dash strike (an attack right
 * after a dash). The clips are gf-humanoid-1 names track C adds (slash_1..3, heavy); until a body has them the runtime
 * falls back to punch (melee/index.js clipFor).
 */
export const DEFAULT_WEAPONS = Object.freeze([
  {
    id: 'sword', name: 'Sword', kind: 'sword', rarity: 0, color: '#c9d3df', prop: '',
    combo: [
      M({ windup: 0.1, active: 0.1, recover: 0.22, arc: 120, reach: 2.2, damage: 1, knockback: 3.5, hitStop: 0.055, lunge: 3.5, sweep: 1, tilt: 12, clip: 'slash_1' }),
      M({ windup: 0.09, active: 0.1, recover: 0.22, arc: 120, reach: 2.2, damage: 1, knockback: 3.5, hitStop: 0.055, lunge: 3.5, sweep: -1, tilt: -12, clip: 'slash_2' }),
      M({ windup: 0.16, active: 0.12, recover: 0.38, arc: 160, reach: 2.6, damage: 2, knockback: 7, hitStop: 0.09, lunge: 6, sweep: 1, tilt: 28, clip: 'slash_3', finisher: true }),
    ],
    heavy: M({ windup: 0.42, active: 0.14, recover: 0.45, arc: 200, reach: 2.8, damage: 3, knockback: 10, hitStop: 0.12, lunge: 5, sweep: -1, tilt: 4, clip: 'heavy', finisher: true, knockdown: true, guardBreak: true }),
    dashStrike: M({ windup: 0.04, active: 0.12, recover: 0.3, arc: 70, reach: 3, damage: 2, knockback: 7, hitStop: 0.07, lunge: 9, sweep: 0, tilt: 0, clip: 'slash_3', finisher: true }),
  },
  {
    id: 'axe', name: 'Axe', kind: 'axe', rarity: 0, color: '#b9a48a', prop: '',
    combo: [
      M({ windup: 0.17, active: 0.12, recover: 0.32, arc: 140, reach: 2.3, damage: 2, knockback: 5, hitStop: 0.075, lunge: 3, sweep: 1, tilt: 16, clip: 'slash_1' }),
      M({ windup: 0.2, active: 0.13, recover: 0.42, arc: 170, reach: 2.4, damage: 3, knockback: 8, hitStop: 0.1, lunge: 4.5, sweep: -1, tilt: -20, clip: 'slash_3', finisher: true }),
    ],
    heavy: M({ windup: 0.55, active: 0.16, recover: 0.5, arc: 360, reach: 2.6, damage: 4, knockback: 11, hitStop: 0.14, lunge: 0, sweep: 1, tilt: 0, clip: 'heavy', finisher: true, knockdown: true, guardBreak: true }),
    dashStrike: M({ windup: 0.05, active: 0.14, recover: 0.36, arc: 90, reach: 2.8, damage: 3, knockback: 8, hitStop: 0.09, lunge: 8, sweep: 1, tilt: 20, clip: 'slash_3', finisher: true }),
  },
  {
    id: 'spear', name: 'Spear', kind: 'spear', rarity: 0, color: '#d8c79a', prop: '',
    combo: [
      M({ windup: 0.08, active: 0.09, recover: 0.2, arc: 36, reach: 3.2, damage: 1, knockback: 3, hitStop: 0.045, lunge: 4.5, sweep: 0, clip: 'slash_1' }),
      M({ windup: 0.08, active: 0.09, recover: 0.2, arc: 36, reach: 3.2, damage: 1, knockback: 3, hitStop: 0.045, lunge: 4.5, sweep: 0, clip: 'slash_2' }),
      M({ windup: 0.14, active: 0.12, recover: 0.36, arc: 44, reach: 3.8, damage: 2, knockback: 8, hitStop: 0.085, lunge: 8, sweep: 0, clip: 'slash_3', finisher: true }),
    ],
    heavy: M({ windup: 0.4, active: 0.14, recover: 0.45, arc: 50, reach: 4.4, damage: 3, knockback: 10, hitStop: 0.11, lunge: 10, sweep: 0, clip: 'heavy', finisher: true, knockdown: true, guardBreak: true }),
    dashStrike: M({ windup: 0.04, active: 0.12, recover: 0.3, arc: 40, reach: 4, damage: 2, knockback: 8, hitStop: 0.07, lunge: 12, sweep: 0, clip: 'slash_3', finisher: true }),
  },
]);

/** A move with every field, numbers kept in sane ranges. */
export function normalizeMove(m = {}, fallback = MOVE_DEFAULTS) {
  const o = { ...MOVE_DEFAULTS, ...fallback, ...(m && typeof m === 'object' ? m : {}) };
  return {
    windup: clamp(num(o.windup, 0.1), 0, 2), active: clamp(num(o.active, 0.1), 0.02, 1), recover: clamp(num(o.recover, 0.24), 0, 2),
    arc: clamp(num(o.arc, 110), 5, 360), reach: clamp(num(o.reach, 2.1), 0.5, 8), damage: clamp(num(o.damage, 1), 0, 100),
    knockback: clamp(num(o.knockback, 4), 0, 30), hitStop: clamp(num(o.hitStop, 0.05), 0, 0.3), lunge: clamp(num(o.lunge, 3), 0, 20),
    sweep: [-1, 0, 1].includes(o.sweep) ? o.sweep : 1, tilt: clamp(num(o.tilt, 0), -80, 80), clip: typeof o.clip === 'string' ? o.clip : '',
    finisher: !!o.finisher, knockdown: !!o.knockdown, guardBreak: !!o.guardBreak,
  };
}

/** The weapon table from params (any part missing takes the kit's): ids unique, every move whole. */
export function normalizeWeapons(list) {
  const src = Array.isArray(list) && list.length ? list : DEFAULT_WEAPONS;
  const out = [], seen = new Set();
  for (const [i, w0] of src.entries()) {
    if (!w0 || typeof w0 !== 'object') continue;
    const base = DEFAULT_WEAPONS.find(d => d.id === w0.id || d.kind === w0.kind) ?? DEFAULT_WEAPONS[0];
    let id = String(w0.id ?? base.id ?? `weapon-${i + 1}`).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').slice(0, 24) || `weapon-${i + 1}`;
    while (seen.has(id)) id = `${id}-${i + 1}`;
    seen.add(id);
    const combo = (Array.isArray(w0.combo) && w0.combo.length ? w0.combo : base.combo).slice(0, 8).map((m, j) => normalizeMove(m, base.combo[Math.min(j, base.combo.length - 1)]));
    out.push({
      id, name: String(w0.name ?? base.name ?? id).slice(0, 32), kind: ['sword', 'axe', 'spear', 'hammer', 'fists'].includes(w0.kind) ? w0.kind : base.kind,
      rarity: clamp(Math.round(num(w0.rarity, 0)), 0, RARITIES.length - 1), color: typeof w0.color === 'string' ? w0.color : base.color,
      prop: typeof w0.prop === 'string' ? w0.prop : '', model: typeof w0.model === 'string' ? w0.model : '',
      grip: w0.grip && typeof w0.grip === 'object' ? w0.grip : null,
      combo, heavy: normalizeMove(w0.heavy, base.heavy), dashStrike: normalizeMove(w0.dashStrike, base.dashStrike),
    });
  }
  return out.length ? out : normalizeWeapons(DEFAULT_WEAPONS);
}

/** A move's key: its combo index (0..7), 'h' (heavy) or 'd' (dash strike). Its wire code: 0..7, 8 (dash strike), 9 (heavy). */
export const moveCode = key => (key === 'h' ? 9 : key === 'd' ? 8 : Number(key) | 0);
export const moveKey = code => (code === 9 ? 'h' : code === 8 ? 'd' : clamp(code | 0, 0, 7));
export const baseMove = (W, key) => (key === 'h' ? W.heavy : key === 'd' ? W.dashStrike : W.combo[clamp(Number(key) | 0, 0, W.combo.length - 1)]);

/** Upgrades (kit/mechanics/loot): {damage, speed (times × speed), knock, reach (+m), dashCd (× cooldown)}; 1 / 0 when none. */
export const NO_MODS = Object.freeze({ damage: 1, speed: 1, knock: 1, reach: 0, dashCd: 1 });

/** The move as it plays for a weapon and a player's upgrades: rarity and upgrades applied. */
export function resolveMove(W, key, mods = NO_MODS) {
  const m = baseMove(W, key), k = { ...NO_MODS, ...(mods ?? {}) }, sp = clamp(num(k.speed, 1), 0.4, 1.5);
  return {
    ...m, key,
    windup: m.windup * sp, active: m.active * sp, recover: m.recover * sp,
    damage: Math.round(m.damage * (1 + RARITY_STEP * (W.rarity ?? 0)) * clamp(num(k.damage, 1), 0.2, 5) * 100) / 100,
    reach: m.reach + clamp(num(k.reach, 0), 0, 3), knockback: m.knockback * clamp(num(k.knock, 1), 0.2, 4),
  };
}

/** Hits to bring down `hp` with a weapon's light combo, repeated (a finisher on every last step). */
export function comboHitsToKill(W, hp, mods = NO_MODS) {
  let left = hp, n = 0;
  for (let i = 0; i < 200 && left > 1e-9; i++) { left -= resolveMove(W, i % W.combo.length, mods).damage; n++; }
  return left > 1e-9 ? Infinity : n;
}

export const SWING_DEFAULTS = Object.freeze({
  comboWindow: 0.45,     // seconds after a swing in which the next press continues the combo
  buffer: 0.25,          // an early press is kept this long
  chainAt: 0.3,          // a buffered press chains once this share of the recover has passed (0: at once)
  holdRepeat: true,      // holding the button keeps swinging the combo
  dashTime: 0.2, dashIframes: 0.28, dashCooldown: 0.65, dashStrikeWindow: 0.18,
});

/** A player's swing state (the copy that owns the player keeps it). */
export function createSwing() {
  return { state: 'idle', t: 0, key: null, move: null, step: 0, comboT: 0, buffer: null, bufferT: 0, dashT: 0, dashCd: 0, iframes: 0, sinceDash: 9, serial: 0, dashSerial: 0, yaw: 0, dashYaw: 0, stopT: 0, hit: new Set() };
}

/** Freeze this swing's own timeline for `secs` (hit-stop: the attacker's swing only; the world never pauses). */
export function holdSwing(s, secs) { s.stopT = Math.max(s.stopT, secs); }

/**
 * One frame of a player's swings and dash. input: {light, heavy, dash (edges this frame), lightHeld, aimYaw, dashYaw}.
 * W: the weapon (normalised); mods: upgrades; o: SWING_DEFAULTS. Returns the frame's events, in order:
 *   {type: 'dash', yaw, serial}, {type: 'dash-end'}, {type: 'swing', key, move, serial, yaw}, {type: 'active', move, yaw},
 *   {type: 'recover'}, {type: 'end', key}
 */
export function stepSwing(s, input = {}, dt, W, mods = NO_MODS, o = SWING_DEFAULTS) {
  const ev = [], k = { ...NO_MODS, ...(mods ?? {}) };
  const real = Math.max(0, dt);
  const frozen = s.stopT > 0; s.stopT = Math.max(0, s.stopT - real);
  const t = frozen ? 0 : real;                       // the swing's own clock stops during hit-stop
  s.comboT = Math.max(0, s.comboT - real); s.dashCd = Math.max(0, s.dashCd - real); s.iframes = Math.max(0, s.iframes - real);
  s.sinceDash += real; s.bufferT = Math.max(0, s.bufferT - real); if (s.bufferT <= 0) s.buffer = null;
  if (input.light) { s.buffer = 'light'; s.bufferT = o.buffer; }
  if (input.heavy) { s.buffer = 'heavy'; s.bufferT = o.buffer; }
  const wantsLight = s.buffer === 'light' || (o.holdRepeat && input.lightHeld);
  const start = key => {
    const move = resolveMove(W, key, k);
    s.state = 'windup'; s.t = 0; s.key = key; s.move = move; s.serial++; s.hit.clear(); s.buffer = null; s.bufferT = 0;
    if (typeof input.aimYaw === 'number') s.yaw = input.aimYaw;
    if (key === 'h' || key === 'd') s.step = 0; else s.step = (Number(key) + 1) % W.combo.length;
    ev.push({ type: 'swing', key, move, serial: s.serial, yaw: s.yaw });
  };
  const nextLight = () => (s.sinceDash < o.dashStrikeWindow ? 'd' : s.comboT > 0 || s.state === 'recover' ? s.step : 0);

  // the dash: cancels a windup or a recovery, never the active frames
  if (input.dash && s.dashCd <= 0 && s.state !== 'active' && s.state !== 'dash') {
    if (s.state === 'windup' || s.state === 'recover') ev.push({ type: 'end', key: s.key, cancelled: true });
    s.state = 'dash'; s.t = 0; s.dashT = 0; s.dashSerial++; s.dashYaw = typeof input.dashYaw === 'number' ? input.dashYaw : s.yaw;
    s.dashCd = o.dashCooldown * clamp(num(k.dashCd, 1), 0.2, 3); s.iframes = Math.max(s.iframes, o.dashIframes); s.step = 0; s.comboT = 0; s.stopT = 0;
    ev.push({ type: 'dash', yaw: s.dashYaw, serial: s.dashSerial });
  }
  switch (s.state) {
    case 'idle':
      if (s.buffer === 'heavy') start('h');
      else if (wantsLight) start(nextLight());
      break;
    case 'dash':
      s.t += real; s.dashT += real;
      if (wantsLight && s.t >= 0.05 && s.buffer === 'light') { s.sinceDash = 0; start('d'); break; }
      if (s.t >= o.dashTime) { s.state = 'idle'; s.t = 0; s.sinceDash = 0; ev.push({ type: 'dash-end' }); }
      break;
    case 'windup':
      if (typeof input.aimYaw === 'number') s.yaw = input.aimYaw;      // the swing follows the aim until it lands
      s.t += t;
      if (s.t >= s.move.windup) { s.state = 'active'; s.t -= s.move.windup; ev.push({ type: 'active', move: s.move, yaw: s.yaw }); }
      break;
    case 'active':
      s.t += t;
      if (s.t >= s.move.active) { s.state = 'recover'; s.t -= s.move.active; ev.push({ type: 'recover' }); }
      break;
    case 'recover': {
      s.t += t;
      const chainOk = s.t >= s.move.recover * o.chainAt && !frozen;
      if (chainOk && s.buffer === 'heavy' && s.key !== 'h') { ev.push({ type: 'end', key: s.key }); start('h'); break; }
      if (chainOk && wantsLight && s.key !== 'h' && s.key !== 'd' && s.step !== 0) { ev.push({ type: 'end', key: s.key }); start(s.step); break; }
      if (s.t >= s.move.recover) {
        ev.push({ type: 'end', key: s.key });
        const finished = s.key === 'h' || s.key === 'd' || s.step === 0;
        s.state = 'idle'; s.t = 0; s.comboT = finished ? 0 : o.comboWindow;
        if (finished) s.step = 0;
      }
      break;
    }
  }
  return ev;
}

/** The share of an active swing done (0..1), for the trail. */
export const activeShare = s => (s.state === 'active' && s.move ? clamp(s.t / Math.max(1e-6, s.move.active), 0, 1) : s.state === 'recover' ? 1 : 0);

const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));
/** yaw (radians, three.js: forward = (sin yaw, 0, cos yaw)) from (x, z) toward (tx, tz). */
export const yawTo = (x, z, tx, tz) => Math.atan2(tx - x, tz - z);

/**
 * Who a swing hits: targets [{id, x, z, radius}] inside the arc (degrees) and reach of a swing from (x, z) facing yaw.
 * The arc widens by each target's own size (buddy-rollback hitArc), and anything at point-blank range counts.
 * → [{id, d, angle (rad off the swing's middle)}] nearest first
 */
export function arcHits(origin, yaw, move, targets = []) {
  const out = [], half = (move.arc ?? 110) * DEG / 2;
  for (const t of targets) {
    const r = t.radius ?? 0.45, dx = t.x - origin.x, dz = t.z - origin.z, d = Math.hypot(dx, dz);
    if (d > (move.reach ?? 2) + r) continue;
    const ang = Math.abs(wrap(Math.atan2(dx, dz) - yaw));
    if (ang > half + Math.atan2(r, Math.max(d, 0.1)) && d > r + 0.4) continue;
    out.push({ id: t.id, d, angle: ang, target: t });
  }
  return out.sort((a, b) => a.d - b.d);
}

/**
 * Does a guard block a hit? A shielded enemy facing `facing` (yaw) blocks a swing that comes from in front of it,
 * within blockArc degrees, unless the move breaks guards (heavy) or the guard is down. from: the attacker's (x, z).
 */
export function blocks({ x, z, facing, blockArc = 120, guardDown = false }, from, move = {}) {
  if (guardDown || move.guardBreak) return false;
  const toAttacker = Math.atan2(from.x - x, from.z - z);
  return Math.abs(wrap(toAttacker - facing)) <= (blockArc * DEG) / 2;
}

/**
 * The host's check on a hit a player's copy reports: the target near enough to the attacker (where the host has both:
 * the attacker's pose is up to a few frames old), within reach + its radius + slack. → true when it counts
 */
export function plausibleHit(attacker, target, move, slack = 1.6) {
  const d = Math.hypot(target.x - attacker.x, target.z - attacker.z);
  return d <= (move.reach ?? 2) + (target.radius ?? 0.45) + slack;
}

/**
 * The ribbon of a slash trail as it grows: from the swing's start angle to where the blade is now. share: 0..1 of the
 * active frames. sweep 1: right to left (seen from behind), -1: left to right, 0: a thrust (a narrow wedge that
 * lengthens). → {a0, a1 (radians, relative to the swing's yaw), inner, outer}
 */
export function trailSpan(move, share) {
  const half = Math.min(Math.PI, (move.arc * DEG) / 2), s = clamp(share, 0, 1);
  if (move.sweep === 0) { const w = Math.max(0.12, half); return { a0: -w, a1: w, inner: 0.35, outer: 0.6 + (move.reach - 0.6) * s }; }
  const from = move.sweep > 0 ? half : -half, to = -from;
  const head = from + (to - from) * s, tail = from + (to - from) * Math.max(0, s - 0.55);
  return { a0: Math.min(head, tail), a1: Math.max(head, tail), inner: Math.max(0.4, move.reach * 0.5), outer: move.reach };
}

/** Upgrade cards between levels (kit/mechanics/loot offers them; melee applies them). id → what it changes. */
export const UPGRADES = Object.freeze({
  sharper: { name: 'Sharper edge', text: '+25% damage', mods: { damage: 1.25 } },
  quicker: { name: 'Quick hands', text: 'Swings 15% faster', mods: { speed: 0.85 } },
  fleet: { name: 'Fleet foot', text: 'Dash recharges 30% sooner', mods: { dashCd: 0.7 } },
  reach: { name: 'Long arm', text: '+0.4 m reach', mods: { reach: 0.4 } },
  heavy: { name: 'Heavy hand', text: '+40% knockback', mods: { knock: 1.4 } },
  mend: { name: 'Second wind', text: 'Heal to full now', heal: true },
});
/** A player's mods from the upgrade ids they picked (multiplicative; reach adds). */
export function modsOf(ids = []) {
  const m = { ...NO_MODS };
  for (const id of ids) {
    const u = UPGRADES[id]?.mods; if (!u) continue;
    if (u.damage) m.damage *= u.damage; if (u.speed) m.speed *= u.speed; if (u.knock) m.knock *= u.knock;
    if (u.reach) m.reach += u.reach; if (u.dashCd) m.dashCd *= u.dashCd;
  }
  m.speed = Math.max(0.5, m.speed); m.dashCd = Math.max(0.3, m.dashCd);
  return m;
}
