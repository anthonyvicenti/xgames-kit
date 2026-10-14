// The dev server answers only this machine, and only pages it served itself.
//   - It binds 127.0.0.1 (never 0.0.0.0), so nothing on the network can reach it.
//   - Host must be 127.0.0.1:<port> or localhost:<port>: a DNS-rebinding page (evil.example resolving to 127.0.0.1)
//     sends its own name as Host and is refused.
//   - Origin, when a browser sends one, must be this server's own: another site's page can't call the API, post to
//     signaling or open the signaling WebSocket. "null" origins (sandboxed frames, file://) are refused.
//   - The API also refuses requests a browser marks cross-site (Sec-Fetch-Site).
// Requests without Origin (curl, the CLI, a same-origin GET) are allowed: browsers always send Origin on cross-origin
// POSTs and WebSocket upgrades, so a missing Origin never comes from another site's page.

export const allowedHosts = port => [`127.0.0.1:${port}`, `localhost:${port}`];
export const allowedOrigins = port => [`http://127.0.0.1:${port}`, `http://localhost:${port}`];

/** → null when the request may proceed, else { status, reason }. */
export function refuse(headers, port, { api = false } = {}) {
  const host = String(headers.host ?? '').toLowerCase();
  if (!host) return { status: 400, reason: 'missing Host header' };
  if (!allowedHosts(port).includes(host)) return { status: 421, reason: `Host ${host} is not this server (use http://127.0.0.1:${port}/)` };
  const origin = headers.origin;
  if (origin !== undefined) {
    if (!allowedOrigins(port).includes(String(origin).toLowerCase())) return { status: 403, reason: `Origin ${origin} may not use this server` };
  }
  if (api) {
    const site = headers['sec-fetch-site'];
    if (site !== undefined && !['same-origin', 'none'].includes(String(site))) return { status: 403, reason: `cross-site request (${site})` };
  }
  return null;
}

/** Headers every response carries. */
export const BASE_HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'same-origin',
  // only this server's own pages may frame its pages (the studio frames the game)
  'x-frame-options': 'SAMEORIGIN',
  'content-security-policy': "frame-ancestors 'self'",
};
