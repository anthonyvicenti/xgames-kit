// Helpers for route handlers (builder/server/routes/*.mjs may import them; they are optional: handlers get plain Node req/res).
import { BASE_HEADERS } from './security.mjs';

export class HttpError extends Error {
  /** extra: more fields for the JSON body beside `error` (a refused slot write sends its `problems`, in words) */
  constructor(status, message, extra = null) { super(message); this.status = status; this.extra = extra; }
}

export function sendJson(res, status, body) {
  if (res.headersSent) return;
  res.writeHead(status, { ...BASE_HEADERS, 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

export function sendText(res, status, text, type = 'text/plain; charset=utf-8') {
  if (res.headersSent) return;
  res.writeHead(status, { ...BASE_HEADERS, 'content-type': type });
  res.end(text);
}

/** The request body as a Buffer, refusing more than `limit` bytes (413). */
export function readBody(req, { limit = 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0, over = false;
    req.on('data', c => {
      if (over) return;
      size += c.length;
      if (size > limit) { over = true; reject(new HttpError(413, `request body over ${limit} bytes`)); req.resume(); return; }
      chunks.push(c);
    });
    req.on('end', () => { if (!over) resolve(Buffer.concat(chunks)); });
    req.on('error', reject);
  });
}

/** The request body parsed as JSON ({} when empty); 400 when it is not JSON. */
export async function readJson(req, { limit = 1024 * 1024 } = {}) {
  const buf = await readBody(req, { limit });
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); } catch { throw new HttpError(400, 'body is not JSON'); }
}

/** The game the dev server has open now (ctx.gameDir), or a 409 that says what to do when none is. */
export function openGame(ctx) {
  if (!ctx.gameDir) throw new HttpError(409, 'No game is open yet: pick one on the studio\'s start page, or describe a new one there.');
  return ctx.gameDir;
}
