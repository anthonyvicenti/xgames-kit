// "Connect Supabase", the one button (builder/lib/backend/supabase-connect.mjs on builder/lib/backend/flow.mjs), against stand-ins
// only: Supabase (tests/stubs/supabase-mock.mjs: OAuth consent, the Management API), games.fun's exchange route
// (tests/stubs/gamesfun-route-mock.mjs) and Claude Code and Codex (tests/stubs/fake-agents.mjs, on a PATH and HOME of
// their own). Nothing reaches supabase.com, games.fun or this machine's own agents.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { BIN, KIT_ROOT } from '../builder/lib/paths.mjs';
import { tempDir, tempGame } from './helpers.mjs';
import { fakeAgents } from './stubs/fake-agents.mjs';
import { startGamesfunRoute } from './stubs/gamesfun-route-mock.mjs';
import { startSupabaseMock } from './stubs/supabase-mock.mjs';
import { freePort } from './stubs/railway-mock.mjs';

const { startRun, FlowError } = await import('../builder/lib/backend/flow.mjs');
const C = await import('../builder/lib/backend/supabase-connect.mjs');
const mcp = await import('../builder/lib/backend/mcp.mjs');
const store = await import('../builder/lib/secret-store.mjs');

// the loopback callback in these tests (53841 is the real one; the creator's machine may use it): a free one of this
// run's own, drawn below the ephemeral range (a fixed 6081 was taken by another stream's server in a full run, and the
// sign-in timeout step read PORT_BUSY)
let PORT;
let supa, route, root, n = 0;
before(async () => {
  PORT = await freePort();
  root = await tempDir('gf-one-button-');
  supa = await startSupabaseMock({ readyAfter: 2 });
  route = await startGamesfunRoute({ supabase: supa, callbackPort: PORT });
});
after(async () => { await route?.close(); await supa?.close(); await root?.cleanup(); });

/** A fresh config folder and a stand-in world per test. */
async function world(t, extra = {}) {
  const cfg = await tempDir('gf-one-button-cfg-');
  t.after(() => cfg.cleanup());
  const game = await tempGame('soak-squad');
  t.after(() => game.cleanup());
  const agents = await fakeAgents(path.join(root.dir, `agents-${++n}`));
  const env = { ...process.env, ...agents.env, GAMESFUN_CONFIG_DIR: cfg.dir, GAMESFUN_SECRET_STORE: 'file', GAMESFUN_SUPABASE_API: supa.url, GAMESFUN_STUDIO_URL: route.url, GAMESFUN_BACKEND_CALLBACK_PORT: String(PORT), GAMESFUN_NO_OPEN: '1', ...extra };
  for (const k of ['GAMESFUN_BACKEND_CALLBACK_HOST', 'GAMESFUN_SUPABASE_BROKER', 'GAMESFUN_SUPABASE_CLIENT_ID', 'GAMESFUN_STUDIO']) if (!(k in extra)) delete env[k];
  return { env, dir: game.dir, cfg: cfg.dir, agents };
}
/** The person's browser: follows the start link, Supabase's (stand-in) consent and the redirect back. */
const browser = async url => { const r = await fetch(url); return { status: r.status, url: r.url, text: await r.text() }; };

/** Run the flow; `answer(q)` answers each question (undefined: leave it open). → the run's final state */
async function connect(w, { answer = () => undefined, opts = {}, onLink = browser, timeoutMs = 20000 } = {}) {
  const pages = [];
  const run = startRun(C.STEPS, h => C.connectSupabase(h, w.dir, { env: w.env, everyMs: 5, open: async url => { pages.push(await onLink(url)); }, ...opts }));
  const asked = [];
  const timer = setInterval(() => {
    const q = run.state.question;
    if (!q || asked.at(-1)?.id === q.id) return;
    asked.push(q);
    const a = answer(q, run);
    if (a !== undefined) run.answer(q.id, a);
  }, 5);
  const t = setTimeout(() => run.cancel(), timeoutMs);
  const state = await run.done;
  clearInterval(timer); clearTimeout(t);
  return { state, asked, pages };
}
const freshProjects = (...list) => { supa.state.projects.length = 0; supa.state.tables.clear(); supa.state.freeLimit = false; supa.state.refuseHosts.clear(); supa.state.deny = false; supa.state.migrationFail = null; return list.map(([n, r, s]) => supa.state.addProject(n, r ?? 'eu-central-1', s)); };
const step = (state, id) => state.steps.find(s => s.id === id);

