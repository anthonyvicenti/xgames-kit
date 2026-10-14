// The web3 routes' own boundary, checked before any state changes even though the dev server checks Host and Origin
// too (defence in depth: these routes can spend the creator's money once their wallet approves):
// - loopback only: the connection must arrive on 127.0.0.1 or ::1;
// - Host must name this server on a loopback name (127.0.0.1, localhost or [::1]) and its own port, so another site
//   can't reach it through DNS rebinding;
// - a POST must carry this server's own Origin and a JSON content type, so no other page can drive it; a GET from
//   another origin is refused too; Sec-Fetch-Site, when sent, must be same-origin or none;
// - no CORS headers, ever; only GET and POST;
// - bodies are capped by their declared length and while streaming.
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
export const MAX_BODY_BYTES = 64 * 1024;

/** A refusal with its HTTP status. */
export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

const HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cross-origin-resource-policy': 'same-origin',
};

/** The server's own origins for this request, from the socket it arrived on. */
function ownOrigins(req) {
  const port = req.socket?.localPort;
  return new Set([...LOOPBACK_HOSTS].map((h) => `http://${h}:${port}`));
}

/** Throws an HttpError unless the request may go on. */
export function guard(req) {
  const local = req.socket?.localAddress;
  if (!LOOPBACK_ADDRESSES.has(local)) throw new HttpError(403, 'Only this computer may use the web3 routes.');
  const host = String(req.headers.host ?? '').toLowerCase();
  if (!ownOrigins(req).has(`http://${host}`)) throw new HttpError(403, 'Refused: wrong Host.');
  const site = req.headers['sec-fetch-site'];
  if (site !== undefined && site !== 'same-origin' && site !== 'none') throw new HttpError(403, 'Refused: cross-site request.');
  const origin = req.headers.origin;
  if (req.method === 'POST') {
    if (origin !== `http://${host}`) throw new HttpError(403, 'Refused: wrong or missing Origin.');
    const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    if (type !== 'application/json') throw new HttpError(415, 'Send JSON.');
  } else if (req.method === 'GET' || req.method === 'HEAD') {
    if (origin !== undefined && origin !== `http://${host}`) throw new HttpError(403, 'Refused: wrong Origin.');
  } else throw new HttpError(405, 'Method not allowed.');
}

/** The JSON body, refusing anything over the cap before or while reading it. */
export async function readJson(req, limit = MAX_BODY_BYTES) {
  // A server that already parsed the body hands it over as an object.
  if (req.body !== undefined && req.body !== null && typeof req.body === 'object' && !(req.body instanceof Uint8Array)) {
    if (JSON.stringify(req.body).length > limit) throw new HttpError(413, 'Body too large.');
    return req.body;
  }
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > limit) throw new HttpError(413, 'Body too large.');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'Body too large.');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  try {
    const value = JSON.parse(text);
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch {}
  throw new HttpError(400, 'The body must be a JSON object.');
}

export function sendJson(res, status, body) {
  if (res.headersSent) return;
  res.writeHead(status, { ...HEADERS, 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body, (key, value) => (typeof value === 'bigint' ? value.toString() : value)));
}

export function sendBytes(res, contentType, bytes) {
  res.writeHead(200, { ...HEADERS, 'content-type': contentType, 'content-security-policy': "default-src 'none'; sandbox", 'content-length': bytes.length });
  res.end(Buffer.from(bytes));
}

/** Wrap a handler: guard, run, and answer errors as { error } with their status. */
export function handle(fn, log) {
  return async (req, res, params) => {
    try {
      guard(req);
      const out = await fn(req, res, params);
      if (out !== undefined) sendJson(res, 200, out);
    } catch (error) {
      const status = error.status ?? (error.name === 'RuleError' ? 400 : 500);
      if (status >= 500) log?.(`web3: ${error.stack ?? error.message}`);
      sendJson(res, status, { error: error.message });
      if (status === 413) req.destroy?.();
    }
  };
}
