// verify check 6's forge leg (CONTRACT §8 forge): a lost round ends. Kept apart from tools/verify-forge.mjs, which
// calls checkForgeRoundEnds in its solo session and folds the answer into check 6.
//
// Why forge has its own (wave 3, track S3, 2026-10-10; regressions/forge-round-never-ends): check 6 plays one round to
// its results and replays it, alone and with two players, and every time the round is ended by something other than
// the game's rules: the solo round's clock is set to 25 s, and the gate's host presses End round. So a forge game whose
// rules never end a round passed it. In a wave game that is a player lying dead in the ruin, the screen red, until the
// clock runs out: 15 minutes in Bone Vigil, 7 in the wave 1b room. The session ends a round on its clock and on
// rules.check() alone; who has fallen is the rules' to say (ctx.round.end('lost', []) when nobody stands).
//
// What it does: a game whose player has hit points and whose enemies come in waves (as check 21's forge leg) is played
// alone with HEALTH hit points and no armour (set as Studio overrides a value: one hit fells the player, so the check
// does not wait out a whole fight) and a long clock (CLOCK s, so the clock cannot be what ends it). The player stands
// where it spawned and the first wave comes. From the moment the core says it fell: within END_S the round must reach
// its results, or the player must stand again (a game that puts a fallen player back on their feet has not stranded
// them). A player still standing after FALL_S was not felled: nothing to judge, said so, never a failure.
import { healthApplies } from './forge-hud-check.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const r1 = v => Math.round(v * 10) / 10;
export const FORGE_ROUND_LIMITS = { HEALTH: 12, CLOCK: 600, FALL_S: 60, END_S: 8 };

/** In the page: the round and the local player, as the core holds it. */
const READ = () => {
  const g = window.__game; if (!g) return null;
  const s = g.snapshot(), me = s.players.find(p => p.local), core = g.forge?.players?.().find(p => p.local) ?? null;
  let dead = false; try { dead = !!g.forge?.feel?.()?.shown?.view?.dead; } catch {}
  return { phase: s.phase, reason: s.reason ?? null, left: s.time?.left ?? null, fallen: me?.alive === false || dead || (core ? core.alive === false || core.hp <= 0 : false), hp: core?.hp ?? null, enemies: (g.forge?.enemies?.() ?? []).filter(e => !e.dead).length };
};

/**
 * The verdict from the measurements (pure). m: {applies, why, fell (s into the round, or null), ended (s after the fall
 * the results came, or null), stood (s after the fall the player stood again, or null), waited (s watched after the
 * fall), left (s still on the round's clock when the watch stopped), enemies (the most alive at once), reason}
 */
export function judgeForgeRoundEnd(m, L = FORGE_ROUND_LIMITS) {
  if (!m.applies) return { ok: true, judged: false, detail: `a lost round: nothing to judge (${m.why})` };
  if (m.fell === null) return { ok: true, judged: false, detail: `a lost round: not judged, the player was still standing after ${L.FALL_S} s on ${L.HEALTH} hit points (${m.enemies ? `${m.enemies} enemies were alive at once and none felled it` : 'no enemy came'})` };
  if (m.ended !== null && m.ended <= L.END_S) return { ok: true, judged: true, detail: `a lost round ends: alone on ${L.HEALTH} hit points the player fell ${r1(m.fell)} s in and the results came ${r1(m.ended)} s later${m.reason ? ` ("${m.reason}")` : ''}` };
  if (m.stood !== null && m.stood <= L.END_S) return { ok: true, judged: true, detail: `a fallen player is not stranded: alone on ${L.HEALTH} hit points the player fell ${r1(m.fell)} s in and stood again ${r1(m.stood)} s later` };
  const left = m.left !== null && m.left !== undefined ? `${Math.floor(m.left / 60)} min ${Math.round(m.left % 60)} s` : 'the rest of its time';
  return { ok: false, judged: true, detail: `a lost round does not end: alone, the player fell ${r1(m.fell)} s into the round and ${r1(m.waited)} s later the round was still running with ${left} on its clock and nobody standing (the check gave it a ${Math.round(L.CLOCK / 60)}-minute clock; the game's own is what a player would wait out). Nothing ends a forge round but its clock and the rules: end it when nobody stands (rules.update on the host: every player's alive is false → ctx.round.end('lost', [])), or put the fallen back on their feet` };
}

