// A stand-in for Railway (backboard.railway.com) for tests: its OAuth server, its GraphQL API and the `railway up`
// upload, shaped from Railway's docs as read on 2026-10-12 and the
// one live check made that day (dynamic registration answers 201 with no auth; DELETE of the client answers 204).
// Nothing here is Railway's code. What it enforces, because Railway's docs say so:
//   - a native client registers with token_endpoint_auth_method "none", and its token exchange fails if it sends a
//     client secret (Basic auth or client_secret)
//   - redirect_uri must match a registered one exactly; PKCE S256 is required; `openid` is required
//   - a refresh token is given only for offline_access + prompt=consent; refresh tokens rotate, and reusing a rotated
//     one revokes the whole authorization
//   - deleting a client ends every token issued to it
//   - GraphQL failures are HTTP 200 with `errors`; inputs outside the documented fields are 400 BAD_USER_INPUT
// "Deploying" an upload: the mock unpacks the .tar.gz into a temp folder and runs its server.js with Node (no shell)
// on this machine, with the service's variables; the service's domain is that server's 127.0.0.1 address.
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';

const b64url = b => Buffer.from(b).toString('base64url');
const id = p => `${p}_${randomBytes(9).toString('base64url')}`;

/** Unpack a ustar archive (regular files only; refuses absolute paths and ..). → [{ name, data }] */
export function untar(buf) {
  const out = [];
  for (let off = 0; off + 512 <= buf.length;) {
    const h = buf.subarray(off, off + 512);
    if (h.every(b => b === 0)) break;
    const str = (a, b) => h.subarray(a, b).toString('utf8').replace(/\0.*$/s, '');
    const name = (str(345, 500) ? `${str(345, 500)}/` : '') + str(0, 100);
    const size = parseInt(str(124, 136).trim() || '0', 8);
    const type = String.fromCharCode(h[156] || 48);
    let sum = 0; for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i];
    if (sum !== parseInt(str(148, 156).trim(), 8)) throw new Error(`bad tar checksum at ${name}`);
    const data = buf.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type !== '0') continue;
    const clean = name.replace(/^\.\//, '');
    if (path.isAbsolute(clean) || clean.split('/').includes('..')) throw new Error(`unsafe path in upload: ${name}`);
    out.push({ name: clean, data: Buffer.from(data) });
  }
  return out;
}

// A port a test names now and the kit binds later (a callback port). Port 0 would hand out one from the system's
// ephemeral range, which every other process on a busy machine is also being handed (each verify's servers, each
// browser's connections), so by the time the kit bound it another could hold it ("port busy": the Railway step of the
// backend Chrome test, under load). These are drawn below that range, where nothing is handed out on its own.
const LOW = 20000, HIGH = 32000;
const tryPort = port => new Promise(resolve => {
  const s = net.createServer();
  s.once('error', () => resolve(null));
  s.listen(port, '127.0.0.1', () => s.close(() => resolve(port)));
});
export const freePort = async () => {
  for (let i = 0; i < 200; i++) { const p = await tryPort(LOW + Math.floor(Math.random() * (HIGH - LOW))); if (p) return p; }
  throw new Error(`no free port between ${LOW} and ${HIGH}`);
};

const ALLOWED = {
  ProjectCreateInput: ['name', 'description', 'workspaceId', 'isPublic', 'prDeploys', 'defaultEnvironmentName', 'repo'],
  ServiceCreateInput: ['projectId', 'name', 'source', 'branch', 'icon', 'variables'],
  VolumeCreateInput: ['projectId', 'serviceId', 'mountPath', 'environmentId', 'region'],
  VariableCollectionUpsertInput: ['projectId', 'environmentId', 'serviceId', 'variables', 'replace', 'skipDeploys'],
  ServiceDomainCreateInput: ['serviceId', 'environmentId', 'targetPort'],
};

/**
 * Start the stand-in. → { base, state, close() }
 * opts: port (0 = any), appPort (the deployed server's port; 0 = a free one), workspaces, deny (consent says no),
 *       accessTtl (seconds), log
 */
