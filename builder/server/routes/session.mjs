// /api/session/…: the bridge between the studio page and the person's own agent session (builder/bridge/CONTRACT.md).
// This file is only the HTTP face: the state is builder/bridge/core.mjs, the agent's hooks are builder/bridge/transports/*.mjs.
// Every route needs this run's token (except the one that hands it to the server's own page); the dev server's gate
// (builder/server/security.mjs) has already refused other hosts, other origins and cross-site fetches. No CORS header is sent.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createBridge, BridgeError, CONTRACT } from '../../bridge/core.mjs';
import { forgetRun, recordRun, waitForm } from '../../bridge/runfile.mjs';
import { openTransport } from '../../bridge/transport.mjs';
import { HttpError, readJson } from '../http.mjs';
import { BASE_HEADERS } from '../security.mjs';

const HEARTBEAT_MS = 25_000;
const live = new Map();   // server url → { bridge, token, close }

/** The bridge of a running dev server (tests, and whoever stops the server: call close()). */
export const bridgeFor = url => live.get(url) ?? null;

export default async function register(router, ctx) {
  const token = randomBytes(24).toString('base64url');
  const wait = await waitForm(ctx.kitRoot);
  const bridge = createBridge({ gameDir: ctx.gameDir, kitRoot: ctx.kitRoot });
  const transport = openTransport(process.env.GAMESFUN_BRIDGE_TRANSPORT || 'claude-hooks', bridge, { wait, url: ctx.url, kit: ctx.kitRoot });
  const streams = new Set();

  const sameToken = given => {
    const a = Buffer.from(String(given ?? '')), b = Buffer.from(token);
    return a.length === b.length && timingSafeEqual(a, b);
  };
  const guard = fn => async (req, res, params) => {
    if (!sameToken(req.headers['x-gamesfun-token'] || req.query.get('token'))) throw new HttpError(401, 'missing or wrong token');
    try { return await fn(req, res, params); } catch (e) { if (e instanceof BridgeError) throw new HttpError(e.status, e.message); throw e; }
  };
  const body = req => readJson(req, { limit: 64 * 1024 });

  // ---- the page ---------------------------------------------------------------------------------------------------
  router.get('/token', req => {
    if (req.headers['sec-fetch-site'] !== 'same-origin') throw new HttpError(403, 'only this server\'s own page may ask for the token');
    return { token, run: bridge.run, contract: CONTRACT };
  });
  router.get('/queue', guard(() => bridge.queue()));
  router.post('/request', guard(async req => bridge.addRequest(await body(req))));
  router.patch('/request/:id', guard(async (req, res, { id }) => bridge.editRequest(id, await body(req))));
  router.delete('/request/:id', guard((req, res, { id }) => bridge.removeRequest(id)));
  router.post('/permission/:id', guard(async (req, res, { id }) => bridge.answerPermission(id, await body(req))));
  router.get('/events', guard((req, res) => {
    const after = Number(req.headers['last-event-id'] ?? req.query.get('after') ?? 0) || 0;
    res.writeHead(200, { ...BASE_HEADERS, 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive' });
    const write = ev => res.write(`id: ${ev.seq}\nevent: ${ev.kind}\ndata: ${JSON.stringify(ev)}\n\n`);
    res.write(`event: hello\ndata: ${JSON.stringify({ seq: 0, t: Date.now(), kind: 'hello', run: bridge.run, contract: CONTRACT })}\n\n`);
    for (const ev of bridge.eventsAfter(after)) write(ev);
    const off = bridge.subscribe(write);
    const beat = setInterval(() => res.write(': hb\n\n'), HEARTBEAT_MS);
    beat.unref();
    const end = () => { clearInterval(beat); off(); streams.delete(res); };
    streams.add(res);
    req.on('close', end);
  }));

  // ---- the session's tools (builder/bridge/client.mjs) --------------------------------------------------------------------
  router.get('/requests', guard(req => bridge.collect(req.query.get('session') || null)));
  router.post('/request/:id/done', guard(async (req, res, { id }) => bridge.reportRequest(id, await body(req))));

  // ---- the plugin (the transport) ---------------------------------------------------------------------------------
  router.post('/hook/:event', guard(async (req, res, { event }) => {
    const input = await readJson(req, { limit: 4 * 1024 * 1024 });
    const { body: answer, onClose } = await transport.hook(event, input);
    // the agent gave up on this hook (answered in the terminal, or its timeout): the approval is stale
    if (onClose) res.on('close', () => { if (!res.writableEnded) onClose(); });
    const out = await answer;
    if (res.destroyed) return;
    res.writeHead(200, { ...BASE_HEADERS, 'content-type': 'application/json; charset=utf-8' });
    res.end(out ? JSON.stringify(out) : '');
  }));
  // The kit's terminal commands, run by a session with or without the plugin (`gamesfun tool`, `gamesfun session`):
  // each tool call says so here, so the page follows a build whose session has no hooks. Body: { session, cwd, agent,
  // tool, input, ok }. Kinds: tool-start, tool-end.
  router.post('/cli/:kind', guard(async (req, res, { kind }) => {
    const b = await body(req);
    if (!['tool-start', 'tool-end'].includes(kind)) throw new HttpError(404, `no cli event ${kind}`);
    if (typeof b.session !== 'string' || !b.session || typeof b.tool !== 'string') throw new HttpError(400, 'a cli event names its session and tool');
    bridge.event(kind, { session: b.session, cwd: typeof b.cwd === 'string' ? b.cwd : null, agent: typeof b.agent === 'string' ? b.agent : undefined, via: 'cli', tool: b.tool, input: b.input ?? null, ok: b.ok !== false });
    return { ok: true };
  }));
  router.get('/wait', guard((req, res) => {
    const form = ['monitor', 'listener'].includes(req.query.get('form')) ? req.query.get('form') : 'rewake';
    let beat = null;
    const handle = {
      form,
      send: obj => { if (!res.writableEnded) res.write(JSON.stringify(obj) + '\n'); },
      end: () => { clearInterval(beat); if (!res.writableEnded) res.end(); },
    };
    let close;
    try { close = bridge.openWait(req.query.get('session') || null, handle, { cwd: req.query.get('cwd') || null, agent: req.query.get('agent') || undefined }); } catch (e) { if (e instanceof BridgeError) throw new HttpError(e.status, e.message); throw e; }
    if (!res.headersSent) { res.writeHead(200, { ...BASE_HEADERS, 'content-type': 'application/x-ndjson; charset=utf-8' }); res.flushHeaders(); }
    // a blank line every 25 s: the wait knows the server is there, and nothing in between gives up on a silent body
    beat = setInterval(() => { if (!res.writableEnded) res.write('\n'); }, HEARTBEAT_MS);
    beat.unref();
    streams.add(res);
    req.on('close', () => { clearInterval(beat); streams.delete(res); close(); });
  }));

  // ---- the run file: how the plugin and the tools find this server ---------------------------------------------
  const entry = { url: ctx.url, token, run: bridge.run, pid: process.pid, game: ctx.gameDir, wait, started: Date.now(), kit: ctx.kitRoot };
  await recordRun(ctx.kitRoot, entry);
  // the studio opened another game (or a new idea's folder): the bridge and the run file follow, so the plugin and the
  // tools find this server for that game
  ctx.onGame?.(dir => { bridge.setGame(dir); entry.game = dir; recordRun(ctx.kitRoot, entry).catch(e => ctx.log(`bridge: ${e.message}`)); });
  const onExit = () => { /* a dead pid is dropped by every reader; nothing to do synchronously */ };
  process.once('exit', onExit);
  live.set(ctx.url, {
    bridge, token, wait,
    close: async () => {
      live.delete(ctx.url);
      bridge.close();
      for (const res of streams) res.end();
      await forgetRun(ctx.kitRoot, process.pid).catch(() => {});
    },
  });
  ctx.log(`bridge ${bridge.run}: waiting for your agent session (wait: ${wait})`);
}
