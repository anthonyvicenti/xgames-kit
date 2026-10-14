// Test helpers: a throwaway game folder, a stand-in for core's dev-server router (the real one is core's; this one
// only mounts builder/server/routes/web3.mjs the way docs/ARCHITECTURE.md describes), and raw HTTP requests whose Host,
// Origin and other headers the test controls.
import http from 'node:http';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import register from '../../builder/server/routes/web3.mjs';

/** A tiny valid PNG of one colour (w×h), so pictures are real images. */
export function png(r = 255, g = 0, b = 0, w = 2, h = 2) {
  const crc = (buf) => {
    let c = ~0;
    for (const byte of buf) {
      c ^= byte;
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const rows = Buffer.concat(Array.from({ length: h }, () => Buffer.from([0, ...Array.from({ length: w }, () => [r, g, b]).flat()])));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

/** A game folder with an index.html, an assets folder of pictures and (optionally) a gamesfun.json. */
export async function makeGame({ title = 'Bean Brawl', config = null, assetsJson = null } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'gf-web3-'));
  const kitRoot = path.join(root, 'kit');
  const gameDir = path.join(kitRoot, 'games', 'bean-brawl');
  await mkdir(path.join(gameDir, 'assets'), { recursive: true });
  await writeFile(path.join(gameDir, 'index.html'), `<!doctype html><title>${title}</title>`);
  await writeFile(path.join(gameDir, 'assets', 'hat.png'), png(250, 200, 0));
  await writeFile(path.join(gameDir, 'assets', 'skin.png'), png(0, 200, 250));
  await writeFile(path.join(gameDir, 'assets', 'icon.png'), png(20, 20, 20));
  if (config) await writeFile(path.join(gameDir, 'gamesfun.json'), JSON.stringify(config, null, 2));
  if (assetsJson) await writeFile(path.join(gameDir, 'assets.json'), JSON.stringify(assetsJson));
  return { root, kitRoot, gameDir };
}

/** Mount the web3 routes on a bare loopback server, the way core's router would (under /api/web3). */
export async function serve(ctx) {
  const table = [];
  const router = {
    get: (p, h) => table.push({ method: 'GET', path: `/api/web3${p}`, handler: h }),
    post: (p, h) => table.push({ method: 'POST', path: `/api/web3${p}`, handler: h }),
  };
  register(router, ctx);
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://x').pathname;
    const route = table.find((r) => r.path === pathname && (r.method === req.method || (req.method !== 'GET' && req.method !== 'POST' && r.path === pathname)));
    if (!route) {
      res.writeHead(404);
      res.end();
      return;
    }
    route.handler(req, res, {});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return { port, origin: `http://127.0.0.1:${port}`, close: () => new Promise((r) => (server.closeAllConnections(), server.close(r))) };
}

/** A raw request: every header is the test's to choose (fetch would not let it set Host). */
export function request(port, { method = 'GET', path: p = '/api/web3/state', headers = {}, body = null, chunks = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, agent: false, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      const parts = [];
      res.on('data', (c) => parts.push(c));
      res.on('end', () => {
        const text = Buffer.concat(parts).toString('utf8');
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text, json, bytes: Buffer.concat(parts) });
      });
    });
    // the server answers 413 and closes while the body is still being written: the write then fails with ECONNRESET or
    // EPIPE on Linux and macOS, and with ECANCELED or ECONNABORTED on Windows (first Windows run, 2026-10-11)
    req.on('error', (e) => (['ECONNRESET', 'EPIPE', 'ECANCELED', 'ECONNABORTED'].includes(e.code) ? resolve({ status: 413, headers: {}, text: '', json: null }) : reject(e)));
    if (chunks) {
      (async () => {
        for (const c of chunks) {
          if (!req.write(c)) await new Promise((r) => req.once('drain', r));
        }
        req.end();
      })().catch(() => {});
    } else {
      if (body !== null) req.write(typeof body === 'string' ? body : JSON.stringify(body));
      req.end();
    }
  });
}

/** POST JSON the way the studio page does. */
export const post = (port, p, body, headers = {}) =>
  request(port, { method: 'POST', path: `/api/web3${p}`, body, headers: { origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json', ...headers } });
