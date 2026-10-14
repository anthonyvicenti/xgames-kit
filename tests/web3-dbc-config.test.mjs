// A launch's own Meteora DBC config, as the kit builds it, byte for byte what games.fun's launchpad builds for the
// same inputs (launch/own-config.mjs prepareOwnConfig with @meteora-ag/dynamic-bonding-curve-sdk 1.5.12): the
// createConfig instruction (its ConfigParameters: the curve, the fees, the 95 / 5 split) and its accounts, the pool on
// it, and the creator's first buy with the SOL wrap around it. The expected bytes are tests/web3/fixtures/
// dbc-config.json, made by tests/web3/fixtures/generate-dbc-config.mjs from the launchpad itself.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { toHex } from '../builder/web3/gf-web3/chain/bytes.js';
import { createConfigInstruction, createPoolInstruction, dbcPda, firstBuyInstructions, localPoolConfig } from '../builder/web3/gf-web3/chain/dbc.js';
import { curveParams, dec, minBaseFeeNumerator, quoteFirstBuy, SPLIT, targetsForPair } from '../builder/web3/gf-web3/chain/dbc-curve.js';
import { associatedTokenAddress, NATIVE_MINT } from '../builder/web3/gf-web3/chain/pda.js';
import { closeTokenAccount, syncNative, transferLamports } from '../builder/web3/gf-web3/chain/programs.js';
import { compileMessage, MAX_TRANSACTION_BYTES, readMessage, wireTransaction } from '../builder/web3/gf-web3/chain/tx.js';
import { networkConfig } from '../builder/web3/gf-web3/network.js';

const F = JSON.parse(readFileSync(new URL('./web3/fixtures/dbc-config.json', import.meta.url), 'utf8'));
const plain = (ix) => ({ programId: ix.programId, keys: ix.keys, data: toHex(ix.data) });
const BLOCKHASH = 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N';

/** The kit's transactions as flows.mjs groups them: one when it fits, else the config, then the rest. */
function kitTransactions(ixs, payer) {
  const wire = (instructions) => {
    const w = wireTransaction(compileMessage({ payer, blockhash: BLOCKHASH, instructions }));
    return w.length <= MAX_TRANSACTION_BYTES ? w : null;
  };
  const one = wire(ixs);
  return one ? [one] : [wire(ixs.slice(0, 1)), wire(ixs.slice(1))];
}

/** A wire's instructions with each account's flags as its compiled message gives them (as web3.js decodes them). */
function decoded(w) {
  const m = readMessage(w.subarray(1 + 64 * w[0]));
  const { numRequiredSignatures: sig, numReadonlySigned: roSigned, numReadonlyUnsigned: roUnsigned } = m.header;
  const flags = (i) => ({ isSigner: i < sig, isWritable: i < sig - roSigned || (i >= sig && i < m.keys.length - roUnsigned) });
  return m.instructions.map((ix) => ({ programId: m.keys[ix.programIndex], keys: ix.accountIndexes.map((i) => ({ pubkey: m.keys[i], ...flags(i) })), data: toHex(ix.data) }));
}

/** What the kit's launch flow (builder/web3/node/flows.mjs launchSteps) puts in the launch, in its order. */
function kitLaunch(c) {
  const { pair, caps, creator, config, mint, name, symbol, uri } = c.input;
  const targets = targetsForPair(pair, caps);
  const params = curveParams(targets);
  const local = localPoolConfig({ quoteMint: pair.mint, params });
  const ixs = [
    createConfigInstruction({ config, feeClaimer: F.partner, leftoverReceiver: F.partner, quoteMint: pair.mint, payer: creator, params }),
    createPoolInstruction({ configAddress: config, config: local, baseMint: mint, creator, name, symbol, uri }),
  ];
  let quote = null;
  if (c.input.firstBuy) {
    const amountIn = BigInt(c.input.firstBuy);
    quote = quoteFirstBuy(params, amountIn);
    const [quoteAta, baseAta, swap] = firstBuyInstructions({ configAddress: config, config: local, baseMint: mint, buyer: creator, amountIn, minimumAmountOut: quote.minimumAmountOut }).instructions;
    const wrapped = associatedTokenAddress(creator, NATIVE_MINT);
    ixs.push(...(pair.native ? [quoteAta, baseAta, transferLamports(creator, wrapped, amountIn), syncNative(wrapped), swap, closeTokenAccount(wrapped, creator, creator)] : [quoteAta, baseAta, swap]));
  }
  return { targets, params, ixs, quote, pool: dbcPda.pool(pair.mint, mint, config) };
}

