// What the session's tools call (builder/mcp/tools: gamesfun_requests). The MCP server is its own process, so these find the
// running dev server from the run file and talk to its routes; a tool needs no port, no token and no Bash.
// Every function answers { ok: false, error } instead of throwing: a closed page never breaks a tool.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findRun } from './runfile.mjs';

// The tools run from the kit, whatever folder the session is in: the kit's own .gamesfun/ is always looked in too.
const KIT = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const locate = options => options.run ?? findRun({ cwd: options.cwd, env: options.env, extra: options.extra ?? [KIT] });

async function call(run, method, route, body) {
  const res = await fetch(new URL(route, run.url), {
    method,
    headers: { 'x-gamesfun-token': run.token, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(5000),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (!res.ok) return { ok: false, error: json?.error ?? `the studio answered ${res.status}` };
  return { ok: true, ...json };
}
async function withRun(options, fn) {
  const run = await locate(options);
  if (!run) return { ok: false, error: 'the studio is not running here (start it with: npx gamesfun dev)' };
  try { return await fn(run); } catch (e) { return { ok: false, error: `the studio did not answer at ${run.url}: ${e.message}` }; }
}

/** Is a studio running for this folder, and which sessions does it see? */
export async function bridgeStatus(options = {}) {
  const run = await locate(options);
  if (!run) return { running: false };
  try {
    const q = await call(run, 'GET', '/api/session/queue');
    if (!q.ok) return { running: false, error: q.error };
    return { running: true, url: run.url, run: q.run, game: q.game, wait: q.transport?.wait ?? null, sessions: q.sessions, waiting: q.requests.filter(r => r.state === 'waiting').length };
  } catch (e) { return { running: false, error: e.message }; }
}

/** The page's requests for this session: what it was handed and has not reported, plus what is waiting for it. */
export function collectRequests(options = {}) {
  return withRun(options, async run => {
    const r = await call(run, 'GET', `/api/session/requests${options.session ? `?session=${encodeURIComponent(options.session)}` : ''}`);
    if (!r.ok) return r;
    return { ok: true, session: r.session, requests: r.requests.map(({ id, text, selection, state }) => ({ id, text, selection, state })) };
  });
}

/** The session reports a request done (or that it will not do it: status "dropped", with the reason in note). */
export function reportRequest(options = {}) {
  return withRun(options, async run => {
    if (!options.id) return { ok: false, error: 'which request? pass its id' };
    const r = await call(run, 'POST', `/api/session/request/${encodeURIComponent(options.id)}/done`, { note: options.note ?? null, status: options.status ?? 'done' });
    if (!r.ok) return r;
    const { ok, ...request } = r;
    return { ok: true, request };
  });
}

/**
 * Who is running this command, for the page: { id, agent }. The agent's own session id when it tells its shells one
 * (Claude Code: CLAUDE_CODE_SESSION_ID, the same id its hooks send, so the plugin's events and these meet in one
 * session); GAMESFUN_SESSION when the person or a harness sets one; else one id per kit folder ("term-…"), so a
 * listener started again is the same session.
 */
export function sessionIdentity(env = process.env, kit = KIT) {
  const claude = env.CLAUDE_CODE_SESSION_ID || (env.CLAUDECODE === '1' ? env.CLAUDE_SESSION_ID : '');
  if (env.GAMESFUN_SESSION) return { id: String(env.GAMESFUN_SESSION), agent: env.GAMESFUN_AGENT || (claude ? 'claude-code' : 'terminal') };
  if (claude) return { id: String(claude), agent: 'claude-code' };
  let h = 0;
  for (const ch of path.resolve(kit)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return { id: `term-${h.toString(16).padStart(8, '0')}`, agent: env.GAMESFUN_AGENT || 'terminal' };
}

/** A terminal command's tool call, for the page (best effort: never fails, never waits long). */
export async function postCliEvent(kind, { tool, input = null, ok = true, cwd = process.cwd(), env = process.env, run = null } = {}) {
  try {
    const r = run ?? await findRun({ cwd, env, extra: [KIT] });
    if (!r) return false;
    const who = sessionIdentity(env);
    const res = await fetch(new URL(`/api/session/cli/${kind}`, r.url), {
      method: 'POST', headers: { 'x-gamesfun-token': r.token, 'content-type': 'application/json' },
      body: JSON.stringify({ session: who.id, agent: who.agent, cwd, tool, input, ok }), signal: AbortSignal.timeout(1500),
    });
    return res.ok;
  } catch { return false; }
}

/**
 * The terminal listener: hold the page's wait for this session until the page sends something.
 * → { type: 'requests', text, requests } | { type: 'superseded' } | { type: 'ended' } | { type: 'timeout' }
 * With no studio running it looks again every `pollMs`, and after a studio restart it connects again by itself.
 * options: { cwd, env, session, agent, maxMs, pollMs, onWaiting(message) }
 */
export async function listen(options = {}) {
  const { cwd = process.cwd(), env = process.env, maxMs = 0, pollMs = 2000, onWaiting = () => {}, find = findRun } = options;
  const who = options.session ? { id: options.session, agent: options.agent ?? 'terminal' } : sessionIdentity(env);
  const started = Date.now();
  const left = () => (maxMs > 0 ? maxMs - (Date.now() - started) : Infinity);
  let told = false;
  const http = await import('node:http');
  for (;;) {
    if (left() <= 0) return { type: 'timeout' };
    const run = await find({ cwd, env, extra: [KIT] }).catch(() => null);
    if (!run) {
      if (!told) { onWaiting('the studio is not running yet; waiting for it (node bin/gamesfun.mjs dev starts it)'); told = true; }
      await new Promise(r => setTimeout(r, Math.min(pollMs, left())));
      continue;
    }
    const got = await new Promise(resolve => {
      const q = new URLSearchParams({ form: 'listener', session: who.id, agent: who.agent, cwd });
      let timer = null;
      const req = http.get(new URL(`/api/session/wait?${q}`, run.url), { headers: { 'x-gamesfun-token': run.token } }, res => {
        if (res.statusCode !== 200) { res.resume(); return resolve(null); }
        res.setEncoding('utf8');
        let buf = '';
        res.setTimeout(70_000, () => req.destroy());   // the studio writes a blank line every 25 s
        res.on('data', chunk => {
          buf += chunk;
          let nl;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line) continue;
            let msg;
            try { msg = JSON.parse(line); } catch { continue; }
            if (msg.type === 'requests' || msg.type === 'superseded' || msg.type === 'ended') { clearTimeout(timer); req.destroy(); return resolve(msg); }
          }
        });
        res.on('end', () => resolve(null));
        res.on('error', () => resolve(null));
      });
      req.on('error', () => resolve(null));
      if (Number.isFinite(left())) timer = setTimeout(() => { req.destroy(); resolve({ type: 'timeout' }); }, left());
    });
    if (got) return got.type === 'requests' ? { type: 'requests', text: got.text, requests: got.requests ?? [], session: who.id } : { type: got.type };
    await new Promise(r => setTimeout(r, Math.min(pollMs, Math.max(0, left()))));
  }
}
