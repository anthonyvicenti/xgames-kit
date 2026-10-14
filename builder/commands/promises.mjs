import path from 'node:path';
import { guard, parse } from '../lib/cli.mjs';
import { resolveGame } from '../lib/games.mjs';
import { runTool } from '../lib/run-tool.mjs';

const usage = `Usage: gamesfun promises [dir] [--spec <spec.json>] [--json]

What the game promises a player: every control the HUD lists, the core loop and scoring, each mechanic's "as", the
hook, the spec's accept items and the kit's own. A play-test passes a promise only when it is seen on screen.`;

export default {
  name: 'promises',
  summary: 'list what a game promises a player (the play-test checklist)',
  usage,
  run: args => guard(async () => {
    const { values, positionals } = parse(args, { spec: { type: 'string' } }, usage);
    const dir = await resolveGame(positionals[0]);
    const flags = [];
    if (values.spec) flags.push('--spec', path.resolve(values.spec));
    if (values.json) flags.push('--json');
    return (await runTool('promises', [dir, ...flags])).code;
  }),
};
