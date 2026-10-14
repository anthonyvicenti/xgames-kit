// What the Economy tab uses: calls to the dev server's /api/web3 routes, the wallet, and the approval runner
// that walks a flow step by step (prepare on the server → the wallet signs here → complete on the server).
import { studioWallet } from './wallet.js';

/** Calls /api/web3/… through the studio's ctx.api when it has one, else same-origin fetch. Throws the server's words. */
export function apiOf(ctx) {
  return async (path, body) => {
    const url = `/api/web3${path}`;
    if (typeof ctx?.api === 'function') return ctx.api(url, body);
    const response = await fetch(url, body === undefined ? { cache: 'no-store' } : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(json.error || `The server answered ${response.status}.`);
    return json;
  };
}

/** One wallet per studio page, shared by every web3 tab. */
let shared = null;
export function walletOf(ctx, pick) {
  shared ??= studioWallet(ctx?.wallet, 'solana:devnet', pick);
  return shared;
}

/** "12500000" with 6 decimals → "12.5". */
export function fromUnits(units, decimals) {
  const digits = BigInt(units ?? 0).toString().padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}

export const short = (a) => (a && a.length > 12 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a ?? '');
export const explorer = (state, kind, id) => state.network.explorer.replace('{kind}', kind).replace('{id}', encodeURIComponent(id));
export const pictureUrl = (path) => `/api/web3/picture?path=${encodeURIComponent(path)}`;
export const cancelled = (error) => /reject|denied|cancel|declin|closed/i.test(String(error?.message ?? error));

/**
 * Run a flow to the end. `view` is what /flow/start returned. `on(update)` hears every change:
 *   { view, step, title, details, kind, waiting: 'wallet' | 'server' | null, error }
 * Returns the finished view. A wallet that declines stops the run; calling again continues from the same step.
 */
export async function runFlow(api, wallet, view, on = () => {}) {
  let current = view;
  while (!current.done) {
    on({ view: current, waiting: 'server' });
    const p = await api('/flow/prepare', { flowId: current.id, wallet: wallet.address() });
    on({ view: current, step: p.step, title: p.title, details: p.details, kind: p.kind, waiting: 'wallet' });
    const answer = p.kind === 'message' ? { signature: await wallet.signMessage(p.text) } : { signed: await wallet.signTransactions(p.transactions) };
    on({ view: current, step: p.step, title: p.title, details: p.details, kind: p.kind, waiting: 'server' });
    current = await api('/flow/complete', { flowId: current.id, prepareId: p.prepareId, ...answer });
    on({ view: current, waiting: null });
  }
  return current;
}
