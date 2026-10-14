// Shared by the multiplayer kit's tools (adopt.mjs, serve.mjs, gate.mjs, detect.mjs, rollout.mjs, status.mjs):
//   everything in manifest.mjs (validateMultiplayer, kitFiles, checkKit, readManifest, …), re-exported
//   startParty()          a loopback server for one game folder plus the host-join signaling endpoints, on one port
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { attachSignaling } from '../p2p/signal-server.mjs';
import { KIT_DIR } from './manifest.mjs';

const WATCH_RELAY = new URL('../../watch/relay/node.mjs', import.meta.url);

export * from './manifest.mjs';

// ---------------- loopback server: one game folder + signaling ----------------
const TYPES = { '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.map': 'application/json', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.wasm': 'application/wasm', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.bin': 'application/octet-stream', '.ktx2': 'image/ktx2', '.hdr': 'application/octet-stream',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.pck': 'application/octet-stream', '.ink': 'text/plain; charset=utf-8', '.pzl': 'text/plain; charset=utf-8' };

/**
 * Serve `dir` at / with signaling on the same port: the WebSocket at /signal and HTTP at /signal/v1 (the transport the
 * kit uses off localhost, or here with ?signal=http). `overlay` (Map path → Buffer) wins over files on disk:
 * the gate uses it to try a game with the kit and a draft manifest before anything is written into the game.
 * `transports` turns either signaling transport off (the kit's fallback tests: a host with no HTTP signaling, or none).
 */
// `studio`: the origin /watch/v1 names as Studio's (default none: the friends page then trusts its own origin); a check
// that puts a stand-in Studio page on another origin above the friends page passes that page's origin (kit 1.7.2).
export async function startParty({ dir, port = 0, host = '127.0.0.1', overlay = null, isolated = false, log = () => {}, transports = ['ws', 'http'], watch = true, studio = null } = {}) {
  const base = resolve(dir);
  const requests = [];
  const server = createServer(async (req, res) => {
    if (transports.includes('http') && sig.handleHttp(req, res)) return;      // HTTP signaling: POST /signal/v1, GET /signal/v1/ice
    const url = new URL(req.url, 'http://x');
    // watch then play (gf-multiplayer 1.6.0, watch/PLAN.md): the play host's config answer and the stream relay
    if (url.pathname === '/watch/v1') { res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); return res.end(JSON.stringify({ v: 1, relay: relay ? `ws://${req.headers.host}/watch/v1/` : null, studio: studio ?? null })); }
    if (relay?.handleHttp(req, res)) return;
    const send = (code, body, type = 'text/plain; charset=utf-8') => {
      const headers = { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
      if (isolated) { headers['cross-origin-opener-policy'] = 'same-origin'; headers['cross-origin-embedder-policy'] = 'require-corp'; headers['cross-origin-resource-policy'] = 'same-origin'; }
      res.writeHead(code, headers); res.end(req.method === 'HEAD' ? undefined : body);
    };
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, 'method not allowed');
    let rel;
    try { rel = decodeURIComponent(url.pathname.slice(1)); } catch { return send(400, 'bad path'); }
    if (rel === '' || rel.endsWith('/')) rel += 'index.html';
    requests.push(rel);
    if (overlay?.has(rel)) return send(200, overlay.get(rel), TYPES[extname(rel).toLowerCase()] ?? 'application/octet-stream');
    const file = resolve(base, rel);
    if (file !== base && !file.startsWith(base + sep)) return send(403, 'forbidden');
    try {
      const st = await stat(file);
      if (st.isDirectory()) { res.writeHead(301, { location: `${url.pathname}/${url.search}` }); return res.end(); }
      return send(200, await readFile(file), TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream');
    } catch { return send(404, 'not found'); }
  });
  const sig = attachSignaling(server, { path: '/signal', log });
  // the stream relay's WebSockets go with the others: a server without WebSockets has neither (its listener would otherwise
  // hold other upgrade requests open instead of letting Node close them)
  // The relay is loaded only here, and only when it is in the checkout (builder/watch/relay): a server for a game that
  // never streams does not need the folder. Without it /watch/v1 answers relay: null, which is what a play host with
  // no relay answers, and the log says so once.
  let relay = null;
  if (watch && transports.includes('ws')) {
    if (existsSync(fileURLToPath(WATCH_RELAY))) relay = (await import(WATCH_RELAY.href)).attachWatchRelay(server, { path: '/watch/v1/', log });
    else log('watch: builder/watch/relay is not in this checkout, so this server has no stream relay (watch then play is off)');
  }
  if (!transports.includes('ws')) server.removeAllListeners('upgrade');      // no listener: Node closes upgrade requests
  await new Promise((ok, no) => { server.once('error', no); server.listen(port, host, ok); });
  const at = server.address().port;
  return { server, sig, relay, port: at, requests, url: `http://${host}:${at}/`, partyUrl: `http://${host}:${at}/${KIT_DIR}/`,
    close: () => new Promise(r => { sig.close(); relay?.close(); server.close(r); server.closeAllConnections?.(); }) };
}
