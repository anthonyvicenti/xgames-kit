// verify check 15's forge leg (CONTRACT §8 forge): the first wave can be fought. Kept apart from
// tools/verify-forge.mjs, which plays it in its solo session and folds the answer into check 15 (the loop is alive).
//
// Why forge has its own (the frozen forge case, 2026-10-11; gf-forge/evidence/eval-t6-full-2026-10-11;
// regressions/forge-first-wave-kills): verify passed three times on a game whose first minute a play-tester could not
// get through, and nothing in it plays the fight. Check 15 looked at the goal's share of the first picture; check 12
// plays bots; check 6 fells the player on purpose. So a first wave that kills whoever stands and fights passed, and so
// would enemies no round can hurt.
//
// What it does: a game whose player has hit points, holds a weapon at the start and whose enemies come in waves is
// played alone on its own values (only the clock is lengthened, so the clock cannot be what ends it). The player
// stands where it spawned and fights with a new player's hand (lib/forge-fight.mjs: the nearest enemy in view, a
// quarter second to react, a degree and a half off, three rounds a second; the hand runs in the page, on the game's
// own clock). A try ends badly when
//   - the player is felled before the first wave is cleared, or
//   - KILL_S after the first enemy rose, nothing has fallen.
// A wave still being fought after WATCH_S, with the player standing and enemies falling, is a good try and says so.
//
// UP TO `TRIES` TRIES, each with other dice in the hand, and the first good one passes. One fight is one throw: on
// Bone Vigil's first wave (8, four at once) twelve fights with the hand a little steadier or looser and four seeds
// ran from untouched (100 of 100 health) to felled at 16 s, ten cleared and two felled (2026-10-11; a crowd that
// reaches a standing player finishes it, so a fight goes one way or the other). A gate that failed a game on one
// throw would fail that wave one run in six. So the leg fails only a first wave that fells the hand every time, which
// is what regressions/forge-first-wave-kills is (32, sixteen at once); a wave that takes more than one try passes
// and the detail says how many it took.
//
// The first wave is over when as many enemies have fallen as it holds (counted by the hand, from
// window.__game.forge.enemies: the kit's own observation). Not from the game's rules: the first cut read the wave's number
// from what a game's own rules.observe() reports, which Bone Vigil's rules do and the rules create writes do not, so
// on the frozen case's game it fought on through the second and third waves and called the fall there the first
// wave's ("with 20 of the wave's 5 down").
import { healthApplies } from './forge-hud-check.mjs';
import { POINTER_LOCK } from './forge-feel-check.mjs';
import { fightFor } from './forge-fight.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const r1 = v => Math.round(v * 10) / 10;
export const FORGE_FIRST_WAVE_LIMITS = { CLOCK: 600, WATCH_S: 75, KILL_S: 30, TRIES: 3, SEEDS: [15, 16, 17] };

/** Does the leg apply? (pure) */
export function firstWaveApplies(game) {
  const a = healthApplies(game);
  if (!a.applies) return a;
  if (game.round?.mode === 'world') return { applies: false, why: 'a world has no waves to clear' };
  if (!(game.forge?.weapons ?? []).some(w => w?.start !== false)) return { applies: false, why: 'the player holds no weapon at the start' };
  const size = (game.forge.waves[0]?.enemies ?? []).reduce((n, e) => n + (Number(e?.count) || 0), 0);
  return { applies: true, size };
}

/** In the page: the round, the local player and the wave, as the core holds them, at the page's own time. */
const READ = () => {
  const g = window.__game; if (!g) return null;
  const s = g.snapshot(), me = s.players.find(p => p.local), core = g.forge?.players?.().find(p => p.local) ?? null;
  let dead = false; try { dead = !!g.forge?.feel?.()?.shown?.view?.dead; } catch {}
  let cards = null; try { cards = g.forge?.cards?.()?.phase ?? null; } catch {}
  return { now: performance.now(), phase: s.phase, reason: s.reason ?? null, fallen: me?.alive === false || dead || (core ? core.alive === false || core.hp <= 0 : false), hp: core?.hp ?? null,
    wave: s.rules?.ai?.director?.wave ?? null, cards, enemies: (g.forge?.enemies?.() ?? []).filter(e => !e.dead).length };
};

/**
 * One try's verdict from its measurements (pure). m: {applies, why, size (the first wave's enemies), cannot, first (s
 * into the round the first enemy was alive, or null), kill (s the first one fell), cleared (s the wave was cleared),
 * fell (s the player fell), watched (s), low (the lowest health seen), hp (the player's own), shots, firedAt, down
 * (enemies that fell)}
 */
