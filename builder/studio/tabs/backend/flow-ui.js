// A provider's one button in the Backend tab: the button, then each step as it happens (a clock on the one under way),
// the one question the flow is waiting on, and the end: "Connected", or the error in words with what to do next.
// The flow runs in the dev server (builder/lib/backend/flow.mjs, …/supabase-connect.mjs, …/railway-connect.mjs); this page only
// polls its state (GET <base>), starts it (POST <base>), answers (POST <base>/answer) and cancels (POST <base>/cancel).
//
// The sign-in tab is opened in the click itself (a blank tab, pointed at the sign-in link once the dev server has it),
// so no popup blocker stops it. A question that needs a new tab ("Try localhost") does the same in its own click.
const MARK = { todo: '○', doing: '●', done: '✓', skipped: '–', warn: '!', failed: '✕' };
const clock = s => (s == null ? '' : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`);

/**
 * mountFlow(root, ctx, opts) → { start(body), cleanup() }
 * opts: base ('backend/supabase/one-button'), button (its words), body() (what Start sends), intro (a node or null),
 *       agentWay() (optional: the "Connect through your agent" fallback), connected(result, el) (draws the end),
 *       onDone(result) (after a success), extra (nodes under the button, e.g. the agents checkbox), hideOldResult
 *       (do not show a finished run's "Connected" when the panel opens: the game has no backend now)
 */
export function mountFlow(root, ctx, opts) {
  const { el, line } = ctx;
  const api = (p = '', b) => ctx.api(`${opts.base}${p}`, b);
  const go = el('button', { type: 'button', className: 'flow-go' }, opts.button);
  go.dataset.testid = 'flow-go';
  const steps = el('ol', { className: 'flow-steps', hidden: true, 'aria-live': 'polite' });
  const question = el('div', { className: 'flow-question', hidden: true });
  const end = el('div', { 'aria-live': 'polite' });
  const foot = el('div');
  // a panel with nothing to start (already connected) shows only what the last run did. What needs the person (a
  // question, the end) sits right under the button; the steps follow.
  if (opts.button) root.append(el('div', { className: 'toolbar' }, go, ...(opts.extra ?? [])));
  // once connected, the steps fold under one line (they stay open while the flow runs, and after an error)
  const fold = el('details', { className: 'flow-fold', open: true }, el('summary', {}, 'What the kit did'), steps);
  root.append(question, end, fold, foot);

  let timer = null, stopped = false, asked = null, wasRunning = false, opened = null;
  const openTab = () => { const t = window.open('about:blank', '_blank'); if (t) t.opener = null; return t; };
  const point = (tab, s) => {
    if (!tab) return;
    if (s.link && s.link !== opened) { opened = s.link; tab.location.href = s.link; } else if (!s.link) tab.close();
  };

  function drawSteps(s) {
    steps.hidden = !s.steps.length;
    fold.hidden = !s.steps.length;
    fold.open = !!s.running || !s.result;
    fold.querySelector('summary').hidden = !!s.running || !s.result;
    steps.replaceChildren(...s.steps.map(x => {
      const li = el('li', {}, el('span', { className: 'mark', 'aria-hidden': 'true' }, MARK[x.state] ?? '○'),
        el('span', { className: 'label' }, x.label),
        el('span', { className: 'clock' }, x.state === 'doing' ? clock(x.seconds) : ''),
        x.detail ? el('span', { className: 'detail' }, x.detail) : null);
      li.dataset.state = x.state;
      li.dataset.step = x.id;
      return li;
    }));
  }

  const answer = async (q, value, { tab = null } = {}) => {
    try { const s = await api('/answer', { id: q.id, answer: value }); point(tab, s); draw(s); poll(); } catch (e) { tab?.close(); end.replaceChildren(line('bad', e.message)); }
  };
  const btn = (text, onclick, cls = '') => Object.assign(el('button', { type: 'button', className: cls }, text), { onclick });
  const links = list => (list?.length ? el('p', { className: 'small' }, ...list.flatMap((l, i) => [i ? ' · ' : null, el('a', { href: l.url, target: '_blank', rel: 'noopener' }, l.label)])) : null);

  const put = (...kids) => question.replaceChildren(...kids.filter(k => k != null && k !== false));
  function drawQuestion(q) {
    if (!q) { question.hidden = true; question.replaceChildren(); asked = null; return; }
    if (asked === q.id) return;                     // keep what the person is typing
    asked = q.id;
    question.hidden = false;
    requestAnimationFrame(() => question.scrollIntoView?.({ block: 'nearest' }));
    question.dataset.kind = q.kind;
    const title = el('p', { className: 'flow-q-title' }, q.title);
    if (q.kind === 'signing-in') {
      const parts = [title, el('p', { className: 'small muted' }, 'The tab did not open? ', el('a', { href: q.link, target: '_blank', rel: 'noopener' }, 'Open the sign-in'), '.')];
      const acts = [btn('Cancel', () => answer(q, { cancel: true }), 'ghost small')];
      if (q.other) {
        parts.push(el('p', { className: 'small muted' }, q.hint));
        acts.unshift(btn(`Try ${q.other} instead`, () => answer(q, { host: q.other }, { tab: openTab() }), 'ghost small'));
      }
      put(...parts, el('div', { className: 'toolbar' }, ...acts));
      return;
    }
    if (q.kind === 'project' || q.kind === 'full') {
      const rows = q.projects.map(p => el('div', { className: 'row' },
        el('span', {}, p.name, el('small', {}, [p.organizationName, p.region, p.paused ? 'paused' : null].filter(Boolean).join(' · '))),
        el('div', { className: 'edit' }, btn(p.paused ? 'Restore and use' : 'Use', () => answer(q, { project: p.ref }), 'small'))));
      put(title, ...(q.body ? [el('p', { className: 'small muted' }, q.body)] : []), ...rows,
        ...(q.canCreate ? [el('div', { className: 'toolbar' }, btn('Make a new project for this game', () => answer(q, { create: true }), 'ghost'))] : []), links(q.links));
      return;
    }
    if (q.kind === 'paused') {
      put(title, el('div', { className: 'toolbar' }, btn('Restore it', () => answer(q, { restore: true })), btn('Pick another', () => answer(q, { other: true }), 'ghost')), links(q.links));
      return;
    }
    if (q.kind === 'create') {
      const name = el('input', { type: 'text', value: q.defaults.name, 'aria-label': 'Project name', maxLength: 64 });
      const org = el('select', { 'aria-label': 'Organization' }, ...q.organizations.map(o => el('option', { value: o.slug, selected: o.slug === q.defaults.organization }, o.name)));
      const region = el('select', { 'aria-label': 'Region' }, ...q.regions.map(r => el('option', { value: r.value, selected: r.value === q.defaults.region }, r.label)));
      org.addEventListener('change', async () => {
        try { const r = await ctx.api(`backend/supabase/regions?org=${encodeURIComponent(org.value)}`); region.replaceChildren(...r.regions.map((x, i) => el('option', { value: x.value, selected: i === 0 }, x.label))); } catch (e) { end.replaceChildren(line('bad', e.message)); }
      });
      const make = btn('Make it', () => { make.disabled = true; answer(q, { name: name.value.trim() || q.defaults.name, organization: org.value, region: region.value }); });
      put(title,
        el('div', { className: 'row' }, el('span', {}, 'Name'), el('div', { className: 'edit' }, name)),
        ...(q.organizations.length > 1 ? [el('div', { className: 'row' }, el('span', {}, 'Organization'), el('div', { className: 'edit' }, org))] : []),
        el('div', { className: 'row' }, el('span', {}, 'Region'), el('div', { className: 'edit' }, region)),
        el('p', { className: 'small muted' }, 'Free plan: 2 active projects; a free project pauses after a week with no use. The database password is made for you and kept on this computer.'),
        el('div', { className: 'toolbar' }, make, ...(q.canPick ? [btn('Back to my projects', () => answer(q, { back: true }), 'ghost')] : [])));
      return;
    }
    if (q.kind === 'workspace') {
      const ws = el('select', { 'aria-label': 'Workspace' }, ...q.workspaces.map(w => el('option', { value: w.id }, w.name)));
      put(title, el('div', { className: 'toolbar' }, ws, btn('Use this workspace', () => answer(q, { workspace: ws.value }))));
      return;
    }
    put(title);
  }

  function draw(s) {
    drawSteps(s);
    drawQuestion(s.running ? s.question : null);
    go.disabled = !!s.running;
    if (s.running) {
      const cancel = btn('Cancel', async () => { cancel.disabled = true; try { draw(await api('/cancel', {})); } catch (e) { end.replaceChildren(line('bad', e.message)); } }, 'ghost small');
      foot.replaceChildren(el('div', { className: 'toolbar end' }, cancel));
      end.replaceChildren();
      wasRunning = true;
      return;
    }
    foot.replaceChildren();
    if (s.error) {
      // the page's next step: again (or sign in again); when games.fun's route is not there, the agent's way first
      const said = el('div', { 'aria-live': 'polite' });
      const again = btn(s.error.signIn ? 'Sign in again' : 'Try again', () => start({ signInAgain: !!s.error.signIn }));
      const acts = s.error.fallback === 'agent' && opts.agentWay
        ? [btn('Connect through your agent', () => opts.agentWay(said)), Object.assign(again, { className: 'ghost' })]
        : [again];
      end.replaceChildren(el('div', { className: `check-line ${s.error.code === 'CANCELLED' ? 'warn' : 'bad'}` }, el('b', {}, s.error.code === 'CANCELLED' ? 'Stopped. ' : 'Not connected. '), s.error.message, links(s.error.links)),
        el('div', { className: 'toolbar' }, ...acts), said);
      end.firstChild.dataset.testid = 'flow-error';
      return;
    }
    if (s.result) {
      const box = el('div', { className: 'check-line ok' });
      box.dataset.testid = 'flow-connected';
      opts.connected(s.result, box);
      end.replaceChildren(box);
      if (wasRunning) { wasRunning = false; opts.onDone?.(s.result); }
      return;
    }
    end.replaceChildren();
  }

  let first = true;
  async function poll() {
    clearTimeout(timer);
    if (stopped) return;
    let s;
    try { s = await api(); } catch (e) { end.replaceChildren(line('bad', e.message)); return; }
    // a panel for a game with no backend does not show an earlier run's "Connected" (that backend was removed since)
    if (first && opts.hideOldResult && !s.running && s.result) { first = false; return; }
    first = false;
    draw(s);
    if (s.running) timer = setTimeout(poll, 1000);
  }

  async function start(body = {}) {
    first = false;
    const tab = openTab();
    go.disabled = true;
    end.replaceChildren();
    opened = null;
    try { const s = await api('', { ...(opts.body?.() ?? {}), ...body }); point(tab, s); draw(s); poll(); }
    catch (e) { tab?.close(); go.disabled = false; end.replaceChildren(line('bad', e.message)); }
  }
  go.addEventListener('click', () => start());
  poll();
  return { start, cleanup: () => { stopped = true; clearTimeout(timer); } };
}
