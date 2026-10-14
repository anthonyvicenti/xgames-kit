// A stand-in for Supabase's OAuth server and Management API, for tests. Shapes are recorded from Supabase's own
// documents (read 2026-10-12): the Management API's OpenAPI (https://api.supabase.com/api/v1-json: /v1/oauth/authorize,
// /v1/oauth/token (form, client_secret_basic or _post), /v1/oauth/revoke, /v1/organizations, /v1/projects,
// /v1/projects/available-regions, /v1/projects/{ref}, /v1/projects/{ref}/health, /v1/projects/{ref}/api-keys,
// /v1/projects/{ref}/database/query[/read-only], /v1/projects/{ref}/config/auth) and the OAuth discovery document
// (https://api.supabase.com/.well-known/oauth-authorization-server). Nothing here is Supabase's code.
//
// It also plays the games.fun exchange ("broker") the kit would use with games.fun's registered app: /broker/token and
// /broker/revoke add the client secret and forward. The consent screen is automatic: /v1/oauth/authorize redirects
// straight back with a code (or with ?deny=1 in the client id's place, an access_denied).
//
// For the one-button flow (builder/lib/backend/supabase-connect.mjs) it also answers GET /v1/organizations/{slug} (the plan),
// POST /v1/projects/{ref}/restore, POST /v1/projects/{ref}/database/migrations (Idempotency-Key honoured: a key seen
// before is not applied again) and refuses like Supabase where the docs say it does: a redirect host it was told to
// refuse (state.refuseHosts), a third active project on a free plan (state.freeLimit), a migration that fails.
import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';

// Secret-shaped strings are built at run time, so this file never holds one (and no scanner mistakes it for a leak).
const SECRET_PREFIX = ['sb', 'secret', ''].join('_');
const b64url = b => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const jwt = payload => `${b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64url(JSON.stringify(payload))}.${b64url(randomBytes(32))}`;
const ref = () => Array.from(randomBytes(20), b => 'abcdefghijklmnopqrstuvwxyz'[b % 26]).join('');