export function judgeFirstWave(m, L = FORGE_FIRST_WAVE_LIMITS) {
  if (!m.applies) return { ok: true, judged: false, detail: `the first wave: nothing to judge (${m.why})` };
  if (m.cannot) return { ok: true, judged: false, detail: 'the first wave: not judged, the game gives no enemies or no look to fight with (window.__game.forge.enemies, forge.face)' };
  if (m.first === null) return { ok: true, judged: false, detail: `the first wave: not judged, no enemy came in ${Math.round(m.watched)} s` };
  const of = `${m.down} of the wave's ${m.size} down, ${m.shots} rounds fired at ${m.firedAt} of them`;
  if (m.fell !== null && (m.cleared === null || m.fell <= m.cleared)) return { ok: false, judged: true, detail: `the player was down ${r1(m.fell)} s into the round, ${r1(m.fell - m.first)} s after the first enemy rose, with ${of}` };
  if (m.kill === null && m.watched - m.first >= L.KILL_S) return { ok: false, judged: true, nothing: true, detail: `${m.shots} rounds aimed at the bodies of ${m.firedAt} enemies in ${r1(m.watched - m.first)} s and none fell` };
  if (m.cleared !== null) return { ok: true, judged: true, detail: `cleared in ${r1(m.cleared)} s (${m.shots} rounds, ${m.down} down; lowest health ${m.low === null ? '?' : Math.round(m.low)} of ${m.hp})` };
  return { ok: true, judged: true, detail: `still standing after ${Math.round(m.watched)} s with ${of} (lowest health ${m.low === null ? '?' : Math.round(m.low)} of ${m.hp})` };
}

/**
 * The leg's verdict from its tries, in the order played (pure): the first good try passes; every try bad fails, in the
 * words of the try that got furthest. tries: [m …]
 */
export function judgeFirstWaveTries(tries, L = FORGE_FIRST_WAVE_LIMITS) {
  const js = tries.map(m => judgeFirstWave(m, L));
  const first = js[0];
  if (!first || !first.judged) return first ?? { ok: true, judged: false, detail: 'the first wave: not judged, no try was played' };
  const good = js.findIndex(j => j.ok && j.judged), hp = tries[0].hp;
  if (good >= 0) {
    const before = js.slice(0, good).map(j => j.detail);
    return { ok: true, judged: true, detail: `the first wave can be fought: standing and firing, ${js[good].detail}${good ? `, on try ${good + 1} of up to ${L.TRIES} (before it: ${before.join('; ')}): a first wave this close to felling a new player is worth making gentler` : ''}` };
  }
  const unjudged = js.find(j => !j.judged);
  if (unjudged) return unjudged;                                   // a try that could not be played is not a verdict against the game
  const best = tries.map((m, i) => ({ m, j: js[i] })).sort((a, b) => b.m.down - a.m.down)[0];
  const n = `${js.length === 1 ? 'the one try' : `each of ${js.length} tries`}`;
  if (js.every(j => j.nothing)) return { ok: false, judged: true, detail: `nothing falls in the first wave: alone on the game's own values, in ${n}, ${best.j.detail} (enemy health against the starting weapon's damage and magazine, or shots that do not land)` };
  return { ok: false, judged: true, detail: `the first wave fells a player who stands and fights: alone on the game's own values (${hp} hit points), aiming at the nearest enemy and firing three rounds a second, in ${n}; at best ${best.j.detail}. A new player does not know to run yet: make the first wave smaller, slower to rise or fewer at once (forge.waves[0]: enemies, delay, spawnEvery, maxAlive, attackers), and ramp the later ones` };
}

