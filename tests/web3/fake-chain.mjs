// A small fake of the Solana JSON-RPC and the Irys node, for offline tests of the creator flows. It checks every
// signature on what it is sent (so a flow that sends a half-signed transaction fails here), and applies the effects
// the flows rely on: the loot program 0.3's create_game / open_pool / upsert_item / upsert_box / upsert_recipe /
// upsert_schedule / upsert_lottery / open_stake, a shop purchase's order
// (buy_item opens it rolled, settle and refund close it), Metaplex Core's collection, and a Meteora DBC pool with its
// mint and metadata. For the economy calls (gf-web3's economy): buy_tickets adds a line to the lottery, draw_lottery
// draws it at once (first place: ticket `drawTicket`, 0 unless a test sets it), pay_lottery pays places and opens the
// next round, stake / unstake keep the position, enter / claim keep the entries, hold / take_back keep the hold.
// For decisions: pay splits into pools, payout moves a pool's balance to the receiver, update_game names the authority,
// open_contest / decide keep the contest; pay and payout log their receipts (Paid, PaidOut), and getTransaction answers
// with each sent transaction, its time (the fake's clock when it was sent) and its logs.
import { createHash } from 'node:crypto';
import { addressBytes, decodeBase58, encodeBase58 } from '../../builder/web3/gf-web3/chain/base58.js';
import { decodeAccount, decodeBorsh, encodeAccount, encodeBorsh } from '../../builder/web3/gf-web3/chain/borsh.js';
import { concat, fromBase64, readUintLE, toBase64, uintLE, utf8 } from '../../builder/web3/gf-web3/chain/bytes.js';
import { LOOT_IDL, LOOT_PROGRAM, lootPda, lotteryLines, NO_ADDRESS } from '../../builder/web3/gf-web3/chain/loot.js';
import { MPL_CORE_PROGRAM } from '../../builder/web3/gf-web3/chain/core.js';
import { DBC_PROGRAM } from '../../builder/web3/gf-web3/chain/dbc.js';
import { TOKEN_PROGRAM } from '../../builder/web3/gf-web3/chain/pda.js';
import { readMessage, readTransaction } from '../../builder/web3/gf-web3/chain/tx.js';
import { verifySignature } from '../../builder/web3/node/ed25519.mjs';

const json = (value, status = 200) => new Response(JSON.stringify(value, (k, v) => (typeof v === 'bigint' ? Number(v) : v)), { status, headers: { 'content-type': 'application/json' } });
const borshString = (s) => concat(uintLE(utf8(s).length, 4), utf8(s));

