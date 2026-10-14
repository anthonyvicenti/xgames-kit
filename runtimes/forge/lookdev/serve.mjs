#!/usr/bin/env node
// gf-forge lookdev's server (track R, port 5824): the lookdev page beside the kit and the art library, as a game
// would load them (the kit's wasm, the library's files as slot bytes).
//
//   node runtimes/forge/lookdev/serve.mjs [--port 5824] [--wasm <dir>]
//     /             runtimes/forge/lookdev/ (index.html, scene.js)
//     /kit/         runtimes/forge/kit/ (host.js, render.js, look.js, the release wasm in wasm/)
//     /library/     the forge's art by its forge names (bodies/x.glb, …; catalog.json the forge's catalog), from the
//                   asset library through runtimes/forge/tools/library.mjs
//     --wasm <dir>  serve /kit/wasm/ from <dir> instead (a dev build: forge_web.js + forge_web_bg.wasm)
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { forgeLibrarySync } from '../tools/library.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FORGE = resolve(HERE, '..');
export const PORT = 5824;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.wasm': 'application/wasm', '.glb': 'model/gltf-binary', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.css': 'text/css', '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg' };

/** Start the server. → {server, url, close()} */
export async function startLookdev({ port = PORT, wasm = null, quiet = true, extra = {} } = {}) {
  const roots = [['/kit/wasm/', wasm ? resolve(wasm) : join(FORGE, 'kit/wasm')], ...Object.entries(extra), ['/kit/', join(FORGE, 'kit')], ['/', HERE]];
  const server = createServer(async (req, res) => {
    try {
      const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (path.startsWith('/library/')) {
        const L = forgeLibrarySync(), name = path.slice('/library/'.length);
        const body = name === 'catalog.json' ? JSON.stringify(L.forgeCatalog) : await readFile(L.forgeFile(name));
        res.writeHead(200, { 'content-type': TYPES[extname(name).toLowerCase()] ?? 'application/octet-stream', 'cache-control': 'no-store' });
        res.end(body);
        return;
      }
      const [prefix, root] = roots.find(([p]) => path.startsWith(p));
      let rel = path.slice(prefix.length) || 'index.html';
      const file = normalize(join(root, rel));
      if (!file.startsWith(resolve(root) + sep) && file !== resolve(root)) { res.writeHead(403).end(); return; }
      const s = await stat(file).catch(() => null);
      const f = s?.isDirectory() ? join(file, 'index.html') : file;
      const body = await readFile(f);
      res.writeHead(200, { 'content-type': TYPES[extname(f).toLowerCase()] ?? 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(body);
      if (!quiet) console.log(`200 ${path}`);
    } catch (e) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end(String(e?.code ?? e));
    }
  });
  await new Promise((ok, no) => { server.once('error', no); server.listen(port, '127.0.0.1', ok); });
  const url = `http://127.0.0.1:${server.address().port}/`;
  return { server, url, close: () => new Promise(ok => server.close(ok)) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const a = process.argv.slice(2), opt = k => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : null; };
  const s = await startLookdev({ port: Number(opt('--port') ?? PORT), wasm: opt('--wasm'), quiet: false });
  console.log(`gf-forge lookdev on ${s.url} (WebGPU Chrome, Edge or Safari 26+)`);
}
