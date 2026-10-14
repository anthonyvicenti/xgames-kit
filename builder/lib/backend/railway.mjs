// Railway as a game's own server host: the kit signs the person in to Railway in their own browser, creates a project
// with one service from the kit's game server template (builder/templates/backends/railway-node/), and writes only the
// service's public URL into the game. The provider row is providers/railway.mjs; this file talks to Railway.
//
// Railway's documented surface (docs.railway.com, read 2026-10-12):
//   - "Login with Railway": OAuth 2.0 + OIDC at backboard.railway.com/oauth (discovery: /oauth/.well-known/openid-
//     configuration). A Native (public) client sends no secret and must use PKCE S256. Redirect URIs match exactly;
//     for native apps Railway says to use http://127.0.0.1:<port>/callback, not localhost.
//   - Dynamic client registration (RFC 7591) at /oauth/register, open (no auth; checked 2026-10-12). Each machine
//     registers its own client on first use, so nobody (not games.fun, not the person) creates an app by hand. The
//     registration access token it returns deletes that client again (RFC 7592), and deleting an app "invalidates all
//     tokens issued through that app": that is how `disconnect` revokes, as Railway has no revocation endpoint.
//   - Access tokens last an hour; `offline_access` + `prompt=consent` gives a refresh token, which rotates: the kit
//     saves each new one at once, because reusing an old one revokes the whole authorization.
//   - The GraphQL API at /graphql/v2: projectCreate, serviceCreate, volumeCreate, variableCollectionUpsert,
//     serviceDomainCreate, deployment. Errors come as HTTP 200 with an `errors` array. Free plans get 100 requests an
//     hour, so the kit polls slowly.
//   - Code with no GitHub and no image: the kit uploads the template folder as a .tar.gz to
//     /project/<id>/environment/<id>/up?serviceId=<id>, the endpoint Railway's own CLI uses for `railway up`
//     (railwayapp/cli, MIT, src/controllers/upload.rs @ dc804165). It is not in Railway's API docs: if Railway refuses
//     it for a third-party token, `source: { image }` (a published image of the same template) is the documented way.
//
// Never logged, never returned, never written to a game: the access and refresh tokens, the registration access token
// and GF_SECRET (generated here, sent to Railway once as a service variable, then dropped).
import { createHash, randomBytes } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { deleteSecret, getSecret, setSecret } from '../secret-store.mjs';
import { postForm, startLoopback, tokenRecord } from './oauth.mjs';

export const ID = 'railway';
export const LABEL = 'Railway';
export const DEFAULT_BASE = 'https://backboard.railway.com';
/** The one fixed callback port (Railway compares redirect URIs exactly, port included). */
export const CALLBACK_PORT = 53842;
// workspace:member is enough to make a project in a workspace the person picks; the official CLI asks for admin
export const SCOPES = ['openid', 'email', 'profile', 'offline_access', 'workspace:member'];
export const TEMPLATE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'templates', 'backends', 'railway-node');
/** Where published games are played (their origin goes into the server's GF_ORIGINS). */
export const PLAY_ORIGINS = ['https://games-fun-play.vercel.app'];
/** The kit's dev server origins (builder/server/index.mjs PREFERRED_PORTS), so the game works locally too. */
export const DEV_PORTS = [5180, 5181, 5182, 5183, 5184, 5185, 5186, 5187, 5188, 5189];
export const SERVICE_NAME = 'game-server';

const CLIENT = 'railway-client', TOKEN = 'railway-token';
const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\])$/;

/** Railway's base URL. GAMESFUN_RAILWAY_BASE points the kit at a stand-in (tests): https, or http on this machine. */
export function base(env = process.env) {
  const v = env.GAMESFUN_RAILWAY_BASE;
  if (!v) return DEFAULT_BASE;
  const u = new URL(v);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && LOOPBACK.test(u.hostname))) throw new Error('GAMESFUN_RAILWAY_BASE must be https (or http on this machine)');
  return u.origin;
}
export const callbackPort = (env = process.env) => (/^\d{2,5}$/.test(env.GAMESFUN_RAILWAY_CALLBACK_PORT ?? '') ? Number(env.GAMESFUN_RAILWAY_CALLBACK_PORT) : CALLBACK_PORT);
export const redirectUri = (env = process.env) => `http://127.0.0.1:${callbackPort(env)}/callback`;

