// A shop read as an economy (migrateShop: the in-game kit's and the Economy tab's), and the `gamesfun economy` command.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { check } from '../builder/web3/economy/check.mjs';
import { compile } from '../builder/web3/economy/compile.mjs';
import { leaveOldProgram, migrateShop } from '../builder/web3/economy/migrate.mjs';
import { lootPda } from '../builder/web3/gf-web3/chain/loot.js';
import { readEconomy as readEconomySpec } from '../builder/web3/gf-web3/econ/spec.js';
import { validate } from '../builder/web3/economy/validate.mjs';
import { FIXTURES, NOW, ROOT } from './economy/helpers.mjs';

const run = promisify(execFile);
const CLI = path.join(ROOT, 'bin', 'gamesfun.mjs');

/** A shop as the kit writes it today (builder/web3/gf-web3/config.js cleanShop), live on loot 0.2. */
const shopConfig = (currency) => ({
  version: 1,
  network: 'devnet',
  creator: '43QBMgKHHkPuPZsN4KUwUkbxJkHfv4gZF1d7xNMP66gc',
  shop: {
    name: 'Soak Squad Shop',
    description: 'Hats and water guns',
    royaltyBps: 750,
    currency,
    collection: '98iBZ4eVrpLoRxguPjqrmcEEQbYgJjf19nDct5hSYQ6R',
    game: 'CaNj6MqahzwNWGNWXtQhEy9mM3qX6gnDUBMJSchQPa78',
    items: [
      { id: 1, name: 'Golden Soaker', description: '', rarity: 'Legendary', price: '2500000', maxSupply: 10, soulbound: false, picture: 'assets/gold.png', listed: true },
      { id: 2, name: 'Bucket Hat', description: 'Splash-proof', rarity: 'Common', price: '0', maxSupply: 0, soulbound: true, listed: true },
    ],
    boxes: [{ id: 1, name: 'Splash crate', price: '1000000', entries: [{ item: 1, weight: 1 }, { item: 2, weight: 99 }], listed: true }],
  },
});

test('a SOL shop becomes an economy that validates, checks and compiles', () => {
  const { config, changed, notes } = migrateShop(shopConfig({ mint: 'So11111111111111111111111111111111111111112', symbol: 'SOL', decimals: 9, native: true }));
  assert.equal(changed, true);
  assert.equal(config.shop, undefined);
  assert.equal(config.creator, '43QBMgKHHkPuPZsN4KUwUkbxJkHfv4gZF1d7xNMP66gc', 'the rest of gamesfun.json is kept');
  const e = config.economy;
  assert.deepEqual(validate(e), []);
  assert.deepEqual(e.tokens, [{ key: 'sol', source: 'sol' }]);
  assert.equal(e.collection.royaltyPercent, 7.5);
  assert.deepEqual(e.items.map((i) => [i.key, i.id, i.price, i.supply, i.soulbound]), [['golden-soaker', 1, '0.0025', 10, false], ['bucket-hat', 2, '0', 0, true]]);
  assert.deepEqual(e.boxes[0].outcomes, [{ gives: 'item', item: 'golden-soaker', weight: 1 }, { gives: 'item', item: 'bucket-hat', weight: 99 }]);
  assert.equal(e.previous.game, 'CaNj6MqahzwNWGNWXtQhEy9mM3qX6gnDUBMJSchQPa78');
  assert.ok(notes.some((n) => n.includes('0.2')));
  assert.equal(check(e, { now: NOW }).ok, true);
  const box = compile(e, { now: NOW }).transactions.flatMap((t) => t.steps).find((s) => s.ix === 'upsert_box');
  assert.equal(box.args.args.price, '1000000', 'the same price in lamports');
  assert.deepEqual(box.args.args.entries.map((x) => x.weight), [1, 99], 'the same weights');
});

test('a shop in the game’s launched token keeps the token as a curve token', () => {
  const mint = '4ikj24Byduo7WZGhnxNYkqstpm9xUVeZH7eLQbjGDL7N';
  const c = shopConfig({ mint, symbol: 'MAIN', decimals: 6, native: false });
  c.token = { mint, name: 'Main', symbol: 'MAIN', decimals: 6, program: 'spl-token', source: 'launched' };
  const { config } = migrateShop(c);
  assert.deepEqual(config.economy.tokens[0], { key: 'main', source: 'curve', mint, name: 'Main', symbol: 'MAIN', decimals: 6, program: 'spl-token', venue: 'games.fun' });
  assert.equal(config.economy.items[0].price, '2.5');
  assert.equal(check(config.economy, { now: NOW }).ok, true);
});

