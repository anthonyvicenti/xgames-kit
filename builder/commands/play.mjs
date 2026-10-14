import path from 'node:path';
import { ensureBrowser } from '../lib/chrome.mjs';
import { guard, parse, UsageError } from '../lib/cli.mjs';
import { resolveGame } from '../lib/games.mjs';
import { runTool } from '../lib/run-tool.mjs';

const usage = `Usage: gamesfun play [dir] (--script <steps.json> | --steps '<json>') --out <dir> [--size 1280x720] [--headed] [--json]

Play the game like a new player, black box: real keys and mouse in Chrome, screenshots of the player's own view and
the HUD's words after each step. This is the play-tester's tool (skills/verify-and-playtest). A step list:
  [{"do":"start","bots":3,"seed":1,"round":40}, {"do":"hold","key":"Mouse","seconds":2,"shot":"firing"},
   {"do":"press","key":"KeyE","shot":"after-e"}, {"do":"move","dir":"forward","seconds":1.5}, {"do":"look","dx":300},
   {"do":"until","phase":"results","timeout":90}, {"do":"again"}]
Steps: start, hold, press, move, look, wait, shot, snap, until, again, click (builder/tools/lib/play-script.mjs).`;

export default {
  name: 'play',
  summary: 'play a game with scripted real input and screenshots (play-testing)',
  usage,
  run: args => guard(async () => {
    const { values, positionals } = parse(args, { script: { type: 'string' }, steps: { type: 'string' }, out: { type: 'string' }, size: { type: 'string' }, headed: { type: 'boolean' } }, usage);
    if (!values.out || !(values.script || values.steps)) throw new UsageError(usage);
    const target = /^https?:\/\//.test(positionals[0] ?? '') ? positionals[0] : await resolveGame(positionals[0]);
    await ensureBrowser({ log: m => console.error(m) });
    const flags = ['--out', path.resolve(values.out)];
    if (values.script) flags.push('--script', path.resolve(values.script));
    if (values.steps) flags.push('--steps', values.steps);
    if (values.size) flags.push('--size', values.size);
    if (values.headed) flags.push('--headed');
    if (values.json) flags.push('--json');
    return (await runTool('play', [target, ...flags])).code;
  }),
};
