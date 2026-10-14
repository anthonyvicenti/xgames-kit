// The requirements ledger: the first thing the loop writes, before any pitch card. The agent writes the essentials in
// the creator's own words (the actions, who acts when, the perspective, the players, what a player is, the devices,
// the feel, the references), and gives each line a home:
//   exists  a part the registry has does it (`by`: mechanic:<id>, loop:<id>, runtime:<id>, kind:<id>, capability:<id>)
//   build   this game writes it (`how`: what will be written; `where`: rules | module | engine)
//   probe   a bounded probe answers first whether it exists or is built (`probe`: {question, minutes})
// Nothing in the ledger narrows the idea: a line leaves only when the creator's own words cut it (`cut.words`).
// The creator is asked only how friends play together and what a player is, and only when their words leave it open
// (a line that quotes them and still leaves part open says so: asked: true).
//
// Pure: checkLedger(ledger, {sources, registry}) → ['$.rows[2].home: …'].
import { byProblem } from './registry.mjs';
import { HOW_BUILD, quoted } from './words.mjs';

export const LEDGER_SCHEMA = 'gf-ledger/1';
export const ABOUTS = ['action', 'acts', 'perspective', 'players', 'body', 'devices', 'feel', 'reference', 'thing'];
/** One line each, always: who acts when, the perspective, how friends play, what a player is. At least one action. */
export const ONE_EACH = ['acts', 'perspective', 'players', 'body'];
export const HOMES = ['exists', 'build', 'probe'];
/** Lines the foundation answers (runtime, loop, kind): `exists` needs no `by`. */
export const FOUNDATION_ABOUTS = ['acts', 'perspective', 'players', 'body', 'devices', 'feel', 'reference'];
export const WHERE = ['rules', 'module', 'engine'];
/** The only things the creator is asked (the creator, 2026-10-11: "We should ask about multiplayer and characters if there are non obvious."). */
export const ASKABLE = ['players', 'body'];
export const PROBE_MAX_MINUTES = 30;
/** A line's words may be `default` only for these: the creator said nothing, and the kit's default stands (said plainly). */
const DEFAULTABLE = ['devices'];

/**
 * The ledger round's answer as a JSON Schema, from the registry's own words (`catalog`: the vocabulary, the loops'
 * acts, the kinds, the capabilities): a host gives it to the round as its output schema, so a value the registry does
 * not have cannot be written (found by the real builds: a home written as an object, a camera that is no camera, round
 * after round). checkLedger still holds what a schema cannot (the person's words, one line each, the questions).
 */
export function ledgerOutputSchema(catalog, { extraAsks = [] } = {}) {
  const v = catalog?.vocab ?? {}, en = xs => (Array.isArray(xs) && xs.length ? { enum: [...new Set(xs)] } : { type: 'string' });
  const row = { type: 'object', required: ['id', 'about', 'what', 'home'], properties: {
    id: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,31}$' }, about: en(ABOUTS), what: { type: 'string', maxLength: 200 },
    words: { type: ['string', 'null'] }, core: { type: 'boolean' }, asked: { type: 'boolean' }, home: en(HOMES),
    by: { type: 'string', pattern: '^(mechanic|loop|runtime|kind|capability):[a-z0-9][a-z0-9/-]*$' }, how: { type: 'string' }, where: en(WHERE),
    probe: { type: 'object', required: ['question', 'minutes'], properties: { question: { type: 'string' }, minutes: { type: 'integer', minimum: 1, maximum: PROBE_MAX_MINUTES } } },
    needs: { type: 'array', items: en((catalog?.capabilities ?? []).map(c => c.id)) },
    acts: en((catalog?.acts ?? []).map(a => a.acts)), camera: en(v.cameras), dimension: en(v.dimensions), together: en(v.together), body: en(v.bodies),
    devices: { type: 'array', items: en(v.devices) }, graphics: en(v.graphics), kind: en((catalog?.kinds ?? []).map(k => k.id)),
    cut: { type: 'object', required: ['words'], properties: { words: { type: 'string' } } },
  } };
  const ask = { type: 'object', required: ['about', 'text', 'options', 'default'], properties: { about: en([...ASKABLE, ...extraAsks]), text: { type: 'string' }, options: { type: 'array', minItems: 2, items: { type: 'object', required: ['id', 'label'], properties: { id: { type: 'string' }, label: { type: 'string' } } } }, default: { type: 'string' } } };
  return { type: 'object', required: ['ledger'], properties: { ledger: { type: 'object', required: ['rows', 'asks'], properties: { rows: { type: 'array', minItems: 1, items: row }, asks: { type: 'array', items: ask } } } } };
}