const readJson = (name, env) => { const v = getSecret(name, { env }); if (!v) return null; try { return JSON.parse(v); } catch { return null; } };
const writeJson = (name, value, env) => setSecret(name, JSON.stringify(value), { env });

async function getJson(url, { fetchImpl = fetch, ...init } = {}) {
  const res = await fetchImpl(url, { ...init, headers: { accept: 'application/json', ...(init.headers ?? {}) } });
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch {}
  return { res, json, text };
}

/** Railway's OIDC discovery document, checked: every endpoint the kit uses is on Railway's own origin. */
export async function discover({ env = process.env, fetchImpl = fetch } = {}) {
  const b = base(env);
  const { res, json } = await getJson(`${b}/oauth/.well-known/openid-configuration`, { fetchImpl });
  if (!res.ok || !json?.authorization_endpoint) throw new Error(`Railway's sign-in settings did not load (${res.status})`);
  for (const k of ['authorization_endpoint', 'token_endpoint', 'registration_endpoint']) {
    if (!json[k] || new URL(json[k]).origin !== b) throw new Error(`Railway's ${k} is not on ${b}; refusing to sign in`);
  }
  if (!(json.code_challenge_methods_supported ?? []).includes('S256')) throw new Error('Railway no longer lists PKCE S256; refusing to sign in');
  return { issuer: json.issuer, authorize: json.authorization_endpoint, token: json.token_endpoint, register: json.registration_endpoint, revoke: json.revocation_endpoint ?? null };
}

/** This machine's own Railway client: registered once (dynamic registration), kept in the secret store. */
export async function ensureClient({ env = process.env, fetchImpl = fetch, endpoints } = {}) {
  const want = redirectUri(env), b = base(env);
  const saved = readJson(CLIENT, env);
  if (saved?.client_id && saved.base === b && saved.redirect_uri === want) return saved;
  const ep = endpoints ?? await discover({ env, fetchImpl });
  const { res, json, text } = await getJson(ep.register, {
    fetchImpl, method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'games.fun kit', application_type: 'native', token_endpoint_auth_method: 'none',
      redirect_uris: [want], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
    }),
  });
  if (!res.ok || !json?.client_id) throw new Error(`Railway did not register the kit's sign-in client (${res.status}): ${json?.error_description ?? json?.error ?? text.slice(0, 160)}`);
  if (json.client_secret) throw new Error('Railway gave the kit a client secret; a kit on your machine cannot keep one, so the kit refuses it');
  const rec = { base: b, client_id: json.client_id, redirect_uri: want, registration_client_uri: json.registration_client_uri ?? `${ep.register}/${json.client_id}`, registration_access_token: json.registration_access_token ?? null, registered_at: new Date().toISOString() };
  writeJson(CLIENT, rec, env);
  return rec;
}

export const loadToken = ({ env = process.env } = {}) => readJson(TOKEN, env);

/**
 * Sign in in the person's own browser (PKCE S256, a checked `state`, one fixed callback on 127.0.0.1).
 * open(url): show or open the start link. → { where: { kind, where } }
 */
export async function signIn({ env = process.env, open, fetchImpl = fetch, timeoutMs, scopes = SCOPES, onFlow } = {}) {
  const ep = await discover({ env, fetchImpl });
  const client = await ensureClient({ env, fetchImpl, endpoints: ep });
  const flow = await startLoopback({
    ports: [callbackPort(env)], host: '127.0.0.1', label: 'Railway', timeoutMs,
    authorizeUrl: (redirect, state, challenge) => `${ep.authorize}?${new URLSearchParams({
      response_type: 'code', client_id: client.client_id, redirect_uri: redirect, scope: scopes.join(' '),
      state, code_challenge: challenge, code_challenge_method: 'S256', prompt: 'consent',
    })}`,
  });
  if (flow.redirectUri !== client.redirect_uri) { flow.close(); throw new Error(`the callback ${flow.redirectUri} is not the one registered (${client.redirect_uri})`); }
  onFlow?.(flow);
  try { open?.(flow.startUrl); } catch {}
  const { code } = await flow.result;
  // a public client: no secret and no Basic auth, only the verifier (Railway: "If you include a client secret with a native app, the request will fail")
  const t = await postForm(ep.token, { grant_type: 'authorization_code', code, redirect_uri: client.redirect_uri, client_id: client.client_id, code_verifier: flow.verifier }, { fetchImpl });
  const rec = tokenRecord(t, { kind: 'oauth', base: base(env), scope: t.scope ?? scopes.join(' ') });
  return { where: writeJson(TOKEN, rec, env) };
}

