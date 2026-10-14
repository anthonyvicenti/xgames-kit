// What a published game may carry, checked on the server for every kit publish (lib/kit-publish.mjs), whatever the
// kit already checked (the kit runs the same rules first, for a fast answer: gamesfun-kit builder/lib/publish/scan.mjs; the
// two lists move together, and tests/fixtures/publish-scan-cases.json is the same file in both repositories).
//
// 1. Secrets. A published game's files are public (docs/play-origin.md "Published means downloadable"). A file that
//    looks like a key is refused, in plain words, naming the file and line and never echoing the value. Keys that are
//    DESIGNED to be public pass: a Supabase anon key (a JWT whose role is "anon"; row-level security is what protects
//    the data) and a Supabase publishable key (sb_publishable_…). A service-role key, a secret key (sb_secret_…), any
//    other JWT, private keys, cloud and payment keys, .env files and wallet keypairs are refused.
// 2. Backend origins. A game that talks to its own backend (its Supabase project, its server) names the origins in
//    backend.json → origins at the game's root (the kit's `gamesfun backend connect` writes it: gamesfun-kit
//    builder/lib/backend/config.mjs). The play host adds exactly those to that game's content-security
//    policy (connect-src; the https ones also img-src and media-src) and nothing else; every other third-party request
//    stays refused.
// Pure (no Node imports): the Studio routes, the play host and the tests share it.

