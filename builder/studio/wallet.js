// The studio page's wallet: the app side of the Wallet Standard (https://github.com/wallet-standard/wallet-standard),
// with no build step and no dependencies. Wallet extensions (Phantom, Solflare, Backpack, …) register themselves through
// the standard's two window events; tabs use ctx.wallet to connect and to reach a wallet's features, e.g.
// ctx.wallet.feature('solana:signAndSendTransaction'). The studio never holds a key: wallets sign in the user's browser.
export function createWallet({ chainPrefix = 'solana:' } = {}) {
  const wallets = new Set();
  const listeners = new Set();
  let selected = null, account = null, offEvents = null;

  const state = () => ({ wallets: list(), wallet: selected, account, address: account?.address ?? null });
  const emit = () => { for (const fn of listeners) { try { fn(state()); } catch (e) { console.error(e); } } };
  const register = (...ws) => {
    for (const w of ws) if (w && typeof w === 'object' && w.features) wallets.add(w);
    emit();
    return () => { for (const w of ws) wallets.delete(w); if (selected && !wallets.has(selected)) { selected = null; account = null; } emit(); };
  };
  const api = Object.freeze({ register });
  // a wallet that loads after us announces itself; we announce ourselves to wallets that loaded before
  window.addEventListener('wallet-standard:register-wallet', ({ detail: callback }) => { try { callback(api); } catch (e) { console.error('wallet register', e); } });
  try { window.dispatchEvent(Object.assign(new Event('wallet-standard:app-ready'), { detail: api })); } catch (e) { console.error(e); }

  function list() {
    return [...wallets].map(w => ({ name: w.name, icon: w.icon, version: w.version, chains: [...(w.chains ?? [])], features: Object.keys(w.features ?? {}), wallet: w }));
  }
  const fits = w => (w.chains ?? []).some(c => String(c).startsWith(chainPrefix)) && 'standard:connect' in (w.features ?? {});

  return {
    list,
    get wallet() { return selected; },
    get account() { return account; },
    get address() { return account?.address ?? null; },
    /** A feature of the connected wallet ('solana:signTransaction', 'solana:signAndSendTransaction', …), or null. */
    feature(name) { return selected?.features?.[name] ?? null; },
    /** Connect: the wallet named, else the only (or first) Solana wallet. → the account */
    async connect(name = null) {
      const w = [...wallets].find(x => (name ? x.name === name : fits(x)));
      if (!w) throw new Error(name ? `no wallet named ${name}` : 'No Solana wallet found. Install one (e.g. Phantom) in this browser, then reload.');
      const r = await w.features['standard:connect'].connect();
      selected = w;
      account = (r?.accounts ?? w.accounts ?? [])[0] ?? null;
      offEvents?.();
      offEvents = w.features['standard:events']?.on?.('change', ({ accounts }) => { if (accounts) account = accounts[0] ?? null; emit(); }) ?? null;
      emit();
      return account;
    },
    async disconnect() {
      try { await selected?.features?.['standard:disconnect']?.disconnect(); } finally { offEvents?.(); offEvents = null; selected = null; account = null; emit(); }
    },
    /** fn(state) on every change (a wallet registers, connects, switches account). → unsubscribe */
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
}
