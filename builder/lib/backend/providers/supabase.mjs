// Supabase as a backend provider (the shape is builder/lib/backend/providers.mjs). The one button ("Connect Supabase", in the
// studio and in the terminal) is ../supabase-connect.mjs; the Management API and the sign-in are ../supabase.mjs; the
// agent's way (Supabase's hosted MCP server) and "Add Supabase to my agents" are ../mcp.mjs.
import path from 'node:path';
import { shown } from '../../games.mjs';
import { openUrl } from '../../open.mjs';
import { FlowError, snapshot, startRun } from '../flow.mjs';
import * as mcp from '../mcp.mjs';
import { connectSupabase, STEPS } from '../supabase-connect.mjs';
import * as S from '../supabase.mjs';

// builder/lib/backend/index.mjs imports this registry, so it is reached lazily here (no import cycle at load)
const lib = () => import('../index.mjs');

const REQUEST = game => `Connect Supabase to this game (${game}) as its backend. Follow the gamesfun-backend skill: run "npx gamesfun backend connect supabase --add-mcp", tell me how to sign in to Supabase in my browser, then list my projects (offer an existing one before creating one: ask me the name and region), get the project URL and publishable key and write them with "npx gamesfun backend use supabase". Do not put any secret or service-role key in the game.`;

const cliOptions = {
  agent: { type: 'boolean' }, 'add-mcp': { type: 'boolean' }, 'no-agents': { type: 'boolean' },
  'token-stdin': { type: 'boolean' }, 'sign-in': { type: 'boolean' },
  'client-id': { type: 'string' }, 'client-secret-stdin': { type: 'boolean' },
  project: { type: 'string' }, create: { type: 'boolean' }, name: { type: 'string' }, org: { type: 'string' }, region: { type: 'string' },
  restore: { type: 'boolean' }, yes: { type: 'boolean' }, 'anonymous-sign-ins': { type: 'boolean' },
};

const cliUsage = [
  'connect supabase [game]             One button: your browser signs in to Supabase (through games.fun\'s app), the kit',
  '                                    picks or makes the project, adds the game\'s tables with row-level security,',
  '                                    writes backend.json and adds Supabase to your agents. The studio\'s "Connect',
  '                                    Supabase" runs the same steps.',
  '    --project <ref>                 use this project          --create  make a new one (--name, --org, --region:',
  '                                    a code like eu-central-1, or americas, emea, apac; default: nearest to you)',
  '    --restore                       restore the project if it is paused       --yes  take the defaults',
  '    --no-agents                     do not add Supabase\'s MCP server to Claude Code / Codex',
  '    --sign-in                       sign in again even when a saved sign-in works',
  '    --token-stdin                   sign in with a personal access token (sbp_…) on stdin instead',
  '    --client-id <uuid> --client-secret-stdin   sign in with your own OAuth app instead of games.fun\'s',
  '  connect supabase --agent          The agent\'s way: your agent adds Supabase\'s MCP server (--add-mcp does it for',
  '                                    Claude Code / Codex) and you sign in from the agent; prints the steps.',
];

/** The agent's way, in words (the 503/404 fallback and --agent). */
async function agentWay(values) {
  const out = { way: 'mcp', url: mcp.mcpUrl(), steps: mcp.manualSteps(), tools: mcp.AGENT_TOOLS, agents: [] };
  if (values['add-mcp']) out.agents = await mcp.addServer();
  return out;
}
const printAgentWay = (out, write) => {
  for (const a of out.agents) write(`${a.name}: ${a.status}${a.status === 'failed' ? `\n  ${a.output}` : ''}${['added', 'already added'].includes(a.status) ? `\n  Sign in: ${a.signIn}` : ''}`);
  if (!out.agents.length) { write('Connect Supabase through your agent (nobody registers anything; your browser signs in):'); for (const s of out.steps) write(`  ${s}`); }
  write('', 'Then your agent:', ...out.tools.map(t => `  - ${t}`), '', 'Skill: gamesfun-backend (tables, access rules and edge functions, safely).');
};

/** A region flag in the flow's words: a code, or americas|emea|apac (a smart group). */
const regionValue = r => (r == null ? null : /^(americas|emea|apac)$/.test(r) ? `group:${r}` : r);

