// The studio with no game open (the start page), a game opened while the server runs, a new idea's folder followed
// until the build loop makes it a game, the conversation's words, and connect's record of having run.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { buildRunning, gameReady, startDevServer } from '../builder/server/index.mjs';
import { freeName, slugOf } from '../builder/server/routes/studio.mjs';
import { createGame } from '../builder/lib/create.mjs';
import { tempDir } from './helpers.mjs';
import { recordConnected } from '../builder/commands/connect.mjs';
import { MARK, STAGES, choiceRequest, compose, ideaRequest, stageOf, wordsOf } from '../builder/studio/chat.js';
import * as ORDER_MOD from '../builder/loop/order.mjs';

const root = await tempDir();
after(() => root.cleanup());
const games = path.join(root.dir, 'games');
await mkdir(games, { recursive: true });
const srv = await startDevServer({ gamesRoot: games, port: 0, log: () => {}, watch: false });
after(() => srv.close());
const base = `http://127.0.0.1:${srv.port}`;
const call = async (p, body) => {
  const r = await fetch(base + p, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};

test('no game open: the start page has nothing to play, and every game route says what to do', async () => {
  assert.deepEqual((await call('/api/studio/project')).body, { project: null });
  const info = await call('/api/game/info');
  assert.equal(info.status, 409);
  assert.match(info.body.error, /No game is open yet: pick one on the studio's start page, or describe a new one there/);
  assert.equal((await fetch(`${base}/game/`)).status, 404, 'no game page is served');
  const b = await call('/api/build/state');
  assert.equal(b.body.none, true); assert.equal(b.body.loop, null); assert.equal(b.body.made, false);
  const home = (await call('/api/studio/home')).body;
  assert.deepEqual(home.games, []);
  assert.ok(home.examples.some(e => e.id === 'soak-squad'), 'the examples are offered');
  assert.equal(typeof home.setup.connected, 'boolean');
  for (const f of ['index.html', 'studio.js', 'chat.js', 'start.js', 'studio.css']) assert.equal((await fetch(`${base}/studio/${f}`)).status, 200, f);
});

test('a new idea: a folder name from its words, opened before anything is written; the conversation follows the loop; the game appears once made', async () => {
  const r = await call('/api/studio/new', { idea: 'A pillow fight in a backyard, with my friends!' });
  assert.equal(r.status, 200);
  assert.equal(r.body.name, 'pillow-fight-backyard-friends');
  assert.deepEqual([r.body.project.name, r.body.project.made], ['pillow-fight-backyard-friends', false]);
  assert.equal(existsSync(path.join(games, r.body.name)), false, 'nothing is written: the build loop makes the folder');
  const { bridgeFor } = await import('../builder/server/routes/session.mjs');
  assert.equal(bridgeFor(srv.url).bridge.game, path.join(games, r.body.name), 'the bridge follows the open game (the stop guard reads its loop)');
  // the loop's talk: the idea and the cards (in the loop's state, gf-loop/2) are what the conversation shows
  const loopDir = path.join(games, r.body.name, '.gf-loop');
  await mkdir(loopDir, { recursive: true });
  await writeFile(path.join(loopDir, 'state.json'), JSON.stringify({ schema: 'gf-loop/2', kind: 'build', status: 'waiting-on-creator', step: 'pitch', waiting: { about: 'cards' }, prompt: 'A pillow fight in a backyard, with my friends!', history: [],
    pitch: { reply: 'Two takes.', cards: [{ id: 'a', title: 'Pillow Brawl', take: 'Swing.', v1: { has: ['one yard'], build: [], notYet: [] }, spec: { hook: 'Bop your friends.', secret: 'not sent to the page' } }], questions: [{ about: 'players', text: 'How long?', default: 'short', options: [{ id: 'short', label: '90 s' }, { id: 'long', label: '3 min' }] }] } }));
  let b = (await call('/api/build/state')).body;
  assert.equal(b.made, false);
  assert.equal(b.idea, 'A pillow fight in a backyard, with my friends!');
  assert.deepEqual(b.pitch.cards.map(c => c.title), ['Pillow Brawl']);
  assert.equal(b.pitch.cards[0].spec, undefined, 'a card is cut to what the page shows');
  assert.equal(b.pitch.cards[0].hook, 'Bop your friends.');
  assert.deepEqual(b.pitch.questions[0].options.map(o => o.label), ['90 s', '3 min']);
  assert.equal((await call('/api/studio/home')).body.games[0].made, false, 'a folder being pitched is listed on the start page');
  // create made the folder a game: the page opens it
  await createGame(path.join(games, r.body.name), { from: 'soak-squad', force: true });
  await writeFile(path.join(loopDir, 'state.json'), JSON.stringify({ schema: 'gf-loop/2', kind: 'build', status: 'delivered', step: 'done', prompt: 'A pillow fight in a backyard, with my friends!', history: [] }));
  b = (await call('/api/build/state')).body;
  assert.equal(b.made, true);
  assert.equal((await call('/api/game/info')).body.name, r.body.name);
  assert.equal((await fetch(`${base}/game/`)).status, 200, 'the game page is served now');
});

test('opening and closing a game; names are checked; an example is copied into games/ and opened', async () => {
  assert.equal((await call('/api/studio/project', { name: '../etc' })).status, 400);
  assert.equal((await call('/api/studio/project', { name: 'nope' })).status, 404);
  assert.deepEqual((await call('/api/studio/project', { name: null })).body, { project: null });
  assert.equal((await call('/api/game/info')).status, 409);
  const ex = await call('/api/studio/example', { example: 'soak-squad' });
  assert.equal(ex.status, 200, JSON.stringify(ex.body));
  assert.equal(ex.body.name, 'soak-squad');
  assert.equal(ex.body.project.made, true);
  assert.equal((await call('/api/game/info')).body.name, 'soak-squad');
  assert.equal((await call('/api/studio/example', { example: 'no-such' })).status, 400);
  const home = (await call('/api/studio/home')).body;
  assert.deepEqual(home.games.map(g => [g.name, g.made]).sort(), [['pillow-fight-backyard-friends', true], ['soak-squad', true]]);
});

test('folder names: the words that matter, and the next free one', async () => {
  assert.equal(slugOf('I want a game where we race boats on a lake'), 'race-boats-lake');
  assert.equal(slugOf('!!!'), 'new-game');
  assert.equal(slugOf('Ünïcödé café'), 'unicode-cafe');
  await mkdir(path.join(games, 'boats'), { recursive: true });
  assert.equal(freeName(games, 'boats'), 'boats-2');
});

test('the conversation\'s words: the person\'s words first, the line for their session after the mark', () => {
  const text = ideaRequest('a pillow fight', 'games/pillow-fight');
  assert.equal(wordsOf(text), 'a pillow fight');
  assert.ok(text.includes(MARK));
  assert.match(text, /gamesfun_step_ledger \{"game": "games\/pillow-fight"/);
  const pick = choiceRequest({ id: 'b', title: 'Feather Frenzy' }, [{ id: 'len', option: 'long', question: 'How long?', answer: '3 min' }], 'games/pillow-fight');
  assert.equal(wordsOf(pick), 'Let\'s make "Feather Frenzy". How long? 3 min');
  assert.match(pick, /chose card "b".*len = long/s);
  assert.equal(compose('hi', ''), 'hi');
});

test('the stages a person follows, from the loop state (gf-loop/2: every step has a stage)', () => {
  assert.deepEqual(STAGES.map(s => s.label), ['Ledger', 'Foundation', 'Pitch', 'Spec', 'Build', 'Gates', 'Play-test', 'Reader', 'Deliver']);
  assert.equal(stageOf(null).index, -1, 'no loop (an example): no stages shown');
  assert.deepEqual(stageOf({ status: 'building', step: 'ledger' }), { index: 0, waiting: false, done: false });
  assert.deepEqual(stageOf({ status: 'waiting-on-creator', step: 'pitch', waiting: { about: 'cards' } }), { index: 2, waiting: true, done: false });
  assert.deepEqual(stageOf({ status: 'waiting-on-creator', step: 'foundation', waiting: { about: 'migration' } }), { index: 1, waiting: true, done: false });
  assert.equal(stageOf({ status: 'building', step: 'repair' }).index, 4);
  for (const step of ['economy', 'backend', 'verify']) assert.equal(stageOf({ status: 'building', step }).index, 5);
  assert.equal(stageOf({ status: 'building', step: 'read' }).index, 7);
  assert.deepEqual(stageOf({ status: 'delivered', step: 'done' }), { index: 8, waiting: false, done: true });
  const { ORDER } = ORDER_MOD;
  for (const o of ORDER) assert.ok(STAGES.some(s => s.steps.includes(o.step)), `the step ${o.step} has a stage`);
});

test('connect leaves a record the studio reads (the one step left), and --remove takes it away', async () => {
  const dir = path.join(root.dir, 'state');
  const ok = { results: [{ id: 'claude', name: 'Claude Code', status: 'registered', plugin: { status: 'installed' } }, { id: 'codex', name: 'Codex', status: 'not installed' }] };
  const v = await recordConnected(ok, { dir });
  assert.deepEqual([v.connected, v.plugin, v.agents.map(a => a.id)], [true, true, ['claude']]);
  assert.equal(JSON.parse(await readFile(path.join(dir, 'connected.json'), 'utf8')).plugin, true);
  assert.equal(await recordConnected({ results: [{ id: 'claude', status: 'failed' }] }, { dir: path.join(root.dir, 'none') }), null, 'nothing is recorded when nothing was added');
  await recordConnected(ok, { dir, remove: true });
  assert.equal(existsSync(path.join(dir, 'connected.json')), false);
  await rm(dir, { recursive: true, force: true });
});

test('a game the build loop is still making on its first build is not shown; a change to a delivered game is', async () => {
  const t = await tempDir();
  try {
    const dir = path.join(t.dir, 'g');
    await createGame(dir, { from: 'soak-squad' });
    assert.equal(gameReady(dir), true, 'a game with no loop (an example the person picked, a game made by hand) is shown');
    await mkdir(path.join(dir, '.gf-loop'), { recursive: true });
    const state = (kind, status) => writeFile(path.join(dir, '.gf-loop', 'state.json'), JSON.stringify({ schema: 'gf-loop/1', kind, status, step: 'verify' }));
    for (const [kind, status, shown] of [['build', 'building', false], ['build', 'waiting-on-creator', false], ['build', 'delivered', true], ['build', 'failed', true], ['change', 'building', true], ['pitch', 'waiting-on-creator', true]]) {
      await state(kind, status);
      assert.equal(gameReady(dir), shown, `${kind} ${status}`);
      assert.equal(buildRunning(dir), !shown, `${kind} ${status}`);
    }
  } finally { await t.cleanup(); }
});
