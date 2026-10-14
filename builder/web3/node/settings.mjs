// The creator's own settings for the web3 layer, kept on their machine and never in a game: the RPC URL that builds
// and sends their transactions (it may carry a provider key, so it lives in the git-ignored `.gamesfun/web3.json`
// or the GAMESFUN_RPC_URL environment variable) and nothing else. Devnet only.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { networkConfig } from '../gf-web3/network.js';
import { rpcClient } from '../gf-web3/rpc.js';
import { ensureDir } from './game.mjs';

const FILE = 'web3.json';

export const settingsPath = (kitRoot) => path.join(kitRoot, '.gamesfun', FILE);

/** An RPC URL the creator may use: https anywhere, or http on this machine (a local validator). */
export function checkRpcUrl(value) {
  let url;
  try {
    url = new URL(String(value ?? '').trim());
  } catch {
    throw new Error('The RPC URL is not a valid link.');
  }
  const local = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) throw new Error('The RPC URL must be https (or http on this machine).');
  if (/mainnet/i.test(url.hostname)) throw new Error('This kit runs on devnet only; that looks like a mainnet RPC.');
  return url.toString();
}

/** The URL with anything that may be a key hidden, for showing on screen. */
export function maskRpcUrl(value) {
  try {
    const url = new URL(value);
    const hidden = url.search || url.pathname.length > 1 ? '/…' : '';
    return `${url.protocol}//${url.host}${hidden}`;
  } catch {
    return 'custom';
  }
}

export async function readSettings(kitRoot) {
  try {
    const value = JSON.parse(await readFile(settingsPath(kitRoot), 'utf8'));
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

export async function writeSettings(kitRoot, settings) {
  await ensureDir(path.dirname(settingsPath(kitRoot)));
  const clean = {};
  if (settings.rpcUrl) clean.rpcUrl = checkRpcUrl(settings.rpcUrl);
  await writeFile(settingsPath(kitRoot), `${JSON.stringify(clean, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  return clean;
}

/**
 * The network and the creator's RPC for this kit: { network, rpcUrl, rpc, custom, shown }.
 * Order: GAMESFUN_RPC_URL, then .gamesfun/web3.json, then the public devnet RPC.
 */
export async function chainContext(kitRoot, { env = process.env, fetchImpl } = {}) {
  const network = networkConfig('devnet');
  const settings = kitRoot ? await readSettings(kitRoot) : {};
  const chosen = env.GAMESFUN_RPC_URL || settings.rpcUrl || null;
  const rpcUrl = chosen ? checkRpcUrl(chosen) : network.rpcUrl;
  return {
    network,
    rpcUrl,
    rpc: rpcClient(rpcUrl, fetchImpl ? { fetchImpl } : {}),
    custom: Boolean(chosen),
    shown: chosen ? maskRpcUrl(rpcUrl) : rpcUrl,
  };
}
