// "Connect Railway": the one button for a game's own server (builder/lib/backend/railway.mjs, run on
// builder/lib/backend/flow.mjs so the studio shows its steps, its questions and its errors as it does Supabase's). The studio's
// Backend tab and `gamesfun backend connect railway` both run this.
//   sign-in    the person's browser signs in to Railway (the kit's own client, registered on this machine by dynamic
//              registration: no secret; PKCE S256; http://127.0.0.1:53842/callback); a working saved sign-in is kept
//   workspace  the workspaces shared on Railway's page: one → it; several → a picker; none → sign in again
//   deploy     a project and a service, the kit's game server template (builder/templates/backends/railway-node) uploaded,
//              its variables (the server's secret stays on Railway), a domain, and /health answering
//   keys       backend.json with the server's URL only (a server gives a game no key) and gf/backend/
import path from 'node:path';
import { FlowError } from './flow.mjs';
import * as R from './railway.mjs';

const lib = () => import('./index.mjs');

export const STEPS = [
  ['sign-in', 'Sign in to Railway in your browser'],
  ['workspace', 'Choose the workspace'],
  ['deploy', 'Deploy the game server (the kit\'s template)'],
  ['keys', 'Write backend.json and gf/backend/'],
];

export const dashboardUrl = projectId => `https://railway.com/project/${encodeURIComponent(projectId)}`;

/** A Railway failure in the person's words (builder/lib/backend/railway.mjs already words most of them). */
function plainError(e) {
  if (e instanceof FlowError) return e;
  const m = String(e?.message ?? e);
  if (e?.code === 'NO_TOKEN') return new FlowError('SIGNED_OUT', 'Railway no longer accepts the kit\'s sign-in. Press Connect Railway again to sign in.');
  if (e?.code === 'RATE') return new FlowError('BUSY', `${m}.`);
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|network/i.test(m) || e?.cause?.code) return new FlowError('NETWORK', 'Could not reach Railway. Check your internet connection, then press Connect again.');
  if (e?.code === 'UPLOAD' || e?.code === 'DEPLOY' || e?.code === 'HEALTH') return new FlowError(e.code, `${m[0].toUpperCase()}${m.slice(1)}.`.replace(/\.\.$/, '.'));
  return new FlowError('RAILWAY', `Railway: ${m.replace(/^Railway refused: /, '')}`.replace(/([^.])$/, '$1.'));
}

/** Sign in, with a "signing-in" question open so the page can offer Cancel. */
async function signInStep(h, { env, fetchImpl, open, timeoutMs }) {
  let flow = null;
  h.signal?.addEventListener('abort', () => flow?.close(), { once: true });
  const signing = R.signIn({ env, fetchImpl, timeoutMs, onFlow: f => { flow = f; }, open: url => { h.link(url); return open?.(url); } }).then(r => ({ ok: r }), e => ({ err: e }));
  const asked = (async () => {
    while (!flow) { const r = await Promise.race([signing, new Promise(res => setTimeout(() => res(null), 20))]); if (r) return null; }
    return h.ask({ kind: 'signing-in', title: 'Sign in to Railway in the tab that opened, and pick the workspace the kit may use.', link: flow.startUrl });
  })();
  const first = await Promise.race([signing, asked.then(answer => ({ answer }), e => ({ askErr: e }))]);
  if (first?.ok) { h.retract(); return first.ok; }
  if (first?.askErr || first?.answer?.cancel) { flow?.close(); await signing; throw new FlowError('CANCELLED', 'You stopped the sign-in. Nothing was changed.'); }
  h.retract();
  const m = String(first?.err?.message ?? '');
  if (/no free port/.test(m)) throw new FlowError('PORT_BUSY', `Something on this computer is using port ${R.callbackPort(env)}. Close it and press Connect again.`);
  if (/access_denied|denied/i.test(m)) throw new FlowError('DENIED', 'You didn\'t allow the kit to reach your Railway account. Nothing was changed.');
  if (/not finished within/.test(m)) throw new FlowError('TIMEOUT', 'The sign-in wasn\'t finished. Press Connect again.');
  throw plainError(first?.err ?? new Error('the sign-in stopped'));
}

