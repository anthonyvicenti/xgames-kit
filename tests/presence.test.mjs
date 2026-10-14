// Seeing a friend with no character (the creator, 2026-10-14: "You can fix seeing your friend default"): the shape a
// game's friends get (gf/mp/presence.js), the state each copy sends, what create writes, the ledger that stops asking
// what a friend looks like, the spec held to the ledger's body line, and the friends promise.
// The browser half (two players over WebRTC) is verify measure 5's presence leg and the regressions
// board-friend-unseen, own-board-unseen, table-four-friends-seen and lights-race-friends-seen (builder/gates).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { heldBy, shapeOf, createPresence, clean, SEES, MESSAGE } from '../builder/gf-multiplayer/source/presence.js';
import { shapeOfSpec } from '../builder/tools/lib/presence.mjs';
import { createRegistry } from '../registry/build-catalog.mjs';
import { checkLedger } from '../builder/loop/ledger.mjs';
import { checkSpec, friendsShapeOf } from '../builder/loop/pitch.mjs';
import { promisesOf } from '../builder/loop/promises.mjs';
import { playtestBrief } from '../builder/loop/playtest.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const json = async rel => JSON.parse(await readFile(path.join(ROOT, rel), 'utf8'));
const registry = createRegistry(await json('registry/catalog.json'));
const boardMan = { params: { properties: { presence: { default: 'walk' }, boards: { default: 'shared' } } }, holds: [{ when: { presence: 'cursor' }, as: 'mark' }, { when: { boards: 'own' }, as: 'board' }] };
const of = id => (id === 'board' ? boardMan : null);

test('the shape comes from how friends play and the parts that hold the players, never from one game', () => {
  const board = params => heldBy([{ id: 'board', params }], of);
  assert.equal(shapeOf({ together: 'turns', held: board({}) }), 'character', 'a board walked on: characters');
  assert.equal(shapeOf({ together: 'turns', held: board({ presence: 'cursor' }) }), 'seats');
  assert.equal(shapeOf({ together: 'own-board', held: board({ boards: 'own' }) }), 'boards');
  assert.equal(shapeOf({ together: 'versus', held: board({ boards: 'own' }) }), 'boards', 'a board of your own is boards whatever together says');
  assert.equal(shapeOf({ together: 'own-board', held: [] }), 'character', 'own-board alone never makes a shape: the loop writes presence when nobody is a character');
  assert.equal(shapeOf({ together: 'own-board', presence: 'boards', held: [] }), 'boards', 'a game whose own code holds the players says it');
  assert.equal(shapeOf({ together: 'solo', held: board({ presence: 'cursor' }) }), null);
  assert.deepEqual(heldBy([{ id: 'tag', params: {} }, { id: 'board', params: { presence: 'cursor' } }], of), ['mark']);
});

test('each copy sends its own player, only on change and at most rate a second; a friend\'s arrives clean', () => {
  const sent = []; let t = 0;
  const P = createPresence({ shape: 'boards', me: () => 'p1', send: (type, d) => sent.push([type, d]), now: () => t, rate: 10 });
  P.set({ pointer: [2, 3], moves: 1, last: [2, 3], board: { cols: 2, rows: 2, g: 'a...' } });
  P.frame(0.016); P.frame(0.016);
  assert.equal(sent.length, 1); assert.equal(sent[0][0], MESSAGE);
  P.set({ pointer: [1, 1] }); P.frame(0.02);
  assert.equal(sent.length, 1, 'not again within a tenth of a second');
  P.frame(0.1); assert.equal(sent.length, 2);
  P.frame(0.2); assert.equal(sent.length, 2, 'nothing changed: nothing sent');
  P.receive({ pointer: [99, 0], mood: 'shouting', moves: 3, board: { cols: 2, rows: 2, g: 'bad' }, x: 1 }, 'p2');
  const f = P.of('p2');
  assert.equal(f.pointer, null, 'a cell off any board is dropped');
  assert.equal(f.mood, 'waiting', 'an unknown mood is waiting');
  assert.equal(f.board, null, 'a board whose cells do not fit is dropped');
  assert.equal(f.moves, 3);
  assert.deepEqual(P.ids().sort(), ['p1', 'p2']);
  assert.equal(P.of('p1').mine, true);
  assert.deepEqual(clean({ last: [1, 2], score: 4 }), { last: [1, 2], score: 4 });
});

test('the examples: Table Four is seats, Lights Race is boards, Giant Four is characters', async () => {
  for (const [id, want] of [['table-four', 'seats'], ['lights-race', 'boards'], ['giant-four', 'character']]) {
    const r = await shapeOfSpec(await json(`examples/minimal/${id}/spec.json`));
    assert.equal(r.shape, want, id);
    assert.equal(r.sees, SEES[want]);
  }
});

