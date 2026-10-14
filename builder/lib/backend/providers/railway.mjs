// Railway as a backend provider (the shape is builder/lib/backend/providers.mjs): kind 'server', the person's own server. The kit
// signs in to Railway in the person's browser, deploys the kit's game server template (leaderboards, saves, a live
// score feed) and writes only its public URL into the game. Railway's side is ../railway.mjs.
import { shown } from '../../games.mjs';
import { openUrl } from '../../open.mjs';
import { FlowError, snapshot, startRun } from '../flow.mjs';
import { connectRailway, STEPS } from '../railway-connect.mjs';
import * as R from '../railway.mjs';

// builder/lib/backend/index.mjs imports this registry, so it is reached lazily here (no import cycle at load)
const lib = () => import('../index.mjs');

const REQUEST = game => `Give this game (${game}) its own server on Railway: run "npx gamesfun backend connect railway ${game}" in a terminal I can see, so my browser opens Railway's sign-in (I pick the workspace on Railway's page). If it lists more than one workspace, ask me which one. It deploys the kit's game server and writes only the server's public URL into backend.json. Then use gf/backend/server.js in rules.js for the leaderboard (submitScore at the end of a round, topScores for the board) and keep every secret out of the game.`;

const cliOptions = {
  workspace: { type: 'string' }, origin: { type: 'string', multiple: true }, image: { type: 'string' },
  'no-dev-origins': { type: 'boolean' },
  // shared with other providers' flags (the same names and types)
  name: { type: 'string' }, project: { type: 'string' }, 'sign-in': { type: 'boolean' },
};
const cliUsage = [
  'connect railway [game]              The game\'s own server (leaderboards, saves, a live feed) in your Railway account:',
  '                                    your browser signs in to Railway; the kit creates a project and a service from',
  '                                    its game server template and writes only the server\'s public URL into the game',
  '    --workspace <id>                the workspace to use (when you shared more than one on Railway\'s page)',
  '    --name <name>                   the new project\'s name (default: the game\'s folder name)',
  '    --project <id>                  deploy again into a project the kit made before',
  '    --origin <origin>               another exact origin the server lets in (repeatable; the games.fun play host and',
  '                                    this machine\'s dev server are always in); --no-dev-origins leaves the dev server out',
  '    --image <ref>                   deploy a published image of the template instead of uploading it',
  '    --sign-in                       sign in again (another account, or other workspaces)',
];

function say(json) { return (...l) => { if (!json) for (const x of l) console.log(x); }; }

/** `gamesfun backend connect railway …`: the one-button flow in the terminal (builder/lib/backend/railway-connect.mjs). */
async function connect(values, gameArg, io) {
  const json = values.json, out = say(json);
  const gameDir = await io.resolveGame(gameArg);
  // the link goes to stderr too under --json, so a person (or a test) can always finish the sign-in
  const tell = json ? l => process.stderr.write(`${l}\n`) : l => console.log(l);
  const printed = new Map();
  const onChange = st => {
    for (const s of st.steps) {
      const key = `${s.state}|${s.detail ?? ''}`;
      if (s.state === 'todo' || printed.get(s.id) === key) continue;
      printed.set(s.id, key);
      tell(`${{ doing: '…', done: '✓', skipped: '-', warn: '!', failed: '✗' }[s.state] ?? ' '} ${s.label}${s.detail ? `: ${s.detail}` : ''}`);
    }
  };
  const ask = async q => {
    if (q.kind === 'signing-in') return new Promise(() => {});
    if (q.kind === 'workspace') {
      if (values.workspace) return { workspace: values.workspace };
      throw new FlowError('NEED', q.title, { question: q });
    }
    throw new FlowError('NEED', q.title, { question: q });
  };
  const run = startRun(STEPS, h => connectRailway({ ...h, ask }, gameDir, {
    signIn: values['sign-in'] ? 'always' : 'auto', name: values.name ?? null, image: values.image ?? null, projectId: values.project ?? null,
    origins: R.gameOrigins(values.origin ?? [], { dev: !values['no-dev-origins'] }),
    open: url => {
      if (process.env.GAMESFUN_NO_OPEN === '1' || !openUrl(url)) tell(`Open this link in your browser to sign in to Railway (it waits up to 5 minutes): ${url}`);
      else tell(`Opening ${url} in your browser to sign in to Railway (it waits up to 5 minutes)…`);
    },
  }), { onChange });
  const end = await run.done;
  if (end.error?.code === 'NEED') {
    const q = end.error.question;
    if (json) { io.printJson({ need: 'workspace', workspaces: q.workspaces }); return 0; }
    out(`${q.title} (--workspace <id>)`, ...q.workspaces.map(w => `  ${w.id}  ${w.name}`));
    return 0;
  }
  if (end.error) throw new Error([end.error.message, ...(end.error.links ?? []).map(l => `  ${l.label}: ${l.url}`)].join('\n'));
  const r = end.result;
  if (json) { io.printJson({ game: shown(gameDir), settings: r.settings, project: r.project, created: r.created, volume: r.volume, dashboard: r.dashboard }); return 0; }
  out(`Connected ${shown(gameDir)} to its own server: ${r.url}`,
    `  backend.json holds only that URL; the server's secret stays on Railway. The client is gf/backend/server.js.`,
    r.volume ? '  Scores and saves are kept on a Railway volume.' : '  No volume: scores and saves reset at each deploy.',
    `  Railway project: ${r.project.name} (${r.dashboard}). Disconnect the kit's sign-in any time: npx gamesfun backend disconnect railway`);
  return 0;
}