export function fakeChain({ irysFree = true } = {}) {
  const accounts = new Map();
  const sent = [];
  const rolls = [];
  const balances = new Map();
  const draw = { ticket: 0n };
  let now = Math.floor(Date.now() / 1000);
  const simulated = [];
  const transactions = new Map();
  let logs = [];
  const emit = (name, value) => {
    const ev = LOOT_IDL.events.find((e) => e.name === name);
    logs.push(`Program data: ${toBase64(concat(Uint8Array.from(ev.discriminator), encodeBorsh(LOOT_IDL, { defined: { name } }, value)))}`);
  };
  const tokenAmount = (address) => {
    const a = accounts.get(address);
    return a && a.data.length >= 72 ? new DataView(a.data.buffer, a.data.byteOffset).getBigUint64(64, true) : 0n;
  };
  const setTokenAmount = (address, amount, mint) => {
    let a = accounts.get(address);
    if (!a) {
      const data = new Uint8Array(165);
      if (mint) data.set(addressBytes(mint), 0);
      put(address, TOKEN_PROGRAM, data);
      a = accounts.get(address);
    }
    new DataView(a.data.buffer, a.data.byteOffset).setBigUint64(64, amount, true);
  };
  const uploads = [];
  const irysBalances = new Map();
  let slot = 1000;
  const blockhash = encodeBase58(createHash('sha256').update('fake blockhash').digest());

  const put = (address, owner, data) => accounts.set(address, { owner, data, lamports: 1_000_000 });
  // Wrapped SOL's mint is always there, as on the real chain.
  const nativeMint = new Uint8Array(82);
  nativeMint[44] = 9;
  nativeMint[45] = 1;
  put('So11111111111111111111111111111111111111112', TOKEN_PROGRAM, nativeMint);
  const rawAccount = (a) => (a ? { owner: a.owner, lamports: a.lamports, data: [toBase64(a.data), 'base64'], executable: false } : null);

  const loot = (address, type, value) => put(address, LOOT_PROGRAM, encodeAccount(LOOT_IDL, type, value));
  const read = (address, type) => decodeAccount(LOOT_IDL, type, accounts.get(address).data);

  function lootEffect(name, args, keys) {
    const ix = LOOT_IDL.instructions.find((i) => i.name === name);
    const names = [];
    const walk = (list) => list.forEach((a) => (a.accounts ? walk(a.accounts) : names.push(a.name)));
    walk(ix.accounts);
    const at = (n) => keys[names.indexOf(n)];
    if (name === 'create_game') {
      loot(at('game'), 'Game', { owner: at('owner'), authority: args.authority, collection: at('collection'), mint: at('mint'), treasury: at('treasury'), bump: 255, fees_bump: 255, paused: false, suspended: false, official: null });
    } else if (name === 'upsert_item') {
      const { issued, voided } = accounts.get(at('item')) ? read(at('item'), 'Item') : { issued: 0, voided: 0 };
      loot(at('item'), 'Item', { ...args.args, game: at('game'), item_id: args.item_id, issued, voided, bump: 255 });
    } else if (name === 'upsert_box') {
      const old = accounts.get(at('loot_box')) ? read(at('loot_box'), 'LootBox') : null;
      loot(at('loot_box'), 'LootBox', { ...args.args, game: at('game'), box_id: args.box_id, opened: 0n, version: old ? old.version + 1 : 0, bump: 255 });
    } else if (name === 'open_pool') {
      const data = new Uint8Array(165);
      data.set(addressBytes(at('mint')), 0);
      data.set(addressBytes(at('game')), 32);
      put(at('pool'), TOKEN_PROGRAM, data);
    } else if (name === 'upsert_recipe') {
      loot(at('recipe'), 'Recipe', { ...args.args, game: at('game'), id: args.id, bump: 255, version: 0 });
    } else if (name === 'upsert_schedule') {
      loot(at('schedule'), 'Schedule', { ...args.args, game: at('game'), id: args.id, bump: 255, runs: 0 });
    } else if (name === 'upsert_lottery') {
      const places = [...args.args.places, ...Array(8 - args.args.places.length).fill(0)];
      loot(at('lottery'), 'Lottery', { ...args.args, places, game: at('game'), id: args.id, bump: 255, round: 0, status: 'Open', sold: 0n, asked_slot: 0n, winner: NO_ADDRESS, first_ticket: 0n, paid: 0, pot_at_payout: 0n });
    } else if (name === 'open_stake') {
      loot(at('stake'), 'Stake', { game: at('game'), id: args.id, bump: 255, mint: at('mint'), rewards_pool: args.rewards_pool, rewards_mint: at('rewards_mint'), lock: args.lock, total: 0n, reward_per_token: 0n });
    } else if (name === 'buy_item') {
      const item = read(at('item'), 'Item');
      loot(at('item'), 'Item', { ...item, issued: item.issued + 1 });
      loot(at('order'), 'Order', {
        game: at('game'), player: at('player'), nonce: args.nonce, mint: at('mint'), loot_box: NO_ADDRESS, box_version: 0, status: 'Rolled',
        outcome: { Item: [args.item_id] }, serial: item.issued + 1, paid: item.price, fee: 2_000_000n, shares: item.shares, requested_slot: BigInt(slot), bump: 255,
      });
    } else if (name === 'open_box') {
      // The oracle answers at once here: `rolls` says how (the box's first entry, unless a test pushed 'Failed').
      const box = read(at('loot_box'), 'LootBox');
      const failed = rolls.shift() === 'Failed';
      loot(at('order'), 'Order', {
        game: at('game'), player: at('player'), nonce: args.nonce, mint: at('mint'), loot_box: at('loot_box'), box_version: box.version, status: failed ? 'Failed' : 'Rolled',
        outcome: failed ? 'Nothing' : box.entries[0].outcome, serial: 1, paid: box.price, fee: 2_000_000n, shares: box.shares, requested_slot: BigInt(slot), bump: 255,
      });
    } else if (name === 'settle' || name === 'settle_prize' || name === 'refund') {
      accounts.delete(at('order'));
    } else if (name === 'buy_tickets') {
      const data = accounts.get(at('lottery')).data;
      const l = read(at('lottery'), 'Lottery');
      const lines = lotteryLines(data);
      const sold = BigInt(l.sold) + args.count;
      const head = encodeAccount(LOOT_IDL, 'Lottery', { ...l, sold });
      put(at('lottery'), LOOT_PROGRAM, concat(head, ...lines.map((x) => concat(addressBytes(x.buyer), uintLE(x.end, 8))), addressBytes(at('player')), uintLE(sold, 8)));
    } else if (name === 'draw_lottery') {
      const data = accounts.get(at('lottery')).data;
      const l = read(at('lottery'), 'Lottery');
      const lines = lotteryLines(data);
      const tail = data.subarray(encodeAccount(LOOT_IDL, 'Lottery', l).length);
      const winner = lines.find((x) => BigInt(x.end) > draw.ticket)?.buyer ?? NO_ADDRESS;
      put(at('lottery'), LOOT_PROGRAM, concat(encodeAccount(LOOT_IDL, 'Lottery', { ...l, status: 'Drawn', first_ticket: draw.ticket, winner }), tail));
    } else if (name === 'pay_lottery') {
      const data = accounts.get(at('lottery')).data;
      const l = read(at('lottery'), 'Lottery');
      const tail = data.subarray(encodeAccount(LOOT_IDL, 'Lottery', l).length);
      const paid = l.paid | (1 << args.place);
      const winners = Math.min(l.places.filter(Boolean).length, Number(l.sold));
      const done = paid.toString(2).split('1').length - 1 >= winners;
      put(at('lottery'), LOOT_PROGRAM, done
        ? encodeAccount(LOOT_IDL, 'Lottery', { ...l, paid: 0, status: 'Open', sold: 0n, winner: NO_ADDRESS, first_ticket: 0n, round: l.round + 1, draws_at: BigInt(l.draws_at) + BigInt(l.every) })
        : concat(encodeAccount(LOOT_IDL, 'Lottery', { ...l, paid }), tail));
    } else if (name === 'stake' || name === 'unstake') {
      const s = read(at('stake'), 'Stake');
      const old = accounts.get(at('position'))?.data;
      const amount = old ? readUintLE(old, 66, 8) : 0n;
      const left = name === 'stake' ? amount + args.amount : amount - args.amount;
      loot(at('stake'), 'Stake', { ...s, total: BigInt(s.total) + (name === 'stake' ? args.amount : -args.amount) });
      if (left === 0n) accounts.delete(at('position'));
      else put(at('position'), LOOT_PROGRAM, concat(Uint8Array.of(10), addressBytes(at('stake')), addressBytes(at('player')), Uint8Array.of(255), uintLE(left, 8), uintLE(name === 'stake' ? BigInt(now) : readUintLE(old, 74, 8), 8), uintLE(0n, 16)));
    } else if (name === 'enter') {
      const c = read(at('contest'), 'Contest');
      const old = accounts.get(at('entry')) ? read(at('entry'), 'Entry').amount : 0n;
      loot(at('entry'), 'Entry', { contest: at('contest'), player: at('player'), side: args.side, bump: 255, amount: BigInt(old) + args.amount });
      loot(at('contest'), 'Contest', { ...c, entries: c.entries + (old ? 0 : 1), sides: c.sides.map((v, i) => (i === args.side ? BigInt(v) + args.amount : v)) });
    } else if (name === 'claim') {
      accounts.delete(at('entry'));
    } else if (name === 'hold') {
      loot(at('hold'), 'Hold', { game: at('game'), asset: at('asset'), player: at('player'), free_at: BigInt(now) + args.seconds, reference: args.reference, bump: 255 });
    } else if (name === 'take_back' || name === 'award') {
      accounts.delete(at('hold'));
    } else if (name === 'update_game') {
      const g = read(at('game'), 'Game');
      const u = args.update;
      const newOwner = at('new_owner');
      loot(at('game'), 'Game', { ...g, ...(newOwner && newOwner !== LOOT_PROGRAM ? { owner: newOwner } : {}), ...(u.authority ? { authority: u.authority } : {}), ...(u.paused !== null && u.paused !== undefined ? { paused: u.paused } : {}) });
    } else if (name === 'pay') {
      const game = at('game');
      const g = read(game, 'Game');
      let left = args.amount;
      const pools = [];
      for (const share of args.shares) {
        const part = (args.amount * BigInt(share.bps)) / 10_000n;
        left -= part;
        if (share.to.Pool) pools.push([share.to.Pool[0], part]);
      }
      for (const [index, part] of pools) {
        const pool = lootPda.pool(game, index);
        setTokenAmount(pool, tokenAmount(pool) + part, at('mint'));
      }
      emit('Paid', { game, player: at('player'), mint: at('mint'), amount: args.amount, shares: args.shares, to_treasury: left, reference: args.reference });
      if (g.paused) throw new Error('Paused');
    } else if (name === 'payout') {
      const have = tokenAmount(at('pool'));
      if (have < args.amount) throw new Error('custom program error: insufficient funds');
      if (read(at('game'), 'Game').authority !== at('authority')) throw new Error('NotAuthority');
      setTokenAmount(at('pool'), have - args.amount);
      setTokenAmount(at('to'), tokenAmount(at('to')) + args.amount, at('mint'));
      emit('PaidOut', { game: at('game'), authority: at('authority'), pool: args.index, to: at('to'), amount: args.amount, reference: args.reference });
    } else if (name === 'open_contest') {
      loot(at('contest'), 'Contest', { game: at('game'), id: args.id, bump: 255, opener: at('authority'), mint: at('mint'), closes_at: args.args.closes_at, result_by: args.args.result_by, terms: new Uint8Array(32), verdict: 'Open', winner: 0, entries: 0, prize: 0n, unclaimed: 0n, shares: args.args.shares, sides: Array(args.args.sides).fill(0n) });
    } else if (name === 'decide') {
      const c = read(at('contest'), 'Contest');
      if (read(at('game'), 'Game').authority !== at('authority')) throw new Error('NotAuthority');
      loot(at('contest'), 'Contest', { ...c, verdict: 'Won', winner: args.side });
    }
  }

  function decodeLootIx(data) {
    const ix = LOOT_IDL.instructions.find((i) => i.discriminator.every((b, j) => data[j] === b));
    if (!ix) throw new Error('unknown loot instruction');
    let at = 8;
    const args = {};
    for (const arg of ix.args) [args[arg.name], at] = decodeBorsh(LOOT_IDL, arg.type, data, at);
    return { name: ix.name, args };
  }

  function apply(wire, { verify }) {
    const { message, signatures, signers } = readTransaction(wire);
    if (verify) signers.forEach((s, i) => {
      if (!verifySignature(s, message, signatures[i])) throw Object.assign(new Error(`Transaction signature verification failure for ${s}`), { code: -32003 });
    });
    const m = readMessage(message);
    if (m.blockhash !== blockhash) throw new Error('Blockhash not found');
    const effects = [];
    for (const ix of m.instructions) {
      const program = m.keys[ix.programIndex];
      const keys = ix.accountIndexes.map((i) => m.keys[i]);
      if (program === LOOT_PROGRAM) effects.push(() => {
        const { name, args } = decodeLootIx(ix.data);
        lootEffect(name, args, keys);
      });
      if (program === MPL_CORE_PROGRAM && ix.data[0] === 21) effects.push(() => {
        let at = 1;
        const nameLen = Number(new DataView(ix.data.buffer, ix.data.byteOffset + at, 4).getUint32(0, true));
        const name = new TextDecoder().decode(ix.data.subarray(at + 4, at + 4 + nameLen));
        at += 4 + nameLen;
        const uriLen = new DataView(ix.data.buffer, ix.data.byteOffset + at, 4).getUint32(0, true);
        const uri = new TextDecoder().decode(ix.data.subarray(at + 4, at + 4 + uriLen));
        put(keys[0], MPL_CORE_PROGRAM, concat(Uint8Array.of(5), addressBytes(keys[1]), borshString(name), borshString(uri), uintLE(0, 4), uintLE(0, 4)));
      });
      // createConfig: a PoolConfig with the fields the launch reads back (quote, fee claimer, leftover receiver, the split).
      if (program === DBC_PROGRAM && ix.data.length > 8 && [201, 207, 243, 114].every((b, j) => ix.data[j] === b)) effects.push(() => {
        const [config, feeClaimer, leftover, quoteMint] = keys;
        const d = ix.data;
        const at = 8 + 27 + (d[8 + 27] === 1 ? 33 : 1); // past the base fee and the optional dynamic fee
        const cfg = new Uint8Array(1048);
        cfg.set([26, 108, 14, 123, 116, 230, 129, 43]);
        cfg.set(addressBytes(quoteMint), 8);
        cfg.set(addressBytes(feeClaimer), 40);
        cfg.set(addressBytes(leftover), 72);
        cfg[234] = d[at + 2]; // activation type
        cfg[235] = d[at + 4]; // token decimal
        cfg[237] = d[at + 3]; // token type
        cfg[239] = d[at + 6]; // partner permanently locked LP
        cfg[240] = d[at + 5];
        cfg[241] = d[at + 8]; // creator permanently locked LP
        cfg[242] = d[at + 7];
        cfg.set(d.subarray(at + 9, at + 17), 264); // migration quote threshold
        const fees = at + 9 + 8 + 16 + 40 + 1 + (d[at + 9 + 8 + 16 + 40 + 1] === 1 ? 17 : 1);
        cfg[245] = d[fees]; // creator trading fee
        cfg[248] = d[fees + 3]; // creator migration fee
        put(config, DBC_PROGRAM, cfg);
      });
      if (program === DBC_PROGRAM && ix.data.length > 8 && [140, 85, 215, 176].every((b, j) => ix.data[j] === b)) effects.push(() => {
        const [config, , creator, baseMint, , pool, , , mintMetadata] = keys;
        const vp = new Uint8Array(424);
        vp.set([213, 224, 5, 209, 98, 69, 119, 92]);
        vp.set(addressBytes(config), 72);
        vp.set(addressBytes(creator), 104);
        vp.set(addressBytes(baseMint), 136);
        put(pool, DBC_PROGRAM, vp);
        const mint = new Uint8Array(82);
        mint[44] = 6;
        mint[45] = 1;
        put(baseMint, TOKEN_PROGRAM, mint);
        let at = 8;
        const read = () => {
          const n = new DataView(ix.data.buffer, ix.data.byteOffset + at, 4).getUint32(0, true);
          const s = new TextDecoder().decode(ix.data.subarray(at + 4, at + 4 + n));
          at += 4 + n;
          return s;
        };
        const [name, symbol, uri] = [read(), read(), read()];
        put(mintMetadata, 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s', concat(Uint8Array.of(4), addressBytes(creator), addressBytes(baseMint), borshString(name), borshString(symbol), borshString(uri)));
      });
    }
    return { effects, signature: encodeBase58(signatures[0]), m, wire };
  }

  async function rpc(body) {
    const { method, params, id } = body;
    const ok = (result) => json({ jsonrpc: '2.0', id, result });
    const err = (message, code = -32002) => json({ jsonrpc: '2.0', id, error: { code, message } });
    switch (method) {
      case 'getLatestBlockhash':
        return ok({ context: { slot }, value: { blockhash, lastValidBlockHeight: 10_000 } });
      case 'getBlockHeight':
        return ok(500);
      case 'getSlot':
        return ok(slot);
      case 'getMultipleAccounts':
        return ok({ context: { slot }, value: params[0].map((a) => rawAccount(accounts.get(a))) });
      case 'getAccountInfo':
        return ok({ context: { slot }, value: rawAccount(accounts.get(params[0])) });
      case 'getProgramAccounts': {
        const [program, { filters = [] } = {}] = params;
        const match = (data) =>
          filters.every((f) => {
            if (f.dataSize !== undefined) return data.length === f.dataSize;
            const want = decodeBase58(f.memcmp.bytes);
            return want.every((b, i) => data[f.memcmp.offset + i] === b);
          });
        return ok([...accounts.entries()].filter(([, a]) => a.owner === program && match(a.data)).map(([pubkey, a]) => ({ pubkey, account: rawAccount(a) })));
      }
      case 'getMinimumBalanceForRentExemption':
        return ok((params[0] + 128) * 5080);
      case 'getSignaturesForAddress':
        return ok(sent.slice(-(params[1]?.limit ?? 10)).reverse().map((signature) => ({ signature, slot, err: null, blockTime: 1_800_000_000 })));
      case 'getTransaction': {
        const t = transactions.get(params[0]);
        if (!t) return ok(sent.includes(params[0]) ? { meta: { logMessages: [] } } : null);
        return ok({ slot, blockTime: t.blockTime, transaction: params[1]?.encoding === 'base64' ? [toBase64(t.wire), 'base64'] : { signatures: [params[0]] }, meta: { err: null, logMessages: t.logs } });
      }
      case 'getBalance':
        return ok({ context: { slot }, value: balances.get(params[0]) ?? 5_000_000_000 });
      case 'getTokenAccountBalance': {
        const a = accounts.get(params[0]);
        if (!a) return err('Invalid param: could not find account', -32602);
        return ok({ context: { slot }, value: { amount: String(new DataView(a.data.buffer, a.data.byteOffset).getBigUint64(64, true)), decimals: 6 } });
      }
      case 'simulateTransaction': {
        try {
          const { m } = apply(fromBase64(params[0]), { verify: params[1]?.sigVerify !== false });
          simulated.push(m);
          const watch = params[1]?.accounts?.addresses ?? [];
          const token = (amount) => {
            const d = new Uint8Array(165);
            new DataView(d.buffer).setBigUint64(64, amount, true);
            return { owner: TOKEN_PROGRAM, lamports: 2039280, data: [toBase64(d), 'base64'], executable: false };
          };
          return ok({ context: { slot }, value: { err: null, logs: ['Program log: ok'], unitsConsumed: 123456, accounts: watch.map(() => token(47_388_825_736_462n)) } });
        } catch (e) {
          return ok({ context: { slot }, value: { err: { InstructionError: [0, 'Custom'] }, logs: [`Program log: ${e.message}`], unitsConsumed: 0 } });
        }
      }
      case 'sendTransaction': {
        try {
          const wire = fromBase64(params[0]);
          const { effects, signature } = apply(wire, { verify: true });
          const before = new Map([...accounts].map(([k, a]) => [k, { ...a, data: a.data.slice() }]));
          logs = [];
          try {
            for (const e of effects) e();
          } catch (e) {
            accounts.clear();
            for (const [k, a] of before) accounts.set(k, a);
            throw e;
          }
          transactions.set(signature, { wire, blockTime: now, logs });
          sent.push(signature);
          return ok(signature);
        } catch (e) {
          return err(e.message, e.code ?? -32002);
        }
      }
      case 'getSignatureStatuses':
        return ok({ context: { slot }, value: params[0].map((s) => (sent.includes(s) ? { slot, confirmations: 1, err: null, confirmationStatus: 'confirmed' } : null)) });
      default:
        return err(`fake chain: no ${method}`);
    }
  }

  async function irys(url, init) {
    const u = new URL(url);
    if (u.pathname.startsWith('/price/')) return new Response('39874');
    if (u.pathname === '/info') return json({ addresses: { solana: '4a7s9iC5NwfUtf8fXpKWxYXcekfqiN6mRqipYXMtcrUS' } });
    if (u.pathname === '/account/balance/solana' && init?.method === 'POST') return json({ confirmed: true });
    if (u.pathname === '/account/balance/solana') return json({ balance: String(irysBalances.get(u.searchParams.get('address')) ?? 0) });
    if (u.pathname === '/tx/solana' && init?.method === 'POST') {
      const bytes = new Uint8Array(init.body);
      if (!irysFree && bytes.length > 1000) return new Response('Not enough balance for transaction', { status: 402 });
      const id = encodeBase58(createHash('sha256').update(bytes.subarray(2, 66)).digest());
      uploads.push({ id, bytes });
      return json({ id, timestamp: Date.now() });
    }
    return new Response('not found', { status: 404 });
  }

  const fetchImpl = async (url, init = {}) => {
    if (String(url).startsWith('https://devnet.irys.xyz')) return irys(String(url), init);
    return rpc(JSON.parse(init.body));
  };
  return {
    fetchImpl, accounts, put, sent, transactions, tokenAmount, setTokenAmount, simulated, uploads, irysBalances, blockhash, rolls, balances, draw,
    /** The fake's clock (Unix seconds) for holds and stakes; tests pass the same to gf-web3 as `now`. */
    get now() {
      return now;
    },
    set now(value) {
      now = value;
    },
  };
}
