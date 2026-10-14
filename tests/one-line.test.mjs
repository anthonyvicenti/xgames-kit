// The one-line entry: the agent registry, connect, doctor, update and the process helpers. Windows and macOS cases are
// checked with a fake platform and path.win32, as in paths.test.mjs; real agents are never started (a recording runner
// stands in), and the real Claude Code and Codex runs are documented in docs/DEVELOPING.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { agentProblems, detectAgent, expand, loadAgents, mcpCommands } from '../builder/lib/agents.mjs';
import { connect, SERVER_FILE } from '../builder/lib/connect.mjs';
import { formatDoctor, runDoctor, SOFTWARE_RENDERER } from '../builder/lib/doctor.mjs';
import { listServerTools } from '../builder/lib/mcp-check.mjs';
import { agentCommand, findProgram, stopCommand } from '../builder/lib/proc.mjs';
import { checkAllowed, DAY_MS, kitState, noticeText, startUpdateCheck, updateKit } from '../builder/lib/update.mjs';
import { tempDir } from './helpers.mjs';

const data = loadAgents();
const claude = data.agents.find(a => a.id === 'claude'), codex = data.agents.find(a => a.id === 'codex');

test('agents.json is valid and has Claude Code and Codex', () => {
  assert.deepEqual(agentProblems(data), []);
  assert.deepEqual(data.agents.map(a => a.id).sort(), ['claude', 'codex']);
});

test('a broken row is named, not swallowed', () => {
  const bad = structuredClone(data);
  bad.agents[0].mcp.add = ['mcp', 'add', '{name}'];
  bad.agents[1].binaries.win32 = [];
  bad.agents.push({ ...structuredClone(bad.agents[0]), id: 'claude' });
  const p = agentProblems(bad).join('\n');
  assert.match(p, /mcp\.add needs/);
  assert.match(p, /binaries\.win32/);
  assert.match(p, /duplicate id/);
});

test('a new agent is a row: nothing else changes', () => {
  const more = structuredClone(data);
  more.agents.push({ ...structuredClone(codex), id: 'other', name: 'Other' });
  assert.deepEqual(agentProblems(more), []);
});

test('expand fills names and spreads {...args}', () => {
  assert.deepEqual(expand(['a', '{name}', '--', '{command}', '{...args}'], { name: 'x', command: '/n', args: ['1', '2 3'] }), ['a', 'x', '--', '/n', '1', '2 3']);
  assert.throws(() => expand(['{scope}'], {}), /no value for \{scope\}/);
});

test('the agents\' own commands, with an absolute Node and a path holding spaces', () => {
  const v = { name: 'gamesfun', command: 'C:\\Program Files\\nodejs\\node.exe', args: ['C:\\Users\\Ada Lovelace\\gamesfun-kit\\mcp\\server.mjs'] };
  const c = mcpCommands(claude, { ...v, scope: 'project' });
  assert.deepEqual(c.add, ['mcp', 'add', '--transport', 'stdio', '--scope', 'project', 'gamesfun', '--', v.command, v.args[0]]);
  assert.deepEqual(c.remove, ['mcp', 'remove', '--scope', 'project', 'gamesfun']);
  assert.equal(mcpCommands(claude, v).add[5], 'user');
  const x = mcpCommands(codex, v);
  assert.deepEqual(x.add, ['mcp', 'add', 'gamesfun', '--', v.command, v.args[0]]);
  assert.deepEqual(x.list, ['mcp', 'list', '--json']);
  assert.throws(() => mcpCommands(codex, { ...v, scope: 'project' }), /no "project" scope/);
});

test('finding an agent on Windows: PATHEXT, a .cmd shim, no shell', async () => {
  const have = new Set(['C:\\npm\\codex.cmd', 'C:\\bin\\claude.exe']);
  const env = { PATH: 'C:\\nothing;C:\\npm;C:\\bin', PATHEXT: '.COM;.EXE;.BAT;.CMD' };
  const exists = p => have.has(p);
  assert.equal(findProgram(codex.binaries.win32, { platform: 'win32', env, exists }), 'C:\\npm\\codex.cmd');
  assert.equal(findProgram(claude.binaries.win32, { platform: 'win32', env, exists }), 'C:\\bin\\claude.exe');
  assert.equal(findProgram(['nope'], { platform: 'win32', env, exists }), null);
  const calls = [];
  const d = await detectAgent(codex, { platform: 'win32', env, exists, runner: async (f, a) => { calls.push([f, a]); return { code: 0, stdout: 'codex-cli 9.9\n', stderr: '' }; } });
  assert.equal(d.found, true);
  assert.equal(d.version, 'codex-cli 9.9');
  assert.deepEqual(calls, [['C:\\npm\\codex.cmd', ['--version']]]);
  const none = await detectAgent(claude, { platform: 'linux', env: { PATH: '' }, exists: () => false });
  assert.equal(none.found, false);
});

