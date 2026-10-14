#!/usr/bin/env node
// Writes the bench's assets.json (a gf-assets/1 manifest) from the asset library's bodies (serve.mjs benchLibrary()):
//   character.body.player   assets/models/body-player.glb   the slot the exit-gate swaps through an override
//   character.clips         assets/clips/gf-humanoid-1.glb
//   character.body.lib-<id> assets/bodies/<id>.glb          every library body, for the picker and the line-up
// The files themselves are served from the asset library by serve.mjs (no copies in the repo).
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { benchLibrary } from './serve.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const lib = await benchLibrary();
const model = (id, label, file, extra = {}) => ({ id, group: 'characters', label, type: 'model', source: { file },
  constraints: { rigged: true, rig: 'gf-humanoid-1', animations: lib.clips.names, maxBytes: 6000000, scale: 1 }, facet: 'look', ...extra });
const manifest = {
  schema: 'gf-assets/1', game: 'gf-three-character-bench', title: 'gf-three character bench',
  editing: 'readonly', readonlyReason: 'A development bench for track C, not a game',
  groups: [{ id: 'characters', label: 'Characters' }],
  slots: [
    model('character.body.player', 'Player character', 'assets/models/body-player.glb', { tier: 'main', description: `Default: ${lib.default}` }),
    { id: 'character.clips', group: 'characters', label: 'Character animations', type: 'model', source: { file: 'assets/clips/gf-humanoid-1.glb' },
      constraints: { rig: 'gf-humanoid-1', animations: lib.clips.names }, tier: 'advanced', facet: 'look', editable: false, readonlyReason: 'shared clips', license: lib.clips.license },
    ...lib.bodies.map(b => model(`character.body.lib-${b.id}`, b.label, `assets/bodies/${b.id}.glb`, { tier: 'advanced', license: { spdx: b.license.spdx, author: b.license.author, url: b.license.url } })),
  ],
  ignore: [{ path: '*.mjs', reason: 'bench tooling' }, { path: 'evidence/**', reason: 'QA runs' }],
};
writeFileSync(resolve(here, 'assets.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`assets.json: ${manifest.slots.length} slots (${lib.bodies.length} library bodies)`);
