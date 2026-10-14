// Stand-ins for Claude Code and Codex as `connect` uses them: programs on a PATH of their own, under a temporary HOME,
// that answer `mcp get|add|remove` for a stdio server and Claude Code's `plugin` commands, in the shapes the real
// programs print (Claude Code 2.1.296 and Codex 0.160.0, run under a scratch HOME on 2026-10-12):
//   claude mcp get <name>                     "  Command: <node>" and "  Args: <server.mjs>" lines, exit 1 when not there
//   claude mcp add … <name> -- <cmd> <args>   refuses a name it has ("already exists"); $CLAUDE_CONFIG_DIR/.claude.json
//   claude plugin marketplace add <dir>       re-points a marketplace of the same name that came from another folder
//   claude plugin marketplace list --json     [{ name, source: 'directory', path, installLocation }]
//   claude plugin list --json                 [{ id, scope, enabled, installPath, readFromFolder }]; readFromFolder is
//                                             left out when that folder is gone, as Claude Code does
//   codex mcp get <name>                      "  command: …" and "  args: …"; `add` writes over a name it has
// Every call is appended to $FAKE_AGENT_LOG. Use only with a temporary HOME, CLAUDE_CONFIG_DIR and CODEX_HOME.
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const COMMON = `const fs = require('node:fs'), path = require('node:path');
const a = process.argv.slice(2);
if (process.env.FAKE_AGENT_LOG) fs.appendFileSync(process.env.FAKE_AGENT_LOG, JSON.stringify({ agent: AGENT, args: a }) + '\\n');
const read = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const write = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2)); };
const after = (k, d = null) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
`;

const CLAUDE = `#!/usr/bin/env node
const AGENT = 'claude';
${COMMON}
const dir = process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME, '.claude');
const cfg = path.join(dir, '.claude.json'), plug = path.join(dir, 'fake-plugins.json');
if (a[0] === '--version') { console.log('2.1.296 (Claude Code)'); process.exit(0); }
if (a[0] === 'mcp') {
  const c = read(cfg, { mcpServers: {} }); c.mcpServers ??= {};
  if (a[1] === 'get') {
    const s = c.mcpServers[a[2]];
    if (!s) { console.error('No MCP server found with name: ' + a[2]); process.exit(1); }
    console.log(a[2] + ':\\n  Scope: User config (available in all your projects)\\n  Status: ✔ Connected\\n  Type: stdio\\n  Command: ' + s.command + '\\n  Args: ' + s.args.join(' ') + '\\n  Environment:\\n\\nTo remove this server, run: claude mcp remove ' + a[2] + ' -s user');
    process.exit(0);
  }
  if (a[1] === 'add') {
    const dd = a.indexOf('--'), name = a[dd - 1];
    if (c.mcpServers[name]) { console.error('MCP server ' + name + ' already exists in user config'); process.exit(1); }
    c.mcpServers[name] = { type: 'stdio', command: a[dd + 1], args: a.slice(dd + 2), env: {} };
    write(cfg, c); console.log('Added stdio MCP server ' + name + ' to user config'); process.exit(0);
  }
  if (a[1] === 'remove') {
    const name = a.at(-1);
    if (!c.mcpServers[name]) { console.error('No MCP server found with name: ' + name); process.exit(1); }
    delete c.mcpServers[name]; write(cfg, c); console.log('Removed MCP server ' + name + ' from user config'); process.exit(0);
  }
}
if (a[0] === 'plugin') {
  const p = read(plug, { markets: {}, plugins: [] });
  if (a[1] === 'marketplace' && a[2] === 'list') { console.log(JSON.stringify(Object.entries(p.markets).map(([name, at]) => ({ name, source: 'directory', path: at, installLocation: at })), null, 2)); process.exit(0); }
  if (a[1] === 'marketplace' && a[2] === 'add') {
    const at = path.resolve(a[3]), m = read(path.join(at, '.claude-plugin', 'marketplace.json'), null);
    if (!m) { console.error('✘ Failed to add marketplace: no .claude-plugin/marketplace.json in ' + at); process.exit(1); }
    const was = p.markets[m.name]; p.markets[m.name] = at; write(plug, p);
    console.log('✔ Successfully added marketplace: ' + m.name + (was && was !== at ? '\\n  Marketplace was already added from dir:' + was + ' and now points at dir:' + at + '.' : ''));
    process.exit(0);
  }
  if (a[1] === 'marketplace' && a[2] === 'remove') {
    if (!p.markets[a[3]]) { console.error('✘ Marketplace ' + a[3] + ' not found'); process.exit(1); }
    delete p.markets[a[3]]; write(plug, p); console.log('✔ Successfully removed marketplace: ' + a[3]); process.exit(0);
  }
  if (a[1] === 'list') {
    console.log(JSON.stringify(p.plugins.map(x => ({ id: x.id, version: '0.1.0', scope: x.scope, enabled: true, installPath: path.join(dir, 'plugins', 'cache', x.id), ...(fs.existsSync(x.from) ? { readFromFolder: x.from } : { errors: ['Marketplace failed to load: cache-miss'] }) })), null, 2));
    process.exit(0);
  }
  if (a[1] === 'install') {
    const [plugin, market] = a[2].split('@');
    if (!p.markets[market]) { console.error('✘ Plugin "' + a[2] + '" not found in any marketplace'); process.exit(1); }
    p.plugins = p.plugins.filter(x => x.id !== a[2]);
    const src = read(path.join(p.markets[market], '.claude-plugin', 'marketplace.json'), { plugins: [] }).plugins.find(x => x.name === plugin)?.source ?? plugin;
    p.plugins.push({ id: a[2], scope: after('--scope', 'user'), from: path.join(p.markets[market], src) });
    write(plug, p); console.log('✔ Successfully installed plugin: ' + a[2]); process.exit(0);
  }
  if (a[1] === 'uninstall') {
    if (!p.plugins.some(x => x.id === a[2])) { console.error('✘ Plugin "' + a[2] + '" is not installed'); process.exit(1); }
    p.plugins = p.plugins.filter(x => x.id !== a[2]); write(plug, p); console.log('✔ Successfully uninstalled plugin: ' + a[2]); process.exit(0);
  }
}
console.error('the stand-in does not know: ' + a.join(' ')); process.exit(2);
`;

