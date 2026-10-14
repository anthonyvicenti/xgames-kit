// connect run in a checkout makes that checkout the one in use. A fresh clone once said "already
// registered" and "already installed" for an MCP server, marketplace and plugin added from an earlier /tmp clone, and left
// them there. Here Claude Code and Codex are stand-ins on a PATH and HOME of their own (tests/stubs/fake-connect-agents.mjs):
// this machine's agents and their settings are never touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { detectAll, loadAgents } from '../builder/lib/agents.mjs';
import { connect, SERVER_FILE } from '../builder/lib/connect.mjs';
import { KIT_ROOT } from '../builder/lib/paths.mjs';
import { movedLine } from '../builder/commands/connect.mjs';
import { tempDir } from './helpers.mjs';
import { fakeConnectAgents } from './stubs/fake-connect-agents.mjs';

const data = loadAgents();
const okServer = async () => ({ ok: true, tools: ['gamesfun_catalog'] });
const skip = process.platform === 'win32' && 'the stand-ins are #! scripts';

/** A folder that looks like another kit checkout: its CLI, its MCP server, and a marketplace of one plugin. */
async function otherKit(dir) {
  for (const f of ['bin/gamesfun.mjs', 'builder/mcp/server.mjs', 'plugin/.claude-plugin/plugin.json']) { await mkdir(path.dirname(path.join(dir, f)), { recursive: true }); await writeFile(path.join(dir, f), '{}\n'); }
  await mkdir(path.join(dir, '.claude-plugin'), { recursive: true });
  await writeFile(path.join(dir, '.claude-plugin', 'marketplace.json'), await readFile(path.join(KIT_ROOT, '.claude-plugin', 'marketplace.json')));
  return dir;
}
/** Register everything from `kit` the way an earlier connect there did, through the stand-ins' own commands. */
function registerFrom(kit, a) {
  const run = (bin, args) => execFileSync(path.join(a.bin, bin), args, { env: a.env, cwd: a.home, stdio: 'pipe' });
  run('claude', ['mcp', 'add', '--transport', 'stdio', '--scope', 'user', 'gamesfun', '--', process.execPath, path.join(kit, 'builder', 'mcp', 'server.mjs')]);
  run('codex', ['mcp', 'add', 'gamesfun', '--', process.execPath, path.join(kit, 'builder', 'mcp', 'server.mjs')]);
  run('claude', ['plugin', 'marketplace', 'add', kit, '--scope', 'user']);
  run('claude', ['plugin', 'install', 'gamesfun@gamesfun-kit', '--scope', 'user']);
}
const ask = (a, bin, args) => execFileSync(path.join(a.bin, bin), args, { env: a.env, cwd: a.home, encoding: 'utf8' });
const mutating = log => log.split('\n').filter(Boolean).map(l => JSON.parse(l).args.join(' ')).filter(c => / (add|remove|install|uninstall) /.test(` ${c} `));

