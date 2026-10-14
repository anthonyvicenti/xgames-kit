// Stand-ins for Claude Code and Codex, as programs on a PATH of their own, so "Add Supabase to my agents" runs the
// agents' own commands for real (spawned, with arguments) without touching this machine's agents. Each one answers only
// what the kit calls: --version, and `mcp get|add|remove`, shaped from the real programs' behaviour:
//   claude mcp add --scope project --transport http <name> <url>   writes <cwd>/.mcp.json (Claude Code 2.1.296 does;
//                                                                   checked under a scratch HOME), refuses a name it has;
//                                                                   --scope local|user: $HOME/.claude.json
//   claude mcp get <name>                                           0 when <cwd>/.mcp.json or $HOME/.claude.json has it
//   claude mcp remove --scope project <name>                        leaves {"mcpServers": {}} behind, as Claude Code does
//   codex mcp add <name> --url <url> | get | remove                 ${CODEX_HOME:-$HOME/.codex}/config.toml
// Every call is appended to $FAKE_AGENT_LOG. Use only with a temporary HOME and CODEX_HOME.
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const CLAUDE = `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
const a = process.argv.slice(2);
if (process.env.FAKE_AGENT_LOG) fs.appendFileSync(process.env.FAKE_AGENT_LOG, JSON.stringify({ agent: 'claude', args: a, cwd: process.cwd() }) + '\\n');
if (a[0] === '--version') { console.log('2.1.296 (Claude Code)'); process.exit(0); }
const file = path.join(process.cwd(), '.mcp.json');
const read = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const user = read(path.join(process.env.HOME, '.claude.json'));
if (a[0] === 'mcp' && a[1] === 'get') {
  const name = a[2], p = read(file)?.mcpServers?.[name], u = user?.mcpServers?.[name];
  const s = p ?? u;
  if (!s) { console.error('No MCP server named "' + name + '".'); process.exit(1); }
  console.log(name + ':\\n  Scope: ' + (p ? 'Project config (shared via .mcp.json)' : 'User config') + '\\n  Type: ' + s.type + '\\n  URL: ' + s.url);
  process.exit(0);
}
if (a[0] === 'mcp' && a[1] === 'add') {
  const i = a.indexOf('--scope'), scope = a[i + 1], t = a.indexOf('--transport');
  const rest = a.slice(2).filter((x, k) => ![i - 2, i - 1, t - 2, t - 1].includes(k));
  const [name, url] = rest;
  // project scope: <cwd>/.mcp.json; local and user scope: the stand-in's own $HOME/.claude.json
  const target = scope === 'project' ? file : path.join(process.env.HOME, '.claude.json');
  const j = read(target) ?? { mcpServers: {} };
  j.mcpServers ??= {};
  if (j.mcpServers[name]) { console.error('MCP server ' + name + ' already exists'); process.exit(1); }
  j.mcpServers[name] = { type: a[t + 1], url };
  fs.writeFileSync(target, JSON.stringify(j, null, 2));
  console.log('Added HTTP MCP server ' + name + ' with URL: ' + url + ' to project config');
  process.exit(0);
}
if (a[0] === 'mcp' && a[1] === 'remove') {
  const name = a[a.length - 1], j = read(file);
  if (!j?.mcpServers?.[name]) { console.error('No project-scoped MCP server named ' + name); process.exit(1); }
  delete j.mcpServers[name];
  fs.writeFileSync(file, JSON.stringify(j, null, 2));
  console.log('Removed MCP server ' + name + ' from project config');
  process.exit(0);
}
console.error('the stand-in does not know: ' + a.join(' ')); process.exit(2);
`;

const CODEX = `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
const a = process.argv.slice(2);
if (process.env.FAKE_AGENT_LOG) fs.appendFileSync(process.env.FAKE_AGENT_LOG, JSON.stringify({ agent: 'codex', args: a, cwd: process.cwd() }) + '\\n');
if (a[0] === '--version') { console.log('codex-cli 0.130.0'); process.exit(0); }
const home = process.env.CODEX_HOME || path.join(process.env.HOME, '.codex');
const file = path.join(home, 'config.toml');
const text = () => { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } };
const has = name => new RegExp('^\\\\[mcp_servers\\\\.' + name + '\\\\]$', 'm').test(text());
if (a[0] === 'mcp' && a[1] === 'get') {
  if (!has(a[2])) { console.error('No MCP server named ' + a[2] + ' found.'); process.exit(1); }
  console.log(text().split('[mcp_servers.' + a[2] + ']')[1].split('\\n[')[0].trim()); process.exit(0);
}
if (a[0] === 'mcp' && a[1] === 'add') {
  const name = a[2], url = a[a.indexOf('--url') + 1];
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(file, text() + (text() && !text().endsWith('\\n') ? '\\n' : '') + '[mcp_servers.' + name + ']\\nurl = "' + url + '"\\n');
  console.log("Added global MCP server '" + name + "'."); process.exit(0);
}
if (a[0] === 'mcp' && a[1] === 'remove') {
  const name = a[2];
  if (!has(name)) { console.error('No MCP server named ' + name); process.exit(1); }
  const out = text().replace(new RegExp('\\\\[mcp_servers\\\\.' + name + '\\\\]\\\\n(?:[^\\\\[\\\\n][^\\\\n]*\\\\n?)*', 'm'), '');
  fs.writeFileSync(file, out); console.log("Removed global MCP server '" + name + "'."); process.exit(0);
}
console.error('the stand-in does not know: ' + a.join(' ')); process.exit(2);
`;

/** Write the two stand-ins into `<dir>/bin`, with a home of their own. → { bin, home, codexHome, log, env } */
export async function fakeAgents(dir, { only = ['claude', 'codex'] } = {}) {
  const bin = path.join(dir, 'bin'), home = path.join(dir, 'home'), codexHome = path.join(home, '.codex'), log = path.join(dir, 'agents.log');
  await mkdir(bin, { recursive: true });
  await mkdir(home, { recursive: true });
  for (const [name, src] of [['claude', CLAUDE], ['codex', CODEX]]) {
    if (!only.includes(name)) continue;
    await writeFile(path.join(bin, name), src);
    await chmod(path.join(bin, name), 0o755);
  }
  // the PATH holds the stand-ins and this Node only (so the real agents of this machine are never found)
  const PATH = [bin, path.dirname(process.execPath)].join(path.delimiter);
  return { bin, home, codexHome, log, env: { PATH, HOME: home, USERPROFILE: home, CODEX_HOME: codexHome, CLAUDE_CONFIG_DIR: path.join(home, '.claude'), FAKE_AGENT_LOG: log } };
}