/** Every word the creator gave: the idea, the references' captions, their answers and change requests. */
export const sourcesOf = s => [s?.prompt, ...(s?.references ?? []).map(r => r?.caption ?? r), ...(s?.answers ?? [])].filter(Boolean).map(String);

/**
 * Hold a ledger to its rules. `sources`: the creator's words (sourcesOf). `extraAsks`: abouts a host adds to the two
 * (an economy, a backend), each its own part's business. → problems, each with its path.
 */
export async function checkLedger(ledger, { sources = [], registry, extraAsks = [] } = {}) {
  const out = [], lines = Array.isArray(ledger?.rows) ? ledger.rows : null;
  if (!lines || !lines.length) return ['$.rows: the ledger has no lines: write the essentials of the idea in the person\'s own words'];
  const vocab = await registry.vocabulary(), loops = await registry.loops();
  const ids = new Set();
  lines.forEach((r, i) => {
    const at = `$.rows[${i}]`;
    if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(String(r?.id ?? ''))) out.push(`${at}.id: a short id of letters, digits and dashes`);
    else if (ids.has(r.id)) out.push(`${at}.id: "${r.id}" is used twice`);
    ids.add(r?.id);
    if (!ABOUTS.includes(r?.about)) out.push(`${at}.about: one of ${ABOUTS.join(', ')}`);
    if (typeof r?.what !== 'string' || !r.what.trim() || r.what.length > 200) out.push(`${at}.what: one plain sentence, what this line is (at most 200 characters)`);
    // the creator's words, never the agent's
    if (r?.words === 'default') { if (!DEFAULTABLE.includes(r.about)) out.push(`${at}.words: only the devices line may stand on the default; quote the person's words for "${r.what}"`); }
    else if (r?.words == null) { if (!((r?.asked || r?.answered) && ASKABLE.includes(r.about)) && !(r?.about === 'body' && r.body === 'character')) out.push(`${at}.words: copy the person's own words for "${r?.what ?? r?.id}" (a few of their words are enough)${ASKABLE.includes(r?.about) ? ', or ask it (asked: true, and a question in asks)' : ''}`); }
    else if (!quoted(r.words, ...sources)) out.push(`${at}.words: "${String(r.words).slice(0, 80)}" is not the person's words: copy them exactly from the idea, a reference's caption or an answer`);
    if (r?.cut) { if (!quoted(r.cut.words, ...sources)) out.push(`${at}.cut.words: a line is cut only by the person's own words, quoted exactly`); return; }
    out.push(...homeProblems(r, at));
    out.push(...valueProblems(r, at, vocab, loops));
  });
  for (const about of ONE_EACH) {
    const n = lines.filter(r => r?.about === about && !r.cut).length;
    if (n !== 1) out.push(`$.rows: ${n ? 'more than one' : 'no'} "${about}" line: write exactly one (${about === 'acts' ? 'who acts when' : about === 'perspective' ? 'how the player sees the game' : about === 'players' ? 'how friends play together' : 'what a player is'})`);
  }
  if (!lines.some(r => r?.about === 'action' && !r.cut)) out.push('$.rows: no "action" line: what does a player do?');
  // the questions: two kinds only, each for a line the person's words leave open, never both
  const asks = Array.isArray(ledger?.asks) ? ledger.asks : [];
  const askable = [...ASKABLE, ...extraAsks];
  asks.forEach((q, i) => {
    const at = `$.asks[${i}]`;
    if (!askable.includes(q?.about)) { out.push(`${at}.about: the person is asked only ${askable.join(' or ')}; everything else is decided from their words and said plainly`); return; }
    const row = lines.find(r => r?.about === q.about && !r.cut);
    const opts = Array.isArray(q?.options) ? q.options : [];
    if (opts.length < 2 || opts.some(o => !o?.id || !o?.label)) out.push(`${at}.options: at least two, each {id, label}`);
    if (!opts.some(o => o?.id === q?.default)) out.push(`${at}.default: one of the options' ids`);
    if (typeof q?.text !== 'string' || !q.text.trim()) out.push(`${at}.text: the question, in one plain sentence`);
    // a line may quote the person and still be asked when their words leave part of it open (a board game says what a
    // player is, not how each is shown at the board): the line says so by `asked: true` (found by the PA11 build)
    if (ASKABLE.includes(q.about) && row && !row.asked) out.push(row.words && row.words !== 'default'
      ? `${at}: the ${q.about} line quotes the person ("${row.words}") and is not marked asked. When their words settle ${q.about === 'players' ? 'how friends play together' : 'what a player is'}, drop this question; when they leave part of it open (a part's own question, such as how each player is shown at a board), set asked: true on the line and keep the question`
      : `${at}: the ${q.about} line is not marked asked: set asked: true on it`);
  });
  for (const r of lines) if (r?.asked && !asks.some(q => q?.about === r.about)) out.push(`$.rows: the ${r.about} line is asked, and asks has no question about it`);
  if (asks.filter(q => q?.about === 'players').length > 1 || asks.filter(q => q?.about === 'body').length > 1) out.push('$.asks: one question per thing asked');
  // the ledger's references to the registry are real
  for (const [i, r] of lines.entries()) if (r?.home === 'exists' && !r.cut && r.by) { const p = await byProblem(registry, r.by); if (p) out.push(`$.rows[${i}].by: ${p}`); }
  for (const [i, r] of lines.entries()) for (const c of r?.needs ?? []) if (!(await registry.capabilities()).some(x => x.id === c)) out.push(`$.rows[${i}].needs: the registry has no capability "${c}" (registry capabilities lists them; what none names is a build line)`);
  return out;
}