test('one project: sign in through games.fun\'s route, its tables, backend.json, the check, both agents; Remove undoes exactly that', async t => {
  const w = await world(t);
  const [p] = freshProjects(['my-games']);
  const before = route.state.exchanges;
  const { state, pages, asked } = await connect(w);
  assert.equal(state.error, null, JSON.stringify(state.error));
  assert.deepEqual(state.steps.map(s => s.state), ['done', 'done', 'done', 'done', 'done', 'done', 'done', 'done', 'done'], JSON.stringify(state.steps));
  assert.match(pages[0].text, /Connected/);
  assert.match(pages[0].url, new RegExp(`^http://127\\.0\\.0\\.1:${PORT}/callback\\?`), 'the 127.0.0.1 loopback by default');
  assert.equal(route.state.exchanges, before + 1, 'the code was traded through games.fun\'s route');
  assert.deepEqual(asked.map(q => q.kind).filter(k => k !== 'signing-in'), [], 'one project: nothing to choose');
  // the sign-in remembers the route, so a refresh goes through it; nothing of it is in the game
  const tok = JSON.parse(store.getSecret('backend-supabase', { env: w.env }));
  assert.equal(tok.via, 'broker');
  assert.equal(tok.broker, `${route.url}/api/kit/supabase`);
  const r = state.result;
  assert.equal(r.project.ref, p.ref);
  assert.equal(r.dashboard, `https://supabase.com/dashboard/project/${p.ref}`);
  const cfg = JSON.parse(await readFile(path.join(w.dir, 'backend.json'), 'utf8'));
  assert.equal(cfg.url, `https://${p.ref}.supabase.co`);
  assert.match(cfg.key, /^sb_publishable_/);
  assert.equal(cfg.players, 'anonymous');
  assert.ok((await stat(path.join(w.dir, 'gf', 'backend', 'index.js'))).isFile());
  // tables: no spec needs → the high-score example, applied once with an idempotency key
  const mig = await readdir(path.join(w.dir, 'supabase', 'migrations'));
  assert.equal(mig.length, 1);
  assert.match(mig[0], /^\d{14}_high_scores\.sql$/);
  const applied = supa.state.migrations.filter(m => m.ref === p.ref);
  assert.equal(applied.length, 1);
  assert.match(applied[0].key, /^gamesfun-[0-9a-f]{32}$/);
  assert.deepEqual(supa.state.authConfig.get(p.ref), { external_anonymous_users_enabled: true });
  assert.equal(r.check.ok, true);
  assert.ok(supa.state.queries.some(q => q.ref === p.ref && q.readOnly), 'the live check ran read-only');
  // agents: Claude Code in the game's .mcp.json (project scope), Codex in its own config, both scoped to the project
  const url = `https://mcp.supabase.com/mcp?project_ref=${p.ref}`;
  assert.deepEqual(r.agents.map(a => [a.id, a.status, a.scope]), [['claude', 'added', 'project'], ['codex', 'added', 'user']]);
  const mcpJson = JSON.parse(await readFile(path.join(w.dir, '.mcp.json'), 'utf8'));
  assert.deepEqual(mcpJson.mcpServers.supabase, { type: 'http', url });
  assert.match(await readFile(path.join(w.agents.codexHome, 'config.toml'), 'utf8'), new RegExp(`\\[mcp_servers\\.supabase\\]\\nurl = "${url.replace(/[?.]/g, '\\$&')}"`));
  assert.equal((await mcp.added(w.dir)).length, 2);
  // Remove: exactly what was added
  const removed = await mcp.removeFromAgents(w.dir, { env: w.env });
  assert.deepEqual(removed.map(x => x.status), ['removed', 'removed']);
  await assert.rejects(stat(path.join(w.dir, '.mcp.json')), 'the .mcp.json the kit made is gone again');
  assert.doesNotMatch(await readFile(path.join(w.agents.codexHome, 'config.toml'), 'utf8'), /supabase/);
  assert.deepEqual(await mcp.added(w.dir), []);
});

