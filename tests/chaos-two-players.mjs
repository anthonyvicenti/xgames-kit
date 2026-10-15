// Physical chaos over real WebRTC: a host and a joiner in one room of a turn-based game with the aim, knockback and
// hazards mechanics (the example blast-isles, or any such game). They take turns with real input (the mouse turns the
// view, F held charges the power and its release fires); the host aims its blast just on the land side of the joiner, so
// the joiner is thrown into the sea. Both screens must agree: the same flight (path, landing, splash) for the thrown
// joiner, each screen drawing the joiner's body on it, the same fall into the water, the joiner back on dry ground.
//
//   node tests/chaos-two-players.mjs <game dir> [--shots <dir>] [--turns 8]
// Under the GPU wrapper on Linux: .claude/scripts/gpu-run.sh node tests/chaos-two-players.mjs ...
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isMain } from '../builder/lib/main.mjs';
import { serve } from '../builder/tools/serve.mjs';
import { launchChrome } from '../builder/qa/browser.mjs';
import { solveShot, weaponsOf } from '../components/aim/logic.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms, what) {
  const t0 = Date.now();
  for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`); await sleep(150); }
}
const party = page => page.evaluate(() => window.__party?.snapshot() ?? null).catch(() => null);
const gameFrame = page => page.frames().find(f => f.parentFrame() === page.mainFrame());
const inGame = (page, fn, arg) => gameFrame(page)?.evaluate(fn, arg).catch(() => null) ?? null;
const state = page => inGame(page, () => {
  const g = window.__game; if (!g) return null;
  const s = g.snapshot();
  return { you: s.me, phase: s.phase, started: !!s.net?.started, flow: s.flow, players: s.players, aim: g.mechanic('aim'), kb: g.mechanic('knockback'), hz: g.mechanic('hazards'), juice: s.juice };
});
// a recorder in each game page: every 50 ms, the knockback mechanic's flights as this copy draws them
const record = page => inGame(page, () => {
  if (window.__chaosLog) return true;
  window.__chaosLog = [];
  setInterval(() => { const k = window.__game?.mechanic('knockback'); if (k?.flying?.length) window.__chaosLog.push({ now: window.__game.snapshot().time.now, f: k.flying.map(f => ({ body: f.body, t: f.t, dur: f.dur, into: f.into, end: f.end, at: f.at })) }); }, 50);
  return true;
});
const logOf = page => inGame(page, () => window.__chaosLog ?? []);

export async function chaosTwoPlayers(dir, { shots = null, turns = 8, log = () => {} } = {}) {
  const game = JSON.parse(readFileSync(path.join(dir, 'config', 'game.json'), 'utf8'));
  const aimP = game.mechanics.find(m => m.id === 'aim')?.params ?? {};
  const weapons = weaponsOf(aimP.weapons ?? []), gravity = aimP.gravity ?? 18;
  const s = await serve(dir, { port: 0 });
  const browser = await launchChrome({ gpu: 'webgl', disableFeatures: ['WebRtcHideLocalIpsWithMdns'], args: ['--autoplay-policy=no-user-gesture-required'] });
  const errors = [], out = { ok: false, steps: [], turns: [] };
  const step = (name, ok, saw) => { out.steps.push({ name, ok: !!ok, saw }); log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${saw}`); };
  if (shots) mkdirSync(shots, { recursive: true });
  const open = async label => {
    const c = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await c.newPage();
    page.on('pageerror', e => errors.push(`${label}: ${e.message}`));
    page.on('console', m => { if (m.type() === 'error') errors.push(`${label}: ${m.text()}`); });
    return page;
  };
  let film = 0;
  const snap = async (H, J, tag) => { if (!shots) return; const n = String(film++).padStart(3, '0'); await Promise.all([H.screenshot({ path: path.join(shots, `${n}-host-${tag}.jpg`), type: 'jpeg', quality: 72 }), J.screenshot({ path: path.join(shots, `${n}-joiner-${tag}.jpg`), type: 'jpeg', quality: 72 })]); };
  try {
    const H = await open('host'), J = await open('joiner');
    await H.goto(s.partyUrl, { waitUntil: 'load' });
    await until(async () => (await party(H))?.phase === 'home', 20000, 'the host lobby');
    await H.fill('#gfp-name', 'Hosta'); await H.click('#gfp-host');
    await until(async () => { const p = await party(H); return p?.phase === 'room' && p.code ? p : null; }, 20000, 'the host to open a room');
    const invite = await H.inputValue('#mp-invite');
    await J.goto(invite, { waitUntil: 'load' });
    await until(async () => (await party(J))?.phase === 'home', 20000, 'the joiner lobby');
    await J.fill('#gfp-name', 'Joan'); await J.click('#gfp-join');
    await until(async () => (await party(H))?.racers?.length === 2 && (await party(J))?.racers?.length === 2, 30000, 'both players in the room');
    await H.click('#mp-start');
    await until(async () => (await state(H))?.started && (await state(J))?.started, 90000, 'the round to start on both');
    await until(async () => (await state(H))?.phase === 'playing', 30000, 'playing');
    await record(H); await record(J);
    // focus each page's canvas (pointer lock where the browser gives it): the mouse turns the view from here on
    for (const p of [H, J]) await gameFrame(p).locator('canvas').first().click({ position: { x: 640, y: 360 } }).catch(() => {});
    const s0 = [await state(H), await state(J)];
    const hostId = s0[0].you, joinId = s0[1].you;
    step('a turn game with two players, the host first', s0[0].flow?.id === 'turns' && s0[0].flow.order.length === 2 && s0[0].flow.turn === hostId, `order ${s0[0].flow?.order}, turn ${s0[0].flow?.turn}`);

    // aim with real input: turn the view (mouse) until the aim part's own yaw and elevation are the solved shot's
    const aimTo = async (page, want) => {
      let mx = 640, my = 360;
      for (let k = 0; k < 30; k++) {
        const a = (await state(page))?.aim?.me; if (!a) return false;
        let dy = ((a.yaw - want.yaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI, de = a.elevation - want.elevation;
        if (Math.abs(dy) < 0.01 && Math.abs(de) < 0.6) return true;
        mx += clampN(dy / 0.0026, -300, 300); my += clampN(de * Math.PI / 180 / 0.0026, -300, 300);
        await page.mouse.move(mx, my, { steps: 3 }); await sleep(120);
      }
      return true;
    };
    // charge with F held and watch the aim part's own trajectory preview: let go when its landing is nearest the target
    // (a player does the same by eye); the solved power is the fallback
    const fireAt = async (page, power, to) => {
      await page.keyboard.down('KeyF');
      let best = Infinity, t0 = Date.now(), got = null;
      for (;;) {
        const a = (await state(page))?.aim;
        if (a?.me?.charging && a.preview?.end) {
          const d = Math.hypot(a.preview.end.x - to.x, a.preview.end.z - to.z);
          if (d < best) { best = d; got = a.me.power; }
          if (d < 0.6 || d > best + 0.25 || a.me.power >= 0.995) break;
        }
        if (Date.now() - t0 > 8000) break;
      }
      await page.keyboard.up('KeyF');
      return { miss: best, power: got, solved: power };
    };
    // the shot from this page's player to a point
    const plan = async (page, to) => {
      const st = await state(page), a = st.aim.me, w = weapons.find(x => x.id === a.weapon) ?? weapons[0];
      const sol = solveShot(a.muzzle, to, { speed: w.speed, gravity: gravity * w.gravity, wind: { x: st.aim.wind.x * w.wind, z: st.aim.wind.z * w.wind }, minPower: 0.12, elevations: [20, 30, 40, 50, 58] });
      return sol;
    };
    // where to blast the joiner from: just on the land side of them, so the push goes toward the nearest water
    const blastSpot = async () => {
      return inGame(H, id => {
        const g = window.__game, me = g.snapshot().players.find(p => p.id === id);
        let best = null;
        for (let k = 0; k < 16; k++) {
          const a = (k / 16) * Math.PI * 2, dx = Math.sin(a), dz = Math.cos(a);
          for (let d = 1; d < 30; d += 0.5) { const y = g.terrainAt(me.x + dx * d, me.z + dz * d); if (y == null || y < 0.05) { if (!best || d < best.d) best = { d, dx, dz }; break; } }
        }
        return best ? { x: me.x - best.dx * 1.1, y: me.y + 0.3, z: me.z - best.dz * 1.1, edge: best.d, joiner: me } : null;
      }, joinId);
    };

    let thrownWater = null;
    for (let n = 0; n < turns && !(thrownWater && out.turns.some(t => t.who === 'joiner')); n++) {
      const sh = await until(async () => { const x = await state(H); return x?.flow?.turn && !x.aim.resolving && x.aim.shells === 0 ? x : null; }, 40000, 'a turn to start');
      const turnId = sh.flow.turn, page = turnId === hostId ? H : J, who = turnId === hostId ? 'host' : 'joiner';
      await until(async () => (await state(page))?.aim?.me?.may, 15000, `${who} may fire`);
      let to;
      if (who === 'host') { const b = await blastSpot(); to = b ? { x: b.x, y: b.y, z: b.z } : null; out.turns.push({ n, who, edge: b?.edge ?? null }); }
      else { const h = (await state(J)).players.find(p => p.id === hostId); to = { x: h.x + 2.5, y: h.y + 0.4, z: h.z + 2.5 }; out.turns.push({ n, who }); }
      if (!to) { step('a spot to blast from', false, 'none found'); break; }
      const sol = await plan(page, to);
      await aimTo(page, sol);
      await snap(H, J, `aim-${who}`);
      const fired0 = (await state(H)).aim.fired;
      const f = await fireAt(page, sol.power, to); out.turns.at(-1).fire = { ...f, miss: Math.round(f.miss * 100) / 100 };
      await until(async () => (await state(H))?.aim?.fired > fired0, 8000, `${who}'s shell`).catch(() => null);
      // film the shot and what it throws, on both screens
      for (let k = 0; k < 10; k++) { await sleep(320); await snap(H, J, `shot${n}-${who}`); }
      await until(async () => { const x = await state(H); return x && !x.aim.resolving && x.aim.shells === 0 && x.flow.turn !== turnId ? x : null; }, 30000, 'the turn to pass').catch(() => null);
      // what both screens hold for a few seconds after the turn (the fall, the way back)
      out.after = out.after ?? [];
      for (let k = 0; k < 8; k++) { const [a, b] = [await state(H), await state(J)]; out.after.push({ n, h: [a.phase, a.players.map(p => [p.id, p.x, p.y, p.z, p.alive, p.score]), a.hz.stats, a.kb.stats], j: [b.phase, b.players.map(p => [p.id, p.x, p.y, p.z, p.alive, p.score]), b.hz.stats, b.hz.out] }); await sleep(400); }
      const hzH = (await state(H)).hz, hzJ = (await state(J)).hz;
      if (!thrownWater && who === 'host' && hzH?.last?.player === joinId && hzH.last.cause === 'water') thrownWater = { host: hzH.last, joiner: hzJ?.last ?? null, n };
    }
    const [eH, eJ] = [await state(H), await state(J)];
    step('both took turns and fired with real input', (eH.aim.stats.fired ?? 0) >= 1 && out.turns.some(t => t.who === 'joiner') && eH.flow.moves >= 2, `${eH.aim.fired} shells, ${eH.flow.moves} turns played, ${eH.flow.passed} passed`);
    step('the camera followed a shot on both screens', (eH.juice.counts.follows ?? 0) > 0 && (eJ.juice.counts.follows ?? 0) > 0, `follows: host ${eH.juice.counts.follows}, joiner ${eJ.juice.counts.follows}`);
    step('the joiner, thrown by the host\'s blasts, ended in the sea', !!thrownWater, thrownWater ? `turn ${thrownWater.n}: ${JSON.stringify(thrownWater.host)}` : 'never');
    step('both screens saw the same fall into the water, by the host', !!thrownWater && thrownWater.joiner?.player === joinId && thrownWater.joiner.cause === 'water' && thrownWater.joiner.by === hostId, thrownWater ? `joiner's screen: ${JSON.stringify(thrownWater.joiner)}` : 'never');

    // the flight on both screens: the same path, each screen's body on it
    const [lH, lJ] = [await logOf(H), await logOf(J)];
    const key = `p:${joinId}`;
    // the joiner's flights as each screen recorded them, one per landing place (the last one: the throw before the fall)
    const all = l => l.flatMap(e => e.f.filter(f => f.body === key).map(f => ({ ...f, now: e.now })));
    const lastEnd = list => list.at(-1)?.end ?? null;
    const aH = all(lH), aJ = all(lJ), endH = lastEnd(aH), endJ = lastEnd(aJ);
    const same = (f, end) => end && f.end.join() === end.join();
    const fH = aH.filter(f => same(f, endH)), fJ = aJ.filter(f => same(f, endJ));
    out.flight = { into: fH.at(-1)?.into ?? null, end: endH, flights: { host: new Set(aH.map(f => f.end.join())).size, joiner: new Set(aJ.map(f => f.end.join())).size } };
    step('the same thrown flight on both screens (its landing)', !!endH && !!endJ && Math.hypot(endH[0] - endJ[0], endH[1] - endJ[1], endH[2] - endJ[2]) < 0.02, `host ${JSON.stringify(endH)}, joiner ${JSON.stringify(endJ)}; the flight ended: ${out.flight.into} (${out.flight.flights.host} flights of the joiner on the host)`);
    const off = list => list.filter(f => f.at?.body && !f.at.done && f.t > 0.5).map(f => Math.hypot(f.at.body.x - f.at.x, f.at.body.y - (f.at.y + f.at.lift), f.at.body.z - f.at.z));
    const med = a => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : null);
    const oH = off(fH), oJ = off(fJ);
    step('each screen draws the thrown body on the path (median distance under 0.8 m)', oH.length > 3 && oJ.length > 3 && med(oH) < 0.8 && med(oJ) < 0.8, `host ${med(oH)?.toFixed(2)} m over ${oH.length} samples, joiner ${med(oJ)?.toFixed(2)} m over ${oJ.length}`);
    // the drawn body at the same moment of the flight on both screens
    const pairs = [];
    for (const a of fJ) { if (!a.at?.body) continue; const b = fH.reduce((best, x) => (x.at?.body && (!best || Math.abs(x.t - a.t) < Math.abs(best.t - a.t)) ? x : best), null); if (b && Math.abs(b.t - a.t) < 0.06) pairs.push(Math.hypot(a.at.body.x - b.at.body.x, a.at.body.y - b.at.body.y, a.at.body.z - b.at.body.z)); }
    step('both screens draw the body in the same place at the same moment of the flight (median under 1 m)', pairs.length > 3 && med(pairs) < 1, `median ${med(pairs)?.toFixed(2)} m, max ${pairs.length ? Math.max(...pairs).toFixed(2) : '-'} m over ${pairs.length} pairs`);
    // back on dry ground, on both screens
    await until(async () => { const a = await state(H), b = await state(J); return !a.hz.out.length && !b.hz.out.length ? true : null; }, 15000, 'the joiner back').catch(() => null);
    const [bH, bJ] = [await state(H), await state(J)];
    const jH = bH.players.find(p => p.id === joinId), jJ = bJ.players.find(p => p.id === joinId);
    const ground = await inGame(H, p => window.__game.terrainAt(p.x, p.z), jH);
    step('the joiner came back on dry ground, the same place on both screens', jH?.alive && ground != null && ground > 0.2 && Math.hypot(jH.x - jJ.x, jH.z - jJ.z) < 1.5, `host sees ${jH?.x},${jH?.y},${jH?.z}; joiner ${jJ?.x},${jJ?.y},${jJ?.z}; ground ${ground}`);
    step('scores agree', JSON.stringify(bH.players.map(p => [p.id, p.score])) === JSON.stringify(bJ.players.map(p => [p.id, p.score])), JSON.stringify(bH.players.map(p => [p.name, p.score])));
    step('no page errors', errors.length === 0, errors.slice(0, 5).join(' | ') || 'none');
    if (shots) writeFileSync(path.join(shots, 'flight-log.json'), JSON.stringify({ host: fH, joiner: fJ }, null, 1));
    out.ok = out.steps.every(x => x.ok);
    return out;
  } catch (e) {
    step('the run finished', false, e.message);
    out.errors = errors;
    return out;
  } finally { await browser.close().catch(() => {}); await s.close?.().catch?.(() => {}); s.server?.close?.(); }
}
const clampN = (v, a, b) => Math.max(a, Math.min(b, v));

if (isMain(import.meta)) {
  const a = process.argv.slice(2), arg = k => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : null; };
  const dir = a.find((x, i) => !x.startsWith('--') && !['--shots', '--turns'].includes(a[i - 1]));
  if (!dir) { console.error('usage: node tests/chaos-two-players.mjs <game dir> [--shots <dir>] [--turns 8]'); process.exit(2); }
  const r = await chaosTwoPlayers(dir, { shots: arg('--shots'), turns: Number(arg('--turns') ?? 8), log: m => console.error(m) });
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.ok ? 0 : 1);
}
