// Static server for gf-vista pages: the reference build (5960), the golden sandbox (5961) and track benches.
//   node runtimes/vista/tools/serve.mjs <dir> [port=5960]
// No caching (a rebuilt page is always what loads), correct types for the core's binary files and WGSL.
import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { resolve, join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.wgsl': 'text/plain; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ktx2': 'image/ktx2',
  '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.bin': 'application/octet-stream',
  '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.woff2': 'font/woff2', '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8',
};

export function serve(dir, port = 0, host = '127.0.0.1') {
  const root = resolve(dir);
  const server = createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.endsWith('/')) p += 'index.html';
    const file = normalize(join(root, p));
    if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
    let st; try { st = statSync(file); } catch { res.writeHead(404).end('not found'); return; }
    if (st.isDirectory()) { res.writeHead(302, { location: p + '/' }).end(); return; }
    res.writeHead(200, { 'content-type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream', 'content-length': st.size, 'cache-control': 'no-store' });
    createReadStream(file).pipe(res);
  });
  return new Promise(ok => server.listen(port, host, () => ok(server)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [dir, port = '5960'] = process.argv.slice(2);
  if (!dir) { console.error('usage: serve.mjs <dir> [port]'); process.exit(2); }
  const s = await serve(dir, Number(port));
  console.log(`serving ${resolve(dir)} on http://127.0.0.1:${s.address().port}/`);
}
