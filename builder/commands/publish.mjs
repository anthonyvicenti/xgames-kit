import { guard, parse, printJson } from '../lib/cli.mjs';
import { resolveGame, shown } from '../lib/games.mjs';
import { preflight, publishGame, publishStatus } from '../lib/publish/index.mjs';
import { studioOrigin } from '../lib/publish/client.mjs';

const usage = `Usage: gamesfun publish [dir] [--draft] [--new] [--title <name>] [--status] [--check] [--json]

Put a game on games.fun at a link anyone can play: games.fun hosts it, you need no server. Sign in first
(npx gamesfun login). The game's checks gate it: verify --quick must pass on the files you publish (it runs now unless
nothing changed since it last passed). A game whose checks fail goes up as a private draft only, and you are told
which checks failed. Files that look like keys, .env files and links refuse it; evidence/ and hidden files are left
out. Only files games.fun does not have yet are uploaded. The link is unlisted: only people you give it to find it.
Publishing the same folder again makes a new version at the same link.
  --draft        a private version in your games.fun Studio, no public link
  --new          publish as a new game (a new link), not an update of this folder's game
  --title <name> the game's name on games.fun (default: its title)
  --status       this folder's link and the account it is published from; publishes nothing
  --check        the offline checks only (files, secrets, backend origins); publishes nothing
GAMESFUN_STUDIO=<origin> publishes to another games.fun (a local Studio while developing).`;

export default {
  name: 'publish',
  summary: 'put a game on games.fun at a link anyone can play (unlisted)',
  usage,
  run: args => guard(async () => {
    const { values, positionals } = parse(args, { draft: { type: 'boolean' }, new: { type: 'boolean' }, title: { type: 'string' }, status: { type: 'boolean' }, check: { type: 'boolean' } }, usage);
    const dir = await resolveGame(positionals[0]);
    const origin = studioOrigin();
    if (values.status) {
      const s = await publishStatus(dir, { origin });
      if (values.json) printJson(s);
      else {
        console.log(s.signedIn ? `Signed in to ${origin} as ${s.signedIn.email}.` : `Not signed in to ${origin} (npx gamesfun login).`);
        console.log(s.known ? `${shown(dir)} is ${s.known.url ? `published at ${s.known.url}` : 'a private draft'} (version ${s.known.lastVersion}).${s.live?.error ? ` games.fun says: ${s.live.error}` : s.live ? (s.live.published ? ` Live: version ${s.live.version?.number}.` : ' Not live now.') : ''}` : `${shown(dir)} has not been published to ${origin} yet.`);
      }
      return 0;
    }
    if (values.check) {
      const p = await preflight(dir, { origin });
      const ok = !p.problems.length && !p.secrets && !p.names;
      const out = { ok, files: p.built.tree.files.length, bytes: p.built.bytes, skipped: p.built.skipped, added: p.built.added, copied: p.built.copied, problems: p.problems, secrets: p.secrets, names: p.names, nameWarnings: p.nameWarnings, backend: p.backend };
      if (values.json) printJson(out);
      else console.log(ok ? `${shown(dir)}: ${out.files} files, ${(out.bytes / 1048576).toFixed(1)} MB, nothing refused.${p.backend.length ? ` It may talk to: ${p.backend.join(', ')}.` : ''} Left out: ${out.skipped.join(', ') || 'nothing'}.` : [...p.problems, p.secrets, p.names].filter(Boolean).join('\n'));
      return ok ? 0 : 1;
    }
    const r = await publishGame(dir, { origin, draft: values.draft, newGame: values.new, title: values.title ?? null, progress: values.json ? () => {} : l => console.error(l) });
    if (values.json) printJson(r);
    else if (r.url) console.log(`Published ${shown(dir)} (version ${r.version.number}, unlisted): ${r.url}\n  the game itself: ${r.gameUrl}${r.friendsUrl ? `\n  play with friends: ${r.friendsUrl}` : ''}\n  uploaded ${r.uploaded} new files; games.fun already had ${r.alreadyThere}.`);
    else console.log(`Saved ${shown(dir)} as a private draft (version ${r.version.number}): ${r.studioUrl}${r.publishError ? `\n  not published: ${r.publishError}` : r.verify.pass ? '' : `\n  its checks did not pass: ${r.verify.failed.map(c => `${c.n} ${c.name}`).join('; ') || 'verify did not run'}. Fix them (npx gamesfun verify ${shown(dir)} --quick) and publish again.`}`);
    return r.url || values.draft ? 0 : 1;
  }),
};