const ledgerOf = (body, words, together = 'turns') => ({
  rows: [
    { id: 'drop', about: 'action', what: 'Drop a disc into a column', words: 'four in a row', home: 'exists', by: 'mechanic:board', core: true },
    { id: 'acts', about: 'acts', what: 'Players take turns', words: 'four in a row', acts: 'one-at-a-time', home: 'exists' },
    { id: 'view', about: 'perspective', what: 'Seen from above', words: 'four in a row', camera: 'top', dimension: '3d', home: 'exists' },
    { id: 'friends', about: 'players', what: 'Friends play each other', words: 'with a friend', together, home: 'exists' },
    { id: 'body', about: 'body', what: 'Each player plays from their seat', words, body, home: 'exists' },
  ],
  asks: [],
});
const PROMPT = 'four in a row with a friend';

test('the ledger stops asking what a friend looks like when the shape answers it, and still asks when it is unclear', async () => {
  const check = l => checkLedger(l, { sources: [PROMPT], registry });
  const looks = ledgerOf('board', 'four in a row');
  looks.rows[4].asked = true;
  looks.asks = [{ about: 'body', text: 'How should your friend appear?', options: [{ id: 'board', label: 'A seat card' }, { id: 'cursor', label: 'A pointer' }], default: 'board' }];
  assert.ok((await check(looks)).some(p => /asks\[0\]: the person's words make the players no characters .*never a question/.test(p)), 'a question about how a friend looks is refused');
  const unclear = ledgerOf('board', 'four in a row');
  unclear.rows[4].asked = true;
  unclear.asks = [{ about: 'body', text: 'Walk on the board, or play it from your seat?', options: [{ id: 'character', label: 'Walk on it' }, { id: 'board', label: 'From my seat' }], default: 'board' }];
  assert.ok(!(await check(unclear)).some(p => /never a question/.test(p)), 'whether the players are characters at all may still be asked');
  const silent = ledgerOf('board', null);
  silent.rows[4].asked = true;
  silent.asks = [{ about: 'body', text: 'How do you play?', options: [{ id: 'board', label: 'Seat' }, { id: 'cursor', label: 'Pointer' }], default: 'board' }];
  assert.ok(!(await check(silent)).some(p => /never a question/.test(p)), 'words that say nothing: the line is truly open');
});

test('a spec shows friends as the ledger\'s body line says', async () => {
  const foundation = { runtime: 'three', profile: 'standard-3d', loop: 'turns', kind: 'silly', why: { runtime: '-', loop: '-', kind: '-' } };
  const spec = await json('examples/minimal/table-four/spec.json');
  const presence = async (s, l) => (await checkSpec(s, { ledger: l, foundation, registry })).filter(p => /presence|own board|characters/.test(p));
  assert.deepEqual(await presence(spec, ledgerOf('cursor', 'four in a row')), [], 'a board played from the seats: seats');
  const walked = structuredClone(spec); walked.mechanics[0].params.presence = 'walk';
  assert.ok((await presence(walked, ledgerOf('cursor', 'four in a row'))).some(p => /multiplayer\.presence: .*no characters .*set "seats"/.test(p)), 'no character in the ledger, characters in the spec: refused with the fix');
  const own = structuredClone(spec); own.multiplayer.together = 'own-board';
  assert.ok((await presence(own, ledgerOf('board', 'four in a row', 'own-board'))).some(p => /friends are seen as boards/.test(p)));
  assert.ok((await presence(spec, ledgerOf('character', null))).some(p => /makes the players characters/.test(p)));
  assert.equal(await friendsShapeOf(spec, registry), 'seats');
  assert.equal(await friendsShapeOf(await json('examples/minimal/lights-race/spec.json'), registry), 'boards');
});

test('a friends promise says what each screen shows when nobody is a character, and the tester is told', async () => {
  const spec = await json('examples/minimal/lights-race/spec.json');
  const ledger = ledgerOf('board', 'four in a row', 'own-board');
  const list = promisesOf({ spec, ledger, friends: 'boards' });
  const p = list.find(x => x.id === 'row.friends');
  assert.equal(p.friends, true); assert.equal(p.sees, 'boards');
  assert.match(p.text, /Nobody is a character here, so on each screen each friend's own board is drawn live beside yours/);
  const brief = playtestBrief({ promises: list, focus: [p.id], game: 'games/x', reportHow: 'report' });
  assert.match(brief, /Nobody is a character in this game, so seeing your friend means: their own board drawn live beside yours/);
  assert.ok(!promisesOf({ spec, ledger, friends: 'character' }).find(x => x.id === 'row.friends').sees);
});
