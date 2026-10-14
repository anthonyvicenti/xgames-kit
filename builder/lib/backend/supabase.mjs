// Supabase as a game's backend: signing in to the person's Supabase account, their organizations and projects, a new
// project, the project's public key, SQL through the Management API. Shapes are Supabase's own (the Management API's
// OpenAPI document, https://api.supabase.com/api/v1-json, read 2026-10-12; docs
// https://supabase.com/docs/guides/integrations/build-a-supabase-oauth-integration).
//
// Three ways to connect, in the order the kit offers them (docs/BACKEND.md):
//   1. "mcp" (the default): the person's own agent adds Supabase's hosted MCP server (builder/lib/backend/mcp.mjs) and signs
//      in in the browser through dynamic client registration. Nobody registers an app, the kit holds no token; the
//      agent calls get_project_url and get_publishable_keys and hands the two public values to `backend use`.
//   2. "oauth": this module's own sign-in, PKCE and one fixed loopback redirect. Supabase requires the app to be
//      registered by an organization's owner (Organization settings → OAuth Apps), and its documented token exchange
//      sends the client secret (api.supabase.com/.well-known/oauth-authorization-server lists only client_secret_basic
//      and client_secret_post). A downloadable kit cannot keep a secret, so none ships: the code is traded either by a
//      broker (GAMESFUN_SUPABASE_BROKER, a games.fun route that adds the secret; not built yet) or
//      directly with the person's own registered app (`--client-id`, secret on stdin, kept in the secret store).
//   3. "pat": a scoped personal access token the person made at https://supabase.com/dashboard/account/tokens, on stdin.
// Ways 2 and 3 keep the token in builder/lib/secret-store.mjs under "backend-supabase"; never in a game folder or this checkout.
import { deleteSecret, getSecret, setSecret } from '../secret-store.mjs';
import { postForm, startLoopback, tokenRecord } from './oauth.mjs';

export const ID = 'supabase';
export const LABEL = 'Supabase';
const TOKEN_NAME = 'backend-supabase';
const APP_NAME = 'backend-supabase-app';
const DBPASS = ref => `supabase-db-${ref}`;

/** The scopes games.fun's OAuth app asks for (chosen when the app is registered; the `scope` parameter is deprecated). */
export const SCOPES = [
  ['organizations:read', 'list the person\'s organizations and the regions a new project can live in'],
  ['projects:read', 'list their projects, see when a new one is ready'],
  ['projects:write', 'create a project when they ask for a new one'],
  ['secrets:read', 'read the project\'s API keys, to take the publishable (public) one; the same answer holds the secret key, so the kit keeps only the entry whose type is publishable and never logs the answer'],
  ['secrets:write', 'optional: create a publishable key on a project that has none'],
  ['database:read', 'check every table the game uses has row-level security (read-only SQL)'],
  ['database:write', 'apply the game\'s tables and access rules (supabase/migrations/*.sql) after the kit\'s checker passed them'],
  ['auth:write', 'optional: turn on anonymous sign-ins so each player has an id for their own rows'],
  ['edge_functions:write', 'optional: deploy the game\'s edge functions'],
];

/** The one fixed loopback port of the redirect (an OAuth redirect must match a registered one exactly, port included;
 *  when it is busy the kit says so and does not pick another). */
export const CALLBACK_PORT = 53841;

export function settings(env = process.env) {
  const port = Number(env.GAMESFUN_BACKEND_CALLBACK_PORT);
  return {
    api: (env.GAMESFUN_SUPABASE_API || 'https://api.supabase.com').replace(/\/+$/, ''),
    broker: env.GAMESFUN_SUPABASE_BROKER ? env.GAMESFUN_SUPABASE_BROKER.replace(/\/+$/, '') : null,
    clientId: env.GAMESFUN_SUPABASE_CLIENT_ID || null,
    ports: [Number.isInteger(port) && port > 0 ? port : CALLBACK_PORT],
    // games.fun's app registers both http://127.0.0.1:53841/callback and http://localhost:53841/callback; 127.0.0.1 is
    // the loopback RFC 8252 asks for, and the one-button flow falls back to localhost when Supabase refuses it
    // (builder/lib/backend/supabase-connect.mjs, signInStep)
    callbackHost: env.GAMESFUN_BACKEND_CALLBACK_HOST || '127.0.0.1',
    // the project's public URL; local stacks and tests set a template with {ref}
    projectUrl: ref => (env.GAMESFUN_SUPABASE_PROJECT_URL || 'https://{ref}.supabase.co').replace('{ref}', ref),
  };
}

