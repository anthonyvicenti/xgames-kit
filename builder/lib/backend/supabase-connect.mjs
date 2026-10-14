// "Connect Supabase": the one button. The studio's Backend tab and `gamesfun backend connect supabase` both run this
// flow (one implementation; builder/lib/backend/flow.mjs keeps its steps and questions). The order is games.fun's findings,
// games.fun's notes on the Supabase OAuth exchange, §7:
//   app        GET <games.fun>/api/kit/supabase: which Supabase app to sign in as (games.fun holds its secret)
//   sign-in    the person's browser signs in to Supabase and allows games.fun's app; PKCE S256, a checked state, the
//              loopback http://127.0.0.1:53841/callback (http://localhost:53841/callback when Supabase refuses that
//              one); the code is traded through games.fun's route; the tokens stay in builder/lib/secret-store.mjs
//   projects   their organizations and projects (each read once per connect: those calls share one budget across
//              everyone using games.fun's app)
//   project    one project: use it; several: a picker; none: make one (organization, nearest region); a paused one:
//              Restore; a full free plan (2 active projects): use an existing one, or links
//   ready      wait until the project and its auth, db and rest services are healthy, with a clock
//   tables     the game's tables from supabase/migrations/*.sql, or the skill's examples the spec's backend needs ask
//              for (leaderboard → high scores, saves → saved progress), checked first, applied once each
//   keys       the project's URL and publishable key into backend.json, and gf/backend/ refreshed
//   check      row-level security on the project itself (the live checker)
//   agents     Supabase's MCP server, scoped to this project, added to the person's agents (builder/lib/backend/mcp.mjs)
// Every error is a sentence (FlowError); a code is never shown alone.
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_STUDIO, studioOrigin } from '../publish/client.mjs';
import { deleteSecret, setSecret, storeInfo } from '../secret-store.mjs';
import { FlowError, reachable } from './flow.mjs';
import * as mcp from './mcp.mjs';
import { checkGame } from './rls.mjs';
import * as S from './supabase.mjs';

// builder/lib/backend/index.mjs loads the provider registry, whose Supabase file loads this one: reach it lazily
const lib = () => import('./index.mjs');

export const STEPS = [
  ['app', 'Find games.fun\'s Supabase app'],
  ['sign-in', 'Sign in to Supabase in your browser'],
  ['projects', 'Read your organizations and projects'],
  ['project', 'Choose the project'],
  ['ready', 'Wait until the database is ready'],
  ['tables', 'Add the game\'s tables, with row-level security'],
  ['keys', 'Write backend.json and gf/backend/'],
  ['check', 'Check row-level security on the project'],
  ['agents', 'Add Supabase to your agents'],
];

const EXAMPLES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../skills/gamesfun-backend/references');
/** The skill's examples, by the spec's `backend.needs` word (loop/backend.mjs BACKEND_NEEDS). */
export const NEED_TABLES = { leaderboard: ['high-scores.sql', 'high_scores'], saves: ['saved-progress.sql', 'progress'] };
export const CALLBACK_HOSTS = ['127.0.0.1', 'localhost'];

/** games.fun's Studio: GAMESFUN_STUDIO_URL, else GAMESFUN_STUDIO (the publish track's), else production. */
export function studio(env = process.env) {
  const v = String(env.GAMESFUN_STUDIO_URL ?? '').trim();
  if (v) { try { return studioOrigin({ GAMESFUN_STUDIO: v }); } catch (e) { throw new Error(e.message.replace(/GAMESFUN_STUDIO\b/g, 'GAMESFUN_STUDIO_URL')); } }
  return studioOrigin(env);
}
/** games.fun's exchange route (GAMESFUN_SUPABASE_BROKER points the kit at another one). */
export const brokerUrl = (env = process.env) => (env.GAMESFUN_SUPABASE_BROKER ? env.GAMESFUN_SUPABASE_BROKER.replace(/\/+$/, '') : `${studio(env)}/api/kit/supabase`);
export { DEFAULT_STUDIO };

const AGENT_WAY = { fallback: 'agent' };
const hostOf = u => { try { return new URL(u).host; } catch { return 'games.fun'; } };

