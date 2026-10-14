import { guard, parse, printJson } from '../lib/cli.mjs';
import { kitState, noticeText, refreshCache, updateKit } from '../lib/update.mjs';

const usage = `Usage: gamesfun update [--check] [--dry-run] [--json]

Bring this checkout up to date: git fetch, fast-forward only (it never merges, rebases or discards your changes), and
npm ci only when package-lock.json changed. Your games/ folder is not touched.
  --check     only say whether a newer kit exists
  --dry-run   say what an update would do
A cached check (at most once a day, in the background, never delaying a command) prints one line when a newer kit
exists. Turn it off with GAMESFUN_NO_UPDATE_CHECK=1.`;

export default {
  name: 'update',
  summary: 'fetch and fast-forward the kit, reinstall packages if the lockfile changed',
  usage,
  run: args => guard(async () => {
    const { values } = parse(args, { check: { type: 'boolean' }, 'dry-run': { type: 'boolean' }, 'refresh-cache': { type: 'boolean' } }, usage);
    if (values['refresh-cache']) { await refreshCache().catch(() => {}); return 0; }   // the background check
    if (values.check) {
      const s = await kitState({});
      const r = s.ok ? { ok: true, behind: s.behind, ahead: s.ahead, upstream: s.upstream, newer: s.behind > 0 } : s;
      if (values.json) printJson(r);
      else console.log(s.ok ? (noticeText({ behind: s.behind, upstream: s.upstream }) ?? `gamesfun: up to date with ${s.upstream}`) : `gamesfun: ${s.error}`);
      return s.ok ? 0 : 1;
    }
    const r = await updateKit({ dryRun: !!values['dry-run'], log: m => console.error(`gamesfun: ${m}`) });
    if (values.json) { printJson(r); return r.ok ? 0 : 1; }
    if (r.status === 'up-to-date') console.log(`gamesfun: already up to date (${r.head} on ${r.upstream})`);
    else if (r.status === 'would-update') console.log(`gamesfun: would fast-forward ${r.behind} commit(s) from ${r.upstream}`);
    else if (r.status === 'updated') {
      console.log(`gamesfun: updated ${r.from} -> ${r.to} (${r.commits} commits, ${r.changed} files)${r.installed ? '; packages reinstalled' : ''}`);
      for (const l of r.log) console.log(`  ${l}`);
      if (r.kitsChanged) console.log('  the kits changed: games you made keep their old copies; to move one onto the new kits, create it again: node bin/gamesfun.mjs create games/<name> --spec games/<name>/spec.json');
    }
    if (r.error) console.error(`gamesfun: ${r.error}`);
    return r.ok ? 0 : 1;
  }),
};
