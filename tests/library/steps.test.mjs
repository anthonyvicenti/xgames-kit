// The steps a pack's rebuild line may name (builder/art/rig, builder/art/sound): mapped from the command line, and a
// body already on the standard left as it is. The retarget itself was proven by rebuilding all 18 Kenney blocky
// characters from the pinned zip byte for byte (needs the network and the graphics card, so not run here).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ingestOptions, parse } from '../../builder/art/cli.mjs';
import { rebuildPlan } from '../../builder/art/rebuild.mjs';
import { FIXES, RETARGETS } from '../../builder/art/rig/index.mjs';
import { findAsset, localFile } from '../../builder/art/views.mjs';

test('the command line names the body and sound steps; the blocky pack\'s rebuild line puts its bodies on the standard', () => {
  const o = ingestOptions(parse(['--pack', 'p', '--replace', '--retarget', 'kenney-blocky', '--fix', 'thumbs', '--peak', '-1']).o);
  assert.deepEqual([o.replace, o.retarget, o.fix, o.peak], [true, 'kenney-blocky', 'thumbs', -1]);
  const pack = JSON.parse(readFileSync(new URL('../../library/packs/kenney-blocky-characters/pack.json', import.meta.url), 'utf8'));
  const p = rebuildPlan(pack);
  assert.equal(p.opts.retarget, 'kenney-blocky'); assert.equal(p.opts.category, 'body'); assert.equal(p.opts.replace, true);
  assert.ok(RETARGETS['kenney-blocky'] && FIXES.thumbs);
});

test('the thumbs fix leaves a body whose thumbs already rest along the standard\'s as it is', async () => {
  const zombie = localFile(findAsset('quaternius-ual-bodies/quaternius-zombie'));
  const r = await FIXES.thumbs(readFileSync(zombie));
  assert.match(r.did[0], /already along the standard/);
});
