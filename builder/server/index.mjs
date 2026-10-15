// The local dev server behind `gamesfun dev`: the studio page, the game it has open (none at first when `dev` is started
// without one: the studio's start page), live reload, local multiplayer signaling and the API routes in
// builder/server/routes/*.mjs. It binds 127.0.0.1 only and checks Host and Origin (security.mjs).
//
// The open game can change while the server runs (the studio opens one of games/, or a new idea's folder the build
// loop is making): ctx.gameDir is read at each request, never kept by a route, and ctx.setGame(dir) moves it, tells the
// routes that asked (ctx.onGame(fn)) and the studio page (the `project` event).
//
//   /                      → /studio/
//   /studio/…              the studio page (builder/studio/index.html, studio.js, tabs/*.js)
//   /game/…                the game folder (its pages get the live-reload script and, when the game's multiplayer kit
//                          knows online play and GAMESFUN_ONLINE is not off, the online-play line); /game/gf/mp/ plays with friends.
//                          /game/gamesfun.json is optional: a game without one answers 204 (no web3 settings, no body),
//                          which the host bridge and gf-web3 read as "no economy", without a failed request in the console
//   /signal, /signal/v1    gf-multiplayer signaling: the WebSocket the kit uses on 127.0.0.1, and HTTP (kits' signal server)
//   /api/<area>/…          routes from builder/server/routes/<area>.mjs
//   /__gamesfun/online.js  online play's readable side, for a game page that got the online line (builder/server/online.mjs)
//   /__gamesfun/gf-web3/…  the kit's own in-game web3 kit (builder/web3/gf-web3), for the studio's host bridge (builder/studio/host-bridge.js):
//                          the page that hosts the game signs with the kit's code, never with code from the game's folder
//   /__gamesfun/events     live reload (Server-Sent Events): `game` when the game's files change, `studio` for the studio's
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isGame, readJson } from '../lib/games.mjs';
import { GAMES, GF3_TOOLS, KIT_ROOT, SIGNAL_SERVER, STUDIO } from '../lib/paths.mjs';
const GF_WEB3 = path.join(KIT_ROOT, 'builder', 'web3', 'gf-web3');
import { sendJson, sendText } from './http.mjs';
import { injectOnline, ONLINE_CLIENT, ONLINE_CLIENT_PATH, onlineFor } from './online.mjs';
import { createEvents, injectReload, RELOAD_CLIENT, watchTree } from './reload.mjs';
import { createRouter } from './router.mjs';
import { BASE_HEADERS, refuse } from './security.mjs';
import { serveStatic } from './static.mjs';

export const HOST = '127.0.0.1';
export const PREFERRED_PORTS = [5180, 5181, 5182, 5183, 5184, 5185, 5186, 5187, 5188, 5189];

function listen(server, port) {
  return new Promise((resolve, reject) => {
    const onError = e => { server.off('listening', onListen); reject(e); };
    const onListen = () => { server.off('error', onError); resolve(server.address().port); };
    server.once('error', onError);
    server.once('listening', onListen);
    server.listen(port, HOST);
  });
}

/**
 * The build loop's first build of this folder is under way: its state (.gf-loop/state.json) is a `build` run that is
 * building or waiting on a question. A `change` run is a change to a game that was already delivered, so it is not.
 */
export function buildRunning(dir) {
  let s = null;
  try { s = JSON.parse(readFileSync(path.join(dir, '.gf-loop', 'state.json'), 'utf8')); } catch { return false; }
  if (!((s?.kind ?? 'build') === 'build' && ['building', 'waiting-on-creator'].includes(s?.status))) return false;
  // a headless build that was stopped (Ctrl+C, the wall clock) keeps its state to go on from, and is not running: its
  // record says so, and the game it left is shown (T8 run 1, 2026-10-14: a stopped build's game could never be opened)
  try { if (JSON.parse(readFileSync(path.join(dir, '.gf-loop', 'headless', 'record.json'), 'utf8'))?.running === false) return false; } catch { /* no headless record: a session's build */ }
  return true;
}

/**
 * Is the open folder a game to show (its page served, its tools offered), or one the build loop is still making?
 * A game create made is one once its build is over (nothing is shown before the person's first prompt, which
 * would be confusing, and while the loop makes the game the preview says so: the files create wrote are not the game yet); so is
 * any folder the person opened that the loop is not making (no .gf-loop in it: a game made by hand, by an example or by
 * an older kit). A folder that does not exist yet, or holds only the loop's talk, is being made.
 */
