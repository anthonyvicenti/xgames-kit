// Backend (optional): a game needs none, and with none this tab is one quiet line and one button, "Add a backend
// (optional)". Picking a provider mounts its panel (builder/studio/tabs/backend/<id>.js, listed by /api/backend/status; the
// provider shape is builder/lib/backend/providers.mjs). With a backend connected: what it is, the provider's panel, and the
// checks (no secrets in the game, row-level security on every table).
//
// A panel module exports `default { id, mount(el, pctx) }`; pctx is this tab's ctx plus { provider (its status
// entry), game (the game's backend status), refresh(), line(tone, text), el }. mount may return a cleanup function.
//
// A tool of the studio's layout (docs/ARCHITECTURE.md): in the Launch group after Publish and before Economy, in the
// inspector beside the game. It asks the person's session only through the conversation (ctx.chat.ask / send); a page
// with no conversation (a test page) has no ctx.chat, and the tab then only says what to ask.
const el = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) (k in e && k !== 'list') ? (e[k] = v) : e.setAttribute(k, v);
  e.append(...kids.filter(k => k != null && k !== false));
  return e;
};
const line = (tone, text) => el('div', { className: `check-line ${tone}` }, text);

export default {
  id: 'backend',
  label: 'Backend',
  group: 'Launch',
  order: 35,                     // Publish is 30, Economy 40 (web3 keeps Economy last)
  icon: '<path d="M4.5 5.5a7.5 2.5 0 1 0 15 0a7.5 2.5 0 1 0-15 0"/><path d="M4.5 5.5v13c0 1.4 3.4 2.5 7.5 2.5s7.5-1.1 7.5-2.5v-13"/><path d="M4.5 12c0 1.4 3.4 2.5 7.5 2.5s7.5-1.1 7.5-2.5"/>',
  async mount(root, ctx) {
    let cleanup = null, picked = null;
    const body = el('div');
    root.append(body);

    async function mountPanel(where, prov, status) {
      cleanup?.(); cleanup = null;
      if (!prov.panel) { where.replaceChildren(el('ol', { className: 'timeline' }, ...prov.agent.steps.map(s => el('li', {}, s)))); return; }
      try {
        const mod = (await import(prov.panel)).default;
        cleanup = await mod.mount(where, { ...ctx, provider: prov, game: status.game, refresh: paint, line, el }) ?? null;
      } catch (e) { where.replaceChildren(el('p', { className: 'error-box' }, `${prov.panel} did not load: ${e.message}`)); }
    }

    async function checks(box, kind) {
      let c;
      try { c = await ctx.api('backend/check'); } catch (e) { box.replaceChildren(line('bad', e.message)); return; }
      const secrets = line(c.scan.ok ? 'ok' : 'bad', c.scan.ok ? `No secrets in the game's ${c.scan.files} files.` : `Secrets in the game's files: ${c.scan.hits.map(h => `${h.file}: ${h.kind}`).join('; ')}`);
      // a server (Railway) has no tables of the game's: only the secrets line
      if (kind === 'server') { box.replaceChildren(secrets); return; }
      box.replaceChildren(
        secrets,
        line(c.rls.ok ? 'ok' : 'bad', c.rls.migrations.length || c.rls.used.length ? `Row-level security: ${c.rls.ok ? 'on every table' : 'refused'} (${c.rls.migrations.length} migration${c.rls.migrations.length === 1 ? '' : 's'}; the game reads ${c.rls.used.join(', ') || 'no table'}).` : 'No tables yet. Ask your session for one, for example "a high-score table" or "save each player\'s progress".'),
        ...c.rls.refused.map(r => line('bad', r)), ...c.rls.warned.map(w => line('warn', w)));
      // a table is the session's work: ask it in the conversation's one box, with this backend as the chip
      if (ctx.chat?.ask) {
        const ask = el('button', { type: 'button', className: 'ghost small' }, c.rls.migrations.length ? 'Ask my session for another table' : 'Ask my session for a table');
        ask.addEventListener('click', () => ctx.chat.ask({
          label: 'Backend',
          placeholder: 'e.g. a high-score table, or save each player\'s progress',
          compose: words => `For this game's backend (backend.json): ${words}. Follow the gamesfun-backend skill: a migration in supabase/migrations/ with row-level security on every table, the game reaches it only through gf/backend/, then npx gamesfun backend check passes.`,
          button: 'Ask my session',
        }));
        box.append(el('div', { className: 'toolbar' }, ask));
      }
    }

    async function paint() {
      let s;
      try { s = await ctx.api('backend/status'); } catch (e) { body.replaceChildren(el('p', { className: 'error-box' }, e.message)); return; }
      const set = s.game.settings;
      if (set) {
        const prov = s.providers.find(p => p.id === set.provider);
        const panel = el('div'), checkBox = el('div');
        const remove = el('button', { type: 'button', className: 'ghost small danger' }, 'Remove the backend from this game');
        remove.addEventListener('click', async () => {
          if (!confirm('Remove backend.json and gf/backend/ from this game? The database itself is not touched.')) return;
          await ctx.api('backend/disconnect', { provider: set.provider, fromGame: true }).catch(e => ctx.toast(e.message, 'error'));
          picked = null; paint();
        });
        body.replaceChildren(
          el('div', { className: 'check-line ok' }, el('b', {}, `${prov?.label ?? set.provider}: `), `${set.project?.name ? `${set.project.name} · ` : ''}${set.url}`,
            el('div', { className: 'muted small' }, `${set.keyKind ? `${set.keyKind === 'publishable' ? 'publishable' : 'anon'} key in backend.json · ` : ''}client at ${s.game.client ?? 'gf/backend/ (missing: connect again)'}`)),
          el('h3', {}, 'Checks'), checkBox, panel, el('div', { className: 'toolbar end' }, remove));
        await checks(checkBox, prov?.kind);
        if (prov) await mountPanel(panel, prov, s);
        return;
      }
      if (s.game.settingsError) body.replaceChildren(el('p', { className: 'error-box' }, s.game.settingsError));
      if (!picked) {
        // no backend: the default. One quiet line and one button.
        const add = el('button', { type: 'button', className: 'ghost' }, 'Add a backend (optional)');
        add.addEventListener('click', () => { picked = 'choose'; paint(); });
        body.replaceChildren(...(s.game.settingsError ? [el('p', { className: 'error-box' }, s.game.settingsError)] : []),
          el('p', { className: 'muted' }, 'This game runs in the browser with no backend, and that is fine. Add one when it needs scores, saves, accounts or a server of its own.'),
          el('div', { className: 'toolbar' }, add));
        return;
      }
      if (picked === 'choose') {
        const back = el('button', { type: 'button', className: 'ghost small' }, 'Not now');
        back.addEventListener('click', () => { picked = null; paint(); });
        body.replaceChildren(el('p', { className: 'muted' }, 'Pick where the game\'s backend lives. It is your own account and your own bill; the game carries only public values.'),
          ...s.providers.map(p => {
            const go = el('button', { type: 'button' }, `Use ${p.label}`);
            go.addEventListener('click', () => { picked = p.id; paint(); });
            return el('div', { className: 'card' }, el('h4', {}, p.label, ' ', el('span', { className: 'chip' }, p.kind === 'database' ? 'database' : 'server')), el('p', { className: 'muted small' }, p.about), el('div', { className: 'toolbar' }, go));
          }), el('div', { className: 'toolbar end' }, back));
        return;
      }
      const prov = s.providers.find(p => p.id === picked);
      const panel = el('div');
      const back = el('button', { type: 'button', className: 'ghost small' }, 'Back');
      back.addEventListener('click', () => { picked = 'choose'; paint(); });
      body.replaceChildren(el('h3', {}, prov?.label ?? picked), panel, el('div', { className: 'toolbar end' }, back));
      if (prov) await mountPanel(panel, prov, s);
    }

    await paint();
    const off = ctx.on?.('backend', () => paint());
    return () => { off?.(); cleanup?.(); };
  },
};
