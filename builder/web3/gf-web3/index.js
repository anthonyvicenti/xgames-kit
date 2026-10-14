// gf-web3: the games.fun in-game kit. Optional wallet sign-in, the player's items from this game's collection,
// the game's economy (econ/play.js: buy, boxes, recipes, lotteries, stakes, contests, holds) and its token, all from
// the game's public gamesfun.json (its `economy` section; an older `shop` reads as the economy it stands for). Guests play without a
// wallet; nothing asks for one until the player presses something that needs it. Owned items' looks become a
// gf-three loadout (CONTRACT §6e), so everyone in a multiplayer match sees what each player wears.
//
//   import gfWeb3 from './gf/web3/index.js';
//   await gfWeb3.ready();                        // reads ./gamesfun.json
//   const items = await gfWeb3.shop.list();      // what is on sale, priced in the shop's currency
//   await gfWeb3.shop.buy(items[0].id);          // two wallet approvals: pay, then claim (the collectible is minted)
//   await gfWeb3.wearOwned();                    // the owned items' looks → window.__GF_LOADOUT
//
// Mock mode (no network, a pretend wallet, deterministic rolls) runs when the page is automated or headless
// (navigator.webdriver, HeadlessChrome: gf-three verify stays deterministic) or with ?gamesfun_mock=1.
// ?gamesfun_mock=0 forces the real chain. ?gamesfun_owned=1,2 gives the mock wallet items to start with.
//
// Reads go to the public devnet RPC, which rate-limits (about 100 requests per 10 s per IP) and has no DAS API, so
// ownedItems() asks getProgramAccounts for this collection's Core assets owned by the player (filtered on the node,
// about one call per refresh). Call it on connect and after a purchase, not every frame. A game may pass its own
// public, keyless RPC with configure({ rpc }); never put a keyed RPC URL in a game: everything in it is public.
import { encodeBase58, isAddress } from './chain/base58.js';
import { utf8 } from './chain/bytes.js';
import { ownedAssetFilters, parseCoreAsset, MPL_CORE_PROGRAM } from './chain/core.js';
import { decodeLoot, LOOT_PROGRAM, LootAccount, lootPda } from './chain/loot.js';
import { sha256 } from './chain/sha256.js';
import { compileMessage, readTransaction, wireTransaction, withSignature, transactionId } from './chain/tx.js';
import { CONFIG_FILE, emptyConfig, parseConfig } from './config.js';
import { economyState, parseActionId, playerActions } from './econ/actions.js';
import { economyPlay } from './econ/play.js';
import { economyFromShop } from './econ/shop.js';
import { readEconomy, toUnits } from './econ/spec.js';
import { loadoutOf } from './looks.js';
import { networkConfig } from './network.js';
import { rpcClient } from './rpc.js';
import { secretLike } from './rules.js';
import * as walletKit from './wallet.js';

import { VERSION } from './version.js';

export { VERSION, economyState, parseActionId, playerActions };

const MESSAGE = {
  NoWallet: 'No Solana wallet found in this browser. Install one (Phantom, Solflare, Backpack…) and reload.',
  Cancelled: 'No wallet chosen.',
  NoItem: (sku) => `There is no item ${sku} in this game.`,
  NotForSale: (name) => `${name} is not sold directly; it comes from loot boxes.`,
  NoBox: (id) => `There is no box ${id} in this game.`,
};

/** Deterministic randomness for the mock (mulberry32). */
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A kit instance. In a game page, use the default export. Options (tests and special hosts):
 * { config, configUrl, fetchImpl, location, navigator, wallets (array of Wallet Standard wallets), mock, rpc, storage, win }
 */
