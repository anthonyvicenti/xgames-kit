// gf-three host: the page that hosts the game (the games.fun /play page) and what it offers the home menu (CONTRACT §6g):
// a wallet, the items that wallet owns from this game, and friends mode. The game never touches a wallet. Its code is
// written by an agent, so it can't ask anyone to sign anything: the page connects, reads the items and builds the
// loadout (§6e). The game only shows the page's state and asks the page for things.
//
// The game, to its ancestors:
//   { type: 'gf:host-ready', v: 1 }                     at boot, then every second until a page answers (40 s at
//                                                        most); the page answers with gf:host, gf:wallet and gf:loadout
//   { type: 'gf:wallet-connect', wallet: <name> }      the player picked a wallet in the menu
//   { type: 'gf:wallet-disconnect' }
//   { type: 'gf:wear', item: <itemId>, on: true|false }
//   { type: 'gf:friends' }                              Play with friends (the page opens its friends lobby)
//   { type: 'gf:open', url }                            a loot box link from the items view (the page opens it if it is
//                                                        one of its own)
//   { type: 'gf:econ-action', id }                      the player clicked one of the economy's buttons (the page signs,
//                                                        or not, and answers with gf:economy)
// The page, to the game:
//   { type: 'gf:host', v: 1, wallet: true|false, friends: true|false, shop: true|false,
//     economy?: { actions: [{ id, kind, label, price?: { amount, currency }, says?, where }] } }
//       kind: buy|openBox|craft|buyTickets|stake|unstake|hold|enter|claim; where: menu|pause|results|hud
//       (no economy, or no actions: nothing of the economy is drawn anywhere)
//   { type: 'gf:wallet', status: 'none'|'connecting'|'connected'|'error', wallets: [{name, icon}], address, short, name,
//     icon, error, items: [{itemId, name, rarity, rarityName, image, wearable, worn, count, what}] | null,
//     boxes: [{name, price, symbol, url}] }
//   { type: 'gf:economy', v: 1, balances: [entry], tickets: [entry], stakes: [entry], claimable: [entry],
//     pending: [actionId], error }, on every change; entry = { id, label?, amount?, symbol?, text? }. A HUD line
//     (where 'hud') shows the entry whose id is its action's id; pending buttons wait (disabled) for the page.
// The game draws what the page offers and reports clicks: it never signs, never prices and never decides anything of
// the economy, and rules.js never sees any of it (CONTRACT §6g W2).
// Only the window that said gf:host is answered and listened to, and only an ancestor (or the game itself, for QA)
// may say it. Without a host (the game opened on its own, or a Studio preview) the menu says where wallets connect.

let installed = false, hostWin = null, offers = null, wallet = null, sent = [];
let economy = null, econState = null, econSent = [];
const subs = [];

function ancestors(win) {
  const out = [];
  try { let w = win; for (let i = 0; i < 8 && w.parent && w.parent !== w; i++) { out.push(w.parent); w = w.parent; } } catch {}
  return out;
}
const str = (v, n = 200) => (typeof v === 'string' ? v.slice(0, n) : '');
const num = v => (Number.isFinite(v) ? v : null);
const img = v => (typeof v === 'string' && /^(https:|data:image\/)/.test(v) && v.length < 200000 ? v : null);

