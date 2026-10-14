// The exit test of the library: the resolver fills every file slot of today's round example (Soak Squad, kind silly)
// and the scenic example (Isle Run, kind scenic) from the real library, and each pick is the right kind of thing.
// Skipped when the library has not been imported on this machine (the packs are in git; the kinds are read from
// XGAMES_KINDS or the repository's kinds/).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadConfig } from '../../builder/art/config.mjs';
import { allAssets, loadLibrary } from '../../builder/art/library.mjs';
import { loadPolicy } from '../../builder/art/policy.mjs';
import { fillSlots, loadKind } from '../../builder/art/resolve.mjs';

const config = loadConfig();
const lib = loadLibrary(config, { privatePacks: false });
const enough = allAssets(lib).filter(a => a.dimension === '3d').length >= 300;
const fixture = name => JSON.parse(readFileSync(new URL(`./fixtures/${name}-slots.json`, import.meta.url), 'utf8'));

for (const name of ['soak-squad', 'isle-run']) {
  test(`every file slot of ${name} is filled from the public library`, { skip: !enough && 'the library is not imported here' }, () => {
    const f = fixture(name);
    const kindPreset = loadKind(f.kind, config.kindsDir);
    const r = fillSlots(lib, f.slots, { kindPreset, runtime: 'three', policy: loadPolicy(config.policyFile), devices: ['phone', 'desktop'] });
    assert.deepEqual(r.none.map(n => `${n.slot}: ${n.findings.join('; ')}`), []);
    assert.equal(r.filled.length, f.slots.length);
    for (const x of r.filled) {
      if (x.slot.startsWith('character.body.')) { assert.equal(x.pick.category, 'body', x.slot); }
      if (x.slot === 'character.clips') assert.equal(x.pick.category, 'clip');
      if (x.slot.startsWith('world.') || x.slot.startsWith('look.textures')) assert.equal(x.pick.category, 'texture', x.slot);
      if (x.pick.credit === null) assert.notEqual(x.pick.licence.spdx.startsWith('CC-BY'), true, `${x.slot}: a CC-BY pick carries its credit`);
    }
    if (process.env.ART_SHOW) for (const x of r.filled) console.log(`${x.slot.padEnd(34)} ${x.pick.ref.padEnd(48)} ${x.why ?? ''}${x.pick.why.join('; ')}`);
  });
}
