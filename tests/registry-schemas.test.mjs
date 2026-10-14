// Every schema compiles, and every example beside it is judged as its name says: valid-*.json passes, invalid-*.json
// fails with the message its folder's expect.json names (so it fails for the reason it was written for).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { loadSchemas, schemaFiles, ROOT } from '../registry/schemas.mjs';

const { ajv, validate } = await loadSchemas();
const json = async f => JSON.parse(await readFile(f, 'utf8'));

test('every schema compiles', async () => {
  for (const f of await schemaFiles()) {
    const s = await json(join(ROOT, f));
    assert.doesNotThrow(() => ajv.getSchema(s.$id), f);
    assert.ok(ajv.getSchema(s.$id), `${f} compiles`);
  }
});

// common holds definitions only, and catalog is checked against the catalog the registry builds (tests/catalog.test.mjs).
const NO_EXAMPLES = new Set(['common', 'catalog']);

for (const f of await schemaFiles()) {
  const name = basename(f, '.schema.json');
  if (NO_EXAMPLES.has(name)) continue;
  const dir = join(ROOT, dirname(f), 'examples', name);
  test(`${name}: 2+ valid and 1+ invalid examples, each judged as named`, async () => {
    assert.ok(existsSync(dir), `${f} has examples in ${join(dirname(f), 'examples', name)}`);
    const id = (await json(join(ROOT, f))).$id;
    const files = (await readdir(dir)).filter(x => x.endsWith('.json') && x !== 'expect.json');
    const valid = files.filter(x => x.startsWith('valid-')), invalid = files.filter(x => x.startsWith('invalid-'));
    assert.ok(valid.length >= 2, `${name}: ${valid.length} valid examples`);
    assert.ok(invalid.length >= 1, `${name}: ${invalid.length} invalid examples`);
    const expect = existsSync(join(dir, 'expect.json')) ? await json(join(dir, 'expect.json')) : {};
    for (const x of valid) assert.deepEqual(validate(id, await json(join(dir, x))), [], `${name}/${x} is valid`);
    for (const x of invalid) {
      const problems = validate(id, await json(join(dir, x)));
      assert.ok(problems.length, `${name}/${x} is invalid`);
      assert.ok(expect[x], `${name}/expect.json names why ${x} fails`);
      assert.ok(problems.some(p => p.includes(expect[x])), `${name}/${x} fails for "${expect[x]}", got:\n  ${problems.join('\n  ')}`);
    }
  });
}