test('a Windows batch shim goes through cmd.exe once; syntax characters are refused', () => {
  const env = { ComSpec: 'C:\\Windows\\System32\\cmd.exe' };
  const c = agentCommand('C:\\npm\\codex.cmd', ['mcp', 'add', 'gamesfun', '--', 'C:\\Program Files\\nodejs\\node.exe', 'C:\\Users\\Ada Lovelace\\kit\\mcp\\server.mjs'], { platform: 'win32', env });
  assert.equal(c.cmd, 'C:\\Windows\\System32\\cmd.exe');
  assert.deepEqual(c.args.slice(0, 3), ['/d', '/s', '/c']);
  assert.equal(c.args[3], '"C:\\npm\\codex.cmd mcp add gamesfun -- "C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\Ada Lovelace\\kit\\mcp\\server.mjs""');
  assert.equal(c.windowsVerbatimArguments, true);
  for (const bad of ['a&b', '50%', 'x"y', 'a|b', 'a^b', '<x', 'a\nb']) assert.throws(() => agentCommand('C:\\npm\\codex.cmd', [bad], { platform: 'win32', env }), /refusing/);
  assert.deepEqual(agentCommand('C:\\bin\\claude.exe', ['a&b'], { platform: 'win32', env }), { cmd: 'C:\\bin\\claude.exe', args: ['a&b'] });
  assert.deepEqual(agentCommand('/usr/bin/codex.cmd', ['x'], { platform: 'linux' }), { cmd: '/usr/bin/codex.cmd', args: ['x'] });
});

test('stopping a tree: taskkill on Windows, the process group elsewhere, never pid 0', () => {
  assert.deepEqual(stopCommand(4242, { platform: 'win32' }), { cmd: 'taskkill', args: ['/PID', '4242', '/T', '/F'] });
  assert.deepEqual(stopCommand(4242, { platform: 'linux' }), { group: true, pid: 4242 });
  assert.deepEqual(stopCommand(4242, { platform: 'darwin' }), { group: true, pid: 4242 });
  for (const bad of [0, -1, NaN, '12', null]) assert.equal(stopCommand(bad, { platform: 'win32' }), null);
});

// A recording stand-in for an agent's program: it keeps a set of registered names and answers get/add/remove.
function fakeAgents({ registered = {}, addFails = false, pluginFails = null } = {}) {
  const calls = [], state = { ...registered };
  const runner = async (file, argv) => {
    calls.push([path.basename(file), ...argv].join(' '));
    const id = path.basename(file);
    const verb = argv[1];
    if (argv[0] === 'plugin') {   // the agent's plugin commands: a marketplace, an install, a list, an uninstall
      const sc = argv.includes('--scope') ? argv[argv.indexOf('--scope') + 1] : 'user';
      if (verb === 'list') return { code: 0, stdout: JSON.stringify(state.plugin ? [{ id: state.plugin.id, scope: state.plugin.scope, enabled: true }] : []), stderr: '' };
      if (verb === 'marketplace' && argv[2] === 'list') return { code: 0, stdout: JSON.stringify(state.marketplace ? [{ name: 'gamesfun-kit', source: 'directory', path: state.marketplace }] : []), stderr: '' };
      if (verb === 'marketplace') { if (pluginFails === 'marketplace') return { code: 1, stdout: '', stderr: 'no marketplace there' }; state.marketplace = argv[2] === 'add' ? argv[3] : undefined; return { code: 0, stdout: 'ok', stderr: '' }; }
      if (verb === 'install') { if (pluginFails === 'install') return { code: 1, stdout: '', stderr: 'not found in marketplace' }; state.plugin = { id: argv[2], scope: sc }; return { code: 0, stdout: 'ok', stderr: '' }; }
      if (verb === 'uninstall') { delete state.plugin; return { code: 0, stdout: 'ok', stderr: '' }; }
    }
    const nm = argv[0] === 'mcp' && verb === 'add' ? argv[argv.indexOf('--') > 0 ? argv.indexOf('--') - 1 : 2] : argv.at(-1);
    if (verb === 'get') return state[id] ? { code: 0, stdout: `gamesfun:\n  Status: ok\n`, stderr: '' } : { code: 1, stdout: '', stderr: 'No MCP server found' };
    if (verb === 'add') { if (addFails) return { code: 1, stdout: '', stderr: 'boom' }; state[id] = nm; return { code: 0, stdout: 'added', stderr: '' }; }
    if (verb === 'remove') { delete state[id]; return { code: 0, stdout: 'removed', stderr: '' }; }
    return { code: 1, stdout: '', stderr: 'unknown' };
  };
  const detected = data.agents.map(row => ({ id: row.id, name: row.name, optional: true, found: true, path: `/bin/${row.id}`, version: '1', row }));
  return { calls, state, runner, detected };
}
const okServer = async () => ({ ok: true, tools: ['gamesfun_catalog'] });