/** Keep only what the menu draws, in the shapes it expects (a page is trusted for its own wallet, not for markup). */
function cleanWallet(d) {
  const status = ['none', 'connecting', 'connected', 'error'].includes(d.status) ? d.status : 'none';
  const items = Array.isArray(d.items) ? d.items.slice(0, 60).map(i => ({
    itemId: num(i?.itemId), name: str(i?.name, 80), rarity: num(i?.rarity) ?? 0, rarityName: str(i?.rarityName, 24),
    image: img(i?.image), wearable: !!i?.wearable, worn: !!i?.worn, count: Math.max(1, num(i?.count) ?? 1), what: str(i?.what, 80),
  })).filter(i => i.itemId !== null) : null;
  return {
    status, address: str(d.address, 64), short: str(d.short, 24), name: str(d.name, 40), icon: img(d.icon), error: str(d.error, 240),
    wallets: Array.isArray(d.wallets) ? d.wallets.slice(0, 12).map(w => ({ name: str(w?.name, 40), icon: img(w?.icon) })).filter(w => w.name) : [],
    items, boxes: Array.isArray(d.boxes) ? d.boxes.slice(0, 12).map(b => ({ name: str(b?.name, 60), price: str(String(b?.price ?? ''), 24), symbol: str(b?.symbol, 12), url: str(b?.url, 400) })).filter(b => /^https?:/.test(b.url)) : [],
  };
}
// the economy (CONTRACT §6g W2): the page's buttons and its state, kept to the shapes the menu and the HUD draw
export const ECON_KINDS = ['buy', 'openBox', 'craft', 'buyTickets', 'stake', 'unstake', 'hold', 'enter', 'claim'];
export const ECON_WHERE = ['menu', 'pause', 'results', 'hud'];
const econId = v => (typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(v) ? v : null);
// an amount as the page wrote it: a number, or a decimal string (a token amount too big or too exact for a number)
const amount = v => (Number.isFinite(v) ? v : typeof v === 'string' && v.length <= 40 && /^-?\d+(\.\d+)?$/.test(v.trim()) ? v.trim() : null);
export function cleanEconomy(e) {
  const seen = new Set(), actions = [];
  for (const a of Array.isArray(e?.actions) ? e.actions.slice(0, 32) : []) {
    const id = econId(a?.id), label = str(a?.label, 60).trim();
    if (!id || seen.has(id) || !label || !ECON_KINDS.includes(a.kind) || !ECON_WHERE.includes(a.where)) continue;
    const pa = a.price && typeof a.price === 'object' ? amount(a.price.amount) : null;
    seen.add(id);
    actions.push({ id, kind: a.kind, label, price: pa === null ? null : { amount: pa, currency: str(a.price.currency, 16) }, says: str(a.says, 140), where: a.where });
  }
  return { actions };
}
export function cleanEconState(d) {
  const list = v => (Array.isArray(v) ? v.slice(0, 32).map(x => ({ id: econId(x?.id), label: str(x?.label, 40), amount: amount(x?.amount), symbol: str(x?.symbol, 16), text: str(x?.text, 60) }))
    .filter(x => x.id && (x.amount !== null || x.text)) : []);
  return { balances: list(d?.balances), tickets: list(d?.tickets), stakes: list(d?.stakes), claimable: list(d?.claimable),
    pending: Array.isArray(d?.pending) ? d.pending.map(econId).filter(Boolean).slice(0, 32) : [], error: str(d?.error, 200) };
}
/** What a state entry says: the page's own text, else the amount and its symbol. */
export const econText = x => (x ? x.text || `${x.amount}${x.symbol ? ` ${x.symbol}` : ''}` : '');
/** A price as a button says it. */
export const priceText = p => (p ? `${p.amount}${p.currency ? ` ${p.currency}` : ''}` : '');
/** An economy button's label: the name and, when it costs something, the price, so the price is never only in a line that can hide (a short window hides the small line). */
export const econLabel = (a, wait = false) => { const n = wait ? `${a.label}…` : a.label; return a.price ? `${n} · ${priceText(a.price)}` : n; };

function emit() { for (const fn of subs.slice()) { try { fn(); } catch (e) { console.error(e); } } }

