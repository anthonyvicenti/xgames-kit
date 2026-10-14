import { ensureCharDeps } from '../lib/char-deps.mjs';
import { runTool } from '../lib/run-tool.mjs';
import { guard, UsageError } from '../lib/cli.mjs';

const usage = `Usage: gamesfun rig-check <body.glb> [...] [--archetype worm|blob|quadruped|flyer] [--json]

Does a GLB work as a character body? A person-shaped body is held to the gf-humanoid-1 rig standard: the bones, the
scale (metres, Y up, facing +Z, feet on the ground), the skin weights, and the kit's shared animation clips pose it
sanely. A worm, blob, four-legged or winged body (its file says which, or --archetype) is held to that archetype's
standard (CREATURES.md) and posed through every action by the kit's own procedural motion. Any body that passes can
go in a character.body.<role> slot: npx gamesfun slots set character.body.player --file <body.glb>. A plain mesh is
rigged first: npx gamesfun art autorig <mesh.glb> --archetype blob --out <body.glb>.
The first run installs the 3D tools' npm packages (gltf-transform, meshoptimizer, sharp).`;

export default {
  name: 'rig-check',
  summary: 'check that a GLB works as a character body (gf-humanoid-1)',
  usage,
  run: args => guard(async () => {
    if (!args.some(a => !a.startsWith('--'))) throw new UsageError(usage);
    ensureCharDeps();
    return (await runTool('rig-check', args)).code;
  }),
};
