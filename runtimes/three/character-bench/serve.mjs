#!/usr/bin/env node
// Character bench server: node runtimes/three/character-bench/serve.mjs [--port 5792]
// Serves runtimes/three/ as the site root (so /kit/... are the dev sources), plus:
//   */vendor/three/build/*, */vendor/three/examples/jsm/*, */vendor/rapier/*   the pinned copies (README "Pinned")
//   /gf-assets.js                                                             gf-assets 1.3.0 (what kit/assets imports as ../../gf-assets.js)
//   /library/bodies.json                                                      the asset library's bodies (benchLibrary())
//   /character-bench/assets/models/body-player.glb                            the default body (a pack's default)
//   /character-bench/assets/bodies/<id>.glb, /character-bench/assets/clips/*  the asset library's files (store or default set)
import { isMain } from '../../../builder/tools/lib/main.mjs';
import http from 'node:http';
import { createReadStream, existsSync, statSync, readFileSync } from 'node:fs';
import { join, resolve, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bodiesIn, findAsset, licenceOf, localFile } from '../../../builder/art/views.mjs';
import { importLayer } from '../../../builder/tools/lib/kit-import.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const GF3 = resolve(here, '..');
const REPO = resolve(GF3, '../..');
const VENDOR = {
  threeBuild: join(REPO, 'runtimes/three/vendor/three@0.186.0'),
  threeAddons: [join(REPO, 'runtimes/three/vendor/three@0.186.0'), join(REPO, 'runtimes/three/vendor/three@0.186.0'), join(REPO, 'runtimes/three/vendor/three@0.186.0')],
  rapier: join(REPO, 'runtimes/three/vendor/rapier@0.19.2'),
};
const GF_ASSETS = join(REPO, 'builder/gf-assets/source/gf-assets.js');

/** The bench's body list: every gf-humanoid-1 body in the three and scenic profiles' packs that is on this machine. */
export async function benchLibrary() {
  const seen = new Set(), bodies = [...bodiesIn('three'), ...bodiesIn('scenic')].filter(b => !seen.has(b.id) && seen.add(b.id) && localFile(findAsset(b.ref)));
  const ch = await importLayer(join(GF3, 'kit/character/character.js')), rig = await importLayer(join(GF3, 'kit/character/rig.js'));
  const clips = findAsset('humanoid-clips/gf-humanoid-1');
  return { default: bodies.find(b => b.default)?.id ?? bodies[0]?.id, clips: { ref: 'humanoid-clips/gf-humanoid-1', names: [...new Set([...(ch.CLIPS ?? []), ...(rig.MELEE_CLIPS ?? [])])], license: licenceOf(clips) }, bodies };
}
const bodyFile = id => { const a = findAsset(id, 'three'); return a?.category === 'body' ? localFile(a) : null; };
const MIME = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.html': 'text/html; charset=utf-8', '.glb': 'model/gltf-binary',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.css': 'text/css', '.wasm': 'application/wasm', '.ktx2': 'image/ktx2', '.svg': 'image/svg+xml' };

function route(path) {
  let m;
  if ((m = path.match(/\/vendor\/three\/build\/(.+)$/))) return join(VENDOR.threeBuild, 'build', m[1]);
  if ((m = path.match(/\/vendor\/three\/examples\/jsm\/(.+)$/))) return VENDOR.threeAddons.map(d => join(d, 'examples/jsm', m[1])).find(existsSync);
  if ((m = path.match(/\/vendor\/rapier\/(.+)$/))) return join(VENDOR.rapier, m[1]);
  if (/(^|\/)gf-assets\.js$/.test(path) && !path.startsWith('/kit/')) return GF_ASSETS;
  if (path === '/character-bench/assets/models/body-player.glb') return bodyFile(bodiesIn('three')[0]?.ref);
  if ((m = path.match(/^\/(?:character-bench\/assets|library)\/bodies\/([a-z0-9_-]+)\.glb$/))) return bodyFile(m[1]);
  if (/^\/character-bench\/assets\/clips\/gf-humanoid-1\.glb$/.test(path)) return localFile(findAsset('humanoid-clips/gf-humanoid-1'));
  return join(GF3, path);
}

export function serve(port = 5792) {
  const srv = http.createServer((req, res) => {
    let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (path === '/' || path === '/character-bench') { res.writeHead(302, { location: '/character-bench/' }); return res.end(); }
    if (path.endsWith('/')) path += 'index.html';
    if (path === '/library/bodies.json') { benchLibrary().then(d => { res.writeHead(200, { 'content-type': MIME['.json'], 'cache-control': 'no-store' }); res.end(JSON.stringify(d)); }, e => { res.writeHead(500); res.end(e.message); }); return; }
    const file = route(path);
    // a file under the repository, or one the asset library names (its store may sit outside it)
    const fromLibrary = /^\/(library|character-bench\/assets)\//.test(path);
    if (!file || !(fromLibrary || resolve(file).startsWith(REPO)) || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    createReadStream(file).pipe(res);
  });
  return new Promise(ok => srv.listen(port, '127.0.0.1', () => ok(srv)));
}

if (isMain(import.meta)) {
  const i = process.argv.indexOf('--port');
  const port = i > 0 ? +process.argv[i + 1] : 5792;
  await serve(port);
  console.log(`character bench: http://127.0.0.1:${port}/character-bench/`);
}
