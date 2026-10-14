// Irys uploads: the kit's ANS-104 data items match @irys/bundles 0.0.5 byte for byte (golden fixtures from
// tests/web3/fixtures/generate.mjs), and the node client refuses odd answers instead of trusting them.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fromHex, toHex, utf8 } from '../builder/web3/gf-web3/chain/bytes.js';
import { irysNode, itemId, messageToSign, signatureData, signedItem, unsignedItem } from '../builder/web3/node/irys.mjs';
import { verifySignature } from '../builder/web3/node/ed25519.mjs';

const F = JSON.parse(readFileSync(new URL('./web3/fixtures/chain.json', import.meta.url), 'utf8'));

describe('ANS-104 data items for a Solana wallet (signature type 4)', () => {
  for (const [i, f] of F.irys.entries()) {
    it(`item ${i}: deep hash, signed bytes and id match @irys/bundles`, () => {
      const item = unsignedItem({ owner: f.owner, data: fromHex(f.data), tags: f.tags, anchor: fromHex(f.anchor) });
      assert.equal(toHex(signatureData(item)), f.signatureData);
      // The fixture's signature is the wallet's ed25519 signature of the hex text, as a wallet's signMessage makes it.
      const raw = fromHex(f.raw);
      const signature = raw.slice(2, 66);
      assert.equal(verifySignature(f.owner, utf8(messageToSign(item)), signature), true);
      assert.equal(toHex(signedItem(item, signature)), f.raw);
      assert.equal(itemId(signature), f.id);
    });
  }

  it('refuses a malformed owner, anchor, tag or signature', () => {
    assert.throws(() => unsignedItem({ owner: new Uint8Array(31), data: utf8('x') }), /32 bytes/);
    assert.throws(() => unsignedItem({ owner: F.irys[0].owner, data: utf8('x'), anchor: new Uint8Array(5) }), /anchor/);
    assert.throws(() => unsignedItem({ owner: F.irys[0].owner, data: utf8('x'), tags: [{ name: '', value: 'v' }] }), /tag/);
    const item = unsignedItem({ owner: F.irys[0].owner, data: utf8('x') });
    assert.throws(() => signedItem(item, new Uint8Array(63)), /64 bytes/);
  });
});

describe('the Irys node client', () => {
  const answer = (status, body) => async () => new Response(body, { status });
  const irys = { node: 'https://node.test', gateway: 'https://gw.test', currency: 'solana' };

  it('reads price, balance and the deposit address, and refuses odd answers', async () => {
    assert.equal(await irysNode(irys, { fetchImpl: answer(200, '39874') }).price(100), 39874n);
    assert.equal(await irysNode(irys, { fetchImpl: answer(200, '{"balance":"12"}') }).balance('7Mj8GZjgesKWEG43o9ibp1mi6GHkB7nV5ubCV9xd4389'), 12n);
    await assert.rejects(irysNode(irys, { fetchImpl: answer(200, '-1') }).price(1), /unexpected/);
    await assert.rejects(irysNode(irys, { fetchImpl: answer(200, '{"addresses":{"solana":"nope"}}') }).depositAddress(), /unexpected/);
    await assert.rejects(irysNode(irys, { fetchImpl: answer(402, 'Not enough balance') }).upload(new Uint8Array(1)), /402/);
    await assert.rejects(irysNode(irys, { fetchImpl: answer(200, '{"id":"../../etc"}') }).upload(new Uint8Array(1)), /unexpected/);
  });

  it('never follows redirects', async () => {
    let seen;
    await irysNode(irys, { fetchImpl: async (url, init) => ((seen = init), new Response('1')) }).price(1);
    assert.equal(seen.redirect, 'error');
  });
});
