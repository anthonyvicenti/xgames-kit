// A local Solana for the full simulation: LiteSVM with the real loot program 0.3, Metaplex Core and MagicBlock's VRF,
// devnet's loot platform record and VRF queue, a clock the simulation moves, and an `rpc` object with the methods the
// in-game kit's economy calls use (builder/web3/gf-web3/econ/play.js), so the same code a game runs drives the program here.
//
// Signatures are not checked (LiteSVM's sigverify is off): a player, the owner or the authority is just an address
// marked as a signer, and nothing needs a key. That is also how the oracle is played: MagicBlock's oracle cannot run
// here, so after a transaction asks for randomness, `send` answers it at once with the loot program's own callback,
// signed by the VRF identity the program checks (`["identity", loot]` under the VRF program), with randomness from the
// simulation's seeded generator. The oracle would have taken the request off its queue; the queue account goes back
// to the bytes it had before (the fee it was paid stays in its balance). Exactly what the program's own LiteSVM tests
// do (program/loot/programs/loot/tests/common/mod.rs).
import { createHash } from 'node:crypto';
import { decodeBase58, encodeBase58 } from '../../gf-web3/chain/base58.js';
import { readUintLE, uintLE } from '../../gf-web3/chain/bytes.js';
import { MPL_CORE_PROGRAM } from '../../gf-web3/chain/core.js';
import { decodeLoot, LOOT_IDL, LOOT_PROGRAM, lootIx, lootPda, LootAccount, VRF_PROGRAM, VRF_QUEUE } from '../../gf-web3/chain/loot.js';
import { METAPLEX_METADATA_PROGRAM, pdaOf, TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from '../../gf-web3/chain/pda.js';
import { meta } from '../../gf-web3/chain/programs.js';
import { compileMessage, readMessage, signersOf } from '../../gf-web3/chain/tx.js';
import { programError } from '../../gf-web3/rpc.js';

export const SIGNATURE_LAMPORTS = 5_000n;
/** Slots are about 400 ms. */
const SLOTS_PER_SECOND = 2.5;
const TOKEN_PROGRAMS = new Set([TOKEN_PROGRAM, TOKEN_2022_PROGRAM]);
/** LiteSVM's transaction errors without fields, by number (its TransactionErrorFieldless). */
const TX_ERRORS = ['AccountInUse', 'AccountLoadedTwice', 'AccountNotFound', 'ProgramAccountNotFound', 'InsufficientFundsForFee', 'InvalidAccountForFee', 'AlreadyProcessed', 'BlockhashNotFound', 'CallChainTooDeep', 'MissingSignatureForFee', 'InvalidAccountIndex', 'SignatureFailure', 'InvalidProgramForExecution (a program the transaction calls is not loaded)', 'SanitizeFailure'];

/** A fresh address nobody holds a key to (none is needed: signatures are not checked). */
export const newAddress = (random) => encodeBase58(random(32));

/** A seeded byte generator: the same seed gives the same run. */
export function seeded(seed = 'gamesfun') {
  let counter = 0n;
  let pool = new Uint8Array(0);
  return (n) => {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      if (!pool.length) {
        pool = createHash('sha256').update(`${seed}:${counter++}`).digest();
      }
      out[i] = pool[0];
      pool = pool.subarray(1);
    }
    return out;
  };
}

/** The VRF identity the loot program's callbacks must be signed by. */
export const vrfIdentity = () => pdaOf([new TextEncoder().encode('identity'), decodeBase58(LOOT_PROGRAM)], VRF_PROGRAM);

/** sha256("ticket" ‖ key ‖ slot): the ticket a callback names (order.rs `ticket_of`). */
const ticketOf = (key, slot) => encodeBase58(createHash('sha256').update(Buffer.concat([Buffer.from('ticket'), Buffer.from(decodeBase58(key)), Buffer.from(uintLE(BigInt(slot), 8))])).digest());

/** Each loot instruction's 8-byte discriminator → its IDL entry and its accounts, flattened in order. */
const BY_DISCRIMINATOR = new Map(
  LOOT_IDL.instructions.map((def) => {
    const names = [];
    const walk = (list) => list.forEach((a) => (a.accounts ? walk(a.accounts) : names.push(a.name)));
    walk(def.accounts);
    return [Buffer.from(def.discriminator).toString('hex'), { name: def.name, names }];
  }),
);
export const lootName = (ix) => (ix.programId === LOOT_PROGRAM ? BY_DISCRIMINATOR.get(Buffer.from(ix.data.subarray(0, 8)).toString('hex')) ?? null : null);

