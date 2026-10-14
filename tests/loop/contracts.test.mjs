// What the loop writes, held to the contracts stream's schemas (staging/contracts; in xgames-kit: builder/ and registry/).
// Skipped, with the reason said, when the contracts are not beside this folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dryRun } from './dryrun/dry-run.mjs';
import { goodLedger, PROMPT } from './fixtures/registry.mjs';

const LOADER = fileURLToPath(new URL('../../registry/schemas.mjs', import.meta.url));
const skip = existsSync(LOADER) ? false : 'the contracts are not beside the loop folder (staging/contracts)';

test('the ledger, the ladder, the promise ledger, the verdicts and the specs match the contracts', { skip }, async () => {
  const { loadSchemas, SCHEMA } = await import(LOADER);
  const { validate } = await loadSchemas();
  const ok = (id, data, what) => assert.deepEqual(validate(id, data), [], what);
  ok(SCHEMA.ledger, { schema: 'gf-ledger/1', prompt: PROMPT, ...goodLedger() }, 'the fixture ledger');
  const r = await dryRun({ quiet: true, write: false });
  const a = r.artifacts;
  ok(SCHEMA.ledger, a.ledger, 'the ledger at the end of the dry run');
  ok(SCHEMA.ledger, a.pitchLedger, 'the ledger the pitch carries, with its foundation');
  for (const [i, l] of a.ladders.entries()) ok(SCHEMA.ladder, l, `ladder ${i}`);
  ok(SCHEMA.promises, a.promiseLedger, 'the promise ledger of the last delivery');
  for (const [i, v] of a.verdicts.entries()) ok(SCHEMA.verdict, v, `verdict ${i}`);
  for (const [i, s] of a.specs.entries()) ok(SCHEMA.spec, s, `spec ${i}`);
});