// ---------------------------------------------------------------- the app the kit signs in as
/** → { clientId, clientSecret|null, via: 'direct'|'broker' } or null when neither games.fun's app nor the person's is set up. */
export function app({ env = process.env } = {}) {
  const s = settings(env);
  let own = null;
  try { own = JSON.parse(getSecret(APP_NAME, { env }) ?? 'null'); } catch {}
  if (own?.clientId && own?.clientSecret) return { clientId: own.clientId, clientSecret: own.clientSecret, via: 'direct', own: true };
  if (s.clientId && s.broker) return { clientId: s.clientId, clientSecret: null, via: 'broker', broker: s.broker };
  // a sign-in made through games.fun's route remembers which route and app it used, so a refresh finds them again
  const t = loadToken({ env });
  if (t?.via === 'broker' && t.broker && t.client_id) return { clientId: t.client_id, clientSecret: null, via: 'broker', broker: t.broker };
  return null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Save the person's own registered OAuth app (their organization's OAuth Apps page). */
export function saveOwnApp(clientId, clientSecret, { env = process.env } = {}) {
  if (!UUID.test(String(clientId ?? ''))) throw new Error('the client id is a UUID (Organization settings → OAuth Apps)');
  if (typeof clientSecret !== 'string' || clientSecret.trim().length < 16) throw new Error('paste the app\'s client secret on stdin');
  return setSecret(APP_NAME, JSON.stringify({ clientId, clientSecret: clientSecret.trim() }), { env });
}

// ---------------------------------------------------------------- the person's token
export function loadToken({ env = process.env } = {}) {
  try { const t = JSON.parse(getSecret(TOKEN_NAME, { env }) ?? 'null'); return t?.access_token ? t : null; } catch { return null; }
}
const saveToken = (t, env) => setSecret(TOKEN_NAME, JSON.stringify(t), { env });

/** A personal access token (sbp_…), checked against the API before it is saved. */
export async function savePat(pat, { env = process.env, fetchImpl = fetch } = {}) {
  const t = String(pat ?? '').trim();
  if (!/^sbp_[A-Za-z0-9_]{20,}$/.test(t)) throw new Error('that is not a Supabase personal access token (sbp_…); make one at https://supabase.com/dashboard/account/tokens');
  await call({ access_token: t }, 'GET', '/v1/organizations', null, { env, fetchImpl });
  const rec = { kind: 'pat', access_token: t, refresh_token: null, expires_at: null, saved_at: new Date().toISOString() };
  return { where: saveToken(rec, env), token: rec };
}

/**
 * Sign in in the browser. `open(url)` shows the person the localhost start link. → { where, token }
 * The one-button flow passes `app` (games.fun's, from its route), `host` (127.0.0.1 or localhost) and `onFlow` (to
 * cancel the wait).
 */
export async function signIn({ env = process.env, open, fetchImpl = fetch, timeoutMs, app: given = null, host = null, onFlow } = {}) {
  const a = given ?? app({ env });
  if (!a) throw Object.assign(new Error(NOT_REGISTERED), { code: 'NO_APP' });
  const s = settings(env);
  const flow = await startLoopback({
    ports: s.ports, host: host ?? s.callbackHost, label: LABEL, timeoutMs,
    authorizeUrl: (redirectUri, state, challenge) => {
      const u = new URL(`${s.api}/v1/oauth/authorize`);
      for (const [k, v] of Object.entries({ client_id: a.clientId, redirect_uri: redirectUri, response_type: 'code', state, code_challenge: challenge, code_challenge_method: 'S256' })) u.searchParams.set(k, v);
      return u.href;
    },
  });
  onFlow?.(flow);
  await open?.(flow.startUrl, flow);
  const { code } = await flow.result;
  const t = await exchange({ grant_type: 'authorization_code', code, code_verifier: flow.verifier, redirect_uri: flow.redirectUri }, a, s, fetchImpl);
  const rec = tokenRecord(t, { kind: 'oauth', client_id: a.clientId, via: a.via, ...(a.via === 'broker' ? { broker: a.broker } : {}), saved_at: new Date().toISOString() });
  return { where: saveToken(rec, env), token: rec };
}

export const NOT_REGISTERED = 'The kit\'s own Supabase sign-in needs an OAuth app registered with Supabase, and none is set up on this machine. '
  + 'The usual way needs none: npx gamesfun backend connect supabase (your agent adds Supabase\'s MCP server and you sign in in your browser). Or paste a personal access token (make one at https://supabase.com/dashboard/account/tokens): npx gamesfun backend connect supabase --token-stdin, '
  + 'or register your own app in your Supabase organization (Organization settings → OAuth Apps, redirect http://localhost:53841/callback) and run: npx gamesfun backend connect supabase --client-id <id> --client-secret-stdin';