/**
 * The tokens a transaction moved, read from its token-program instructions (its own and the ones programs made):
 * [{ kind: 'transfer' | 'mint' | 'burn', from, to, mint, amount }]. Gross, not net: a settle that pays a prize out of
 * a pool and the box's share into it shows both.
 */
function tokenMoves(keys, instructions, before) {
  const out = [];
  const mintOf = (account) => before.get(account)?.token?.mint ?? null;
  for (const { program, accounts, data } of instructions) {
    if (!TOKEN_PROGRAMS.has(program) || data.length < 9) continue;
    const amount = readUintLE(data, 1, 8);
    const a = (i) => keys[accounts[i]];
    switch (data[0]) {
      case 3:
        out.push({ kind: 'transfer', from: a(0), to: a(1), mint: mintOf(a(0)), amount });
        break;
      case 12:
        out.push({ kind: 'transfer', from: a(0), to: a(2), mint: a(1), amount });
        break;
      case 7:
      case 14:
        out.push({ kind: 'mint', from: null, to: a(1), mint: a(0), amount });
        break;
      case 8:
      case 15:
        out.push({ kind: 'burn', from: a(0), to: null, mint: a(1), amount });
        break;
      default:
    }
  }
  return out;
}

/** A token account's mint, owner and amount (classic and Token-2022 share these offsets). */
export function tokenAccount(account) {
  if (!account || !TOKEN_PROGRAMS.has(account.owner) || account.data.length < 165) return null;
  return { mint: encodeBase58(account.data.subarray(0, 32)), owner: encodeBase58(account.data.subarray(32, 64)), amount: readUintLE(account.data, 64, 8) };
}
/** A mint's supply and decimals. */
export function mintAccount(account) {
  if (!account || !TOKEN_PROGRAMS.has(account.owner) || account.data.length < 82 || account.data.length === 165) return null;
  if (account.data.length > 165 && account.data[165] !== 1) return null; // Token-2022 account type: 1 = mint
  return { supply: readUintLE(account.data, 36, 8), decimals: account.data[44] };
}

/**
 * The local chain. `bins` from cache.mjs simBinaries(); `start` the unix time the clock starts at; `random` the seeded
 * generator; `onSent(record)` sees every landed transaction with each account it named, before and after.
 */
