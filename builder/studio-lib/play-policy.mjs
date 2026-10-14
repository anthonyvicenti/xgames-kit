// File-tree versions and the play origin: the shared contract (docs/play-origin.md).
// Pure module (no Node or DOM imports): Studio's server, its API routes, the worker and QA all import it.
//
// A file-tree version is a list of files stored by content: blobs live at `blobs/<sha256>`, and the tree itself
// is canonical JSON at `trees/<treeSha>.json`. The play origin serves a tree's files at
//   https://<PLAY_HOST>/v/<versionId>/<token>/<path>      (a saved version)
//   https://<PLAY_HOST>/d/<draftId>/<token>/<path>        (a Studio draft over a saved version)
//   https://<PLAY_HOST>/p/<slug>/<path>                   (a published game: public, no token; lib/publish.mjs)
// with PLAY_HEADERS. Games load their own files with relative URLs, so the prefix never matters to them.

export const TREE_FORMAT = 'gf-tree-v1';
export const TREE_LIMITS = { files: 5000, totalBytes: 512 * 1024 * 1024, fileBytes: 128 * 1024 * 1024 };
export const SHA256 = /^[0-9a-f]{64}$/;
export const blobKey = sha => `blobs/${sha}`;
export const treeKey = sha => `trees/${sha}.json`;

// Same rules as source-record.mjs sourcePath: relative, forward slashes, no dot segments, no control chars.
export function treePath(path) {
  if (typeof path !== 'string' || !path || path.length > 512 || path.startsWith('/') || path.includes('\\') || /[\u0000-\u001f\u007f]/.test(path)) throw Error(`Unsafe tree path: ${JSON.stringify(path)}`);
  const parts = path.split('/');
  if (parts.some(p => !p || p === '.' || p === '..')) throw Error(`Unsafe tree path: ${JSON.stringify(path)}`);
  return path;
}

export const MIME = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8', json: 'application/json; charset=utf-8', map: 'application/json; charset=utf-8', txt: 'text/plain; charset=utf-8',
  md: 'text/plain; charset=utf-8', csv: 'text/csv; charset=utf-8', ink: 'text/plain; charset=utf-8', pzl: 'text/plain; charset=utf-8', xml: 'application/xml',
  svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', ico: 'image/x-icon',
  ktx2: 'image/ktx2', hdr: 'application/octet-stream', exr: 'application/octet-stream',
  mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav', m4a: 'audio/mp4', flac: 'audio/flac', mp4: 'video/mp4', webm: 'video/webm',
  ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2',
  glb: 'model/gltf-binary', gltf: 'model/gltf+json', bin: 'application/octet-stream', wasm: 'application/wasm',
  pck: 'application/octet-stream', sog: 'application/octet-stream', ply: 'application/octet-stream', spz: 'application/octet-stream',
};
export const mimeFor = path => MIME[(/\.([a-z0-9]+)$/i.exec(path)?.[1] ?? '').toLowerCase()] ?? 'application/octet-stream';

/** Validate a tree object; returns it with paths sorted (canonical order). Throws with a readable message. */
export function validateTree(tree) {
  if (!tree || tree.schemaVersion !== 1 || tree.format !== TREE_FORMAT || !Array.isArray(tree.files)) throw Error('Not a gf-tree-v1 tree.');
  if (tree.files.length === 0 || tree.files.length > TREE_LIMITS.files) throw Error(`A tree holds 1–${TREE_LIMITS.files} files.`);
  const seen = new Set(); let total = 0;
  for (const f of tree.files) {
    treePath(f.path);
    if (seen.has(f.path)) throw Error(`Duplicate tree path ${f.path}.`);
    seen.add(f.path);
    if (!SHA256.test(f.sha256 ?? '')) throw Error(`Bad sha256 for ${f.path}.`);
    if (!Number.isInteger(f.bytes) || f.bytes < 0 || f.bytes > TREE_LIMITS.fileBytes) throw Error(`Bad size for ${f.path}.`);
    total += f.bytes;
  }
  if (total > TREE_LIMITS.totalBytes) throw Error('Tree is larger than the play-origin limit.');
  if (!seen.has('index.html')) throw Error('A tree needs index.html at its root.');
  return { schemaVersion: 1, format: TREE_FORMAT, files: [...tree.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)).map(f => ({ path: f.path, sha256: f.sha256, bytes: f.bytes, mime: f.mime ?? mimeFor(f.path) })) };
}

