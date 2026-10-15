// The scripted player of the play judge (builder/play/JUDGE.md): a new player's hand on real keys and the mouse. It
// goes for the nearest objective it has not given up on, turns to a rival in range and uses the main action on them,
// presses interact near something, clicks what a board offers, jumps when it is stuck, and wanders when nothing is
// near. It reads what the game's observation says (the play feed's objectives, the players, the camera, the points a
// part offers): the same things a player's screen shows. What it could not get to, and why, is the judge's evidence
// that an objective is out of a player's reach.
//
//   const a = createAgent({ controls });       // controls: config/game.json → controls (what the game's own keys are)
//   const act = a.decide(obs);                 // pure: obs (OBSERVE below) → {hold: [keys], look: dx, fire, tap: [keys], click}
//   await drive(page, act, held);              // the keys and the mouse, for real
//   a.report()                                 // {tried: [{id, reached, closest, seconds, why}], fired, presses, clicks}
const r2 = v => Math.round(v * 100) / 100;

export const AGENT_LIMITS = {
  PROGRESS_M: 0.5,      // closer by this to the objective counts as progress…
  STUCK_S: 3,           // …none for this long: jump
  GIVE_UP_S: 9,         // …none for this long: give it up (an objective a player cannot get to)
  RIVAL_M: 14,          // a rival within this is worth aiming at
  AIM_RAD: 0.3,         // fire when the camera points within this of the rival
  PX_PER_RAD: 380,      // mouse pixels a radian of turn takes at first (about 600 px a quarter turn), learnt as it plays
  TURN_MAX_PX: 160,     // the most the mouse moves in one step
  WANDER_TURN_S: 3,
};

/** In the page: what the scripted player reads (the play feed, the snapshot's players, the camera, a part's points). */
export const OBSERVE = () => {
  const g = window.__game; if (!g?.snapshot) return null;
  const s = g.snapshot(), cam = g.camera?.() ?? null, ctl = g.controls?.() ?? null, play = g.play?.() ?? null;
  const me = s.players?.find(p => p.id === s.me) ?? null;
  return {
    phase: s.phase, t: s.time?.now ?? 0, round: s.round, me, players: (s.players ?? []).filter(p => p.id !== s.me),
    cam: cam ? { dir: cam.dir, yaw: cam.yaw, cursor: !!cam.cursorMode } : null,
    points: (ctl?.points ?? []).slice(0, 24), interact: (ctl?.interactables ?? []).slice(0, 4),
    objectives: (play?.objectives ?? []).filter(o => o.open), aimed: !!ctl?.aimed, hasPlay: !!play,
    viewport: ctl?.viewport ?? { w: innerWidth, h: innerHeight },
  };
};

const ang = a => Math.atan2(Math.sin(a), Math.cos(a));

/**
 * The player's policy. controls: the game's controls (primary, interact, jump, …: the actions it has). A frame of
 * reference is learnt from the camera (forward on screen is where W goes); `frame` can be given (a calibration).
 */
