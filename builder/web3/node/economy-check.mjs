// `gamesfun economy check --devnet`: a live game's economy, run end to end on devnet by a synthetic player, and every
// pool checked against what it owes. Not a verify check (verify never calls it): a creator runs it on purpose, with a
// devnet key file they name that pays for the run.
//
//   1. A fresh synthetic player (its key lives in memory only, for this run) is funded from the creator's key file.
//   2. It plays through gf-web3's economy calls, the same ones the host page performs for a real player: each box is
//      opened (pay and roll, then the prize claimed) until it wins or `tries` runs out, each item on sale bought once,
//      one ticket bought in each lottery. Every open is checked against the real accounts: each pool moved by exactly
//      its share of the price less the prize it paid, and the player by the price, the platform fee and the network
//      fees, plus the prize.
//   3. Every pool, stake and contest pot is read and checked against what it owes now: rolled orders' prizes, a drawn
//      lottery's unpaid places, stakers' principal and earned rewards, a contest's unclaimed pot.
//   4. What is left in the synthetic player goes back to the key file's wallet.
// The record: public addresses, signatures, balances and verdicts; never a key.
import { readFile } from 'node:fs/promises';
import { addressBytes, encodeBase58 } from '../gf-web3/chain/base58.js';
import { readTransaction, wireTransaction, compileMessage, signersOf } from '../gf-web3/chain/tx.js';
import { currentFees, decodeLoot, decodePosition, LOOT_PROGRAM, LootAccount, lootPda, VRF_QUEUE } from '../gf-web3/chain/loot.js';
import { NATIVE_MINT } from '../gf-web3/chain/pda.js';
import { transferLamports } from '../gf-web3/chain/programs.js';
import { pendingRewards, readTokenAccount, winnerCount } from '../gf-web3/econ/chain.js';
import { readEconomy as readSpec } from '../gf-web3/econ/spec.js';
import { createGfWeb3 } from '../gf-web3/index.js';
import { explorerUrl } from '../gf-web3/network.js';
import { ORACLE_FEE } from '../economy/model.mjs';
import { freshKeypair, keypairFromSecret } from './ed25519.mjs';

export const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const TAG = { Order: 5, Position: 10 };
const SOL = 1_000_000_000n;
const sol = (lamports) => `${(Number(lamports) / 1e9).toFixed(6).replace(/\.?0+$/, '')} SOL`;
const json = (value) => JSON.parse(JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));
const big = (v) => BigInt(v ?? 0);

/** A key file (a keypair JSON array) → { address, sign }. The secret never leaves this function's closure. */
export async function readKeyFile(file) {
  let bytes;
  try {
    bytes = Uint8Array.from(JSON.parse(await readFile(file, 'utf8')));
  } catch (e) {
    throw new Error(`Could not read the key file (${e.code === 'ENOENT' ? 'no such file' : 'not a keypair JSON array'}). Name a devnet keypair file with --key <file> or GAMESFUN_DEVNET_KEY.`);
  }
  if (bytes.length !== 64) throw new Error('The key file is not a 64-byte keypair JSON array.');
  return keypairFromSecret(bytes);
}

/** A Wallet Standard wallet backed by a key held in this process (the synthetic player's). */
function memoryWallet(k, name) {
  const account = { address: k.address, publicKey: addressBytes(k.address), chains: ['solana:devnet'], features: [] };
  const sign = (wire) => {
    const { message, signers, signatures } = readTransaction(wire);
    return wireTransaction(message, signers.map((s, i) => (s === k.address ? k.sign(message) : signatures[i])));
  };
  return {
    version: '1.0.0', name, icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>', chains: ['solana:devnet'], accounts: [account],
    features: {
      'standard:connect': { version: '1.0.0', connect: async () => ({ accounts: [account] }) },
      'solana:signTransaction': { version: '1.0.0', supportedTransactionVersions: ['legacy', 0], signTransaction: async (...inputs) => inputs.map((i) => ({ signedTransaction: sign(i.transaction) })) },
    },
  };
}

