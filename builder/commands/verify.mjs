import { ensureCharDeps } from '../lib/char-deps.mjs';
import { ensureBrowser } from '../lib/chrome.mjs';
import { guard, parse, UsageError } from '../lib/cli.mjs';
import { resolveGame, shown } from '../lib/games.mjs';
import { runTool } from '../lib/run-tool.mjs';
import { isGodotGame, verifyGodotGame } from '../../runtimes/godot/gamesfun.mjs';

const usage = `Usage: gamesfun verify [dir] [--quick] [--release] [--profile <file>] [--check <n>] [--gate <A-F>] [--out <dir>] [--json]

Is this game good? gf-three's verify plays it in Chrome with real input (alone with bots, and two players over real
WebRTC) and prints one verdict. Evidence goes to <game>/evidence/verify-N/ (verdict.json, screenshots).
  --quick        skip the contact sheet (check 9); about 2 minutes
  --release      also run the measures that test the kit, not the game (7, 8, 20-22, 24, 31, 34); about 3 minutes more
  --profile <file>  a machine that cannot run everything (a CI runner): the file lists checks to leave out, each with its
                 reason; they are recorded as skipped, never as passed, and the run is never a full pass (.github/ci-profile.json)
  --check <n>    run one check alone while you fix it: 13 or 10, 14, 15, 16, or a list: 1,2,11,14,17 (the ones that only read files)
  --gate <A-F>   run one gate's measures (builder/GATES.md): A integrity, B health, C cause -> effect,
                 D the loop closes, E shared truth, F matches the spec
  --out <dir>    write the evidence somewhere else

Chrome: CHROME_PATH, else an installed Chrome or Edge, else Playwright's Chromium (downloaded once, on demand).`;

const STATIC = new Set(['1', '2', '11', '14', '17']);   // checks that read files only: no browser needed
const isStatic = list => !!list && list.split(',').every(n => STATIC.has(n));

export default {
  name: 'verify',
  summary: 'run the checks every game must pass (real Chrome, real input)',
  usage,
  run: args => guard(async () => {
    const { values, positionals } = parse(args, { quick: { type: 'boolean' }, release: { type: 'boolean' }, profile: { type: 'string' }, check: { type: 'string' }, gate: { type: 'string' }, out: { type: 'string' } }, usage);
    if (values.check && !/^\d+(,\d+)*$/.test(values.check)) throw new UsageError(`--check takes a check number, e.g. 13\n\n${usage}`);
    if (values.gate && !/^[A-F]$/i.test(values.gate)) throw new UsageError(`--gate takes a gate letter, A to F\n\n${usage}`);
    if (values.gate && values.check) throw new UsageError(`--gate and --check: one or the other\n\n${usage}`);
    const dir = await resolveGame(positionals[0]);
    if (isGodotGame(dir)) return verifyGodotGame(dir, values);   // runtime godot: its own measures for the six gates
    if (values.gate || !isStatic(values.check)) {
      const b = await ensureBrowser({ log: m => console.error(m) });
      if (!values.json) console.error(`verify: ${shown(dir)} in ${b.kind === 'edge' ? 'Microsoft Edge' : b.kind === 'chromium' ? 'Chromium' : 'Chrome'} (${b.path})`);
    }
    ensureCharDeps();   // verify reads every body's skeleton (check 19) with the 3D tools' packages; installed once
    const flags = [];
    if (values.quick) flags.push('--quick');
    if (values.release) flags.push('--release');
    if (values.profile) flags.push('--profile', values.profile);
    if (values.check) flags.push('--check', values.check);
    if (values.gate) flags.push('--gate', values.gate.toUpperCase());
    if (values.out) flags.push('--out', values.out);
    if (values.json) flags.push('--json');
    const r = await runTool('verify', [dir, ...flags], { stdio: 'inherit' });
    return r.code;
  }),
};
