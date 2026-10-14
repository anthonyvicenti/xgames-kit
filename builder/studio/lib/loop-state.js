// The creation loop's state file (<game>/.gf-loop/state.json, schema gf-loop/2: builder/loop/state.mjs), as a person
// reads it. loopView is the one reader of that shape; if the shape moves, only it changes. No DOM (the page draws it:
// builder/studio/loop-panel.js; tests/studio-page.test.mjs reads it in node).

const STEP_WORDS = {
  ledger: 'Writing down what you asked for', foundation: 'Choosing what runs it, how it plays and how it feels',
  pitch: 'Choosing a pitch', spec: 'Checking the plan', create: 'Making the game folder', look: 'Choosing the look', build: 'Your session is writing the game',
  fix: 'Applying automatic fixes', economy: 'Checking the economy', backend: 'Checking the backend', verify: 'Running the six gates',
  playtest: 'The play-tester is playing', read: 'A second reader is reading it against your words',
  repair: 'Your session is repairing what failed', ask: 'Questions for you', deliver: 'Handing the game over', done: 'Finished',
};
const STATUS_WORDS = { building: 'Building', 'waiting-on-creator': 'Waiting for your answer', delivered: 'Delivered', failed: 'Stopped: it did not work out', cancelled: 'Cancelled: you rolled back' };

/** A delivered outcome that is not a plain "delivered", as the status line names it (the loop library's outcomeOf). */
const OUTCOME_WORDS = {
  'delivered-with-issues': 'Delivered with issues', 'delivered-stale-proof': 'Delivered, with out-of-date proof',
  'delivered-unverified': 'Delivered without a passing verify', 'not-made': 'No game was made',
};
const ISSUES_WORDS = 'Something the game promises was not checked by anything, or the play-tester could not see it work. The ledger below says which.';

/** The stages a person follows, and the loop steps each holds. */
export const STAGES = [
  { id: 'ledger', label: 'Ledger', steps: ['ledger'] },
  { id: 'foundation', label: 'Foundation', steps: ['foundation'] },
  { id: 'pitch', label: 'Pitch', steps: ['pitch'] },
  { id: 'spec', label: 'Spec', steps: ['spec'] },
  { id: 'look', label: 'Look', steps: ['look'] },
  { id: 'build', label: 'Build', steps: ['create', 'build', 'fix', 'repair', 'ask'] },
  { id: 'gates', label: 'Gates', steps: ['economy', 'backend', 'verify'] },
  { id: 'playtest', label: 'Play-test', steps: ['playtest'] },
  { id: 'read', label: 'Reader', steps: ['read'] },
  { id: 'deliver', label: 'Deliver', steps: ['deliver', 'done'] },
];
/** Where a loop state stands among STAGES: {index, waiting, done} (index -1: no loop here, an example or a game made by hand). */
export function stageOf(raw) {
  if (!raw || typeof raw !== 'object') return { index: -1, waiting: false, done: false };
  const at = raw.waiting?.about === 'cards' ? 'pitch' : raw.waiting?.about === 'looks' ? 'look' : raw.waiting?.about === 'migration' ? 'foundation' : raw.step;
  const index = Math.max(0, STAGES.findIndex(s => s.steps.includes(at)));
  return { index, waiting: raw.status === 'waiting-on-creator', done: raw.status === 'delivered' };
}

const text = (v, n = 400) => (typeof v === 'string' ? v.slice(0, n) : '');
const list = v => (Array.isArray(v) ? v : []);

/**
 * Raw state (or null) → what the conversation draws: where the run stands, the failures of the last verify with their
 * rule and fix, the play-tester's notes, and the loop itself (loopDetails). `said`: the delivery's outcome in words.
 */
export function loopView(raw, said = null) {
  if (!raw || typeof raw !== 'object') return { present: false };
  const outcome = raw.outcome == null ? null : typeof raw.outcome === 'object' ? raw.outcome.outcome ?? null : String(raw.outcome);
  const issues = raw.status === 'delivered' && /with-issues|stale-proof|unverified/.test(String(outcome));
  const pt = raw.playtest;
  const rounds = list(raw.rounds);
  return {
    present: true,
    status: raw.status ?? 'building',
    statusWords: (raw.status === 'delivered' && OUTCOME_WORDS[outcome]) || (raw.status === 'failed' && OUTCOME_WORDS[outcome]) || (STATUS_WORDS[raw.status] ?? String(raw.status ?? '')),
    step: raw.step ?? null,
    stepWords: STEP_WORDS[raw.step] ?? String(raw.step ?? ''),
    why: text(raw.why, 600),
    round: Number(raw.round) || 0,
    counts: { rounds: rounds.length, repairs: rounds.filter(r => r.kind === 'repair').length, specialist: rounds.filter(r => r.kind === 'specialist').length, verifies: Number(raw.verifies) || 0, playtests: Number(raw.playtests) || 0 },
    verify: raw.verify ? { n: raw.verify.n ?? null, ok: raw.verify.ok === true, at: raw.verify.at ?? null } : null,
    // the failing measures as the verdict wrote them, each with its gate, its rule and its fix
    failures: list(raw.verify?.failed).filter(f => f && typeof f === 'object').slice(0, 12).map(f => ({ gate: f.gate ?? null, measure: f.measure ?? null, detail: text(f.detail, 600), rule: text(f.rule, 300) || null, fix: text(f.fix, 300) || null })),
    playtest: pt ? { round: pt.round ?? null, ok: pt.ok === true, at: pt.at ?? null, summary: text(pt.summary, 1200), notes: playtestNotes(pt) } : null,
    waitingOn: raw.handed ? raw.handed.kind ?? raw.handed.step ?? 'your session' : null,
    history: list(raw.history).slice(-12).map(h => ({ step: h.step, next: h.next ?? null, why: text(h.why, 300), at: h.at ?? null, ...(h.ladder ? { ladder: h.ladder } : {}) })),
    outcome,
    issues,
    issuesWords: issues ? text(said?.firstWords ?? raw.outcome?.notYet, 1200) || ISSUES_WORDS : null,
    staleProof: outcome === 'delivered-stale-proof',
    updated: raw.updated ?? null,
    ...loopDetails(raw),
  };
}