export async function startSupabaseMock({ clientId = '6f1c0d5e-4b7a-4c2e-9a3d-2b8e7f6a5c41', clientSecret = ['sb', 'secret', 'mockClientSecret0123456789'].join('_'), readyAfter = 2, expiresIn = 3600, port = 0 } = {}) {
  const S = {
    clientId, clientSecret, codes: new Map(), access: new Map(), refresh: new Map(), pats: new Set(), revoked: [],
    requests: [], orgs: [{ id: 'org1', slug: 'acme-games', name: 'Acme Games' }], projects: [], polls: new Map(),
    liveRows: null, authConfig: new Map(), queries: [],
    plan: 'free', refuseHosts: new Set(), freeLimit: false, migrations: [], migrationKeys: new Set(), migrationFail: null,
    restoreRefuse: null, tables: new Map(),
  };
  const project = (name, region, status = 'ACTIVE_HEALTHY') => {
    const p = { id: ref(), name, region, status, organization_id: 'org1', organization_slug: 'acme-games', created_at: new Date().toISOString(), database: { host: 'db.x.supabase.co', version: '17', postgres_engine: '17', release_channel: 'ga' } };
    p.ref = p.id;
    p.keys = [
      { name: 'anon', api_key: jwt({ iss: 'supabase', ref: p.ref, role: 'anon' }), id: 'anon', type: 'legacy', prefix: null },
      { name: 'service_role', api_key: jwt({ iss: 'supabase', ref: p.ref, role: 'service_role' }), id: 'service_role', type: 'legacy', prefix: null },
      { name: 'default', api_key: `sb_publishable_${b64url(randomBytes(16))}`, id: 'pub1', type: 'publishable', prefix: null },
      { name: 'default', api_key: `${SECRET_PREFIX}abcd••••••••••••`, id: 'sec1', type: 'secret', prefix: `${SECRET_PREFIX}abcd` },
    ];
    S.projects.push(p);
    return p;
  };
  S.addProject = project;
  project('existing-game', 'eu-central-1');

  const issue = () => {
    const access_token = `sbp_oauth_${b64url(randomBytes(24))}`, refresh_token = `rt_${b64url(randomBytes(24))}`;
    S.access.set(access_token, Date.now() + expiresIn * 1000);
    S.refresh.set(refresh_token, true);
    return { access_token, refresh_token, expires_in: expiresIn, token_type: 'Bearer' };
  };
  const send = (res, status, body, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(body === undefined ? '' : JSON.stringify(body)); };
  const read = req => new Promise(r => { let d = ''; req.on('data', c => { d += c; }); req.on('end', () => r(d)); });
  const clientAuth = (req, form) => {
    const h = req.headers.authorization ?? '';
    if (h.startsWith('Basic ')) { const [id, sec] = Buffer.from(h.slice(6), 'base64').toString().split(':'); return id === S.clientId && sec === S.clientSecret; }
    return form.get('client_id') === S.clientId && form.get('client_secret') === S.clientSecret;
  };
  const bearer = req => {
    const t = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    if (S.pats.has(t)) return true;
    const exp = S.access.get(t);
    return !!exp && exp > Date.now();
  };
  async function token(req, res, form) {
    if (!clientAuth(req, form)) return send(res, 401, { message: 'invalid client' });
    if (form.get('grant_type') === 'authorization_code') {
      const c = S.codes.get(form.get('code'));
      if (!c) return send(res, 400, { error: 'invalid_grant', error_description: 'unknown code' });
      S.codes.delete(form.get('code'));
      if (c.redirect_uri !== form.get('redirect_uri')) return send(res, 400, { error: 'invalid_grant', error_description: 'redirect_uri does not match' });
      if (b64url(createHash('sha256').update(form.get('code_verifier') ?? '').digest()) !== c.challenge) return send(res, 400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
      return send(res, 200, issue());
    }
    if (form.get('grant_type') === 'refresh_token') {
      if (!S.refresh.get(form.get('refresh_token'))) return send(res, 400, { error: 'invalid_grant', error_description: 'refresh token revoked' });
      S.refresh.delete(form.get('refresh_token'));
      return send(res, 200, issue());
    }
    return send(res, 400, { error: 'unsupported_grant_type' });
  }

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const body = await read(req);
    S.requests.push({ method: req.method, path: u.pathname, query: u.search });
    if (req.method === 'GET' && u.pathname === '/v1/oauth/authorize') {
      const q = u.searchParams;
      if (q.get('client_id') !== S.clientId) return send(res, 400, { message: 'unknown client' });
      if (q.get('response_type') !== 'code' || q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge')) return send(res, 400, { message: 'PKCE S256 required by this mock' });
      const back = new URL(q.get('redirect_uri'));
      if (S.refuseHosts.has(back.hostname)) return send(res, 400, { message: `redirect_uri ${q.get('redirect_uri')} is not registered for this app` });
      if (S.deny) { back.searchParams.set('error', 'access_denied'); back.searchParams.set('error_description', 'The user denied access'); }
      else { const code = b64url(randomBytes(16)); S.codes.set(code, { redirect_uri: q.get('redirect_uri'), challenge: q.get('code_challenge') }); back.searchParams.set('code', code); }
      back.searchParams.set('state', q.get('state') ?? '');
      res.writeHead(302, { location: back.href }); return res.end();
    }
    if (req.method === 'POST' && u.pathname === '/v1/oauth/token') return token(req, res, new URLSearchParams(body));
    if (req.method === 'POST' && u.pathname === '/v1/oauth/revoke') {
      const j = JSON.parse(body || '{}');
      if (j.client_id !== S.clientId || j.client_secret !== S.clientSecret) return send(res, 401, { message: 'invalid client' });
      S.refresh.delete(j.refresh_token); S.revoked.push(j.refresh_token); return send(res, 204);
    }
    // games.fun's exchange: adds the secret the kit never holds
    if (req.method === 'POST' && u.pathname === '/broker/token') { const f = new URLSearchParams(body); f.set('client_secret', S.clientSecret); return token(req, res, f); }
    if (req.method === 'POST' && u.pathname === '/broker/revoke') { const f = new URLSearchParams(body); S.refresh.delete(f.get('refresh_token')); S.revoked.push(f.get('refresh_token')); return send(res, 204); }

    if (!u.pathname.startsWith('/v1/')) return send(res, 404, { message: 'not found' });
    if (!bearer(req)) return send(res, 401, { message: 'Unauthorized' });
    if (req.method === 'GET' && u.pathname === '/v1/organizations') return send(res, 200, S.orgs);
    const om = /^\/v1\/organizations\/([\w-]+)$/.exec(u.pathname);
    if (req.method === 'GET' && om) { const o = S.orgs.find(x => x.slug === om[1]); return o ? send(res, 200, { id: o.id, name: o.name, plan: o.plan ?? S.plan }) : send(res, 404, { message: 'organization not found' }); }
    if (req.method === 'GET' && u.pathname === '/v1/projects') return send(res, 200, S.projects.map(({ keys, ...p }) => p));
    if (req.method === 'GET' && u.pathname === '/v1/projects/available-regions') {
      const all = [{ name: 'Central EU (Frankfurt)', code: 'eu-central-1', type: 'specific', provider: 'AWS' }, { name: 'East US (North Virginia)', code: 'us-east-1', type: 'specific', provider: 'AWS' }];
      return send(res, 200, { recommendations: { smartGroup: { name: 'EMEA', code: 'emea', type: 'smartGroup' }, specific: [all[0]] }, all: { smartGroup: [], specific: all } });
    }
    if (req.method === 'POST' && u.pathname === '/v1/projects') {
      const j = JSON.parse(body || '{}');
      if (!j.name || !j.organization_slug || !j.db_pass) return send(res, 400, { message: 'name, organization_slug and db_pass are required' });
      const activeFree = S.projects.filter(x => !/INACTIVE|PAUS/.test(x.status)).length;
      if (S.freeLimit && activeFree >= 2) return send(res, 400, { message: 'The following organization members have reached their maximum limits for the number of active free projects within organizations where they are an administrator or owner: you (2 project limit).' });
      S.lastDbPass = j.db_pass;
      S.lastRegion = j.region_selection;
      const p = project(j.name, j.region_selection?.code ?? j.region ?? 'us-east-1', 'COMING_UP');
      S.polls.set(p.ref, 0);
      const { keys, ...out } = p; return send(res, 201, out);
    }
    const m = /^\/v1\/projects\/([a-z]{20})(\/.*)?$/.exec(u.pathname);
    if (!m) return send(res, 404, { message: 'not found' });
    const p = S.projects.find(x => x.ref === m[1]);
    if (!p) return send(res, 404, { message: 'project not found' });
    const rest = m[2] ?? '';
    if (req.method === 'GET' && rest === '') {
      if (p.status === 'COMING_UP') { const n = (S.polls.get(p.ref) ?? 0) + 1; S.polls.set(p.ref, n); if (n >= (S.readyAfter ?? readyAfter)) p.status = 'ACTIVE_HEALTHY'; }
      const { keys, ...out } = p; return send(res, 200, out);
    }
    if (req.method === 'GET' && rest === '/health') return send(res, 200, (u.searchParams.get('services') ?? '').split(',').map(name => ({ name, status: p.status === 'ACTIVE_HEALTHY' ? 'ACTIVE_HEALTHY' : 'COMING_UP', healthy: p.status === 'ACTIVE_HEALTHY' })));
    if (req.method === 'GET' && rest === '/api-keys') return send(res, 200, p.keys.map(k => (k.type === 'secret' && u.searchParams.get('reveal') === 'true' ? { ...k, api_key: `${SECRET_PREFIX}REVEALEDfullValue123456` } : k)));
    if (req.method === 'POST' && rest === '/api-keys') { const k = { name: 'games', api_key: `sb_publishable_${b64url(randomBytes(16))}`, id: 'pub2', type: 'publishable' }; p.keys.push(k); return send(res, 201, k); }
    if (req.method === 'POST' && (rest === '/database/query' || rest === '/database/query/read-only')) { S.queries.push({ ref: p.ref, readOnly: rest.endsWith('read-only'), query: JSON.parse(body).query }); return send(res, 201, S.liveRows ?? [...(S.tables.get(p.ref) ?? [])].map(name => ({ name, kind: 'r', rls: true, policies: 2 }))); }
    if (req.method === 'POST' && rest === '/restore') {
      if (S.restoreRefuse) return send(res, 400, { message: S.restoreRefuse });
      p.status = 'COMING_UP'; S.polls.set(p.ref, 0); return send(res, 200, {});
    }
    if (req.method === 'POST' && rest === '/database/migrations') {
      const j = JSON.parse(body || '{}'), key = req.headers['idempotency-key'] ?? null;
      if (key && S.migrationKeys.has(`${p.ref}|${key}`)) return send(res, 200, {});
      if (S.migrationFail) return send(res, 400, { message: S.migrationFail });
      const made = [...String(j.query).matchAll(/create table (?:if not exists )?public\.(\w+)/gi)].map(m => m[1]);
      const have = S.tables.get(p.ref) ?? new Set();
      const dup = made.find(t => have.has(t));
      if (dup) return send(res, 400, { message: `ERROR:  42P07: relation "${dup}" already exists` });
      for (const t of made) have.add(t);
      S.tables.set(p.ref, have);
      S.migrations.push({ ref: p.ref, name: j.name, key, query: j.query });
      if (key) S.migrationKeys.add(`${p.ref}|${key}`);
      return send(res, 200, {});
    }
    if (req.method === 'PATCH' && rest === '/config/auth') { S.authConfig.set(p.ref, JSON.parse(body)); return send(res, 200, JSON.parse(body)); }
    return send(res, 404, { message: 'not found' });
  });
  await new Promise(r => server.listen(port, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, state: S, close: () => new Promise(r => server.close(r)) };
}
