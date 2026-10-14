// The kit's dependency-free Solana code agrees with the reference libraries (@solana/web3.js, @solana/spl-token,
// the Meteora DBC SDK, @irys/bundles). The expected values are golden fixtures made by tests/web3/fixtures/generate.mjs
// from those libraries and from real devnet accounts; the kit never depends on them. The loot program (0.3) has its
// own fixtures and tests: tests/web3-loot.test.mjs. chain.json's `loot` section is the retired 0.1 client's output,
// kept here only as instructions to compile into messages.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { decodeBase58, encodeBase58, isAddress, isSignature } from '../builder/web3/gf-web3/chain/base58.js';
import { compactU16, fromBase64, fromHex, readCompactU16, toBase64, toHex } from '../builder/web3/gf-web3/chain/bytes.js';
import { isOnCurve } from '../builder/web3/gf-web3/chain/curve.js';
import { associatedTokenAddress, findProgramAddress, metadataAddress } from '../builder/web3/gf-web3/chain/pda.js';
import { sha256 } from '../builder/web3/gf-web3/chain/sha256.js';
import { parseCoreAsset } from '../builder/web3/gf-web3/chain/core.js';
import { computeUnitLimit, computeUnitPrice, withSolWrap } from '../builder/web3/gf-web3/chain/programs.js';
import { compileMessage, readMessage, readTransaction, signersOf, wireTransaction, withSignature } from '../builder/web3/gf-web3/chain/tx.js';
import { createPoolInstruction, dbcPda, firstBuyInstructions, readPoolConfig } from '../builder/web3/gf-web3/chain/dbc.js';
import { parseMint } from '../builder/web3/gf-web3/chain/mint.js';

const F = JSON.parse(readFileSync(new URL('./web3/fixtures/chain.json', import.meta.url), 'utf8'));
const plain = (ix) => ({ programId: ix.programId, keys: ix.keys, data: toHex(ix.data) });
const bytesOf = (account) => (account ? fromBase64(account.data) : null);
const normalize = (v) =>
  typeof v === 'bigint' ? v.toString() : v instanceof Uint8Array ? toHex(v) : Array.isArray(v) ? v.map(normalize) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, normalize(x)])) : v;

describe('bytes, hashes, base58 and the curve', () => {
  it('sha256 matches node:crypto around every block boundary', () => {
    for (const length of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000]) {
      const data = randomBytes(length);
      assert.equal(toHex(sha256(data)), createHash('sha256').update(data).digest('hex'), `length ${length}`);
    }
  });

  it('base58 matches web3.js, leading zeros included', () => {
    for (const { hex, text } of F.base58) {
      assert.equal(encodeBase58(fromHex(hex)), text);
      assert.equal(toHex(decodeBase58(text)), hex);
    }
    assert.equal(isAddress('11111111111111111111111111111111'), true);
    for (const bad of ['', '0OIl', 'abc', 42, null, '1'.repeat(45)]) assert.equal(isAddress(bad), false);
    assert.equal(isSignature(encodeBase58(randomBytes(64))), true);
    assert.equal(isSignature(encodeBase58(randomBytes(32))), false);
  });

  it('isOnCurve agrees with web3.js on keys, hashes and edge encodings', () => {
    for (const { hex, onCurve } of F.curve) assert.equal(isOnCurve(fromHex(hex)), onCurve, hex);
  });

  it('compact-u16 and base64 round-trip', () => {
    for (const n of [0, 1, 127, 128, 255, 16383, 16384, 65535]) {
      const bytes = compactU16(n);
      assert.deepEqual(readCompactU16(bytes, 0), { value: n, size: bytes.length });
    }
    const data = new Uint8Array(randomBytes(70000));
    assert.deepEqual(fromBase64(toBase64(data)), data);
    assert.throws(() => fromBase64('not base64!'));
  });
});

describe('program addresses', () => {
  it('findProgramAddress matches web3.js, bump included', () => {
    for (const { seeds, program, address, bump } of F.pdas) assert.deepEqual(findProgramAddress(seeds.map(fromHex), program), [address, bump]);
  });
  it('associated token accounts match spl-token, for wallets, PDAs and Token-2022', () => {
    for (const { owner, mint, program, address } of F.atas) assert.equal(associatedTokenAddress(owner, mint, program), address);
  });
  it('Metaplex metadata PDAs match', () => {
    assert.equal(metadataAddress(F.metadataPda.mint), F.metadataPda.address);
  });
});

describe('the SOL wrap around a purchase', () => {
  it('a SOL price wraps exactly the price around the purchase, budget first', () => {
    const [ata, transfer, sync, close, limit, price] = F.solWrap;
    assert.deepEqual(plain(computeUnitLimit(450000)), limit);
    assert.deepEqual(plain(computeUnitPrice(5000)), price);
    const body = { programId: '11111111111111111111111111111111', keys: [], data: Uint8Array.of(1) };
    const wrapped = withSolWrap(F.messages.payer, 'So11111111111111111111111111111111111111112', 2500000n, [computeUnitLimit(450000), body]);
    assert.deepEqual(wrapped.map(plain), [limit, ata, transfer, sync, plain(body), close]);
    assert.deepEqual(withSolWrap(F.messages.payer, F.loot.inputs.mint, 1n, [body]), [body]);
  });
});