async function sendAs(rpc, signer, instructions) {
  const { blockhash, lastValidBlockHeight } = await rpc.latestBlockhash();
  const message = compileMessage({ payer: signer.address, blockhash, instructions });
  const signature = await rpc.send(wireTransaction(message, signersOf(message).map(() => signer.sign(message))));
  await rpc.confirm(signature, { lastValidBlockHeight });
  return signature;
}

/**
 * What one landed transaction cost its fee payer outside the economy: the network fee, and what MagicBlock's oracle
 * queue took for a roll (builder/web3/economy/model.mjs ORACLE_FEE, 0.0005 SOL a request; the open's check compares the two).
 */
async function txCosts(rpc, signature) {
  for (let i = 0; i < 5; i++) {
    const t = await rpc.call('getTransaction', [signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }]).catch(() => null);
    if (t?.meta) {
      const keys = (t.transaction?.message?.accountKeys ?? []).map((k) => (typeof k === 'string' ? k : k.pubkey));
      const q = keys.indexOf(VRF_QUEUE);
      return { fee: BigInt(t.meta.fee ?? 0), oracle: q >= 0 ? BigInt(t.meta.postBalances[q] - t.meta.preBalances[q]) : 0n };
    }
    await new Promise((r) => setTimeout(r, 800));
  }
  return { fee: 5000n, oracle: 0n, guessed: true };
}

/**
 * Every pool, stake and contest pot of a live economy against what it owes now. Pure reads.
 * → [{ kind: 'pool'|'stake'|'contest', key, account, holds, owes: [{ what, units }], owed, covers, mayOwe? }]
 * (units in the token's base units, as text)
 */