function homeProblems(r, at) {
  const out = [];
  if (!HOMES.includes(r?.home)) return [`${at}.home: one of the words "exists", "build" or "probe"${r?.home && typeof r.home === 'object' ? ' (a word, not an object: by, how, where and probe are fields of the line itself)' : ''}`];
  // a line about the foundation (who acts when, the view, the players, the devices, the feel) is done by the foundation
  // the loop chooses from it; an action or a thing names the registry part that does it
  if (r.home === 'exists' && !r.by && FOUNDATION_ABOUTS.indexOf(r.about) < 0) out.push(`${at}.by: what in the registry does it (mechanic:<id>, loop:<id>, runtime:<id>, kind:<id> or capability:<id>)`);
  if (r.home === 'build') {
    if (!HOW_BUILD.test(String(r.how ?? ''))) out.push(`${at}.how: "${r.what}" is built for this game: say in one sentence what will be written (rules logic, a module in src/, or an engine override)`);
    if (!WHERE.includes(r.where)) out.push(`${at}.where: rules, module or engine`);
  }
  if (r.home === 'probe') {
    const m = Number(r.probe?.minutes);
    if (typeof r.probe?.question !== 'string' || !r.probe.question.trim()) out.push(`${at}.probe.question: what the probe finds out, in one sentence`);
    if (!(m > 0 && m <= PROBE_MAX_MINUTES)) out.push(`${at}.probe.minutes: a bound, 1 to ${PROBE_MAX_MINUTES} minutes`);
  }
  return out;
}

function valueProblems(r, at, vocab, loops) {
  const out = [], one = (field, allowed) => { if (r[field] != null && !allowed.includes(r[field])) out.push(`${at}.${field}: one of ${allowed.join(', ')}`); };
  if (r.about === 'acts') {
    const acts = [...new Set(loops.map(l => l.acts))];
    if (!acts.includes(r.acts)) out.push(`${at}.acts: who acts when, one of ${acts.join(', ')} (the registry's loops say what each means)`);
  }
  if (r.about === 'players') { if (!vocab.together.includes(r.together)) out.push(`${at}.together: one of ${vocab.together.join(', ')}`); }
  if (r.about === 'body') { if (!vocab.bodies.includes(r.body)) out.push(`${at}.body: one of ${vocab.bodies.join(', ')}`); }
  if (r.about === 'perspective') {
    if (!vocab.cameras.includes(r.camera)) out.push(`${at}.camera: one of ${vocab.cameras.join(', ')}`);
    if (!vocab.dimensions.includes(r.dimension)) out.push(`${at}.dimension: one of ${vocab.dimensions.join(', ')}`);
  }
  if (r.about === 'devices') { if (!Array.isArray(r.devices) || !r.devices.length || r.devices.some(d => !vocab.devices.includes(d))) out.push(`${at}.devices: a list from ${vocab.devices.join(', ')}`); }
  one('graphics', vocab.graphics);
  return out;
}

