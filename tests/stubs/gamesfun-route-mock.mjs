// A stand-in for games.fun's Supabase exchange route (creator-studio/app/api/kit/supabase{,/token,/refresh,/revoke}
// in the games.fun repository, documented in its docs/kit-publish.md "Connect Supabase" and
// games.fun's notes on the Supabase OAuth exchange, §4). It is shaped from that contract, not copied from it:
//   GET  /api/kit/supabase          {ready, client_id, redirect_uris, authorize_url, scopes, pkce}, or 503 not_configured
//                                   (state.mode 'off'), or 404 (state.mode 'missing': a games.fun without the route)
//   POST /api/kit/supabase/token    authorization_code (code, code_verifier, redirect_uri) or refresh_token; adds the
//                                   client secret (Basic) and forwards to the Supabase stand-in's /v1/oauth/token
//   POST /api/kit/supabase/refresh  refresh_token
//   POST /api/kit/supabase/revoke   refresh_token → {revoked: true}
// Rules kept from the contract: only the kit's two loopback redirects, PKCE required, a request with an Origin header
// refused 403, Supabase's refusal of a code or refresh token → 401 invalid_grant, its own trouble → 502, never 400/401.
import http from 'node:http';

export async function startGamesfunRoute({ supabase, callbackPort = 53841, mode = 'ready' } = {}) {
  const S = { mode, requests: [], exchanges: 0 };
  const REDIRECTS = [`http://127.0.0.1:${callbackPort}/callback`, `http://localhost:${callbackPort}/callback`];
  const send = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
  const fail = (res, status, error, error_description) => send(res, status, { error, error_description });
  const read = req => new Promise(r => { let d = ''; req.on('data', c => { d += c; }); req.on('end', () => r(d)); });
  const fields = (req, body) => {
    if (String(req.headers['content-type']).includes('json')) { try { return JSON.parse(body || '{}'); } catch { return null; } }
    return Object.fromEntries(new URLSearchParams(body));
  };
  async function upstream(form) {
    const basic = Buffer.from(`${supabase.state.clientId}:${supabase.state.clientSecret}`).toString('base64');
    const r = await fetch(`${supabase.url}/v1/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Basic ${basic}` }, body: new URLSearchParams(form).toString() });
    const j = await r.json().catch(() => null);
    return { status: r.status, j };
  }
  const tokens = ({ status, j }) => (status === 200 && j?.access_token
    ? { status: 200, body: { access_token: j.access_token, refresh_token: j.refresh_token, expires_in: j.expires_in, token_type: j.token_type ?? 'bearer' } }
    : status === 400 || status === 401 ? { status: 401, body: { error: 'invalid_grant', error_description: 'Supabase refused this sign-in code (it was already used, has expired, or access was removed). Connect Supabase again.' } }
      : { status: 502, body: { error: 'upstream_error', error_description: 'Supabase did not answer; try again later.' } });

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const body = await read(req);
    S.requests.push({ method: req.method, path: u.pathname, origin: req.headers.origin ?? null });
    if (!u.pathname.startsWith('/api/kit/supabase')) return fail(res, 404, 'not_found', 'Not here.');
    if (S.mode === 'missing') return fail(res, 404, 'not_found', 'This page could not be found.');
    if (req.headers.origin) return fail(res, 403, 'not_for_pages', 'This route is for the kit, not for web pages.');
    if (S.mode === 'off') return fail(res, 503, 'not_configured', 'Connect Supabase is not set up on this server (SUPABASE_OAUTH_CLIENT_ID and SUPABASE_OAUTH_CLIENT_SECRET).');
    if (req.method === 'GET' && u.pathname === '/api/kit/supabase') {
      return send(res, 200, { ready: true, client_id: supabase.state.clientId, redirect_uris: REDIRECTS, authorize_url: `${supabase.url}/v1/oauth/authorize`, scopes: ['organizations:read', 'projects:read', 'projects:write', 'secrets:read', 'secrets:write', 'database:read', 'database:write', 'auth:read', 'auth:write'], pkce: 'S256' });
    }
    if (req.method !== 'POST') return fail(res, 405, 'invalid_request', 'POST only.');
    const f = fields(req, body);
    if (!f) return fail(res, 400, 'invalid_request', 'The body is not JSON.');
    if (f.client_id != null && f.client_id !== supabase.state.clientId) return fail(res, 400, 'invalid_client', 'This sign-in was started with another Supabase app than this server\'s.');
    if (u.pathname === '/api/kit/supabase/revoke') {
      if (!f.refresh_token) return fail(res, 400, 'invalid_request', 'refresh_token is required.');
      await fetch(`${supabase.url}/v1/oauth/revoke`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_id: supabase.state.clientId, client_secret: supabase.state.clientSecret, refresh_token: f.refresh_token }) });
      return send(res, 200, { revoked: true });
    }
    const grant = u.pathname === '/api/kit/supabase/refresh' ? 'refresh_token' : f.grant_type;
    if (grant === 'refresh_token') {
      if (!f.refresh_token) return fail(res, 400, 'invalid_request', 'refresh_token is required.');
      const r = tokens(await upstream({ grant_type: 'refresh_token', refresh_token: f.refresh_token }));
      return send(res, r.status, r.body);
    }
    if (grant !== 'authorization_code' || u.pathname !== '/api/kit/supabase/token') return fail(res, 400, 'unsupported_grant_type', 'authorization_code or refresh_token.');
    if (!REDIRECTS.includes(f.redirect_uri ?? '')) return fail(res, 400, 'invalid_request', `redirect_uri must be the kit's own callback (${REDIRECTS.join(' or ')}).`);
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(f.code_verifier ?? '')) return fail(res, 400, 'invalid_request', 'code_verifier is required (PKCE).');
    if (!f.code) return fail(res, 400, 'invalid_request', 'code is required.');
    S.exchanges++;
    const r = tokens(await upstream({ grant_type: 'authorization_code', code: f.code, code_verifier: f.code_verifier, redirect_uri: f.redirect_uri }));
    return send(res, r.status, r.body);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, state: S, close: () => new Promise(r => { server.closeAllConnections?.(); server.close(r); }) };
}
