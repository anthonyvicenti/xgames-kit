// The creation loop's order, once. The library steps through it, the MCP tools refuse a call made out of it, and the
// build-loop skill is generated from it (skill.mjs). Nothing else lists the steps.
//
//   ledger → foundation → pitch → spec → create → look → build → fix → [economy] → [backend] → verify → playtest → read → deliver
//                                                          ↑                                              │
//                                                   └── repair / ask ◄─────────────────────────────┘   (the stop rule and the ladder)
//
// economy and backend run only for a spec that keeps that part (parts.mjs); read is the second reader (reader.mjs),
// advisory: it never sends the loop back.
//
// A change request, and the creator's answer to a question, re-enter at the ledger.

export const STEPS = ['ledger', 'foundation', 'pitch', 'spec', 'create', 'look', 'build', 'fix', 'economy', 'backend', 'verify', 'playtest', 'read', 'repair', 'ask', 'deliver', 'done'];

/** The steps that are an agent round the session does itself; the round ends with gamesfun_step_fix. */
export const ROUND_STEPS = ['build', 'repair'];

/** Where a run stands. `waiting-on-creator`: the cards, a question or a migration are with the person. */
export const STATUSES = ['building', 'waiting-on-creator', 'delivered', 'failed', 'cancelled'];

/**
 * Each step, the tool that runs it, and what it does. `ends`: the tool that ends a round this step hands over (when it
 * is not the step's own tool).
 */
export const ORDER = [
  { step: 'ledger', tool: 'gamesfun_step_ledger', does: 'hands you the requirements ledger round: the essentials in the person\'s own words, each with a home (exists, build or probe); then checks the ledger you pass back. Asks the person only how friends play together and what a player is, and only when their words leave it open' },
  { step: 'foundation', tool: 'gamesfun_step_foundation', does: 'picks the runtime by hard limits (devices, graphics, camera, what must be built) from the registry\'s compatibility answers, the loop by who acts when, and the kind last, from the person\'s words and references. Hands you a bounded probe round first when a ledger line needs one; a runtime change waits for the person\'s yes to the migration' },
  { step: 'pitch', tool: 'gamesfun_step_pitch', does: 'hands you the pitch round on the foundation: 2–3 cards that each keep every line of the ledger (nothing is narrowed; only what the person cut is "not yet"). With the person\'s choice it moves on to the spec' },
  { step: 'spec', tool: 'gamesfun_step_spec', does: 'checks the cards or the spec against the ledger and the foundation; a valid spec is locked, and every "the build writes it" line becomes a promise in spec.build' },
  { step: 'create', tool: 'gamesfun_step_create', does: 'makes the game from the locked spec and hands you the build round with a one-page brief, built from the manifests of only what the spec chose' },
  { step: 'look', tool: 'gamesfun_step_look', does: 'the look before the build: the style target (the spec\'s, or read from the references and the person\'s words: a round reads the frames on a fixed rubric and you pass its answer as `judged`), then 2–3 readings of it drawn as contact sheets on the game\'s own world and bodies. The person picks one (`pick`: {option, words}); a host with no look tools goes straight on to the build' },
  { step: 'build', tool: 'gamesfun_step_fix', does: 'the build round is yours: write rules.js, src/ modules and declared overrides for every promise in spec.build, then end it with gamesfun_step_fix (summary and controls)' },
  { step: 'fix', tool: 'gamesfun_step_fix', does: 'ends your round and runs the mechanical repairs' },
  { step: 'economy', tool: 'gamesfun_step_economy', does: 'only when the person kept an economy: the kit\'s economy checker on the economy the build round saved in gamesfun.json (economy_check). A refusal is repaired like a failed gate; going live waits for the person\'s own approval at delivery' },
  { step: 'backend', tool: 'gamesfun_step_backend', does: 'only when the person kept a backend: no secret in the game\'s files and row-level security on every table (backend_check). Connecting their own account is theirs, whenever they like; the game plays in the browser until then' },
  { step: 'verify', tool: 'gamesfun_step_verify', does: 'the six gates on the files as they are; each gate names what ran, what passed and what this runtime skipped' },
  { step: 'playtest', tool: 'gamesfun_step_playtest', does: 'hands the play-tester the promise list with the controls (first call), then reads its report: each promise seen, not seen or unreachable' },
  { step: 'read', tool: 'gamesfun_step_read', does: 'the second reader: hands the reader subagent the person\'s words, the ledger, the promises with the play-tester\'s log and the captures (never the build\'s transcript or spec), then reads its marks: each line kept, partly, lost or cannot-tell. Advisory: it never sends the loop back, and its marks and findings join the delivery ledger' },
  { step: 'repair', tool: 'gamesfun_step_repair', ends: 'gamesfun_step_fix', does: 'hands you the next repair round. The stop rule holds: when a round fails on the same set as the last, or an earlier set comes back, the loop climbs the ladder (stronger model, specialist round, paid generation, questions for the person) instead of repeating' },
  { step: 'ask', tool: 'gamesfun_ask', does: 'the top of the ladder, or a plan the build round cannot start: write the person\'s questions; the run waits on their answer, which re-enters at the ledger' },
  { step: 'deliver', tool: 'gamesfun_step_deliver', does: 'hands the version over with its ledger: every line proven, failed or untested; stale proof sends the loop back to verify or the play-test' },
];