export function createAgent({ controls = {}, limits = AGENT_LIMITS, rng = Math.random } = {}) {
  const L = limits;
  const can = { fire: !!controls.primary, interact: !!controls.interact, jump: controls.jump !== undefined ? !!controls.jump : true };
  // the game's own rows (controls.more: [keys, what, …]): a new player tries each now and then
  const own = keysOfRows(controls.more);
  let exploreAt = 0, holdClick = 0;
  const tried = new Map();        // objective id → {id, t0, best, bestAt, closest, reached, gaveUp, why, from}
  const given = new Set();
  let target = null, lastT = null, pxPerRad = L.PX_PER_RAD, lastLook = null, wanderAt = 0, wanderDx = 0, sign = -1, wrong = 0;
  let fired = 0, presses = 0, clicks = 0, jumps = 0;
  const frameOf = obs => {
    const d = obs.cam?.dir;
    if (!d || obs.cam.cursor) return null;
    const l = Math.hypot(d[0], d[2]);
    if (l < 0.2) return null;          // straight down: a top-down view, no forward to turn
    const F = [d[0] / l, d[2] / l];
    return { F, R: [-F[1], F[0]] };
  };
  const keysToward = (fr, dx, dz) => {
    const l = Math.hypot(dx, dz) || 1, ux = dx / l, uz = dz / l, keys = [];
    const f = fr ? ux * fr.F[0] + uz * fr.F[1] : -uz, r = fr ? ux * fr.R[0] + uz * fr.R[1] : ux;   // no camera: screen up is −z
    if (f > 0.38) keys.push('KeyW'); if (f < -0.38) keys.push('KeyS'); if (r > 0.38) keys.push('KeyD'); if (r < -0.38) keys.push('KeyA');
    return keys;
  };
  return {
    decide(obs) {
      const act = { hold: [], look: 0, fire: false, tap: [], click: null, note: '' };
      if (!obs || obs.phase !== 'playing' || !obs.me) return act;
      const t = obs.t, me = obs.me, fr = frameOf(obs);
      // what the last look did to the view: learn which way the mouse turns it and how many pixels a radian takes
      if (lastLook && fr && Math.abs(lastLook.dx) > 20) {
        const dh = ang(Math.atan2(fr.F[0], fr.F[1]) - lastLook.heading);
        if (Math.abs(dh) > 0.02) {
          if (Math.sign(dh) === Math.sign(lastLook.err)) { wrong = 0; pxPerRad = Math.max(60, Math.min(3000, 0.7 * pxPerRad + 0.3 * Math.abs(lastLook.dx) / Math.abs(dh))); }
          else if (++wrong >= 2) { sign = -sign; wrong = 0; }
        }
      }
      lastLook = null;
      if (me.alive === false) return act;
      // a board or a cursor game: click what the part offers now and then
      if (obs.points?.length && (lastT === null || t - lastT >= 0)) {
        if (rng() < 0.25) { const p = obs.points[Math.floor(rng() * obs.points.length)]; act.click = { x: p.x, y: p.y }; clicks++; act.note = 'click a point'; }
      }
      // the objective: the nearest open one not given up
      const open = (obs.objectives ?? []).filter(o => !given.has(o.id));
      if (target && !open.some(o => o.id === target)) {
        const tr = tried.get(target); if (tr && !tr.gaveUp) { tr.reached = tr.reached || tr.closest <= 2.5; tr.seconds = r2(t - tr.t0); tr.gone = true; }
        target = null;
      }
      if (!target && open.length) {
        const best = open.map(o => ({ o, d: Math.hypot(o.x - me.x, o.z - me.z) })).sort((a, b) => a.d - b.d)[0];
        target = best.o.id;
        if (!tried.has(target)) tried.set(target, { id: target, kind: best.o.kind, t0: t, best: best.d, bestAt: t, closest: best.d, reached: false, gaveUp: false, from: [r2(me.x), r2(me.z)], at: [best.o.x, best.o.y, best.o.z] });
        else { const tr = tried.get(target); tr.t0 = t; tr.bestAt = t; tr.best = best.d; }
      }
      let moving = false;
      if (target) {
        const o = open.find(x => x.id === target), tr = tried.get(target);
        const dx = o.x - me.x, dz = o.z - me.z, d = Math.hypot(dx, dz);
        tr.closest = Math.min(tr.closest, d);
        if (d < tr.best - L.PROGRESS_M) { tr.best = d; tr.bestAt = t; }
        if (d <= 1.0) { tr.reached = true; tr.seconds = r2(t - tr.t0); }
        const still = t - tr.bestAt;
        if (still > L.GIVE_UP_S && d > 1.2) {
          tr.gaveUp = true; tr.seconds = r2(t - tr.t0); tr.why = `no closer than ${r2(tr.closest)} m in ${L.GIVE_UP_S} s of trying`;
          given.add(target); target = null;
        } else {
          act.hold.push(...keysToward(fr, dx, dz)); moving = act.hold.length > 0;
          if (still > L.STUCK_S && can.jump && rng() < 0.35) { act.tap.push('Space'); jumps++; }
          if (can.interact && d <= 2.2) { act.tap.push('KeyE'); presses++; }
          act.note = `to ${target} (${r2(d)} m)`;
        }
      }
      // a rival in range: turn to them and use the main action
      const rivals = (obs.players ?? []).filter(p => p.alive !== false).map(p => ({ p, d: Math.hypot(p.x - me.x, p.z - me.z) })).filter(x => x.d <= L.RIVAL_M).sort((a, b) => a.d - b.d);
      if (rivals.length && fr) {
        const r = rivals[0].p, want = Math.atan2(r.x - me.x, r.z - me.z), have = Math.atan2(fr.F[0], fr.F[1]);
        const err = ang(want - have);
        // which way the mouse turns the view is learnt from what the view did (above)
        act.look = Math.max(-L.TURN_MAX_PX, Math.min(L.TURN_MAX_PX, Math.round(sign * err * pxPerRad)));
        if (Math.abs(act.look) < 3) act.look = 0;
        if (act.look) lastLook = { dx: act.look, heading: have, err };
        if (can.fire && Math.abs(err) < L.AIM_RAD) { act.fire = true; fired++; }
        if (!target) { act.hold.push(...keysToward(fr, r.x - me.x, r.z - me.z).filter(k => rivals[0].d > 5 || k !== 'KeyW')); moving = act.hold.length > 0; }
      } else if (rivals.length && can.fire && !fr) { act.fire = rng() < 0.5; if (act.fire) fired++; }
      // the game's own controls: one of them every few seconds (a click is held a moment: cast, charge, reel)
      if (own.length && t - exploreAt > 3) {
        exploreAt = t; const k = own[Math.floor(rng() * own.length)];
        if (k === 'Mouse') holdClick = t + 1.5; else { act.tap.push(k); presses++; }
      }
      if (t < holdClick) { act.fire = true; fired++; }
      // nothing to do: wander, turning now and then
      if (!moving && !act.click && !rivals.length) {
        if (t - wanderAt > L.WANDER_TURN_S) { wanderAt = t; wanderDx = Math.round((rng() - 0.5) * 300); }
        act.hold.push('KeyW'); if (fr) act.look = act.look || Math.round(wanderDx / 6);
        if (can.fire && rng() < 0.1) { act.fire = true; fired++; }
        act.note = act.note || 'wander';
      }
      lastT = t;
      return act;
    },
    report() {
      return { tried: [...tried.values()].map(({ id, kind, reached, gaveUp, closest, seconds, why, from, at, gone }) => ({ id, kind, reached: !!reached, gaveUp, closest: r2(closest), seconds: seconds ?? null, ...(why ? { why } : {}), ...(gone ? { gone: true } : {}), from, at })),
        fired, presses, clicks, jumps, pxPerRad: Math.round(pxPerRad), turnSign: sign };
    },
  };
}

