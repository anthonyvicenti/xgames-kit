// Simulated time for a check's page (CONTRACT §5, kit/core/step.js). A check that used to sleep now asks its clock:
//
//   await prepareStepped(page);                      // before page.goto: the page-side helper (an init script)
//   await page.goto(stepUrl(`${url}?seed=7&bots=0`));  // the test flag ?gf-step=1
//   …wait for the lobby in real time (loading is the network's and the disk's, not the game's clock)…
//   const clock = await clockFor(page);              // stepped when the game's kit offers window.__game.step
//   await clock.wait(300);                           // 300 ms of the game's time, without waiting for them
//   const t = clock.now(); while (clock.now() - t < 1500) { …; await clock.pass(60); }
//
// On a stepped page time stands still between waits, so a slow screenshot or a loaded machine no longer eats into what
// the check measures (check 13 flaked three times under load on 2026-10-10 for exactly that). Real keys, clicks and
// mouse moves stay real: they are sent as before and the next stepped frame reads them.
// A game on a kit copy with no step (an older game, a forge game) gets the wall clock: the same calls sleep, and the
// check runs as it always did. `clock.stepped` says which; checks record it.
//
// The page's own test timers: verify's recorder (tools/lib/alive-check.mjs RECORDER) samples the observation with
// setInterval. On a stepped page an interval set by an init script (that is, by the harness, before any of the game's
// code runs) is driven by simulated time instead, so the recording still holds four samples per second of play. The
// game's and the kit's own timers are never touched: they are set after the init scripts, when setInterval is the
// browser's again.
const sleep = ms => new Promise(r => setTimeout(r, ms));

export const STEP_FLAG = 'gf-step=1';
/** The game's address with the test flag. */
export const stepUrl = url => `${url}${url.includes('?') ? '&' : '?'}${STEP_FLAG}`;

/** In the page, before any other init script: the stepping helper and, on a stepped page, the harness's intervals. */
export const STEP_PRE = () => {
  if (window.__gfStepT) return;
  const asked = new URLSearchParams(location.search).get('gf-step') === '1';
  const T = window.__gfStepT = { now: 0, timers: [], real: window.setInterval, asked };
  if (asked && window === window.top) window.setInterval = (fn, ms) => { T.timers.push({ fn, ms: Math.max(1, Number(ms) || 0), due: Math.max(1, Number(ms) || 0) }); return -T.timers.length; };
  const breathe = () => new Promise(r => { const c = new MessageChannel(); c.port1.onmessage = () => { c.port1.close(); r(); }; c.port2.postMessage(0); });
  // run `ms` of the game's time: in slices that end where a harness timer is due (at most CHUNK ms), drawing the last
  // frame only; every few slices the page breathes, so loads, promises and input events land as they would in play
  const CHUNK = 250;
  window.__gfStep = async ms => {
    const g = window.__game;
    if (typeof g?.step !== 'function') throw new Error('this page has no stepped time (window.__game.step)');
    let left = ms, n = 0, frames = 0;
    while (left > 1e-6) {
      let d = Math.min(left, CHUNK);
      for (const t of T.timers) d = Math.min(d, Math.max(1e-3, t.due - T.now));
      const last = left - d <= 1e-6;
      frames += g.step(d, { draw: last }).frames;
      T.now += d; left -= d;
      for (const t of T.timers) while (t.due <= T.now + 1e-6) { t.due += t.ms; try { t.fn(); } catch {} }
      if (!last && ++n % 4 === 0) await breathe();
    }
    return { frames, now: T.now, phase: g.phase };
  };
};
/** In the page, after the harness's init scripts: setInterval is the browser's again for everything the game loads. */
export const STEP_POST = () => { const T = window.__gfStepT; if (T && window.setInterval !== T.real) window.setInterval = T.real; };

/** Install the page-side helper on a page that has not navigated yet. Safe to call twice (the script guards itself). */
export async function prepareStepped(page) {
  await page.addInitScript(STEP_PRE);
  await page.addInitScript(STEP_POST);
}

/**
 * The clock of a page that has booted (window.__game is there). → {stepped, now(), wait(ms), pass(ms), until(fn, ms, what, every)}
 *   wait(ms)   let `ms` of the game's time go by (stepped: at once; else a real sleep)
 *   pass(ms)   between two real actions that already take time on the wall clock (a screenshot in a loop): stepped,
 *              the game's time moves by `ms`; on the wall clock, nothing more is waited
 *   now()      milliseconds: the game's time this clock has let by, or the wall clock
 *   until(fn, ms, what, every = 150)   poll fn until it returns something, for at most `ms` of this clock
 */
export async function clockFor(page, { real = false } = {}) {
  const can = !real && await page.evaluate(() => typeof window.__game?.step === 'function' && typeof window.__gfStep === 'function').catch(() => false);
  if (!can) return wallClock();
  let t = 0;
  const wait = async ms => { if (!(ms > 0)) return; await page.evaluate(m => window.__gfStep(m), ms); t += ms; };
  const clock = { stepped: true, now: () => t, wait, pass: wait };
  clock.until = untilOn(clock);
  return clock;
}

/** The wall clock, with the same calls. */
export function wallClock() {
  const clock = { stepped: false, now: () => Date.now(), wait: ms => (ms > 0 ? sleep(ms) : Promise.resolve()), pass: async () => {} };
  clock.until = untilOn(clock);
  return clock;
}

const untilOn = clock => async (fn, ms, what, every = 150) => {
  const t0 = clock.now();
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (clock.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await clock.wait(every);
  }
};

/**
 * After the click that takes the mouse: the pointer lock is the browser's and lands in real time, whatever the page's
 * clock. Wait (on the wall clock, at most `ms`) until the game has the mouse, was refused it (a post's frame), or uses
 * the cursor itself (the follow camera). On the wall clock the checks' own waits covered this; on a stepped page the
 * next button press could arrive first and only ask for the lock again. → true when the mouse is settled
 */
export async function mouseTaken(page, ms = 1500) {
  const t0 = Date.now();
  for (;;) {
    const ok = await page.evaluate(() => { const c = window.__game?.camera?.(); return !c || !!(c.locked || c.lockRefused || c.cursorMode || document.pointerLockElement); }).catch(() => true);
    if (ok || Date.now() - t0 > ms) return ok;
    await sleep(40);
  }
}