/** What the play-tester said: its summary, then what it could not see, one line each. */
export function playtestNotes(pt) {
  const out = [];
  for (const [id, a] of Object.entries(pt?.answers ?? {})) if (a?.status && a.status !== 'seen') out.push(`${id} ${a.status}${a.note ? `: ${text(a.note, 200)}` : ''}`);
  return [...list(pt?.feel).map(f => text(f, 200)), ...out].slice(0, 12);
}

const HOME_WORDS = { exists: 'the kit has it', build: 'this game builds it', probe: 'a short try decides', cut: 'you cut it' };
/**
 * The loop as the person follows it: the ledger (their words, each line's home, how it stands at delivery and the
 * second reader's mark), the foundation and why, the ladder, the promises and what proves each, the second reader's
 * findings, and the optional parts (an economy, a backend).
 */
export function loopDetails(raw) {
  const o = raw?.outcome && typeof raw.outcome === 'object' ? raw.outcome : null;
  const ledger = raw?.change?.ledger ?? raw?.ledger ?? null;
  const delivered = new Map(list(o?.ledger?.rows).map(r => [r.id, r]));
  const reading = raw?.reading?.status === 'read' ? raw.reading : null;
  const lines = list(ledger?.rows).map(r => {
    const d = delivered.get(r.id), mark = reading?.rows?.[r.id] ?? null;
    const home = r.cut ? 'cut' : r.home;
    return { id: r.id, about: r.about, words: r.words ?? null, what: text(r.what, 200), home, homeWords: HOME_WORDS[home] ?? home, by: r.by ?? null, how: text(r.how, 200) || null, core: !!r.core, asked: !!r.asked,
      ...(r.cut ? { cutBy: r.cut.words } : {}), status: d?.status ?? null, ...(mark ? { reader: { mark: mark.mark, why: text(mark.why, 300) } } : {}) };
  });
  const f = raw?.foundation;
  const foundation = f ? { runtime: f.runtime, profile: f.profile ?? null, place: f.profile ? `${f.runtime}/${f.profile}` : f.runtime, loop: f.loop, kind: f.kind,
    why: { runtime: text(f.why?.runtime, 400), loop: text(f.why?.loop, 400), kind: text(f.why?.kind, 400) }, said: list(f.said).map(s => text(s, 400)).slice(0, 8) } : null;
  const L = raw?.ladder;
  const climbs = [...list(raw?.ladders), L].filter(Boolean).flatMap(l => list(l.climbs)).map(c => ({ rung: c.rung, reason: c.reason, skipped: c.skipped ?? null, areas: c.areas ?? null }));
  const ladder = { rung: L?.rung ?? null, strong: !!L?.strong, owed: list(L?.queue).map(q => q.area ? `${q.kind}: ${q.area}` : q.kind), climbs, failing: list(L?.sets).at(-1)?.items?.map(i => i.key) ?? [] };
  // a promise's standing: settled at delivery, else the play-tester's last word, else not played yet
  const settled = new Map(list(o?.promiseLedger?.promises).map(p => [p.id, p.status]));
  const answers = raw?.playtest?.answers ?? {};
  const promises = list(raw?.promises).map(p => ({ id: p.id, kind: p.kind, row: p.row ?? null, text: text(p.text, 300), core: !!p.core,
    status: settled.get(p.id) ?? (answers[p.id]?.status === 'seen' ? 'seen' : answers[p.id]?.status ?? null) }));
  const r = raw?.reading;
  const reader = !r ? (o?.reader ?? null) : r.status === 'read'
    ? { status: 'read', marks: countMarks(r.rows), findings: list(r.findings).map(x => text(x, 300)), summary: text(r.summary, 800), words: text(o?.reader?.words, 1200) || null, intent: o?.reader?.intent ?? null }
    : { status: r.status, why: text(r.why, 600) };
  const parts = {};
  for (const part of ['economy', 'backend']) {
    const decided = raw?.parts?.[part], check = raw?.partChecks?.[part], at = o?.[part];
    if (!decided && !check && !at) continue;
    parts[part] = { ...(decided ? { kept: !!decided.kept, by: decided.by ?? null, option: decided.option ?? decided.words ?? null } : {}), ...(check ? { check: { ok: !!check.ok, problems: list(check.problems).slice(0, 6).map(p => `${p.code}: ${text(p.message, 200)}`) } } : {}), ...(at ? { state: at.state, words: text(at.words, 800), link: at.link ?? null } : {}) };
  }
  return { lines, cut: lines.filter(l => l.home === 'cut').length, foundation, ladder, promises, reader, parts };
}
const countMarks = rows => { const c = { kept: 0, partly: 0, lost: 0, 'cannot-tell': 0 }; for (const v of Object.values(rows ?? {})) if (v?.mark in c) c[v.mark]++; return c; };