/** Key-shaped strings (the kit's general scanner, builder/lib/secret-patterns.mjs, plus Supabase's). */
export const SECRET_PATTERNS = [
  ['private key block', /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/g],
  ['OpenAI or Anthropic key', /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{24,}/g],
  ['Meshy key', /\bmsy_[A-Za-z0-9_-]{16,}/g],
  ['AWS access key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/g],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/g],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ['Stripe secret key', /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g],
  ['Supabase secret key', /\bsb_secret_[A-Za-z0-9_-]{16,}/g],
  ['Supabase access token', /\bsbp_[A-Za-z0-9]{20,}/g],
  ['database address with a password', /\bpostgres(?:ql)?:\/\/[^\s:@/'"]+:[^\s@/'"]+@/gi],
  ['games.fun publish token', /\bgfk_[A-Za-z0-9_-]{30,}/g],
  ['secret assigned a literal', /\b[A-Za-z0-9_]*(?:SECRET|API_KEY|APIKEY|PRIVATE_KEY|ACCESS_TOKEN|SERVICE_ROLE|PASSWORD)[A-Za-z0-9_]*["']?\s*[:=]\s*["']([A-Za-z0-9+/_=.-]{16,})["']/gi],
  ['Solana secret key (base58)', /(?<![A-Za-z0-9])[1-9A-HJ-NP-Za-km-z]{86,90}(?![A-Za-z0-9])/g],
];
const JWT = /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{16,}/g;

/** Files refused by name, wherever they are in the folder. */
export const REFUSED_FILES = [
  [/(^|\/)\.env(\.[^/]*)?$/i, 'a .env file (secrets live there, never in a game)'],
  [/\.(pem|key|p12|pfx)$/i, 'a key or certificate file'],
  [/(^|\/)id_(rsa|ed25519|ecdsa)[^/]*$/, 'an SSH key'],
  [/\.keypair\.json$/i, 'a wallet keypair'],
  [/(^|\/)service[-_]?account[^/]*\.json$/i, 'a cloud service-account key'],
];

const TEXT_EXT = /\.(m?js|cjs|json|jsonl|md|txt|html?|css|ya?ml|toml|ini|cfg|env|sh|ps1|py|ts|tsx|jsx|svg|csv|xml|example|map|glsl|wgsl|vert|frag)$/i;
const BINARY_EXT = /\.(glb|gltf|png|jpe?g|gif|webp|avif|ktx2|hdr|exr|wasm|bin|ogg|mp3|wav|m4a|flac|mp4|webm|zip|gz|woff2?|ttf|otf|ico|pck)$/i;
/** Files the scanner never reads (pictures, models, sounds, wasm): known binary extensions. */
export const isBinaryPath = path => BINARY_EXT.test(path);
/** Whether the scanner reads a file: known text extensions, or no NUL byte in the first 8 KB and not a known binary. */
export const looksText = (path, bytes) => TEXT_EXT.test(path) || (!BINARY_EXT.test(path) && !bytes.subarray(0, 8192).includes(0));
/** The scanner reads text files up to this size; bigger text (a bundled engine) is still scanned, in its first part. */
export const SCAN_BYTES = 4 * 1024 * 1024;

function base64urlJson(part) {
  try {
    const padded = part.replace(/-/g, '+').replace(/_/g, '/');
    const text = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
    return JSON.parse(decodeURIComponent(Array.from(text, c => '%' + c.charCodeAt(0).toString(16).padStart(2, '0')).join('')));
  } catch { return null; }
}
/** A JWT's role claim (Supabase keys carry one), or null when it is not a readable JWT. */
export function jwtRole(token) {
  const payload = base64urlJson(String(token).split('.')[1] ?? '');
  return payload && typeof payload === 'object' ? (typeof payload.role === 'string' ? payload.role : '') : null;
}
/** Keys designed to ship inside a browser game: a Supabase anon key, or a Supabase publishable key. */
export const isPublicKey = value => /^sb_publishable_[A-Za-z0-9_-]{16,}$/.test(value) || (/^eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value) && jwtRole(value) === 'anon');

const lineAt = (text, index) => text.slice(0, index).split('\n').length;

/**
 * Every secret-shaped thing in one file: [{path, line, kind}]. Never returns the value. `bytes` is a Uint8Array.
 * Binary files are not read (a key inside a PNG is not a thing anyone ships by accident).
 */
export function scanFile(path, bytes) {
  const hits = [];
  for (const [re, why] of REFUSED_FILES) if (re.test(path)) { hits.push({path, line: 0, kind: why}); break; }
  if (!looksText(path, bytes)) return hits;
  const text = new TextDecoder().decode(bytes.subarray(0, SCAN_BYTES));
  for (const [kind, re] of SECRET_PATTERNS) {
    re.lastIndex = 0;
    for (let m; (m = re.exec(text));) {
      if (kind === 'secret assigned a literal' && isPublicKey(m[1])) continue;
      hits.push({path, line: lineAt(text, m.index), kind});
      break;   // one hit per kind per file is enough to refuse it
    }
  }
  JWT.lastIndex = 0;
  for (let m; (m = JWT.exec(text));) {
    const role = jwtRole(m[0]);
    if (role === 'anon') continue;
    hits.push({path, line: lineAt(text, m.index), kind: role === 'service_role' ? 'Supabase service-role key (it bypasses row-level security: never in a game)' : role ? `a signed token with role "${role}"` : 'a signed token (JWT)'});
    break;
  }
  if (/\.json$/i.test(path)) {
    try { const v = JSON.parse(text); if (Array.isArray(v) && v.length === 64 && v.every(n => Number.isInteger(n) && n >= 0 && n < 256)) hits.push({path, line: 1, kind: 'a wallet keypair (64-byte array)'}); } catch { /* not JSON */ }
  }
  return hits;
}

/** The refusal, in plain words, for a list of hits (or null). */
export function secretsMessage(hits) {
  if (!hits.length) return null;
  const shown = hits.slice(0, 5).map(h => `${h.path}${h.line ? `:${h.line}` : ''} (${h.kind})`).join('; ');
  return `Nothing was published: ${hits.length === 1 ? 'a file looks like it holds a secret' : `${hits.length} files look like they hold secrets`}: ${shown}${hits.length > 5 ? '; …' : ''}. `
    + 'A published game is public, file by file. Keep keys on your own machine or in your backend; a browser game may only carry keys made to be public (a Supabase anon or publishable key, with row-level security on).';
}

// ---- Backend origins ---------------------------------------------------------------------------------------------

export const MAX_BACKEND_ORIGINS = 8;
const IP_LITERAL = /^(\d{1,3}(\.\d{1,3}){3}|\[[0-9a-f:.]+\])$/i;
const LOCAL_NAME = /(^|\.)(localhost|local|internal|lan|home|test|example|invalid)$/i;

/**
 * One backend origin, checked: https: or wss:, a public DNS name (no IP literal, no localhost or private suffix), no
 * path, query, credentials or wildcard, and not the Studio or the play host itself. → the normalised origin; throws
 * an Error whose message says what is wrong.
 */
export function backendOrigin(value, {own = []} = {}) {
  const bad = why => Error(`backend.json origins: ${JSON.stringify(value)} ${why}.`);
  if (typeof value !== 'string' || !value.trim()) throw bad('is not an origin');
  if (value.length > 200) throw bad('is too long');
  if (value.includes('*')) throw bad('has a wildcard; name each origin');
  let url;
  try { url = new URL(value.trim()); } catch { throw bad('is not a URL'); }
  const loopback = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/i.test(url.hostname) || /\.localhost$/i.test(url.hostname);
  if (loopback) throw bad('is on this machine: a published game cannot reach it. Connect a hosted project before publishing');
  if (!['https:', 'wss:'].includes(url.protocol)) throw bad('must start with https:// or wss://');
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) throw bad('must be an origin only (no path, query or user)');
  if (value.trim().replace(/\/+$/, '').toLowerCase() !== url.origin) throw bad(`must be written as ${url.origin}`);
  const host = url.hostname.toLowerCase();
  if (IP_LITERAL.test(host) || !host.includes('.') || LOCAL_NAME.test(host)) throw bad('must be a public name (no IP address, localhost or private name)');
  if (own.some(o => { try { return new URL(o).hostname.toLowerCase() === host; } catch { return false; } })) throw bad('is games.fun itself; the game reaches its own host without listing it');
  return url.origin;
}

/** The game's backend settings file, at its root (public values only). */
export const BACKEND_FILE = 'backend.json';

/**
 * The origins a game's backend.json asks for: {origins, problems}. `backend` is the parsed backend.json (or null:
 * no backend, the default). Strict for publishing (problems refuse it); the play host uses only `origins`.
 */
export function backendOrigins(backend, {own = []} = {}) {
  const list = backend?.origins;
  if (backend == null || list == null) return {origins: [], problems: backend?.url ? ['backend.json has a url but no origins; run `npx gamesfun backend connect` again to write them.'] : []};
  if (!Array.isArray(list)) return {origins: [], problems: ['backend.json origins must be a list of origins, like ["https://abcd.supabase.co", "wss://abcd.supabase.co"].']};
  const origins = [], problems = [];
  for (const value of list) {
    try { const o = backendOrigin(value, {own}); if (!origins.includes(o)) origins.push(o); } catch (e) { problems.push(e.message); }
  }
  if (origins.length > MAX_BACKEND_ORIGINS) { problems.push(`backend.json origins names ${origins.length} origins; at most ${MAX_BACKEND_ORIGINS}.`); origins.length = MAX_BACKEND_ORIGINS; }
  // The url the game's client calls must be one of them (else the published game would be refused at its first call).
  if (typeof backend.url === 'string' && backend.url) {
    let at = null; try { at = new URL(backend.url).origin; } catch { problems.push(`backend.json url ${JSON.stringify(backend.url)} is not an address.`); }
    if (at && !origins.includes(at) && !problems.length) problems.push(`backend.json url ${at} is not in its origins.`);
  }
  return {origins, problems};
}