test('an existing "supabase" entry is never replaced, and Remove leaves what it did not add', async t => {
  const w = await world(t);
  const [p] = freshProjects(['mine']);
  await writeFile(path.join(w.dir, '.mcp.json'), JSON.stringify({ mcpServers: { supabase: { type: 'http', url: 'https://mcp.supabase.com/mcp' } } }));
  const r = await mcp.addToAgents(w.dir, { projectRef: p.ref, env: w.env });
  const claude = r.find(x => x.id === 'claude');
  assert.equal(claude.status, 'already there');
  assert.match(claude.output, /already has a server named "supabase"; the kit left it as it is/);
  assert.equal(JSON.parse(await readFile(path.join(w.dir, '.mcp.json'), 'utf8')).mcpServers.supabase.url, 'https://mcp.supabase.com/mcp');
  // Codex had none: added, and only that is undone
  assert.equal(r.find(x => x.id === 'codex').status, 'added');
  const removed = await mcp.removeFromAgents(w.dir, { env: w.env });
  assert.deepEqual(removed.map(x => [x.id, x.status]), [['codex', 'removed']]);
  assert.equal(JSON.parse(await readFile(path.join(w.dir, '.mcp.json'), 'utf8')).mcpServers.supabase.url, 'https://mcp.supabase.com/mcp');
});

test('no project: "Make one" with the nearest region; the database password is kept, never shown; the clock runs until healthy', async t => {
  const w = await world(t);
  freshProjects();
  const { state, asked } = await connect(w, { answer: q => (q.kind === 'create' ? { name: q.defaults.name, organization: q.defaults.organization, region: q.defaults.region } : undefined), opts: { addToAgents: false } });
  assert.equal(state.error, null, JSON.stringify(state.error));
  const create = asked.find(q => q.kind === 'create');
  assert.match(create.title, /no Supabase project yet/);
  assert.equal(create.defaults.region, 'group:emea');
  assert.match(create.regions[0].label, /Nearest to you \(EMEA\)/);
  assert.match(create.defaults.name, /\(games\.fun\)$/);
  assert.deepEqual(supa.state.lastRegion, { type: 'smartGroup', code: 'emea' });
  const ref = state.result.project.ref;
  assert.equal(state.result.created, true);
  assert.equal(store.getSecret(`supabase-db-${ref}`, { env: w.env }), supa.state.lastDbPass, 'kept under the project\'s name');
  assert.equal(supa.state.lastDbPass.length, 43, '32 random bytes, base64url');
  assert.equal(store.getSecret(`supabase-db-pending-${path.basename(w.dir)}`, { env: w.env }), null, 'the pending name is gone');
  assert.ok(!JSON.stringify(state).includes(supa.state.lastDbPass), 'the password is not in what the page sees');
  assert.match(state.result.dbPassword, /npx gamesfun backend password/);
  assert.ok(step(state, 'ready').seconds !== null);
  assert.equal(step(state, 'agents').state, 'skipped');
});