test('connect registers with each found agent through its own command, then checks it', async () => {
  const f = fakeAgents();
  const r = await connect({ runner: f.runner, detected: f.detected, listTools: okServer, data });
  assert.equal(r.ok, true);
  assert.deepEqual(r.results.map(x => x.status), ['registered', 'registered']);
  assert.equal(f.calls.filter(c => c.startsWith('claude mcp add --transport stdio --scope user gamesfun -- ')).length, 1);
  assert.equal(f.calls.filter(c => c.startsWith('codex mcp add gamesfun -- ')).length, 1);
  assert.ok(f.calls.every(c => /^(claude|codex) mcp (get|add)|^claude plugin (list|marketplace (add|list)|install)/.test(c)), 'only the agents\' own commands');
  assert.ok(r.results[0].steps.filter(s => s.command.includes(' mcp ')).at(-1).command.includes('mcp get'));
  assert.ok(r.results[0].steps.at(-1).command.includes('plugin list'), 'the plugin is checked last, in the agent\'s own list');
});

test('connect installs the kit\'s plugin through the agent\'s own plugin commands, from this checkout, and --remove takes it out', async () => {
  const f = fakeAgents();
  const kit = path.resolve('some kit');
  let r = await connect({ agent: 'claude', scope: 'local', dir: 'proj', kit, runner: f.runner, detected: f.detected, listTools: okServer, data });
  assert.equal(r.ok, true);
  assert.deepEqual(r.results[0].plugin, { id: 'gamesfun@gamesfun-kit', status: 'installed' });
  assert.ok(f.calls.includes(`claude plugin marketplace add ${kit} --scope local`), 'the checkout is the marketplace');
  assert.ok(f.calls.includes('claude plugin install gamesfun@gamesfun-kit --scope local'));
  assert.ok(f.calls.indexOf('claude plugin install gamesfun@gamesfun-kit --scope local') > f.calls.findIndex(c => c.startsWith('claude mcp add')), 'the tools first, then the plugin');
  assert.match(r.results[0].restartHint, /^nothing to type: .*session wait/, 'nothing is left to type in the session they are in');
  assert.ok(r.results[0].steps.every(s => s.cwd === path.resolve('proj')), 'local scope belongs to --dir');
  // a second run leaves both alone
  const before = f.calls.length;
  r = await connect({ agent: 'claude', scope: 'local', dir: 'proj', kit, runner: f.runner, detected: f.detected, listTools: okServer, data });
  assert.equal(r.results[0].plugin.status, 'already installed');
  assert.ok(!f.calls.slice(before).some(c => / (add|install) /.test(c)));
  r = await connect({ agent: 'claude', scope: 'local', dir: 'proj', kit, remove: true, runner: f.runner, detected: f.detected, data });
  assert.equal(r.results[0].plugin.status, 'removed');
  assert.equal(f.state.plugin, undefined);
  assert.ok(f.calls.includes('claude plugin uninstall gamesfun@gamesfun-kit --scope local') && f.calls.includes('claude plugin marketplace remove gamesfun-kit --scope local'));
  // an agent with no plugin command says so, and is still registered
  r = await connect({ agent: 'codex', runner: fakeAgents().runner, detected: f.detected, listTools: okServer, data });
  assert.equal(r.results[0].status, 'registered');
  assert.equal(r.results[0].plugin.status, 'none');
});

