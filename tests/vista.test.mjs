// The vista runtime as the CLI shows it, with no browser: open by its registry manifest (no switch in the environment),
// its desktop-only limit said plainly, and its example listed like any other. Its verify needs a hardware WebGPU
// adapter, so it runs by hand or in the smoke test (docs/CI.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { catalogLines, registry, SECTIONS } from '../builder/lib/catalog.mjs';
import { listExamples, resolveExample } from '../builder/lib/examples.mjs';
import { EXAMPLES } from '../builder/lib/paths.mjs';

test('vista is open by its registry manifest; the catalog says it plays on a desktop only', async () => {
  assert.ok(SECTIONS.includes('runtimes') && !SECTIONS.includes('engines'));
  const reg = await registry();
  assert.equal(reg.runtimes.find(r => r.id === 'vista').state.open, true);
  const lines = catalogLines(reg, ['runtimes']);
  const i = lines.findIndex(l => /^\s+vista\s/.test(l));
  assert.match(lines[i], /\[open\]/);
  assert.match(lines.slice(i, i + 4).join('\n'), /phone unsupported/);
});

test('the vista example is a spec v2 on the vista runtime, listed with the others, and create --from finds it', async () => {
  const meta = JSON.parse(await readFile(path.join(EXAMPLES, 'lantern-cove', 'example.json'), 'utf8'));
  assert.equal(meta.closed, undefined, 'nothing closes an example: the registry opens runtimes');
  const spec = JSON.parse(await readFile(path.join(EXAMPLES, 'lantern-cove', 'spec.json'), 'utf8'));
  assert.deepEqual([spec.specVersion, spec.runtime, spec.kind, 'engine' in spec], [2, 'vista', 'calm', false]);
  const shown = (await listExamples(EXAMPLES)).find(e => e.id === 'lantern-cove');
  assert.deepEqual([shown?.runtime, shown?.loop, shown?.kind], ['vista', 'round', 'calm']);
  assert.equal((await resolveExample('lantern-cove')).id, 'lantern-cove');
});