test('several projects: a picker; a paused one offers Restore; a full free plan offers an existing project', async t => {
  const w = await world(t);
  const [a, , c] = freshProjects(['first'], ['second'], ['sleepy', 'us-east-1', 'INACTIVE']);
  // pick the paused one, restore it
  let r = await connect(w, { answer: q => (q.kind === 'project' ? { project: c.ref } : q.kind === 'paused' ? { restore: true } : undefined), opts: { addToAgents: false } });
  assert.equal(r.state.error, null, JSON.stringify(r.state.error));
  assert.deepEqual(r.asked.map(q => q.kind).filter(k => k !== 'signing-in'), ['project', 'paused']);
  assert.match(r.asked.find(q => q.kind === 'paused').title, /sleepy is paused .* Restore it\? It takes a few minutes\./);
  assert.ok(supa.state.requests.some(q => q.method === 'POST' && q.path === `/v1/projects/${c.ref}/restore`));
  assert.equal(r.state.result.project.ref, c.ref);
  // a full free plan (two active): "Make a new project" leads to the choice, which takes an existing one
  r = await connect(w, { answer: q => (q.kind === 'project' ? { create: true } : q.kind === 'full' ? { project: a.ref } : undefined), opts: { addToAgents: false } });
  assert.equal(r.state.error, null, JSON.stringify(r.state.error));
  const full = r.asked.find(q => q.kind === 'full');
  assert.match(full.title, /already has 2 active projects/);
  assert.ok(full.links.some(l => /\/org\/acme-games\/billing$/.test(l.url)));
  assert.equal(r.state.result.project.ref, a.ref);
  assert.deepEqual(r.asked.map(q => q.kind), ['project', 'full'], 'the saved sign-in was kept: no second sign-in');
  assert.equal(step(r.state, 'sign-in').state, 'skipped');
});

test('Supabase refusing the new project (the free limit) shows its words and the same choices', async t => {
  const w = await world(t);
  freshProjects(['one'], ['two']);
  supa.state.plan = 'pro';            // the kit's count does not see it; Supabase refuses anyway
  supa.state.freeLimit = true;
  t.after(() => { supa.state.plan = 'free'; supa.state.freeLimit = false; });
  const r = await connect(w, { answer: q => (q.kind === 'project' ? { create: true } : q.kind === 'create' ? q.defaults : q.kind === 'full' ? { project: q.projects[1].ref } : undefined), opts: { addToAgents: false } });
  assert.equal(r.state.error, null, JSON.stringify(r.state.error));
  assert.match(r.asked.find(q => q.kind === 'full').title, /^Supabase did not make the project: The following organization members have reached their maximum limits/);
});

test('games.fun\'s route not set up (503) or missing (404): the agent way, in words', async t => {
  const w = await world(t);
  freshProjects(['x']);
  route.state.mode = 'off';
  t.after(() => { route.state.mode = 'ready'; });
  let r = await connect(w);
  assert.equal(r.state.error.code, 'NOT_SET_UP');
  assert.equal(r.state.error.fallback, 'agent');
  assert.match(r.state.error.message, /^One-button Supabase is not set up on 127\.0\.0\.1:\d+ yet\. You can connect through your agent instead/);
  assert.equal(step(r.state, 'app').state, 'failed');
  route.state.mode = 'missing';
  r = await connect(w);
  assert.equal(r.state.error.code, 'NOT_OFFERED');
  assert.match(r.state.error.message, /does not offer one-button Supabase yet/);
});

test('refused consent, a cancel, a busy port, a closed network: each is a sentence and nothing is changed', async t => {
  const w = await world(t);
  freshProjects(['x']);
  supa.state.deny = true;
  let r = await connect(w);
  supa.state.deny = false;
  assert.equal(r.state.error.code, 'DENIED');
  assert.equal(r.state.error.message, 'You didn\'t allow games.fun to reach your Supabase account. Nothing was changed.');
  await assert.rejects(stat(path.join(w.dir, 'backend.json')));
  // the person presses Cancel while the sign-in tab is open
  r = await connect(w, { onLink: async () => null, answer: q => (q.kind === 'signing-in' ? { cancel: true } : undefined) });
  assert.equal(r.state.error.code, 'CANCELLED');
  assert.match(r.state.error.message, /You stopped the sign-in\. Nothing was changed\./);
  // the port is taken
  const busy = http.createServer().listen(PORT, '127.0.0.1');
  await new Promise(res => busy.once('listening', res));
  r = await connect(w);
  await new Promise(res => busy.close(res));
  assert.equal(r.state.error.code, 'PORT_BUSY');
  assert.equal(r.state.error.message, `Something on this computer is using port ${PORT}. Close it and press Connect again.`);
  // games.fun cannot be reached
  r = await connect({ ...w, env: { ...w.env, GAMESFUN_STUDIO_URL: 'http://127.0.0.1:9' } });
  assert.equal(r.state.error.code, 'NETWORK');
  assert.equal(r.state.error.message, 'Could not reach 127.0.0.1:9. Check your internet connection, then press Connect again.');
  // a sign-in never finished
  r = await connect({ ...w }, { onLink: async () => null, opts: { signInTimeoutMs: 300 } });
  assert.equal(r.state.error.code, 'TIMEOUT');
  assert.equal(r.state.error.message, 'The sign-in wasn\'t finished. Press Connect again.');
});

