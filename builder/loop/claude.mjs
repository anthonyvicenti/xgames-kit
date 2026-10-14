// One round of the loop as one headless Claude Code session (`claude -p`), with the person's own Claude Code login or
// ANTHROPIC_API_KEY: the kit never holds a credential, and nothing here signs anyone in. The round's message goes in on
// stdin; the answer comes back as structured output against the round's JSON schema (--json-schema); every event of
// the session is kept as a line of the round's transcript.
//
// What a session may use is named per round (--allowedTools under --permission-mode dontAsk: anything else is denied,
// never asked), and only this kit's MCP server is loaded (--strict-mcp-config). The person's own user settings, hooks
// and plugins are left out (--setting-sources project,local), so a stop guard or another plugin cannot hold a round.
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { killTree } from './kit.mjs';

/** The MCP config that loads this kit's server (and nothing else) into a round. */
export const mcpConfigOf = (server, env = {}) => JSON.stringify({ mcpServers: { gamesfun: { command: process.execPath, args: [server], env } } });
/**
 * An error that says nothing about the round's work: a usage or rate limit, an overloaded service, a dropped connection.
 * A host waits and runs the round again; it never counts as the model's answer (nor climbs the ladder).
 */
export const TRANSIENT = /hit your (session|usage|weekly) limit|usage limit|rate[ _-]?limit|overloaded|\b(429|529|503)\b|ECONNRESET|ETIMEDOUT|socket hang up|network error/i;
/** How long to wait before the next try: until a stated reset when it is near, else a growing wait (1, 2, 5, 10, 15 minutes). */
export function waitFor(error, tries, now = new Date()) {
  const steps = [1, 2, 5, 10, 15], base = steps[Math.min(tries, steps.length - 1)] * 60000;
  const m = /resets\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i.exec(String(error ?? ''));
  if (!m) return base;
  let h = Number(m[1]) % 12 + (/pm/i.test(m[3]) ? 12 : 0);
  const at = new Date(now); at.setHours(h, Number(m[2] ?? 0), 30, 0);
  if (at <= now) at.setDate(at.getDate() + 1);
  return Math.max(base, Math.min(at - now, 6 * 3600000));
}
/** A tool of this kit's MCP server, by the name a session sees it under. */
export const mcp = name => `mcp__gamesfun__${name}`;

/**
 * → run({prompt, system, schema, model, effort, cwd, allowed, disallowed, addDirs, name, timeoutMinutes, signal}) →
 *   {ok, structured, text, sessionId, turns, ms, usd, tokens: {input, output, cacheRead, cacheWrite}, models: [id], denied, error?}
 * `bin`: the claude program (a test passes a fake one). `logDir`: where each round's transcript goes.
 */
export function claudeRunner({ bin = process.env.GAMESFUN_CLAUDE ?? 'claude', mcpConfig = null, logDir, permission = 'dontAsk', env = process.env, log = () => {} } = {}) {
  let n = 0;
  return async function run({ prompt, system = '', schema, model = null, effort = null, cwd, allowed = [], disallowed = [], addDirs = [], extraArgs = [], name = 'round', timeoutMinutes = 120, signal = null }) {
    const k = ++n, t0 = Date.now();
    await mkdir(logDir, { recursive: true });
    const file = path.join(logDir, `${String(k).padStart(2, '0')}-${name}.jsonl`);
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--setting-sources', 'project,local',
      '--permission-mode', permission, ...(model ? ['--model', model] : []), ...(effort ? ['--effort', effort] : []),
      ...(schema ? ['--json-schema', JSON.stringify(schema)] : []), ...(system ? ['--append-system-prompt', system] : []),
      ...(mcpConfig ? ['--mcp-config', mcpConfig, '--strict-mcp-config'] : []),
      ...(allowed.length ? ['--allowedTools', ...allowed] : []), ...(disallowed.length ? ['--disallowedTools', ...disallowed] : []),
      ...addDirs.flatMap(d => ['--add-dir', d]), ...extraArgs];
    const out = createWriteStream(file);
    out.write(JSON.stringify({ type: 'gamesfun-round', round: k, name, model, effort, cwd, allowed, at: new Date().toISOString(), prompt }) + '\n');
    const child = spawn(bin, args, { cwd, env: { ...env, DISABLE_AUTOUPDATER: '1' }, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true });
    child.stdin.end(prompt);
    let buf = '', result = null, stderr = '';
    const models = new Set();
    child.stdout.on('data', d => {
      out.write(d); buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let e; try { e = JSON.parse(line); } catch { continue; }
        if (e.type === 'result') result = e;
        if (e.type === 'assistant') {
          if (e.message?.model) models.add(e.message.model);
          for (const c of e.message?.content ?? []) if (c.type === 'tool_use') log(`    ${name}: ${c.name} ${String(c.input?.command ?? c.input?.file_path ?? c.input?.game ?? c.input?.name ?? '').replace(/\s+/g, ' ').slice(0, 100)}`);
        }
      }
    });
    child.stderr.on('data', d => { stderr = (stderr + d).slice(-4000); });
    const stop = () => killTree(child);
    signal?.addEventListener('abort', stop, { once: true });
    const timer = setTimeout(() => { log(`    ${name}: over ${timeoutMinutes} minutes, stopped`); stop(); }, timeoutMinutes * 60000);
    const code = await new Promise(done => { child.on('close', done); child.on('error', e => { stderr += e.message; done(1); }); });
    clearTimeout(timer); signal?.removeEventListener('abort', stop);
    await new Promise(r => out.end(r));
    const u = result?.usage ?? {};
    for (const m of Object.keys(result?.modelUsage ?? {})) models.add(m);
    return {
      ok: !!result && !result.is_error, structured: result?.structured_output ?? null, text: result?.result ?? '', sessionId: result?.session_id ?? null,
      turns: result?.num_turns ?? null, ms: Date.now() - t0, usd: result?.total_cost_usd ?? 0, transcript: file,
      tokens: { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0 },
      models: [...models], denied: (result?.permission_denials ?? []).map(d => d.tool_name ?? d),
      ...(!result ? { error: `claude exited (${code}) without a result: ${stderr.trim().split('\n').slice(-3).join(' ')}` } : result.is_error ? { error: String(result.result ?? result.subtype ?? 'error').slice(0, 600) } : {}),
    };
  };
}

/**
 * The runner with patience: a round that ends on a transient error (TRANSIENT) is run again after waitFor(), for as
 * long as `signal` allows; every try is kept (`tries`). Any other result is returned as it is.
 */
export function patient(run, { log = () => {}, sleep = ms => new Promise(r => setTimeout(r, ms)), now = () => new Date() } = {}) {
  return async o => {
    const tries = [];
    for (;;) {
      const r = await run(o);
      if (!r.error || !TRANSIENT.test(r.error) || o.signal?.aborted) return { ...r, ...(tries.length ? { tries } : {}) };
      const ms = waitFor(r.error, tries.length, now());
      tries.push({ error: r.error.slice(0, 200), waitedMinutes: +(ms / 60000).toFixed(1), transcript: r.transcript });
      log(`    ${o.name}: ${r.error.slice(0, 120)}; waiting ${Math.round(ms / 60000)} min, then the same round again`);
      await sleep(ms);
      if (o.signal?.aborted) return { ...r, tries };
    }
  };
}