export async function startRailwayMock({ port = 0, appPort = 0, workspaces = [{ id: 'ws_play', name: 'Play' }], deny = false, accessTtl = 3600, log = () => {} } = {}) {
  const state = {
    clients: new Map(), codes: new Map(), access: new Map(), refresh: new Map(), projects: new Map(), services: new Map(),
    deployments: new Map(), variables: new Map(), volumes: [], uploads: [], domains: [], ops: [], requests: 0, apps: [],
    tokenRequests: [], deny,
  };
  let base = '';
  const send = (res, status, body, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(body == null ? '' : JSON.stringify(body)); };
  const body = req => new Promise((resolve, reject) => { const c = []; req.on('data', d => c.push(d)); req.on('end', () => resolve(Buffer.concat(c))); req.on('error', reject); });
  const bearer = req => /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? null;
  const live = t => { const a = state.access.get(t); return a && a.expires > Date.now() && state.clients.has(a.client) && !a.revoked ? a : null; };
  const gqlErr = (res, message, code = 'INTERNAL_SERVER_ERROR', status = 200) => send(res, status, { errors: [{ message, extensions: { code, traceId: '1' } }], data: null });
  const checkInput = (type, input) => { const bad = Object.keys(input ?? {}).filter(k => !ALLOWED[type].includes(k)); return bad.length ? `${type} has no field ${bad.join(', ')}` : null; };

  function issue(clientId, scope, sub) {
    const access = b64url(randomBytes(24)), out = { access_token: access, token_type: 'Bearer', expires_in: accessTtl, id_token: 'eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ1c2VyX21vY2sifQ.sig', scope };
    state.access.set(access, { client: clientId, scope, sub, expires: Date.now() + accessTtl * 1000 });
    if (scope.split(' ').includes('offline_access')) { const r = b64url(randomBytes(24)); state.refresh.set(r, { client: clientId, scope, sub, used: false, grant: sub }); out.refresh_token = r; }
    return out;
  }

  async function oauth(req, res, u) {
    if (u.pathname === '/oauth/.well-known/openid-configuration') return send(res, 200, {
      issuer: base, authorization_endpoint: `${base}/oauth/auth`, token_endpoint: `${base}/oauth/token`, registration_endpoint: `${base}/oauth/register`,
      userinfo_endpoint: `${base}/oauth/me`, jwks_uri: `${base}/oauth/jwks`, code_challenge_methods_supported: ['S256'],
      grant_types_supported: ['authorization_code', 'refresh_token'], token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', 'none'],
      scopes_supported: ['openid', 'email', 'profile', 'offline_access', 'workspace:admin', 'workspace:member', 'workspace:viewer', 'project:admin', 'project:member', 'project:viewer'],
      authorization_response_iss_parameter_supported: true, response_types_supported: ['code'],
    });
    if (u.pathname === '/oauth/register' && req.method === 'POST') {
      const m = JSON.parse((await body(req)).toString() || '{}');
      if (!Array.isArray(m.redirect_uris) || !m.redirect_uris.length) return send(res, 400, { error: 'invalid_redirect_uri', error_description: 'redirect_uris is mandatory property' });
      const clientId = id('rlwy_oaci'), rat = b64url(randomBytes(32));
      const c = { client_id: clientId, redirect_uris: m.redirect_uris, token_endpoint_auth_method: m.token_endpoint_auth_method ?? 'client_secret_basic', grant_types: m.grant_types ?? ['authorization_code'], rat, client_name: m.client_name };
      state.clients.set(clientId, c);
      return send(res, 201, { application_type: m.application_type ?? 'web', grant_types: c.grant_types, response_types: ['code'], token_endpoint_auth_method: c.token_endpoint_auth_method, client_id_issued_at: Math.floor(Date.now() / 1000), client_id: clientId, redirect_uris: c.redirect_uris, registration_client_uri: `${base}/oauth/register/${clientId}`, registration_access_token: rat, ...(c.token_endpoint_auth_method === 'none' ? {} : { client_secret: b64url(randomBytes(32)) }) });
    }
    const reg = /^\/oauth\/register\/([^/]+)$/.exec(u.pathname);
    if (reg) {
      const c = state.clients.get(reg[1]);
      if (!c || bearer(req) !== c.rat) return send(res, 401, { error: 'invalid_token', error_description: 'invalid token provided' });
      if (req.method === 'DELETE') { state.clients.delete(reg[1]); for (const a of state.access.values()) if (a.client === reg[1]) a.revoked = true; return send(res, 204, null); }
      return send(res, 200, { client_id: c.client_id, redirect_uris: c.redirect_uris });
    }
    if (u.pathname === '/oauth/auth' && req.method === 'GET') {
      const q = u.searchParams, c = state.clients.get(q.get('client_id'));
      if (!c) return send(res, 400, { error: 'invalid_client' });
      if (!c.redirect_uris.includes(q.get('redirect_uri'))) return send(res, 400, { error: 'invalid_redirect_uri' });
      const back = new URL(q.get('redirect_uri'));
      const fail = (error, d) => { back.searchParams.set('error', error); back.searchParams.set('error_description', d); back.searchParams.set('state', q.get('state') ?? ''); res.writeHead(302, { location: back.href }); res.end(); };
      if (q.get('response_type') !== 'code') return fail('unsupported_response_type', 'response_type must be code');
      if (!(q.get('scope') ?? '').split(' ').includes('openid')) return fail('invalid_scope', 'openid is required');
      if (c.token_endpoint_auth_method === 'none' && (!q.get('code_challenge') || q.get('code_challenge_method') !== 'S256')) return fail('invalid_request', 'PKCE (S256) is required for native clients');
      if (state.deny) return fail('access_denied', 'The user denied access');
      // the person signs in and approves, choosing the workspaces to share (here: all of the stand-in's)
      let scope = q.get('scope');
      if (scope.split(' ').includes('offline_access') && q.get('prompt') !== 'consent') scope = scope.split(' ').filter(s => s !== 'offline_access').join(' ');
      const code = b64url(randomBytes(18));
      state.codes.set(code, { client: c.client_id, redirect: q.get('redirect_uri'), challenge: q.get('code_challenge'), scope, used: false });
      back.searchParams.set('code', code); back.searchParams.set('state', q.get('state') ?? ''); back.searchParams.set('iss', base);
      res.writeHead(302, { location: back.href }); return res.end();
    }
    if (u.pathname === '/oauth/token' && req.method === 'POST') {
      const f = new URLSearchParams((await body(req)).toString());
      state.tokenRequests.push({ grant: f.get('grant_type'), basic: !!req.headers.authorization, secret: f.has('client_secret') });
      const c = state.clients.get(f.get('client_id'));
      if (!c) return send(res, 401, { error: 'invalid_client' });
      if (c.token_endpoint_auth_method === 'none' && (req.headers.authorization || f.has('client_secret'))) return send(res, 401, { error: 'invalid_client', error_description: 'native clients must not send a client secret' });
      if (f.get('grant_type') === 'authorization_code') {
        const k = state.codes.get(f.get('code'));
        if (!k || k.used || k.client !== c.client_id) return send(res, 400, { error: 'invalid_grant', error_description: 'code already used or expired' });
        k.used = true;
        if (k.redirect !== f.get('redirect_uri')) return send(res, 400, { error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
        if (b64url(createHash('sha256').update(f.get('code_verifier') ?? '').digest()) !== k.challenge) return send(res, 400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
        return send(res, 200, issue(c.client_id, k.scope, 'user_mock'));
      }
      if (f.get('grant_type') === 'refresh_token') {
        const r = state.refresh.get(f.get('refresh_token'));
        if (!r || r.client !== c.client_id) return send(res, 400, { error: 'invalid_grant', error_description: 'refresh token not found' });
        if (r.used) { for (const a of state.access.values()) if (a.client === c.client_id) a.revoked = true; for (const x of state.refresh.values()) if (x.client === c.client_id) x.used = true; return send(res, 400, { error: 'invalid_grant', error_description: 'refresh token reused: the authorization is revoked' }); }
        r.used = true;
        return send(res, 200, issue(c.client_id, r.scope, r.sub));
      }
      return send(res, 400, { error: 'unsupported_grant_type' });
    }
    return send(res, 404, { error: 'not found' });
  }

  async function deploy(dep, svc) {
    const project = state.projects.get(svc.projectId);
    const vars = state.variables.get(svc.id) ?? {};
    const dir = mkdtempSync(path.join(os.tmpdir(), 'railway-mock-app-'));
    for (const f of dep.files) { mkdirSync(path.dirname(path.join(dir, f.name)), { recursive: true }); writeFileSync(path.join(dir, f.name), f.data); }
    const data = mkdtempSync(path.join(os.tmpdir(), 'railway-mock-volume-'));
    const p = svc.appPort;
    const env = { PATH: process.env.PATH, ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP } : {}), ...vars, PORT: String(p), GF_HOST: '127.0.0.1', ...(vars.GF_DATA_DIR ? { GF_DATA_DIR: data } : {}), RAILWAY_PROJECT_ID: project.id, RAILWAY_SERVICE_ID: svc.id };
    const child = spawn(process.execPath, ['server.js'], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    child.stdout.on('data', d => { out += d; }); child.stderr.on('data', d => { out += d; });
    state.apps.push({ child, dir, data, port: p, out: () => out });
    dep.status = 'DEPLOYING';
    for (let i = 0; i < 100; i++) {
      try { const r = await fetch(`http://127.0.0.1:${p}/health`); if (r.ok) { dep.status = 'SUCCESS'; return; } } catch {}
      if (child.exitCode != null) break;
      await new Promise(r => setTimeout(r, 100));
    }
    dep.status = 'CRASHED';
    log(`mock deploy crashed: ${out}`);
  }

  async function graphql(req, res) {
    const a = live(bearer(req));
    const { query = '', variables = {} } = JSON.parse((await body(req)).toString() || '{}');
    if (!a) return gqlErr(res, 'Not Authorized');
    const op = /\b(me|projectCreate|project|serviceCreate|volumeCreate|variableCollectionUpsert|serviceDomainCreate|serviceInstanceDeployV2|deployment)\s*[({]/.exec(query)?.[1];
    state.ops.push(op ?? '?');
    const input = variables.input;
    const need = (type) => checkInput(type, input);
    switch (op) {
      case 'me': return send(res, 200, { data: { me: { workspaces } } });
      case 'projectCreate': {
        const bad = need('ProjectCreateInput'); if (bad) return gqlErr(res, bad, 'BAD_USER_INPUT', 400);
        if (input.workspaceId && !workspaces.some(w => w.id === input.workspaceId)) return gqlErr(res, 'Not Authorized');
        const p = { id: id('prj'), name: input.name, workspaceId: input.workspaceId ?? null, env: { id: id('env'), name: input.defaultEnvironmentName ?? 'production' } };
        state.projects.set(p.id, p);
        return send(res, 200, { data: { projectCreate: { id: p.id, name: p.name, environments: { edges: [{ node: p.env }] } } } });
      }
      case 'project': {
        const p = state.projects.get(variables.id); if (!p) return gqlErr(res, 'Project not found');
        const svcs = [...state.services.values()].filter(s => s.projectId === p.id).map(s => ({ node: { id: s.id, name: s.name } }));
        return send(res, 200, { data: { project: { id: p.id, name: p.name, services: { edges: svcs }, environments: { edges: [{ node: p.env }] } } } });
      }
      case 'serviceCreate': {
        const bad = need('ServiceCreateInput'); if (bad) return gqlErr(res, bad, 'BAD_USER_INPUT', 400);
        if (!state.projects.has(input.projectId)) return gqlErr(res, 'Project not found');
        const s = { id: id('svc'), name: input.name, projectId: input.projectId, source: input.source ?? null, appPort: appPort || await freePort() };
        state.services.set(s.id, s);
        return send(res, 200, { data: { serviceCreate: { id: s.id, name: s.name } } });
      }
      case 'volumeCreate': {
        const bad = need('VolumeCreateInput'); if (bad) return gqlErr(res, bad, 'BAD_USER_INPUT', 400);
        state.volumes.push({ ...input });
        return send(res, 200, { data: { volumeCreate: { id: id('vol'), name: 'game-server-volume' } } });
      }
      case 'variableCollectionUpsert': {
        const bad = need('VariableCollectionUpsertInput'); if (bad) return gqlErr(res, bad, 'BAD_USER_INPUT', 400);
        state.variables.set(input.serviceId, { ...(input.replace ? {} : state.variables.get(input.serviceId) ?? {}), ...input.variables });
        return send(res, 200, { data: { variableCollectionUpsert: true } });
      }
      case 'serviceDomainCreate': {
        const bad = need('ServiceDomainCreateInput'); if (bad) return gqlErr(res, bad, 'BAD_USER_INPUT', 400);
        const s = state.services.get(input.serviceId); if (!s) return gqlErr(res, 'Service not found');
        const domain = `127.0.0.1:${s.appPort}`;
        state.domains.push({ serviceId: s.id, domain, targetPort: input.targetPort ?? null });
        return send(res, 200, { data: { serviceDomainCreate: { id: id('dom'), domain } } });
      }
      case 'serviceInstanceDeployV2': return gqlErr(res, 'The stand-in deploys uploads only');
      case 'deployment': {
        const d = state.deployments.get(variables.id); if (!d) return gqlErr(res, 'Deployment not found');
        return send(res, 200, { data: { deployment: { id: d.id, status: d.status, url: null, staticUrl: null } } });
      }
      default: return gqlErr(res, `Cannot query that in the stand-in: ${query.slice(0, 60)}`, 'GRAPHQL_VALIDATION_FAILED', 400);
    }
  }

  const server = http.createServer(async (req, res) => {
    state.requests++;
    try {
      const u = new URL(req.url, 'http://x');
      if (u.pathname.startsWith('/oauth/')) return await oauth(req, res, u);
      if (u.pathname === '/graphql/v2' && req.method === 'POST') return await graphql(req, res);
      const up = /^\/project\/([^/]+)\/environment\/([^/]+)\/up$/.exec(u.pathname);
      if (up && req.method === 'POST') {
        if (!live(bearer(req))) return send(res, 401, { message: 'Not Authorized' });
        if (req.headers['content-type'] !== 'application/gzip') return send(res, 400, { message: 'expected application/gzip' });
        const svc = state.services.get(u.searchParams.get('serviceId'));
        const p = state.projects.get(up[1]);
        if (!svc || !p || p.env.id !== up[2] || svc.projectId !== p.id) return send(res, 400, { message: 'no such service in this project and environment' });
        const raw = await body(req);
        const files = untar(gunzipSync(raw));
        const dep = { id: id('dep'), status: 'BUILDING', files, serviceId: svc.id };
        state.deployments.set(dep.id, dep);
        state.uploads.push({ serviceId: svc.id, bytes: raw.length, files: files.map(f => f.name), message: u.searchParams.get('message') });
        setTimeout(() => deploy(dep, svc), 50);
        return send(res, 200, { deploymentId: dep.id, url: `${base}/project/${p.id}`, logsUrl: `${base}/project/${p.id}/service/${svc.id}?id=${dep.id}`, deploymentDomain: '' });
      }
      return send(res, 404, { message: 'not found' });
    } catch (e) { send(res, 500, { message: e.message }); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
  const close = async () => {
    for (const a of state.apps) { try { a.child.kill(); } catch {} }
    await Promise.all(state.apps.map(a => (a.child.exitCode != null ? null : new Promise(r => a.child.once('exit', r)))));
    for (const a of state.apps) { rmSync(a.dir, { recursive: true, force: true }); rmSync(a.data, { recursive: true, force: true }); }
    await new Promise(r => { server.close(() => r()); server.closeAllConnections?.(); });
  };
  return { base, state, close };
}
