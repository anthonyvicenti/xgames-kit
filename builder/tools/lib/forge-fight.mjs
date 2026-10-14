// A new player's eyes and hand in a first-person fight (a forge game), for scripts that cannot see the screen:
// tools/play.mjs's "fight" step (the play-tester) and verify check 15's forge leg (lib/forge-first-wave-check.mjs).
//
// Why (the frozen forge case, 2026-10-11, gf-forge/evidence/eval-t6-full-2026-10-11): a play-tester whose
// scripts could only fire straight ahead killed nothing in three rounds, called every fight unwinnable, and two repair
// rounds diluted the game for it. Measured on Bone Vigil: with no up or down aim 20 of 68 rounds land; aimed at the
// chest, 55 of 69.
//
// One beat: the nearest living enemy inside the view (within `view` of where the player looks; the picture is about
// 100° wide at 16:9) → turn to its body (`body` of its height: the chest), off by about `off` each way as a hand is (a
// degree and a half, one standard deviation: at 10 m about two rounds in three land on a body), and fire one
// round; a new enemy is looked at for `react` first; none in view → a look-around step of `sweep`. It reads only what
// the screen shows a player (the enemies in front of the camera, window.__game.forge.enemies and camera) and turns with the
// core's own look (window.__game.forge.face, QA: as play.mjs's "face"). No walls are asked about: an enemy behind one
// is turned to and shot at, as a new player would.
//
// THE HAND RUNS IN THE PAGE, on the page's own frames and clock, and presses the fire button there (mouse events on
// the game's canvas, which the kit's input hears as it hears a mouse). The first cut ran each beat from Node: on a
// loaded machine every beat's round trips took longer, the hand fired fewer rounds a second while the game ran on, and
// Bone Vigil's first wave felled it in one corpus run and not in the next (2026-10-11: forge-vigil FLAKY on check 15).
// Node now only starts the hand, holds any walk keys, and looks in on it; how often it looks changes nothing the hand
// does.
const sleep = ms => new Promise(r => setTimeout(r, ms));
const RAD = Math.PI / 180;
export const FIGHT = { beat: 330, react: 250, off: 1.5 * RAD, view: 46 * RAD, sweep: 55 * RAD, body: 0.62 };