export function createGfWeb3(options = {}) {
  const win = options.win ?? (typeof window === 'undefined' ? null : window);
  const loc = options.location ?? win?.location ?? null;
  const nav = options.navigator ?? (typeof navigator === 'undefined' ? null : navigator);
  const query = new URLSearchParams(loc?.search ?? '');
  const forced = query.get('gamesfun_mock');
  const automated = Boolean(nav?.webdriver) || /HeadlessChrome/.test(nav?.userAgent ?? '');
  const fetchImpl = options.fetchImpl ?? globalThis.fetch?.bind(globalThis);
  const network = networkConfig('devnet');
  const state = {
    mock: options.mock ?? (forced === '1' ? true : forced === '0' ? false : automated || win?.__GF_WEB3_MOCK === true),
    config: options.config ? parseConfig(JSON.stringify(options.config)) : null,
    loading: null,
    rpcUrl: options.rpc ?? null,
    wallet: null,
    account: null,
    mockAddress: null,
    mockOwned: [],
    mockOpened: 0,
    worn: null,
    listeners: new Map(),
  };
  const storage = options.storage ?? (() => {
    try {
      return win?.localStorage ?? null;
    } catch {
      return null;
    }
  })();

  const emit = (event, detail) => {
    for (const fn of state.listeners.get(event) ?? []) {
      try {
        fn(detail);
      } catch (error) {
        console.error(error);
      }
    }
  };
  const status = (text) => emit('status', text);
  const rpc = () => rpcClient(state.rpcUrl ?? network.rpcUrl, fetchImpl ? { fetchImpl } : {});
  const mockAddress = encodeBase58(sha256(utf8('gamesfun mock player')));

  async function loadConfig() {
    if (state.config) return state.config;
    try {
      const url = options.configUrl ?? new URL(CONFIG_FILE, loc?.href ?? 'http://localhost/').toString();
      const response = await fetchImpl(url, { cache: 'no-store' });
      return response.ok ? parseConfig(await response.text()) : emptyConfig();
    } catch (error) {
      if (/network this kit does not support|unknown version|not valid JSON/.test(error.message)) console.warn(`gf-web3: ${error.message}`);
      return emptyConfig();
    }
  }

  const ownedOf = (item, asset, serial) => ({
    id: item.id,
    key: item.key ?? null,
    name: item.name,
    description: item.description ?? '',
    rarity: item.rarity ?? 'Common',
    look: item.look ?? null,
    image: item.image ?? null,
    serial,
    asset,
  });

  /** Read gamesfun.json (once) and get ready. Call it before anything else; it never throws. */
  async function ready() {
    state.loading ??= loadConfig().then((loaded) => {
      // Every call reads the economy section; a game that still has an old `shop` gets the economy it stands for.
      const fromShop = economyFromShop(loaded);
      const config = fromShop ? { ...loaded, economy: fromShop } : loaded;
      state.config = config;
      if (state.mock) {
        const wanted = (query.get('gamesfun_owned') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
        state.mockOwned = wanted.map((sku) => findItem(config, sku)).filter(Boolean).map((item, i) => ownedOf(item, `mock-asset-${i + 1}`, i + 1));
      } else {
        walletKit.listenForWallets();
        for (const w of options.wallets ?? []) walletKit.registerWallet(w);
      }
      return config;
    });
    return state.loading;
  }

  const address = () => (state.mock ? state.mockAddress : (state.account?.address ?? null));

  /** Ask the player to connect a wallet (only when they press something that needs it). Returns their address. */
  async function connect() {
    await ready();
    if (state.mock) {
      state.mockAddress = mockAddress;
      emit('wallet', mockAddress);
      return mockAddress;
    }
    if (address()) return address();
    const list = await walletKit.waitForWallets();
    if (!list.length) throw new Error(MESSAGE.NoWallet);
    const wallet = await walletKit.pickWallet(list);
    if (!wallet) throw new Error(MESSAGE.Cancelled);
    state.account = await walletKit.connectWallet(wallet);
    state.wallet = wallet;
    walletKit.onAccountChange(wallet, (account) => {
      state.account = account;
      if (!account) state.wallet = null;
      emit('wallet', account?.address ?? null);
    });
    emit('wallet', state.account.address);
    return state.account.address;
  }

  async function disconnect() {
    const wallet = state.wallet;
    state.wallet = null;
    state.account = null;
    state.mockAddress = null;
    emit('wallet', null);
    await walletKit.disconnectWallet(wallet);
  }

  /** Optional sign-in: the wallet signs a one-time message (Sign In With Solana style). A client-side proof for now. */
  async function signIn({ statement } = {}) {
    const player = await connect();
    const config = await ready();
    const host = loc?.host ?? 'game';
    const message = [
      `${host} wants you to sign in with your Solana account:`,
      player,
      '',
      statement ?? `Sign in to ${config.economy?.name ?? 'this game'} on games.fun. This costs nothing and moves no funds.`,
      '',
      `URI: ${loc?.origin ?? ''}`,
      `Chain ID: ${network.chain}`,
      `Nonce: ${encodeBase58(globalThis.crypto.getRandomValues(new Uint8Array(12)))}`,
      `Issued At: ${new Date().toISOString()}`,
    ].join('\n');
    if (state.mock) return { address: player, message, signature: 'mock', mock: true };
    const signature = await walletKit.signText(state.wallet, state.account, message);
    return { address: player, message, signature: encodeBase58(signature), mock: false };
  }

  /**
   * Compile, have the wallet sign, send and confirm one transaction. `signers`: keys made here that also sign (a new
   * collectible's address: { address, sign(message) }); they sign after the wallet.
   */
  async function signAndSend(player, instructions, signers = []) {
    const client = rpc();
    const { blockhash, lastValidBlockHeight } = await client.latestBlockhash();
    const wire = wireTransaction(compileMessage({ payer: player, blockhash, instructions }));
    await client.simulate(wire);
    let [signed] = await walletKit.signTransactions(state.wallet, state.account, network.chain, [wire]);
    if (!signed) throw new Error('The wallet returned nothing to send.');
    for (const s of signers) signed = withSignature(signed, s.address, await s.sign(readTransaction(signed).message));
    const signature = await client.send(signed);
    await client.confirm(signature, { lastValidBlockHeight });
    return signature;
  }

  /** The economy section, read (an old `shop` stands in through econ/shop.js), or null. */
  const econOf = (config) => (config.economy ? readEconomy(config.economy) : null);

  /** An item of the economy by key, id (number or digits) or name (any case). */
  function findItem(config, sku) {
    const e = econOf(config);
    if (!e) return null;
    const text = String(sku ?? '').trim();
    const id = typeof sku === 'number' ? sku : /^\d+$/.test(text) ? Number(text) : NaN;
    return e.items.find((i) => i.id === id) ?? e.items.find((i) => i.key === text) ?? e.items.find((i) => i.name.toLowerCase() === text.toLowerCase()) ?? null;
  }
  /** A box of the economy by key or id. */
  function findBox(config, id) {
    const e = econOf(config);
    return e?.boxes.find((b) => b.key === String(id)) ?? e?.boxes.find((b) => b.id === Number(id)) ?? null;
  }

  const priceText = (e, part) => `${part.price} ${e.priceToken(part)?.symbol ?? ''}`.trim();
  const unitsOf = (e, part) => toUnits(part.price ?? 0, e.priceToken(part)?.decimals ?? 9).toString();

  /** What the game sells: its items, priced in its currency (items priced 0 come from boxes and recipes). */
  async function listShop() {
    const e = econOf(await ready());
    if (!e) return [];
    return e.items
      .filter((item) => item.active !== false)
      .map((item) => {
        const forSale = Number(item.price ?? 0) > 0;
        return {
          id: item.id,
          key: item.key,
          sku: item.id,
          name: item.name,
          description: item.description ?? '',
          rarity: item.rarity ?? 'Common',
          look: item.look ?? null,
          image: item.image ?? null,
          price: unitsOf(e, item),
          priceText: forSale ? priceText(e, item) : 'Loot boxes only',
          currency: e.currency?.symbol ?? null,
          forSale,
        };
      });
  }

  /** The game's boxes that give items, with their published odds. */
  async function boxes() {
    const e = econOf(await ready());
    if (!e) return [];
    return e.boxes
      .filter((box) => box.active !== false)
      .map((box) => {
        const outcomes = box.outcomes ?? [];
        const weights = outcomes.map((o) => o.weight ?? Math.round((o.chance ?? 0) * 100));
        const total = weights.reduce((n, w) => n + w, 0) || 1;
        return {
          id: box.id,
          key: box.key,
          name: box.name,
          price: unitsOf(e, box),
          priceText: priceText(e, box),
          odds: outcomes.map((o, i) => ({ id: o.gives === 'item' ? (e.part('item', o.item)?.id ?? null) : null, item: o.gives === 'item' ? (e.part('item', o.item)?.name ?? o.item) : o.gives, chance: weights[i] / total })),
        };
      });
  }

  /** What an outcome of the economy calls means for the player's items. */
  const wonItem = (e, outcome) => {
    const item = outcome?.item ? e.part('item', outcome.item) : null;
    return item ? ownedOf(item, outcome.asset ?? null, outcome.serial ?? null) : { id: null, name: outcome?.name ?? 'Nothing', rarity: 'Common', look: null, image: null, serial: null, asset: null, outcome };
  };

  /** Buy an item (by id, key or name). Two wallet approvals: the purchase, then the claim that mints the collectible. */
  async function buy(sku, { onStatus } = {}) {
    const config = await ready();
    const item = findItem(config, sku);
    if (!item) throw new Error(MESSAGE.NoItem(sku));
    if (!(Number(item.price ?? 0) > 0)) throw new Error(MESSAGE.NotForSale(item.name));
    if (state.mock) {
      await connect();
      const bought = ownedOf(item, `mock-asset-${state.mockOwned.length + 1}`, state.mockOwned.length + 1);
      state.mockOwned.push(bought);
      emit('items', bought);
      return { item: bought, signatures: [], mock: true };
    }
    const off = onStatus ? on('status', onStatus) : null;
    try {
      const r = await economy.buy(item.key);
      return { item: wonItem(econOf(config), r.outcome), asset: r.asset ?? null, order: r.order, signatures: r.signatures, mock: false };
    } finally {
      off?.();
    }
  }

  /** Open a box (by id or key): pay and roll (one approval), wait for MagicBlock's VRF, then claim what it rolled. */
  async function openBox(id, { onStatus } = {}) {
    const config = await ready();
    const box = findBox(config, id);
    if (!box) throw new Error(MESSAGE.NoBox(id));
    if (state.mock) {
      await connect();
      const e = econOf(config);
      const roll = seeded(box.id * 7919 + ++state.mockOpened)();
      const outcomes = (box.outcomes ?? []).filter((o) => o.gives === 'item');
      const weight = (o) => o.weight ?? Math.round((o.chance ?? 0) * 100);
      let pick = roll * outcomes.reduce((n, o) => n + weight(o), 0);
      const entry = outcomes.find((o) => (pick -= weight(o)) < 0) ?? outcomes.at(-1);
      if (!entry) return { item: wonItem(e, { name: 'Nothing' }), signatures: [], mock: true };
      const won = ownedOf(e.part('item', entry.item), `mock-asset-${state.mockOwned.length + 1}`, state.mockOwned.length + 1);
      state.mockOwned.push(won);
      emit('items', won);
      return { item: won, signatures: [], mock: true };
    }
    const off = onStatus ? on('status', onStatus) : null;
    try {
      const r = await economy.openBox(box.key);
      return { item: wonItem(econOf(config), r.outcome), asset: r.outcome?.asset ?? null, outcome: r.outcome, order: r.order, signatures: r.signatures, mock: false };
    } finally {
      off?.();
    }
  }

  /** The live game's address, or null. */
  const liveGame = (e) => e?.game ?? (e?.collection ? lootPda.game(e.collection) : null);

  /** The connected player's orders in this game that have not ended yet (a claim they did not approve, a slow roll). */
  async function orders() {
    const config = await ready();
    const player = address();
    const game = liveGame(econOf(config));
    if (state.mock || !player || !game) return [];
    const filters = [
      { memcmp: { offset: 0, bytes: encodeBase58(Uint8Array.of(5)) } },
      { memcmp: { offset: 1, bytes: game } },
      { memcmp: { offset: 33, bytes: player } },
    ];
    const found = await rpc().programAccounts(LOOT_PROGRAM, filters);
    return found.map(({ pubkey, account }) => ({ order: pubkey, ...decodeLoot(LootAccount.Order, account.data) }));
  }

  /** Finish an order: claim it when it was rolled, refund it when it failed or waited too long. */
  async function finish(order) {
    const config = await ready();
    const r = await economy.finish(order);
    if (r.settled) {
      const won = wonItem(econOf(config), r.outcome);
      if (won.asset) emit('items', won);
      return { settled: true, item: won, outcome: r.outcome, signatures: r.signatures };
    }
    return r;
  }

  /** The connected player's items from this game's collection (none for a guest). */
  async function ownedItems() {
    const config = await ready();
    const player = address();
    const e = econOf(config);
    if (!player || !e) return [];
    if (state.mock) return [...state.mockOwned];
    if (!e.collection) return [];
    const assets = await rpc().programAccounts(MPL_CORE_PROGRAM, ownedAssetFilters(player, e.collection));
    return assets.flatMap(({ pubkey, account }) => {
      try {
        const asset = parseCoreAsset(account.data);
        const item = e.itemById(Number(asset.attributes.item_id));
        return item ? [ownedOf(item, pubkey, asset.attributes.serial ? Number(asset.attributes.serial) : null)] : [];
      } catch {
        return [];
      }
    });
  }

  /** Whether the player owns an item, by id, key or name. */
  async function owns(sku) {
    const config = await ready();
    const item = findItem(config, sku);
    return Boolean(item) && (await ownedItems()).some((i) => i.id === item.id);
  }

  /** The game's token (launched or linked), or null. */
  async function token() {
    return (await ready()).token ?? null;
  }

  // ------------------------------------------------------------ looks → gf-three loadout

  const wornKey = () => `gf-web3:worn:${loc?.pathname ?? ''}:${address() ?? 'guest'}`;

  /** The loadout these items make (one item per slot; `items` in the player's order of choice, else rarest first). */
  function loadout(items, { byRarity = !Array.isArray(state.worn) } = {}) {
    return loadoutOf(items ?? [], { byRarity });
  }

  /**
   * Wear items: their looks become this player's gf-three loadout (window.__GF_LOADOUT, which gf-three's
   * kit/net/looks.js applies and sends to every other player). `items`: owned items or their ids. Remembered per
   * game and wallet. Returns { loadout, worn }.
   */
  async function wear(items) {
    const owned = await ownedItems();
    const chosen = (items ?? owned).map((x) => (typeof x === 'object' ? x : owned.find((o) => o.id === Number(x)))).filter(Boolean);
    const result = loadout(chosen, { byRarity: !items });
    state.worn = result.worn;
    try {
      storage?.setItem(wornKey(), JSON.stringify(result.worn));
    } catch {}
    if (win) win.__GF_LOADOUT = result.loadout;
    emit('loadout', result);
    return result;
  }

  /** Wear what the player owns: their remembered choice for this game, else every owned item (rarest wins a slot). */
  async function wearOwned() {
    const owned = await ownedItems();
    let saved = null;
    try {
      saved = JSON.parse(storage?.getItem(wornKey()) ?? 'null');
    } catch {}
    const chosen = Array.isArray(saved) ? saved.map((id) => owned.find((o) => o.id === id)).filter(Boolean) : null;
    return wear(chosen?.length ? chosen : undefined);
  }

  function on(event, fn) {
    const set = state.listeners.get(event) ?? new Set();
    set.add(fn);
    state.listeners.set(event, set);
    return () => set.delete(fn);
  }

  /** Another public RPC for reads and sends (keyless only: everything in a game is public), or a config object. */
  function configure({ rpc: url, config, mock } = {}) {
    if (url !== undefined) {
      if (secretLike(url) || !/^https:\/\//.test(url)) throw new Error('Use a public, keyless https RPC in a game. A keyed URL would be visible to every player.');
      state.rpcUrl = url;
    }
    if (config) {
      state.config = parseConfig(JSON.stringify(config));
      state.loading = null;
    }
    if (mock !== undefined) state.mock = Boolean(mock);
  }

  /** The economy calls (econ/play.js): one per thing a player signs, the reads, act(id), state(). */
  const economy = economyPlay({
    ready,
    connect,
    address,
    rpc,
    send: signAndSend,
    mock: () => state.mock,
    emit,
    say: status,
    rollPollMs: options.rollPollMs,
    now: options.now,
  });

  return {
    VERSION,
    get mock() {
      return state.mock;
    },
    get address() {
      return address();
    },
    get config() {
      return state.config;
    },
    ready,
    configure,
    connect,
    disconnect,
    signIn,
    ownedItems,
    owns,
    shop: { list: listShop, buy },
    boxes,
    openBox,
    orders,
    finish,
    token,
    economy,
    loadout,
    wear,
    wearOwned,
    on,
    isAddress,
    transactionId,
  };
}

const gfWeb3 = createGfWeb3();
export default gfWeb3;
