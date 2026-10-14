// The studio's wallet, as the Economy tab uses it. The studio page owns the Wallet Standard connection and
// hands it over as ctx.wallet (builder/studio/wallet.js); this adapts it (and other shapes a host may pass), and falls back to
// finding a wallet itself when the page has none. The wallet signs in this browser; nothing here ever sees a private key.
//   { name, address(), connect(), signTransactions(base64[]) → base64[], signMessage(text) → base64 signature }

const b64ToBytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
function bytesToB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

const found = new Set();
let listening = false;
function listen() {
  if (listening) return;
  listening = true;
  const registry = Object.freeze({
    register: (...list) => {
      for (const w of list) {
        for (const seen of found) if (seen.name === w.name) found.delete(seen);
        found.add(w);
      }
      return () => list.forEach((w) => found.delete(w));
    },
  });
  window.addEventListener('wallet-standard:register-wallet', ({ detail }) => {
    try {
      detail(registry);
    } catch {}
  });
  try {
    window.dispatchEvent(new CustomEvent('wallet-standard:app-ready', { detail: registry }));
  } catch {}
}
const usable = (w) =>
  w?.features?.['standard:connect'] && w.features['solana:signTransaction'] && w.features['solana:signMessage'] && (w.chains ?? []).some((c) => String(c).startsWith('solana:'));

/** A Wallet Standard wallet (and optionally its connected account) as the tabs' wallet. */
function fromStandard(wallet, chain, initialAccount = null) {
  let account = initialAccount;
  return {
    name: wallet.name,
    address: () => account?.address ?? null,
    async connect() {
      if (account) return account.address;
      const result = await wallet.features['standard:connect'].connect();
      account = result?.accounts?.[0] ?? wallet.accounts?.[0] ?? null;
      if (!account) throw new Error('The wallet did not share an account.');
      wallet.features['standard:events']?.on?.('change', ({ accounts }) => accounts && (account = accounts[0] ?? null));
      return account.address;
    },
    async signTransactions(list) {
      const outputs = await wallet.features['solana:signTransaction'].signTransaction(...list.map((b64) => ({ account, transaction: b64ToBytes(b64), chain })));
      return outputs.map((o) => bytesToB64(o.signedTransaction));
    },
    async signMessage(text) {
      const [out] = await wallet.features['solana:signMessage'].signMessage({ account, message: new TextEncoder().encode(text) });
      return bytesToB64(out.signature);
    },
  };
}

/**
 * The tabs' wallet from ctx.wallet, which may be: an object with address/connect/signTransactions/signMessage already;
 * { wallet, account } (a Wallet Standard wallet and its account); or a Wallet Standard wallet. Without one, the tab
 * finds the browser's wallets itself and asks the creator to pick (`pick(list)` → wallet).
 */
export function studioWallet(ctxWallet, chain = 'solana:devnet', pick = async (list) => list[0]) {
  if (ctxWallet && typeof ctxWallet.signTransactions === 'function') {
    return {
      name: ctxWallet.name ?? 'Wallet',
      address: () => (typeof ctxWallet.address === 'function' ? ctxWallet.address() : ctxWallet.address) ?? null,
      connect: async () => (ctxWallet.connect ? ctxWallet.connect() : ctxWallet.address),
      async signTransactions(list) {
        const out = await ctxWallet.signTransactions(list.map(b64ToBytes));
        return out.map((x) => (typeof x === 'string' ? x : bytesToB64(x)));
      },
      async signMessage(text) {
        const sig = await ctxWallet.signMessage(new TextEncoder().encode(text));
        return typeof sig === 'string' ? sig : bytesToB64(sig.signature ?? sig);
      },
    };
  }
  // The studio page's own wallet (builder/studio/wallet.js): list(), connect(name?), account, address, feature(name), onChange(fn).
  if (ctxWallet && typeof ctxWallet.feature === 'function' && typeof ctxWallet.list === 'function') {
    const need = (name) => {
      const f = ctxWallet.feature(name);
      if (!f) throw new Error(`${ctxWallet.wallet?.name ?? 'This wallet'} can’t ${name === 'solana:signMessage' ? 'sign messages' : 'sign transactions'}; pick another wallet.`);
      return f;
    };
    return {
      get name() {
        return ctxWallet.wallet?.name ?? 'Wallet';
      },
      address: () => ctxWallet.address ?? null,
      onChange: (fn) => ctxWallet.onChange(fn),
      async connect() {
        if (ctxWallet.address) return ctxWallet.address;
        const list = ctxWallet.list().map((w) => w.wallet).filter(usable);
        if (!list.length) throw new Error('No Solana wallet found in this browser. Install Phantom (or any Wallet Standard wallet), switch it to devnet and reload.');
        const wallet = await pick(list);
        if (!wallet) throw new Error('No wallet chosen.');
        const account = await ctxWallet.connect(wallet.name);
        if (!account) throw new Error('The wallet did not share an account.');
        return account.address;
      },
      async signTransactions(list) {
        const outputs = await need('solana:signTransaction').signTransaction(...list.map((b64) => ({ account: ctxWallet.account, transaction: b64ToBytes(b64), chain })));
        return outputs.map((o) => bytesToB64(o.signedTransaction));
      },
      async signMessage(text) {
        const [out] = await need('solana:signMessage').signMessage({ account: ctxWallet.account, message: new TextEncoder().encode(text) });
        return bytesToB64(out.signature);
      },
    };
  }
  if (ctxWallet?.wallet?.features) return fromStandard(ctxWallet.wallet, chain, ctxWallet.account ?? null);
  if (ctxWallet?.features) return fromStandard(ctxWallet, chain);
  listen();
  let chosen = null;
  return {
    get name() {
      return chosen?.name ?? 'Wallet';
    },
    address: () => chosen?.address() ?? null,
    async connect() {
      if (chosen?.address()) return chosen.address();
      const list = [...found].filter(usable);
      if (!list.length) throw new Error('No Solana wallet found in this browser. Install Phantom (or any Wallet Standard wallet), switch it to devnet and reload.');
      const wallet = await pick(list);
      if (!wallet) throw new Error('No wallet chosen.');
      chosen = fromStandard(wallet, chain);
      return chosen.connect();
    },
    signTransactions: (list) => chosen.signTransactions(list),
    signMessage: (text) => chosen.signMessage(text),
    available: () => [...found].filter(usable).map((w) => w.name),
  };
}