describe('transactions', () => {
  const M = F.messages;
  const buy = () => [plainToIx(F.loot.buyItem[0])];
  const plainToIx = (p) => ({ programId: p.programId, keys: p.keys, data: fromHex(p.data) });

  it('compiles v0 messages byte for byte like web3.js, with and without a lookup table', () => {
    const ixs = buy();
    assert.equal(toHex(compileMessage({ payer: M.payer, blockhash: M.blockhash, instructions: ixs, version: 0 })), M.v0Buy);
    assert.equal(toHex(compileMessage({ payer: M.payer, blockhash: M.blockhash, instructions: ixs, version: 0, lookupTables: [M.table] })), M.v0BuyWithTable);
  });

  it('compiles legacy messages that decompile to the same instructions as web3.js', () => {
    const ixs = buy();
    const ours = readMessage(compileMessage({ payer: M.payer, blockhash: M.blockhash, instructions: ixs }));
    const theirs = readMessage(fromHex(M.legacyBuy));
    const resolve = (m) => ({
      header: m.header,
      keys: [...m.keys].sort(),
      instructions: m.instructions.map((ix) => ({ program: m.keys[ix.programIndex], accounts: ix.accountIndexes.map((i) => m.keys[i]), data: toHex(ix.data) })),
    });
    assert.deepEqual(resolve(ours), resolve(theirs));
    const roles = (m) => Object.fromEntries(m.keys.map((k, i) => [k, [i < m.header.numRequiredSignatures, i < m.header.numRequiredSignatures - m.header.numReadonlySigned || (i >= m.header.numRequiredSignatures && i < m.keys.length - m.header.numReadonlyUnsigned)]]));
    assert.deepEqual(roles(ours), roles(theirs));
  });

  it('wire transactions: signature slots, reading back, filling one slot', () => {
    const message = compileMessage({ payer: M.payer, blockhash: M.blockhash, instructions: buy() });
    const wire = wireTransaction(message);
    const read = readTransaction(wire);
    assert.deepEqual(read.signers, [M.payer]);
    assert.deepEqual(read.message, message);
    const signature = randomBytes(64);
    const signed = withSignature(wire, M.payer, signature);
    assert.deepEqual(readTransaction(signed).signatures[0], new Uint8Array(signature));
    assert.throws(() => withSignature(wire, F.loot.pdas.platform, signature), /does not sign/);
    assert.deepEqual(signersOf(message), [M.payer]);
  });
});

describe('Meteora DBC launch instructions match the SDK', () => {
  const D = F.dbc;
  const config = readPoolConfig(bytesOf(F.accounts.poolConfig));
  const pool = createPoolInstruction({ configAddress: D.input.configAddress, config, baseMint: D.input.baseMint, creator: D.input.creator, name: D.input.name, symbol: D.input.symbol, uri: D.input.uri });

  it('reads a devnet curve config like the SDK (antisnipe-v1, the shared MAIN-dev config launches used before 2026-10-12)', () => {
    const read = normalize(config);
    assert.deepEqual(Object.fromEntries(Object.keys(F.accounts.poolConfig.expect).map((k) => [k, read[k]])), F.accounts.poolConfig.expect);
    // The split games.fun's registry reads, at the loot program's offsets (venue.rs): this old config is 50 / 50.
    assert.deepEqual(
      [read.leftoverReceiver, read.creatorTradingFeePercentage, read.partnerPermanentLockedLiquidityPercentage, read.creatorPermanentLockedLiquidityPercentage, read.creatorMigrationFeePercentage, read.migratedCompoundingFeeBps],
      ['8yPDcNeKHwfSmyx9MPNpgqU8o1W4xiCHxzYty7w3rnNV', 50, 50, 50, 0, 0],
    );
  });
  it('createPool', () => {
    assert.equal(pool.pool, D.pool);
    assert.equal(dbcPda.pool(config.quoteMint, D.input.baseMint, D.input.configAddress), D.pool);
    assert.deepEqual([plain(pool)].map(({ programId, keys, data }) => ({ programId, keys, data })), D.createPool);
  });
  it('createPoolWithFirstBuy', () => {
    const buy = firstBuyInstructions({ configAddress: D.input.configAddress, config, baseMint: D.input.baseMint, buyer: D.input.creator, amountIn: BigInt(D.input.amountIn), minimumAmountOut: BigInt(D.input.minimumAmountOut) });
    assert.deepEqual([pool, ...buy.instructions].map(plain), D.createPoolWithFirstBuy);
  });
});

describe('accounts read from devnet decode like the reference readers', () => {
  it('a classic mint with Metaplex metadata, and one without', () => {
    const main = parseMint(F.accounts.mainMint.address, F.accounts.mainMint.owner, bytesOf(F.accounts.mainMint), bytesOf(F.accounts.mainMetadata));
    const e = F.accounts.mainMint.expect;
    assert.deepEqual([main.decimals, main.supply, main.mintAuthority, main.freezeAuthority], [e.decimals, e.supply, e.mintAuthority, e.freezeAuthority]);
    assert.equal(main.program, 'spl-token');
    const usdc = parseMint(F.accounts.usdcMint.address, F.accounts.usdcMint.owner, bytesOf(F.accounts.usdcMint));
    assert.equal(usdc.decimals, 6);
    assert.equal(parseMint(F.accounts.lootGame.address, F.accounts.lootGame.owner, bytesOf(F.accounts.lootGame)), null);
  });
  it('a Core asset minted by the loot program', { skip: !F.accounts.coreAsset }, () => {
    assert.deepEqual(normalize(parseCoreAsset(bytesOf(F.accounts.coreAsset))), F.accounts.coreAsset.expect);
  });
});
