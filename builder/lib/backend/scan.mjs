// Secrets never enter a game's files (an invariant: true of every game). This scan walks a game
// folder and names every key-shaped string, with Supabase's own shapes added to the kit's general scanner
// (builder/lib/secret-patterns.mjs):
//   - a Supabase secret key (sb_secret_…) or personal access / OAuth token (sbp_…);
//   - a signed token (JWT) whose role is not `anon`: the service-role key, a user's session, an admin token. The
//     legacy anon key is a JWT with role `anon` and is public by design, so it passes;
//   - a Postgres connection string with a password;
//   - a .env file, a key or certificate file (by name).
// `gamesfun backend check` runs it, `backend connect` runs it before it writes anything, and publishing
// refuses a game it flags. It is a pattern scan: it finds the shapes above, not a secret someone disguised.
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { SECRET_PATTERNS } from '../secret-patterns.mjs';
import { jwtPayload } from './supabase.mjs';

const SKIP_DIRS = new Set(['node_modules', '.git', '.gf-loop']);
const BINARY = /\.(glb|gltf|bin|png|jpe?g|webp|gif|avif|ktx2|basis|hdr|exr|wasm|ogg|mp3|wav|m4a|flac|mp4|webm|zip|gz|br|ttf|otf|woff2?|ico|pck)$/i;
const OWN = [
  ['Supabase secret key (sb_secret_)', /\bsb_secret_[A-Za-z0-9_-]{8,}/],
  ['Supabase access token (sbp_)', /\bsbp_[A-Za-z0-9_]{16,}/],
  ['database connection string with a password', /\bpostgres(?:ql)?:\/\/[^\s:@/'"]+:[^\s@/'"]{3,}@/i],
];
// the generic JWT shape is replaced by the role-aware check below; the rest of the general scanner's list stays
const BY_NAME = [
  [/(^|\/)\.env(\.[^/]*)?$/, 'a .env file (secrets live there)'],
  [/\.(pem|key|p12|pfx)$/i, 'a key or certificate file'],
  [/(^|\/)id_(rsa|ed25519|ecdsa)[^/]*$/, 'an SSH key'],
  [/\.keypair\.json$/i, 'a wallet keypair'],
];
const GENERIC = SECRET_PATTERNS.filter(([kind]) => kind !== 'JSON web token');
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{16,}/g;

const lineAt = (text, i) => text.slice(0, i).split('\n').length;

/** → [{ file, kind, line }] for one file's text. */
export function scanText(rel, text) {
  const hits = [];
  for (const [kind, re] of [...OWN, ...GENERIC]) {
    const m = new RegExp(re.source, re.flags.replace('g', '')).exec(text);
    if (m) hits.push({ file: rel, kind, line: lineAt(text, m.index) });
  }
  for (const m of text.matchAll(JWT)) {
    const p = jwtPayload(m[0]);
    if (p?.role === 'anon') continue;
    hits.push({ file: rel, kind: p?.role === 'service_role' ? 'Supabase service-role key (a JWT with role service_role)' : `a signed token (JWT, role ${p?.role ?? 'unknown'}) that is not the public anon key`, line: lineAt(text, m.index) });
  }
  return hits;
}

/** Walk a game folder. → { ok, files, hits: [{ file, kind, line }] } */
export async function scanGame(dir) {
  const hits = [];
  let files = 0;
  async function walk(d) {
    let entries = [];
    try { entries = await readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const abs = path.join(d, e.name);
      const rel = path.relative(dir, abs).split(path.sep).join('/');
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) await walk(abs); continue; }
      if (!e.isFile()) continue;
      files++;
      const byName = BY_NAME.find(([re]) => re.test(rel));
      if (byName && !/\.env\.example$/.test(rel)) { hits.push({ file: rel, kind: byName[1], line: 0 }); continue; }
      if (BINARY.test(e.name)) continue;
      let buf;
      try { buf = await readFile(abs); } catch { continue; }
      if (buf.length > 8 * 1024 * 1024 || buf.subarray(0, 4096).includes(0)) continue;
      hits.push(...scanText(rel, buf.toString('utf8')));
    }
  }
  await walk(dir);
  return { ok: hits.length === 0, files, hits };
}

/** The hits in words, one per line. */
export const describeHits = hits => hits.map(h => `${h.file}${h.line ? `:${h.line}` : ''}: ${h.kind}`).join('\n');
