// The Backend tab's Supabase panel (the panel seam: builder/studio/tabs/backend.js). One button, "Connect Supabase": the kit signs
// the person in to Supabase in their browser (games.fun's app, through games.fun's route), picks or makes the project,
// adds the game's tables with row-level security, writes backend.json and gf/backend/, checks the project and, when the
// box is ticked, adds Supabase's MCP server to their agents. The steps run in the dev server
// (builder/lib/backend/supabase-connect.mjs, the same code as `gamesfun backend connect supabase`); builder/studio/tabs/backend/flow-ui.js
// draws them. Other ways stay one click away: through the person's agent, a pasted URL and key, a personal access token.
import { sessionApi } from '../../lib/session-client.js';
import { connection } from '../../lib/session.js';
import { mountFlow } from './flow-ui.js';

export default {
  id: 'supabase',
  async mount(root, ctx) {
    const { el, line, provider: prov, game } = ctx;
    const api = (p, b) => ctx.api(`backend/supabase/${p}`, b);
    const parts = [];
    const steps = () => el('ol', { className: 'timeline' }, ...prov.agent.steps.map(s => el('li', {}, s)));

    /** The agent's way, one button: the person's session when one is connected, else their agents and the steps. */
    async function agentWay(said) {
      try {
        if (connection(await sessionApi('queue')).state === 'none') throw new Error('no session');
        const { text } = await ctx.api('backend/request', { provider: 'supabase' });
        if (ctx.chat?.send) await ctx.chat.send(text); else await sessionApi('request', { text });
        said.replaceChildren(line('ok', 'Asked your session. It adds Supabase\'s MCP server and tells you how to sign in: your browser opens Supabase, you sign in and allow access to your organization.'));
      } catch {
        try {
          const r = await api('add-mcp', {});
          said.replaceChildren(...(r.agents.some(a => a.status !== 'not installed')
            ? r.agents.filter(a => a.status !== 'not installed').map(a => line(a.status === 'failed' ? 'bad' : 'ok', `${a.name}: ${a.status}. ${['added', 'already added'].includes(a.status) ? a.signIn : a.output ?? ''}`))
            : [line('warn', 'No session is connected to this page, and no Claude Code or Codex was found. With another agent:'), steps()]));
        } catch (e) { said.replaceChildren(line('warn', `No session is connected to this page (${e.message}). Follow these steps:`), steps()); }
      }
    }

    /** "Connected", with the project, its dashboard and what reached the agents. */
    function connected(r, box) {
      box.append(el('b', {}, 'Connected. '), `${r.project.name}${r.project.organization ? ` (${r.project.organization})` : ''}. `,
        el('a', { href: r.dashboard, target: '_blank', rel: 'noopener' }, 'Open it in the Supabase dashboard'),
        el('div', { className: 'muted small' }, `${r.tables.length ? `Tables: ${r.tables.map(t => t.file.split('/').pop().replace(/^\d+_/, '').replace(/\.sql$/, '')).join(', ')}. ` : ''}${r.check.ok ? 'Row-level security: checked on the project.' : 'Row-level security: see the check above.'}${r.dbPassword ? ` The database password was ${r.dbPassword}.` : ''}`),
        ...r.agents.filter(a => a.status !== 'not installed').map(a => el('div', { className: 'muted small' }, `${a.name}: ${a.status}${a.file ? ` (${a.file})` : ''}.${a.status === 'added' ? ` ${a.use}` : a.output ? ` ${a.output}` : ''}`)));
    }

    if (!game.connected) {
      const agents = el('input', { type: 'checkbox', checked: true, 'aria-label': 'Add Supabase to my agents' });
      parts.push(el('p', { className: 'muted small' }, prov.about),
        el('p', { className: 'small flow-intro' }, 'Your browser opens Supabase: sign in and allow games.fun. The kit does the rest: the project, the game\'s tables with row-level security, backend.json, and a check. Only public values reach the game.'));
      root.replaceChildren(...parts);
      const flowBox = el('div');
      root.append(flowBox);
      const flow = mountFlow(flowBox, ctx, {
        base: 'backend/supabase/one-button', button: 'Connect Supabase',
        body: () => ({ addToAgents: agents.checked }),
        extra: [el('label', { className: 'muted small' }, agents, ' Add Supabase to my agents (Claude Code, Codex)')],
        agentWay, connected, onDone: () => ctx.refresh(), hideOldResult: true,
      });

      // ---- other ways
      const said = el('div', { 'aria-live': 'polite' });
      const viaAgent = el('button', { type: 'button', className: 'ghost' }, 'Connect through your agent');
      viaAgent.addEventListener('click', async () => { viaAgent.disabled = true; try { await agentWay(said); } finally { viaAgent.disabled = false; } });
      const url = el('input', { type: 'url', placeholder: 'https://<ref>.supabase.co', 'aria-label': 'Project URL' });
      const key = el('input', { type: 'text', placeholder: 'sb_publishable_…', 'aria-label': 'Publishable key', autocomplete: 'off', spellcheck: false });
      const write = el('button', { type: 'button', className: 'ghost' }, 'Use these');
      const wrote = el('div', { 'aria-live': 'polite' });
      write.addEventListener('click', async () => {
        try { await ctx.api('backend/use', { provider: 'supabase', url: url.value.trim(), key: key.value.trim() }); key.value = ''; ctx.refresh(); } catch (e) { wrote.replaceChildren(line('bad', e.message)); }
      });
      const pat = el('input', { type: 'password', placeholder: 'sbp_…', 'aria-label': 'Personal access token', autocomplete: 'off' });
      const save = el('button', { type: 'button', className: 'ghost' }, 'Save token');
      const saved = el('div', { 'aria-live': 'polite' });
      save.addEventListener('click', async () => { try { await api('token', { token: pat.value }); pat.value = ''; saved.replaceChildren(line('ok', 'Saved. Press Connect Supabase: it uses this sign-in.')); } catch (e) { saved.replaceChildren(line('bad', e.message)); } });
      root.append(el('details', { className: 'other-ways' }, el('summary', {}, 'Other ways to connect'),
        el('h3', {}, 'Through your agent'),
        el('p', { className: 'muted small' }, 'Your agent adds Supabase\'s MCP server; you sign in from the agent. Nothing goes through games.fun.'),
        el('div', { className: 'toolbar' }, viaAgent), said,
        el('details', {}, el('summary', {}, 'Paste the URL and publishable key yourself'),
          el('p', { className: 'muted small' }, 'From your project in the Supabase dashboard: Project settings → API keys. Only the publishable (or anon) key: a secret one is refused.'),
          el('div', { className: 'row' }, el('span', {}, 'Project URL'), el('div', { className: 'edit' }, url)),
          el('div', { className: 'row' }, el('span', {}, 'Publishable key'), el('div', { className: 'edit' }, key)),
          el('div', { className: 'toolbar' }, write), wrote),
        el('details', {}, el('summary', {}, 'Sign in with a personal access token'),
          el('p', { className: 'muted small' }, 'A token from supabase.com/dashboard/account/tokens. The kit keeps it in your system\'s keychain, or a private file in your user folder; never in the game.'),
          el('div', { className: 'toolbar' }, pat, save), saved)));
      return () => flow.cleanup();
    }

    // ---- connected: what the button did (when it was the button), the agents, the project's own check
    const s = game.settings;
    const ref = s?.project?.ref;
    const box = el('div');
    parts.push(box);
    const flow = mountFlow(box, ctx, { base: 'backend/supabase/one-button', button: null, body: () => ({ addToAgents: false }), agentWay, connected, onDone: () => ctx.refresh() });
    if (ref) parts.push(el('p', { className: 'small' }, el('a', { href: `https://supabase.com/dashboard/project/${ref}`, target: '_blank', rel: 'noopener' }, 'Open the project in the Supabase dashboard')));

    const agentsBox = el('div', { 'aria-live': 'polite' });
    const agentNote = el('div', { 'aria-live': 'polite' });
    parts.push(el('h3', {}, 'Your agents'), agentsBox, agentNote);
    const paintAgents = list => {
      if (list.length) {
        const remove = el('button', { type: 'button', className: 'ghost small' }, 'Remove from my agents');
        remove.addEventListener('click', async () => {
          remove.disabled = true;
          try {
            const r = await ctx.api('backend/agents/remove', {});
            agentNote.replaceChildren(...r.agents.map(a => line(a.status === 'failed' ? 'bad' : a.status === 'left' ? 'warn' : 'ok', `${a.name}: ${a.status} (${a.file})${a.output ? `. ${a.output}` : ''}`)));
            paintAgents([]);
          } catch (e) { agentNote.replaceChildren(line('bad', e.message)); remove.disabled = false; }
        });
        agentsBox.replaceChildren(...list.map(a => el('div', { className: 'check-line ok' }, `${a.name}: Supabase's MCP server for this project, in `, el('code', {}, a.file), ` (${a.scope} scope).`)),
          el('div', { className: 'toolbar' }, remove));
      } else {
        const add = el('button', { type: 'button', className: 'ghost small' }, 'Add Supabase to my agents');
        add.disabled = !ref;
        add.addEventListener('click', async () => {
          add.disabled = true;
          try {
            const r = await api('agents/add', {});
            agentNote.replaceChildren(...(r.agents.some(a => a.status !== 'not installed') ? r.agents.filter(a => a.status !== 'not installed').map(a => line(a.status === 'failed' ? 'bad' : a.status === 'added' ? 'ok' : 'warn', `${a.name}: ${a.status} (${a.file}).${a.status === 'added' ? ` ${a.use}` : a.output ? ` ${a.output}` : ''}`)) : [line('warn', 'No Claude Code or Codex on this computer.')]));
            paintAgents(r.added ?? []);
          } catch (e) { agentNote.replaceChildren(line('bad', e.message)); add.disabled = false; }
        });
        agentsBox.replaceChildren(el('p', { className: 'muted small' }, 'Give your agents Supabase\'s MCP server for this project, so they can read the tables and write new ones. Each agent signs in to Supabase itself the first time.'), el('div', { className: 'toolbar' }, add));
      }
    };
    paintAgents(game.agents ?? []);

    const signed = prov.status?.signedIn;
    const note = el('div', { 'aria-live': 'polite' });
    if (signed) {
      const live = el('button', { type: 'button', className: 'ghost small' }, 'Check the project again');
      live.addEventListener('click', async () => {
        try { const r = await api('check-live'); note.replaceChildren(line(r.ok ? 'ok' : 'bad', r.ok ? 'The project: every table has row-level security.' : 'The project:'), ...r.refused.map(x => line('bad', x)), ...r.warned.map(x => line('warn', x))); } catch (e) { note.replaceChildren(line('bad', e.message)); }
      });
      const out = el('button', { type: 'button', className: 'ghost small danger' }, 'Sign the kit out of Supabase');
      out.addEventListener('click', async () => { await ctx.api('backend/disconnect', { provider: 'supabase' }); ctx.refresh(); });
      parts.push(el('h3', {}, 'The kit\'s Supabase sign-in'), el('p', { className: 'muted small' }, `Signed in (${signed.kind === 'pat' ? 'a personal access token' : 'through games.fun\'s app'}); kept on this computer, never in the game.`), el('div', { className: 'toolbar' }, live, out), note);
    }
    root.replaceChildren(...parts);
    return () => flow.cleanup();
  },
};
