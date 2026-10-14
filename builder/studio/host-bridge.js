// The host bridge: the page that hosts a game (the studio's preview, builder/studio/play.html) offers the game its economy
// the way games.fun's /play page does (gf-three kit/net/host.js, CONTRACT §6g W2). The game never signs and never
// calls gf-web3: it draws the buttons and lines this page offers and reports clicks; this page signs with the kit's
// own gf-web3 (served at /__gamesfun/gf-web3/, never the copy in the game's folder) and the player's wallet.
//
//   game → page   { type: 'gf:host-ready', v: 1 }          at boot and every second until a page answers
//   page → game   { type: 'gf:host', v: 1, wallet, friends, shop, economy: { actions: [{ id, kind, label, price?, says?, where }] } }
//                 { type: 'gf:wallet', status, wallets, address, short, name, icon, error, items, boxes }
//                 { type: 'gf:economy', v: 1, balances, tickets, stakes, claimable, pending, error }   on every change
//   game → page   { type: 'gf:econ-action', id }           → gfWeb3.economy.act(id, answers), then a new gf:economy
//                 { type: 'gf:wallet-connect' | 'gf:wallet-disconnect' }
//
// Only a game whose economy is live (gamesfun.json → economy.live.game) hears anything: with no economy, or web3 off,
// this page says nothing new and the game looks exactly as before. Messages are taken only from this page's origin and
// from a window the host accepts (the preview frame or a frame inside it); answers go to that window alone, at this
// origin. Nothing secret ever reaches the game: its frame gets labels, prices, amounts and the short address.
//
// econMessages() is the one adapter between gf-web3's economyState() and the gf:host / gf:economy shapes; it is pure,
// so the tests run it in Node. Amounts the player reads (HUD lines, what is to claim) are rounded for people by the
// Economy tab's own formatter (economy-parts.js amountText: at most four decimals, "<0.0001" for a dust amount);
// gf-web3's state keeps them exact.

import { roundAmounts } from './tabs/web3/economy-parts.js';

