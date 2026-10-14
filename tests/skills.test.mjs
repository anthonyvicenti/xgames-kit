// skills/ is the source of truth; .claude/skills/ and .agents/skills/ must mirror it byte for byte.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { diffMirror, MIRRORS, skillProblems, SOURCE } from '../scripts/sync-skills.mjs';

test('the core skills exist with valid front matter', async () => {
  for (const s of ['make-a-game', 'swap-assets', 'multiplayer', 'verify-and-playtest']) assert.ok(existsSync(path.join(SOURCE, s, 'SKILL.md')), s);
  assert.deepEqual(await skillProblems(), []);
});

for (const mirror of MIRRORS) {
  test(`${path.basename(path.dirname(mirror))}/skills mirrors skills/ (run node scripts/sync-skills.mjs on drift)`, async () => {
    assert.deepEqual(await diffMirror(mirror), { missing: [], changed: [], extra: [] });
  });
}