async function exchange(fields, a, s, fetchImpl) {
  if (a.via === 'direct') return postForm(`${s.api}/v1/oauth/token`, { ...fields, client_id: a.clientId }, { basic: [a.clientId, a.clientSecret], fetchImpl });
  return postForm(`${a.broker}/token`, { ...fields, client_id: a.clientId }, { fetchImpl });
}

/** The saved token, refreshed when it is about to expire. Throws "sign in first" when there is none or it was revoked. */
export async function token({ env = process.env, fetchImpl = fetch } = {}) {
  const t = loadToken({ env });
  if (!t) throw Object.assign(new Error('Not signed in to Supabase. Run: npx gamesfun backend connect supabase'), { code: 'NO_TOKEN' });
  if (!t.expires_at || t.expires_at - Date.now() > 60_000) return t;
  if (!t.refresh_token) throw Object.assign(new Error('The Supabase sign-in has expired. Run: npx gamesfun backend connect supabase'), { code: 'NO_TOKEN' });
  const a = app({ env });
  if (!a) throw Object.assign(new Error(NOT_REGISTERED), { code: 'NO_APP' });
  try {
    const r = await exchange({ grant_type: 'refresh_token', refresh_token: t.refresh_token }, a, settings(env), fetchImpl);
    const rec = tokenRecord(r, { kind: 'oauth', client_id: a.clientId, via: a.via, ...(a.via === 'broker' ? { broker: a.broker } : {}), saved_at: new Date().toISOString() });
    if (!rec.refresh_token) rec.refresh_token = t.refresh_token;
    saveToken(rec, env);
    return rec;
  } catch (e) {
    if (e.status === 400 || e.status === 401) { deleteSecret(TOKEN_NAME, { env }); throw Object.assign(new Error('Supabase no longer accepts this sign-in (it was revoked or expired). Run: npx gamesfun backend connect supabase'), { code: 'NO_TOKEN' }); }
    throw e;
  }
}

/** Forget the sign-in here, and revoke it at Supabase when it is an OAuth one. → { removed, revoked, note } */
export async function disconnect({ env = process.env, fetchImpl = fetch, forgetApp = false } = {}) {
  const t = loadToken({ env });
  let revoked = false, note = null;
  if (t?.kind === 'oauth' && t.refresh_token) {
    const a = app({ env });
    try {
      if (a?.via === 'direct') {
        const r = await fetchImpl(`${settings(env).api}/v1/oauth/revoke`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_id: a.clientId, client_secret: a.clientSecret, refresh_token: t.refresh_token }) });
        revoked = r.ok;
      } else if (a?.via === 'broker') {
        const r = await fetchImpl(`${a.broker}/revoke`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: a.clientId, refresh_token: t.refresh_token }).toString() });
        revoked = r.ok;
      }
    } catch {}
    if (!revoked) note = 'Supabase did not confirm the revoke; the token was removed here and stops working when it expires.';
  }
  if (t?.kind === 'pat') note = 'A personal access token stays valid at Supabase until you delete it at https://supabase.com/dashboard/account/tokens.';
  const removed = deleteSecret(TOKEN_NAME, { env });
  if (forgetApp) deleteSecret(APP_NAME, { env });
  return { removed, revoked, note };
}

