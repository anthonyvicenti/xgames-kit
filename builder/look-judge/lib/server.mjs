// The look judge's static server: one port, a few folders under their own prefixes (the runtime's kit and library,
// this kit's kinds and runtime files, the pinned vendor copies the pages' import maps name, the sheet packs, the fonts).
// A prefix maps to a folder, or to a function from the rest of the path to a file (null: not found), for a tree that is
// assembled from several folders (a game's gf/three/, builder/tools/lib/paths.mjs repoFileOf).
//   const s = await startServer({ '/kit/': dir, '/three/': rel => fileOf(rel), ... }); s.url; s.close();
import { createServer } from 'node:http';
import { createReadStream, statSync, existsSync } from 'node:fs';
import { join, extname, resolve, sep } from 'node:path';

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.glb': 'model/gltf-binary', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.txt': 'text/plain', '.ogg': 'audio/ogg', '.wgsl': 'text/plain; charset=utf-8', '.ktx2': 'image/ktx2', '.bin': 'application/octet-stream', '.gltf': 'model/gltf+json', '.jpeg': 'image/jpeg', '.mp3': 'audio/mpeg', '.wav': 'audio/wav' };

/** map: { '/prefix/': folder }. Longest prefix wins. → { server, url, close() } */
export function startServer(map, { port = 0, host = '127.0.0.1' } = {}) {
  const prefixes = Object.keys(map).sort((a, b) => b.length - a.length);
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const pre = prefixes.find(p => path.startsWith(p));
    if (!pre) { res.writeHead(404).end('no route: ' + path); return; }
    const rest = path.slice(pre.length);
    let file;
    if (typeof map[pre] === 'function') {
      if (rest.split('/').includes('..')) { res.writeHead(403).end(); return; }
      file = map[pre](rest);
      if (!file) { res.writeHead(404, { 'content-type': 'text/plain' }).end('not found: ' + path); return; }
    } else {
      const base = resolve(map[pre]);
      file = resolve(join(base, rest));
      if (file !== base && !file.startsWith(base + sep)) { res.writeHead(403).end(); return; }
    }
    try { if (statSync(file).isDirectory()) file = join(file, 'index.html'); } catch { /* 404 below */ }
    if (!existsSync(file)) { res.writeHead(404, { 'content-type': 'text/plain' }).end('not found: ' + path); return; }
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    createReadStream(file).pipe(res);
  });
  return new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(port, host, () => ok({ server, url: `http://${host}:${server.address().port}`, close: () => new Promise(r => server.close(r)) }));
  });
}