const CODEX = `#!/usr/bin/env node
const AGENT = 'codex';
${COMMON}
const file = path.join(process.env.CODEX_HOME || path.join(process.env.HOME, '.codex'), 'fake-mcp.json');
if (a[0] === '--version') { console.log('codex-cli 0.160.0'); process.exit(0); }
const c = read(file, {});
if (a[0] === 'mcp' && a[1] === 'get') {
  const s = c[a[2]];
  if (!s) { console.error('Error: No MCP server named \\'' + a[2] + '\\' found.'); process.exit(1); }
  console.log(a[2] + '\\n  enabled: true\\n  transport: stdio\\n  command: ' + s.command + '\\n  args: ' + s.args.join(' ') + '\\n  cwd: -\\n  env: -\\n  remove: codex mcp remove ' + a[2]);
  process.exit(0);
}
if (a[0] === 'mcp' && a[1] === 'add') { const dd = a.indexOf('--'); c[a[2]] = { command: a[dd + 1], args: a.slice(dd + 2) }; write(file, c); console.log("Added global MCP server '" + a[2] + "'."); process.exit(0); }
if (a[0] === 'mcp' && a[1] === 'remove') {
  if (!c[a[2]]) { console.error('Error: No MCP server named \\'' + a[2] + '\\' found.'); process.exit(1); }
  delete c[a[2]]; write(file, c); console.log("Removed global MCP server '" + a[2] + "'."); process.exit(0);
}
console.error('the stand-in does not know: ' + a.join(' ')); process.exit(2);
`;

/** Write the stand-ins into `<dir>/bin`, with a home of their own. → { bin, home, log, env } */
export async function fakeConnectAgents(dir) {
  const bin = path.join(dir, 'bin'), home = path.join(dir, 'home'), log = path.join(dir, 'agents.log');
  await mkdir(bin, { recursive: true });
  await mkdir(home, { recursive: true });
  for (const [name, src] of [['claude', CLAUDE], ['codex', CODEX]]) {
    await writeFile(path.join(bin, name), src);
    await chmod(path.join(bin, name), 0o755);
  }
  // the PATH holds the stand-ins and this Node only (so the real agents of this machine are never found)
  const PATH = [bin, path.dirname(process.execPath)].join(path.delimiter);
  return { bin, home, log, env: { PATH, HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, '.codex'), CLAUDE_CONFIG_DIR: path.join(home, '.claude'), FAKE_AGENT_LOG: log } };
}