/** A connect-src origin: ws:, wss: or https: with a host, no path, query, credentials or wildcard. Returns it normalised; throws otherwise. */
export function connectOrigin(value) {
  const bad = () => Error(`Bad connect origin: ${JSON.stringify(value)}`);
  if (typeof value !== 'string' || value.includes('*')) throw bad();
  let url;
  try { url = new URL(value); } catch { throw bad(); }
  if (!['ws:', 'wss:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash
    || url.pathname !== '/' || value.replace(/\/+$/, '').toLowerCase() !== url.origin) throw bad();
  return url.origin;
}

/**
 * Headers for every play-origin response. Games may be framed by `studioOrigin` (one origin or a list) and by the play origin itself
 * ('self'): the multiplayer party page (gf/mp/index.html) frames its own game from the same origin (2026-10-07).
 * Same-origin requests (fetch, workers, wasm) are allowed; every third-party request is refused.
 * `isolated` (assets.json `runtime.crossOriginIsolated: true`) adds COOP/COEP for SharedArrayBuffer games.
 * `embedders`: more origins that may frame it (published games only: PUBLIC_EMBEDDERS).
 * `connect`: more origins the page may open connections to (connect-src): the live relay's wss:// origin for published
 * games (lib/watch-config.mjs relayOrigin). Only ws:, wss: and https: origins, no paths, no wildcards; else it throws.
 * `backend`: the game's own backend origins (its backend.json → origins, checked by lib/publish-scan.mjs
 * backendOrigins): added to connect-src, and the https ones to img-src and media-src (pictures and sounds from the
 * game's own storage). Per game: each tree's files carry only that tree's origins (docs/kit-publish.md "Backends").
 */
export function playHeaders({ studioOrigin, isolated = false, mime, embedders = [], connect = [], backend = [] }) {
  const own = backend.map(connectOrigin);
  const extraConnect = [...new Set([...connect.map(connectOrigin), ...own])];
  const media = own.filter(o => o.startsWith('https:'));
  const csp = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob:",
    "worker-src 'self' blob:",
    ["connect-src 'self' blob: data:", ...extraConnect].join(' '),
    ["img-src 'self' data: blob:", ...media].join(' '),
    ["media-src 'self' data: blob:", ...media].join(' '),
    "font-src 'self' data:",
    "style-src 'self' 'unsafe-inline'",
    "object-src 'none'", "base-uri 'none'", "form-action 'none'",
    // 'self': the multiplayer party page (gf/mp/index.html, kit gf-multiplayer) frames the game from the same origin.
    `frame-ancestors ${["'self'", ...[studioOrigin].flat(), ...embedders].filter(Boolean).join(' ')}`,
  ].join('; ');
  const h = {
    'content-security-policy': csp,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    // A COEP:require-corp embedder (Studio framing an isolated game, or the worker's own HTTP-playtest harness,
    // studio-worker/tools/playtest-http.mjs) can only load a cross-origin sub-document that opts in with
    // `cross-origin`; `same-origin` here would make Chrome refuse the very framing §2 relies on. Non-isolated
    // games keep the tighter default, since nothing embedding them sets COEP.
    'cross-origin-resource-policy': isolated ? 'cross-origin' : 'same-origin',
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  };
  if (mime) h['content-type'] = mime;
  if (isolated) { h['cross-origin-opener-policy'] = 'same-origin'; h['cross-origin-embedder-policy'] = 'require-corp'; }
  return h;
}

/**
 * Who else may frame a published game's files (/p/ only; never /v/ or /d/, whose URLs carry a token): X, so a post
 * linking /play/<slug> plays the game inside the post (lib/x-card.mjs). The game listens to its ancestors for the
 * host bridge (gf-three kit/net/host.js), which is why this is a short list and not every site.
 */
export const PUBLIC_EMBEDDERS = Object.freeze(['https://x.com', 'https://*.x.com', 'https://twitter.com', 'https://*.twitter.com']);

/** The iframe sandbox for play-origin games: a distinct origin, so allow-same-origin is safe and games get storage. */
export const PLAY_SANDBOX = 'allow-scripts allow-same-origin allow-pointer-lock';

// ---- Host routing and capability tokens (docs/play-origin.md §2) --------------------------------
// PLAY_HOST is one configured value (env), never derived from a request: production sets it to the
// play subdomain ("play.<studio domain>"); local dev sets it to "play.localhost:<port>" (scripts/local-dev.sh
// setup writes it). Normally it is "play." plus the Studio host (same port), which is how studioOriginFromPlayHost
// gets back to the framing Studio origin; when it isn't (two *.vercel.app aliases), STUDIO_ORIGIN says so (studioOriginFor).
// Exact loopback names, or any *.localhost subdomain (Chrome resolves those to loopback too, e.g. "play.localhost").
const LOOPBACK_HOSTNAME = /^(localhost|127\.0\.0\.1|\[?::1\]?)$|\.localhost$/i;
const originFor = host => `${LOOPBACK_HOSTNAME.test((host ?? '').split(':')[0]) ? 'http' : 'https'}://${host}`;