/** The ladder's rungs, in the order they are climbed. Cost never ends a build: the top rung asks the person. */
export const RUNGS = ['model', 'specialist', 'generate', 'ask'];

export const toolOf = step => ORDER.find(o => o.step === step)?.tool ?? null;
export const orderOf = step => ORDER.find(o => o.step === step) ?? null;

/**
 * What a host does with a hand-over, as data beside the message's prose (a host that is not MCP, such as Studio's
 * worker writing answer files, never parses the text). `tool` and `args` are the MCP call that takes the result;
 * `returns` is the key a runner host's agent(o) / playtester(o) result carries it under. Keyed by the round's kind,
 * or by what the person is asked.
 */
export const ACTIONS = {
  ledger: { tool: 'gamesfun_step_ledger', args: { ledger: { rows: [], asks: [] } }, returns: 'ledger' },
  amend: { tool: 'gamesfun_step_ledger', args: { ledger: { rows: [], asks: [] } }, returns: 'ledger' },
  probe: { tool: 'gamesfun_step_foundation', args: { probes: [] }, returns: 'probes' },
  pitch: { tool: 'gamesfun_step_spec', args: { pitch: { reply: '', cards: [], questions: [] } }, returns: 'pitch' },
  spec: { tool: 'gamesfun_step_spec', args: { spec: {} }, returns: 'spec' },
  build: { tool: 'gamesfun_step_fix', args: { summary: '', controls: '' }, returns: 'summary' },
  look: { tool: 'gamesfun_step_look', args: { judged: {} }, returns: 'judged' },
  looks: { tool: 'gamesfun_step_look', args: { pick: { option: '', words: '' } }, returns: 'pick' },
  ask: { tool: 'gamesfun_ask', args: { message: '', questions: [] }, returns: 'questions' },
  playtest: { tool: 'gamesfun_playtest_report', args: { token: '', report: { promises: [], feel: [], summary: '' } }, returns: 'report' },
  read: { tool: 'gamesfun_reader_report', args: { token: '', reading: { schema: 'gf-reading/1', rows: [], findings: [], summary: '' } }, returns: 'reading' },
  cards: { tool: 'gamesfun_step_pitch', args: { choice: { card: '', answers: {}, words: '' } }, returns: 'choice' },
  questions: { tool: 'gamesfun_step_ledger', args: { answer: { words: '' } }, or: { tool: 'gamesfun_step_ledger', args: { answer: { words: '', deliver: true } } }, returns: 'answer' },
  migration: { tool: 'gamesfun_step_foundation', args: { approve: '' }, or: { tool: 'gamesfun_step_foundation', args: { decline: '' } }, returns: 'approve | decline' },
};
const BUILDING = ['build', 'change', 'migrate', 'repair', 'specialist', 'generate'];
/**
 * The next action of a step's answer: {tool, args, returns, or?}. `kind` is the round's kind; a talk round handed back
 * for repair (kind 'repair' at the ledger, pitch or spec step) takes the result of that step's own round.
 */
export function actionOf({ waiting, kind = null, about = null, step = null }) {
  if (waiting === 'creator') return structuredClone(ACTIONS[about] ?? ACTIONS.questions);
  if (waiting === 'playtest') return structuredClone(ACTIONS.playtest);
  if (waiting === 'reader') return structuredClone(ACTIONS.read);
  const talk = { ledger: 'ledger', foundation: 'probe', pitch: 'pitch', spec: 'spec', look: 'look', ask: 'ask' }[step];
  if (kind === 'repair' && talk && step !== 'repair') return structuredClone(ACTIONS[talk]);
  if (BUILDING.includes(kind)) return structuredClone(ACTIONS.build);
  return structuredClone(ACTIONS[kind] ?? ACTIONS[talk] ?? ACTIONS.build);
}
