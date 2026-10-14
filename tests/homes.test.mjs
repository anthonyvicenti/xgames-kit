// Where every rule lives (builder/tools/lib/homes.json): every verify check has one home with its rule and fix, and
// every prompt rule of the build brief (builder/loop/brief.mjs RULES, at most five) its home and what enforces it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { checkHomes, currentRules, lineHash, loadHomes } from '../builder/tools/lib/homes.mjs';
import { RULES } from '../builder/loop/brief.mjs';

test('every check and every prompt rule has its home; every rule names what enforces it; the rules keep their budget', async () => {
  const r = checkHomes(loadHomes(), await currentRules());
  assert.deepEqual(r.problems, []);
  assert.equal(r.summary.ruleCount, RULES.length);
  assert.ok(r.summary.ruleCount <= 5);
  assert.ok(r.lines.every(l => l.enforcedBy.length > 0));
  assert.equal(existsSync(new URL('../builder/spec/prompts/build.md', import.meta.url)), false, 'the old prompt is gone: the brief is composed per round');
});

test('a reworded rule needs a new home, a rule with no enforcer is refused, a sixth rule passes the budget', () => {
  const homes = loadHomes();
  let r = checkHomes(homes, [...RULES.slice(0, 4), `${RULES[4]} Also be kind.`]);
  assert.ok(r.problems.some(p => /rule 5 .* has no home/.test(p)) && r.problems.some(p => /tags a rule that is no longer/.test(p)), r.problems.join('\n'));
  const bare = structuredClone(homes);
  bare.rules.list[2].enforcedBy = [];
  r = checkHomes(bare, RULES);
  assert.ok(r.problems.some(p => /rule 3 .* names no enforcer/.test(p)));
  const six = 'Always add a tutorial.';
  const more = structuredClone(homes);
  more.rules.list.push({ hash: lineHash(six), starts: six, home: 'invariant', enforcedBy: ['nothing real'] });
  r = checkHomes(more, [...RULES, six]);
  assert.ok(r.problems.some(p => /6 prompt rules; the budget is 5/.test(p)));
});
