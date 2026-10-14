// Ed25519 with node:crypto: the fresh keys a launch (base mint) and a new shop (collection address) need, and checking
// a wallet's signature. The kit never holds a user's key; these fresh keys sign their part of one transaction, live
// in memory only, and are dropped when the flow ends.
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { addressBytes, encodeBase58 } from '../gf-web3/chain/base58.js';

const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex');

/** A fresh keypair: { address, sign(message) → 64-byte signature }. The private key never leaves this object. */
export function freshKeypair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url');
  const address = encodeBase58(new Uint8Array(raw));
  let key = privateKey;
  return {
    address,
    sign(message) {
      if (!key) throw new Error('This key was dropped.');
      return new Uint8Array(sign(null, Buffer.from(message), key));
    },
    drop() {
      key = null;
    },
  };
}

/** A keypair from a 64-byte Solana secret key (seed then public key). Tests and the devnet proof only. */
export function keypairFromSecret(secret) {
  const seed = Buffer.from(secret.slice(0, 32));
  const privateKey = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' });
  const raw = Buffer.from(createPublicKey(privateKey).export({ format: 'jwk' }).x, 'base64url');
  return { address: encodeBase58(new Uint8Array(raw)), sign: (message) => new Uint8Array(sign(null, Buffer.from(message), privateKey)) };
}

/** Whether `signature` is `address`'s ed25519 signature of `message`. */
export function verifySignature(address, message, signature) {
  if (!signature || signature.length !== 64) return false;
  try {
    const key = createPublicKey({ key: Buffer.concat([SPKI_ED25519, Buffer.from(addressBytes(address))]), format: 'der', type: 'spki' });
    return verify(null, Buffer.from(message), key, Buffer.from(signature));
  } catch {
    return false;
  }
}