test('Supabase refusing 127.0.0.1: the kit asks with localhost; "try localhost" from the page does the same', async t => {
  const w = await world(t);
  freshProjects(['x']);
  supa.state.refuseHosts.add('127.0.0.1');
  t.after(() => supa.state.refuseHosts.clear());
  let r = await connect(w, { opts: { addToAgents: false } });
  assert.equal(r.state.error, null, JSON.stringify(r.state.error));
  assert.match(r.pages[0].url, new RegExp(`^http://localhost:${PORT}/callback\\?`));
  // the page's way: the first tab shows Supabase's error; the person presses "Try localhost"
  supa.state.refuseHosts.clear();
  const w2 = await world(t);
  let tries = 0;
  r = await connect(w2, {
    onLink: async url => { tries++; return tries === 1 ? null : browser(url); },
    answer: q => (q.kind === 'signing-in' && q.host === '127.0.0.1' ? { host: q.other } : undefined),
    opts: { addToAgents: false },
  });
  assert.equal(r.state.error, null, JSON.stringify(r.state.error));
  assert.equal(tries, 2);
  assert.match(r.pages[1].url, new RegExp(`^http://localhost:${PORT}/callback\\?`));
});

test('the spec\'s needs pick the tables; a refused migration names its file; a table already there is kept', async t => {
  const w = await world(t);
  const [p] = freshProjects(['x']);
  const spec = JSON.parse(await readFile(path.join(w.dir, 'spec.json'), 'utf8'));
  await writeFile(path.join(w.dir, 'spec.json'), JSON.stringify({ ...spec, backend: { kind: 'database', provider: 'supabase', needs: ['leaderboard', 'saves'] } }, null, 2));
  supa.state.migrationFail = 'ERROR:  42601: syntax error at or near "tabel"';
  let r = await connect(w, { opts: { addToAgents: false } });
  assert.equal(r.state.error.code, 'MIGRATION');
  assert.match(r.state.error.message, /^Supabase refused supabase\/migrations\/\d{14}_high_scores\.sql: ERROR: {2}42601: syntax error/);
  supa.state.migrationFail = null;
  r = await connect(w, { opts: { addToAgents: false } });
  assert.equal(r.state.error, null, JSON.stringify(r.state.error));
  assert.deepEqual(r.state.result.tables.map(x => [x.file.split('/').pop().replace(/^\d+_/, ''), x.status]), [['high_scores.sql', 'applied'], ['progress.sql', 'applied']]);
  assert.match(r.state.result.tables.map(x => x.file).join(), /high_scores\.sql.*progress\.sql/);
  // connecting again: the same files are not applied twice (the key), and the board is still one table
  const n = supa.state.migrations.filter(m => m.ref === p.ref).length;
  r = await connect(w, { opts: { addToAgents: false } });
  assert.equal(r.state.error, null);
  assert.equal(supa.state.migrations.filter(m => m.ref === p.ref).length, n);
});