/** A fresh access token: refreshed (and the rotated refresh token saved at once) when it has under a minute left. */
export async function token({ env = process.env, fetchImpl = fetch } = {}) {
  const t = loadToken({ env });
  if (!t?.access_token || t.base !== base(env)) throw Object.assign(new Error('The kit is not signed in to Railway. Run: npx gamesfun backend connect railway'), { code: 'NO_TOKEN' });
  if (!t.expires_at || t.expires_at - 60_000 > Date.now()) return t.access_token;
  if (!t.refresh_token) throw Object.assign(new Error('The Railway sign-in has expired. Sign in again: npx gamesfun backend connect railway --sign-in'), { code: 'NO_TOKEN' });
  const client = readJson(CLIENT, env);
  const ep = await discover({ env, fetchImpl });
  let r;
  try { r = await postForm(ep.token, { grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: client?.client_id }, { fetchImpl }); } catch (e) {
    if (e.status === 400 || e.status === 401) { deleteSecret(TOKEN, { env }); throw Object.assign(new Error('Railway ended the kit\'s sign-in (it was revoked or expired). Sign in again: npx gamesfun backend connect railway --sign-in'), { code: 'NO_TOKEN' }); }
    throw e;
  }
  writeJson(TOKEN, tokenRecord({ ...r, refresh_token: r.refresh_token ?? t.refresh_token }, { kind: 'oauth', base: t.base, scope: r.scope ?? t.scope }), env);
  return r.access_token;
}

/** One GraphQL call. Railway reports failures as HTTP 200 with `errors`, so both are checked. */
export async function gql(query, variables = {}, { env = process.env, fetchImpl = fetch } = {}) {
  const access = await token({ env, fetchImpl });
  const { res, json, text } = await getJson(`${base(env)}/graphql/v2`, {
    fetchImpl, method: 'POST', headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json' }, body: JSON.stringify({ query, variables }),
  });
  if (res.status === 429) throw Object.assign(new Error(`Railway's API limit was reached (a free plan allows 100 requests an hour); try again in ${res.headers.get('retry-after') ?? 'a while'} seconds`), { code: 'RATE' });
  const errs = json?.errors;
  if (!res.ok || errs?.length) {
    const msg = errs?.map(e => e.message).join('; ') || text.slice(0, 160) || String(res.status);
    throw Object.assign(new Error(`Railway refused: ${msg}`), { status: res.status, code: /not authori[sz]ed/i.test(msg) ? 'DENIED' : 'RAILWAY' });
  }
  return json.data;
}

const opt = o => ({ env: o.env ?? process.env, fetchImpl: o.fetchImpl ?? fetch });

/** The workspaces the person shared on the consent page. */
export async function workspaces(o = {}) {
  const d = await gql('query { me { workspaces { id name } } }', {}, opt(o));
  return d?.me?.workspaces ?? [];
}

export async function createProject({ name, workspaceId }, o = {}) {
  const d = await gql(`mutation projectCreate($input: ProjectCreateInput!) { projectCreate(input: $input) { id name environments { edges { node { id name } } } } }`,
    { input: { name, description: 'A games.fun game\'s own server (gamesfun backend connect railway)', ...(workspaceId ? { workspaceId } : {}) } }, opt(o));
  const p = d.projectCreate;
  const envs = p.environments?.edges?.map(e => e.node) ?? [];
  return { id: p.id, name: p.name, environment: envs.find(e => e.name === 'production') ?? envs[0] ?? null };
}

