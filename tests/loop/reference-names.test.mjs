// A game this one is made like is never named where players read it: the spec's title, hook, round, rules, controls
// and characters are held to it when the spec is locked, the play target too (T1 run 1, 2026-10-14, locked "PeeVPee
// Brawl"; publish would have refused the game only after the whole build). The person's words keep the name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { namedInShown } from '../../builder/loop/pitch.mjs';
import { checkTarget } from '../../builder/play/design.mjs';

const ledger = { rows: [{ id: 'reference', about: 'reference', words: 'a game like PeeVPee', what: 'A crude party game', home: 'exists' }] };

test('the spec: a reference name in the title or the hook is a problem; in the prompt it is the person\'s words', () => {
  const p = namedInShown({ prompt: 'a game like PeeVPee where you pee on your friends', title: 'PeeVPee Brawl', hook: 'Soak your friends.' }, ledger);
  assert.equal(p.length, 1);
  assert.match(p[0], /^\$\.title: "PeeVPee" names PeeVPee/);
  assert.deepEqual(namedInShown({ prompt: 'a game like PeeVPee', title: 'Puddle Brawl', hook: 'Soak your friends.' }, ledger), []);
  assert.equal(namedInShown({ title: 'Pee V Pee Party' }, ledger).length, 1, 'spacing does not hide it');
});

test('the spec: a multi-word name\'s first word alone is an ordinary word (a worm game may say worm)', () => {
  const l = { rows: [{ id: 'r', about: 'reference', words: 'the same asethetic as worms ultmate mayhem that lets people battle for an NFT', what: 'x', home: 'exists' }] };
  assert.deepEqual(namedInShown({ title: 'Worm Island Warfare', hook: 'Your squad of cartoon worms…' }, l), []);
  assert.equal(namedInShown({ title: 'Worms Ultimate Mayhem Party' }, l).length, 1);
});

test('the play target: a name read out of the ledger\'s words is a problem', async () => {
  const p = await checkTarget({ genre: { name: 'a PeeVPee-style brawl' }, avoid: [{ failure: 'idle' }, { failure: 'unreachable' }], events: [{ name: 'soak', meaningful: true }] }, { spec: { ledger } });
  assert.ok(p.some(x => /names "PeeVPee"/.test(x)), p.join('\n'));
});