/** One fight of the first wave, alone, with the hand's dice at `seed`. → m (the measurements judgeFirstWave reads) */
async function playOnce({ newPage, url, game, seed, L, applies, warnings, shot, n }) {
  const m = { applies: true, why: null, size: applies.size ?? 0, cannot: false, first: null, kill: null, cleared: null, fell: null, watched: 0, low: null, hp: Number(game.forge?.player?.health ?? 0), shots: 0, firedAt: 0, down: 0, seed, shot: null, hand: null };
  const T = await newPage(`the first wave, try ${n}`, { overrides: { patches: [{ file: 'config/game.json', pointer: '/round/seconds', value: L.CLOCK }] } });
  const p = T.page;
  try {
    await p.addInitScript(POINTER_LOCK);
    await p.goto(`${url}?seed=7&bots=0`, { waitUntil: 'load' });
    for (let t = Date.now(); (await p.evaluate(() => window.__game?.phase ?? null).catch(() => null)) !== 'lobby'; ) { if (Date.now() - t > 90000) throw new Error('no lobby in 90 s'); await sleep(200); }
    await p.click('#gf-play');
    for (let t = Date.now(); (await p.evaluate(() => window.__game?.phase ?? null).catch(() => null)) !== 'playing'; ) { if (Date.now() - t > 20000) throw new Error('the round did not start'); await sleep(120); }
    await p.mouse.click(640, 360);                                             // the mouse is the game's from here
    // times are the page's own clock (the hand runs there), from the moment the round began
    const t0 = await p.evaluate(() => performance.now());
    let pageNow = t0; const at = () => (pageNow - t0) / 1000;
    const io = { frame: () => p, down: k => p.keyboard.down(k), up: k => p.keyboard.up(k) };
    const did = await fightFor(io, { seconds: L.WATCH_S, seed, until: async d => {
      const s = await p.evaluate(READ).catch(() => null);
      if (!s) return null;
      pageNow = s.now; m.watched = at();
      if (s.hp !== null) m.low = m.low === null ? s.hp : Math.min(m.low, s.hp);
      if (m.first === null && s.enemies > 0) m.first = at();
      if (m.kill === null && d.gone > 0) m.kill = at();
      if (s.fallen) { m.fell = at(); return 'fell'; }
      if (s.phase === 'results') { m.cleared = at(); return 'the round ended'; }   // not fallen: the game's own end (a single wave won)
      if (d.gone >= m.size || (s.wave ?? 1) >= 2 || s.cards === 'choosing' || s.cards === 'dealing') { m.cleared = at(); return 'cleared'; }
      if (m.first !== null && m.kill === null && at() - m.first >= L.KILL_S) return 'nothing fell';
      return null;
    } });
    m.cannot = did.cannot; m.shots = did.shots; m.firedAt = did.firedAt; m.down = did.gone;
    if (m.kill === null && did.gone > 0) m.kill = m.watched;
    if (m.cleared === null && m.fell === null && did.gone >= m.size) m.cleared = m.watched;
    m.hand = { ended: did.ended, stopped: did.stopped };
    m.shot = await shot(p, n === 1 ? 'first-wave' : `first-wave-try-${n}`);
  } catch (e) { warnings.push(`the first-wave page stopped (try ${n}): ${e.message}`); }
  finally { if (T.errors.length) warnings.push(`the first-wave page console errors: ${[...new Set(T.errors)].slice(0, 2).join(' | ')}`); await T.ctx.close().catch(() => {}); }
  return m;
}

/** Check 15's forge leg. → {ok, detail, judged, record, warnings} */
export async function checkForgeFirstWave({ newPage, url, game, log = () => {}, shot = async () => null }) {
  const L = FORGE_FIRST_WAVE_LIMITS, warnings = [];
  const a = firstWaveApplies(game);
  if (!a.applies) { const j = judgeFirstWave({ applies: false, why: a.why }, L); return { ...j, warnings, record: { applies: false, why: a.why } }; }
  const tries = [];
  for (let n = 1; n <= L.TRIES; n++) {
    const m = await playOnce({ newPage, url, game, seed: L.SEEDS[(n - 1) % L.SEEDS.length], L, applies: a, warnings, shot, n });
    tries.push(m);
    const j = judgeFirstWave(m, L);
    log(`  forge first wave, try ${n}: ${j.ok ? (j.judged ? 'good' : 'not judged') : 'bad'} · ${j.detail.slice(0, 200)}`);
    if (j.ok || !j.judged) break;                                              // a good try passes; a try that could not be played is not played again
  }
  const j = judgeFirstWaveTries(tries, L);
  if (!j.judged) warnings.push(`check 15 on forge: ${j.detail}`);
  log(`  forge first wave: ${j.ok ? 'ok' : 'FAIL'} ${j.detail.slice(0, 240)}`);
  const num = v => (v === null ? null : r1(v));
  const rows = tries.map(m => ({ ...m, first: num(m.first), kill: num(m.kill), cleared: num(m.cleared), fell: num(m.fell), watched: r1(m.watched) }));
  return { ...j, warnings, record: { applies: true, size: a.size, tries: rows, ...rows.at(-1), limits: L, hand: 'lib/forge-fight.mjs FIGHT, in the page' } };
}
