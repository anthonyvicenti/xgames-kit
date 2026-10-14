// Verify: the checks every game must pass (gf-three's verify, run with real input in Chrome), and their evidence.
const el = (tag, attrs = {}, ...kids) => { const e = document.createElement(tag); Object.assign(e, attrs); e.append(...kids.filter(k => k != null)); return e; };

export default {
  id: 'verify',
  label: 'Verify',
  order: 20,
  async mount(root, ctx) {
    const quick = el('button', { type: 'button' }, 'Run quick verify (~2 min)');
    const full = el('button', { type: 'button', className: 'ghost' }, 'Full verify');
    const status = el('span', { className: 'muted' });
    const log = el('pre', { className: 'log', hidden: true });
    const runs = el('div');
    root.append(
      el('p', { className: 'muted' }, 'The same command your agent runs: ', el('code', {}, 'npx gamesfun verify --quick'), '. A game is done when it passes.'),
      el('div', { className: 'toolbar' }, quick, full, status), log, runs);

    let timer = null;
    async function start(isQuick) {
      try { await ctx.api('game/verify', { quick: isQuick }); ctx.toast('Verify started'); poll(); }
      catch (e) { ctx.toast(e.message, 'error'); }
    }
    quick.addEventListener('click', () => start(true));
    full.addEventListener('click', () => start(false));

    function renderRuns(list) {
      runs.replaceChildren();
      if (!list.length) { runs.append(el('p', { className: 'muted empty' }, 'No verify runs yet. Run quick verify to check the game the way your agent does.')); return; }
      list.forEach((r, i) => {
        const head = el('h3', {}, `${r.run}: ${r.pass ? 'PASS' : 'FAIL'} ${r.passed}/${r.ran}${r.skipped.length ? ` (skipped ${r.skipped.join(', ')})` : ''}${r.quick ? ' · quick' : ''}${r.seconds ? ` · ${r.seconds} s` : ''}`);
        runs.append(head);
        if (i > 2) return;
        for (const c of r.checks) {
          const st = c.ok === null ? 'skip' : c.ok ? 'pass' : 'fail';
          runs.append(el('div', { className: 'check' }, el('span', { className: `st ${st}` }, st.toUpperCase()), el('span', { className: 'mono' }, String(c.n)), el('div', {}, c.name, el('div', { className: 'detail' }, c.detail ?? ''))));
        }
        if (i === 0 && r.shots?.length) {
          const shots = el('div', { className: 'shots' });
          for (const s of r.shots.slice(0, 12)) { const a = el('a', { href: s, target: '_blank', rel: 'noopener' }, el('img', { src: s, alt: s.split('/').pop(), loading: 'lazy' })); shots.append(a); }
          runs.append(shots);
        }
      });
    }

    async function poll() {
      clearTimeout(timer);
      try {
        const v = await ctx.api('game/verify');
        quick.disabled = full.disabled = v.running;
        status.textContent = v.running ? `running since ${new Date(v.started).toLocaleTimeString()}…` : v.finished ? `last run exited ${v.code}` : '';
        log.hidden = !v.log.length;
        log.textContent = v.log.join('\n');
        log.scrollTop = log.scrollHeight;
        renderRuns(v.runs);
        if (v.running) timer = setTimeout(poll, 2000);
      } catch (e) { status.textContent = e.message; }
    }
    await poll();
    const off = ctx.on('verify', () => poll());
    return () => { off(); clearTimeout(timer); };
  },
};