/** The terminal's answers: flags first, then a prompt when there is a terminal, else "pass this flag". */
function terminalAsk(values, { json, say }) {
  const tty = process.stdin.isTTY && process.stdout.isTTY && !json;
  const need = q => { throw new FlowError('NEED', q.title, { question: q }); };
  const prompt = async (text, def = '') => {
    const rl = (await import('node:readline/promises')).createInterface({ input: process.stdin, output: process.stdout });
    try { return (await rl.question(text)).trim() || def; } finally { rl.close(); }
  };
  return async q => {
    if (q.kind === 'signing-in') { say(`Waiting for you to sign in to Supabase in your browser (up to 5 minutes). ${q.hint}`); return new Promise(() => {}); }
    if (q.kind === 'project' || q.kind === 'full') {
      if (values.project) return { project: values.project };
      if (q.kind === 'project' && (values.create || values.yes)) return { create: true };
      if (!tty) need(q);
      say(q.title, ...(q.body ? [q.body] : []), ...q.projects.map((p, i) => `  ${i + 1}. ${p.name} (${p.ref}, ${p.region}${p.paused ? ', paused' : ''})`), ...(q.canCreate ? [`  ${q.projects.length + 1}. Make a new project for this game`] : []), ...(q.links ?? []).map(l => `  ${l.label}: ${l.url}`));
      const n = Number(await prompt('Number: '));
      if (q.canCreate && n === q.projects.length + 1) return { create: true };
      if (q.projects[n - 1]) return { project: q.projects[n - 1].ref };
      throw new FlowError('CANCELLED', 'No project was chosen. Nothing more was changed.');
    }
    if (q.kind === 'paused') {
      if (values.restore || values.yes) return { restore: true };
      if (!tty) need(q);
      return /^y/i.test(await prompt(`${q.title} [y/N] `, 'n')) ? { restore: true } : { other: true };
    }
    if (q.kind === 'create') {
      const a = { name: values.name ?? q.defaults.name, organization: values.org ?? q.defaults.organization, region: regionValue(values.region) ?? q.defaults.region };
      if (values.create || values.yes || values.name || values.org || values.region) return a;
      if (!tty) need(q);
      const where = q.regions.find(r => r.value === a.region)?.label ?? a.region;
      return /^n/i.test(await prompt(`${q.title}\n  "${a.name}" in ${q.organizations.find(o => o.slug === a.organization)?.name ?? a.organization}, ${where}. Make it? [Y/n] `, 'y')) ? (() => { throw new FlowError('CANCELLED', 'No project was made. Nothing more was changed.'); })() : a;
    }
    need(q);
  };
}

/** The flags a question needs, for a terminal with no prompt (a script, an agent). */
function needWords(q, gameArg) {
  const g = gameArg ? `${gameArg} ` : '';
  if (q.kind === 'project' || q.kind === 'full') return [q.title, ...(q.body ? [q.body] : []), ...q.projects.map(p => `  ${p.ref}  ${p.name}  ${p.region}${p.paused ? '  (paused)' : ''}`), ...(q.links ?? []).map(l => `  ${l.label}: ${l.url}`), '',
    `Then: npx gamesfun backend connect supabase ${g}--project <ref>`, ...(q.canCreate ? [`  or: npx gamesfun backend connect supabase ${g}--create [--name <name>] [--org <slug>] [--region <code|americas|emea|apac>]`] : [])];
  if (q.kind === 'paused') return [q.title, `Then: npx gamesfun backend connect supabase ${g}--project ${q.project.ref} --restore`];
  if (q.kind === 'create') return [q.title, `  organizations: ${q.organizations.map(o => o.slug).join(', ')}`, `  regions: ${q.regions.map(r => r.value.replace(/^group:/, '')).join(', ')}`, `Then: npx gamesfun backend connect supabase ${g}--create (defaults: "${q.defaults.name}", ${q.defaults.organization}, ${q.defaults.region.replace(/^group:/, '')})`];
  return [q.title];
}

