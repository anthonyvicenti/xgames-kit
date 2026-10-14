// The Backend tab's Railway panel (the panel seam: builder/studio/tabs/backend.js; the provider: builder/lib/backend/providers/railway.mjs).
// One button, "Connect Railway": the kit signs in to Railway in a new tab (its own client: nothing to register), picks the
// workspace (or asks, when there are several), deploys its game server template there and writes only the server's URL
// into the game. The steps run in the dev server (builder/lib/backend/railway-connect.mjs, the same code as `gamesfun backend
// connect railway`); builder/studio/tabs/backend/flow-ui.js draws them. Or deploy the template yourself and paste its URL.
import { mountFlow } from './flow-ui.js';

export default {
  id: 'railway',
  async mount(root, ctx) {
    const { el, line, provider: prov, game } = ctx;
    const settings = game.settings?.provider === 'railway' ? game.settings : null;
    const signed = prov.status?.signedIn;
    const note = el('div', { 'aria-live': 'polite' });
    const parts = [el('p', { className: 'muted small' }, prov.about)];
    const connected = (r, box) => box.append(el('b', {}, 'Connected. '), `The game's server is up at ${r.url}. `,
      el('a', { href: r.dashboard, target: '_blank', rel: 'noopener' }, 'Open the project in Railway'),
      el('div', { className: 'muted small' }, `backend.json holds only that URL; the server's secret stays on Railway. ${r.volume ? 'Scores and saves are kept on a Railway volume.' : 'No volume: scores and saves reset at each deploy.'}`));

    if (settings) parts.push(el('p', {}, 'In rules.js: ', el('code', {}, "import { connectGameServer } from './gf/backend/server.js'"), ', then ', el('code', {}, "submitScore('main', score, name)"), ' at the end of a round and ', el('code', {}, "topScores('main')"), ' for the board.'));
    else parts.push(el('p', { className: 'small flow-intro' }, 'Your browser opens Railway: sign in (or make an account) and pick the workspace the kit may use. The kit does the rest: a project, its game server (leaderboards, saves, a live score feed), and the server\'s URL in backend.json. Nothing to register.'));
    root.replaceChildren(...parts);
    const flowBox = el('div');
    root.append(flowBox);
    const flow = mountFlow(flowBox, ctx, {
      base: 'backend/railway/one-button', button: settings ? 'Deploy the server again' : 'Connect Railway',
      connected, onDone: () => ctx.refresh(), hideOldResult: !settings,
    });
    if (settings) flowBox.querySelector('.flow-go')?.classList.add('ghost');

    // the "everyone else" way: deploy the template yourself (any host), then paste the URL
    if (!settings) {
      const url = el('input', { type: 'url', placeholder: 'https://<service>.up.railway.app', 'aria-label': 'Server URL' });
      const use = el('button', { type: 'button', className: 'ghost' }, 'Use this server');
      const said = el('div', { 'aria-live': 'polite' });
      use.addEventListener('click', async () => {
        try { await ctx.api('backend/use', { provider: 'railway', url: url.value.trim() }); ctx.refresh(); } catch (e) { said.replaceChildren(line('bad', e.message)); }
      });
      root.append(el('details', {}, el('summary', {}, 'Deploy the template yourself, then paste its URL'),
        el('p', { className: 'muted small' }, 'The template is templates/backends/railway-node/ in the kit (its README has the steps for Railway, Render, Fly.io and Cloudflare). Set GF_ORIGINS to this game\'s origins and GF_SECRET to a long random value on the host; only the URL goes in the game.'),
        el('div', { className: 'toolbar' }, url, use), said));
    }
    if (signed) {
      const out = el('button', { type: 'button', className: 'ghost small danger' }, 'Sign the kit out of Railway');
      out.addEventListener('click', async () => {
        try { const r = await ctx.api('backend/disconnect', { provider: 'railway' }); note.replaceChildren(line(r.revoked ? 'ok' : 'warn', r.note ?? 'Signed out.')); setTimeout(() => ctx.refresh(), 1500); } catch (e) { note.replaceChildren(line('bad', e.message)); }
      });
      root.append(el('div', { className: 'toolbar end' }, out), note);
    }
    return () => flow.cleanup();
  },
};