test('connect re-points a server, marketplace and plugin registered from another live checkout, and says how to switch back', { skip }, async t => {
  const tmp = await tempDir('gamesfun-repoint-'); t.after(tmp.cleanup);
  const a = await fakeConnectAgents(tmp.dir);
  const old = await otherKit(path.join(tmp.dir, 'old clone', 'gamesfun-kit'));
  registerFrom(old, a);
  const detected = await detectAll(data, { env: a.env });
  assert.deepEqual(detected.filter(d => d.found).map(d => d.id).sort(), ['claude', 'codex'], 'the stand-ins, never this machine\'s agents');

  const r = await connect({ env: a.env, detected, listTools: okServer, data });
  assert.equal(r.ok, true, JSON.stringify(r, null, 1));
  const [claude, codex] = ['claude', 'codex'].map(id => r.results.find(x => x.id === id));
  assert.equal(claude.status, 'registered');
  assert.equal(claude.plugin.status, 'installed');
  assert.deepEqual(claude.moved.map(m => [m.what, m.from, m.to, m.live]), [
    ['MCP server', old, KIT_ROOT, true], ['marketplace gamesfun-kit', old, KIT_ROOT, true], ['plugin gamesfun@gamesfun-kit', old, KIT_ROOT, true]]);
  assert.equal(codex.status, 'registered');
  assert.deepEqual(codex.moved.map(m => [m.what, m.from, m.to]), [['MCP server', old, KIT_ROOT]]);
  // the agents' own lists now name this checkout
  assert.match(ask(a, 'claude', ['mcp', 'get', 'gamesfun']), new RegExp(`Args: ${SERVER_FILE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
  assert.match(ask(a, 'codex', ['mcp', 'get', 'gamesfun']), new RegExp(`args: ${SERVER_FILE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
  assert.equal(JSON.parse(ask(a, 'claude', ['plugin', 'marketplace', 'list', '--json']))[0].path, KIT_ROOT);
  assert.equal(JSON.parse(ask(a, 'claude', ['plugin', 'list', '--json']))[0].readFromFolder, path.join(KIT_ROOT, 'plugin'));
  // one line each: the old folder, the new one, and how to switch back
  const line = movedLine(claude.moved[0]);
  assert.ok(line.includes(old) && line.includes(KIT_ROOT) && /run connect in that folder to switch back/.test(line), line);

  // a second run here has nothing to move and changes nothing
  await rm(a.log, { force: true });
  const again = await connect({ env: a.env, detected, listTools: okServer, data });
  assert.deepEqual(again.results.map(x => [x.id, x.status, x.moved.length]), [['claude', 'already registered', 0], ['codex', 'already registered', 0]]);
  assert.equal(again.results[0].plugin.status, 'already installed');
  assert.deepEqual(mutating(await readFile(a.log, 'utf8').catch(() => '')), []);

  // --replace still registers again from here; --remove still takes everything out
  const rep = await connect({ env: a.env, detected, listTools: okServer, data, replace: true });
  assert.deepEqual(rep.results.map(x => [x.status, x.moved.length]), [['registered', 0], ['registered', 0]]);
  const gone = await connect({ env: a.env, detected, data, remove: true });
  assert.deepEqual(gone.results.map(x => x.status), ['removed', 'removed']);
  assert.equal(gone.results[0].plugin.status, 'removed');
  assert.deepEqual(JSON.parse(ask(a, 'claude', ['plugin', 'marketplace', 'list', '--json'])), []);
});

test('a registration from a deleted clone is re-pointed too, and the line says that folder is gone', { skip }, async t => {
  const tmp = await tempDir('gamesfun-repoint-'); t.after(tmp.cleanup);
  const a = await fakeConnectAgents(tmp.dir);
  const old = await otherKit(path.join(tmp.dir, 'gamesfun-kit-proof'));
  registerFrom(old, a);
  await rm(old, { recursive: true, force: true });
  const detected = await detectAll(data, { env: a.env });
  const r = await connect({ agent: 'claude', env: a.env, detected, listTools: okServer, data });
  const c = r.results[0];
  assert.equal(c.status, 'registered');
  assert.equal(c.plugin.status, 'installed');
  assert.deepEqual(c.moved.map(m => [m.what, m.from, m.live]), [['MCP server', old, false], ['marketplace gamesfun-kit', old, false], ['plugin gamesfun@gamesfun-kit', old, false]]);
  assert.match(movedLine(c.moved[1]), /no longer holds a kit/);
  assert.match(movedLine(c.moved[1], { dryRun: true }), /^would move: /);
  assert.equal(JSON.parse(ask(a, 'claude', ['plugin', 'list', '--json']))[0].readFromFolder, path.join(KIT_ROOT, 'plugin'));
});

test('a dry run names what it would move and changes nothing', { skip }, async t => {
  const tmp = await tempDir('gamesfun-repoint-'); t.after(tmp.cleanup);
  const a = await fakeConnectAgents(tmp.dir);
  const old = await otherKit(path.join(tmp.dir, 'old'));
  registerFrom(old, a);
  await rm(a.log, { force: true });
  const detected = await detectAll(data, { env: a.env });
  const r = await connect({ env: a.env, detected, data, dryRun: true });
  assert.deepEqual(r.results.map(x => [x.status, x.moved.length]), [['would register', 3], ['would register', 1]]);
  assert.deepEqual(mutating(await readFile(a.log, 'utf8')), []);
  assert.match(ask(a, 'claude', ['mcp', 'get', 'gamesfun']), new RegExp(`Args: ${path.join(old, 'builder', 'mcp', 'server.mjs').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
});