export async function obligations(rpc, economy) {
  const e = readSpec(economy);
  if (!e.game) throw new Error(`${e.name ?? 'The economy'} is not live: put it live first (npx gamesfun economy publish).`);
  const game = e.game;
  const rows = [];
  const poolRows = new Map();
  const pools = e.pools.map((p) => ({ p, address: lootPda.pool(game, p.index) }));
  const found = await rpc.accounts(pools.map((x) => x.address));
  pools.forEach(({ p, address }, i) => {
    const t = readTokenAccount(found[i]?.data);
    const row = { kind: 'pool', key: p.key, index: p.index, account: address, open: Boolean(t), holds: t?.amount ?? 0n, owes: [], mayOwe: [] };
    poolRows.set(p.index, row);
    rows.push(row);
  });

  // orders: a rolled prize is owed by its pool; a pending roll may still win the box's biggest prize from it
  const orders = await rpc.programAccounts(LOOT_PROGRAM, [{ memcmp: { offset: 0, bytes: encodeBase58(Uint8Array.of(TAG.Order)) } }, { memcmp: { offset: 1, bytes: game } }]);
  const boxes = new Map(e.boxes.map((b) => [lootPda.box(game, b.id), b]));
  for (const { pubkey, account } of orders) {
    let o;
    try {
      o = decodeLoot(LootAccount.Order, account.data);
    } catch {
      continue;
    }
    if (o.status === 'Rolled' && o.outcome?.Pay) poolRows.get(o.outcome.Pay.pool)?.owes.push({ what: `rolled order ${pubkey}`, units: big(o.outcome.Pay.amount) });
    if (o.status === 'Pending') {
      const b = boxes.get(o.loot_box);
      for (const out of b?.outcomes ?? []) {
        if (out.gives !== 'pay') continue;
        const pool = e.part('pool', out.pool);
        const t = e.poolToken(out.pool);
        poolRows.get(pool?.index)?.mayOwe.push({ what: `pending roll ${pubkey} (${b.name})`, units: BigInt(Math.round(Number(out.amount) * 10 ** (t?.decimals ?? 9))) });
      }
    }
  }

  // lotteries: a drawn round owes its unpaid places, out of the pot as it stood at payout
  for (const l of e.lotteries) {
    const [a] = await rpc.accounts([lootPda.lottery(game, l.id)]);
    if (!a) continue;
    const lot = decodeLoot(LootAccount.Lottery, a.data);
    if (lot.status !== 'Drawn') continue;
    const n = winnerCount(lot);
    for (let place = 0; place < n; place++) {
      if (Number(lot.paid) & (1 << place)) continue;
      poolRows.get(lot.pot)?.owes.push({ what: `lottery ${l.key} round ${lot.round}, place ${place + 1}`, units: (big(lot.pot_at_payout) * BigInt(lot.places[place])) / 10_000n });
    }
  }

  // stakes: the staked vault owes every staker's principal, the rewards vault what each has earned
  for (const s of e.stakes) {
    const stakeAddr = lootPda.stake(game, s.id);
    const [a, staked, rewards] = await rpc.accounts([stakeAddr, lootPda.staked(stakeAddr), lootPda.rewards(stakeAddr)]);
    if (!a) continue;
    const st = decodeLoot(LootAccount.Stake, a.data);
    const positions = await rpc.programAccounts(LOOT_PROGRAM, [{ memcmp: { offset: 0, bytes: encodeBase58(Uint8Array.of(TAG.Position)) } }, { memcmp: { offset: 1, bytes: stakeAddr } }]);
    const earned = positions.reduce((n, { account }) => {
      try {
        return n + pendingRewards(st, decodePosition(account.data));
      } catch {
        return n;
      }
    }, 0n);
    rows.push({ kind: 'stake', key: `${s.key} (staked)`, account: lootPda.staked(stakeAddr), open: Boolean(staked), holds: readTokenAccount(staked?.data)?.amount ?? 0n, owes: [{ what: `${positions.length} staker${positions.length === 1 ? '' : 's'}’ principal`, units: big(st.total) }], mayOwe: [] });
    rows.push({ kind: 'stake', key: `${s.key} (rewards)`, account: lootPda.rewards(stakeAddr), open: Boolean(rewards), holds: readTokenAccount(rewards?.data)?.amount ?? 0n, owes: [{ what: 'rewards earned and not collected', units: earned }], mayOwe: [] });
  }

  // contests: the pot owes its sides while open, what is unclaimed once decided or called off
  for (const c of e.contests) {
    const addr = lootPda.contest(game, c.id);
    const [a, pot] = await rpc.accounts([addr, lootPda.pot(addr)]);
    if (!a) continue;
    const ct = decodeLoot(LootAccount.Contest, a.data);
    const open = ct.verdict === 'Open';
    const owed = open ? ct.sides.reduce((n, v) => n + big(v), 0n) : big(ct.unclaimed);
    rows.push({ kind: 'contest', key: c.key, account: lootPda.pot(addr), open: Boolean(pot), holds: readTokenAccount(pot?.data)?.amount ?? 0n, owes: [{ what: open ? 'every side’s entries' : 'winnings and refunds not yet collected', units: owed }], mayOwe: [] });
  }

  for (const r of rows) {
    r.owed = r.owes.reduce((n, o) => n + o.units, 0n);
    r.covers = r.holds >= r.owed;
    r.mayOwed = r.mayOwe.reduce((n, o) => n + o.units, 0n);
  }
  return rows;
}

/** One box open, checked against the accounts it moves. */
async function checkedOpen({ rpc, kit, e, box, player, platformFee }) {
  const poolAddr = new Map(e.pools.map((p) => [p.key, lootPda.pool(e.game, p.index)]));
  const tokens = async () => Object.fromEntries(await Promise.all([...poolAddr].map(async ([k, a]) => [k, readTokenAccount((await rpc.accounts([a]))[0]?.data)?.amount ?? 0n])));
  const t = e.priceToken(box);
  const isSol = (box.currency ?? e.currencyKey) === 'sol' || t?.wsol || t?.mint === NATIVE_MINT;
  const beforePools = await tokens();
  const beforeLamports = await rpc.balance(player.address);
  const r = await kit.economy.openBox(box.key);
  const afterPools = await tokens();
  const afterLamports = await rpc.balance(player.address);
  let fees = 0n;
  let oracle = 0n;
  for (const s of r.signatures ?? []) {
    const c = await txCosts(rpc, s);
    fees += c.fee;
    oracle += c.oracle;
  }
  const onChain = decodeLoot(LootAccount.Box, (await rpc.accounts([lootPda.box(e.game, box.id)]))[0].data);
  const price = big(onChain.price);
  const prize = r.outcome?.kind === 'prize' ? big(r.outcome.units) : 0n;
  const prizePool = r.outcome?.pool ?? null;
  const pools = {};
  for (const p of e.pools) {
    const share = (box.split ?? []).filter((s) => s.to === `pool:${p.key}`).reduce((n, s) => n + Math.round(Number(s.percent) * 100), 0);
    const expected = (price * BigInt(share)) / 10_000n - (prizePool === p.key ? prize : 0n);
    const moved = afterPools[p.key] - beforePools[p.key];
    pools[p.key] = { before: beforePools[p.key], after: afterPools[p.key], moved, expected, ok: moved === expected };
  }
  const expectedPlayer = (isSol ? -price + prize : 0n) - platformFee - fees - oracle;
  const movedPlayer = afterLamports - beforeLamports;
  return {
    outcome: r.outcome?.says ?? r.says, won: prize > 0n || r.outcome?.kind === 'item', price, prize, prizePool, signatures: r.signatures,
    player: { before: beforeLamports, after: afterLamports, moved: movedPlayer, expected: expectedPlayer, networkFees: fees, oracleFee: oracle, oracleAsCosted: oracle === ORACLE_FEE, unexplained: movedPlayer - expectedPlayer, ok: movedPlayer === expectedPlayer },
    pools, ok: movedPlayer === expectedPlayer && Object.values(pools).every((p) => p.ok),
  };
}