// ---------------------------------------------------------------- 1. which app
/** The person's own registered app when they saved one, else games.fun's from its route. */
export async function findApp({ env = process.env, fetchImpl = fetch } = {}) {
  const own = S.app({ env });
  if (own?.via === 'direct') return own;
  const broker = brokerUrl(env), host = hostOf(broker);
  const res = await reachable(fetchImpl, host)(broker, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
  let j = null;
  try { j = JSON.parse(await res.text()); } catch {}
  if (res.status === 404) throw new FlowError('NOT_OFFERED', `${host} does not offer one-button Supabase yet. You can connect through your agent instead: it is one button too.`, AGENT_WAY);
  if (res.status === 503) throw new FlowError('NOT_SET_UP', `One-button Supabase is not set up on ${host} yet. You can connect through your agent instead: it is one button too.`, AGENT_WAY);
  if (!res.ok || !j?.ready || typeof j.client_id !== 'string' || !j.client_id) throw new FlowError('UPSTREAM', `${host} did not say which Supabase app to sign in with (it answered ${res.status}). Try again in a few minutes, or connect through your agent.`, AGENT_WAY);
  return { clientId: j.client_id, clientSecret: null, via: 'broker', broker, redirectUris: Array.isArray(j.redirect_uris) ? j.redirect_uris.map(String) : [] };
}

/**
 * Which loopback name to use: 127.0.0.1 unless the route lists only localhost, or Supabase refuses the 127.0.0.1
 * redirect when asked without a sign-in (a 4xx from its authorize page; a person's browser would see an error page
 * there, never come back). Evidence for both names: the findings §2 (Supabase's docs show http://localhost:…; nothing
 * shows 127.0.0.1, so games.fun registers both).
 */
export async function pickHost(a, { env = process.env, fetchImpl = fetch } = {}) {
  if (env.GAMESFUN_BACKEND_CALLBACK_HOST) return env.GAMESFUN_BACKEND_CALLBACK_HOST;
  const s = S.settings(env), port = s.ports[0];
  const uri = h => `http://${h}:${port}/callback`;
  if (a.redirectUris?.length && !a.redirectUris.includes(uri('127.0.0.1')) && a.redirectUris.includes(uri('localhost'))) return 'localhost';
  try {
    const u = new URL(`${s.api}/v1/oauth/authorize`);
    for (const [k, v] of Object.entries({ client_id: a.clientId, redirect_uri: uri('127.0.0.1'), response_type: 'code', state: 'gamesfun-check', code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM', code_challenge_method: 'S256' })) u.searchParams.set(k, v);
    const r = await fetchImpl(u.href, { redirect: 'manual', signal: AbortSignal.timeout(8000) });
    if (r.status >= 400 && r.status < 500) return 'localhost';
  } catch {}
  return '127.0.0.1';
}

// ---------------------------------------------------------------- 2. sign in
const exchangeError = (e, host) => {
  const s = e?.status;
  if (s === 503) return new FlowError('NOT_SET_UP', `One-button Supabase is not set up on ${host} yet. You can connect through your agent instead: it is one button too.`, AGENT_WAY);
  if (s === 401) return new FlowError('CODE_REFUSED', 'Supabase did not accept the sign-in (it was already used or took too long). Press Connect Supabase again.');
  if (s === 429) return new FlowError('BUSY', `${host} is busy right now (too many sign-ins at once). Wait a minute, then press Connect Supabase again.`);
  if (s === 502 || s === 504) return new FlowError('UPSTREAM', `${host} could not reach Supabase to finish the sign-in. Try again in a few minutes.`);
  if (s === 400) return new FlowError('BAD_REQUEST', `The sign-in could not be finished: ${String(e.message).replace(/^.*?\(400\):\s*/, '')} Press Connect Supabase again.`);
  return e;
};

/** Sign in, with the "signing-in" question open so the page can offer "try localhost" or "cancel". → the token. */
async function signInStep(h, a, { env, fetchImpl, open, timeoutMs }) {
  const port = S.settings(env).ports[0];
  let host = await pickHost(a, { env, fetchImpl });
  let flow = null;
  h.signal?.addEventListener('abort', () => flow?.close(), { once: true });
  for (;;) {
    flow = null;
    const signing = S.signIn({ env, fetchImpl, app: a, host, timeoutMs, onFlow: f => { flow = f; }, open: url => { h.link(url); return open?.(url); } })
      .then(r => ({ ok: r }), e => ({ err: e }));
    // the link exists once the loopback listens: ask the page what to do while the person signs in
    const asked = (async () => {
      while (!flow) { const r = await Promise.race([signing, new Promise(res => setTimeout(() => res(null), 20))]); if (r) return null; }
      const other = CALLBACK_HOSTS.find(x => x !== host);
      return h.ask({ kind: 'signing-in', title: 'Sign in to Supabase in the tab that opened, and allow games.fun.', link: flow.startUrl, host, other,
        hint: `If Supabase shows an error about the redirect address, try ${other} instead.` });
    })();
    const first = await Promise.race([signing, asked.then(answer => ({ answer }), e => ({ askErr: e }))]);
    if (first?.ok) { h.retract(); return first.ok; }
    // the loopback is closed (its port free again) before the run ends, so Connect can be pressed again at once
    if (first?.askErr || first?.answer?.cancel) { flow?.close(); await signing; throw new FlowError('CANCELLED', 'You stopped the sign-in. Nothing was changed.'); }
    if (first?.answer?.host) { flow?.close(); await signing; h.link(null); host = CALLBACK_HOSTS.includes(first.answer.host) ? first.answer.host : host; h.note('sign-in', `Trying again with ${host}`); continue; }
    h.retract();
    const e = first?.err ?? new Error('the sign-in stopped');
    const m = String(e.message);
    if (/no free port/.test(m)) throw new FlowError('PORT_BUSY', `Something on this computer is using port ${port}. Close it and press Connect again.`);
    if (/access_denied|denied/i.test(m)) throw new FlowError('DENIED', 'You didn\'t allow games.fun to reach your Supabase account. Nothing was changed.');
    if (/not finished within/.test(m)) throw new FlowError('TIMEOUT', 'The sign-in wasn\'t finished. Press Connect again.');
    if (/^cancelled$/.test(m)) throw new FlowError('CANCELLED', 'You stopped the sign-in. Nothing was changed.');
    if (/did not connect/.test(m)) throw new FlowError('NOT_CONNECTED', `Supabase did not connect: ${m.replace(/^.*did not connect:\s*/, '')}. Press Connect again.`);
    throw exchangeError(e, hostOf(a.broker ?? ''));
  }
}

// ---------------------------------------------------------------- what the game asks for
async function readJson(file) { try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; } }
/** The game's title, for a new project's name. */
export async function gameTitle(gameDir) {
  const g = await readJson(path.join(gameDir, 'config', 'game.json'));
  const s = await readJson(path.join(gameDir, 'spec.json'));
  return String(g?.text?.title ?? s?.title ?? path.basename(gameDir)).trim() || 'game';
}
/** The spec's backend needs (spec.json → backend.needs), or []. */
export async function specNeeds(gameDir) {
  const s = await readJson(path.join(gameDir, 'spec.json'));
  return Array.isArray(s?.backend?.needs) ? s.backend.needs.map(String) : [];
}
/** The tables the button gives a game: its own migrations, else the examples its needs name (a leaderboard when none). */
export async function planTables(gameDir) {
  const dir = path.join(gameDir, 'supabase', 'migrations');
  const own = (await readdir(dir).catch(() => [])).filter(f => f.endsWith('.sql')).sort();
  if (own.length) return { files: own.map(f => path.join(dir, f)), from: 'game', needs: await specNeeds(gameDir), wrote: [] };
  const needs = await specNeeds(gameDir);
  const picked = Object.keys(NEED_TABLES).filter(n => needs.includes(n));
  const use = picked.length ? picked : ['leaderboard'];
  await mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const wrote = [];
  for (const [i, n] of use.entries()) {
    const [src, table] = NEED_TABLES[n];
    const file = path.join(dir, `${String(Number(stamp) + i)}_${table}.sql`);
    await writeFile(file, await readFile(path.join(EXAMPLES, src), 'utf8'));
    wrote.push(file);
  }
  return { files: wrote, from: picked.length ? 'needs' : 'default', needs, wrote };
}

// ---------------------------------------------------------------- the flow
const gameSlug = dir => path.basename(dir).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'game';
const isPaused = p => /^(INACTIVE|PAUSING|PAUSE_FAILED)$/.test(p?.status ?? '');
const active = p => !isPaused(p) && !/REMOVED|GOING_DOWN/.test(p?.status ?? '');
const projectRow = (p, orgs) => ({ ref: p.ref, name: p.name, region: p.region, status: p.status, paused: isPaused(p), organization: p.organization_slug ?? null, organizationName: orgs.find(o => o.slug === p.organization_slug)?.name ?? p.organization_slug ?? null });
const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(new FlowError('CANCELLED', 'You stopped it. Nothing more was changed.')); }, { once: true });
});

