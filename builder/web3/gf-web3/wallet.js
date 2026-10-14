// A Wallet Standard client for a game page, with no library: the protocol Phantom, Solflare, Backpack and other
// Solana wallets register through (wallet-standard:register-wallet / wallet-standard:app-ready). Ported from games.fun's
// launchpad/dashboard/wallet.js, plus signMessage and a small picker when the player has more than one wallet.

const wallets = new Set();
const listeners = new Set();
const registry = Object.freeze({
  register(...list) {
    for (const w of list) {
      // One entry per wallet name: a wallet that registers again replaces itself.
      for (const seen of wallets) if (seen.name === w.name) wallets.delete(seen);
      wallets.add(w);
    }
    for (const fn of listeners) fn();
    return () => {
      for (const w of list) wallets.delete(w);
      for (const fn of listeners) fn();
    };
  },
});

let listening = false;
/** Start hearing wallets announce themselves (idempotent; only in a browser). */
export function listenForWallets() {
  if (listening || typeof window === 'undefined') return;
  listening = true;
  window.addEventListener('wallet-standard:register-wallet', (event) => {
    try {
      event.detail(registry);
    } catch {}
  });
  try {
    window.dispatchEvent(new CustomEvent('wallet-standard:app-ready', { detail: registry }));
  } catch {}
}

export const onWalletsChanged = (fn) => (listeners.add(fn), () => listeners.delete(fn));

/** Add a wallet directly (a host page that already holds one, or a test). */
export const registerWallet = (wallet) => registry.register(wallet);

const usable = (w) =>
  Boolean(w?.features?.['standard:connect'] && w.features['solana:signTransaction']) && (w.chains ?? []).some((c) => String(c).startsWith('solana:'));

/** The Solana wallets this browser offers. */
export const availableWallets = () => [...wallets].filter(usable);

/** Wait a moment for wallets that register late (extensions inject after the page loads). */
export async function waitForWallets(ms = 1500) {
  if (availableWallets().length) return availableWallets();
  await new Promise((resolve) => {
    const stop = onWalletsChanged(() => availableWallets().length && (stop(), resolve()));
    setTimeout(() => (stop(), resolve()), ms);
  });
  return availableWallets();
}

/** Ask the player to choose a wallet with a small overlay; resolves null when they close it. */
export function pickWallet(list) {
  if (list.length === 1) return Promise.resolve(list[0]);
  return new Promise((resolve) => {
    const shade = document.createElement('div');
    shade.setAttribute('role', 'dialog');
    shade.setAttribute('aria-label', 'Choose a wallet');
    shade.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:grid;place-items:center;background:#0009;font:15px system-ui,sans-serif';
    const box = document.createElement('div');
    box.style.cssText = 'background:#16181f;color:#eef;padding:18px;border-radius:14px;min-width:240px;display:grid;gap:8px';
    const title = document.createElement('strong');
    title.textContent = 'Choose a wallet';
    box.append(title);
    const done = (choice) => {
      shade.remove();
      resolve(choice);
    };
    for (const wallet of list) {
      const button = document.createElement('button');
      button.textContent = wallet.name;
      button.style.cssText = 'padding:9px;border-radius:9px;border:1px solid #fff3;background:#252a36;color:inherit;cursor:pointer';
      button.onclick = () => done(wallet);
      box.append(button);
    }
    const cancel = document.createElement('button');
    cancel.textContent = 'Cancel';
    cancel.style.cssText = 'padding:6px;border:0;background:none;color:#aab;cursor:pointer';
    cancel.onclick = () => done(null);
    box.append(cancel);
    shade.append(box);
    shade.addEventListener('click', (e) => e.target === shade && done(null));
    document.body.append(shade);
  });
}

/** Connect and return the wallet's first account. */
export async function connectWallet(wallet, { silent = false } = {}) {
  const result = await wallet.features['standard:connect'].connect(silent ? { silent: true } : undefined);
  const account = result?.accounts?.[0] ?? wallet.accounts?.[0];
  if (!account) throw new Error('The wallet did not share an account.');
  return account;
}

export async function disconnectWallet(wallet) {
  try {
    await wallet?.features?.['standard:disconnect']?.disconnect();
  } catch {}
}

/** Have the wallet sign wire-format transactions in one prompt; returns the signed bytes. */
export async function signTransactions(wallet, account, chain, transactions) {
  const feature = wallet.features['solana:signTransaction'];
  if (!feature) throw new Error(`${wallet.name} cannot sign transactions.`);
  const outputs = await feature.signTransaction(...transactions.map((transaction) => ({ account, transaction, chain })));
  return outputs.map((o) => o.signedTransaction);
}

/** Have the wallet sign a text message; returns the 64-byte signature. */
export async function signText(wallet, account, text) {
  const feature = wallet.features['solana:signMessage'];
  if (!feature) throw new Error(`${wallet.name} cannot sign messages.`);
  const [output] = await feature.signMessage({ account, message: new TextEncoder().encode(text) });
  if (!output?.signature) throw new Error(`${wallet.name} returned no signature.`);
  return output.signature;
}

/** Follow the wallet's account changes (the player switches account in the extension). */
export function onAccountChange(wallet, fn) {
  return wallet.features['standard:events']?.on('change', ({ accounts }) => accounts && fn(accounts[0] ?? null)) ?? (() => {});
}