const ID = /^[A-Za-z0-9_.:-]{1,64}$/;
/** The kinds gf-three draws (kit/net/host.js ECON_KINDS); gf-web3's `pay` is a purchase there. */
const KINDS = new Set(['buy', 'openBox', 'craft', 'buyTickets', 'stake', 'unstake', 'hold', 'enter', 'claim']);
const kindOf = (k) => (KINDS.has(k) ? k : k === 'pay' ? 'buy' : null);
const cut = (s, n) => {
  const t = String(s ?? '').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const MAX_ACTIONS = 32;
const RARITY = ['Common', 'Uncommon', 'Rare', 'Epic', 'Legendary'];

/**
 * What the page sends the game, from what gf-web3 gives it:
 *   economy  the economy section of gamesfun.json (for names and the currency)
 *   actions  gfWeb3.economy.actions() (playerActions: [{ id, kind, label, price?, says, where, asks? }])
 *   state    gfWeb3.economy.state() (economyState: { player, live, balances, pools, tickets, stakes, contests, holds, claimable }) or null
 *   last     { [boxOrItemKey]: says } what the player's last open or purchase of that part came to
 *   unclaimed [part] a box or item paid for whose prize is still to claim ("box:flip")
 *   pending  [actionId]   error  text
 * → { host: gf:host, economy: gf:economy, offered: [action with asks] }
 * Claims are offered on the results card only while the state says there is something to collect. The HUD lines are
 * the page's own: the player's balance in the game's currency, each box's last result, each lottery's tickets and each
 * stake, each shown by an entry of gf:economy with the line's id. A lottery's line shows once the player holds a
 * ticket and a stake's once they have something in it: the kit draws a line only when its entry is there, and four
 * lines of zeros grew the HUD's player card over the player's own character in a real game (devnet proof, coin-hop).
 */
export function econMessages({ economy = {}, actions = [], state = null, last = {}, unclaimed = [], pending = [], error = '' } = {}) {
  const claimable = new Map((state?.claimable ?? []).map((c) => [c.id, c]));
  for (const part of unclaimed) if (!claimable.has(`${part}:claim`)) claimable.set(`${part}:claim`, { id: `${part}:claim`, part, says: 'Your prize is waiting: claim it.' });
  const offered = [];
  const seen = new Set();
  const offer = (a) => {
    const kind = kindOf(a.kind);
    if (!kind || !ID.test(a.id) || seen.has(a.id) || offered.length >= MAX_ACTIONS) return;
    seen.add(a.id);
    offered.push({ ...a, kind });
  };
  for (const a of actions) {
    if (a.kind === 'claim') continue;
    offer({ id: a.id, kind: a.kind, label: cut(a.label, 60), ...(a.price ? { price: { amount: String(a.price.amount), currency: cut(a.price.currency, 16) } } : {}), says: cut(a.says, 140), where: a.where === 'results' ? 'results' : a.where === 'pause' ? 'pause' : 'menu', ...(a.asks ? { asks: a.asks } : {}) });
  }
  for (const [id, c] of claimable) {
    const known = actions.find((a) => a.id === id);
    offer({ id, kind: 'claim', label: cut(known?.label ?? 'Claim your prize', 60), says: cut(roundAmounts(c.says), 140), where: 'results' });
  }

  // the HUD lines and the state entries they show
  const lines = [];
  const balances = [];
  const tickets = [];
  const stakes = [];
  const line = (id, kind, label, list, entry) => {
    lines.push({ id, kind, label: cut(label, 60), says: '', where: 'hud' });
    if (entry) list.push({ id, text: cut(roundAmounts(entry), 60) });
  };
  const currency = economy.currency ?? 'sol';
  const bal = state?.balances?.[currency];
  const symbolOfCurrency = bal?.symbol ?? (economy.tokens ?? []).find((t) => t.key === currency)?.symbol ?? (currency === 'sol' ? 'SOL' : currency.toUpperCase());
  line(`hud:balance:${currency}`, 'buy', `Your ${symbolOfCurrency}`, balances, bal ? bal.amount : '');
  for (const b of economy.boxes ?? []) line(`hud:box:${b.key}`, 'openBox', b.name ?? b.key, balances, last[`box:${b.key}`] ?? '');
  for (const i of economy.items ?? []) if (last[`item:${i.key}`]) line(`hud:item:${i.key}`, 'buy', i.name ?? i.key, balances, last[`item:${i.key}`]);
  for (const l of economy.lotteries ?? []) {
    const t = state?.tickets?.[l.key];
    // the label stays short (the HUD card gives a label one narrow column); the count says what it counts
    line(`hud:lottery:${l.key}`, 'buyTickets', l.name ?? l.key, tickets, t && Number(t.mine) > 0 ? `${t.mine} ticket${Number(t.mine) === 1 ? '' : 's'} · pot ${t.pot} · draw ${t.nextDraw}` : '');
  }
  for (const s of economy.stakes ?? []) {
    const p = state?.stakes?.[s.key];
    const some = (m) => parseFloat(String(m ?? '').replace(/^</, '')) > 0;
    line(`hud:stake:${s.key}`, 'stake', s.name ?? s.key, stakes, p && (some(p.staked) || some(p.pending)) ? `${p.staked} staked · ${p.pending} earned${p.locked ? ' · locked' : ''}` : '');
  }
  for (const l of lines) offer(l);

  const host = {
    type: 'gf:host', v: 1, wallet: true, friends: false, shop: (economy.items ?? []).length > 0,
    economy: { actions: offered.map(({ asks, ...a }) => a) },
  };
  const message = {
    type: 'gf:economy', v: 1, balances, tickets, stakes,
    claimable: [...claimable.values()].filter((c) => seen.has(c.id)).map((c) => ({ id: c.id, text: cut(roundAmounts(c.says), 60) })),
    pending: pending.filter((id) => ID.test(id)), error: cut(error, 200),
  };
  return { host, economy: message, offered };
}

/**
 * The gf:wallet message (gf-three kit/net/host.js cleanWallet's shape). `items` is null only while a connected wallet's
 * items are still being read: a game with no items says so with [] (the kit's menu reads null as "Reading your items…",
 * which a game without a shop would otherwise say forever).
 */
export function walletMessage({ address = null, connecting = false, error = '', wallets = [], shop = false, items = null } = {}) {
  return {
    type: 'gf:wallet', status: address ? 'connected' : connecting ? 'connecting' : error ? 'error' : 'none', wallets,
    address: address ?? '', short: address ? `${address.slice(0, 4)}…${address.slice(-4)}` : '', name: '', icon: null, error,
    items: !address ? null : shop ? items : [], boxes: [],
  };
}

/** A wallet's refusal, in a player's words; anything else as gf-web3 said it. */
export const plainError = (e) => (/reject|denied|cancel|declin|closed/i.test(String(e?.message ?? e)) ? 'You declined in your wallet. Nothing was spent.' : String(e?.message ?? e).slice(0, 200));

/** The default asker: a small dialog with one number (a ticket count, an amount to stake). → answers, or null (cancelled). */
export function askDialog(doc = document) {
  return (action) => new Promise((resolve) => {
    const [field, ask] = Object.entries(action.asks ?? {})[0] ?? [];
    if (!field) return resolve({});
    const d = doc.createElement('dialog');
    d.className = 'gf-ask';
    d.dataset.testid = 'econ-ask';
    d.style.cssText = 'border:0;border-radius:12px;padding:18px 20px;max-width:320px;font:15px system-ui,sans-serif;background:#1d1f27;color:#f4f4f6;box-shadow:0 10px 40px #0008';
    const f = doc.createElement('form');
    f.method = 'dialog';
    const p = doc.createElement('p');
    p.style.margin = '0 0 10px';
    p.textContent = `${action.label}: ${ask.says ?? field}`;
    const input = doc.createElement('input');
    input.name = field;
    input.value = String(ask.default ?? '');
    input.style.cssText = 'width:100%;box-sizing:border-box;padding:8px;border-radius:8px;border:1px solid #555;background:#111;color:inherit;font:inherit';
    input.dataset.testid = 'econ-ask-value';
    const row = doc.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;margin-top:12px';
    const no = doc.createElement('button');
    no.type = 'button';
    no.textContent = 'Cancel';
    const ok = doc.createElement('button');
    ok.type = 'submit';
    ok.textContent = 'OK';
    ok.dataset.testid = 'econ-ask-ok';
    row.append(no, ok);
    f.append(p, input, row);
    d.append(f);
    doc.body.append(d);
    let answered = null;
    no.addEventListener('click', () => d.close());
    f.addEventListener('submit', () => {
      const v = input.value.trim();
      answered = field === 'count' ? { count: Math.max(Number(ask.min ?? 1), Math.floor(Number(v) || 0)) } : { amount: v || String(ask.default ?? '') };
    });
    d.addEventListener('close', () => { d.remove(); resolve(answered); });
    d.showModal();
    input.select();
  });
}

/**
 * Start the bridge on a page. Options:
 *   win          the hosting page's window
 *   accept(src)  whether a message's source window is the game this page hosts
 *   configUrl    the game's gamesfun.json ('/game/gamesfun.json'; the dev server answers 204 when the game has none)
 *   kitUrl       the kit's gf-web3 ('/__gamesfun/gf-web3/index.js')
 *   ask          (action) → answers | null: the asker for an action's `asks` (askDialog by default)
 *   pollMs       how often the state is read again while a game is listening (15 s; the public devnet RPC is rate-limited)
 *   log          (text) for the page's console
 * → { stop(), get offered(), refresh() }
 */
export function hostBridge({ win = window, accept, configUrl = '/game/gamesfun.json', kitUrl = '/__gamesfun/gf-web3/index.js', ask = null, pollMs = 15_000, log = (t) => console.info(`host bridge: ${t}`) } = {}) {
  const origin = win.location.origin;
  let target = null;
  let gf = null;
  let walletKit = null;
  let configText = null;
  let config = null;
  let actions = [];
  let state = null;
  let offered = [];
  let hostSent = '';
  let econSent = '';
  let walletSent = '';
  let walletError = '';
  let connecting = false;
  let items = null;
  const last = {};
  const unclaimed = new Set();
  const pending = new Set();
  let error = '';
  let timer = null;
  let stopped = false;
  let loadedAt = 0;
  const asker = ask ?? askDialog(win.document);

  const post = (msg) => {
    try {
      target?.postMessage(msg, origin);
    } catch {}
  };
  const live = () => Boolean(config?.economy?.live?.game);

  async function kit() {
    if (gf) return gf;
    const mod = await import(kitUrl);
    walletKit = await import(new URL('wallet.js', new URL(kitUrl, win.location.href)).href);
    gf = mod.createGfWeb3({ configUrl: new URL(configUrl, win.location.href).href });
    gf.on?.('wallet', () => { items = null; sendWallet(); refresh(); });
    return gf;
  }

  /** Read gamesfun.json again; → whether the game has a live economy. */
  async function load() {
    // the game says hello every second until a page answers: read the file at most every few seconds (forget() after a change)
    if (Date.now() - loadedAt < 3000) return live() && Boolean(gf);
    loadedAt = Date.now();
    let text = null;
    try {
      const r = await fetch(configUrl, { cache: 'no-store' });
      text = r.ok ? await r.text() : null;
    } catch {}
    if (text === configText) return live();
    configText = text;
    try {
      config = text ? JSON.parse(text) : null;
    } catch {
      config = null;
    }
    if (!live()) return false;
    const g = await kit();
    if (typeof g.economy?.act !== 'function') {
      log('this kit’s gf-web3 has no economy calls');
      return false;
    }
    g.configure({ config });
    await g.ready();
    actions = await g.economy.actions();
    state = null;
    return true;
  }

  function sendEconomy({ force = false } = {}) {
    if (!target || !config) return;
    const m = econMessages({ economy: config.economy, actions, state, last, unclaimed: [...unclaimed], pending: [...pending], error });
    offered = m.offered;
    const h = JSON.stringify(m.host);
    if (force || h !== hostSent) {
      hostSent = h;
      post(m.host);
    }
    const e = JSON.stringify(m.economy);
    if (force || e !== econSent) {
      econSent = e;
      post(m.economy);
    }
  }

  async function sendWallet({ force = false } = {}) {
    if (!target || !gf) return;
    const address = gf.address;
    const list = (walletKit?.availableWallets?.() ?? []).map((w) => ({ name: w.name, icon: /^data:image\//.test(w.icon ?? '') ? w.icon : null }));
    const shop = (config?.economy?.items ?? []).length > 0;
    if (address && shop && items === null) {
      items = [];
      gf.ownedItems().then((owned) => {
        const byId = new Map();
        for (const o of owned) {
          const id = config.economy.items.find((i) => i.key === o.key)?.id ?? null;
          const it = byId.get(o.key) ?? { itemId: Number.isInteger(id) ? id : byId.size + 1, name: o.name, rarity: Math.max(0, RARITY.indexOf(o.rarity)), rarityName: o.rarity, image: null, wearable: false, worn: false, count: 0, what: o.description?.slice(0, 80) ?? '' };
          it.count += 1;
          byId.set(o.key, it);
        }
        items = [...byId.values()];
        sendWallet();
      }).catch(() => {});
    }
    const msg = walletMessage({ address, connecting, error: walletError, wallets: list, shop, items });
    const text = JSON.stringify(msg);
    if (force || text !== walletSent) {
      walletSent = text;
      post(msg);
    }
  }

  /** Read the economy's state again and tell the game what changed. */
  async function refresh() {
    if (!target || !live() || !gf) return;
    try {
      state = await gf.economy.state();
    } catch (e) {
      log(`could not read the economy: ${e.message}`);
    }
    // a paid open or purchase whose prize was never claimed (a declined claim, a slow roll, a closed tab) is claimable
    // on the results card; claiming it finishes every such order of the player's (gf-web3 claim → claimOrders)
    if (gf.address && !pending.size && typeof gf.orders === 'function') {
      const part = config.economy.boxes?.[0] ? `box:${config.economy.boxes[0].key}` : config.economy.items?.[0] ? `item:${config.economy.items[0].key}` : null;
      const open = await gf.orders().then((list) => list.some((o) => o.status === 'Rolled' || o.status === 'Failed')).catch(() => false);
      for (const u of [...unclaimed]) if (!open) unclaimed.delete(u);
      if (open && part) unclaimed.add(part);
    }
    sendEconomy();
  }

  async function perform(id) {
    const a = offered.find((x) => x.id === id && x.where !== 'hud');
    if (!a) return;                              // only a button this page offered
    if (pending.size) {
      error = 'Finish the one waiting in your wallet first.';
      return sendEconomy();
    }
    let answers = {};
    if (a.asks) {
      answers = await asker(a);
      if (!answers) return;
    }
    pending.add(id);
    error = '';
    sendEconomy();
    try {
      const r = await gf.economy.act(id, answers);
      const [kind, key, verb] = id.split(':');
      if ((kind === 'box' || kind === 'item') && verb !== 'claim') last[`${kind}:${key}`] = r?.outcome?.says ?? r?.says ?? 'Done.';
      if (verb === 'claim' && (kind === 'box' || kind === 'item')) unclaimed.delete(`${kind}:${key}`);
      log(`${id}: ${r?.says ?? 'done'}${r?.signatures?.length ? ` (${r.signatures.join(', ')})` : ''}`);
    } catch (e) {
      error = plainError(e);
      const [kind, key] = id.split(':');
      if ((kind === 'box' || kind === 'item') && /roll has not arrived|Claim it in a minute/.test(error)) unclaimed.add(`${kind}:${key}`);
      log(`${id}: ${error}`);
    } finally {
      pending.delete(id);
    }
    await refresh();
    sendEconomy();
    sendWallet();
  }

  async function onMessage(e) {
    const d = e.data;
    if (stopped || e.origin !== origin || !d || typeof d !== 'object' || typeof d.type !== 'string' || !d.type.startsWith('gf:')) return;
    if (!accept(e.source)) return;
    if (d.type === 'gf:host-ready') {
      if (!(await load().catch((err) => (log(err.message), false)))) return;     // no live economy: nothing new is said
      target = e.source;
      sendEconomy({ force: true });
      sendWallet({ force: true });
      refresh();
      clearInterval(timer);
      timer = setInterval(() => { if (win.document.visibilityState !== 'hidden') refresh(); }, pollMs);
      return;
    }
    if (e.source !== target) return;
    if (d.type === 'gf:econ-action' && typeof d.id === 'string' && ID.test(d.id)) return perform(d.id);
    if (d.type === 'gf:wallet-connect' && !gf.address && !connecting) {
      connecting = true;
      walletError = '';
      sendWallet();
      try {
        await gf.connect();
      } catch (err) {
        walletError = plainError(err);
      }
      connecting = false;
      sendWallet();
      refresh();
    } else if (d.type === 'gf:wallet-disconnect' && gf.address) {
      await gf.disconnect().catch(() => {});
      sendWallet();
      refresh();
    }
  }

  win.addEventListener('message', onMessage);
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
      win.removeEventListener('message', onMessage);
    },
    get offered() {
      return offered;
    },
    get live() {
      return live();
    },
    /** The game's files changed: read gamesfun.json again at the next hello. */
    forget() {
      loadedAt = 0;
    },
    refresh,
  };
}

/** Whether `src` is `frameWin` or a window inside it (the friends lobby frames the game inside the preview). */
export function inside(frameWin, src) {
  let w = src;
  for (let i = 0; i < 8 && w; i++) {
    if (w === frameWin) return true;
    let up = null;
    try {
      up = w.parent;
    } catch {}
    if (!up || up === w) return false;
    w = up;
  }
  return false;
}