// ---------------------------------------------------------------- the Management API
export async function call(t, method, path, body, { env = process.env, fetchImpl = fetch, headers = {} } = {}) {
  const res = await fetchImpl(`${settings(env).api}${path}`, {
    method,
    headers: { authorization: `Bearer ${t.access_token}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch {}
  if (res.ok) return json;
  const msg = json?.message || json?.error || text.slice(0, 200);
  if (res.status === 401) throw Object.assign(new Error('Supabase refused the sign-in (401). Run: npx gamesfun backend connect supabase'), { status: 401, code: 'NO_TOKEN' });
  if (res.status === 403) throw Object.assign(new Error(`Supabase refused ${method} ${path} (403): ${msg}. The app or token may lack the permission for it.`), { status: 403 });
  if (res.status === 429) throw Object.assign(new Error(`Supabase's rate limit (429); try again in ${res.headers.get('x-ratelimit-reset') ?? 'a minute'} s`), { status: 429, reset: Number(res.headers.get('x-ratelimit-reset')) || null });
  throw Object.assign(new Error(`Supabase ${method} ${path} failed (${res.status}): ${msg}`), { status: res.status, supabaseMessage: msg });
}

const opts = o => ({ env: o.env ?? process.env, fetchImpl: o.fetchImpl ?? fetch });
export const organizations = async (o = {}) => call(await token(opts(o)), 'GET', '/v1/organizations', null, opts(o));
export const projects = async (o = {}) => call(await token(opts(o)), 'GET', '/v1/projects', null, opts(o));
export const project = async (ref, o = {}) => call(await token(opts(o)), 'GET', `/v1/projects/${checkRef(ref)}`, null, opts(o));

/** Regions a new project can use in an organization: [{ code, name, recommended }]. */
export async function regions(org, o = {}) {
  const r = await call(await token(opts(o)), 'GET', `/v1/projects/available-regions?organization_slug=${encodeURIComponent(checkSlug(org))}`, null, opts(o));
  const rec = new Set((r?.recommendations?.specific ?? []).map(x => x.code));
  return (r?.all?.specific ?? []).map(x => ({ code: x.code, name: x.name, recommended: rec.has(x.code) }));
}

/**
 * A new project. The database password is generated here and kept in the secret store (Supabase cannot hand it back
 * later; the kit itself does not need it, since SQL goes through the Management API). Callers show it once on a screen
 * the person reads (the studio), never in a log or an agent's output. → { project, dbPass, saved }
 */
export async function createProject({ name, org, region, smartGroup = null, dbPass = null }, o = {}) {
  if (typeof name !== 'string' || !name.trim() || name.length > 64) throw new Error('give the project a name (at most 64 characters)');
  const { randomBytes } = await import('node:crypto');
  dbPass ??= randomBytes(24).toString('base64url');
  // a smart group (americas, emea, apac) lets Supabase pick the region nearest the person; a code names one region
  const region_selection = smartGroup ? { type: 'smartGroup', code: checkGroup(smartGroup) } : { type: 'specific', code: checkRegion(region) };
  const p = await call(await token(opts(o)), 'POST', '/v1/projects', { name: name.trim(), organization_slug: checkSlug(org), db_pass: dbPass, region_selection }, opts(o));
  const saved = setSecret(DBPASS(checkRef(p.ref)), dbPass, { env: opts(o).env });
  return { project: p, dbPass, saved };
}

/** One organization, with its plan (free, pro, team, enterprise). */
export const organization = async (slug, o = {}) => call(await token(opts(o)), 'GET', `/v1/organizations/${encodeURIComponent(checkSlug(slug))}`, null, opts(o));

/** The regions call as Supabase answers it: { recommendations: { smartGroup, specific }, all }. */
export const availableRegions = async (org, o = {}) => call(await token(opts(o)), 'GET', `/v1/projects/available-regions?organization_slug=${encodeURIComponent(checkSlug(org))}`, null, opts(o));

/** Restore a paused project (projects:write). It counts towards the free plan's 2 active projects again. */
export const restore = async (ref, o = {}) => call(await token(opts(o)), 'POST', `/v1/projects/${checkRef(ref)}/restore`, {}, opts(o));

/** Apply one migration (database:write), at most once: `key` (the file's hash) is Supabase's Idempotency-Key. */
export async function migrate(ref, { query: sql, name, key }, o = {}) {
  return call(await token(opts(o)), 'POST', `/v1/projects/${checkRef(ref)}/database/migrations`, { query: sql, name }, { ...opts(o), headers: key ? { 'idempotency-key': key } : {} });
}

/** The project's page in the Supabase dashboard. */
export const dashboardUrl = ref => `https://supabase.com/dashboard/project/${checkRef(ref)}`;

/** The database password the kit generated for a project it created (null for others). For the person's own eyes. */
export const dbPassword = (ref, { env = process.env } = {}) => getSecret(DBPASS(checkRef(ref)), { env });

export const PAUSED = 'Your Supabase project is paused (free projects pause after a week without use). Open it at https://supabase.com/dashboard and press Restore, then try again.';

/** Wait until a project answers: its status ACTIVE_HEALTHY, then auth, db and rest healthy (GET …/health). */
export async function waitReady(ref, { timeoutMs = 4 * 60 * 1000, everyMs = 4000, onWait, ...o } = {}) {
  const until = Date.now() + timeoutMs;
  const sleep = () => new Promise(r => setTimeout(r, everyMs));
  for (;;) {
    const p = await project(ref, o);
    if (/^(INACTIVE|PAUSING|PAUSE_FAILED)$/.test(p.status)) throw Object.assign(new Error(PAUSED), { code: 'PAUSED' });
    if (/FAILED|REMOVED|GOING_DOWN/.test(p.status)) throw new Error(`the project is ${p.status}; open it in the Supabase dashboard`);
    if (p.status === 'ACTIVE_HEALTHY') {
      const h = await call(await token(opts(o)), 'GET', `/v1/projects/${checkRef(ref)}/health?services=auth,db,rest`, null, opts(o)).catch(() => null);
      if (Array.isArray(h) && h.length && h.every(x => x.status === 'ACTIVE_HEALTHY')) return p;
    }
    if (Date.now() > until) throw new Error(`the project is still ${p.status}; run connect again in a minute with --project ${ref}`);
    onWait?.(p.status);
    await sleep();
  }
}

/** The project's keys as Supabase lists them (masked: the kit never asks for reveal=true). */
export const apiKeys = async (ref, o = {}) => call(await token(opts(o)), 'GET', `/v1/projects/${checkRef(ref)}/api-keys?reveal=false`, null, opts(o));

/** A publishable key for a project that has none (secrets:write). → the key list entry */
export const createPublishableKey = async (ref, o = {}) => call(await token(opts(o)), 'POST', `/v1/projects/${checkRef(ref)}/api-keys`, { type: 'publishable', name: 'games' }, opts(o));

/** Run SQL on the project. readOnly uses the read-only endpoint (database:read). → rows */
export async function query(ref, sql, { readOnly = false, ...o } = {}) {
  return call(await token(opts(o)), 'POST', `/v1/projects/${checkRef(ref)}/database/query${readOnly ? '/read-only' : ''}`, { query: sql }, opts(o));
}

/** Anonymous sign-ins on or off (each player gets an id for their own rows without an email). */
export async function setAnonymousSignIns(ref, on, o = {}) {
  return call(await token(opts(o)), 'PATCH', `/v1/projects/${checkRef(ref)}/config/auth`, { external_anonymous_users_enabled: !!on }, opts(o));
}

// ---------------------------------------------------------------- what may reach a game
/** Decode a JWT's payload without checking it (only to read its role). */
export function jwtPayload(s) {
  const parts = String(s).split('.');
  if (parts.length !== 3) return null;
  try { return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); } catch { return null; }
}

/** Is this key designed to be public (a browser may carry it, with row-level security on)? */
export function isPublicKey(key) {
  if (typeof key !== 'string') return false;
  if (/^sb_publishable_[A-Za-z0-9_-]{10,}$/.test(key)) return true;
  const p = jwtPayload(key);
  return !!p && p.role === 'anon';
}

/** From the project's key list, the one public key, preferring the new publishable key over the legacy anon JWT. */
export function pickPublicKey(keys) {
  const list = Array.isArray(keys) ? keys : [];
  const pub = list.find(k => k.type === 'publishable' && isPublicKey(k.api_key));
  if (pub) return { key: pub.api_key, kind: 'publishable' };
  const anon = list.find(k => (k.type === 'legacy' || k.type == null) && k.name === 'anon' && isPublicKey(k.api_key));
  if (anon) return { key: anon.api_key, kind: 'anon-jwt' };
  throw new Error('the project has no publishable key the kit can use (Project settings → API keys: create a publishable key)');
}

const checkRef = ref => { if (!/^[a-z0-9]{20}$/.test(String(ref ?? ''))) throw new Error(`not a project ref: ${JSON.stringify(ref)} (20 lower-case letters)`); return ref; };
const checkSlug = s => { if (!/^[\w-]{1,64}$/.test(String(s ?? ''))) throw new Error(`not an organization: ${JSON.stringify(s)}`); return s; };
const checkGroup = g => { if (!['americas', 'emea', 'apac'].includes(g)) throw new Error(`not a region group: ${JSON.stringify(g)} (americas, emea or apac)`); return g; };
const checkRegion = r => { if (!/^[a-z]{2}-[a-z]+-\d$/.test(String(r ?? ''))) throw new Error(`not a region code: ${JSON.stringify(r)} (for example eu-central-1)`); return r; };
export { checkRef, checkSlug };

/** The project's public settings for the game (backend.json). Origins: the REST/auth URL and its realtime socket. */
export function publicSettings(p, picked, env = process.env) {
  const url = settings(env).projectUrl(p.ref);
  const u = new URL(url);
  const ws = `${u.protocol === 'https:' ? 'wss:' : 'ws:'}//${u.host}`;
  return {
    version: 1,
    provider: ID,
    url: u.origin,
    key: picked.key,
    keyKind: picked.kind,
    project: { ref: p.ref, name: p.name, region: p.region, organization: p.organization_slug ?? null },
    origins: [u.origin, ws],
  };
}