/** `gamesfun backend connect supabase …`: the one-button flow in the terminal (builder/lib/backend/supabase-connect.mjs). */
async function connect(values, gameArg, io) {
  const json = values.json;
  const say = (...l) => { if (!json) for (const x of l) console.log(x); };
  const tell = json ? l => process.stderr.write(`${l}\n`) : l => console.log(l);
  if (values.agent || (values['add-mcp'] && !values.project && !values.create)) {
    const out = await agentWay(values);
    if (json) { io.printJson(out); return 0; }
    printAgentWay(out, l => console.log(l));
    return 0;
  }
  const gameDir = await io.resolveGame(gameArg);
  if (values['client-id']) {
    if (!values['client-secret-stdin']) throw new Error('--client-id needs --client-secret-stdin (the secret goes on stdin, never in the arguments)');
    const w = S.saveOwnApp(values['client-id'], await io.stdin());
    say(`Your OAuth app is saved in ${w.where}.`);
  }
  if (values['token-stdin']) {
    const r = await S.savePat(await io.stdin());
    say(`Signed in with your token; saved in ${r.where.where}. Revoke it any time at https://supabase.com/dashboard/account/tokens.`);
  }
  const printed = new Map();
  const onChange = st => {
    for (const s of st.steps) {
      const key = `${s.state}|${s.detail ?? ''}`;
      if (s.state === 'todo' || printed.get(s.id) === key) continue;
      printed.set(s.id, key);
      const mark = { doing: '…', done: '✓', skipped: '-', warn: '!', failed: '✗' }[s.state] ?? ' ';
      tell(`${mark} ${s.label}${s.detail ? `: ${s.detail}` : ''}`);
    }
  };
  const run = startRun(STEPS, h => connectSupabase({ ...h, ask: terminalAsk(values, { json, say: tell }) }, gameDir, {
    addToAgents: !values['no-agents'],
    signIn: values['sign-in'] || values['client-id'] ? 'always' : 'auto',
    open: url => {
      if (process.env.GAMESFUN_NO_OPEN === '1' || !openUrl(url)) tell(`Open this link in your browser to sign in to Supabase (it waits up to 5 minutes): ${url}`);
      else tell(`Opening ${url} in your browser to sign in to Supabase (it waits up to 5 minutes)…`);
    },
  }), { onChange });
  const end = await run.done;
  if (end.error?.code === 'NEED') {
    if (json) { io.printJson({ game: shown(gameDir), need: end.error.question.kind, question: end.error.question, steps: end.steps }); return 0; }
    for (const l of needWords(end.error.question, shown(gameDir))) console.log(l);
    return 0;
  }
  if (end.error) {
    if (json) { io.printJson({ game: shown(gameDir), error: end.error, steps: end.steps }); return 1; }
    const lines = [end.error.message, ...(end.error.links ?? []).map(l => `  ${l.label}: ${l.url}`)];
    if (end.error.fallback === 'agent') { lines.push(''); printAgentWay(await agentWay({}), l => lines.push(l)); }
    throw new Error(lines.join('\n'));
  }
  const r = end.result;
  if (json) { io.printJson({ game: shown(gameDir), result: r, steps: end.steps }); return 0; }
  say('', `Connected ${shown(gameDir)} to ${r.project.name} (${r.project.ref}). Its dashboard: ${r.dashboard}`);
  if (r.dbPassword) say(`  The database password was ${r.dbPassword}`);
  for (const a of r.agents.filter(x => x.status === 'added')) say(`  ${a.name}: ${a.use} (${a.file})`);
  say('Remove Supabase from your agents again: npx gamesfun backend agents --remove');
  return 0;
}

