// A Wallet Standard wallet injected into a Playwright page, backed by a test key that stays in Node: the page asks
// Node to sign (page.exposeFunction), exactly as a browser extension wallet would answer the same calls. Used by the
// studio UI test (fake chain) and the devnet proof (a throwaway devnet key from the git-ignored .gamesfun/).
import { fromBase64, toBase64 } from '../../builder/web3/gf-web3/chain/bytes.js';
import { readTransaction, withSignature } from '../../builder/web3/gf-web3/chain/tx.js';

/** keypair: { address, sign(bytes) → Uint8Array }. Every signature the page asks for is recorded in `log`. */
export async function injectWallet(page, keypair, { name = 'Test Wallet', log = [] } = {}) {
  await page.exposeFunction('__gfTestSignTransaction', (b64) => {
    const wire = fromBase64(b64);
    const { message } = readTransaction(wire);
    log.push({ kind: 'transaction', bytes: wire.length });
    return toBase64(withSignature(wire, keypair.address, keypair.sign(message)));
  });
  await page.exposeFunction('__gfTestSignMessage', (b64) => {
    log.push({ kind: 'message', text: new TextDecoder().decode(fromBase64(b64)).slice(0, 120) });
    return toBase64(keypair.sign(fromBase64(b64)));
  });
  await page.addInitScript(
    ({ address, name: walletName }) => {
      const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
      const decode = (text) => {
        const bytes = [];
        for (const ch of text) {
          let carry = ALPHABET.indexOf(ch);
          for (let i = 0; i < bytes.length; i++) {
            carry += bytes[i] * 58;
            bytes[i] = carry & 0xff;
            carry >>= 8;
          }
          while (carry) bytes.push(carry & 0xff), (carry >>= 8);
        }
        for (const ch of text) if (ch === '1') bytes.push(0); else break;
        return Uint8Array.from(bytes.reverse());
      };
      const b64 = (bytes) => btoa(String.fromCharCode(...bytes));
      const unb64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
      const account = Object.freeze({ address, publicKey: decode(address), chains: ['solana:devnet'], features: ['solana:signTransaction', 'solana:signMessage'] });
      const wallet = {
        version: '1.0.0',
        name: walletName,
        icon: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=',
        chains: ['solana:devnet'],
        get accounts() {
          return [account];
        },
        features: {
          'standard:connect': { version: '1.0.0', connect: async () => ({ accounts: [account] }) },
          'standard:disconnect': { version: '1.0.0', disconnect: async () => {} },
          'standard:events': { version: '1.0.0', on: () => () => {} },
          'solana:signTransaction': {
            version: '1.0.0',
            supportedTransactionVersions: ['legacy', 0],
            signTransaction: async (...inputs) => {
              const out = [];
              for (const input of inputs) out.push({ signedTransaction: unb64(await window.__gfTestSignTransaction(b64(input.transaction))) });
              return out;
            },
          },
          'solana:signMessage': {
            version: '1.0.0',
            signMessage: async (...inputs) => {
              const out = [];
              for (const input of inputs) out.push({ signedMessage: input.message, signature: unb64(await window.__gfTestSignMessage(b64(input.message))) });
              return out;
            },
          },
        },
      };
      const register = (api) => api.register(wallet);
      window.addEventListener('wallet-standard:app-ready', ({ detail }) => register(detail));
      window.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: register }));
    },
    { address: keypair.address, name },
  );
  return log;
}
