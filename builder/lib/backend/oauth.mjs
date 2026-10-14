// A provider's OAuth 2 sign-in from the kit (RFC 6749 authorization code + RFC 7636 PKCE, with a loopback redirect,
// RFC 8252 §7.3): the person's own browser signs in to the provider, the provider sends the browser back to a small
// server on this machine, and the kit trades the code for tokens. Nothing of games.fun sees the password; the code
// and the tokens only pass through games.fun when the provider insists on a client secret and the kit is set up to
// use a broker for the exchange (builder/lib/backend/supabase.mjs says when).
//
// The callback server binds 127.0.0.1 only, answers only GET /start and GET /callback with this flow's Host, accepts
// one callback whose `state` matches, and closes after it or after `timeoutMs`. The kit opens /start (a localhost
// link, so builder/lib/open.mjs's rule "open only our own pages" holds), which redirects to the provider: the authorize link
// with its PKCE challenge never sits in a process's arguments.
import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';

export const b64url = buf => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** A PKCE pair: verifier (43+ chars) and its S256 challenge. */
export function pkce() {
  const verifier = b64url(randomBytes(48));
  return { verifier, challenge: b64url(createHash('sha256').update(verifier).digest()), method: 'S256' };
}

const page = (title, body) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font:16px/1.5 Arial,sans-serif;background:#0a0c16;color:#f4f4f5;display:grid;place-items:center;min-height:100vh;margin:0}main{max-width:32rem;padding:24px}h1{font-size:20px}</style>
<main><h1>${title}</h1><p>${body}</p></main>`;
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/**
 * Start a loopback sign-in. `authorizeUrl(redirectUri, state, challenge)` builds the provider's link.
 * ports: the fixed ports registered with the provider, tried in order (an OAuth redirect must match exactly).
 * → { startUrl, redirectUri, verifier, result: Promise<{ code }>, close() }
 */
export async function startLoopback({ ports, host = 'localhost', authorizeUrl, timeoutMs = 5 * 60 * 1000, label = 'the provider' }) {
  const state = b64url(randomBytes(24));
  const { verifier, challenge } = pkce();
  let settle;
  const result = new Promise((resolve, reject) => { settle = { resolve, reject }; });
  result.catch(() => {});   // the browser may finish (or refuse) before the caller awaits: handled there, never unhandled
  let done = false, server = null, port = null, redirectUri = null, timer = null;
  const finish = (err, value) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    // the answer page is written first; then the port is freed (keep-alive sockets too) before the caller goes on
    setImmediate(() => {
      if (!server) return err ? settle.reject(err) : settle.resolve(value);
      server.close(() => (err ? settle.reject(err) : settle.resolve(value)));
      server.closeAllConnections?.();
    });
  };
  const handler = (req, res) => {
    const send = (status, html, headers = {}) => { res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff', ...headers }); res.end(html); };
    const okHost = [`localhost:${port}`, `127.0.0.1:${port}`].includes(String(req.headers.host).toLowerCase());
    if (!okHost || req.method !== 'GET') return send(403, page('Refused', 'This page only answers this machine.'));
    const u = new URL(req.url, `http://127.0.0.1:${port}`);
    if (u.pathname === '/start') {
      if (done) return send(410, page('This sign-in is over', 'Start again from the kit.'));
      return send(302, '', { location: authorizeUrl(redirectUri, state, challenge) });
    }
    if (u.pathname !== '/callback') return send(404, page('Not here', ''));
    if (done) return send(410, page('This sign-in is over', 'Start again from the kit.'));
    if (u.searchParams.get('state') !== state) return send(400, page('Refused', 'This link is not the sign-in the kit started (the state does not match). Start again from the kit.'));
    const error = u.searchParams.get('error');
    if (error) {
      send(200, page('Not connected', `${esc(label)} said: ${esc(u.searchParams.get('error_description') || error)}. You can close this tab.`));
      return finish(new Error(`${label} did not connect: ${u.searchParams.get('error_description') || error}`));
    }
    const code = u.searchParams.get('code');
    if (!code) return send(400, page('Refused', 'No code came back.'));
    send(200, page('Connected', `Signed in to ${esc(label)}. You can close this tab and go back to the kit.`));
    finish(null, { code });
  };
  let lastErr = null;
  for (const p of ports) {
    const s = http.createServer(handler);
    try {
      await new Promise((resolve, reject) => { s.once('error', reject); s.listen(p, '127.0.0.1', resolve); });
      server = s; port = p; break;
    } catch (e) { lastErr = e; s.close(); }
  }
  if (!server) throw new Error(`no free port for the sign-in callback (tried ${ports.join(', ')}): ${lastErr?.message ?? ''}. Close what uses them and try again.`);
  redirectUri = `http://${host}:${port}/callback`;
  timer = setTimeout(() => finish(new Error(`the sign-in was not finished within ${Math.round(timeoutMs / 60000)} minutes; start again`)), timeoutMs);
  timer.unref?.();
  return { startUrl: `http://${host}:${port}/start`, redirectUri, verifier, state, result, close: () => finish(new Error('cancelled')) };
}

/** POST a form to a token endpoint. `basic`: [id, secret] for HTTP Basic client authentication. → the JSON. */
export async function postForm(url, fields, { basic = null, fetchImpl = fetch } = {}) {
  const headers = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
  if (basic) headers.authorization = `Basic ${Buffer.from(`${basic[0]}:${basic[1]}`).toString('base64')}`;
  const body = new URLSearchParams(Object.entries(fields).filter(([, v]) => v != null)).toString();
  const res = await fetchImpl(url, { method: 'POST', headers, body });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  if (!res.ok) {
    const why = json?.error_description || json?.message || json?.error || text.slice(0, 160);
    const e = new Error(`${new URL(url).host} refused the sign-in (${res.status}): ${why}`);
    e.status = res.status;
    throw e;
  }
  if (!json?.access_token) throw new Error(`${new URL(url).host} sent no access token`);
  return json;
}

/** A token response → what the kit saves (expiry as a time, not a duration). */
export const tokenRecord = (t, extra = {}) => ({
  access_token: t.access_token,
  refresh_token: t.refresh_token ?? null,
  expires_at: Number.isFinite(t.expires_in) ? Date.now() + t.expires_in * 1000 : null,
  token_type: t.token_type ?? 'Bearer',
  ...extra,
});
