// The first prompt from a fresh clone, with nothing reloaded (a first run from a fresh clone: the page's idea reached
// a session whose tools were not loaded; it would not build without them, and the stop hook re-sent the idea three
// times). What is held here, with no model:
//   - the terminal listener (`gamesfun session wait`) needs no plugin and no MCP tools: it ends with the request and
//     the words to build it with the kit's commands, and `session report` reports it;
//   - `gamesfun tool <name>` runs any MCP tool with the same answer;
//   - every message a session gets says the terminal is a full substitute, and none tells it to wait for a reload;
//   - a listener and a plugin's wait of the same session stand side by side; the page's target is a session that is
//     reachable; the session's tools are told apart (MCP or terminal) from what it does.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createBridge, requestMessage, listenerMessage, cliWords, LOOP_TOOL } from '../builder/bridge/core.mjs';
import { listen, sessionIdentity } from '../builder/bridge/client.mjs';
import { protocolWords } from '../plugin/scripts/lib.mjs';
import { BIN, KIT_ROOT } from '../builder/lib/paths.mjs';
import { startDevServer } from '../builder/server/index.mjs';
import { bridgeFor } from '../builder/server/routes/session.mjs';
import { tempGame, tempDir } from './helpers.mjs';

const GAME = path.resolve('/games/one');
const waitHandle = form => { const h = { form, got: [], ended: false, send: o => h.got.push(o), end: () => { h.ended = true; } }; return h; };
const mk = (o = {}) => createBridge({ gameDir: GAME, kitRoot: '/kit', readLoop: async () => null, ...o });

// ---- the state -----------------------------------------------------------------------------------------------------

test('a terminal listener reaches a session with no plugin: it takes the request, ends, and the session is not "working" on nothing', async () => {
  const b = mk();
  const before = b.addRequest({ text: 'a dance game' });
  assert.equal(before.session, null, 'nobody listens yet: the request waits for the first session that does');
  const l = waitHandle('listener');
  b.openWait('S1', l, { cwd: '/kit', agent: 'claude-code' });
  assert.equal(l.got.length, 1, 'the waiting idea is handed the moment the listener opens');
  assert.equal(l.ended, true, 'the listener ends with it (its process exits, which wakes the session)');
  const msg = l.got[0];
  assert.equal(msg.type, 'requests');
  assert.match(msg.text, /GF_REQUEST \{"id":"r_.*","text":"a dance game"\}/);
  assert.match(msg.text, /node "\/kit\/bin\/gamesfun\.mjs" tool <name>/);
  assert.match(msg.text, /session report <id>/);
  assert.match(msg.text, /session wait again in the background/);
  assert.doesNotMatch(msg.text, /reload-plugins|restart your|catalog/i);
  const q = await b.queue();
  assert.equal(q.requests[0].state, 'handed');
  assert.equal(q.requests[0].via, 'listener');
  assert.equal(q.sessions[0].channel, 'terminal');
  assert.equal(q.sessions[0].connected, false);
  // the session runs the kit's commands: the page follows them and knows it builds without the MCP tools
  b.event('tool-start', { session: 'S1', via: 'cli', tool: 'gamesfun_step_pitch', input: { game: 'games/dance' } });
  let s = (await b.queue()).sessions[0];
  assert.equal(s.tools, 'cli');
  assert.equal(s.game, path.resolve('/kit', 'games/dance'), 'the bare tool name counts as a loop tool: the stop guard follows that game');
  assert.equal(s.channel, 'terminal', 'a terminal command is not the plugin');
  assert.equal((await b.queue()).requests[0].state, 'seen');
  assert.equal(b.reportRequest(before.id, { note: 'Made Dance Off' }).state, 'done');
  // a new request while its listener is closed waits; the next listener picks it up
  const next = b.addRequest({ text: 'faster beat' });
  assert.equal(next.state, 'waiting');
  const l2 = waitHandle('listener');
  b.openWait('S1', l2, { cwd: '/kit' });
  assert.equal(l2.got[0].requests[0].text, 'faster beat');
});

test('a listener and a plugin wait of one session stand side by side: the plugin\'s takes it, the listener stays; a newer listener replaces the older', async () => {
  const b = mk();
  b.event('session-start', { session: 'S', cwd: '/kit' });
  const l = waitHandle('listener');
  b.openWait('S', l, { cwd: '/kit' });
  const w = waitHandle('rewake');
  b.openWait('S', w, { cwd: '/kit' });
  assert.equal(l.ended, false, 'the plugin\'s wait did not replace the listener');
  b.addRequest({ text: 'x' });
  assert.equal(w.got.length, 1, 'the plugin\'s wait delivers (the hooks follow the turn)');
  assert.equal(l.got.length, 0);
  assert.equal((await b.queue()).sessions[0].listening, 'listener', 'still reachable through the listener');
  const l2 = waitHandle('listener');
  b.openWait('S', l2, { cwd: '/kit' });
  assert.deepEqual(l.got, [{ type: 'superseded' }]);
  assert.equal(l.ended, true);
  assert.throws(() => b.openWait(null, waitHandle('listener'), { cwd: '/kit' }), /names its session/);
});

