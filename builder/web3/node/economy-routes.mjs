// The Economy tab's routes (mounted under /api/web3 by api.mjs): read and save the `economy` section of the game's
// gamesfun.json, and the pure answers the tab shows while the creator types. Nothing here signs or reads the chain;
// the live state (GET /economy/status) and the publish flow (kind "economy") are builder/web3/node/economy.mjs and flows.mjs.
//   GET  /economy            { economy, source: 'economy' | 'shop' | 'new', notes, token, filled }
//   POST /economy            { economy } → saved (the save: the web3 routes take GET and POST only, see http.mjs)
//   POST /economy/check      { economy? } → { ok, refusals, warnings }        (the saved one when none is sent)
//   POST /economy/simulate   { economy? } → { ok, ...simulation } | { ok: false, error }
//   POST /economy/cost       { economy? } → { ok, setup, actions } | { ok: false, refusals }
import { check, findSecrets } from '../economy/check.mjs';
import { cost } from '../economy/cost.mjs';
import { leaveOldProgram, migrateShop } from '../economy/migrate.mjs';
import { simulate } from '../economy/simulate.mjs';
import { validate } from '../economy/validate.mjs';
import { gameTitle, readConfig, updateConfig } from './game.mjs';
import { handle, HttpError, readJson } from './http.mjs';

const NETWORK = 'devnet';
const now = () => Math.floor(Date.now() / 1000);
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** A new game's economy: SOL and nothing else yet. */
export const starterEconomy = (name) => ({ version: 1, network: NETWORK, ...(name ? { name: String(name).slice(0, 80) } : {}), currency: 'sol', tokens: [{ key: 'sol', source: 'sol' }] });

/**
 * A token launched from the studio is written to gamesfun.json's `token`; the economy's first `curve` token without
 * a mint is that token. Returns true when it filled one in (the tab then saves it).
 */
function fillLaunched(economy, token) {
  if (!token || token.source !== 'launched') return false;
  const t = (economy.tokens ?? []).find((x) => x.source === 'curve' && !x.mint);
  if (!t || (economy.tokens ?? []).some((x) => x.mint === token.mint)) return false;
  Object.assign(t, { mint: token.mint, name: token.name, symbol: token.symbol, decimals: token.decimals, program: token.program, venue: 'games.fun', ...(token.image ? { image: token.image } : {}) });
  return true;
}

/** The game's economy as the tab shows it: saved, migrated from its shop (not saved yet), or new. */
export async function readEconomy(gameDir) {
  const config = await readConfig(gameDir);
  let economy;
  let source;
  let notes = [];
  if (config.economy) {
    economy = structuredClone(config.economy);
    notes = leaveOldProgram(economy);
    source = 'economy';
  } else if (config.shop) {
    const migrated = migrateShop(config);
    economy = migrated.config.economy;
    notes = migrated.notes;
    source = 'shop';
  } else {
    economy = starterEconomy(await gameTitle(gameDir).catch(() => null));
    source = 'new';
  }
  const filled = fillLaunched(economy, config.token);
  return { economy, source, notes, token: config.token ?? null, filled };
}

/** Program ids, pool indexes, live addresses and the old shop's record are written as the economy goes live: a save
 * from a page that loaded before that keeps them. */
const ID_FIELDS = { items: 'id', boxes: 'id', recipes: 'id', schedules: 'id', lotteries: 'id', stakes: 'id', pools: 'index' };
export function keepLive(previous, next) {
  if (!isObject(previous)) return next;
  const out = { ...next };
  for (const [section, field] of Object.entries(ID_FIELDS)) {
    if (!Array.isArray(out[section])) continue;
    const before = new Map((previous[section] ?? []).map((p) => [p.key, p[field]]));
    out[section] = out[section].map((p) => (p[field] === undefined && Number.isInteger(before.get(p.key)) ? { ...p, [field]: before.get(p.key) } : p));
  }
  for (const field of ['live', 'previous']) if (out[field] === undefined && previous[field] !== undefined) out[field] = previous[field];
  return out;
}

/** Refuses a spec that cannot be saved: not the schema's shape, a secret in it, or another network. */
export function refuseUnsaveable(economy) {
  if (!isObject(economy)) throw new HttpError(400, 'Send { economy: { … } }.');
  const secrets = findSecrets(economy);
  if (secrets.length) throw new HttpError(400, `Not saved: ${secrets[0]} looks like a private key or a seed phrase. A spec only ever holds public addresses; delete it, and move that wallet's funds to a new one.`);
  if (economy.network !== undefined && economy.network !== NETWORK) throw new HttpError(400, 'Not saved: the kit runs economies on devnet only.');
  const errors = validate(economy);
  if (errors.length) {
    const shown = errors.slice(0, 3).map((e) => `${e.path} ${e.message}`).join('; ');
    throw new HttpError(400, `Not saved: ${shown}${errors.length > 3 ? ` (and ${errors.length - 3} more)` : ''}. Fix ${errors.length === 1 ? 'it' : 'them'} and it saves by itself.`);
  }
}

/** Saves the economy into gamesfun.json; a shop there becomes part of it (the migration's rule) and is dropped. */
export async function saveEconomy(gameDir, economy) {
  refuseUnsaveable(economy);
  const config = await updateConfig(gameDir, (c) => {
    c.economy = keepLive(c.economy, { version: 1, network: NETWORK, ...economy });
    delete c.shop;
    return c;
  });
  return { economy: config.economy, saved: true };
}

/** The quick simulation, or why there is none yet. */
export function simulateSafely(economy) {
  const verdict = check(economy, { network: NETWORK });
  if (verdict.refusals.some((r) => r.code === 'E-SCHEMA' || r.code === 'E-SECRET')) return { ok: false, error: 'The numbers come back once the notes marked ✗ are fixed.' };
  try {
    return { ok: true, ...simulate(economy, { now: now() }) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

export function costSafely(economy) {
  try {
    return cost(economy, { network: NETWORK });
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

/** The routes, for createWeb3Api's list. `gameDir()` throws a 409 when no game is open. */
export function economyRoutes({ gameDir, log }) {
  const given = async (req) => {
    const body = await readJson(req, 256 * 1024);
    if (body.economy !== undefined) {
      if (!isObject(body.economy)) throw new HttpError(400, 'Send { economy: { … } }.');
      return body.economy;
    }
    return (await readEconomy(gameDir())).economy;
  };
  return [
    { method: 'get', path: '/economy', handler: handle(async () => readEconomy(gameDir()), log) },
    { method: 'post', path: '/economy', handler: handle(async (req) => saveEconomy(gameDir(), (await readJson(req, 256 * 1024)).economy), log) },
    { method: 'post', path: '/economy/check', handler: handle(async (req) => check(await given(req), { network: NETWORK }), log) },
    { method: 'post', path: '/economy/simulate', handler: handle(async (req) => simulateSafely(await given(req)), log) },
    { method: 'post', path: '/economy/cost', handler: handle(async (req) => costSafely(await given(req)), log) },
  ];
}