// A custom domain (2026-10-12: agentgames.fun) adds names without retiring the old ones: every game made before it
// carries the old play host's signaling URL, and links already posted must keep working. PLAY_HOST is the one new
// links use; PLAY_HOST_ALIASES (comma-separated hosts) are answered as the play host too. STUDIO_ORIGIN_ALIASES
// (comma-separated origins) may frame play-origin games beside studioOriginFor's.
const listOf = value => (value ?? '').split(',').map(v => v.trim()).filter(Boolean);
/** Every host answered as the play host, lower case: PLAY_HOST first, then PLAY_HOST_ALIASES. Empty when PLAY_HOST is unset. */
export function playHosts(env = process.env) {
  const main = env.PLAY_HOST?.trim().toLowerCase();
  return main ? [...new Set([main, ...listOf(env.PLAY_HOST_ALIASES).map(h => h.toLowerCase())])] : [];
}
/** Whether `requestHost` (a Host header, no scheme) is the configured play origin (PLAY_HOST or one of its aliases). */
export function isPlayHost(requestHost, env = process.env) {
  return playHosts(env).includes((requestHost ?? '').trim().toLowerCase());
}
/**
 * The play host a request counts as our own, for the same-origin checks of signaling and world saves: the page's own
 * host when its Origin is one of ours (a game on the new domain calling the old alias's signaling is not an outside
 * game), else the host the request was made to when that is ours, else PLAY_HOST. null when PLAY_HOST is unset.
 * @param {Request} request
 */
export function ownPlayHost(request, env = process.env) {
  const hosts = playHosts(env);
  let page = '';
  try { page = new URL(request.headers.get('origin') ?? '').host.toLowerCase(); } catch { /* no or opaque Origin */ }
  if (hosts.includes(page)) return page;
  const asked = requestHost(request.headers).trim().toLowerCase();
  return hosts.includes(asked) ? asked : (hosts[0] ?? null);
}
/** The absolute play origin ("https://play.example.com"), or null when PLAY_HOST is unset. */
export function playOrigin(env = process.env) {
  const host = env.PLAY_HOST?.trim();
  return host ? originFor(host) : null;
}
/** The Studio origin that frames play-origin games, derived from PLAY_HOST by stripping its "play." prefix. */
export function studioOriginFromPlayHost(playHost) {
  if (!playHost) return null;
  const [hostname, port] = playHost.split(':');
  const stripped = hostname.startsWith('play.') ? hostname.slice(5) : hostname;
  return originFor(stripped + (port ? ':' + port : ''));
}

/**
 * The Studio origin allowed to frame play-origin games (CSP frame-ancestors). STUDIO_ORIGIN wins when set: a
 * *.vercel.app deployment can't have a "play." subdomain, so there the play host is a second alias of the same
 * project (e.g. games-fun-play.vercel.app) and the Studio origin is configured explicitly. Otherwise it is PLAY_HOST
 * with its "play." prefix stripped.
 */
export function studioOriginFor(env = process.env) {
  const explicit = env.STUDIO_ORIGIN?.trim().replace(/\/+$/, '');
  return explicit || studioOriginFromPlayHost(env.PLAY_HOST?.trim());
}
/** Every Studio origin allowed to frame play-origin games: studioOriginFor's first, then STUDIO_ORIGIN_ALIASES. */
export function studioOriginsFor(env = process.env) {
  const main = studioOriginFor(env);
  return main ? [...new Set([main, ...listOf(env.STUDIO_ORIGIN_ALIASES).map(o => o.replace(/\/+$/, ''))])] : [];
}

/**
 * A page asked for on an old Studio name (one of STUDIO_ORIGIN_ALIASES' hosts) moves to the Studio origin, same path
 * and query: a game talks to one Studio origin (the voice and live messages, gf-multiplayer party.js studioOrigin()),
 * and a session lives on one host. Only GET and HEAD pages: /api/* (the operator API, the kit's publish client, whose
 * bearer token a browser-style redirect would drop) keeps answering on every name. Returns the target URL or null.
 */
export function oldStudioNameRedirect(host, method, pathAndQuery, env = process.env) {
  if (method !== 'GET' && method !== 'HEAD') return null;
  if (/^\/api(\/|$)/.test(pathAndQuery)) return null;
  const main = studioOriginFor(env);
  if (!main) return null;
  const asked = (host ?? '').trim().toLowerCase();
  const old = listOf(env.STUDIO_ORIGIN_ALIASES).map(o => { try { return new URL(o).host.toLowerCase(); } catch { return null; } });
  if (!asked || !old.includes(asked) || new URL(main).host.toLowerCase() === asked) return null;
  return main + (pathAndQuery.startsWith('/') ? pathAndQuery : '/' + pathAndQuery);
}