test('which tools a session builds with is read from what it does', async () => {
  const b = mk();
  b.event('session-start', { session: 'A', cwd: '/kit' });
  b.event('tool-start', { session: 'A', tool: 'Bash', input: { command: 'node bin/gamesfun.mjs tool gamesfun_next --game games/x' } });
  assert.equal((await b.queue()).sessions[0].tools, 'cli');
  b.event('tool-start', { session: 'A', tool: 'mcp__gamesfun__gamesfun_next', input: { game: 'games/x' } });
  assert.equal((await b.queue()).sessions[0].tools, 'mcp');
  b.event('tool-start', { session: 'A', tool: 'Bash', input: { command: 'node bin/gamesfun.mjs session report r_1 "x"' } });
  assert.equal((await b.queue()).sessions[0].tools, 'mcp', 'once the tools are seen, they are there');
  assert.equal((await b.queue()).sessions[0].channel, 'plugin');
  assert.ok(LOOP_TOOL.test('gamesfun_step_fix') && LOOP_TOOL.test('mcp__gamesfun__gamesfun_next') && !LOOP_TOOL.test('gamesfun_catalog'));
});

test('every message a session gets says the terminal is a full substitute, and none says to wait for a reload or to stay in the catalog', () => {
  const r = [{ id: 'r1', text: 'Make a game where users dance by pressing X on the beat' }];
  for (const text of [requestMessage(r, { session: 'S', kit: '/kit' }), listenerMessage(r, { session: 'S', kit: '/kit' }), protocolWords('http://127.0.0.1:5180/', 'S', { kit: '/kit' }), cliWords('/kit')]) {
    assert.match(text, /tool <name> '<arguments as JSON>'/);
    assert.match(text, /session report <id>/);
    assert.doesNotMatch(text, /type \/reload-plugins|restart the session|only what the catalog|closest ready/i);
  }
  assert.match(cliWords('/kit'), /do not wait for them/);
  assert.match(protocolWords('http://x/', 'S'), /do not ask the person to reload or restart/);
});

test('sessionIdentity: the agent\'s own id when it gives its shells one, else one per kit folder', () => {
  assert.deepEqual(sessionIdentity({ CLAUDE_CODE_SESSION_ID: 'abc' }), { id: 'abc', agent: 'claude-code' });
  assert.deepEqual(sessionIdentity({ GAMESFUN_SESSION: 'mine', GAMESFUN_AGENT: 'codex' }), { id: 'mine', agent: 'codex' });
  const a = sessionIdentity({}, '/a/kit'), b = sessionIdentity({}, '/b/kit');
  assert.match(a.id, /^term-[0-9a-f]{8}$/);
  assert.notEqual(a.id, b.id);
  assert.equal(sessionIdentity({}, '/a/kit').id, a.id, 'the same folder is the same session: a listener started again is not a new one');
  assert.equal(a.agent, 'terminal');
});

// ---- the commands against a real dev server --------------------------------------------------------------------------

let game, srv, runDir, env;
before(async () => {
  game = await tempGame();
  srv = await startDevServer({ gameDir: game.dir, port: 0, log: () => {}, watch: false });
  // a run file of this server alone, so a test running beside this one cannot answer for it
  runDir = await tempDir();
  const live = bridgeFor(srv.url);
  const file = path.join(runDir.dir, 'bridge.json');
  await writeFile(file, JSON.stringify({ schema: 'gf-bridge/1', runs: [{ url: srv.url, token: live.token, run: live.bridge.run, pid: process.pid, game: game.dir, wait: 'rewake', started: Date.now(), kit: KIT_ROOT }] }));
  env = { ...process.env, GAMESFUN_BRIDGE_FILE: file, GAMESFUN_SESSION: 'cli-test-1', GAMESFUN_AGENT: 'claude-code', GAMESFUN_NO_UPDATE_CHECK: '1' };
  for (const k of ['CLAUDE_CODE_SESSION_ID', 'CLAUDECODE']) delete env[k];
});
after(async () => { await bridgeFor(srv.url)?.close(); await srv?.close(); await game?.cleanup(); await runDir?.cleanup(); });