/** In the page: start the hand for `seconds`. It keeps its count in window.__gfHand until told to stop or the round ends. */
const START = ({ seconds, seed, L }) => {
  const g = window.__game, F = g?.forge, dom = document.getElementById('gf-canvas') || document.querySelector('canvas');
  if (window.__gfHand && !window.__gfHand.done) window.__gfHand.stop = true;       // one hand at a time
  const H = window.__gfHand = { shots: 0, lookedAround: 0, firedAt: 0, fell: 0, gone: 0, cannot: false, done: false, stop: false, ended: null, t0: performance.now(), firstAlive: null, firstGone: null };
  if (typeof F?.enemies !== 'function' || typeof F?.face !== 'function' || typeof g?.camera !== 'function' || !dom) { H.cannot = true; H.done = true; return; }
  let s = (0x9e3779b9 ^ seed) | 0;
  const rnd = () => { s = (s + 0x6d2b79f5) | 0; let x = Math.imul(s ^ (s >>> 15), 1 | s); x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x; return ((x ^ (x >>> 14)) >>> 0) / 4294967296; };
  const gauss = () => Math.sqrt(-2 * Math.log(1 - rnd())) * Math.cos(2 * Math.PI * rnd());
  const mouse = type => dom.dispatchEvent(new MouseEvent(type, { button: 0, buttons: type === 'mousedown' ? 1 : 0, bubbles: true, cancelable: true, clientX: Math.round(innerWidth / 2), clientY: Math.round(innerHeight / 2) }));
  const seen = new Set(), open = new Set(), living = new Set();
  let last = null, nextAt = 0, down = 0;                                // presses not yet let go
  const finish = why => { while (down > 0) { mouse('mouseup'); down--; } H.ended = why; H.firedAt = seen.size; H.done = true; };
  const count = alive => {
    // an enemy that was alive and is no longer fell (only while the round runs: its end clears them all)
    for (const n of [...open]) if (!alive.includes(n)) { open.delete(n); H.fell++; }
    for (const n of [...living]) if (!alive.includes(n)) { living.delete(n); H.gone++; if (H.firstGone === null) H.firstGone = performance.now(); }
    for (const n of alive) living.add(n);
    if (alive.length && H.firstAlive === null) H.firstAlive = performance.now();
  };
  const tick = () => {
    const now = performance.now();
    let c = null, alive = [];
    try { c = g.camera(); alive = g.forge.enemies().filter(e => !e.dead); } catch { return finish('the game stopped answering'); }
    if (g.phase === 'playing') count(alive.map(e => e.net)); else return finish(`the round is over (${g.phase})`);
    if (H.stop) return finish('stopped');
    if (now - H.t0 >= seconds * 1000) return finish('time');
    if (now >= nextAt && Array.isArray(c?.eye)) {
      const [ex, ey, ez] = c.eye, yaw = (c.yaw ?? 0) + Math.PI;        // the kit's yaw faces +Z, the core's look −Z
      const turn = (x, z) => { let d = Math.atan2(-(x - ex), -(z - ez)) - yaw; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; };
      const front = alive.map(e => ({ e, d: Math.hypot(e.at[0] - ex, e.at[2] - ez), a: turn(e.at[0], e.at[2]) })).filter(q => Math.abs(q.a) <= L.view && q.d > 0.2).sort((p, q) => p.d - q.d);
      if (!front.length) { const p = yaw + L.sweep; F.face(ex - Math.sin(p) * 5, ey, ez - Math.cos(p) * 5); H.lookedAround++; last = null; nextAt = now + L.beat; }
      else {
        // turn to it (a little off), whether it is new or not: a new one is turned to at once and fired at a moment
        // later, after a second, finer aim, as a hand flicks and then settles
        const q = front[0];
        let tall = 1.8; try { tall = (Number(F.value?.(`enemies.${q.e.typeId}.height`)) || 1.8) * (Number(F.value?.(`enemies.${q.e.typeId}.scale`)) || 1); } catch {}
        const y = Math.atan2(-(q.e.at[0] - ex), -(q.e.at[2] - ez)) + gauss() * L.off, p = Math.atan2(q.e.at[1] + tall * L.body - ey, q.d) + gauss() * L.off, far = Math.max(q.d, 1);
        F.face(ex - Math.sin(y) * Math.cos(p) * far, ey + Math.sin(p) * far, ez - Math.cos(y) * Math.cos(p) * far);
        if (q.e.net !== last) { last = q.e.net; nextAt = now + L.react; }
        else {
          seen.add(q.e.net); open.add(q.e.net); H.firedAt = seen.size;
          setTimeout(() => { if (H.done) return; mouse('mousedown'); down++; H.shots++; setTimeout(() => { if (down > 0) { mouse('mouseup'); down--; } }, 60); }, 70);
          nextAt = now + L.beat;
        }
      }
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
};

/** In the page: the hand's count now. */
const LOOK = () => { const H = window.__gfHand; return H ? { shots: H.shots, lookedAround: H.lookedAround, firedAt: H.firedAt, fell: H.fell, gone: H.gone, cannot: H.cannot, done: H.done, ended: H.ended, t0: H.t0, firstAlive: H.firstAlive, firstGone: H.firstGone, now: performance.now() } : null; };

/**
 * Fight for `seconds`, or until `until(did)` (asked each time Node looks in) answers something. io: {frame() → a page
 * or frame, down(key), up(key)}. keys: held meanwhile (a walk; real keys). seed: the hand's own dice.
 * → {shots, lookedAround, firedAt (enemies), fell (of those, while the round ran), gone (every enemy that was alive
 * and is no longer, mine or not, while the round ran: the count a wave's size is held to), cannot (no fight to have),
 * stopped (what until() answered), ended (why the hand stopped), ms: {first, kill} (page time from the hand's start
 * to the first enemy alive and to the first one gone, or null)}
 */
export async function fightFor(io, { seconds, keys = [], seed = 1, until = null, L = FIGHT, every = 200 } = {}) {
  const did = { shots: 0, lookedAround: 0, firedAt: 0, fell: 0, gone: 0, cannot: false, stopped: null, ended: null, ms: { first: null, kill: null } };
  const take = h => { if (!h) return; Object.assign(did, { shots: h.shots, lookedAround: h.lookedAround, firedAt: h.firedAt, fell: h.fell, gone: h.gone, cannot: h.cannot, ended: h.ended }); did.ms = { first: h.firstAlive === null ? null : h.firstAlive - h.t0, kill: h.firstGone === null ? null : h.firstGone - h.t0, now: h.now - h.t0 }; };
  for (const k of keys) await io.down(k);
  try {
    await io.frame().evaluate(START, { seconds, seed, L });
    const giveUp = Date.now() + (seconds + 30) * 1000;                       // the page's clock decides; this is for a page that died
    for (;;) {
      const h = await io.frame().evaluate(LOOK).catch(() => null);
      if (!h) break;                                                         // the game left the page
      take(h);
      if (h.done) break;
      if (until) { const u = await until(did); if (u) { did.stopped = u; await io.frame().evaluate(() => { if (window.__gfHand) window.__gfHand.stop = true; }).catch(() => {}); } }
      if (Date.now() > giveUp) { await io.frame().evaluate(() => { if (window.__gfHand) window.__gfHand.stop = true; }).catch(() => {}); break; }
      await sleep(every);
    }
    for (let i = 0; i < 20; i++) { const h = await io.frame().evaluate(LOOK).catch(() => null); if (!h) break; take(h); if (h.done) break; await sleep(50); }
    if (until && !did.stopped) { const u = await until(did); if (u) did.stopped = u; }     // the hand stopped by itself (time, the round's end): one last look
  } finally { for (const k of [...keys].reverse()) await io.up(k).catch(() => {}); }
  return did;
}
