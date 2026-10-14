// Publish: put this game on games.fun at a link anyone can play (games.fun hosts it). The same steps as
// `npx gamesfun login` and `npx gamesfun publish` (builder/server/routes/publish.mjs → builder/lib/publish/). The page never sees the
// sign-in token: it sees who is signed in.
const el = (tag, { dataset, ...attrs } = {}, ...kids) => { const e = document.createElement(tag); Object.assign(e, attrs); Object.assign(e.dataset, dataset ?? {}); e.append(...kids.filter(k => k != null)); return e; };
const mb = n => `${(n / 1048576).toFixed(1)} MB`;

export default {
  id: 'publish',
  label: 'Publish',
  group: 'Launch',
  order: 30,
  // the flow's last step: also a primary button beside the preview's bar (studio.js), which opens this tool
  action: { label: 'Publish' },
  async mount(root, ctx) {
    const account = el('div', { className: 'conn', dataset: { state: 'idle' } });
    const signIn = el('button', { type: 'button' }, 'Sign in to games.fun');
    const signOut = el('button', { type: 'button', className: 'ghost small' }, 'Sign out');
    const link = el('div');
    const checks = el('div');
    const publish = el('button', { type: 'button', dataset: { testid: 'publish-run' } }, 'Publish');
    const draft = el('button', { type: 'button', className: 'ghost' }, 'Save a private draft');
    const asNew = el('label', { className: 'muted' }, el('input', { type: 'checkbox' }), ' as a new game (a new link)');
    const status = el('span', { className: 'muted' });
    const log = el('pre', { className: 'log', hidden: true });
    const result = el('div');
    root.append(
      el('p', { className: 'intro' }, 'Put this game on games.fun at a link anyone can play. games.fun hosts it: you need no server. The link is unlisted (only people you give it to find it), and publishing again makes a new version at the same link.'),
      el('h3', {}, 'Account'), account, el('div', { className: 'toolbar' }, signIn, signOut),
      el('h3', {}, 'This game'), link, checks,
      el('div', { className: 'toolbar' }, publish, draft, asNew, status), log, result);

    let timer = null, last = null;
    const start = async isDraft => {
      try { await ctx.api('publish/run', { draft: isDraft, newGame: asNew.querySelector('input').checked }); ctx.toast(isDraft ? 'Saving a draft…' : 'Publishing…'); poll(); }
      catch (e) { ctx.toast(e.message, 'error'); }
    };
    publish.addEventListener('click', () => start(false));
    draft.addEventListener('click', () => start(true));
    signIn.addEventListener('click', async () => {
      // A new tab is opened at once (in the click, so no popup blocker stops it) and pointed at games.fun's sign-in.
      const tab = window.open('about:blank', '_blank');
      try { const { url } = await ctx.api('publish/login', {}); if (tab) tab.location.href = url; else window.open(url, '_blank'); poll(); }
      catch (e) { tab?.close(); ctx.toast(e.message, 'error'); }
    });
    signOut.addEventListener('click', async () => { try { await ctx.api('publish/logout', {}); ctx.toast('Signed out'); poll(); } catch (e) { ctx.toast(e.message, 'error'); } });

    function render(s) {
      last = s;
      const who = s.signedIn;
      account.dataset.state = who ? 'ok' : s.signIn?.state === 'waiting' ? 'warn' : 'idle';
      account.textContent = who ? `Signed in to ${s.studio} as ${who.email} (until ${String(who.expiresAt).slice(0, 10)}; the token is kept in ${s.store}).`
        : s.signIn?.state === 'waiting' ? 'Waiting for you to approve this computer in the games.fun tab…'
        : s.signIn?.state === 'failed' ? `Sign-in did not finish: ${s.signIn.error}` : `Not signed in to ${s.studio}.`;
      signIn.style.display = who ? 'none' : ''; signOut.style.display = who ? '' : 'none';
      publish.disabled = draft.disabled = !who || s.run.running;
      link.replaceChildren(s.known
        ? el('p', {}, s.known.url ? el('span', {}, 'Published at ', el('a', { href: s.known.url, target: '_blank', rel: 'noopener', dataset: { testid: 'publish-link' } }, s.known.url), ` (version ${s.known.lastVersion}).`) : `A private draft on games.fun (version ${s.known.lastVersion}).`)
        : el('p', { className: 'muted empty' }, 'Not published yet. Publishing runs the game’s checks first (verify --quick, about 2 minutes) unless nothing changed since they last passed.'));
      status.textContent = s.run.running ? `running since ${new Date(s.run.started).toLocaleTimeString()}…` : '';
      log.hidden = !s.run.lines.length; log.textContent = s.run.lines.join('\n'); log.scrollTop = log.scrollHeight;
      result.replaceChildren();
      const r = s.run.result;
      if (r?.url) result.append(el('div', { className: 'check-line ok', dataset: { testid: 'publish-result' } }, `Published version ${r.version.number}: `, el('a', { href: r.url, target: '_blank', rel: 'noopener' }, r.url), ` · uploaded ${r.uploaded} new files, games.fun already had ${r.alreadyThere}.`));
      else if (r) result.append(el('div', { className: 'check-line warn', dataset: { testid: 'publish-result' } }, `Saved as a private draft (version ${r.version.number}). `, r.studioUrl ? el('a', { href: r.studioUrl, target: '_blank', rel: 'noopener' }, 'Open it on games.fun') : null,
        r.verify?.pass ? '' : ` Its checks did not pass: ${(r.verify?.failed ?? []).map(c => `${c.n} ${c.name}`).join('; ') || 'verify did not run'}.`));
      if (s.run.error) result.append(el('div', { className: 'error-box', dataset: { testid: 'publish-result' } }, s.run.error));
    }
    async function loadChecks() {
      try {
        const c = await ctx.api('publish/check');
        checks.replaceChildren(el('div', { className: `check-line ${c.ok ? 'ok' : 'bad'}` }, c.ok
          ? `${c.files} files, ${mb(c.bytes)}; nothing that looks like a key.${c.backend.length ? ` Once published it may talk to ${c.backend.join(', ')} (its backend, backend.json) and nowhere else.` : ' Once published it talks to games.fun only.'}`
          : [...c.problems, c.secrets].filter(Boolean).join(' ')));
      } catch (e) { checks.replaceChildren(el('div', { className: 'error-box' }, e.message)); }
    }
    async function poll() {
      clearTimeout(timer);
      try { const s = await ctx.api('publish/status'); render(s); if (s.run.running || s.signIn?.state === 'waiting') timer = setTimeout(poll, 1500); }
      catch (e) { status.textContent = e.message; }
    }
    await Promise.all([poll(), loadChecks()]);
    const offs = [ctx.on('publish', () => poll()), ctx.on('game', () => loadChecks())];
    return () => { offs.forEach(off => off()); clearTimeout(timer); void last; };
  },
};
