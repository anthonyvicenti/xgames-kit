#!/usr/bin/env node
// The gamesfun MCP server (stdio): the CLI's operations as tools for any agent that speaks MCP (Claude Code, Codex,
// Cursor, opencode, Cline). Tools come from builder/mcp/tools/<area>.mjs, each exporting `tools`, an array of
//   { name, description, inputSchema /* JSON Schema */, annotations, outputSchema?, handler(input, ctx) → result }
// (docs/ARCHITECTURE.md, "MCP tools"). A result may be a string, any JSON value, or an MCP result ({ content: [...] }).
//   annotations   MCP tool hints, honest per tool: readOnlyHint, destructiveHint, idempotentHint, openWorldHint
//   outputSchema  for a tool whose answer has a stable shape: the answer then also goes out as structuredContent
// Arguments are checked against inputSchema with Ajv (JSON Schema draft-07) before a handler runs, here and on the
// terminal path (`gamesfun tool`, builder/commands/tool.mjs), with the same words.
// ctx: { kitRoot, log(...), progress(message), runCli(args, { onLine }) → { code, stdout, stderr } }.
// A tool that spends money, signs or changes chain state returns a step for the human; it never signs.
//
// stdout is the protocol: everything else (logs, tool output) goes to stderr.
import { spawn } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import Ajv from 'ajv';
import { isMain } from '../lib/main.mjs';
import { BIN, KIT_ROOT } from '../lib/paths.mjs';
import { markRunning } from '../lib/running.mjs';
import { web3On } from '../lib/web3-switch.mjs';
import { gpuWrap } from '../loop/kit.mjs';

export const TOOLS_DIR = path.join(KIT_ROOT, 'builder', 'mcp', 'tools');
const NAME = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * Tool families a switch can turn off. Web3 (the web3_* and economy_* tools) is on by default since 2026-10-12;
 * GAMESFUN_WEB3=0 hides them (builder/lib/web3-switch.mjs). The commands (`npx gamesfun web3 …`, `npx gamesfun economy …`)
 * work either way.
 */
export const OPTIONAL_TOOLS = [
  { prefix: 'web3_', on: web3On, why: 'tokens, shops and loot boxes (devnet)' },
  { prefix: 'economy_', on: web3On, why: 'game economies on loot program 0.3 (devnet)' },
];
/** Is this tool offered with this environment? */
export const offered = (name, env = process.env) => !OPTIONAL_TOOLS.some(o => name.startsWith(o.prefix) && !o.on(env));

/** The server's instructions: the loop's order in one line, from the order itself (builder/mcp/loop-tools.mjs). */
export { INSTRUCTIONS } from './loop-tools.mjs';
import { INSTRUCTIONS } from './loop-tools.mjs';