/** Deploy, then write backend.json (the URL only) and the client. → { settings, client, project, created, volume } */
export async function connectGame(gameDir, pick, o = {}) {
  const B = await lib();
  await B.assertClean(gameDir, 'before connecting');
  const d = await R.deployServer(pick, o);
  const r = await B.use(gameDir, { provider: 'railway', url: d.url, key: null, project: { ref: d.project.id, name: d.project.name, region: null, organization: pick.workspaceName ?? null }, players: 'anonymous', loopbackOk: true });
  return { ...r, project: d.project, created: d.created, volume: d.volume };
}

/** The studio panel's routes, at /api/backend/railway/…: the one button (one run at a time), and its answers. */
function routes(router, ctx, { HttpError, readJson, fail }) {
  const game = () => { if (!ctx.gameDir) throw new HttpError(409, 'No game is open yet.'); return ctx.gameDir; };
  const wrap = fn => async (req, res, params) => { try { return await fn(req, res, params); } catch (e) { if (e instanceof HttpError) throw e; fail(e); } };
  let run = null, runGame = null;
  // a run belongs to the game it was started for; another open game sees none
  const view = () => snapshot(run && runGame === ctx.gameDir ? run : null);
  const settle = async (ms = 20000) => {
    const until = Date.now() + ms;
    while (run?.state.running && !run.state.link && !run.state.question && Date.now() < until) await new Promise(r => setTimeout(r, 25));
    return view();
  };
  router.post('/railway/one-button', wrap(async req => {
    const b = await readJson(req, { limit: 4096 });
    if (run?.state.running) throw new HttpError(409, 'Connect Railway is already running for this game; finish it or press Cancel.');
    const dir = game();
    runGame = dir;
    const extra = Array.isArray(b.origins) ? b.origins.map(String) : [];
    run = startRun(STEPS, h => connectRailway(h, dir, { origins: R.gameOrigins(extra), name: b.name ? String(b.name) : null, signIn: b.signInAgain ? 'always' : 'auto' }),
      { onChange: st => { if (!st.running) ctx.events.send('backend', { provider: 'railway', done: true }); } });
    return settle();
  }));
  router.get('/railway/one-button', wrap(async () => view()));
  router.post('/railway/one-button/answer', wrap(async req => {
    const b = await readJson(req, { limit: 4096 });
    if (!run?.state.running) throw new HttpError(409, 'Nothing is waiting for an answer.');
    if (!run.answer(String(b.id ?? ''), b.answer ?? {})) throw new HttpError(409, 'That question was already answered.');
    return view();
  }));
  router.post('/railway/one-button/cancel', wrap(async () => { run?.cancel(); if (run) await Promise.race([run.done, new Promise(r => setTimeout(r, 3000))]); return view(); }));
}

export default {
  id: 'railway',
  label: 'Railway',
  kind: 'server',
  about: 'The game\'s own server (leaderboards, saves, a live score feed) in your own Railway account. You sign in in your browser; the kit deploys its game server template and writes only the server\'s URL into the game. Free plan: $1 of credit a month; Hobby $5.',
  ways: [
    { id: 'oauth', label: 'Sign in to Railway from the kit', needs: 'a Railway account; nothing to register (the kit registers its own sign-in client)' },
    { id: 'deploy-paste', label: 'Deploy the template yourself, then paste its URL', needs: 'the template in a public repository (templates/backends/railway-node/README.md)' },
  ],
  // a server host gives a game no key at all: only its public URL
  publicKey: () => false,
  settings({ project = null }) {
    return project ? { project: { ref: project.ref ?? null, name: project.name ?? null, region: project.region ?? null, organization: project.organization ?? null } } : {};
  },
  status: ({ env = process.env } = {}) => R.status({ env }),
  disconnect: ({ env = process.env } = {}) => R.disconnect({ env }),
  agentSteps: () => ({
    steps: [
      'In a terminal: npx gamesfun backend connect railway <game>',
      'Your browser opens Railway: sign in (or make an account) and pick the workspace the kit may use.',
      'The kit creates a project and a service, deploys its game server, and writes the server\'s URL to backend.json.',
    ],
    tools: [
      'gf/backend/server.js in rules.js: connectGameServer(), then submitScore(board, score, name), topScores(board), save(data), load(), live(board, fn)',
      'npx gamesfun backend check: no secret in the game',
    ],
    request: REQUEST,
  }),
  cli: { options: cliOptions, usage: cliUsage, connect },
  routes,
  panel: '/studio/tabs/backend/railway.js',
};