test('a refused plugin is reported and the tools stay registered; the scope and folder can come from the environment', async () => {
  for (const [fails, words] of [['marketplace', /refused the marketplace: no marketplace there/], ['install', /refused the plugin: not found/]]) {
    const f = fakeAgents({ pluginFails: fails });
    const r = await connect({ agent: 'claude', runner: f.runner, detected: f.detected, listTools: okServer, data });
    assert.equal(r.results[0].status, 'registered');
    assert.equal(r.results[0].plugin.status, 'failed');
    assert.match(r.results[0].plugin.note, words);
  }
  const g = fakeAgents();
  const r = await connect({ agent: 'claude', env: { GAMESFUN_CONNECT_SCOPE: 'local', GAMESFUN_CONNECT_DIR: 'elsewhere' }, runner: g.runner, detected: g.detected, listTools: okServer, data });
  assert.ok(g.calls.some(c => c.startsWith('claude mcp add --transport stdio --scope local gamesfun')));
  assert.ok(r.results[0].steps.every(s => s.cwd === path.resolve('elsewhere')));
  const d = fakeAgents();
  const dry = await connect({ agent: 'claude', dryRun: true, runner: d.runner, detected: d.detected, data });
  assert.equal(dry.results[0].plugin.status, 'would install');
  assert.ok(!d.calls.some(c => /plugin (install|marketplace (add|remove))/.test(c)), 'a dry run installs nothing');
});

test('the checkout is a plugin marketplace of one plugin, the one in plugin/', async () => {
  const m = JSON.parse(await readFile(new URL('../.claude-plugin/marketplace.json', import.meta.url), 'utf8'));
  const p = JSON.parse(await readFile(new URL('../plugin/.claude-plugin/plugin.json', import.meta.url), 'utf8'));
  assert.equal(m.name, claude.plugin.marketplace);
  assert.deepEqual(m.plugins.map(x => [x.name, x.source]), [[claude.plugin.name, './plugin']]);
  assert.equal(p.name, claude.plugin.name);
  // the play-tester's tools are this kit's MCP tools under the name connect registers the server with
  const agent = await readFile(new URL('../plugin/agents/playtester.md', import.meta.url), 'utf8');
  for (const t of agent.match(/^tools: (.*)$/m)[1].split(',').map(x => x.trim()).filter(x => x.startsWith('mcp__'))) assert.ok(t.startsWith(`mcp__${data.server.name}__gamesfun_`), t);
});

test('connect leaves an existing registration alone unless --replace, and --remove takes it out', async () => {
  const f = fakeAgents({ registered: { claude: 'gamesfun' } });
  let r = await connect({ agent: 'claude', runner: f.runner, detected: f.detected, listTools: okServer, data });
  assert.equal(r.results[0].status, 'already registered');
  assert.ok(!f.calls.some(c => c.includes(' mcp add ')));
  r = await connect({ agent: 'claude', replace: true, runner: f.runner, detected: f.detected, listTools: okServer, data });
  assert.equal(r.results[0].status, 'registered');
  assert.ok(f.calls.some(c => c.startsWith('claude mcp remove --scope user gamesfun')));
  r = await connect({ agent: 'claude', remove: true, runner: f.runner, detected: f.detected, data });
  assert.equal(r.results[0].status, 'removed');
  assert.equal(f.state.claude, undefined);
});

test('connect registers nothing when our server does not start', async () => {
  const f = fakeAgents();
  const r = await connect({ runner: f.runner, detected: f.detected, listTools: async () => ({ ok: false, error: 'Cannot find package', stderr: 'x' }), data });
  assert.equal(r.ok, false);
  assert.match(r.error, /did not start.*Nothing was registered/s);
  assert.deepEqual(f.calls, []);
});

