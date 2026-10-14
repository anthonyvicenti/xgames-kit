// The routes seam (docs/ARCHITECTURE.md): builder/server/routes/<area>.mjs exports `default function register(router, ctx)`.
// `router.get/post/patch/delete(path, handler)` mount under /api/<area>/…; a path may hold `:name`
// segments, handed to the handler as params. Handlers receive (req, res, params) and may be async. A handler that
// returns a value without writing a response gets it sent as JSON (200); a thrown HttpError sends its status, any
// other throw a 500. req.query is the URL's searchParams.
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { HttpError, sendJson } from './http.mjs';

const AREA = /^[a-z][a-z0-9-]{0,31}$/;

function compile(full) {
  const keys = [];
  const re = full.split('/').map(seg => {
    if (seg.startsWith(':')) { keys.push(seg.slice(1)); return '([^/]+)'; }
    return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }).join('/');
  return { re: new RegExp(`^${re}/?$`), keys };
}

export function createRouter({ log = () => {} } = {}) {
  const routes = [];
  const areas = new Map();   // area → { file, ok, error, routes: [] }

  /** The facade one route module gets: get/post under /api/<area>. */
  function area(name, file = null) {
    if (!AREA.test(name)) throw new Error(`route area "${name}" must be lower-case letters, digits and dashes`);
    const rec = areas.get(name) ?? { area: name, file, ok: true, error: null, routes: [] };
    areas.set(name, rec);
    const add = method => (p, handler) => {
      if (typeof handler !== 'function') throw new Error(`${name}: ${method} ${p} needs a handler function`);
      const rel = String(p ?? '').replace(/^\/+/, '');
      const full = `/api/${name}${rel ? `/${rel}` : ''}`;
      routes.push({ method, full, handler, area: name, ...compile(full) });
      rec.routes.push(`${method} ${full}`);
    };
    return { get: add('GET'), post: add('POST'), patch: add('PATCH'), delete: add('DELETE'), area: name };
  }

  /** Try to answer a request under /api/. → true when a route took it. */
  async function handle(req, res, url) {
    const method = req.method === 'HEAD' ? 'GET' : req.method;
    let pathMatched = false;
    for (const r of routes) {
      const m = r.re.exec(url.pathname);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== method) continue;
      const params = {};
      try { r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); }); } catch { sendJson(res, 400, { error: 'bad path' }); return true; }
      req.query = url.searchParams;
      try {
        const out = await r.handler(req, res, params);
        if (out !== undefined && !res.headersSent && !res.writableEnded) sendJson(res, 200, out);
        else if (!res.headersSent && !res.writableEnded) sendJson(res, 204, null);
      } catch (e) {
        if (e instanceof HttpError) sendJson(res, e.status, { ...(e.extra ?? {}), error: e.message });
        else { log(`api ${r.area}: ${req.method} ${url.pathname}: ${e.stack ?? e.message}`); sendJson(res, 500, { error: e.message }); }
      }
      return true;
    }
    if (pathMatched) { sendJson(res, 405, { error: `${req.method} not allowed here` }); return true; }
    return false;
  }

  /** Load every builder/server/routes/*.mjs: each registers its area. A module that fails is reported, never fatal. */
  async function load(dir, ctx) {
    let files = [];
    try { files = (await readdir(dir)).filter(f => f.endsWith('.mjs')).sort(); } catch { return; }
    for (const f of files) {
      const name = f.slice(0, -4);
      try {
        if (!AREA.test(name)) throw new Error(`file name must be <area>.mjs with a lower-case area (got ${f})`);
        const mod = await import(pathToFileURL(path.join(dir, f)).href);
        if (typeof mod.default !== 'function') throw new Error('must export default function register(router, ctx)');
        const facade = area(name, f);
        // each area gets its own log; the open game stays the server's (read live: the studio may open another)
        const view = { ...ctx, log: (...a) => ctx.log(`[${name}]`, ...a) };
        if ('gameDir' in ctx) Object.defineProperty(view, 'gameDir', { get: () => ctx.gameDir, enumerable: true });
        await mod.default(facade, view);
      } catch (e) {
        areas.set(name, { area: name, file: f, ok: false, error: e.message, routes: areas.get(name)?.routes ?? [] });
        ctx.log(`routes: ${f} did not load: ${e.message}`);
      }
    }
  }

  return { area, handle, load, areas: () => [...areas.values()], routes: () => routes.map(r => `${r.method} ${r.full}`) };
}