test('nothing to move, or an economy already there, leaves the config alone', () => {
  const plain = { version: 1, network: 'devnet' };
  assert.equal(migrateShop(plain).config, plain);
  const both = { ...shopConfig(undefined), economy: { version: 1 } };
  assert.equal(migrateShop(both).changed, false);
});

test('an economy put live on the program before 0.3.1 goes live fresh: its addresses move to previous', () => {
  // 6LyAQ6uk… is this collection's game on 88Labq6t… (0.3); the current program gives it another address.
  const collection = '7ScDGYiamcQMsjdK1Vamo5fGU9V1tvtj3PcZouZYbz7a';
  const old = { program: '88Labq6tdVnBQsjHSfic6qqgvo5b9NGmy99AYj7KVXqM', game: '6LyAQ6uksrZmfdU8XrcsEqgYRASYS5Nd993u91aDArvn', collection, at: '2026-10-11T12:00:00Z' };
  const economy = { version: 1, live: structuredClone(old) };
  assert.equal(readEconomySpec(economy).game, null, 'the game page reads it as not live');
  const notes = leaveOldProgram(economy);
  assert.equal(economy.live, undefined);
  assert.deepEqual(economy.previous, old);
  assert.match(notes[0], /goes live fresh/);
  // One put live on this program stays.
  const here = { version: 1, live: { game: lootPda.game(collection), collection } };
  assert.deepEqual(leaveOldProgram(here), []);
  assert.equal(readEconomySpec(here).game, lootPda.game(collection));
});

async function tempGame(config) {
  const dir = await mkdtemp(path.join(tmpdir(), 'gf-economy-'));
  for (const f of ['index.html', 'gf-three.json', 'assets.json']) await writeFile(path.join(dir, f), f.endsWith('.json') ? '{}' : '<!doctype html>');
  if (config) await writeFile(path.join(dir, 'gamesfun.json'), JSON.stringify(config));
  return dir;
}

test('no command rewrites a game\'s file: `gamesfun economy migrate` is gone, a shop moves in the Economy tab', async () => {
  const dir = await tempGame(shopConfig(undefined));
  try {
    const r = await run(process.execPath, [CLI, 'economy', 'check', dir]).catch(e => e);
    assert.match(String(r.stderr ?? r.message), /has a shop and no economy yet\. Open the studio's Economy tab/);
    assert.ok(JSON.parse(await readFile(path.join(dir, 'gamesfun.json'), 'utf8')).shop, 'the file is untouched');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('gamesfun economy check|simulate|cost|plan on a fixture, and on a game', async () => {
  const spec = path.join(FIXTURES, 'coin-flip-arena.json');
  const checked = JSON.parse((await run(process.execPath, [CLI, 'economy', 'check', '--spec', spec, '--json'])).stdout);
  assert.equal(checked.ok, true);
  const words = (await run(process.execPath, [CLI, 'economy', 'simulate', '--spec', spec])).stdout;
  assert.match(words, /gives back 0\.088 SOL on average \(88%\)/);
  const plan = JSON.parse((await run(process.execPath, [CLI, 'economy', 'plan', '--spec', spec, '--json'])).stdout);
  assert.equal(plan.ok, true);
  assert.match((await run(process.execPath, [CLI, 'economy', 'cost', '--spec', spec])).stdout, /Going live takes 2 transactions/);

  const bad = JSON.parse(await readFile(spec, 'utf8'));
  bad.boxes[0].outcomes[0].chance = 70;
  const dir = await tempGame({ version: 1, network: 'devnet', economy: bad });
  try {
    const refused = await run(process.execPath, [CLI, 'economy', 'check', dir]).catch((e) => e);
    assert.equal(refused.code, 1);
    assert.match(refused.stdout, /E-ODDS/);
    assert.match(refused.stdout, /Fix:/);
    const later = await run(process.execPath, [CLI, 'economy', 'publish', dir]).catch((e) => e);
    assert.equal(later.code, 1, 'publish refuses what the checker refuses');
    assert.match(later.stdout, /E-ODDS/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('gamesfun.json keeps its economy section when the shop and token flows save it', async () => {
  const { parseConfig, serializeConfig } = await import('../builder/web3/gf-web3/config.js');
  const spec = JSON.parse(await readFile(path.join(FIXTURES, 'coin-flip-arena.json'), 'utf8'));
  const economy = spec.economy ?? spec;
  const text = serializeConfig({ version: 1, network: 'devnet', economy });
  assert.deepEqual(parseConfig(text).economy, economy);
});