/** The commands that open a browser: under GAMESFUN_GPU_WRAP they go through the machine's graphics-card queue. */
const BROWSER_COMMANDS = new Set(['verify', 'play']);
/** Run the gamesfun CLI as a child (keeps long browser runs and their output out of this process). */
export function runCli(args, { onLine = null, cwd = KIT_ROOT, env = {} } = {}) {
  const wrap = BROWSER_COMMANDS.has(args[0]) ? gpuWrap({ ...process.env, ...env }) : [];
  const [file, ...pre] = wrap.length ? [...wrap, process.execPath] : [process.execPath];
  return new Promise((resolve, reject) => {
    const c = spawn(file, [...pre, BIN, ...args], { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '', stderr = '';
    const split = (stream) => { let buf = ''; return d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { onLine?.(buf.slice(0, i).replace(/\r$/, ''), stream); buf = buf.slice(i + 1); } }; };
    const o = split('stdout'), e = split('stderr');
    c.stdout.on('data', d => { stdout += d; o(String(d)); });
    c.stderr.on('data', d => { stderr += d; e(String(d)); });
    c.on('error', reject);
    c.on('close', code => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

/** Every tool from builder/mcp/tools/*.mjs. → { tools: Map(name → tool), problems: [] } */
export async function loadTools(dir = TOOLS_DIR, log = () => {}) {
  const tools = new Map(), problems = [];
  let files = [];
  try { files = (await readdir(dir)).filter(f => f.endsWith('.mjs')).sort(); } catch {}
  for (const f of files) {
    try {
      const mod = await import(pathToFileURL(path.join(dir, f)).href);
      if (!Array.isArray(mod.tools)) throw new Error('must export `tools`, an array');
      for (const t of mod.tools) {
        if (!t || !NAME.test(t.name ?? '') || typeof t.handler !== 'function' || typeof t.description !== 'string') { problems.push(`${f}: a tool needs name (${NAME}), description and handler`); continue; }
        if (tools.has(t.name)) { problems.push(`${f}: tool ${t.name} is already defined by ${tools.get(t.name).file}`); continue; }
        tools.set(t.name, { ...t, inputSchema: t.inputSchema ?? { type: 'object', properties: {} }, file: f });
      }
    } catch (e) { problems.push(`${f}: ${e.message}`); }
  }
  for (const p of problems) log(`mcp: ${p}`);
  return { tools, problems };
}

// ---------------------------------------------------------------- JSON Schema checks (Ajv, compiled once per schema)
const ajv = new Ajv({ allErrors: true, strict: false });
const compiled = new WeakMap();
const validatorOf = schema => { let v = compiled.get(schema); if (!v) compiled.set(schema, v = ajv.compile(schema)); return v; };
/** Ajv's errors in plain words, one per problem: "report.promises/0/pass must be boolean,null". */
function words(errors, root) {
  const out = [];
  for (const e of errors ?? []) {
    const at = [root, ...e.instancePath.split('/').filter(Boolean)].filter(Boolean).join('.').replace(/\.(\d+)(?=\.|$)/g, '[$1]');
    const line = e.keyword === 'required' ? `${[at, e.params.missingProperty].filter(Boolean).join('.')} is required`
      : e.keyword === 'additionalProperties' ? `${at || 'arguments'}: "${e.params.additionalProperty}" is not an argument this takes`
      : e.keyword === 'enum' ? `${at} must be one of ${e.params.allowedValues.map(v => JSON.stringify(v)).join(', ')}`
      : e.keyword === 'type' ? `${at || 'arguments'} must be ${[].concat(e.params.type).join(' or ')}`
      : `${at || 'arguments'} ${e.message}`;
    if (!out.includes(line)) out.push(line);
  }
  return out;
}
/** Every way `input` does not fit the tool's inputSchema, in words; [] when it fits. */
export function inputProblems(schema, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return ['arguments must be an object'];
  const v = validatorOf(schema ?? { type: 'object' });
  return v(input) ? [] : words(v.errors, '');
}
/** Every way an answer does not fit an output schema (tests hold each tool to its own). */
export function outputProblems(schema, value) {
  const v = validatorOf(schema);
  return v(value) ? [] : words(v.errors, 'result');
}
/** The four hints every shipped tool declares (tests/seams.test.mjs holds them to it). */
export const HINTS = ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'];

/** The game folder a call names (its `game` or `dir` argument), when it is a folder that exists. → done() */
export async function running(tool, input) {
  const arg = typeof input.game === 'string' ? input.game : typeof input.dir === 'string' ? input.dir : null;
  if (!arg) return async () => {};
  const dir = path.resolve(KIT_ROOT, arg);
  try { if (dir === KIT_ROOT || !(await stat(dir)).isDirectory()) return async () => {}; } catch { return async () => {}; }
  return markRunning(dir, tool);
}

/**
 * A handler's answer as an MCP result. With `tool.outputSchema`, an answer that is not an error also goes out as
 * structuredContent (an object; a text answer is { text }), and the text part stays the same JSON, so a client that
 * reads only text sees what it always did.
 */
export function toResult(value, tool = null) {
  const isMcp = value && typeof value === 'object' && Array.isArray(value.content);
  const out = isMcp ? value : { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value ?? null, null, 2) }] };
  if (!tool?.outputSchema || out.isError || out.structuredContent) return out;
  let structured = isMcp ? null : value;
  if (isMcp) { try { structured = JSON.parse(out.content.find(c => c.type === 'text')?.text ?? 'null'); } catch { structured = out.content.find(c => c.type === 'text')?.text ?? null; } }
  if (typeof structured === 'string') structured = { text: structured };
  return structured && typeof structured === 'object' && !Array.isArray(structured) ? { ...out, structuredContent: structured } : out;
}

export async function createServer({ toolsDir = TOOLS_DIR, log = (...a) => console.error(...a), env = process.env } = {}) {
  const { Server } = await import('@modelcontextprotocol/sdk/server/index.js');
  const { ListToolsRequestSchema, CallToolRequestSchema } = await import('@modelcontextprotocol/sdk/types.js');
  const { readFile } = await import('node:fs/promises');
  const pkg = JSON.parse(await readFile(path.join(KIT_ROOT, 'package.json'), 'utf8'));
  const { tools: all } = await loadTools(toolsDir, log);
  const tools = new Map([...all].filter(([name]) => offered(name, env)));
  const server = new Server({ name: 'gamesfun', version: pkg.version }, {
    capabilities: { tools: {} },
    instructions: INSTRUCTIONS,
  });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...tools.values()].map(t => ({ name: t.name, ...(t.title ? { title: t.title } : {}), description: t.description, inputSchema: t.inputSchema, ...(t.outputSchema ? { outputSchema: t.outputSchema } : {}), ...(t.annotations ? { annotations: t.annotations } : {}) })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const t = tools.get(req.params.name);
    if (!t) return { isError: true, content: [{ type: 'text', text: `no tool ${req.params.name}` }] };
    const input = req.params.arguments ?? {};
    const bad = inputProblems(t.inputSchema, input);
    if (bad.length) return { isError: true, content: [{ type: 'text', text: bad.join('; ') }] };
    const token = req.params._meta?.progressToken;
    let n = 0;
    const ctx = {
      kitRoot: KIT_ROOT,
      client: server.getClientVersion()?.name ?? null,   // which agent is connected (builder/art/providers.mjs)
      log,
      progress: message => { if (token === undefined) return; extra.sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress: ++n, message: String(message).slice(0, 300) } }).catch(() => {}); },
      runCli,
      signal: extra.signal,
    };
    // While a call runs on a game folder, say so in that folder (builder/lib/running.mjs): an agent that moved a long call to
    // the background and ended its turn is waiting for it, and the studio's stop guard must not count that turn end.
    const done = await running(req.params.name, input);
    try { return toResult(await t.handler(input, ctx), t); }
    catch (e) { return { isError: true, content: [{ type: 'text', text: e.message }] }; }
    finally { await done(); }
  });
  return { server, tools };
}

if (isMain(import.meta)) {
  // stdout belongs to the protocol: anything a library prints goes to stderr instead
  console.log = (...a) => console.error(...a);
  console.info = (...a) => console.error(...a);
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const { server, tools } = await createServer();
  // Whoever started this server stopping it (a closed stdin, a stop signal) is an ordinary exit, so the 'exit' handlers
  // run: a verify under way is stopped with its browser (builder/mcp/tools/loop.mjs), and the running marks are removed.
  // Windows knows SIGINT and SIGTERM only by name.
  process.stdin.on('close', () => process.exit(0));
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) { try { process.on(sig, () => process.exit(0)); } catch { /* not on this system */ } }
  await server.connect(new StdioServerTransport());
  console.error(`gamesfun MCP server: ${tools.size} tools (${[...tools.keys()].join(', ')})`);
}
