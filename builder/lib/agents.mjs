// The agent registry: builder/lib/agents.json is data, this is its reader. One row per coding agent (binary names per system,
// how to detect it, how its own command adds, checks and removes an MCP server). Everything that touches an agent goes
// through the row's own commands, with no shell; nothing here reads an agent's configuration or login files.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { findProgram, run } from './proc.mjs';

const FILE = fileURLToPath(new URL('./agents.json', import.meta.url));
const SYSTEMS = ['win32', 'darwin', 'linux'];
const PLUGIN_COMMANDS = ['addMarketplace', 'install', 'list', 'listMarketplaces', 'uninstall', 'removeMarketplace'];

export function loadAgents(file = FILE) {
  const data = JSON.parse(readFileSync(file, 'utf8'));
  const problems = agentProblems(data);
  if (problems.length) throw new Error(`agents.json: ${problems.join('; ')}`);
  return data;
}

/** What is wrong with a registry, as plain sentences ([] when it is fine). */
export function agentProblems(data) {
  const out = [];
  if (data?.schema !== 'gamesfun-agents/1') out.push('schema must be gamesfun-agents/1');
  if (!/^[a-z0-9-]+$/.test(data?.server?.name ?? '')) out.push('server.name must be lower-case letters, digits and dashes');
  const ids = new Set();
  for (const a of data?.agents ?? []) {
    const at = `agent ${a?.id ?? '?'}`;
    if (!/^[a-z0-9-]+$/.test(a?.id ?? '')) out.push(`${at}: id`);
    if (ids.has(a.id)) out.push(`${at}: duplicate id`);
    ids.add(a.id);
    for (const s of SYSTEMS) {
      if (!Array.isArray(a.binaries?.[s]) || !a.binaries[s].length) out.push(`${at}: binaries.${s}`);
      if (typeof a.install?.[s] !== 'string') out.push(`${at}: install.${s}`);
    }
    const m = a.mcp ?? {};
    if (!Array.isArray(m.scopes) || !m.scopes.includes(m.defaultScope)) out.push(`${at}: mcp.defaultScope must be one of mcp.scopes`);
    if (m.projectScope && !m.scopes?.includes(m.projectScope)) out.push(`${at}: mcp.projectScope must be one of mcp.scopes`);
    for (const k of ['add', 'get', 'list', 'remove']) if (!Array.isArray(m[k]) || m[k].some(x => typeof x !== 'string')) out.push(`${at}: mcp.${k} must be a list of strings`);
    if (!m.add?.includes('{name}') || !m.add?.includes('{command}') || !m.add?.includes('{...args}')) out.push(`${at}: mcp.add needs {name}, {command} and {...args}`);
    if (m.add?.includes('--') && m.add.indexOf('--') > m.add.indexOf('{command}')) out.push(`${at}: mcp.add: -- must come before {command}`);
    if (m.add?.includes('{scope}') && m.scopes.length < 2) out.push(`${at}: mcp.add has {scope} but only one scope`);
    if (a.plugin !== undefined && a.plugin !== null) {
      const pl = a.plugin;
      for (const k of ['marketplace', 'name']) if (!/^[a-z0-9-]+$/.test(pl[k] ?? '')) out.push(`${at}: plugin.${k}`);
      if (!Array.isArray(pl.scopes) || !pl.scopes.length) out.push(`${at}: plugin.scopes`);
      for (const k of PLUGIN_COMMANDS) if (!Array.isArray(pl[k]) || pl[k].some(x => typeof x !== 'string')) out.push(`${at}: plugin.${k} must be a list of strings`);
      if (!pl.addMarketplace?.includes('{kit}')) out.push(`${at}: plugin.addMarketplace needs {kit}`);
    }
  }
  return out;
}

/** Fill a template list: "{name}" → vars.name; the element "{...args}" → every element of vars.args. */
export function expand(template, vars) {
  const out = [];
  for (const t of template) {
    if (t === '{...args}') { out.push(...(vars.args ?? [])); continue; }
    out.push(t.replace(/\{(name|scope|command)\}/g, (_, k) => {
      if (vars[k] === undefined) throw new Error(`no value for {${k}}`);
      return String(vars[k]);
    }));
  }
  return out;
}

/** Where the agent's program is on this machine: { id, name, optional, found, path, version, row } (never throws). */
export async function detectAgent(row, { platform = process.platform, env = process.env, exists, runner = run } = {}) {
  const names = row.binaries[platform] ?? row.binaries.linux;
  const p = findProgram(names, { platform, env, exists });
  const base = { id: row.id, name: row.name, optional: !!row.optional, row, found: !!p, path: p, version: null };
  if (!p) return base;
  const r = await runner(p, row.versionArgs ?? ['--version'], { env, timeoutMs: 15000, platform });
  const line = `${r.stdout}\n${r.stderr}`.split(/\r?\n/).map(s => s.trim()).find(Boolean) ?? null;
  return { ...base, version: r.code === 0 ? line : null, versionError: r.code === 0 ? null : (r.error ?? `exit ${r.code}`) };
}

export async function detectAll(data = loadAgents(), opts = {}) {
  return Promise.all(data.agents.map(row => detectAgent(row, opts)));
}

/** The server's start command: this very Node and the absolute path of builder/mcp/server.mjs (a bare `node` has failed to start for agents on Windows). */
export function serverCommand(serverFile, { nodePath = process.execPath } = {}) {
  return { command: nodePath, args: [serverFile] };
}

/** The agent's own commands for one server, ready to run: { add, get, list, remove } as argument lists. */
export function mcpCommands(row, { name, scope, command, args }) {
  const sc = scope ?? row.mcp.defaultScope;
  if (!row.mcp.scopes.includes(sc)) throw new Error(`${row.name} has no "${sc}" scope (it has: ${row.mcp.scopes.join(', ')})`);
  const vars = { name, scope: sc, command, args };
  return Object.fromEntries(['add', 'get', 'list', 'remove'].map(k => [k, expand(row.mcp[k], vars)]));
}

/**
 * The agent's own commands for this kit's plugin, ready to run, or null when the row has none:
 * { id: '<plugin>@<marketplace>', marketplace, scope, addMarketplace, install, list, listMarketplaces, uninstall, removeMarketplace }.
 */
export function pluginCommands(row, { scope, kit }) {
  const pl = row.plugin;
  if (!pl) return null;
  const sc = scope ?? row.mcp.defaultScope;
  if (!pl.scopes.includes(sc)) throw new Error(`${row.name} has no "${sc}" scope for a plugin (it has: ${pl.scopes.join(', ')})`);
  const vars = { kit, scope: sc, plugin: pl.name, marketplace: pl.marketplace };
  const fill = list => list.map(t => t.replace(/\{(kit|scope|plugin|marketplace)\}/g, (_, k) => String(vars[k])));
  return { id: `${pl.name}@${pl.marketplace}`, marketplace: pl.marketplace, scope: sc, ...Object.fromEntries(PLUGIN_COMMANDS.map(k => [k, fill(pl[k])])) };
}