/** The studio's routes, at /api/backend/supabase/…: the one button (one run at a time), regions, a token, the live check. */
function routes(router, ctx, { HttpError, readJson, fail }) {
  const game = () => { if (!ctx.gameDir) throw new HttpError(409, 'No game is open yet.'); return ctx.gameDir; };
  const wrap = fn => async (req, res, params) => { try { return await fn(req, res, params); } catch (e) { if (e instanceof HttpError) throw e; fail(e); } };
  let run = null, runGame = null;
  // a run belongs to the game it was started for; another open game sees none
  const view = () => (run && runGame === ctx.gameDir ? { ...snapshot(run), game: path.basename(runGame) } : snapshot(null));
  /** Wait until the run shows a sign-in link, asks something or ends (at most `ms`), so one answer can carry the link. */
  const settle = async (ms = 20000, old = null) => {
    const until = Date.now() + ms;
    const waiting = () => run?.state.running && (!run.state.link || run.state.link === old) && (!run.state.question || old) && Date.now() < until;
    while (waiting()) await new Promise(r => setTimeout(r, 25));
    return view();
  };
  router.post('/supabase/one-button', wrap(async req => {
    const b = await readJson(req, { limit: 1024 });
    if (run?.state.running) throw new HttpError(409, 'Connect Supabase is already running for this game; finish it or press Cancel.');
    const dir = game();
    runGame = dir;
    run = startRun(STEPS, h => connectSupabase(h, dir, { addToAgents: b.addToAgents !== false, signIn: b.signInAgain ? 'always' : 'auto' }),
      { onChange: st => { if (!st.running) ctx.events.send('backend', { provider: 'supabase', done: true }); } });
    return settle();
  }));
  router.get('/supabase/one-button', wrap(async () => view()));
  router.post('/supabase/one-button/answer', wrap(async req => {
    const b = await readJson(req, { limit: 4096 });
    if (!run?.state.running) throw new HttpError(409, 'Nothing is waiting for an answer.');
    const old = run.state.link;
    if (!run.answer(String(b.id ?? ''), b.answer ?? {})) throw new HttpError(409, 'That question was already answered.');
    // "try the other address": answer once the new sign-in link is there, so the page's new tab can open it
    return b.answer?.host ? settle(20000, old) : view();
  }));
  router.post('/supabase/one-button/cancel', wrap(async () => { run?.cancel(); if (run) await Promise.race([run.done, new Promise(r => setTimeout(r, 3000))]); return view(); }));
  router.post('/supabase/add-mcp', wrap(async () => ({ agents: await mcp.addServer() })));
  // "Add Supabase to my agents" after the fact, for the project in backend.json
  router.post('/supabase/agents/add', wrap(async () => {
    const dir = game();
    const B = await lib();
    const ref = (await B.config.read(dir))?.project?.ref;
    if (!ref) throw new HttpError(409, 'This game has no Supabase project in backend.json yet: press Connect Supabase first.');
    return { agents: await mcp.addToAgents(dir, { projectRef: ref }), added: await mcp.added(dir) };
  }));
  router.post('/supabase/token', wrap(async req => { const b = await readJson(req, { limit: 4096 }); const r = await S.savePat(b.token); return { saved: r.where.kind }; }));
  router.get('/supabase/regions', wrap(async req => {
    const r = await S.availableRegions(req.query.get('org'));
    const group = r?.recommendations?.smartGroup;
    return { regions: [...(group ? [{ value: `group:${group.code}`, label: `Nearest to you (${group.name ?? group.code})` }] : []), ...(r?.all?.specific ?? []).map(x => ({ value: x.code, label: x.name ?? x.code }))] };
  }));
  router.get('/supabase/check-live', wrap(async () => (await lib()).checkLive(game())));
}

export default {
  id: 'supabase',
  label: 'Supabase',
  kind: 'database',
  about: 'A Postgres database with row-level security, player sign-in (anonymous) and edge functions, in your own Supabase account. Free plan: 2 active projects, paused after a week without use.',
  ways: [
    { id: 'oauth', label: 'Connect Supabase (one button)', needs: 'a Supabase account; games.fun\'s app signs you in through games.fun\'s route' },
    { id: 'mcp', label: 'Through your agent (Supabase\'s MCP server)', needs: 'Claude Code or Codex; you sign in in your browser' },
    { id: 'pat', label: 'A personal access token', needs: 'a token from supabase.com/dashboard/account/tokens' },
    { id: 'paste', label: 'Paste the URL and publishable key', needs: 'the Supabase dashboard' },
  ],
  publicKey: S.isPublicKey,
  settings({ url, key = null, project = null }) {
    const u = new URL(url);
    const ref = project?.ref ?? (/^([a-z0-9]{20})\.supabase\.co$/.exec(u.hostname)?.[1] ?? null);
    return {
      ...(key != null ? { key, keyKind: String(key).startsWith('sb_publishable_') ? 'publishable' : 'anon-jwt' } : {}),
      ...(ref || project ? { project: { ref, name: project?.name ?? null, region: project?.region ?? null, organization: project?.organization ?? project?.organization_slug ?? null } } : {}),
    };
  },
  status({ env = process.env } = {}) {
    const t = S.loadToken({ env }), a = S.app({ env });
    return { signedIn: t ? { kind: t.kind, expires_at: t.expires_at } : null, oauthApp: a ? { via: a.via, own: !!a.own } : null };
  },
  disconnect: opts => S.disconnect(opts),
  agentSteps: () => ({ steps: mcp.manualSteps(), tools: mcp.AGENT_TOOLS, request: REQUEST }),
  cli: { options: cliOptions, usage: cliUsage, connect },
  routes,
  panel: '/studio/tabs/backend/supabase.js',
};