/**
 * A sign-in that Supabase sends to the site's root instead of /auth/callback: when the redirectTo a sign-in asked for
 * is not on Supabase's allowed list, it falls back to its Site URL with the PKCE code (or the error) as the query. That
 * happened on 2026-10-12 when Studio moved to agentgames.fun before the list had the new name, and the creator could not
 * get back into Studio. → '/auth/callback?<query>' (with next=/studio when none was given), or null.
 */
export function strayAuthReturn(pathname, search) {
  if (pathname !== '/' || !search) return null;
  const q = new URLSearchParams(search);
  if (!q.has('code') && !q.has('token_hash') && !q.has('error_description')) return null;
  if (!q.has('next')) q.set('next', '/studio');
  return '/auth/callback?' + q.toString();
}

/**
 * Trailing slashes (next.config.ts sets skipTrailingSlashRedirect, so proxy.ts applies this). A public game's folder
 * URL (/p/<slug>/, /p/<slug>/gf/mp/) keeps its slash and serves that folder's index.html, so the page's relative URLs
 * resolve inside the folder. Every other path keeps Next's default: a 308 to the same path without the slash.
 * Returns that redirect target, or null.
 */
export function trailingSlashRedirect(pathname) {
  if (typeof pathname !== 'string' || pathname === '/' || !pathname.endsWith('/') || /^\/p\/[^/]+\//.test(pathname)) return null;
  return pathname.replace(/\/+$/, '') || '/';
}

/**
 * The host a request was made to, read the way proxy.ts reads it: the first X-Forwarded-Host, else Host.
 * @param {{get(name: string): string | null}} headers
 */
export function requestHost(headers) {
  return headers.get('x-forwarded-host')?.split(',')[0]?.trim() || headers.get('host') || '';
}
/**
 * The host check for the play routes themselves (app/v, app/d, app/p, app/signal/v1). proxy.ts's matcher skips those
 * paths, so a game file costs one function call and not two (middleware + route; 2026-10-08 usage spike), and each
 * route answers this 404 itself when the request isn't for PLAY_HOST. Returns that Response, or null to go on.
 * @param {Request} request
 */
export function offPlayHost(request, env = process.env) {
  if (isPlayHost(requestHost(request.headers), env)) return null;
  return new Response('Not found', {status: 404, headers: {'cache-control': 'no-store'}});
}

export const PLAY_TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // at least 12 h (docs/play-origin.md §2)
// A token's expiry is rounded up to a whole hour, so every mint for one id within the same hour gives the same token,
// and so the same URL. A page that asks again (a poll, a remount, an old open tab) then gets a URL the browser already
// holds, and an iframe whose src doesn't change doesn't reload. Lifetime: from 12 h up to 13 h. On 2026-10-08, Studio
// tabs that minted a fresh token every minute reloaded two whole games each time, about 1,000 play-host requests a minute.
export const PLAY_TOKEN_STEP_MS = 60 * 60 * 1000;
const te = new TextEncoder();
const base64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function fromBase64url(value) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/'), pad = padded.length % 4 ? '='.repeat(4 - (padded.length % 4)) : '';
  return Uint8Array.from(atob(padded + pad), c => c.charCodeAt(0));
}
const hmacKey = secret => crypto.subtle.importKey('raw', te.encode(secret), {name: 'HMAC', hash: 'SHA-256'}, false, ['sign', 'verify']);
const tokenMessage = (kind, id, exp) => `${kind}|${id}|${exp}`;

/**
 * A capability token for `kind` ('v' a version, 'd' a draft) and `id`: `<exp>.<sig>`, HMAC-SHA256(secret, "kind|id|exp").
 * `exp` is now + ttlMs rounded up to a multiple of stepMs, so the same id within one step gets the same token.
 */
export async function mintPlayToken(secret, kind, id, {ttlMs = PLAY_TOKEN_TTL_MS, stepMs = PLAY_TOKEN_STEP_MS, now = Date.now()} = {}) {
  const exp = Math.ceil((now + ttlMs) / stepMs) * stepMs, key = await hmacKey(secret);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, te.encode(tokenMessage(kind, id, exp))));
  return `${exp}.${base64url(sig)}`;
}
/** Verifies a token minted by mintPlayToken for the same secret, kind and id, and that it has not expired. Constant-time. */
export async function verifyPlayToken(secret, kind, id, token, {now = Date.now()} = {}) {
  if (typeof token !== 'string') return false;
  const dot = token.indexOf('.');
  if (dot < 1) return false;
  const exp = Number(token.slice(0, dot));
  if (!Number.isFinite(exp) || exp < now) return false;
  let sig;
  try { sig = fromBase64url(token.slice(dot + 1)); } catch { return false; }
  const key = await hmacKey(secret);
  return crypto.subtle.verify('HMAC', key, sig, te.encode(tokenMessage(kind, id, exp)));
}