describe('a launch’s own DBC config matches games.fun’s launchpad byte for byte', () => {
  it('the fixture covers SOL with and without a first buy, USDC-dev with one, and an unpriced pair with the creator’s caps', () => {
    assert.deepEqual(F.cases.map((c) => c.id), ['sol-no-buy', 'sol-first-buy', 'usdc-first-buy', 'unpriced-own-caps']);
  });
  for (const c of F.cases) {
    describe(c.id, () => {
      const kit = kitLaunch(c);
      const theirs = c.built;
      it('the same curve targets (dollar-sized, or the creator’s own caps)', () => {
        const t = c.launchpad.targets;
        assert.deepEqual([kit.targets.initialMarketCap, kit.targets.migrationMarketCap, kit.targets.quoteDecimals, kit.targets.baseDecimals], [t.initialMarketCapMain, t.migrationMarketCapMain, t.quoteDecimals, t.baseDecimals ?? 6]);
        assert.equal(kit.params.migrationQuoteThreshold.toString(), c.launchpad.threshold);
      });
      it('createConfig: the same data and the same accounts', () => {
        assert.deepEqual(plain(kit.ixs[0]), theirs[0]);
      });
      it('the pool on it: the same address, data and accounts', () => {
        assert.equal(kit.pool, c.launchpad.pool);
        assert.deepEqual(plain(kit.ixs[1]), theirs[1]);
      });
      it('every instruction of the launch, in order (the first buy and its SOL wrap included), as the SDK built it', () => {
        assert.deepEqual(kit.ixs.map(plain), theirs);
      });
      it('the same transactions: as many, each decoding to the same instructions and account flags', () => {
        const wires = kitTransactions(kit.ixs, c.input.creator);
        assert.equal(wires.length, c.transactions.length);
        assert.deepEqual(wires.map(decoded), c.transactions.map((t) => t.instructions));
      });
      if (c.input.firstBuy)
        it('the first buy’s offline quote is the launchpad’s', () => {
          assert.deepEqual([kit.quote.expectedOut.toString(), kit.quote.minimumAmountOut.toString()], [c.launchpad.firstBuy.expectedOut, c.launchpad.firstBuy.minimumAmountOut]);
        });
    });
  }
});

describe('the split and the pair', () => {
  it('every launch carries 95 / 5 to games.fun’s partner wallet, with no migration fee and no compounding', () => {
    const params = curveParams(targetsForPair({ decimals: 9, usd: 100 }));
    assert.deepEqual([params.creatorTradingFeePercentage, params.partnerPermanentLockedLiquidityPercentage, params.creatorPermanentLockedLiquidityPercentage, params.partnerLiquidityPercentage, params.creatorLiquidityPercentage], [95, 5, 95, 0, 0]);
    assert.deepEqual([params.migrationFee.feePercentage, params.migrationFee.creatorFeePercentage, params.compoundingFeeBps], [0, 0, 0]);
    const { launchpad } = networkConfig('devnet');
    assert.deepEqual({ ...launchpad.split }, { ...SPLIT });
    assert.equal(launchpad.partner, F.partner);
  });
  it('no MAIN: SOL is the default pair, USDC-dev the other quick pick, and neither shop currencies nor pairs list MAIN', () => {
    const n = networkConfig('devnet');
    assert.equal(n.launchpad.defaultPair, 'SOL');
    assert.deepEqual(n.launchpad.pairs.map((p) => p.symbol), ['SOL', 'USDC-dev']);
    assert.deepEqual(n.currencies.map((c) => c.symbol), ['SOL', 'USDC-dev']);
    assert.equal('quoteMint' in n.launchpad || 'config' in n.launchpad, false);
  });
  it('a pair with no price needs the creator’s caps, and caps that break the curve are refused', () => {
    assert.throws(() => targetsForPair({ symbol: 'PAIR', decimals: 6, usd: null }), /no price/);
    assert.throws(() => targetsForPair({ decimals: 6, usd: null }, { initialMarketCap: 100, migrationMarketCap: 150 }), /at least 2 times/);
    assert.equal(targetsForPair({ decimals: 9, usd: 0.0001 }).baseDecimals, 9);
  });
  it('a first buy at or past the graduation amount is refused', () => {
    const params = curveParams(targetsForPair({ decimals: 9, usd: 100 }));
    assert.throws(() => quoteFirstBuy(params, params.migrationQuoteThreshold), /graduation/);
  });
  it('the minimum fee is what the exponential scheduler reaches after 60 periods (about 1%: 10,013,002 of 1e9)', () => {
    assert.equal(minBaseFeeNumerator(), 10_013_002n);
  });
  it('decimal.js rounding: 20 significant digits, half up', () => {
    assert.deepEqual(dec('1.23456789012345678905'), { c: 123456789012345678905n, e: -20 });
  });
});
