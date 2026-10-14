import { guard, parse, printJson } from '../lib/cli.mjs';
import { formatDoctor, runDoctor } from '../lib/doctor.mjs';
import { KIT_ROOT } from '../lib/paths.mjs';
import { setWaitForm } from '../bridge/runfile.mjs';

const usage = `Usage: gamesfun doctor [--json] [--skip-graphics] [--all-systems] [--bridge-wait rewake|monitor]

Is this machine ready to make a first game? Checks Node 24, the installed packages, git, a browser, whether graphics are
hardware or software, a free port for the dev server, write access, and each coding agent in lib/agents.json (an agent
you do not use is only a note). Each problem line names the one command that fixes it on your system.
Exit code 1 only for what blocks a first game (a FAIL line); a "warn" never does.
  --json            the same as data: { ok, platform, items: [{ id, label, status, detail, fix: { win32, darwin, linux } }] }
  --skip-graphics   don't open the browser to look at the renderer (about 5 seconds)
  --all-systems     print the fix for Windows, macOS and Linux
  --bridge-wait <rewake|monitor>   switch how the studio page reaches your session (rewake: no shell, the default;
                    monitor: the fallback, needs Git Bash on Windows), then exit`;

export default {
  name: 'doctor',
  summary: 'check this machine for a first game and say how to fix what is missing',
  usage,
  run: args => guard(async () => {
    const { values } = parse(args, { 'skip-graphics': { type: 'boolean' }, 'all-systems': { type: 'boolean' }, 'bridge-wait': { type: 'string' } }, usage);
    if (values['bridge-wait']) { console.log(`The studio bridge's wait is now "${await setWaitForm(KIT_ROOT, values['bridge-wait'])}". Restart \`gamesfun dev\` for it to take effect.`); return 0; }
    const r = await runDoctor({ graphics: !values['skip-graphics'] });
    if (values.json) printJson(r); else console.log(formatDoctor(r, { all: !!values['all-systems'] }));
    return r.ok ? 0 : 1;
  }),
};
