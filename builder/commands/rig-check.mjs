import { ensureCharDeps } from '../lib/char-deps.mjs';
import { runTool } from '../lib/run-tool.mjs';
import { guard, UsageError } from '../lib/cli.mjs';

const usage = `Usage: gamesfun rig-check <body.glb> [...] [--json]

Does a GLB work as a character body (the gf-humanoid-1 rig standard)? Checks the bones, the scale (metres, Y up,
facing +Z, feet on the ground), the skin weights, and that the kit's shared animation clips pose it sanely. Any body
that passes can go in a character.body.<role> slot: npx gamesfun slots set character.body.player --file <body.glb>.
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