test('a game holding a secret is refused before anything reaches Supabase', async t => {
  const w = await world(t);
  freshProjects(['x']);
  await writeFile(path.join(w.dir, '.env'), 'X=1\n');
  const n = supa.state.requests.length;
  const r = await connect(w);
  assert.equal(r.state.error.code, 'SECRET');
  assert.equal(supa.state.requests.length, n);
});

// ---------------------------------------------------------------- the terminal: the same module
const cli = (args, env) => new Promise(resolve => {
  const child = spawn(process.execPath, [BIN, ...args], { cwd: KIT_ROOT, env: { ...env, GAMESFUN_NO_UPDATE_CHECK: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', opened = false;
  child.stdout.on('data', d => { stdout += d; });
  child.stderr.on('data', d => {
    stderr += d;
    // the person's browser: the link the command printed
    const m = /(http:\/\/(?:127\.0\.0\.1|localhost):\d+\/start)/.exec(stderr + stdout);
    if (m && !opened) { opened = true; browser(m[1]).catch(() => {}); }
  });
  child.stdout.on('data', () => {
    const m = /(http:\/\/(?:127\.0\.0\.1|localhost):\d+\/start)/.exec(stdout);
    if (m && !opened) { opened = true; browser(m[1]).catch(() => {}); }
  });
  child.on('close', code => resolve({ code, stdout, stderr }));
});

test('gamesfun backend connect supabase runs the same flow in the terminal', async t => {
  const w = await world(t);
  const [p, q] = freshProjects(['alpha'], ['beta']);
  // several projects and no terminal to ask in: it says what to pass, after signing in
  let r = await cli(['backend', 'connect', 'supabase', w.dir, '--no-agents'], w.env);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Which Supabase project should this game use\?/);
  assert.match(r.stdout, new RegExp(`${p.ref}\\s+alpha`));
  assert.match(r.stdout, /--project <ref>/);
  // with --project: the rest of the steps, and backend.json
  r = await cli(['backend', 'connect', 'supabase', w.dir, '--project', q.ref, '--json'], w.env);
  assert.equal(r.code, 0, r.stderr + r.stdout);
  const out = JSON.parse(r.stdout);
  assert.equal(out.result.project.ref, q.ref);
  assert.deepEqual(out.steps.map(s => s.state), ['skipped', 'skipped', 'done', 'done', 'done', 'done', 'done', 'done', 'done']);
  assert.deepEqual(out.result.agents.map(a => a.status), ['added', 'added']);
  assert.equal(JSON.parse(await readFile(path.join(w.dir, 'backend.json'), 'utf8')).project.ref, q.ref);
  // the agent way stays one flag away, and a route that is not set up points to it
  r = await cli(['backend', 'connect', 'supabase', '--agent', '--json'], w.env);
  assert.equal(JSON.parse(r.stdout).way, 'mcp');
  route.state.mode = 'off';
  t.after(() => { route.state.mode = 'ready'; });
  r = await cli(['backend', 'connect', 'supabase', w.dir, '--sign-in'], w.env);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /One-button Supabase is not set up on/);
  assert.match(r.stderr, /claude mcp add/);
  // agents: Remove from the terminal too
  r = await cli(['backend', 'agents', w.dir, '--remove'], w.env);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Claude Code: removed/);
});

test('the flow\'s machinery: a question answered, a wrong answer id ignored, a cancel ends a wait', async () => {
  const run = startRun([['a', 'A']], async h => { h.start('a'); const x = await h.ask({ kind: 'k' }); h.done('a', String(x)); return x; });
  await new Promise(r => setTimeout(r, 5));
  assert.equal(run.answer('nope', 1), false);
  assert.equal(run.answer(run.state.question.id, 7), true);
  assert.equal((await run.done).result, 7);
  const run2 = startRun([['a', 'A']], async h => { h.start('a'); await h.ask({ kind: 'k' }); });
  await new Promise(r => setTimeout(r, 5));
  run2.cancel();
  const s = await run2.done;
  assert.equal(s.error.code, 'CANCELLED');
  assert.equal(s.steps[0].state, 'failed');
  assert.ok(new FlowError('X', 'y') instanceof Error);
});
