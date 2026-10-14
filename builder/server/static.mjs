// Static files from one folder, through resolveInside (builder/lib/paths.mjs): no traversal, no dotfiles, no Windows device
// names, on any platform.
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { resolveInside } from '../lib/paths.mjs';
import { BASE_HEADERS } from './security.mjs';

export const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.map': 'application/json', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.wasm': 'application/wasm', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.bin': 'application/octet-stream', '.ktx2': 'image/ktx2', '.hdr': 'application/octet-stream',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
};

/**
 * Serve `rest` (the URL path after the mount point, starting with "/") from `base`. A folder answers with its
 * index.html, after a redirect that adds the trailing slash. `transform(file, buf, type)` may rewrite a response body (the
 * live-reload snippet, the online-play line); it may be async. → true when answered (including 403/404).
 */
export async function serveStatic(req, res, { base, rest, mount, search = '', transform = null }) {
  const send = (code, body, type = 'text/plain; charset=utf-8') => {
    res.writeHead(code, { ...BASE_HEADERS, 'content-type': type });
    res.end(req.method === 'HEAD' ? undefined : body);
    return true;
  };
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, 'method not allowed');
  let file = resolveInside(base, rest);
  if (!file) return send(403, 'forbidden');
  try {
    let st = await stat(file);
    if (st.isDirectory()) {
      if (!rest.endsWith('/')) { res.writeHead(301, { ...BASE_HEADERS, location: `${mount}${rest}/${search}` }); res.end(); return true; }
      file = path.join(file, 'index.html');
      st = await stat(file);
    }
    if (!st.isFile()) return send(404, 'not found');
    let buf = await readFile(file);
    const type = TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
    if (transform) buf = await transform(file, buf, type) ?? buf;
    return send(200, buf, type);
  } catch {
    return send(404, 'not found');
  }
}