/** Check 6's forge leg. → {ok, detail, judged, record, warnings} */
export async function checkForgeRoundEnds({ newPage, url, game, log = () => {}, shot = async () => null }) {
  const L = FORGE_ROUND_LIMITS, warnings = [];
  const a = healthApplies(game);
  const m = { applies: a.applies && game.round?.mode !== 'world', why: a.why ?? 'a world has no rounds', fell: null, ended: null, stood: null, waited: 0, left: null, enemies: 0, reason: null };
  if (!m.applies) { const j = judgeForgeRoundEnd(m, L); return { ...j, warnings, record: { applies: false, why: m.why } }; }
  const T = await newPage('a lost round', { overrides: { patches: [
    { file: 'config/game.json', pointer: '/round/seconds', value: L.CLOCK },
    { file: 'config/game.json', pointer: '/forge/player/health', value: L.HEALTH },
    { file: 'config/game.json', pointer: '/forge/player/armor', value: 0 },
  ] } });
  const p = T.page;
  let shotFile = null;
  try {
    await p.goto(`${url}?seed=5&bots=0`, { waitUntil: 'load' });
    for (let t = Date.now(); (await p.evaluate(() => window.__game?.phase ?? null).catch(() => null)) !== 'lobby'; ) { if (Date.now() - t > 90000) throw new Error('no lobby in 90 s'); await sleep(200); }
    await p.click('#gf-play');
    for (let t = Date.now(); (await p.evaluate(() => window.__game?.phase ?? null).catch(() => null)) !== 'playing'; ) { if (Date.now() - t > 20000) throw new Error('the round did not start'); await sleep(120); }
    const t0 = Date.now();
    let fellAt = null;
    for (;;) {
      const s = await p.evaluate(READ).catch(() => null);
      const now = Date.now();
      if (!s) { await sleep(150); if (now - t0 > (L.FALL_S + L.END_S + 5) * 1000) break; continue; }
      m.enemies = Math.max(m.enemies, s.enemies);
      if (fellAt === null) {
        if (s.phase === 'results') { m.fell = (now - t0) / 1000; m.ended = 0; m.reason = s.reason; break; }   // fell and ended between two reads
        if (s.fallen) { fellAt = now; m.fell = (now - t0) / 1000; }
        else if (now - t0 > L.FALL_S * 1000) break;
      } else {
        m.waited = (now - fellAt) / 1000; m.left = s.left;
        if (s.phase === 'results') { m.ended = m.waited; m.reason = s.reason; break; }
        if (!s.fallen && s.phase === 'playing') { m.stood = m.waited; break; }
        if (m.waited > L.END_S + 1.5) break;
      }
      await sleep(150);
    }
    shotFile = await shot(p, 'lost-round');
  } catch (e) { warnings.push(`the lost-round page stopped: ${e.message}`); }
  finally { if (T.errors.length) warnings.push(`the lost-round page console errors: ${[...new Set(T.errors)].slice(0, 2).join(' | ')}`); await T.ctx.close().catch(() => {}); }
  const j = judgeForgeRoundEnd(m, L);
  if (!j.judged) warnings.push(`check 6 on forge: ${j.detail}`);
  log(`  forge lost round: ${j.ok ? 'ok' : 'FAIL'} ${j.detail.slice(0, 220)}`);
  return { ...j, warnings, record: { ...m, fell: m.fell === null ? null : r1(m.fell), ended: m.ended === null ? null : r1(m.ended), stood: m.stood === null ? null : r1(m.stood), waited: r1(m.waited), limits: L, shot: shotFile } };
}
