// Publishing to games.fun from the agent: the same steps as `gamesfun login` / `gamesfun publish` (builder/lib/publish/).
// Signing in is the person's step: the tool opens games.fun in their browser and they approve this computer there; the
// agent never sees a password or the token. Publishing makes the game playable by anyone with the link (unlisted).
import { resolveGame, shown } from '../../lib/games.mjs';
import { KIT_ROOT } from '../../lib/paths.mjs';
import { openUrl } from '../../lib/open.mjs';
import { login, savedLogin, studioOrigin } from '../../lib/publish/client.mjs';
import { preflight, publishGame, publishStatus } from '../../lib/publish/index.mjs';

const game = { type: 'string', description: 'The game folder, relative to the kit root (e.g. games/my-game). Optional when there is only one game.' };
const gameDir = input => resolveGame(input.game, { cwd: KIT_ROOT });
const pending = { url: null, state: 'idle', error: null };

export const tools = [
  {
    name: 'gamesfun_publish_status',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description: 'Is this kit signed in to games.fun, and is the game published (its link, its version)? Read-only.',
    inputSchema: { type: 'object', properties: { game }, additionalProperties: false },
    async handler(input) {
      const dir = await gameDir(input);
      return { ...(await publishStatus(dir)), login: { ...pending } };
    },
  },
  {
    name: 'gamesfun_publish_check',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: 'The offline part of publishing, without publishing: which files would go up, which are left out, and every reason it would be refused (a .env file, a link, anything that looks like a key, a backend.json whose origins the play host cannot open). Run it before gamesfun_publish and fix what it names. Read-only.',
    inputSchema: { type: 'object', properties: { game }, additionalProperties: false },
    async handler(input) {
      const p = await preflight(await gameDir(input));
      return { ok: !p.problems.length && !p.secrets, files: p.built.tree.files.length, bytes: p.built.bytes, skipped: p.built.skipped, added: p.built.added, problems: p.problems, secrets: p.secrets, backend: p.backend };
    },
  },
  {
    name: 'gamesfun_login',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    description: 'Start signing this kit in to games.fun. It opens games.fun in the person’s browser, where THEY sign in and approve this computer; this tool returns at once with that link and the step for the person. Then call gamesfun_publish_status until it says signed in. Never ask the person for a password or a token.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async handler() {
      const origin = studioOrigin();
      const saved = await savedLogin(origin);
      if (saved) return { signedIn: true, email: saved.email, text: `Already signed in to ${origin} as ${saved.email}.` };
      if (pending.state !== 'waiting') {
        Object.assign(pending, { url: null, state: 'waiting', error: null });
        let ready;
        const urlReady = new Promise(r => { ready = r; });
        login({ origin, open: url => { pending.url = url; ready(url); openUrl(url, { web: true }); } })
          .then(() => { pending.state = 'signed-in'; })
          .catch(e => { Object.assign(pending, { state: 'failed', error: e.message }); ready(null); });
        await urlReady;
      }
      if (!pending.url) return { signedIn: false, error: pending.error, text: `Sign-in did not start: ${pending.error}` };
      return { signedIn: false, step: { link: pending.url }, text: `Waiting for the person: open ${pending.url} (it should have opened in their browser), sign in to games.fun and press “Allow the kit to publish”. Nothing else is needed from them. Check with gamesfun_publish_status.` };
    },
  },
  {
    name: 'gamesfun_publish',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    description: 'Publish the game to games.fun at a link anyone can play (unlisted; games.fun hosts it). Use it ONLY when the person asks to publish. It runs the game’s verify --quick first unless the files are unchanged since it last passed (about 2 minutes); a game whose checks fail is saved as a private draft only and the failing checks are named. Files that look like keys refuse it. Publishing the same folder again makes a new version at the same link. Needs gamesfun_login first. Returns { url, gameUrl, friendsUrl, version, draft, verify, studioUrl }.',
    inputSchema: { type: 'object', properties: { game, draft: { type: 'boolean', description: 'A private version only (no public link).' }, newGame: { type: 'boolean', description: 'Publish as a new game with a new link, not an update.' }, title: { type: 'string' } }, additionalProperties: false },
    async handler(input, ctx) {
      const dir = await gameDir(input);
      const r = await publishGame(dir, { draft: input.draft === true, newGame: input.newGame === true, title: input.title ?? null, progress: l => ctx?.progress?.(l) });
      return { ...r, text: r.url ? `Published ${shown(dir)} (version ${r.version.number}, unlisted): ${r.url}` : `Saved ${shown(dir)} as a private draft (version ${r.version.number}): ${r.studioUrl}.${r.verify.pass ? '' : ` Its checks did not pass: ${r.verify.failed.map(c => `${c.n} ${c.name}`).join('; ') || 'verify did not run'}.`}` };
    },
  },
];