/** A Management API failure in the person's words (429, 401 and the rest). */
function apiError(e, what) {
  if (e instanceof FlowError) return e;
  if (e?.status === 429) return new FlowError('BUSY', `Supabase is busy right now (too many requests through games.fun's app). Wait ${e.reset ? `${e.reset} seconds` : 'a minute'}, then press Connect again.`);
  if (e?.code === 'NO_TOKEN' || e?.status === 401) return new FlowError('SIGNED_OUT', 'Supabase no longer accepts this sign-in. Press Connect Supabase again to sign in.', { signIn: true });
  if (e?.status === 403) return new FlowError('NOT_ALLOWED', `Supabase did not allow ${what}: ${e.supabaseMessage ?? 'no permission'}. Check that you are an owner or admin of the organization you picked.`);
  return new FlowError('SUPABASE', `Supabase could not ${what}: ${e?.supabaseMessage ?? e?.message ?? 'no answer'}.`);
}

/**
 * The flow. h: builder/lib/backend/flow.mjs's handle. Options: env, fetchImpl, open(url) (show the sign-in link; the studio
 * opens it in a tab, the terminal opens the browser), addToAgents (default true), agentOpts ({ runner, detected } in
 * tests), signIn ('auto': keep a working saved sign-in; 'always'), everyMs (poll), readyTimeoutMs, signInTimeoutMs.
 * → { project, dashboard, url, keyKind, created, dbPassword, tables, check, agents, anonymous }
 */
