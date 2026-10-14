#!/usr/bin/env node
// Your own signaling server, for friends on different networks when you do not use ours (SELF_HOST.md). It only
// introduces players (a six-letter code, then offer / answer / ICE); the game itself runs player to player. One process,
// no database, nothing stored on disk: a restart forgets every open room.
//   node builder/multiplayer/p2p/serve-signal.mjs [--port 5352] [--host 0.0.0.0] [--allow <origin>[,<origin>…]|*]
// Then point a game at it: open the game with  ?signal=https://YOUR-HOST/signal/v1  (put it behind HTTPS; a game served over
// https can only talk to an https server). --allow names the pages that may use it (their Origin), "*" lets any page.
// GET /signal/v1/ice answers with public STUN, plus a TURN relay when TURN_URLS (with TURN_USERNAME and TURN_CREDENTIAL)
// is set in the environment. Without a relay a few pairs of networks cannot connect (README, "Transport and ICE").
// Limits are signal-core.mjs SIGNAL_LIMITS, per address: 10 rooms a minute, 60 an hour, 30 join attempts a minute.
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { attachSignaling } from './signal-server.mjs';

/** The CORS headers for `origin` under an allow list ('*' or a Set of origins), or null when it is not allowed. */
export function corsFor(origin, allow) {
  if (!origin) return {};
  if (allow !== '*' && !allow.has(origin)) return null;
  return { 'access-control-allow-origin': origin, vary: 'Origin', 'access-control-allow-methods': 'POST, GET, OPTIONS', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '600' };
}

export async function startSignalServer({ port = 5352, host = '0.0.0.0', allow = '*', log = console.log, env = process.env } = {}) {
  const allowed = allow === '*' ? '*' : new Set(String(allow).split(',').map(s => s.trim()).filter(Boolean));
  const server = createServer((req, res) => {
    const origin = req.headers.origin ?? null;
    const cors = corsFor(origin, allowed);
    if (cors === null) { res.writeHead(403, { 'content-type': 'application/json' }); res.end(JSON.stringify({ t: 'error', code: 'bad', reason: 'this page is not on the server\'s allow list' })); return; }
    for (const [k, v] of Object.entries(cors)) res.setHeader(k, v);
    if (req.method === 'OPTIONS') { res.writeHead(204, { 'cache-control': 'no-store' }); res.end(); return; }
    if (sig.handleHttp(req, res)) return;
    if (req.url === '/healthz') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, signaling: sig.stats() })); return; }
    res.writeHead(404, { 'content-type': 'text/plain' }); res.end('signaling only: POST /signal/v1, GET /signal/v1/ice');
  });
  // checkOrigin false: pages are not on this server's origin by design; --allow is the gate instead.
  const sig = attachSignaling(server, { path: '/signal', checkOrigin: false, log, env });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  return { server, sig, url: `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${server.address().port}/signal/v1`, close: () => new Promise(r => { sig.close(); server.close(r); server.closeAllConnections?.(); }) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const a = process.argv.slice(2);
  const opt = (k, d) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
  const s = await startSignalServer({ port: Number(opt('--port', 5352)), host: opt('--host', '0.0.0.0'), allow: opt('--allow', '*') });
  console.log(`signaling on ${s.url} (pages allowed: ${opt('--allow', '*')}). Ctrl-C to stop.`);
}