test('connect reports a refused add, a missing agent, an unknown scope, and a dry run changes nothing', async () => {
  const f = fakeAgents({ addFails: true });
  let r = await connect({ agent: 'codex', runner: f.runner, detected: f.detected, listTools: okServer, data });
  assert.equal(r.ok, false);
  assert.match(r.results[0].note, /refused: boom/);
  r = await connect({ agent: 'codex', scope: 'project', runner: f.runner, detected: f.detected, listTools: okServer, data });
  assert.match(r.results[0].note, /no "project" scope/);
  assert.equal(r.ok, false);
  const h = fakeAgents();
  r = await connect({ scope: 'project', runner: h.runner, detected: h.detected, listTools: okServer, data });
  assert.deepEqual(r.results.map(x => x.status), ['registered', 'skipped'], 'an agent without that scope is skipped when no agent was named');
  assert.equal(r.ok, true);
  await assert.rejects(() => connect({ agent: 'zed', detected: f.detected, listTools: okServer, data }), /no agent "zed"/);
  const missing = f.detected.map(d => ({ ...d, found: false }));
  r = await connect({ runner: f.runner, detected: missing, listTools: okServer, data });
  assert.equal(r.ok, false);
  assert.match(r.error, /no coding agent found/);
  const g = fakeAgents();
  r = await connect({ runner: g.runner, detected: g.detected, data, dryRun: true });
  assert.equal(r.ok, true);
  assert.deepEqual(r.results.map(x => x.status), ['would register', 'would register']);
  assert.ok(!g.calls.some(c => / (add|remove) /.test(c)));
});

test('our MCP server starts and lists its tools (asked of the server itself)', async () => {
  const r = await listServerTools({ command: process.execPath, args: [SERVER_FILE] });
  assert.equal(r.ok, true, r.error);
  for (const t of ['gamesfun_catalog', 'gamesfun_create', 'gamesfun_verify', 'gamesfun_dev_start']) assert.ok(r.tools.includes(t), t);
  const bad = await listServerTools({ command: process.execPath, args: [path.join(path.dirname(SERVER_FILE), 'no-such.mjs')], timeoutMs: 5000 });
  assert.equal(bad.ok, false);
});

const probes = (over = {}) => ({
  deps: () => true, kits: true, git: '/usr/bin/git', chrome: { path: '/usr/bin/google-chrome', kind: 'chrome', source: 'installed' },
  gpu: async () => ({ ok: true, webgl: true, renderer: 'ANGLE (NVIDIA GeForce GTX 1080)', webgpu: true }),
  ports: [[5180, true], [5181, true]], writable: { games: null, state: null },
  detected: data.agents.map(row => ({ id: row.id, name: row.name, optional: true, found: false, path: null, row })),
  registered: async () => true, ...over,
});
const by = (r, id) => r.items.find(i => i.id === id);

test('doctor: a ready machine exits ok even with no agent; each fix is per system', async () => {
  const r = await runDoctor({ probes: probes(), data });
  assert.equal(r.ok, true);
  assert.equal(by(r, 'agent-claude').status, 'warn');
  assert.equal(by(r, 'graphics').status, 'ok');
  assert.match(formatDoctor(r), /Ready/);
});

test('doctor: only what blocks a first game fails (old Node, no packages, no write access)', async () => {
  const r = await runDoctor({ nodeVersion: 'v22.11.0', probes: probes({ deps: n => n !== 'playwright-core', writable: { games: 'EACCES', state: null } }), data });
  assert.equal(r.ok, false);
  assert.deepEqual(r.items.filter(i => i.status === 'fail').map(i => i.id), ['node', 'packages', 'write']);
  assert.match(by(r, 'node').fix.win32, /winget/);
  assert.match(by(r, 'node').fix.darwin, /brew/);
  assert.match(by(r, 'node').fix.linux, /nvm/);
  assert.equal(by(r, 'packages').fix.linux, 'npm ci');
  const text = formatDoctor(r, { system: 'win32' });
  assert.match(text, /FAIL Node/);
  assert.match(text, /fix: winget install OpenJS\.NodeJS/);
  assert.match(formatDoctor(r, { all: true }), /fix \(macOS\): brew install node@24/);
});

