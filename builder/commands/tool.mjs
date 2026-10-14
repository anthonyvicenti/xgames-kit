// `gamesfun tool <name> '<json>'`: any of the kit's MCP tools, run once from a terminal. The same handler the MCP
// server calls (builder/mcp/server.mjs loads them from builder/mcp/tools/), with the same input check (the tool's JSON Schema, Ajv),
// the same running mark on the game folder (the studio's stop guard reads it) and the same answer, printed. A session
// whose MCP tools are not loaded (the kit was installed after it started, or the agent speaks no MCP) builds with this.
//
// What it has that a server does not: no memory between calls. A server holds the build loop's state in memory and
// writes a state file that was edited again from it; each call here is a new process. So the loop tools check the
// state against its seal instead (builder/lib/loop-seal.mjs: an HMAC with a key in the person's config folder, never in the
// game), on this path and on the server's alike, and a state file that is not the sealed one is written again from
// the seal and refused as `state-changed`, exactly as a server would. The play-test's report is held the same way on
// both paths: only a report written through gamesfun_playtest_report with the round's token is read.
import { readFile } from 'node:fs/promises';
import { guard, parse, UsageError } from '../lib/cli.mjs';
import { KIT_ROOT } from '../lib/paths.mjs';

const usage = `Usage: gamesfun tool <name> ['<arguments as JSON>'] [--game <folder>] [--args-file <file>]
       gamesfun tool --list

Run one of the kit's MCP tools (gamesfun_next, gamesfun_step_pitch, gamesfun_requests, …) from a terminal, with the
same arguments and the same answer as the tool. Use it when the tools are not loaded in your agent session: nothing
needs a reload or a restart.
  --game <folder>     sets the "game" argument (e.g. games/my-game), merged into the JSON
  --args-file <file>  read the arguments from a JSON file (for long ones, or a shell that mangles quotes)
  --list              the tools, one line each
Examples:
  node bin/gamesfun.mjs tool gamesfun_next --game games/my-game
  node bin/gamesfun.mjs tool gamesfun_step_pitch '{"game":"games/my-game","idea":"a pillow fight"}'`;

/** What the MCP server would answer, as text: the content's text parts, else the value as JSON. */
export function resultText(result) {
  if (result && Array.isArray(result.content)) return result.content.map(c => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n');
  return typeof result === 'string' ? result : JSON.stringify(result ?? null, null, 2);
}

/** Run one tool by name. → { ok, text, result } (never throws for a tool's own error: that is ok: false). */
export async function runToolByName(name, input = {}, { env = process.env, log = m => console.error(m), signal } = {}) {
  const { loadTools, inputProblems, offered, running, runCli } = await import('../mcp/server.mjs');
  const { tools } = await loadTools(undefined, () => {});
  const t = tools.get(name);
  if (!t || !offered(name, env)) {
    const near = [...tools.keys()].filter(k => offered(k, env) && (k.includes(name) || name.includes(k.replace(/^gamesfun_/, ''))));
    return { ok: false, text: `no tool ${name}${near.length ? ` (did you mean ${near.slice(0, 4).join(', ')}?)` : ''}. node bin/gamesfun.mjs tool --list lists them.` };
  }
  const bad = inputProblems(t.inputSchema, input);
  if (bad.length) return { ok: false, text: bad.join('; ') };
  const { postCliEvent } = await import('../bridge/client.mjs');
  const shown = { ...input };
  await postCliEvent('tool-start', { tool: name, input: shown, env, cwd: process.cwd() });
  const ctx = {
    kitRoot: KIT_ROOT,
    client: env.CLAUDE_CODE_SESSION_ID || env.CLAUDECODE === '1' ? 'claude-code' : null,
    log,
    progress: message => log(`… ${String(message).slice(0, 300)}`),
    runCli,
    signal,
  };
  const done = await running(name, input);
  let result, ok = true;
  try { result = await t.handler(input, ctx); ok = !result?.isError; }
  catch (e) { result = { isError: true, content: [{ type: 'text', text: e.message }] }; ok = false; }
  finally { await done(); }
  await postCliEvent('tool-end', { tool: name, input: shown, ok, env, cwd: process.cwd() });
  return { ok, text: resultText(result), result };
}

export default {
  name: 'tool',
  summary: 'run one of the kit\'s MCP tools from a terminal (when they are not loaded in your session)',
  usage,
  run: args => guard(async () => {
    const { values, positionals } = parse(args, { game: { type: 'string' }, 'args-file': { type: 'string' }, list: { type: 'boolean' } }, usage);
    if (values.list) {
      const { loadTools, offered } = await import('../mcp/server.mjs');
      const { tools } = await loadTools(undefined, () => {});
      for (const t of tools.values()) if (offered(t.name)) console.log(`${t.name.padEnd(28)} ${t.description.split(/(?<=\.)\s/)[0].slice(0, 140)}`);
      return 0;
    }
    const [name, json] = positionals;
    if (!name) throw new UsageError(usage);
    let input = {};
    const source = values['args-file'] ? await readFile(values['args-file'], 'utf8') : json;
    if (source !== undefined && source.trim()) {
      try { input = JSON.parse(source); } catch (e) { throw new UsageError(`the arguments are not JSON (${e.message}). Put them in single quotes, or in a file with --args-file.\n\n${usage}`); }
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new UsageError(`the arguments are a JSON object, e.g. '{"game":"games/my-game"}'\n\n${usage}`);
    }
    if (values.game) input.game = values.game;
    const ac = new AbortController();
    process.once('SIGINT', () => ac.abort());
    const r = await runToolByName(name, input, { signal: ac.signal });
    (r.ok ? console.log : console.error)(r.text);
    return r.ok ? 0 : 1;
  }),
};
