// The contracts are public files: no private path, handle, reference game name, branch or deployment id (the deny-list
// of the release cut). Checked over the schemas, the registry and the manifests (the rest of the repository has its own
// check in tests/release-cut.test.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { ROOT } from '../registry/schemas.mjs';

const DENY = [/\/home\/[a-z]/i, new RegExp('pot' + 'atoe', 'i'), new RegExp('private' + '-explore', 'i'), new RegExp('dark\\s*' + 'veil', 'i'), new RegExp('rtx\\s*' + '5090', 'i'),
  new RegExp('games\\.fun' + '-library', 'i'), /(?<![\w.@/-])agent\/[a-z0-9][\w.-]*/i, /\bdpl_[A-Za-z0-9]/];

const CONTRACTS = ['builder/spec', 'builder/loop', 'builder/gates', 'registry', 'library/schema', 'runtimes/CONTRACT.md', 'loops', 'components', 'kinds'];
const MANIFEST = /(^|\/)(runtime|loop|mechanic)\.json$|^kinds\/|^registry\/|\.schema\.json$|\/examples\/|^runtimes\/CONTRACT\.md$/;

async function* files(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* files(p); else if (/\.(json|md|mjs|js)$/.test(e.name)) yield p;
  }
}

test('no deny-listed word in the schemas, the registry or the manifests', async () => {
  const hits = [];
  const { stat } = await import('node:fs/promises');
  for (const top of CONTRACTS) for await (const f of (await stat(join(ROOT, top))).isDirectory() ? files(join(ROOT, top)) : [join(ROOT, top)]) {
    if (!MANIFEST.test(relative(ROOT, f))) continue;
    const text = await readFile(f, 'utf8');
    for (const re of DENY) if (re.test(text)) hits.push(`${relative(ROOT, f)}: ${re}`);
  }
  assert.deepEqual(hits, []);
});