export function gameReady(dir) {
  if (!dir) return false;
  if (isGame(dir)) return !buildRunning(dir);
  return existsSync(dir) && !existsSync(path.join(dir, '.gf-loop'));
}

/** A folder the studio may open: a direct child of the games folder, named as create names one (letters, digits, dots, dashes). */
export function gameFolder(gamesRoot, name) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name) || name.includes('..')) throw new Error('a game folder is named with letters, digits, dashes and dots, e.g. my-game');
  return path.join(gamesRoot, name);
}

/**
 * Start the dev server. gameDir: the game to open, or null (the studio's start page). gamesRoot: the folder of the
 * person's games (games/ in the kit). port: a number (exactly that one), or null (the first free of PREFERRED_PORTS,
 * else any free port). → { url, port, close(), router, events, ctx }
 */
export async function startDevServer({ gameDir = null, gamesRoot = GAMES, port = null, log = console.log, watch = true, routesDir = path.join(KIT_ROOT, 'builder', 'server', 'routes'), env = process.env } = {}) {
  const gamesfun = gameDir ? await readJson(path.join(gameDir, 'gamesfun.json'), null) : null;
  const network = process.env.GAMESFUN_NETWORK || gamesfun?.network || 'devnet';
  const events = createEvents();
  const router = createRouter({ log });
  let actualPort = 0;
  let sig = null, upgradeHandler = null;
  let ctx = null;                                     // set below, before the routes load; a request before then gets a 503

  const server = createServer(async (req, res) => {
    let url;
    try { url = new URL(req.url, 'http://127.0.0.1'); } catch { return sendText(res, 400, 'bad request'); }
    const api = url.pathname.startsWith('/api/') || url.pathname.startsWith('/signal');
    const no = refuse(req.headers, actualPort, { api });
    if (no) return sendText(res, no.status, no.reason);
    if (!ctx) return sendText(res, 503, 'starting');
    try {
      if (sig?.handleHttp(req, res)) return;                                      // POST /signal/v1, GET /signal/v1/ice
      if (url.pathname.startsWith('/api/')) {
        if (await router.handle(req, res, url)) return;
        return sendJson(res, 404, { error: `no route ${req.method} ${url.pathname}` });
      }
      if (url.pathname === '/') { res.writeHead(302, { ...BASE_HEADERS, location: '/studio/' }); return res.end(); }
      if (url.pathname === '/favicon.ico') { res.writeHead(204, BASE_HEADERS); return res.end(); }
      if (url.pathname === '/__gamesfun/events') return events.attach(req, res);
      if (url.pathname === '/__gamesfun/reload.js') return sendText(res, 200, RELOAD_CLIENT, 'text/javascript; charset=utf-8');
      if (url.pathname === ONLINE_CLIENT_PATH) return sendText(res, 200, ONLINE_CLIENT, 'text/javascript; charset=utf-8');
      if (url.pathname === '/studio' || url.pathname === '/game') { res.writeHead(301, { ...BASE_HEADERS, location: `${url.pathname}/${url.search}` }); return res.end(); }
      if (url.pathname.startsWith('/__gamesfun/gf-web3/')) return await serveStatic(req, res, { base: GF_WEB3, rest: url.pathname.slice('/__gamesfun/gf-web3'.length), mount: '/__gamesfun/gf-web3', search: url.search });
      if (url.pathname.startsWith('/studio/')) return await serveStatic(req, res, { base: STUDIO, rest: url.pathname.slice('/studio'.length), mount: '/studio', search: url.search });
      if (url.pathname.startsWith('/game/')) {
        const gameDir = ctx.gameDir;
        if (!gameReady(gameDir)) return sendText(res, 404, 'no game is open yet');
        // a game without web3 has no gamesfun.json: the Economy tab asks for it, so answer "nothing" instead of a 404
        if (url.pathname === '/game/gamesfun.json' && !(await stat(path.join(gameDir, 'gamesfun.json')).catch(() => null))) { res.writeHead(204, BASE_HEADERS); return res.end(); }
        return await serveStatic(req, res, {
          base: gameDir, rest: url.pathname.slice('/game'.length), mount: '/game', search: url.search,
          // the game's kit and the person's switch are read as each page is served: an upgrade or a new setting needs no restart of the game
          transform: async (file, buf, type) => (type.startsWith('text/html') ? injectOnline(injectReload(buf), await onlineFor(gameDir, env)) : buf),
        });
      }
      return sendText(res, 404, 'not found');
    } catch (e) {
      log(`dev server: ${req.method} ${url.pathname}: ${e.message}`);
      if (!res.headersSent) sendText(res, 500, 'server error');
    }
  });
  // WebSocket upgrades (signaling at /signal) pass the same Host and Origin checks first
  server.on('upgrade', (req, socket, head) => {
    const no = refuse(req.headers, actualPort, { api: true });
    if (no || !upgradeHandler) { socket.write(`HTTP/1.1 ${no?.status ?? 404} ${no ? 'Refused' : 'Not Found'}\r\nConnection: close\r\n\r\n`); socket.destroy(); return; }
    upgradeHandler(req, socket, head);
  });

  // listen: the port asked for, else a preferred one, else any free one
  if (port != null) actualPort = await listen(server, Number(port));
  else {
    for (const p of [...PREFERRED_PORTS, 0]) {
      try { actualPort = await listen(server, p); break; } catch (e) { if (e.code !== 'EADDRINUSE' && e.code !== 'EACCES') throw e; }
    }
  }
  const url = `http://${HOST}:${actualPort}/`;

  // signaling from the kits (gf-multiplayer's own server code): it registers its upgrade handler on this gate
  const { attachSignaling } = await import(pathToFileURL(SIGNAL_SERVER).href);
  const gate = { on: (e, fn) => { if (e === 'upgrade') upgradeHandler = fn; }, off: (e, fn) => { if (e === 'upgrade' && upgradeHandler === fn) upgradeHandler = null; } };
  sig = attachSignaling(gate, { path: '/signal', log: () => {} });

  // the open game: read at each request (ctx.gameDir), moved by setGame; the watch follows it once it is a game
  const listeners = new Set();
  let gameWatch = null, watching = null;
  const armWatch = () => {
    if (!watch) return;
    const dir = gameReady(ctx.gameDir) ? ctx.gameDir : null;
    if (dir === watching) return;
    gameWatch?.(); gameWatch = null; watching = dir;
    if (dir) gameWatch = watchTree(dir, files => { events.send('game', { files }); }, { log });
  };
  ctx = {
    gameDir: gameDir ? path.resolve(gameDir) : null, gamesRoot: path.resolve(gamesRoot), kitRoot: KIT_ROOT, network, log, url, events,
    /** Open another game (a folder under gamesRoot, made or not yet), or none (null): the studio's start page. */
    setGame(dir) {
      const next = dir ? path.resolve(dir) : null;
      if (next === ctx.gameDir) { armWatch(); return next; }
      ctx.gameDir = next;
      armWatch();
      for (const fn of listeners) { try { fn(next); } catch (e) { log(`dev server: ${e.message}`); } }
      events.send('project', { game: next ? path.basename(next) : null });
      return next;
    },
    /** The folder being made became a game (create ran): start watching it. Called by whoever notices first. */
    gameMade: () => armWatch(),
    onGame(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
  await router.load(routesDir, ctx);

  const unwatch = [];
  armWatch();
  if (watch) unwatch.push(watchTree(STUDIO, files => { events.send('studio', { files }); }, { log }));
  return {
    url, port: actualPort, router, events, ctx, signaling: sig,
    /** Where this game's friends join from: { use: 'online' | 'this-machine', host, own, kit, why } */
    online: () => (ctx.gameDir ? onlineFor(ctx.gameDir, env) : Promise.resolve({ use: 'this-machine', why: 'no game is open yet' })),
    close: () => new Promise(resolve => {
      gameWatch?.();
      for (const u of unwatch) u();
      events.close(); sig.close();
      server.close(() => resolve());
      server.closeAllConnections?.();
    }),
  };
}

/** The studio's own version line (shown in the studio header): the package's version and the three runtime's kit. */
export async function kitsInfo() {
  const pkg = JSON.parse(await readFile(path.join(KIT_ROOT, 'package.json'), 'utf8'));
  const gf3 = /export const KIT_VERSION = '([^']+)'/.exec(await readFile(path.join(GF3_TOOLS, 'lib', 'paths.mjs'), 'utf8').catch(() => ''))?.[1] ?? null;
  return { version: pkg.version, kits: { gf3 } };
}
