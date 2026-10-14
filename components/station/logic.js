// station: the pure logic (no three.js, no DOM): one station's task state machine and the quota.
// Node tests: research/gf-three/tests/k2-station.test.mjs.

/**
 * One station. mode 'hold': keep the action held for taskSeconds; 'tap': press it `taps` times; 'stand': just stay
 * in range for taskSeconds. Only one player works a station at a time (the first to claim it). After a finished task
 * the station cools down for `cooldown` seconds. Every call returns the events it caused: 'start', 'cancel', 'done',
 * 'ready' (the cooldown ended).
 */
export function createStation({ mode = 'hold', taskSeconds = 3, taps = 8, cooldown = 2, keepProgress = false } = {}) {
  const s = { state: 'idle', who: null, progress: 0, held: false, cool: 0, tapCount: 0 };
  const finish = () => { s.state = 'cool'; s.cool = cooldown; const who = s.who; s.who = null; s.held = false; s.progress = 0; s.tapCount = 0; return who; };
  return Object.assign(s, {
    /** `who` starts (hold/stand) or restarts the task. */
    claim(who) {
      if (s.state === 'idle') { s.state = 'busy'; s.who = who; s.held = true; return ['start']; }
      if (s.state === 'busy' && s.who === who) { s.held = true; return []; }
      return [];
    },
    /** `who` lets go (hold mode) or walks away: the task is dropped unless keepProgress. */
    release(who) {
      if (s.state !== 'busy' || s.who !== who) return [];
      if (mode === 'hold' && keepProgress && s.progress > 0) { s.held = false; return []; }
      s.state = 'idle'; s.who = null; s.held = false; s.progress = 0; s.tapCount = 0; return ['cancel'];
    },
    /** A press in tap mode: claims an idle station with the first tap. */
    tap(who) {
      const ev = [];
      if (s.state === 'idle') { s.state = 'busy'; s.who = who; ev.push('start'); }
      if (s.state === 'busy' && s.who === who && mode === 'tap') {
        s.tapCount++; s.progress = Math.min(1, s.tapCount / taps);
        if (s.progress >= 1) { s.progress = 1; ev.push('done'); s.lastWho = finish(); }
      }
      return ev;
    },
    /** Advance time. `inRange`: the working player is still in range (and alive). */
    tick(dt, inRange = true) {
      const ev = [];
      if (s.state === 'cool') { s.cool -= dt; if (s.cool <= 0) { s.cool = 0; s.state = 'idle'; ev.push('ready'); } return ev; }
      if (s.state !== 'busy') return ev;
      if (!inRange) return s.release(s.who);
      if (mode === 'hold' || mode === 'stand') {
        if (mode === 'stand' || s.held) s.progress = Math.min(1, s.progress + dt / Math.max(0.05, taskSeconds));
        if (s.progress >= 1) { ev.push('done'); s.lastWho = finish(); }
      }
      return ev;
    },
    reset() { Object.assign(s, { state: 'idle', who: null, progress: 0, held: false, cool: 0, tapCount: 0 }); },
  });
}

/** The quota: how many tasks are done of how many needed (0 = no quota). */
export function createQuota(needed = 0) {
  const q = { done: 0, needed, add(n = 1) { q.done += n; return q.met; }, reset() { q.done = 0; } };
  Object.defineProperty(q, 'met', { get: () => q.needed > 0 && q.done >= q.needed, enumerable: true });
  return q;
}

/** The nearest station within `range` of (x, z). stations: [{x, z}] → {index, dist} | null */
export function nearestStation(stations, x, z, range) {
  let best = null;
  stations.forEach((s, index) => { const dist = Math.hypot(s.x - x, s.z - z); if (dist <= range && (!best || dist < best.dist)) best = { index, dist }; });
  return best;
}

/** The text lines for a screen from a station's wire state. s: {state, progress 0..1, cool (s), who (name)} */
export function screenLines(s, { title = 'Station', idleText = 'Press E to start', busyText = 'In use by {name}', doneText = 'Done!', mineText = 'Working... {pct}%', quota = null, name = '', mine = false } = {}) {
  const pct = Math.round((s.progress ?? 0) * 100);
  const lines = [];
  if (s.state === 'idle') lines.push(idleText);
  else if (s.state === 'busy') lines.push((mine ? mineText : busyText).replace('{pct}', pct).replace('{name}', name));
  else lines.push(doneText);
  if (quota && quota.needed > 0) lines.push(`${quota.label ?? 'Done'} ${quota.done}/${quota.needed}`);
  return { title, lines, bar: s.state === 'busy' ? s.progress : s.state === 'cool' ? 1 : 0 };
}