/**
 * The flow. Options: env, fetchImpl, open(url), signIn ('auto' | 'always'), name (a new project's), origins (the exact
 * origins the server lets in; default the play host and this machine's dev ports), image (a published image instead of
 * the upload), workspace (an id: the terminal's flag). → { url, project, created, volume, dashboard }
 */
export async function connectRailway(h, gameDir, { env = process.env, fetchImpl = fetch, open, signIn = 'auto', name = null, origins = null, image = null, projectId = null, signInTimeoutMs, waitEveryMs } = {}) {
  const B = await lib();
  await B.assertClean(gameDir, 'Before connecting').catch(e => { throw new FlowError('SECRET', e.message); });
  const o = { env, fetchImpl };

  let saved = null;
  if (signIn !== 'always' && R.loadToken({ env })) { try { saved = await R.token(o); } catch { saved = null; } }
  if (saved) h.skip('sign-in', 'Using your saved Railway sign-in.');
  else {
    h.start('sign-in', 'Opening Railway in your browser…');
    await signInStep(h, { env, fetchImpl, open, timeoutMs: signInTimeoutMs });
    h.done('sign-in', 'Signed in. The sign-in is kept on this computer, never in the game.');
  }

  // a game already on a server the kit made: deploy into that project again
  let current = null;
  try { current = await B.config.read(gameDir); } catch {}
  const again = projectId ?? (current?.provider === 'railway' && current.project?.ref ? current.project.ref : null);
  let pick;
  if (again) { h.skip('workspace', 'Deploying again into the project the kit made before.'); pick = { projectId: again }; }
  else {
    h.start('workspace');
    let ws;
    try { ws = await R.workspaces(o); } catch (e) { throw plainError(e); }
    if (!ws.length) throw new FlowError('NO_WORKSPACE', 'You shared no workspace with the kit on Railway\'s page. Press Connect Railway again and pick one there.', { signIn: true });
    let w = ws.length === 1 ? ws[0] : null;
    if (!w) {
      const a = await h.ask({ kind: 'workspace', title: 'Which Railway workspace should the game server live in?', workspaces: ws.map(x => ({ id: x.id, name: x.name })) });
      w = ws.find(x => x.id === a?.workspace);
      if (!w) throw new FlowError('NO_WORKSPACE', 'No workspace was chosen. Nothing was changed.');
    }
    const projectName = (name ?? path.basename(gameDir)).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'game';
    pick = { workspaceId: w.id, workspaceName: w.name, name: projectName };
    h.done('workspace', `${w.name}.`);
  }

  h.start('deploy', 'Starting…');
  let d;
  try { d = await R.deployServer(pick, { ...o, origins: origins ?? R.gameOrigins(), image, waitEveryMs, onStep: s => h.note('deploy', s) }); } catch (e) {
    const fe = plainError(e);
    if (pick.projectId) fe.links = [{ label: 'Open the project in Railway', url: dashboardUrl(pick.projectId) }];
    throw fe;
  }
  h.done('deploy', `Up at ${d.url}${d.volume ? '; scores and saves are kept on a Railway volume' : '; no volume, so scores and saves reset at each deploy'}.`);

  h.start('keys');
  const r = await B.use(gameDir, { provider: 'railway', url: d.url, key: null, project: { ref: d.project.id, name: d.project.name, region: null, organization: pick.workspaceName ?? current?.project?.organization ?? null }, players: 'anonymous', loopbackOk: true })
    .catch(e => { throw new FlowError(e.code === 'SECRET' ? 'SECRET' : 'WRITE', e.message); });
  h.done('keys', `backend.json: ${r.settings.url} only (the server's secret stays on Railway); the client is gf/backend/server.js.`);
  return { url: r.settings.url, settings: r.settings, project: d.project, created: d.created, volume: d.volume, dashboard: dashboardUrl(d.project.id) };
}