test('doctor: software graphics, no browser, busy ports and an unregistered agent are warnings', async () => {
  assert.ok(SOFTWARE_RENDERER.test('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)))'));
  assert.ok(SOFTWARE_RENDERER.test('llvmpipe (LLVM 15)'));
  assert.ok(!SOFTWARE_RENDERER.test('ANGLE (Apple, ANGLE Metal Renderer: Apple M2)'));
  const r = await runDoctor({ platform: 'win32', probes: probes({
    gpu: undefined, ports: [[5180, false], [5181, false]], chrome: null, playwright: { installed: false },
    detected: data.agents.map(row => ({ id: row.id, name: row.name, optional: true, found: true, path: 'C:\\x.exe', version: '1.0', row })), registered: async () => false,
  }), data });
  assert.equal(r.ok, true);
  assert.equal(by(r, 'graphics'), undefined, 'no browser, so no graphics probe');
  assert.equal(by(r, 'browser').status, 'warn');
  assert.match(by(r, 'browser').fix.win32, /winget install Google\.Chrome/);
  assert.equal(by(r, 'port').status, 'warn');
  assert.equal(by(r, 'agent-codex').status, 'warn');
  assert.match(by(r, 'agent-codex').fix.win32, /connect/);
  const g = await runDoctor({ probes: probes({ gpu: async () => ({ ok: true, webgl: true, renderer: 'llvmpipe (LLVM 15)' }) }), data });
  assert.equal(by(g, 'graphics').status, 'warn');
  assert.match(by(g, 'graphics').detail, /software/);
});

test('doctor: an installed but silent agent is a warning with its install command', async () => {
  const r = await runDoctor({ probes: probes({ detected: [{ id: 'codex', name: 'Codex', optional: true, found: true, path: '/x/codex', version: null, versionError: 'exit 1', row: codex }, { id: 'claude', name: 'Claude Code', optional: true, found: false, row: claude }] }), data });
  assert.equal(by(r, 'agent-codex').status, 'warn');
  assert.equal(by(r, 'agent-codex').fix.linux, 'npm install -g @openai/codex');
  assert.equal(r.ok, true);
});

test('update check switches: off by variable, in CI, in tests; daily; a clock set back', () => {
  const now = 1_000_000_000_000;
  assert.equal(checkAllowed({ env: {}, cache: null, now }), true);
  assert.equal(checkAllowed({ env: {}, cache: { checkedAt: now - 1000 }, now }), false);
  assert.equal(checkAllowed({ env: {}, cache: { checkedAt: now - DAY_MS }, now }), true);
  assert.equal(checkAllowed({ env: {}, cache: { checkedAt: now + 5000 }, now }), true);
  assert.equal(checkAllowed({ env: { GAMESFUN_NO_UPDATE_CHECK: '1' }, cache: null, now }), false);
  assert.equal(checkAllowed({ env: { GAMESFUN_NO_UPDATE_CHECK: '0' }, cache: null, now }), true);
  assert.equal(checkAllowed({ env: { CI: 'true' }, cache: null, now }), false);
  assert.equal(checkAllowed({ env: { NODE_TEST_CONTEXT: 'child-v8' }, cache: null, now }), false);
  assert.equal(noticeText(null), null);
  assert.equal(noticeText({ behind: 0 }), null);
  assert.match(noticeText({ behind: 3, upstream: 'origin/main' }), /3 new commits on origin\/main.*update.*GAMESFUN_NO_UPDATE_CHECK=1/);
});

test('the update check starts in the background and never waits', async () => {
  const spawned = [];
  const fake = (...a) => { spawned.push(a); return { on() {}, unref() {} }; };
  const tmp = await tempDir();
  const cacheFile = path.join(tmp.dir, 'update-check.json');
  const t0 = Date.now();
  await startUpdateCheck({ env: {}, spawnFn: fake, cacheFile });
  assert.ok(Date.now() - t0 < 500);
  assert.equal(spawned.length, 1);
  assert.deepEqual(spawned[0][1].slice(1), ['update', '--refresh-cache']);
  assert.equal(spawned[0][2].detached, true);
  assert.equal(spawned[0][2].stdio, 'ignore');
  await startUpdateCheck({ env: { GAMESFUN_NO_UPDATE_CHECK: '1' }, spawnFn: fake, cacheFile });
  assert.equal(spawned.length, 1);
  await writeFile(cacheFile, JSON.stringify({ checkedAt: Date.now(), behind: 2, upstream: 'origin/main' }));
  assert.match(await startUpdateCheck({ env: {}, spawnFn: fake, cacheFile }), /2 new commits/);
  assert.equal(spawned.length, 1, 'a fresh cache starts nothing');
  assert.equal(await startUpdateCheck({ env: { GAMESFUN_NO_UPDATE_CHECK: '1' }, spawnFn: fake, cacheFile }), null);
  await tmp.cleanup();
});