/**
 * Run the check. `config`: the game's gamesfun.json; `funder`: { address, sign } from the creator's key file;
 * `rpc`: an rpcClient on devnet; `budget` lamports for the synthetic player (default: enough for `tries` opens of the
 * dearest box, a ticket in each lottery and each item once); `tries`: opens per box until a win (default 4).
 * → the record (see the file's head)
 */
export async function devnetCheck({ config, funder, rpc, rpcUrl, tries = 4, budget = null, log = () => {}, network }) {
  const genesis = await rpc.call('getGenesisHash');
  if (genesis !== DEVNET_GENESIS) throw new Error(`This RPC is not devnet (genesis ${genesis}). The kit runs on devnet only.`);
  const e = readSpec(config.economy);
  if (!e.game) throw new Error(`${e.name ?? 'The economy'} is not live yet: put it live first (npx gamesfun economy publish).`);
  const tx = (s) => explorerUrl(network, 'tx', s);
  const record = { network: 'devnet', program: LOOT_PROGRAM, game: e.game, economy: e.name, startedAt: new Date().toISOString(), funder: funder.address, steps: [], pools: [], verdict: null };
  const step = async (name, run) => {
    const at = new Date().toISOString();
    try {
      const out = (await run()) ?? {};
      record.steps.push(json({ name, at, ok: out.ok !== false, ...out }));
      log(`${out.ok === false ? '✗' : '✓'} ${name}${out.says ? `: ${out.says}` : ''}`);
      return out;
    } catch (error) {
      record.steps.push({ name, at, ok: false, error: error.message });
      log(`✗ ${name}: ${error.message}`);
      return null;
    }
  };

  const [platformAccount] = await rpc.accounts([lootPda.platform()]);
  const platformFee = BigInt(currentFees(decodeLoot(LootAccount.Platform, platformAccount.data)).player);
  const solBoxes = e.boxes.filter((b) => b.active !== false);
  const dearest = solBoxes.reduce((n, b) => (big(Math.round(Number(b.price) * 1e9)) > n ? big(Math.round(Number(b.price) * 1e9)) : n), 0n);
  const want = budget ?? dearest * BigInt(tries) + BigInt(e.lotteries.length) * (SOL / 50n) + BigInt(e.items.length) * (SOL / 20n) + SOL / 50n + platformFee * BigInt(tries * solBoxes.length + 4);
  const funderBalance = await rpc.balance(funder.address);
  record.budget = want;
  if (funderBalance < want + SOL / 100n) throw new Error(`The key file's wallet holds ${sol(funderBalance)}; this run needs about ${sol(want)} plus fees. Fund it on devnet (https://faucet.solana.com) or pass --budget.`);

  // 1. the synthetic player
  const player = freshKeypair();
  record.player = player.address;
  const kit = createGfWeb3({
    config: { version: 1, network: 'devnet', economy: config.economy }, mock: false,
    location: { search: '', href: 'http://127.0.0.1/', host: '127.0.0.1', origin: 'http://127.0.0.1', pathname: '/' }, navigator: { webdriver: false, userAgent: 'node' },
    wallets: [memoryWallet(player, `economy check ${player.address.slice(0, 6)}`)], rpc: rpcUrl, rollPollMs: 2000,
  });
  try {
    const funded = await step(`fund the synthetic player with ${sol(want)} from the key file's wallet`, async () => {
      const s = await sendAs(rpc, funder, [transferLamports(funder.address, player.address, want)]);
      return { signature: s, explorer: tx(s), ok: (await rpc.balance(player.address)) === want };
    });
    if (!funded?.ok) return finish();
    await kit.connect();

    // 2. play: pay, play, win, be paid
    for (const box of solBoxes) {
      for (let i = 1; i <= tries; i++) {
        const r = await step(`${box.name}: open ${i} of at most ${tries} (pay, roll, claim), checked against the pools and the player`, async () => {
          const c = await checkedOpen({ rpc, kit, e, box, player, platformFee });
          return { ...c, says: `${c.outcome} Player ${sol(c.player.moved)} (oracle ${sol(c.player.oracleFee)}, network ${sol(c.player.networkFees)}${c.player.ok ? '' : `, ${sol(c.player.unexplained)} unexplained`}); ${Object.entries(c.pools).map(([k, p]) => `${k} ${p.moved >= 0n ? '+' : ''}${sol(p.moved)}${p.ok ? '' : ` (expected ${sol(p.expected)})`}`).join(', ')}`, explorer: (c.signatures ?? []).map(tx) };
        });
        if (!r || r.won) break;
      }
    }
    for (const it of e.items.filter((x) => Number(x.price ?? 0) > 0 && x.active !== false)) {
      await step(`${it.name}: buy one`, async () => {
        const r = await kit.economy.buy(it.key);
        return { says: r.says, signatures: r.signatures, explorer: (r.signatures ?? []).map(tx) };
      });
    }
    for (const l of e.lotteries) {
      await step(`${l.name}: buy one ticket`, async () => {
        const r = await kit.economy.buyTickets(l.key, { count: 1 });
        return { says: r.says, signatures: r.signatures, explorer: (r.signatures ?? []).map(tx) };
      });
    }
    const st = await kit.economy.state().catch(() => null);
    if (st?.claimable?.length) for (const c of st.claimable) await step(`collect: ${c.says}`, async () => {
      const r = await kit.economy.act(c.id);
      return { says: r.says, signatures: r.signatures, explorer: (r.signatures ?? []).map(tx) };
    });
    record.won = record.steps.some((s) => s.won);
  } finally {
    await finish();
  }
  return json(record);

  async function finish() {
    if (record.finishedAt) return record;
    // 3. what each pool, stake and contest pot owes
    await step('every pool, stake and contest pot covers what it owes', async () => {
      const rows = await obligations(rpc, config.economy);
      record.pools = json(rows);
      const short = rows.filter((r) => r.open && !r.covers);
      return { ok: short.length === 0, says: rows.map((r) => `${r.kind} ${r.key}: holds ${r.holds}, owes ${r.owed}${r.mayOwed ? ` (and up to ${r.mayOwed} on pending rolls)` : ''}${r.open ? '' : ' (not open)'}${r.covers ? '' : ' SHORT'}`).join('; ') };
    });
    // 4. the rest goes back
    if (record.player) await step('send what is left back to the key file’s wallet', async () => {
      const left = await rpc.balance(record.player);
      if (left <= 5000n) return { says: 'nothing left' };
      const s = await sendAs(rpc, player, [transferLamports(player.address, funder.address, left - 5000n)]);
      return { signature: s, explorer: tx(s), returned: left - 5000n, says: `${sol(left - 5000n)} returned` };
    });
    record.finishedAt = new Date().toISOString();
    record.spent = record.steps.find((s) => s.name.startsWith('send what is left'))?.returned !== undefined ? big(record.budget) - big(record.steps.find((s) => s.name.startsWith('send what is left')).returned) : null;
    record.verdict = record.steps.every((s) => s.ok) ? 'ok' : 'problems';
    return json(record);
  }
}
