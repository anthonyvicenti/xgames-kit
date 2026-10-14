// The `gamesfun web3` command and the web3 MCP tools: drafts edit gamesfun.json; launch and publish only leave a
// request with a step for the human (open the studio, approve in the wallet), and nothing signs or sends.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { web3Action } from '../builder/web3/node/actions.mjs';
import { tools } from '../builder/mcp/tools/web3.mjs';
import command from '../builder/commands/web3.mjs';
import { fakeChain } from './web3/fake-chain.mjs';
import { makeGame } from './web3/helpers.mjs';

const run = promisify(execFile);
const bin = path.join(import.meta.dirname, '..', 'bin', 'gamesfun.mjs');

describe('gamesfun web3 (CLI)', () => {
  it('is found by the CLI and explains itself', async () => {
    const { stdout } = await run(process.execPath, [bin, 'web3', '--help']);
    assert.match(stdout, /gamesfun web3 <action>/);
    assert.equal(command.name, 'web3');
    assert.equal(typeof command.run, 'function');
  });

  it('drafts items and a box, then publishing only queues a request for the studio', async () => {
    const game = await makeGame();
    const chain = fakeChain();
    const opts = { kitRoot: game.kitRoot, cwd: game.root, env: {}, fetchImpl: chain.fetchImpl };
    const g = { game: game.gameDir };
    await web3Action('item', 'add', { ...g, name: 'Golden Hat', picture: 'assets/hat.png', rarity: 'rare', price: '0.05', look: '{"values":{"character.tint.player":"#ffcc00"}}' }, opts);
    await web3Action('item', 'add', { ...g, name: 'Ice Skin', picture: 'assets/skin.png', rarity: 'Epic' }, opts);
    const box = await web3Action('box', 'add', { ...g, name: 'Mystery Box', price: '0.01' }, opts);
    assert.deepEqual(box.data.box.entries, [{ item: 1, weight: 10 }, { item: 2, weight: 4 }]);
    const status = await web3Action('status', null, { ...g, offline: true }, opts);
    assert.match(status.text, /item 1: Golden Hat · Rare · 0\.05 SOL · changes character\.tint\.player · draft/);
    const published = await web3Action('shop', 'publish', g, opts);
    assert.match(published.approve.step, /Review and approve/);
    assert.equal(chain.sent.length, 0, 'nothing was sent');
    const requests = await web3Action('requests', null, g, opts);
    assert.equal(requests.data.requests[0].kind, 'publish');
    await assert.rejects(web3Action('launch', null, { ...g, name: 'Bean', symbol: 'B', picture: 'assets/icon.png' }, opts), /Ticker/);
    await assert.rejects(web3Action('launch', null, { ...g, name: 'Bean', symbol: 'BEAN', picture: '../../etc/passwd' }, opts), /inside the game/);
    await assert.rejects(web3Action('item', 'add', { ...g, name: 'Hat', picture: 'assets/hat.png', description: 'my seed phrase: abandon abandon' }, opts), /secret/);
  });

  it('keeps the creator’s RPC on this machine, never in the game', async () => {
    const game = await makeGame();
    const out = await web3Action('settings', null, { rpc: 'https://devnet.helius-rpc.com/?api-key=SECRET123' }, { kitRoot: game.kitRoot, env: {} });
    assert.equal(out.text, 'RPC: https://devnet.helius-rpc.com/… (network: devnet)');
    const saved = await readFile(path.join(game.kitRoot, '.gamesfun', 'web3.json'), 'utf8');
    assert.match(saved, /SECRET123/);
    // It lives in the kit's git-ignored .gamesfun/, outside every game folder.
    assert.ok(!path.relative(game.gameDir, path.join(game.kitRoot, '.gamesfun')).startsWith('.gamesfun'));
    await assert.rejects(web3Action('settings', null, { rpc: 'https://api.mainnet-beta.solana.com' }, { kitRoot: game.kitRoot, env: {} }), /devnet only/);
  });
});

describe('web3 MCP tools', () => {
  it('each has a name, a description, an object schema and a handler; names are unique', () => {
    const names = new Set();
    for (const t of tools) {
      assert.match(t.name, /^web3_[a-z_]+$/);
      assert.ok(t.description.length > 40, t.name);
      assert.equal(t.inputSchema.type, 'object');
      assert.equal(typeof t.handler, 'function');
      assert.ok(!names.has(t.name));
      names.add(t.name);
    }
  });

  it('the tools that would sign or spend return a step for the human and never sign', async () => {
    const game = await makeGame();
    const chain = fakeChain();
    const ctx = { kitRoot: game.kitRoot, cwd: game.root, env: {}, fetchImpl: chain.fetchImpl };
    const by = (name) => tools.find((t) => t.name === name);
    const looks = await by('web3_player_looks').handler({ game: game.gameDir }, ctx);
    assert.ok(Array.isArray(looks.looks));
    assert.ok((await by('web3_list_pictures').handler({ game: game.gameDir }, ctx)).pictures.includes('assets/hat.png'));
    await by('web3_add_item').handler({ game: game.gameDir, name: 'Golden Hat', picture: 'assets/hat.png', price: '0.05', look: { values: { 'character.tint.player': '#ffcc00' } } }, ctx);
    const launch = await by('web3_prepare_launch').handler({ game: game.gameDir, name: 'Bean Brawl', symbol: 'BEAN', picture: 'assets/icon.png' }, ctx);
    const publish = await by('web3_prepare_publish').handler({ game: game.gameDir }, ctx);
    for (const r of [launch, publish]) {
      assert.match(r.approve.step, /approve/i);
      assert.match(r.approve.step, /wallet/);
      assert.ok(r.approve.requestId);
    }
    assert.equal(chain.sent.length, 0);
    assert.equal(chain.simulated.length, 0);
    const config = JSON.parse(await readFile(path.join(game.gameDir, 'gamesfun.json'), 'utf8'));
    assert.equal(config.token, undefined, 'preparing a launch launches nothing');
    assert.equal(config.shop.items[0].listed, false);
  });
});