export async function project(id, o = {}) {
  const d = await gql(`query project($id: String!) { project(id: $id) { id name services { edges { node { id name } } } environments { edges { node { id name } } } } }`, { id }, opt(o));
  const p = d.project;
  const envs = p.environments?.edges?.map(e => e.node) ?? [];
  return { id: p.id, name: p.name, services: p.services?.edges?.map(e => e.node) ?? [], environment: envs.find(e => e.name === 'production') ?? envs[0] ?? null };
}

export async function createService({ projectId, name = SERVICE_NAME, image = null }, o = {}) {
  const d = await gql(`mutation serviceCreate($input: ServiceCreateInput!) { serviceCreate(input: $input) { id name } }`,
    { input: { projectId, name, ...(image ? { source: { image } } : {}) } }, opt(o));
  return d.serviceCreate;
}

export async function createVolume({ projectId, environmentId, serviceId, mountPath = '/data' }, o = {}) {
  const d = await gql(`mutation volumeCreate($input: VolumeCreateInput!) { volumeCreate(input: $input) { id name } }`,
    { input: { projectId, environmentId, serviceId, mountPath } }, opt(o));
  return d.volumeCreate;
}

export async function setVariables({ projectId, environmentId, serviceId, variables }, o = {}) {
  await gql(`mutation variableCollectionUpsert($input: VariableCollectionUpsertInput!) { variableCollectionUpsert(input: $input) }`,
    { input: { projectId, environmentId, serviceId, variables, skipDeploys: true } }, opt(o));
}

export async function createDomain({ serviceId, environmentId, targetPort = 8080 }, o = {}) {
  const d = await gql(`mutation serviceDomainCreate($input: ServiceDomainCreateInput!) { serviceDomainCreate(input: $input) { id domain } }`,
    { input: { serviceId, environmentId, targetPort } }, opt(o));
  return d.serviceDomainCreate;
}

export async function deployImage({ serviceId, environmentId }, o = {}) {
  const d = await gql(`mutation serviceInstanceDeployV2($serviceId: String!, $environmentId: String!) { serviceInstanceDeployV2(serviceId: $serviceId, environmentId: $environmentId) }`, { serviceId, environmentId }, opt(o));
  return { deploymentId: d.serviceInstanceDeployV2 };
}

export async function deployment(id, o = {}) {
  const d = await gql(`query deployment($id: String!) { deployment(id: $id) { id status url staticUrl } }`, { id }, opt(o));
  return d.deployment;
}