/** The keys a game's own control rows name ("R", "Click", "E / F", "Space", "Q E"), as the browser knows them. */
export function keysOfRows(rows = []) {
  const out = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    const text = String(Array.isArray(row) ? row[0] : row?.keys ?? '');
    for (const w of text.split(/[\s/,+]+/)) {
      if (/^click$|^mouse$|^lmb$/i.test(w)) out.add('Mouse');
      else if (/^[A-Z]$/i.test(w) && !'WASD'.includes(w.toUpperCase())) out.add(`Key${w.toUpperCase()}`);
      else if (/^space$/i.test(w)) out.add('Space');
      else if (/^[0-9]$/.test(w)) out.add(`Digit${w}`);
    }
  }
  return [...out];
}

/**
 * Apply one decision on a page: hold exactly `act.hold` (from `held`, a Set kept by the caller), look, fire, tap, click.
 * Turning: with the mouse taken the game reads the movement between mouse events; before the cursor would leave the
 * screen it goes back to the middle with the mouse let go and taken again (as builder/tools/play.mjs does).
 */
export async function drive(page, act, held, { mouse = { x: 640, y: 400 }, firing = { on: false }, width = 1280, frame = null } = {}) {
  const ev = frame ?? page;     // where the game is: the page, or its frame inside the friends page
  const want = new Set(act.hold);
  for (const k of [...held]) if (!want.has(k)) { await page.keyboard.up(k).catch(() => {}); held.delete(k); }
  for (const k of want) if (!held.has(k)) { await page.keyboard.down(k).catch(() => {}); held.add(k); }
  if (act.look) {
    if (mouse.x + act.look < 80 || mouse.x + act.look > width - 80) {
      if (firing.on) { await page.mouse.up().catch(() => {}); firing.on = false; }
      await ev.evaluate(() => document.exitPointerLock?.()).catch(() => {});
      mouse.x = width / 2; await page.mouse.move(mouse.x, mouse.y).catch(() => {});
      await ev.evaluate(() => document.getElementById('gf-canvas')?.requestPointerLock?.()).catch(() => {});
    }
    mouse.x += act.look; await page.mouse.move(mouse.x, mouse.y, { steps: 2 }).catch(() => {});
  }
  if (act.fire && !firing.on) { await page.mouse.down().catch(() => {}); firing.on = true; }
  else if (!act.fire && firing.on) { await page.mouse.up().catch(() => {}); firing.on = false; }
  for (const k of act.tap) await page.keyboard.press(k).catch(() => {});
  if (act.click) await page.mouse.click(act.click.x, act.click.y).catch(() => {});
}

/** Let every key and the mouse go. */
export async function release(page, held, firing = { on: false }) {
  for (const k of [...held]) await page.keyboard.up(k).catch(() => {});
  held.clear();
  if (firing.on) { await page.mouse.up().catch(() => {}); firing.on = false; }
}