export async function connectSupabase(h, gameDir, {
  env = process.env, fetchImpl = fetch, open, addToAgents = true, agentOpts = {}, signIn = 'auto',
  everyMs = null, readyTimeoutMs = 10 * 60 * 1000, signInTimeoutMs, players = 'anonymous',
} = {}) {
  // Supabase is polled every 5 seconds; GAMESFUN_SUPABASE_POLL_MS polls a stand-in faster (tests)
  everyMs ??= Math.max(5, Number(env.GAMESFUN_SUPABASE_POLL_MS) || 0) || 5000;
  const net = reachable(fetchImpl, 'Supabase');
  const o = { env, fetchImpl: net };
  const B = await lib();
  await B.assertClean(gameDir, 'Before connecting').catch(e => { throw new FlowError('SECRET', e.message); });

  // 1–2. the app and the sign-in (a working saved sign-in is kept)
  let saved = null;
  if (signIn !== 'always' && S.loadToken({ env })) { try { saved = await S.token(o); } catch { saved = null; } }
  if (saved) {
    h.skip('app', 'Using your saved Supabase sign-in.');
    h.skip('sign-in', 'Using your saved Supabase sign-in.');
  } else {
    h.start('app');
    const a = await findApp({ env, fetchImpl });
    h.done('app', a.via === 'direct' ? 'Your own Supabase app (saved on this computer).' : `games.fun's app, through ${hostOf(a.broker)}.`);
    h.start('sign-in', 'Opening Supabase in your browser…');
    await signInStep(h, a, { env, fetchImpl, open, timeoutMs: signInTimeoutMs });
    h.done('sign-in', `Signed in. The sign-in is kept in ${storeInfo({ env }).where}, never in the game.`);
  }

  // 3. organizations and projects, once each
  h.start('projects');
  let orgs, all;
  try { [orgs, all] = await Promise.all([S.organizations(o), S.projects(o)]); } catch (e) { throw apiError(e, 'list your organizations and projects'); }
  if (!orgs?.length) throw new FlowError('NO_ORG', 'Your Supabase account has no organization yet. Create one at supabase.com/dashboard (it is free), then press Connect again.', { links: [{ label: 'Open the Supabase dashboard', url: 'https://supabase.com/dashboard' }] });
  const projects = (all ?? []).filter(p => orgs.some(x => x.slug === p.organization_slug)).map(p => projectRow(p, orgs));
  h.done('projects', `${orgs.length} organization${orgs.length === 1 ? '' : 's'}, ${projects.length} project${projects.length === 1 ? '' : 's'}.`);

  // 4. the project: one → it; several → a picker; none → make one; paused → restore; a full free plan → choose
  h.start('project');
  const plans = new Map();
  const planOf = async slug => {
    if (!plans.has(slug)) { try { plans.set(slug, (await S.organization(slug, o))?.plan ?? null); } catch { plans.set(slug, null); } }
    return plans.get(slug);
  };
  /** Free organizations with 2 active projects already (a hint: Supabase counts every org the person owns). */
  const fullFor = async slug => {
    if (await planOf(slug) !== 'free') return false;
    let n = 0;
    for (const x of orgs) if (await planOf(x.slug) === 'free') n += projects.filter(p => p.organization === x.slug && active(p)).length;
    return n >= 2;
  };
  const fullQuestion = (slug, said = null) => ({
    kind: 'full',
    title: said ? `Supabase did not make the project: ${said}` : 'Your free Supabase plan already has 2 active projects.',
    body: 'Put this game in a project you already have, pause a project you don\'t use in the Supabase dashboard, or upgrade the organization.',
    projects: projects.filter(active),
    links: [{ label: 'Open the Supabase dashboard', url: 'https://supabase.com/dashboard/projects' }, { label: 'Upgrade the organization', url: `https://supabase.com/dashboard/org/${encodeURIComponent(slug)}/billing` }],
  });
  let chosen = null, created = false, dbPassword = null;
  let next = projects.length === 1 ? { project: projects[0].ref } : projects.length ? null : { create: true };
  const title = await gameTitle(gameDir);
  while (!chosen) {
    if (!next) next = await h.ask({ kind: 'project', title: 'Which Supabase project should this game use?', projects, canCreate: true });
    if (next.project) {
      const p = projects.find(x => x.ref === next.project);
      if (!p) throw new FlowError('NO_PROJECT', `No project ${next.project} in your Supabase account. Press Connect again.`);
      if (!p.paused) { chosen = p; break; }
      const a = await h.ask({ kind: 'paused', title: `Your project ${p.name} is paused (free projects pause after a week with no use). Restore it? It takes a few minutes.`, project: p, links: [{ label: 'Open it in the Supabase dashboard', url: S.dashboardUrl(p.ref) }] });
      if (!a?.restore) { next = projects.filter(x => x.ref !== p.ref).length ? null : { create: true }; continue; }
      h.note('project', `Restoring ${p.name}…`);
      try { await S.restore(p.ref, o); chosen = p; break; } catch (e) {
        const said = e?.supabaseMessage ?? e?.message;
        if (e?.status === 429 || e?.code === 'NO_TOKEN') throw apiError(e, 'restore the project');
        if (/limit|active project|free/i.test(said ?? '') || e?.status === 402) { next = await h.ask(fullQuestion(p.organization, said)); continue; }
        throw new FlowError('RESTORE_FAILED', `Supabase did not restore ${p.name}: ${said}. Open it in the Supabase dashboard (a project paused for more than a year can only be downloaded there), or make a new project.`, { links: [{ label: 'Open it in the Supabase dashboard', url: S.dashboardUrl(p.ref) }] });
      }
    }
    // a new project
    const defOrg = orgs[0].slug;
    if (orgs.length === 1 && await fullFor(defOrg)) { next = await h.ask(fullQuestion(defOrg)); continue; }
    let regions = null;
    try { regions = await S.availableRegions(defOrg, o); } catch {}
    const group = regions?.recommendations?.smartGroup?.code ?? null;
    const regionChoices = [
      ...(group ? [{ value: `group:${group}`, label: `Nearest to you (${regions.recommendations.smartGroup.name ?? group})` }] : []),
      ...(regions?.all?.specific ?? []).map(r => ({ value: r.code, label: r.name ?? r.code })),
    ];
    const name = `${title} (games.fun)`.slice(0, 64);
    const answer = await h.ask({ kind: 'create', title: projects.length ? 'Make a new project for this game' : 'You have no Supabase project yet. Make one for this game?',
      organizations: orgs.map(x => ({ slug: x.slug, name: x.name })), regions: regionChoices,
      defaults: { name, organization: defOrg, region: regionChoices[0]?.value ?? 'group:americas' }, canPick: projects.length > 0 });
    if (answer?.back) { next = null; continue; }
    const org = answer?.organization ?? defOrg;
    if (orgs.length > 1 && await fullFor(org)) { next = await h.ask(fullQuestion(org)); continue; }
    const region = String(answer?.region ?? `group:${group ?? 'americas'}`);
    // the database password: made here, kept before the call (Supabase never hands it back), renamed once the ref is known
    const { randomBytes } = await import('node:crypto');
    const pass = randomBytes(32).toString('base64url');
    const pending = `supabase-db-pending-${gameSlug(gameDir)}`;
    setSecret(pending, pass, { env });
    h.note('project', `Making ${answer?.name ?? name}…`);
    try {
      const made = await S.createProject({ name: String(answer?.name ?? name).trim() || name, org, ...(region.startsWith('group:') ? { smartGroup: region.slice(6) } : { region }), dbPass: pass }, o);
      deleteSecret(pending, { env });
      chosen = projectRow(made.project, orgs);
      created = true;
      dbPassword = made.saved.where;
    } catch (e) {
      deleteSecret(pending, { env });
      const said = e?.supabaseMessage ?? e?.message;
      if (e?.status === 429 || e?.code === 'NO_TOKEN') throw apiError(e, 'make the project');
      if ([400, 402, 403].includes(e?.status) && /limit|active project|free|maximum|exceed/i.test(said ?? '')) { next = await h.ask(fullQuestion(org, said)); continue; }
      throw new FlowError('CREATE_FAILED', `Supabase did not make the project: ${said}.`, { links: [{ label: 'Open the Supabase dashboard', url: 'https://supabase.com/dashboard/projects' }] });
    }
  }
  h.done('project', `${chosen.name}${created ? ' (new)' : ''}${chosen.organizationName ? ` in ${chosen.organizationName}` : ''}.`);

  // 5. wait until it answers (a clock on the page; every 5 s; 10 minutes at most)
  h.start('ready', 'Setting up your database… (usually a few minutes)');
  const until = Date.now() + readyTimeoutMs;
  let project = null;
  for (;;) {
    try { project = await S.project(chosen.ref, o); } catch (e) { throw apiError(e, 'say how the project is doing'); }
    if (project.status === 'INIT_FAILED') throw new FlowError('INIT_FAILED', `Supabase could not set up ${chosen.name}. Delete it in the Supabase dashboard and press Connect again; choosing another region may help.`, { links: [{ label: 'Open it in the Supabase dashboard', url: S.dashboardUrl(chosen.ref) }] });
    if (/REMOVED|GOING_DOWN/.test(project.status)) throw new FlowError('GONE', `${chosen.name} is being removed at Supabase. Press Connect again and pick another project.`);
    if (project.status === 'ACTIVE_HEALTHY') {
      let hs = null;
      try { hs = await S.call(await S.token(o), 'GET', `/v1/projects/${chosen.ref}/health?services=auth,db,rest`, null, o); } catch {}
      if (Array.isArray(hs) && hs.length && hs.every(x => x.status === 'ACTIVE_HEALTHY')) break;
      h.note('ready', 'The project is up; waiting for its database, sign-in and API to answer…');
    } else h.note('ready', `Setting up your database… (usually a few minutes; Supabase says ${String(project.status).toLowerCase().replace(/_/g, ' ')})`);
    if (Date.now() > until) throw new FlowError('STILL_SETTING_UP', `Supabase is still setting up ${chosen.name}. Press Connect again later; nothing is lost.`);
    await sleep(everyMs, h.signal);
  }
  h.done('ready', `${chosen.name} is ready.`);

  // 6. the game's tables, checked by the kit first, applied once each
  h.start('tables');
  const plan = await planTables(gameDir);
  const c = await checkGame(gameDir);
  if (!c.ok) throw new FlowError('RLS', `The kit refused the game's tables before sending them (nothing was applied): ${c.refused.join(' ')}`, { refused: c.refused });
  const tables = [];
  for (const file of plan.files) {
    const sql = await readFile(file, 'utf8');
    const rel = path.relative(gameDir, file).split(path.sep).join('/');
    const key = `gamesfun-${createHash('sha256').update(sql).digest('hex').slice(0, 32)}`;
    h.note('tables', `Applying ${rel}…`);
    try { await S.migrate(chosen.ref, { query: sql, name: path.basename(file, '.sql').toLowerCase().replace(/[^a-z0-9_]+/g, '_'), key }, o); tables.push({ file: rel, status: 'applied' }); } catch (e) {
      const said = String(e?.supabaseMessage ?? e?.message ?? '');
      if (/already exists/i.test(said)) { tables.push({ file: rel, status: 'already there' }); continue; }
      if (e?.status === 429 || e?.code === 'NO_TOKEN') throw apiError(e, 'add the tables');
      throw new FlowError('MIGRATION', `Supabase refused ${rel}: ${said}`, { file: rel });
    }
  }
  const tableWords = tables.map(t => `${t.file.split('/').pop()}${t.status === 'applied' ? '' : ` (${t.status})`}`).join(', ');
  const why = plan.from === 'needs' ? ` (the spec asks for ${plan.needs.filter(n => NEED_TABLES[n]).join(' and ')})` : plan.from === 'default' ? ' (a high-score table: the spec names no backend needs)' : '';
  h.done('tables', `${tableWords}${why}; row-level security on every table.`);

  // anonymous sign-ins: each player gets an id for their own rows (backend.json players: anonymous)
  let anonymous = false;
  if (players === 'anonymous') { try { await S.setAnonymousSignIns(chosen.ref, true, o); anonymous = true; } catch {} }

  // 7. the public key into backend.json; gf/backend/ refreshed
  h.start('keys');
  let picked;
  try {
    const keys = await S.apiKeys(chosen.ref, o);
    try { picked = S.pickPublicKey(keys); } catch {
      const made = await S.createPublishableKey(chosen.ref, o);
      picked = S.pickPublicKey([made]);
    }
  } catch (e) { throw apiError(e, 'give the project\'s public key'); }
  const pub = S.publicSettings({ ...project, ref: chosen.ref, name: chosen.name, organization_slug: chosen.organization }, picked, env);
  const used = await B.use(gameDir, { provider: 'supabase', url: pub.url, key: pub.key, project: { ...pub.project }, players: anonymous ? 'anonymous' : 'none', loopbackOk: true })
    .catch(e => { throw new FlowError(e.code === 'SECRET' ? 'SECRET' : 'WRITE', e.message); });
  h.done('keys', `backend.json: ${used.settings.url}, the ${picked.kind === 'publishable' ? 'publishable' : 'anon'} key (public by design); the client is at gf/backend/.`);

  // 8. row-level security on the project itself
  h.start('check');
  let check = null;
  try { check = await B.checkLive(gameDir, o); } catch (e) { check = { ok: false, refused: [], warned: [`The project could not be checked: ${apiError(e, 'run the check').message}`] }; }
  if (check.ok && !check.warned?.length) h.done('check', 'Every table the game uses has row-level security.');
  else if (check.ok) h.warn('check', check.warned.join(' '));
  else h.warn('check', [...check.refused, ...check.warned].join(' ') || 'The check did not pass.');

  // 9. Supabase's MCP server in the person's agents, scoped to this project
  let agents = [];
  if (!addToAgents) h.skip('agents', 'Not asked for.');
  else {
    h.start('agents');
    try { agents = await mcp.addToAgents(gameDir, { projectRef: chosen.ref, env, ...agentOpts }); } catch (e) { agents = [{ id: 'kit', name: 'The kit', status: 'failed', output: e.message }]; }
    const real = agents.filter(x => x.status !== 'not installed');
    if (!real.length) h.skip('agents', 'No Claude Code or Codex on this computer.');
    else if (real.some(x => x.status === 'failed')) h.warn('agents', real.map(x => `${x.name}: ${x.status}${x.output ? ` (${x.output})` : ''}`).join('; '));
    else h.done('agents', real.map(x => `${x.name}: ${x.status}`).join('; '));
  }

  return {
    project: { ref: chosen.ref, name: chosen.name, region: project.region ?? chosen.region, organization: chosen.organizationName ?? chosen.organization },
    dashboard: S.dashboardUrl(chosen.ref), url: used.settings.url, keyKind: used.settings.keyKind, created,
    dbPassword: created ? `made by the kit and kept in ${dbPassword}; see it in your own terminal with: npx gamesfun backend password ${chosen.ref}` : null,
    tables, check: { ok: check.ok, refused: check.refused ?? [], warned: check.warned ?? [] }, agents, anonymous,
  };
}
