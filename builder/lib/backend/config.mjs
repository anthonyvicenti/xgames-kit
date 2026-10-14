// A game's backend settings: <game>/backend.json. Public values only (the project's URL, its publishable key, the
// origins the game talks to), read by the in-game client (gf/backend/) and by publishing (the play host opens the
// game's content-security policy to `origins` for this game only).
//
// Why its own file and not gamesfun.json → backend: gamesfun.json is web3's file (builder/web3/gamesfun.schema.json,
// additionalProperties false), and web3's writer keeps only the fields it knows, so a `backend` key there would be
// dropped by the next economy save. Why not a slot: slots are what a player sees or tunes (R1–R5); swapping the
// database a game talks to is not a look, and a slot would put it in the Tune panel.
//
// {
//   "version": 1,
//   "provider": "supabase",                       // a file in builder/lib/backend/providers/ (supabase, railway)
//   "url": "https://<ref>.supabase.co",           // https (http only for a server on this machine)
//   "key": "sb_publishable_…",                    // a key the provider says is public (publicKey), or omitted
//   "keyKind": "publishable" | "anon-jwt",
//   "project": { "ref", "name", "region", "organization" },
//   "origins": ["https://<ref>.supabase.co", "wss://<ref>.supabase.co"],
//   "players": "anonymous" | "none"               // how a player gets an id for their own rows
// }
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ids, PROVIDERS } from './providers.mjs';
import { scanText } from './scan.mjs';

export const FILE = 'backend.json';
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** An origin a game may contact: https/wss with a host and nothing else; http/ws only on this machine. */
export function checkOrigin(value, { allowLoopback = true } = {}) {
  let u;
  try { u = new URL(value); } catch { throw new Error(`not an origin: ${JSON.stringify(value)}`); }
  const loop = LOOPBACK.has(u.hostname);
  const okProto = ['https:', 'wss:'].includes(u.protocol) || (allowLoopback && loop && ['http:', 'ws:'].includes(u.protocol));
  if (!okProto || u.username || u.password || u.search || u.hash || u.pathname !== '/' || String(value).includes('*') || String(value).replace(/\/+$/, '').toLowerCase() !== u.origin)
    throw new Error(`not an origin a game may contact: ${JSON.stringify(value)} (https:// or wss://, a host only, no path, no wildcard)`);
  return u.origin;
}

/** Validate a backend.json object. → the cleaned object; throws with every problem in words. */
export function validate(v, { allowLoopback = true } = {}) {
  const problems = [];
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(`${FILE} is not an object`);
  if (v.version !== 1) problems.push('version must be 1');
  const prov = PROVIDERS.get(v.provider);
  if (!prov) problems.push(`provider must be one of ${ids().join(', ')}`);
  let url = null;
  try { url = checkOrigin(v.url, { allowLoopback }); } catch (e) { problems.push(`url: ${e.message}`); }
  if (v.key != null && !(prov?.publicKey(v.key))) problems.push(`key is not a key ${prov?.label ?? 'the provider'} designed to be public (a game may carry only a publishable key; never a secret or service-role key)`);
  const origins = [];
  for (const o of Array.isArray(v.origins) ? v.origins : []) { try { origins.push(checkOrigin(o, { allowLoopback })); } catch (e) { problems.push(`origins: ${e.message}`); } }
  if (!Array.isArray(v.origins) || !origins.length) problems.push('origins must list the origins the game contacts');
  if (url && origins.length && !origins.includes(url)) problems.push('origins must include url');
  if (origins.length > 8) problems.push('at most 8 origins');
  if (v.players != null && !['anonymous', 'none'].includes(v.players)) problems.push('players is "anonymous" or "none"');
  const extra = Object.keys(v).filter(k => !['version', 'provider', 'url', 'key', 'keyKind', 'project', 'origins', 'players'].includes(k));
  if (extra.length) problems.push(`unknown fields: ${extra.join(', ')}`);
  const text = JSON.stringify(v);
  for (const hit of scanText(FILE, text)) problems.push(`${hit.kind}: never in a game`);
  if (problems.length) throw new Error(`${FILE}: ${problems.join('; ')}`);
  const p = v.project && typeof v.project === 'object' ? v.project : null;
  return {
    version: 1, provider: v.provider, url, ...(v.key != null ? { key: v.key, keyKind: v.keyKind ?? null } : {}),
    ...(p ? { project: { ref: p.ref ?? null, name: p.name ?? null, region: p.region ?? null, organization: p.organization ?? null } } : {}),
    origins: [...new Set(origins)], players: v.players ?? 'anonymous',
  };
}

export async function read(gameDir) {
  let text;
  try { text = await readFile(path.join(gameDir, FILE), 'utf8'); } catch { return null; }
  return validate(JSON.parse(text));
}

export async function write(gameDir, v) {
  const clean = validate(v);
  await writeFile(path.join(gameDir, FILE), JSON.stringify(clean, null, 2) + '\n', 'utf8');
  return clean;
}

export async function remove(gameDir) {
  await rm(path.join(gameDir, FILE), { force: true });
}