// ------------------------------------------------------------------ the template as a .tar.gz (ustar, no dependency)
const SKIP = new Set(['node_modules', 'data', '.git', '.env']);
/** The template's files, relative, sorted (no data, no node_modules, no .env*). */
export function templateFiles(dir = TEMPLATE_DIR) {
  const out = [];
  const walk = rel => {
    for (const e of readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      if (SKIP.has(e.name) || e.name.startsWith('.env')) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(r); else if (e.isFile()) out.push(r);
    }
  };
  walk('');
  return out.sort();
}
function tarHeader(name, size, mtime) {
  const h = Buffer.alloc(512);
  if (Buffer.byteLength(name) > 100) throw new Error(`a template path is too long for a tar header: ${name}`);
  const put = (s, off, len) => h.write(s, off, len, 'utf8');
  const oct = (n, len) => n.toString(8).padStart(len - 1, '0') + '\0';
  put(name, 0, 100); put(oct(0o644, 8), 100, 8); put(oct(0, 8), 108, 8); put(oct(0, 8), 116, 8);
  put(oct(size, 12), 124, 12); put(oct(Math.floor(mtime / 1000), 12), 136, 12); put('        ', 148, 8); put('0', 156, 1);
  put('ustar\0', 257, 6); put('00', 263, 2);
  let sum = 0; for (const b of h) sum += b;
  put(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return h;
}
/** → { body: Buffer (gzip), files, sha256 } */
export function packTemplate(dir = TEMPLATE_DIR) {
  const files = templateFiles(dir), parts = [];
  for (const f of files) {
    const data = readFileSync(path.join(dir, f)), mtime = statSync(path.join(dir, f)).mtimeMs;
    parts.push(tarHeader(f, data.length, mtime), data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  const body = gzipSync(Buffer.concat(parts));
  return { body, files, sha256: createHash('sha256').update(body).digest('hex') };
}

/** Upload the template as the service's code (what `railway up` does). → { deploymentId, url, logsUrl, deploymentDomain } */
export async function upload({ projectId, environmentId, serviceId, dir = TEMPLATE_DIR }, o = {}) {
  const { env, fetchImpl } = opt(o);
  const access = await token({ env, fetchImpl });
  const u = new URL(`${base(env)}/project/${encodeURIComponent(projectId)}/environment/${encodeURIComponent(environmentId)}/up`);
  u.searchParams.set('serviceId', serviceId);
  u.searchParams.set('message', 'games.fun game server (gamesfun backend connect railway)');
  const { body } = packTemplate(dir);
  const { res, json, text } = await getJson(u.href, { fetchImpl, method: 'POST', headers: { authorization: `Bearer ${access}`, 'content-type': 'application/gzip' }, body });
  if (!res.ok || !json?.deploymentId) throw Object.assign(new Error(`Railway did not take the upload (${res.status}): ${json?.message ?? text.slice(0, 160)}. If this keeps happening, deploy the published image instead (--image).`), { status: res.status, code: 'UPLOAD' });
  return json;
}

/** The URL a Railway domain is served at (https; a stand-in on this machine answers on http). */
export const domainUrl = domain => `${LOOPBACK.test(String(domain).split(':')[0]) ? 'http' : 'https'}://${domain}`;

/** The origins the server lets in (exact): where the game is published, and the kit's dev server. */
export function gameOrigins(extra = [], { dev = true } = {}) {
  const out = [...PLAY_ORIGINS, ...(dev ? DEV_PORTS.flatMap(p => [`http://127.0.0.1:${p}`, `http://localhost:${p}`]) : []), ...extra];
  for (const o of out) { const u = new URL(o); if (u.origin !== o.replace(/\/+$/, '')) throw new Error(`not an origin: ${o}`); }
  return [...new Set(out.map(o => new URL(o).origin))];
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Wait until a deployment is running (polled slowly: free plans get 100 API requests an hour). */
export async function waitDeployed(id, { everyMs = 10_000, timeoutMs = 12 * 60_000, onWait, ...o } = {}) {
  const end = Date.now() + timeoutMs;
  let last = null;
  for (;;) {
    const d = await deployment(id, o);
    if (d?.status !== last) { last = d?.status; onWait?.(last); }
    if (d?.status === 'SUCCESS') return d;
    if (['FAILED', 'CRASHED', 'REMOVED', 'SKIPPED'].includes(d?.status)) throw Object.assign(new Error(`the server's deploy ended ${d.status}; its build and deploy logs are in the Railway dashboard`), { code: 'DEPLOY' });
    if (Date.now() > end) throw Object.assign(new Error(`the server was not up after ${Math.round(timeoutMs / 60000)} minutes (last status ${last}); see the Railway dashboard`), { code: 'DEPLOY' });
    await sleep(everyMs);
  }
}

/** Wait until the public URL answers /health (not Railway's API, so not rate-limited). */
export async function waitHealthy(url, { everyMs = 3000, timeoutMs = 3 * 60_000, fetchImpl = fetch } = {}) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    try { const r = await fetchImpl(`${url}/health`, { cache: 'no-store' }); if (r.ok && (await r.json())?.ok) return true; } catch {}
    if (Date.now() > end) throw Object.assign(new Error(`${url}/health did not answer within ${Math.round(timeoutMs / 60000)} minutes (a new domain can take a few minutes to start answering; run the command again to retry)`), { code: 'HEALTH' });
    await sleep(everyMs);
  }
}

/**
 * Create (or reuse) the project and service, deploy the template, and return the public URL. Nothing is written to a
 * game here; the caller writes backend.json with the URL only.
 * pick: { workspaceId, name } for a new project, or { projectId } to deploy again into one the kit made before.
 * → { url, project: { id, name }, serviceId, environmentId, created, volume, deploymentId }
 */
export async function deployServer(pick, { origins = gameOrigins(), image = null, onStep = () => {}, waitEveryMs, ...o } = {}) {
  // GAMESFUN_RAILWAY_POLL_MS: a faster poll against a stand-in (tests); Railway itself is polled every 10 seconds
  waitEveryMs ??= Math.max(100, Number((o.env ?? process.env).GAMESFUN_RAILWAY_POLL_MS) || 0) || undefined;
  let p, created = false;
  if (pick.projectId) { onStep('Finding the project'); p = await project(pick.projectId, o); }
  else { onStep(`Creating the project "${pick.name}"`); p = { ...(await createProject({ name: pick.name, workspaceId: pick.workspaceId }, o)), services: [] }; created = true; }
  if (!p.environment) throw new Error('the Railway project has no environment');
  const environmentId = p.environment.id;
  let svc = p.services.find(s => s.name === SERVICE_NAME), volume = null;
  if (!svc) {
    onStep('Creating the service');
    svc = await createService({ projectId: p.id, image }, o);
    onStep('Adding a volume for scores and saves');
    try { volume = await createVolume({ projectId: p.id, environmentId, serviceId: svc.id, mountPath: '/data' }, o); } catch (e) { onStep(`No volume (${e.message}): scores and saves reset at each deploy`); }
  }
  onStep('Setting the server\'s variables (its secret stays on Railway)');
  // GF_SECRET is made here, sent once, and dropped: the kit keeps no copy and it never reaches the game
  const variables = { PORT: '8080', GF_SECRET: randomBytes(32).toString('base64url'), GF_ORIGINS: origins.join(','), GF_TRUST_PROXY: '1', ...(volume ? { GF_DATA_DIR: '/data' } : {}) };
  await setVariables({ projectId: p.id, environmentId, serviceId: svc.id, variables }, o);
  onStep(image ? `Deploying the image ${image}` : 'Uploading the game server template');
  const up = image ? await deployImage({ serviceId: svc.id, environmentId }, o) : await upload({ projectId: p.id, environmentId, serviceId: svc.id }, o);
  await waitDeployed(up.deploymentId, { ...o, ...(waitEveryMs ? { everyMs: waitEveryMs } : {}), onWait: s => onStep(`Deploy: ${s}`) });
  onStep('Asking Railway for the public domain');
  const d = await createDomain({ serviceId: svc.id, environmentId, targetPort: 8080 }, o);
  const url = domainUrl(d.domain);
  onStep(`Waiting for ${url} to answer`);
  await waitHealthy(url, { fetchImpl: o.fetchImpl, ...(waitEveryMs ? { everyMs: Math.min(waitEveryMs, 3000) } : {}) });
  return { url, project: { id: p.id, name: p.name }, serviceId: svc.id, environmentId, created, volume: !!volume, deploymentId: up.deploymentId };
}

/** Forget the kit's Railway sign-in and delete its client at Railway, which ends every token issued to it. */
export async function disconnect({ env = process.env, fetchImpl = fetch } = {}) {
  const client = readJson(CLIENT, env), had = !!loadToken({ env });
  let revoked = false, note = null;
  if (client?.registration_client_uri && client.registration_access_token) {
    try {
      const res = await fetchImpl(client.registration_client_uri, { method: 'DELETE', headers: { authorization: `Bearer ${client.registration_access_token}` } });
      revoked = res.status === 204 || res.status === 200 || res.status === 404;
      if (!revoked) note = `Railway did not delete the kit's sign-in client (${res.status}). Remove "games.fun kit" at https://railway.com/account (Apps → Revoke Access).`;
    } catch (e) { note = `Railway could not be reached (${e.message}). Remove "games.fun kit" at https://railway.com/account (Apps → Revoke Access).`; }
  } else if (had) note = 'Remove "games.fun kit" at https://railway.com/account (Apps → Revoke Access) to end the sign-in at Railway too.';
  const removed = deleteSecret(TOKEN, { env }) || had;
  if (revoked || !client?.registration_access_token) deleteSecret(CLIENT, { env });
  return { removed, revoked, note: note ?? (revoked ? 'The server and its project stay in your Railway account; delete them in the Railway dashboard when you no longer want them.' : null) };
}

export function status({ env = process.env } = {}) {
  const t = loadToken({ env }), c = readJson(CLIENT, env);
  return { signedIn: t ? { kind: 'oauth', expires_at: t.expires_at, scope: t.scope ?? null } : null, client: c ? { registered_at: c.registered_at ?? null } : null };
}
