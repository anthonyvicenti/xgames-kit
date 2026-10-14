// A test player that takes its turn (open builder wave 8, track V; the creator's question 14).
//
// verify's solo player walked, jumped, pressed E once and then waited for the bell. In a game of turns that is a
// person who never plays: an untimed turn stays theirs for the whole round, so nothing moves and the checks that read
// the round (7 the sounds, 12 something happens, 15 the loop) judged an empty room. This player plays its own turn,
// and only from what a part says the player may do now:
//
//   window.__game.controls().points          things to point at and click, in CSS pixels (a board with a cursor)
//   window.__game.controls().interactables   things to walk to and press (a board you walk on: your legal cells)
//
// and only the entries a part marks `turn: true` (its own word for "this is your move"); a pickup or a station is not
// a turn and is left to check 13. A game whose rules alone take the move (no part lists anything) is not played: the
// flow's clock or its rules.turnTimeout plays for the idle person, as before, and the record says so. Nothing is
// passed by this file: it only presses what a player would press, with the real mouse and keys.
const sleep = ms => new Promise(r => setTimeout(r, ms));
const CONTROLS = () => { try { const g = window.__game; return g?.phase === 'playing' ? g.controls?.() ?? null : null; } catch { return null; } };
const KEY = { interact: 'KeyE', jump: 'Space' };

/** What the page says the local player may do now as their turn: {points, walk, me, viewport}. */
export async function turnItems(page) {
  const c = await page.evaluate(CONTROLS).catch(() => null);
  return { points: (c?.points ?? []).filter(x => x.turn), walk: (c?.interactables ?? []).filter(x => x.turn), me: c?.me ?? null, viewport: c?.viewport ?? null };
}

/**
 * A player for one page. → { step(), idle(ms), record }
 * step(): when it is the local player's turn and a part lists something, do one thing (a click on a point, or a walk
 * to a cell and its key) → what it did, or null. idle(ms): take turns for `ms`, sleeping while there is none.
 * record: { points, walked, tried, turns: [{how, id}] (the first 12), listed: did a part ever list a turn }.
 */
export function turnPlayer(page, { log = () => {}, seed = 7 } = {}) {
  const record = { points: 0, walked: 0, tried: 0, listed: false, turns: [] };
  let n = seed, dirs = null;
  const pick = list => list[(n = (n * 1103515245 + 12345) & 0x7fffffff) % list.length];
  const me = async () => (await page.evaluate(CONTROLS).catch(() => null))?.me ?? null;
  // which way W and D move this player (the camera does not turn: the mouse stays where it is)
  const calibrate = async () => {
    const step = async k => { const a = await me(); await page.keyboard.down(k); await sleep(200); await page.keyboard.up(k); await sleep(260); const b = await me(); if (!a || !b) return null; const dx = b.x - a.x, dz = b.z - a.z, l = Math.hypot(dx, dz); return l > 0.05 ? [dx / l, dz / l] : null; };
    const f = await step('KeyW'), r = await step('KeyD');
    return f && r ? { f, r } : null;
  };
  async function point(it) {
    await page.mouse.move(it.x, it.y, { steps: 4 }); await sleep(140);
    await page.mouse.down(); await sleep(60); await page.mouse.up(); await sleep(320);
    record.points++; return { how: 'point', id: it.id };
  }
  async function walk(first) {
    dirs ??= await calibrate();
    if (!dirs) return null;
    const want = first.touch > 0 ? (first.touch + first.reach) / 2 : first.reach * 0.6, until = Date.now() + 9000;
    let best = Infinity, stall = 0, t = first;
    while (Date.now() < until) {
      const now = await turnItems(page), m = now.me;
      t = now.walk.find(x => x.id === first.id);
      if (!t || !m) return null;                                     // the turn went, or the round ended
      const dx = t.x - m.x, dz = t.z - m.z, d = Math.hypot(dx, dz);
      if (d <= want + 0.2) break;
      if (d < best - 0.15) { best = d; stall = 0; } else if (++stall > 6) { dirs = null; return null; }   // the camera turned, or something is in the way: calibrate again next time
      const ux = dx / d, uz = dz / d, pf = ux * dirs.f[0] + uz * dirs.f[1], pr = ux * dirs.r[0] + uz * dirs.r[1];
      const keys = []; if (pf > 0.38) keys.push('KeyW'); if (pf < -0.38) keys.push('KeyS'); if (pr > 0.38) keys.push('KeyD'); if (pr < -0.38) keys.push('KeyA');
      for (const k of keys) await page.keyboard.down(k);
      await sleep(Math.max(45, Math.min(220, Math.abs(d - want) * 85)));
      for (const k of keys) await page.keyboard.up(k);
      await sleep(160);
    }
    const k = KEY[t.action ?? 'interact'];
    if (k) await page.keyboard.press(k); else { await page.mouse.down(); await sleep(60); await page.mouse.up(); }
    await sleep(320);
    record.walked++; return { how: 'walk', id: t.id };
  }
  async function step() {
    const t = await turnItems(page);
    if (!t.points.length && !t.walk.length) return null;
    record.listed = true; record.tried++;
    let did = null;
    try { did = t.points.length ? await point(pick(t.points)) : await walk(pick(t.walk.slice(0, 4))); } catch { did = null; }
    if (did && record.turns.length < 12) record.turns.push(did);
    if (did) log(`  turn: ${did.how} ${did.id}`);
    return did;
  }
  async function idle(ms) { const end = Date.now() + ms; while (Date.now() < end) { if (!(await step())) await sleep(Math.min(250, Math.max(0, end - Date.now()))); } }
  return { step, idle, record };
}

/** One plain sentence of what the player did, for a check's detail and the verdict's notes. */
export function turnLine(record) {
  if (!record) return '';
  if (!record.listed) return 'the test player was offered no turn by any part (a game whose rules alone take the move is played by its clock)';
  return `the test player took its turn ${record.points + record.walked} time${record.points + record.walked === 1 ? '' : 's'} (${record.points} by pointing and clicking, ${record.walked} by walking to a cell and pressing)`;
}
