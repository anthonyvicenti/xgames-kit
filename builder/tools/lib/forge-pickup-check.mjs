// verify measure 15's pickup leg on forge (gate C, the loop is alive). Measure 15 reads every page's recording, and a
// pickup is alive when a spot is taken on any of them (alive-check.mjs: shared.pk.p, state 1 → 0). On a three game the
// controls page walks to a pickup and presses E; on forge no page ever walked to one (the solo round's player stands
// still, the controls page tests the forge keys), so a forge game with pickups failed 15 on that alone (godot-phone
// stream, 2026-10-13, when forge gained the shared pickup mechanic).
//
// So, on a recorded page alone (?gf-gate=1: the rules end no round): the player faces the nearest spot (forge.face, the
// QA turn the other forge legs use) and walks to it on real keys (W), up to SECONDS, until a spot is taken. Its
// recording goes to measure 15 with the others; the leg's own verdict is only said, measure 15 judges.
import { POINTER_LOCK } from './forge-feel-check.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
export const FORGE_PICKUP_LIMITS = { SECONDS: 20, STEP_MS: 260 };

/** Does this game have pickups for a player to take? (config/game.json mechanics) */
export const hasPickups = game => (game.mechanics ?? []).some(m => m.id === 'pickup');

/** → {ran, taken, detail, record} */
export async function takeForgePickup({ newPage, url, game, log = () => {}, L = FORGE_PICKUP_LIMITS }) {
  if (!hasPickups(game)) return { ran: false, taken: false, detail: 'no pickup mechanic', record: null };
  const record = { steps: 0, spots: null, taken: null, seconds: 0 };
  const T = await newPage('a pickup, walked to', { record: true, overrides: { patches: [{ file: 'config/game.json', pointer: '/round/seconds', value: 300 }] } });
  const p = T.page, t0 = Date.now();
  const read = () => p.evaluate(() => { const s = window.__game?.snapshot?.(); const me = s?.players?.find(x => x.local); return s && me ? { me: [me.x, me.y, me.z], spots: s.shared?.pk?.p ?? [], phase: s.phase } : null; }).catch(() => null);
  try {
    await p.addInitScript(POINTER_LOCK);
    await p.goto(`${url}?seed=7&bots=0&gf-gate=1`, { waitUntil: 'load' });
    for (let t = Date.now(); (await p.evaluate(() => window.__game?.phase ?? null).catch(() => null)) !== 'lobby'; ) { if (Date.now() - t > 90000) throw new Error('no lobby in 90 s'); await sleep(200); }
    await p.click('#gf-play');
    for (let t = Date.now(); (await p.evaluate(() => window.__game?.phase ?? null).catch(() => null)) !== 'playing'; ) { if (Date.now() - t > 20000) throw new Error('the round did not start'); await sleep(120); }
    await p.mouse.click(640, 360);
    for (let t = Date.now(); Date.now() - t < L.SECONDS * 1000; ) {
      const o = await read();
      if (!o) { await sleep(200); continue; }
      record.spots ??= o.spots.length;
      const there = o.spots.map((q, i) => ({ i, x: q[0], y: q[1], z: q[2], up: q[3] === 1, d: Math.hypot(q[0] - o.me[0], q[2] - o.me[2]) })).filter(q => q.up).sort((a, b) => a.d - b.d);
      if (record.taken === null && o.spots.some(q => q[3] !== 1)) { record.taken = (Date.now() - t0) / 1000; break; }
      if (!there.length) { await sleep(200); continue; }
      const q = there[0];
      await p.evaluate(([x, y, z]) => window.__game?.forge?.face?.(x, y + 0.4, z), [q.x, q.y, q.z]).catch(() => {});
      await p.keyboard.down('KeyW'); await sleep(L.STEP_MS); await p.keyboard.up('KeyW'); await sleep(60);
      record.steps++;
    }
    await sleep(400);   // a sample or two of the recording after the take
  } catch (e) { record.error = e.message; }
  finally { record.seconds = Math.round((Date.now() - t0) / 1000); await T.ctx.close().catch(() => {}); }
  const taken = record.taken !== null;
  const detail = taken ? `walked to a pickup on real keys and took it ${record.taken.toFixed(1)} s in (${record.steps} steps)` : record.error ? `the pickup page stopped: ${record.error}` : `walked toward the nearest pickup for ${L.SECONDS} s (${record.steps} steps, ${record.spots ?? 0} spots) and took none`;
  log(`  pickup leg: ${detail}`);
  return { ran: true, taken, detail, record };
}