// Real git, no network: a bare "remote", two clones.
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim();
async function twoClones() {
  const t = await tempDir('gamesfun-update-');
  const remote = path.join(t.dir, 'remote.git'), a = path.join(t.dir, 'a'), b = path.join(t.dir, 'b');
  git(t.dir, 'init', '--bare', '-b', 'main', remote);
  git(t.dir, 'clone', '-q', remote, a);
  await writeFile(path.join(a, 'package.json'), '{"name":"x","version":"1.0.0","lockfileVersion":3}\n');
  await writeFile(path.join(a, 'package-lock.json'), JSON.stringify({ name: 'x', version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: 'x', version: '1.0.0' } } }));
  // the kit's own .gitattributes line: without it Git for Windows (core.autocrlf=true) checks one.txt out as '1\r\n'
  await writeFile(path.join(a, '.gitattributes'), '* text=auto eol=lf\n');
  await writeFile(path.join(a, 'one.txt'), '1\n');
  git(a, 'add', '.'); git(a, 'commit', '-qm', 'one'); git(a, 'push', '-q', '-u', 'origin', 'main');
  git(t.dir, 'clone', '-q', remote, b);
  return { ...t, a, b };
}

test('update: up to date, then a fast-forward, with npm ci only when the lockfile changed', async () => {
  const c = await twoClones();
  try {
    await mkdir(path.join(c.b, 'node_modules'), { recursive: true });
    let r = await updateKit({ cwd: c.b, install: false });
    assert.equal(r.status, 'up-to-date');
    await writeFile(path.join(c.a, 'two.txt'), '2\n'); git(c.a, 'add', '.'); git(c.a, 'commit', '-qm', 'two'); git(c.a, 'push', '-q');
    assert.equal((await kitState({ cwd: c.b })).behind, 1);
    r = await updateKit({ cwd: c.b, dryRun: true });
    assert.equal(r.status, 'would-update');
    assert.equal(await readFile(path.join(c.b, 'one.txt'), 'utf8'), '1\n');
    r = await updateKit({ cwd: c.b });
    assert.equal(r.status, 'updated');
    assert.equal(r.commits, 1);
    assert.equal(r.installed, false, 'the lockfile did not change');
  } finally { await c.cleanup(); }
});

test('update: refuses a diverged or a dirty checkout and changes nothing', async () => {
  const c = await twoClones();
  try {
    await writeFile(path.join(c.a, 'two.txt'), '2\n'); git(c.a, 'add', '.'); git(c.a, 'commit', '-qm', 'two'); git(c.a, 'push', '-q');
    await writeFile(path.join(c.b, 'one.txt'), 'mine\n');
    let r = await updateKit({ cwd: c.b, install: false });
    assert.equal(r.status, 'dirty');
    git(c.b, 'commit', '-aqm', 'mine');
    r = await updateKit({ cwd: c.b, install: false });
    assert.equal(r.status, 'diverged');
    assert.equal(await readFile(path.join(c.b, 'one.txt'), 'utf8'), 'mine\n');
    const none = await tempDir();
    r = await updateKit({ cwd: none.dir, install: false });
    assert.equal(r.status, 'cannot-check');
    await none.cleanup();
  } finally { await c.cleanup(); }
});

test('update: a changed lockfile runs npm ci', async () => {
  const c = await twoClones();
  try {
    await mkdir(path.join(c.b, 'node_modules'), { recursive: true });
    await writeFile(path.join(c.a, 'package-lock.json'), JSON.stringify({ name: 'x', version: '1.0.1', lockfileVersion: 3, requires: true, packages: { '': { name: 'x', version: '1.0.1' } } }));
    await writeFile(path.join(c.a, 'package.json'), '{"name":"x","version":"1.0.1","lockfileVersion":3}\n');
    git(c.a, 'commit', '-aqm', 'lock'); git(c.a, 'push', '-q');
    const r = await updateKit({ cwd: c.b });
    assert.equal(r.status, 'updated');
    assert.equal(r.ok, true, r.error);
    assert.equal(r.installed, true);
  } finally { await c.cleanup(); }
});

