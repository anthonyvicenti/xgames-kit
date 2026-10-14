// Web3 is on by default in the studio since 2026-10-12 (builder/lib/web3-switch.mjs): the Economy tab (which replaced the
// Token and Shop tabs) is listed unless GAMESFUN_WEB3=0.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { startDevServer } from '../builder/server/index.mjs';
import { tempGame } from './helpers.mjs';

let game, srv, base;
const saved = process.env.GAMESFUN_WEB3;
before(async () => {
  game = await tempGame();
  srv = await startDevServer({ gameDir: game.dir, port: 0, log: () => {}, watch: false });
  base = `http://127.0.0.1:${srv.port}`;
});
after(async () => {
  if (saved === undefined) delete process.env.GAMESFUN_WEB3; else process.env.GAMESFUN_WEB3 = saved;
  await srv.close(); await game.cleanup();
});
const tabs = async () => (await (await fetch(`${base}/api/studio/tabs`)).json()).map(t => t.file);

test('web3 on by default: the Economy tab is listed, and no Token or Shop tab', async () => {
  delete process.env.GAMESFUN_WEB3;
  const files = await tabs();
  assert.ok(files.includes('economy.js'), files.join());
  assert.ok(!files.includes('token.js') && !files.includes('shop.js'), 'the Token and Shop tabs are gone for good');
  process.env.GAMESFUN_WEB3 = '1';
  assert.ok((await tabs()).includes('economy.js'));
});

test('GAMESFUN_WEB3=0 takes the Economy tab out, and the other tabs stay', async () => {
  for (const v of ['0', 'off', 'false', 'no']) {
    process.env.GAMESFUN_WEB3 = v;
    const files = await tabs();
    assert.ok(!files.includes('economy.js'), v);
    for (const f of ['tune.js', 'friends.js', 'assets.js', 'verify.js']) assert.ok(files.includes(f), f);   // (Session and Build are the conversation now, builder/studio/chat.js)
  }
});

test('GAMESFUN_WEB3=0 wins even for a game that already has a gamesfun.json', async () => {
  process.env.GAMESFUN_WEB3 = '0';
  await writeFile(path.join(game.dir, 'gamesfun.json'), JSON.stringify({ network: 'devnet' }));
  assert.ok(!(await tabs()).includes('economy.js'));
  await rm(path.join(game.dir, 'gamesfun.json'));
});