export function simChain({ LiteSVM, Rent, bins, start, random, onSent = () => {} }) {
  const svm = new LiteSVM();
  if (Rent && bins.rent) svm.setRent(new Rent(bins.rent.lamportsPerByteYear, bins.rent.exemptionThreshold, bins.rent.burnPercent));
  svm.withSigverify(false);
  svm.withBlockhashCheck(false);
  svm.withTransactionHistory(0n);
  svm.withNativeMints();
  svm.addProgram(LOOT_PROGRAM, bins.loot.bytes);
  svm.addProgram(MPL_CORE_PROGRAM, bins.core.bytes);
  svm.addProgram(VRF_PROGRAM, bins.vrf.bytes);
  if (bins.metadata) svm.addProgram(METAPLEX_METADATA_PROGRAM, bins.metadata.bytes);
  const put = (address, { owner, lamports, data, executable = false }) => svm.setAccount({ address, lamports: BigInt(lamports), data: Uint8Array.from(data), programAddress: owner, executable });
  put(VRF_QUEUE, bins.queue);
  put(lootPda.platform(), bins.platform);
  const queueBytes = Uint8Array.from(bins.queue.data);
  const startSlot = 400_000_000n;
  let now = start;
  const setClock = () => {
    const clock = svm.getClock();
    clock.unixTimestamp = BigInt(now);
    clock.slot = startSlot + BigInt(Math.floor((now - start) * SLOTS_PER_SECOND));
    svm.setClock(clock);
  };
  setClock();
  const oracle = newAddress(random);
  svm.airdrop(oracle, 1_000_000_000_000n);
  const identity = vrfIdentity();
  /** Every Core asset a transaction touched, by its owner, so a search for a player's collectibles reads only those. */
  const coreOwner = new Map();
  const coreByOwner = new Map();
  const trackCore = (asset, account) => {
    const was = coreOwner.get(asset);
    const owner = account?.owner === MPL_CORE_PROGRAM && account.size > 33 ? account.holder : null;
    if (was === owner) return;
    if (was) coreByOwner.get(was)?.delete(asset);
    if (owner) {
      coreOwner.set(asset, owner);
      if (!coreByOwner.has(owner)) coreByOwner.set(owner, new Set());
      coreByOwner.get(owner).add(asset);
    } else coreOwner.delete(asset);
  };

  function get(address) {
    const a = svm.getAccount(address);
    return a.exists ? { owner: a.programAddress, lamports: a.lamports, data: a.data, executable: a.executable } : null;
  }

  /** Lamports and token amounts of these accounts, as one snapshot. */
  function snapshot(keys) {
    const out = new Map();
    for (const k of keys) {
      const a = get(k);
      out.set(k, a ? { lamports: a.lamports, owner: a.owner, token: tokenAccount(a), mint: mintAccount(a), size: a.data.length, holder: a.owner === MPL_CORE_PROGRAM && a.data.length > 33 ? encodeBase58(a.data.subarray(1, 33)) : null } : null);
    }
    return out;
  }

  /** Compile, send, and throw the program's own words when it fails. Returns the transaction's id. */
  function sendRaw(payer, instructions, { label = '', role = 'player' } = {}) {
    const message = compileMessage({ payer, blockhash: svm.latestBlockhash(), instructions });
    const signers = signersOf(message);
    const keys = [...new Set([payer, ...instructions.flatMap((ix) => [ix.programId, ...ix.keys.map((k) => k.pubkey)])])];
    const before = snapshot(keys);
    const signatures = Object.fromEntries(signers.map((s) => [s, random(64)]));
    const result = svm.sendTransaction({ messageBytes: message, signatures });
    const failed = typeof result.err === 'function';
    const logs = (failed ? result.meta() : result).logs();
    if (failed) {
      const err = result.err();
      const said = typeof err === 'number' ? (TX_ERRORS[err] ?? `transaction error ${err}`) : String(err?.toString?.() ?? 'failed');
      throw Object.assign(new Error(programError(said, logs)), { logs, label });
    }
    const after = snapshot(keys);
    for (const k of keys) if (after.get(k)?.owner === MPL_CORE_PROGRAM || coreOwner.has(k)) trackCore(k, after.get(k));
    const id = encodeBase58(signatures[signers[0]]);
    const { keys: ordered, instructions: compiled } = readMessage(message);
    const run = [];
    const inner = result.innerInstructions();
    compiled.forEach((ix, i) => {
      run.push({ program: ordered[ix.programIndex], accounts: ix.accountIndexes, data: ix.data });
      for (const x of inner[i] ?? []) {
        const c = x.instruction();
        run.push({ program: ordered[c.programIdIndex()], accounts: Array.from(c.accounts()), data: c.data() });
      }
    });
    const moves = tokenMoves(ordered, run, new Map([...before].map(([k, v]) => [k, v ?? after.get(k)])));
    onSent({ id, payer, role, label, signatures: signers.length, instructions, keys, before, after, moves, logs, at: now });
    return id;
  }

  /** The oracle answers what this transaction asked for: a box's roll, a lottery's draw, the authority's roll. */
  function answer(instructions, label) {
    for (const ix of instructions) {
      const known = lootName(ix);
      if (!known || !['open_box', 'draw_lottery', 'roll'].includes(known.name)) continue;
      const account = (name) => ix.keys[known.names.indexOf(name)]?.pubkey;
      const randomness = random(32);
      const restoreQueue = () => {
        const q = get(VRF_QUEUE);
        put(VRF_QUEUE, { ...q, data: queueBytes });
      };
      if (known.name === 'open_box') {
        const order = account('order');
        const o = decodeLoot(LootAccount.Order, get(order).data);
        const box = get(o.loot_box);
        const entries = decodeLoot(LootAccount.Box, box.data).entries;
        const game = o.game;
        const entryKeys = entries.flatMap((e) => (e.outcome?.Item ? [meta(lootPda.item(game, e.outcome.Item[0]), false, true)] : e.outcome?.Pay || e.outcome?.Share ? [meta(lootPda.pool(game, (e.outcome.Pay ?? e.outcome.Share).pool), false, false)] : []));
        const callback = lootIx('callback_roll', { randomness }, { vrf_program_identity: identity, order, loot_box: o.loot_box, ticket: ticketOf(order, o.requested_slot) }, entryKeys);
        restoreQueue();
        sendRaw(oracle, [callback], { label: `${label} (oracle)`, role: 'oracle' });
      } else if (known.name === 'draw_lottery') {
        const lottery = account('lottery');
        const l = decodeLoot(LootAccount.Lottery, get(lottery).data);
        restoreQueue();
        if (l.status !== 'Drawing') continue;
        sendRaw(oracle, [lootIx('callback_lottery', { randomness }, { vrf_program_identity: identity, lottery, ticket: ticketOf(lottery, l.asked_slot) })], { label: `${label} (oracle)`, role: 'oracle' });
      } else {
        const game = account('game');
        const reference = encodeBase58(ix.data.subarray(8, 40));
        restoreQueue();
        sendRaw(oracle, [lootIx('callback_random', { randomness }, { vrf_program_identity: identity, game, reference })], { label: `${label} (oracle)`, role: 'oracle' });
      }
    }
  }

  /** Send as `payer` (signers: other addresses or { address } that sign too; their signatures are not checked). */
  function send(payer, instructions, { label = '', role = 'player' } = {}) {
    const id = sendRaw(payer, instructions, { label, role });
    answer(instructions, label);
    return id;
  }

  const memcmp = (data, { offset, bytes }) => {
    const want = decodeBase58(bytes);
    if (data.length < offset + want.length) return false;
    for (let i = 0; i < want.length; i++) if (data[offset + i] !== want[i]) return false;
    return true;
  };
  const matches = (data, filters = []) => filters.every((f) => (f.memcmp ? memcmp(data, f.memcmp) : f.dataSize !== undefined ? data.length === f.dataSize : true));

  /** The methods of gf-web3's rpc client that the economy calls use, answered from the local chain. */
  const rpc = {
    url: 'litesvm:',
    async accounts(addresses) {
      return addresses.map((a) => {
        const x = get(a);
        return x ? { ...x, lamports: Number(x.lamports) } : null;
      });
    },
    async account(address) {
      return (await rpc.accounts([address]))[0];
    },
    async balance(address) {
      return get(address)?.lamports ?? 0n;
    },
    async tokenBalance(address) {
      return tokenAccount(get(address))?.amount ?? 0n;
    },
    async programAccounts(program, filters) {
      const found =
        program === MPL_CORE_PROGRAM
          ? [...(filters?.find((f) => f.memcmp?.offset === 1) ? coreByOwner.get(filters.find((f) => f.memcmp?.offset === 1).memcmp.bytes) ?? [] : coreOwner.keys())].map((pubkey) => ({ pubkey, account: get(pubkey) })).filter((x) => x.account)
          : svm.getProgramAccounts(program).map((a) => ({ pubkey: a.address, account: { owner: a.programAddress, lamports: a.lamports, data: a.data, executable: a.executable } }));
      return found.filter((x) => matches(x.account.data, filters)).map((x) => ({ pubkey: x.pubkey, account: { ...x.account, lamports: Number(x.account.lamports) } }));
    },
    async latestBlockhash() {
      return { blockhash: svm.latestBlockhash(), lastValidBlockHeight: Number.MAX_SAFE_INTEGER };
    },
    async call(method, params = []) {
      if (method === 'getSlot') return Number(svm.getClock().slot);
      if (method === 'getMinimumBalanceForRentExemption') return Number(svm.minimumBalanceForRentExemption(BigInt(params[0])));
      if (method === 'getSignaturesForAddress') return [];
      if (method === 'getTransaction') return null;
      throw new Error(`The local chain does not answer ${method}.`);
    },
  };

  return {
    svm,
    rpc,
    oracle,
    identity,
    get,
    put,
    send,
    snapshot,
    /** Where the clock is (unix seconds) and moving it forward. */
    now: () => now,
    warp(to) {
      if (to > now) {
        now = Math.floor(to);
        setClock();
        svm.expireBlockhash();
      }
    },
    fund(address, lamports) {
      const a = get(address);
      put(address, { owner: a?.owner ?? '11111111111111111111111111111111', lamports: (a?.lamports ?? 0n) + BigInt(lamports), data: a?.data ?? new Uint8Array(0), executable: false });
    },
    rent: (bytes) => svm.minimumBalanceForRentExemption(BigInt(bytes)),
  };
}