test('the one line is the same in README.md and docs/ONE-LINE.md, and every command in it exists', async () => {
  const fence = text => text.match(/```text\n([^\n]+)\n```/)?.[1];
  const readme = fence(await readFile(new URL('../README.md', import.meta.url), 'utf8'));
  const doc = fence(await readFile(new URL('../docs/ONE-LINE.md', import.meta.url), 'utf8'));
  assert.ok(readme && readme === doc, 'one line, identical in both files');
  for (const must of ['I want you to set up', 'git clone https://', 'npm ci', 'bin/gamesfun.mjs doctor', 'bin/gamesfun.mjs connect', 'bin/gamesfun.mjs dev in the background', 'docs/ONE-LINE.md', 'Never ask me for a password, token or key',
    // informed consent, in the person's words: what connect does and how to undo it
    'at user scope', 'studio page on 127.0.0.1', 'send them my requests and answer their permission prompts', 'connect --remove',
    // the first idea typed in the page reaches this session with nothing typed in the terminal (2026-10-12)
    'start node bin/gamesfun.mjs session wait in the background too', 'nothing needs a reload', 'End with the studio address']) assert.ok(doc.includes(must), must);
  assert.ok(!/reload-plugins|"next:"/.test(doc), 'the line ends on the studio, not on a command the person types');
  assert.ok(!/create games\/first|--from soak-squad|dev games\//.test(doc), 'the line makes no game: dev opens the start page, where the person describes theirs');
  assert.ok(!/claude\.ai|anthropic|logo/i.test(doc), 'no vendor name or logo in the line itself beyond what the README says in plain text');
  const { readdir } = await import('node:fs/promises');
  const files = await readdir(new URL('../builder/commands/', import.meta.url));
  for (const c of ['doctor', 'connect', 'update', 'create', 'dev']) assert.ok(files.includes(`${c}.mjs`), c);
  const guide = await readFile(new URL('../docs/ONE-LINE.md', import.meta.url), 'utf8');
  for (const step of ['### 1. Clone', '### 2. `npm ci`', '### 3.', '### 4.', '### 5. `node bin/gamesfun.mjs dev`', '### 6. `node bin/gamesfun.mjs session wait`']) assert.ok(guide.includes(step), step);
  for (const c of ['session', 'tool']) assert.ok(files.includes(`${c}.mjs`), c);
  assert.ok((guide.match(/^If it fails/gm) ?? []).length >= 4, 'each step says what to do when it fails');
});

test('docs/TRY-IT.md carries the same one line, every picture it shows is in the repository, and it has the eight things and the seven checks', async () => {
  const { existsSync } = await import('node:fs');
  const fence = text => text.match(/```text\n([^\n]+)\n```/)?.[1];
  const text = await readFile(new URL('../docs/TRY-IT.md', import.meta.url), 'utf8');
  assert.equal(fence(text), fence(await readFile(new URL('../README.md', import.meta.url), 'utf8')), 'the line a person pastes is README.md\'s, character for character');
  const pictures = [...text.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map(m => m[1]);
  assert.ok(pictures.length >= 8, 'it shows pictures');
  for (const p of pictures) assert.ok(existsSync(new URL(`../docs/${p}`, import.meta.url)), `docs/${p} is missing`);
  assert.equal((text.match(/^### \d\. /gm) ?? []).length, 8, 'eight things to try');
  assert.ok((text.match(/\*\*If it goes wrong, send us:\*\*/g) ?? []).length >= 7, 'each thing that can be tried says what to send');
  const seven = text.slice(text.indexOf('## Seven more checks'), text.indexOf('## What to send'));
  assert.equal((seven.match(/^\d\. \*\*/gm) ?? []).length, 7, 'the seven by-hand items of docs/CI.md section 8');
  for (const must of ['## Windows: what to install', '## Mac: what to install', 'session wait', 'giant-four', '**Status: the kit side is done; the server side is games.fun\'s.**', '(ONLINE.md)', 'GAMESFUN_ONLINE=off']) assert.ok(text.includes(must), must);
});

test('dev: the port and the browser can be set from the environment, and an option wins', async () => {
  const { devOptions } = await import('../builder/commands/dev.mjs');
  assert.deepEqual(devOptions({}, {}), { port: null, open: true });
  assert.deepEqual(devOptions({}, { GAMESFUN_DEV_PORT: '5927', GAMESFUN_NO_OPEN: '1' }), { port: 5927, open: false });
  assert.deepEqual(devOptions({ port: '5200' }, { GAMESFUN_DEV_PORT: '5927' }), { port: 5200, open: true });
  assert.deepEqual(devOptions({ 'no-open': true }, { GAMESFUN_DEV_PORT: 'x; rm' }), { port: null, open: false });
});
