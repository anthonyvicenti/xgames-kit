// The forge runtime as the CLI and create see it, with no browser: open to pitches because its registry manifest says
// so (runtimes/forge/runtime.json state.open; the creator, 2026-10-13: "We can open forge and vista"), with no switch
// in the environment. Its minimal example (ruin-hold) draws with the free stand-ins of runtimes/forge/tools/
// stand-ins.mjs in place of the generated models this kit does not ship.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { catalogLines, registry } from '../builder/lib/catalog.mjs';
import { listExamples, resolveExample } from '../builder/lib/examples.mjs';
import { EXAMPLE_SETS } from '../builder/lib/paths.mjs';

test('forge is open by its registry manifest, and the catalog says so with its device limits', async () => {
  const reg = await registry();
  const forge = reg.runtimes.find(r => r.id === 'forge');
  assert.equal(forge.state.open, true);
  const lines = catalogLines(reg, ['runtimes']);
  assert.match(lines.find(l => /^\s+forge\s/.test(l)), /^\s+forge\s+\[open\]/);
  assert.ok(lines.some(l => /devices: .*phone emulated/.test(l)), 'device claims are said plainly');
  assert.doesNotMatch(lines.join('\n'), /GF_FORGE_OPEN|GF_VISTA_OPEN/);
});

test('the forge example ships with its free stand-in art, and create --from finds it', async () => {
  const listed = await listExamples(EXAMPLE_SETS);
  const ex = listed.find(e => e.id === 'ruin-hold');
  assert.equal(ex?.runtime, 'forge', 'the forge minimal example');
  await assert.rejects(resolveExample('zombie-town'));
});