/**
 * The hard limits the ledger sets, each with the line it comes from. A limit the person said is hard; the default
 * devices are soft (they yield to a hard limit, and the foundation says so).
 */
export function limitsOf(ledger, vocab) {
  const live = (ledger?.rows ?? []).filter(r => !r.cut);
  const dev = live.find(r => r.about === 'devices'), persp = live.find(r => r.about === 'perspective');
  const graphics = live.find(r => r.graphics);
  const needs = [];
  for (const r of live) for (const c of r.needs ?? []) if (!needs.some(n => n.capability === c)) needs.push({ capability: c, row: r.id });
  return {
    devices: dev && dev.words !== 'default' ? { value: dev.devices, hard: true, row: dev.id } : { value: dev?.devices ?? vocab.defaultDevices, hard: false, row: dev?.id ?? null },
    camera: persp ? { value: persp.camera, hard: !!persp.words, row: persp.id } : null,
    dimension: persp ? { value: persp.dimension, hard: !!persp.words, row: persp.id } : null,
    graphics: graphics ? { value: graphics.graphics, hard: !!graphics.words, row: graphics.id } : null,
    needs,
  };
}

/**
 * The ledger as Studio shows it (creator-studio/lib/ledger.mjs reads pitch.ledger.rows[]): one line each, with
 * home 'cut' for a line the creator cut. → {lines: [{id, about, what, words, home, how, core, by?, cutBy?}]}
 */
export const ledgerView = ledger => ({
  lines: (ledger?.rows ?? []).map(l => ({ id: l.id, about: l.about, what: l.what, words: l.words ?? null, home: l.cut ? 'cut' : l.home, how: l.how ?? '', core: !!l.core,
    ...(l.by ? { by: l.by } : {}), ...(l.cut ? { cutBy: l.cut.words } : {}) })),
  asks: ledger?.asks ?? [],
});

/** The lines still in the ledger (not cut by the creator). */
export const liveRows = ledger => (ledger?.rows ?? []).filter(r => !r.cut);

/** What changed between two ledgers. A line that is gone without the creator's cut is `dropped`, and is refused. */
export function diffLedger(a, b) {
  const before = new Map((a?.rows ?? []).map(r => [r.id, r])), after = new Map((b?.rows ?? []).map(r => [r.id, r]));
  const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);
  const added = [...after.keys()].filter(id => !before.has(id));
  const dropped = [...before.keys()].filter(id => !after.has(id) && !before.get(id).cut);
  const cut = [...after.keys()].filter(id => after.get(id).cut && !before.get(id)?.cut);
  const changed = [...after.keys()].filter(id => before.has(id) && !cut.includes(id) && !same(before.get(id), after.get(id)));
  const abouts = new Set([...added, ...cut, ...changed].map(id => after.get(id)?.about).filter(Boolean));
  return { added, changed, cut, dropped, abouts };
}

/**
 * An amended ledger (a change request, or the creator's answer): its own rules, plus no line dropped, and every new or
 * changed line quotes the person (the new words are among `sources`). → problems
 */
export async function checkAmend(before, after, { sources = [], registry, extraAsks = [] } = {}) {
  const out = await checkLedger(after, { sources, registry, extraAsks });
  const d = diffLedger(before, after);
  for (const id of d.dropped) out.push(`$.rows: the line "${id}" is gone; a line leaves the ledger only when the person's words cut it (cut: {words})`);
  return out;
}

/** Apply the creator's answers to the ledger's questions: the line takes their words and the chosen value. */
export function applyAnswers(ledger, answers = {}, { words = null } = {}) {
  const next = structuredClone(ledger);
  for (const q of next.asks ?? []) {
    const chosen = answers[q.about] ?? q.default, row = next.rows.find(r => r.about === q.about && !r.cut);
    if (!row) continue;
    const field = q.about === 'players' ? 'together' : q.about === 'body' ? 'body' : q.field;
    if (field) row[field] = q.options.find(o => o.id === chosen)?.value ?? chosen;
    row.asked = false;
    row.words = answers[q.about] != null && words ? words : row.words ?? null;
    row.answered = { question: q.text, chosen, default: answers[q.about] == null };
  }
  next.asks = [];
  return next;
}
