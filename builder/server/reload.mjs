// Live reload: watch the game (and the studio's own files), tell open pages over Server-Sent Events.
import { watch } from 'node:fs';
import path from 'node:path';
import { BASE_HEADERS } from './security.mjs';

const IGNORED_TOP = new Set(['evidence', 'node_modules']);

/** Is a changed file (relative to the watched folder) one a page should reload for? */
export function reloadWorthy(rel) {
  const parts = String(rel).split(/[\\/]+/).filter(Boolean);
  if (!parts.length) return true;
  if (IGNORED_TOP.has(parts[0])) return false;
  if (parts.some(p => p.startsWith('.'))) return false;     // .git, .DS_Store, editors' swap and temp files
  if (/~$|\.tmp$|\.swp$|\.crdownload$/i.test(parts.at(-1))) return false;
  return true;
}

/** Watch `dir` recursively; onChange(files[]) after a quiet 150 ms. → close() */
export function watchTree(dir, onChange, { log = () => {} } = {}) {
  let timer = null; const pending = new Set();
  let w;
  try {
    w = watch(dir, { recursive: true }, (_evt, filename) => {
      const rel = filename ? String(filename) : '';
      if (rel && !reloadWorthy(rel)) return;
      pending.add(rel.split(path.sep).join('/'));
      clearTimeout(timer);
      timer = setTimeout(() => { const files = [...pending]; pending.clear(); onChange(files); }, 150);
    });
    w.on('error', e => log(`watch ${dir}: ${e.message}`));
  } catch (e) {
    log(`live reload is off: cannot watch ${dir} (${e.message})`);
    return () => {};
  }
  return () => { clearTimeout(timer); w.close(); };
}

/** The Server-Sent Events hub behind /__gamesfun/events. */
export function createEvents() {
  const clients = new Set();
  const beat = setInterval(() => { for (const res of clients) res.write(': keep-alive\n\n'); }, 25000);
  beat.unref?.();
  return {
    attach(req, res) {
      res.writeHead(200, { ...BASE_HEADERS, 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive' });
      res.write('retry: 1000\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
    },
    send(event, data) {
      const msg = `event: ${event}\ndata: ${JSON.stringify(data ?? {})}\n\n`;
      for (const res of clients) res.write(msg);
    },
    count: () => clients.size,
    close() { clearInterval(beat); for (const res of clients) res.end(); clients.clear(); },
  };
}

/** The script injected into game pages: a top-level page reloads itself; framed pages leave it to their parent. */
export const RELOAD_CLIENT = `// gamesfun dev: live reload (not part of the game; only the dev server adds it)
(() => {
  if (window.top !== window || new URLSearchParams(location.search).get('gf-reload') === '0') return;
  const es = new EventSource('/__gamesfun/events');
  es.addEventListener('game', () => location.reload());
})();
`;

/** Add the reload client to an HTML page. */
export function injectReload(buf) {
  const html = buf.toString('utf8');
  const tag = '<script src="/__gamesfun/reload.js"></script>';
  if (html.includes(tag)) return buf;
  const at = html.search(/<\/head>/i);
  return Buffer.from(at >= 0 ? html.slice(0, at) + tag + '\n' + html.slice(at) : tag + '\n' + html);
}