function cli(args, { input } = {}) {
  return new Promise(resolve => {
    const c = spawn(process.execPath, [BIN, ...args], { cwd: game.dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    c.stdout.on('data', d => { stdout += d; });
    c.stderr.on('data', d => { stderr += d; });
    c.on('close', code => resolve({ code, stdout, stderr }));
    if (input) input(c);
  });
}
const page = async (method, p, body) => {
  const live = bridgeFor(srv.url);
  const r = await fetch(new URL(`/api/session/${p}`, srv.url), { method, headers: { 'x-gamesfun-token': live.token, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return r.json();
};
const until = async (fn, ms = 30000) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error('timed out'); await new Promise(r => setTimeout(r, 50)); } };

test('session wait → the page sends the idea → the listener exits 0 with it → tool runs a loop tool → session report: done on the page', async () => {
  const waiting = cli(['session', 'wait']);
  await until(async () => (await page('GET', 'queue')).sessions.find(s => s.id === 'cli-test-1' && s.connected));
  let q = await page('GET', 'queue');
  assert.equal(q.sessions.find(s => s.id === 'cli-test-1').listening, 'listener');
  const sent = await page('POST', 'request', { text: 'Make a game where users can dance by pressing the X key at the perfect time.' });
  assert.equal(sent.state, 'handed', 'the page is told the truth: handed, because a listener was open');
  const out = await waiting;
  assert.equal(out.code, 0);
  assert.match(out.stdout, /GF_REQUEST \{"id":"r_[^"]+","text":"Make a game where users can dance/);
  assert.match(out.stdout, /session report <id>/);
  assert.match(out.stdout, /session wait again/);
  // the session builds through the terminal: any tool, the same answer; the page sees the step
  const next = await cli(['tool', 'gamesfun_next', '--game', 'games/dance-x']);
  assert.equal(next.code, 0, next.stderr);
  assert.equal(JSON.parse(next.stdout).tool, 'gamesfun_step_ledger');
  q = await page('GET', 'queue');
  const me = q.sessions.find(s => s.id === 'cli-test-1');
  assert.equal(me.tools, 'cli');
  assert.equal(q.requests.find(r => r.id === sent.id).state, 'seen');
  const bad = await cli(['tool', 'gamesfun_nope']);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /no tool gamesfun_nope/);
  assert.equal((await cli(['tool', 'gamesfun_next', '{not json'])).code, 2);
  // report: the note is what the person reads
  const rep = await cli(['session', 'report', sent.id, 'Made Dance Off: press X on the beat']);
  assert.equal(rep.code, 0, rep.stderr);
  assert.match(rep.stdout, /reported r_.*: done/);
  assert.match(rep.stdout, /start node bin\/gamesfun\.mjs session wait in the background/, 'not listening any more: it says how to listen again');
  const done = (await page('GET', 'queue')).requests.find(r => r.id === sent.id);
  assert.equal(done.state, 'done');
  assert.equal(done.note, 'Made Dance Off: press X on the beat');
  const st = await cli(['session', 'status']);
  assert.match(st.stdout, /cli-test-1 \(this one\)/);
});

test('session report refuses "done" while the game\'s build is not delivered (the same rule as the tool), and --dropped always works', async () => {
  const r = await page('POST', 'request', { text: 'add a boss' });
  await mkdir(path.join(game.dir, '.gf-loop'), { recursive: true });
  await writeFile(path.join(game.dir, '.gf-loop', 'state.json'), JSON.stringify({ schema: 'gf-loop/1', kind: 'build', status: 'building', step: 'verify', why: 'w', history: [] }));
  const early = await cli(['session', 'report', r.id, 'added']);
  assert.equal(early.code, 1);
  assert.match(early.stderr, /not delivered yet/);
  const no = await cli(['session', 'report', r.id, '--dropped', 'not this round']);
  assert.equal(no.code, 0, no.stderr);
  const got = (await page('GET', 'queue')).requests.find(x => x.id === r.id);
  assert.deepEqual([got.state, got.note], ['dropped', 'not this round']);
  await rm(path.join(game.dir, '.gf-loop'), { recursive: true, force: true });
});

test('a listener started before the studio waits for it; --max ends it plainly', async () => {
  const said = [];
  const r = await listen({ maxMs: 300, pollMs: 50, find: async () => null, onWaiting: m => said.push(m) });
  assert.deepEqual(r, { type: 'timeout' });
  assert.match(said[0], /the studio is not running yet; waiting for it/);
  const cmd = await cli(['session', 'wait', '--max', '1']);
  assert.equal(cmd.code, 0);
  assert.match(cmd.stdout, /nothing from the page in 1 s/);
});

test('the person\'s own prompt brings back a request the stop hook went quiet about, once', async () => {
  const live = bridgeFor(srv.url);
  const hook = (ev, extra) => fetch(new URL(`/api/session/hook/${ev}`, srv.url), { method: 'POST', headers: { 'x-gamesfun-token': live.token, 'content-type': 'application/json' }, body: JSON.stringify({ session_id: 'P1', cwd: game.dir, hook_event_name: ev, ...extra }) }).then(async r => { const t = await r.text(); return t ? JSON.parse(t) : null; });
  await hook('SessionStart', { source: 'startup' });
  const r = await page('POST', 'request', { text: 'bigger dance floor', session: 'P1' });
  await page('GET', `requests?session=P1`);   // handed (by the tool), not reported
  assert.equal((await hook('Stop', {}))?.decision, 'block', 'one reminder');
  assert.equal((await hook('Stop', {}))?.decision, undefined, 'then quiet');
  assert.equal((await page('GET', 'queue')).requests.find(x => x.id === r.id).stalled, true);
  const back = await hook('UserPromptSubmit', { prompt: 'go' });
  assert.match(back.hookSpecificOutput.additionalContext, /Still open from the studio page[\s\S]*bigger dance floor/);
  assert.equal((await hook('UserPromptSubmit', { prompt: 'go' })), null, 'once');
  await hook('SessionEnd', { reason: 'exit' });
});
