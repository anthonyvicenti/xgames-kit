// One button, many steps: the machinery a provider's "Connect …" flow runs on, shared by the studio (which polls the
// run's state and answers its questions from the page) and the terminal (which prints the steps and answers from flags
// or a prompt). The flow itself is the provider's (builder/lib/backend/supabase-connect.mjs, builder/lib/backend/railway-connect.mjs);
// this file only keeps what the person sees: the steps in order, each one's state and words, the one question waiting
// for an answer, and the end (a result, or an error in plain words).
//
// A flow is `async (h) => result`, where h is:
//   h.start(id, detail?)     the step is under way (the page shows a clock from now)
//   h.note(id, detail)       new words for a step under way (a status, "COMING_UP")
//   h.done(id, detail?)      finished;  h.skip(id, why) not needed;  h.warn(id, detail) finished with a warning
//   h.ask(question)          → Promise of the answer: { id, kind, title, … } (the page draws it, the CLI asks)
//   h.retract()              take the open question back (what it waited for happened by itself)
//   h.link(url)              the sign-in link the person's browser should open (the page opens it in a new tab)
//   h.signal                 aborted when the person cancels
// A step's state: todo | doing | done | skipped | warn | failed.
export class FlowError extends Error {
  /** code: a word for tests and the page's choice of buttons (never shown alone); message: the person's sentence. */
  constructor(code, message, extra = {}) { super(message); this.code = code; Object.assign(this, extra); }
}

/** A thrown thing as the person reads it: { code, message, …extra }. Never a stack, never only a code. */
export function plain(e) {
  if (e instanceof FlowError) { const { code, message, ...extra } = e; return { code, message, ...extra }; }
  return { code: e?.code ?? 'FAILED', message: String(e?.message ?? e ?? 'Something went wrong.') };
}

/** Wrap fetch so an unreachable host is one sentence that names it ("Check your internet connection"). */
export function reachable(fetchImpl, label) {
  return async (url, init) => {
    try { return await fetchImpl(url, init); } catch (e) {
      if (init?.signal?.aborted) throw e;
      let host = label;
      try { host = label ?? new URL(url).host; } catch {}
      throw new FlowError('NETWORK', `Could not reach ${host}. Check your internet connection, then press Connect again.`, { cause: e?.cause?.code ?? e?.message });
    }
  };
}

/**
 * Start a run. steps: [[id, label], …]. flow: async h => result. → the run: { state, answer(qid, value), cancel(),
 * done } where state is what the page polls (plain data: steps, question, link, result, error, running).
 */
export function startRun(steps, flow, { onChange = () => {} } = {}) {
  const ac = new AbortController();
  const state = {
    running: true, startedAt: Date.now(), endedAt: null, link: null, question: null, result: null, error: null,
    steps: steps.map(([id, label]) => ({ id, label, state: 'todo', detail: null, startedAt: null, endedAt: null })),
  };
  let waiting = null, asked = 0;
  const step = id => {
    const s = state.steps.find(x => x.id === id);
    if (!s) throw new Error(`no step "${id}"`);
    return s;
  };
  const set = (id, st, detail) => {
    const s = step(id);
    if (st === 'doing' && s.state !== 'doing') s.startedAt = Date.now();
    if (['done', 'skipped', 'warn', 'failed'].includes(st)) s.endedAt = Date.now();
    s.state = st;
    if (detail !== undefined) s.detail = detail;
    onChange(state);
  };
  const h = {
    signal: ac.signal,
    start: (id, detail = null) => set(id, 'doing', detail),
    note: (id, detail) => set(id, step(id).state === 'todo' ? 'doing' : step(id).state, detail),
    done: (id, detail) => set(id, 'done', detail),
    warn: (id, detail) => set(id, 'warn', detail),
    skip: (id, why = null) => set(id, 'skipped', why),
    link: url => { state.link = url; onChange(state); },
    ask(question) {
      if (ac.signal.aborted) return Promise.reject(new FlowError('CANCELLED', 'You stopped it. Nothing more was changed.'));
      const q = { ...question, id: `q${++asked}` };
      state.question = q;
      onChange(state);
      return new Promise((resolve, reject) => { waiting = { id: q.id, resolve, reject }; });
    },
    /** Take back the open question (what it waited for happened by itself: the browser came back). */
    retract() { if (state.question) { state.question = null; waiting = null; onChange(state); } },
  };
  const done = (async () => {
    try { state.result = await flow(h); } catch (e) {
      state.error = ac.signal.aborted && !(e instanceof FlowError) ? plain(new FlowError('CANCELLED', 'You stopped it. Nothing more was changed.')) : plain(e);
      // a question the terminal cannot ask (no prompt: a script, an agent) ends the run without failing the step
      const at = state.steps.find(s => s.state === 'doing');
      if (at && state.error.code !== 'NEED') { at.state = 'failed'; at.endedAt = Date.now(); }
    } finally {
      state.running = false; state.endedAt = Date.now(); state.question = null; state.link = null; waiting = null;
      onChange(state);
    }
    return state;
  })();
  return {
    state,
    done,
    /** The page's (or the terminal's) answer to the question waiting. → false when that question is not the one waiting. */
    answer(qid, value) {
      if (!waiting || waiting.id !== qid) return false;
      const w = waiting;
      waiting = null; state.question = null;
      onChange(state);
      w.resolve(value);
      return true;
    },
    cancel() {
      ac.abort();
      if (waiting) { const w = waiting; waiting = null; w.reject(new FlowError('CANCELLED', 'You stopped it. Nothing more was changed.')); }
    },
  };
}

/** What the page polls: the state plus the clock of the step under way (seconds), so a page needs no clock of its own. */
export function snapshot(run) {
  if (!run) return { running: false, steps: [], question: null, result: null, error: null, link: null };
  const now = Date.now();
  return { ...run.state, steps: run.state.steps.map(s => ({ ...s, seconds: s.startedAt ? Math.round(((s.endedAt ?? now) - s.startedAt) / 1000) : null })) };
}