/** Listen for the hosting page (boot calls this first, so an early answer is not missed) and say hello. */
export function listenForHost(win = globalThis) {
  if (installed || !win?.addEventListener) return; installed = true;
  const ok = src => src === win || ancestors(win).includes(src);
  win.addEventListener('message', e => {
    const d = e.data;
    if (!d || typeof d !== 'object' || (d.type !== 'gf:host' && d.type !== 'gf:wallet' && d.type !== 'gf:economy')) return;
    if (!ok(e.source)) return;
    if (d.type === 'gf:host') { hostWin = e.source; offers = { wallet: !!d.wallet, friends: !!d.friends, shop: !!d.shop }; economy = cleanEconomy(d.economy); emit(); return; }
    if (e.source !== hostWin) return;
    if (d.type === 'gf:economy') econState = cleanEconState(d);
    else wallet = cleanWallet(d);
    emit();
  });
  // say it again every second until a page answers (for 40 s): a page that loads its own script after the game started
  // (React hydrating the /play page) would miss a single hello, and with it the wallet and the player's loadout
  const hello = () => { for (const w of ancestors(win)) { try { w.postMessage({ type: 'gf:host-ready', v: 1 }, '*'); } catch {} } };
  hello();
  if (ancestors(win).length) { let n = 0; const t = setInterval(() => { if (hostWin || ++n > 40) clearInterval(t); else hello(); }, 1000); }
  announce = hello;
}
let announce = () => {};

function post(msg) {
  sent.push(msg.type); if (sent.length > 40) sent.shift();
  if (!hostWin) return false;
  try { hostWin.postMessage(msg, '*'); return true; } catch { return false; }
}

/** The menu's view of the host: what it offers, the wallet state, and the asks. */
export const host = {
  get present() { return !!hostWin; },
  /** Say hello to the page again (the wallet view does, in case the page came late). */
  hello() { if (!hostWin) announce(); },
  get offers() { return offers ?? { wallet: false, friends: false, shop: false }; },
  get wallet() { return wallet ?? { status: 'none', wallets: [], items: null, boxes: [], address: '', short: '', name: '', icon: null, error: '' }; },
  onChange(fn) { if (typeof fn === 'function') subs.push(fn); return () => { const i = subs.indexOf(fn); if (i >= 0) subs.splice(i, 1); }; },
  connect: name => post({ type: 'gf:wallet-connect', wallet: String(name ?? '') }),
  disconnect: () => post({ type: 'gf:wallet-disconnect' }),
  wear: (item, on) => post({ type: 'gf:wear', item, on: !!on }),
  friends: () => post({ type: 'gf:friends' }),
  open: url => post({ type: 'gf:open', url: String(url ?? '') }),
  /** The economy's buttons and lines the page offers (CONTRACT §6g W2); none without a page. */
  get economy() { return hostWin && economy ? economy : { actions: [] }; },
  /** The page's last gf:economy state, or null. */
  get econState() { return hostWin ? econState : null; },
  /** The offers drawn at one place: 'menu', 'pause', 'results' or 'hud'. */
  econAt: where => host.economy.actions.filter(a => a.where === where),
  /** The state entry a HUD line shows: the one whose id is the action's (balances, then tickets, stakes, claimable). */
  econValue(id) { const s = host.econState; if (!s) return null; for (const k of ['balances', 'tickets', 'stakes', 'claimable']) { const x = s[k].find(e => e.id === id); if (x) return x; } return null; },
  /** A click on an economy button: only an offered button, never a HUD line. */
  econAction(id) {
    if (!host.economy.actions.some(a => a.id === id && a.where !== 'hud')) return false;
    econSent.push(id); if (econSent.length > 40) econSent.shift();
    return post({ type: 'gf:econ-action', id });
  },
  /** For the observation (verify check 22): what the page offers, its last state, and the clicks sent. */
  observeEconomy() { return { offers: host.economy.actions, state: host.econState, sent: econSent.slice(-12) }; },
  /** For the observation (verify check 22): no addresses beyond the short one, no pictures. */
  observe() {
    const w = host.wallet;
    return { present: !!hostWin, offers: host.offers, status: w.status, short: w.short, wallets: w.wallets.map(x => x.name), items: w.items?.map(i => ({ itemId: i.itemId, name: i.name, wearable: i.wearable, worn: i.worn })) ?? null, sent: sent.slice(-12) };
  },
};
