// The full simulation (builder/web3/economy/sim): the real loot program 0.3 in LiteSVM beside the quick simulation.
//
// The pieces that need nothing from outside run everywhere: the fallback to the quick simulation, the comparison and
// its flags, the quick model's own path over a run, the command and the agent tool. The runs of the real program need
// LiteSVM and the program bytes in the cache folder (`gamesfun economy simulate --full` puts them there once); the
// tests never fetch or install anything, so where they are missing (CI has no devnet) those tests skip and say why.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import * as economyTools from '../builder/mcp/tools/economy.mjs';
import { model } from '../builder/web3/economy/model.mjs';
import { cacheDir } from '../builder/web3/economy/sim/cache.mjs';
import { explainFull, prepareFull, simulateFull } from '../builder/web3/economy/sim/index.mjs';
import { compare, quickOverRun } from '../builder/web3/economy/sim/report.mjs';
import { externalAddresses } from '../builder/web3/economy/sim/run.mjs';
import { simulate } from '../builder/web3/economy/simulate.mjs';
import { NOW, ROOT, fixture } from './economy/helpers.mjs';

const run = promisify(execFile);
const CLI = path.join(ROOT, 'bin', 'gamesfun.mjs');

async function emptyCache(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gf-sim-cache-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('offline with an empty cache, the full simulation says why and gives the quick one', async (t) => {
  const dir = await emptyCache(t);
  const r = await simulateFull(fixture('coin-flip-arena'), { dir, offline: true, install: false, days: 3, now: NOW });
  assert.equal(r.mode, 'quick');
  assert.match(r.why, /^The full simulation could not run: .+ This is the quick simulation alone\.$/);
  // The quick simulation over the days asked for.
  assert.equal(r.quick.scenario.days, 3);
  assert.equal(explainFull(r), r.why);
});

test('the command falls back the same way and still exits 0', async (t) => {
  const dir = await emptyCache(t);
  const spec = path.join(dir, 'arena.json');
  await writeFile(spec, JSON.stringify(fixture('coin-flip-arena')));
  const { stdout } = await run(process.execPath, [CLI, 'economy', 'simulate', '--spec', spec, '--full', '--offline', '--days', '2'], { env: { ...process.env, GAMESFUN_CACHE: dir } });
  assert.match(stdout, /^The full simulation could not run: /);
  assert.match(stdout, /Box “Coin flip”: costs 0\.1 SOL/);
  const json = JSON.parse((await run(process.execPath, [CLI, 'economy', 'simulate', '--spec', spec, '--full', '--offline', '--json'], { env: { ...process.env, GAMESFUN_CACHE: dir } })).stdout);
  assert.equal(json.mode, 'quick');
  await assert.rejects(run(process.execPath, [CLI, 'economy', 'simulate', '--spec', spec, '--full', '--players', '0'], { env: { ...process.env, GAMESFUN_CACHE: dir } }), /--players takes a number above 0/);
});

test('economy_simulate full: true hands over to the full simulation and words its answer', async () => {
  const tool = economyTools.tools.find((x) => x.name === 'economy_simulate');
  assert.ok(tool.inputSchema.properties.full && tool.inputSchema.properties.players && tool.inputSchema.properties.days);
  let asked;
  const stub = async (economy, opts) => {
    asked = opts;
    return { mode: 'quick', why: 'The full simulation could not run: no LiteSVM here. This is the quick simulation alone.', quick: simulate(economy, { now: NOW }) };
  };
  const r = await tool.handler({ example: 'coin-flip-arena', full: true, players: 7, days: 3 }, { now: NOW, simulateFull: stub, log: () => {}, env: {} });
  assert.deepEqual({ players: asked.players, days: asked.days }, { players: 7, days: 3 });
  assert.equal(r.mode, 'quick');
  assert.match(r.text, /^The full simulation could not run: no LiteSVM here\./);
  assert.match(r.text, /Box “Coin flip”/);
});

test('a spec’s devnet accounts: existing mints and every account and holder a share names', () => {
  assert.deepEqual(externalAddresses(fixture('coin-flip-arena')), []);
  assert.deepEqual(externalAddresses(fixture('scorched-treasury')), ['4ikj24Byduo7WZGhnxNYkqstpm9xUVeZH7eLQbjGDL7N']);
  const drop = externalAddresses(fixture('falling-drop'));
  assert.ok(drop.includes('4ikj24Byduo7WZGhnxNYkqstpm9xUVeZH7eLQbjGDL7N'));
  assert.ok(drop.length >= 2, 'falling-drop also names a partner account');
  assert.ok(externalAddresses(fixture('duel-arena')).length >= 2, 'duel-arena names a holder');
});

test('the quick model’s own path: a pool that pays a share of itself is still filling at day 5', () => {
  const economy = fixture('halving-seasons');
  const quick = simulate({ ...economy, scenario: { ...economy.scenario, days: 5 } }, { now: NOW });
  const path5 = quickOverRun(quick, model(economy), 5);
  const season = quick.pools.find((p) => p.key === 'season');
  // B* = (1000 − 500) / 0.1 = 5000 from a seed of 0: over 5 days its average level is 5000 (1 − (1 − e^−0.5)/0.5).
  const level = 5000 * (1 - (1 - Math.exp(-0.5)) / 0.5);
  assert.ok(Math.abs(path5.get('season').out - (500 + 0.1 * level)) < 1e-6, `season out ${path5.get('season').out}`);
  assert.ok(season.outPerDay > path5.get('season').out, 'the settled number is above the run’s average');
  // The interest pool gets 10% of the season's level, so its average follows the season's.
  assert.ok(Math.abs(path5.get('interest').in - 0.1 * level) < 1e-6);
  // Over a very long run the path is the settled level.
  const long = quickOverRun(simulate({ ...economy, scenario: { ...economy.scenario, days: 3650 } }, { now: NOW }), model(economy), 3650);
  assert.ok(Math.abs(long.get('season').out - season.outPerDay) / season.outPerDay < 0.01);
});

test('the comparison flags a difference beyond chance and the tolerance, and only that', () => {
  const economy = fixture('coin-flip-arena');
  const quick = simulate({ ...economy, scenario: { ...economy.scenario, days: 14 } }, { now: NOW });
  const full = {
    days: 14,
    boxes: [{ key: 'flip', opens: 14_000, returnPercent: 87.4, realCostSol: 0.10251 }],
    pools: quick.pools.map((p) => ({ key: p.key, token: p.token, inPerDay: p.inPerDay, outPerDay: p.outPerDay, after: p.after })),
    lotteries: [{ key: 'weekly', rounds: 2, paidPerRound: 77 }],
    stakes: [{ key: 'backers', rewardsPerDay: 2 }],
    perDay: { ...quick.perDay, players: { ...quick.perDay.players, networkFeesSol: quick.perDay.players.networkFeesSol * 2 } },
    counts: { 'stake:backers': { wanted: 140, done: 140 } },
  };
  const rows = compare(quick, full, economy);
  const flagged = rows.filter((r) => r.flag).map((r) => r.what);
  // 87.4% against 88% over 14,000 flips is chance (3 standard errors of the return is about 2.2 points); doubled
  // network fees are not.
  assert.deepEqual(flagged, ['players’ network fees a day']);
  const flip = rows.find((r) => r.what === 'box flip: return to players');
  assert.ok(flip.noise > 0.6 && !flip.flag);
  assert.equal(rows.find((r) => r.what === 'box flip: what one open takes from the wallet').difference, 0);
});

// ---------------------------------------------------------------- the real program (needs the cache)

const ready = await prepareFull(fixture('coin-flip-arena'), { dir: cacheDir(), offline: true, install: false });
const skip = ready.ok ? false : `the full simulation's LiteSVM and program bytes are not in the cache (${ready.why}) Run \`npx gamesfun economy simulate --full\` once on a machine with devnet to fill it.`;
const prepared = async (economy) => (ready.ok ? prepareFull(economy, { dir: cacheDir(), offline: true, install: false }) : ready);
const row = (r, what) => r.compare.find((x) => x.what === what);
const flags = (r) => r.flagged.map((x) => x.what).sort();

test('coin-flip arena on the real program: 8 days, one draw', { skip, timeout: 600_000 }, async () => {
  const economy = fixture('coin-flip-arena');
  const r = await simulateFull(economy, { players: 10, days: 8, now: NOW, prepared: await prepared(economy) });
  assert.equal(r.mode, 'full');
  assert.deepEqual(r.full.counts['box:flip'], { wanted: 8000, done: 8000 });
  assert.equal(r.full.counts['lottery:weekly (draw)'].done, 1);
  // Fees are exact: games.fun's, the oracle's, the network's (two signatures a flip, the player's).
  for (const what of ['player fees a day', 'players’ oracle fees a day', 'players’ network fees a day', 'games.fun’s fees a day']) assert.equal(row(r, what).difference, 0, what);
  assert.equal(row(r, 'box flip: what one open takes from the wallet').full, 0.10251);
  assert.equal(row(r, 'players pay a day (sol)').difference, 0);
  // The weekly pot: 7 days of 10% of 1,000 flips and 100 tickets, paid 50/30/20.
  assert.equal(row(r, 'lottery weekly: paid per round').full, 77);
  assert.deepEqual(flags(r), []);
});

test('halving seasons on the real program: 30 days', { skip, timeout: 600_000 }, async () => {
  const economy = fixture('halving-seasons');
  const r = await simulateFull(economy, { players: 20, days: 30, now: NOW, prepared: await prepared(economy) });
  assert.equal(r.mode, 'full');
  // The schedule mints 1,000 PLAY a day for 30 runs: exact.
  assert.equal(row(r, 'pool season: in per day').full, 1000);
  for (const what of ['player fees a day', 'players’ network fees a day', 'games.fun’s fees a day', 'treasury a day (sol)']) assert.equal(row(r, what).difference, 0, what);
  // What the real program does that the quick model only approximates (both understood, not bugs):
  // - the drip takes 10% of the season pool once a day, right after the day's 1,000 landed in it, where the quick
  //   model takes it continuously: about 9% more moves to the interest pool, and the season pool ends lower;
  // - the last drip lands at the very end of the run, with nobody staking after it;
  // - a season pass grows when a claim first writes its `used` numbers on it, and the player pays that rent too.
  const allowed = new Set(['pool season: after 30 days', 'pool interest: in per day', 'pool interest: after 30 days', 'players’ rent a day', 'pool season: out per day', 'stake vault: rewards per day', 'players get back a day (play)', 'pool interest: out per day']);
  for (const what of flags(r)) assert.ok(allowed.has(what), `unexpected difference: ${what} ${JSON.stringify(row(r, what))}`);
  // Season passes rest a day between claims and only 5 are sold a day: the scenario's 50 claims a day cannot all happen.
  assert.ok(r.full.counts['recipe:daily-claim'].done < 1500);
});

test('sacrifice raffle on the real program: 8 days, tickets burned, eight places', { skip, timeout: 900_000 }, async () => {
  const economy = fixture('sacrifice-raffle');
  const r = await simulateFull(economy, { players: 20, days: 8, now: NOW, prepared: await prepared(economy) });
  assert.equal(r.mode, 'full');
  for (const what of ['players pay a day (sol)', 'players pay a day (ticket)', 'burned a day (ticket)', 'treasury a day (sol)', 'player fees a day', 'players’ network fees a day', 'games.fun’s fees a day']) assert.equal(row(r, what).difference, 0, what);
  assert.equal(row(r, 'lottery weekly: paid per round').difference, 0);
  // The rent too, since the quick simulation counts a collectible's real rent and what a burned one gives back.
  assert.deepEqual(flags(r), []);
});
