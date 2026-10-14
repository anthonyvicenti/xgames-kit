// The second reader: an independent judge of "intent kept". It sees only the creator's words and the delivered game
// (the captures, and the promise ledger with the play-tester's log), never the build's transcript, its spec or its
// summary, and marks every ledger line the way the evals' readers do (evals/paired/RUBRIC.md):
//   kept         the evidence shows it working as the person's words ask
//   partly       it is there, thinner or different in a way the person would notice
//   lost         it is absent, or something else stands in its place
//   cannot-tell  the evidence does not show it either way
// In the loop it is a step before delivery, and advisory: it never blocks delivery, and its marks and findings join the
// delivery ledger. In the evals it is the judge (evals/lib/judge.mjs): the same session, the set's frozen JUDGE.md as
// its prompt, a copy of one blind bundle as its only folder.
//
// Pure, apart from what a host passes in: the library never starts a session. A host passes a runner (`reader(o)`)
// or hands the round over and takes the reading back with the next step(input).
import { liveRows } from './ledger.mjs';

export const READING_SCHEMA = 'gf-reading/1';
export const MARKS = ['kept', 'partly', 'lost', 'cannot-tell'];
/** How a mark counts, as the paired rubric scores it (cannot-tell is not kept: a new player could not see it either). */
export const MARK_SCORE = { kept: 1, partly: 0.5, lost: 0, 'cannot-tell': 0 };
/** Invalid readings a run takes before it goes on without one (the reader is advisory: it never holds a delivery). */
export const READER_TRIES = 2;
export const READER_AGENT = 'reader';

const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/**
 * What the reader is given, and nothing more: the person's words (the idea, the references' captions, their answers
 * and change requests), each ledger line as {id, about, words, what, core}, the promises the game makes with the
 * play-tester's log of each, and the captures (screenshots of the tester's own screen).
 * Left out on purpose: the spec, the foundation, each line's home (how the build meant to do it), the build's summary
 * and every transcript.
 */
export function readerBundle(S, { captures = [] } = {}) {
  const ledger = S?.change?.ledger ?? S?.ledger;
  const rows = liveRows(ledger).map(r => ({ id: r.id, about: r.about, words: r.words ?? null, what: clip(r.what, 200), core: !!r.core }));
  const answers = S?.playtest?.answers ?? {};
  const promises = (S?.promises ?? []).map(p => {
    const a = answers[p.id];
    const two = p.friends && a ? { seats: a.two === true ? 'two players, each driven by the tester (checked against the run)' : `not two players (${clip(a.twoWhy ?? 'no friends run', 200)})`, ...(a.screens ? { screens: { host: clip(a.screens.host, 300), friend: clip(a.screens.friend, 300) } } : {}) } : {};
    return { id: p.id, row: p.row ?? null, text: clip(p.text, 300), ...(p.friends ? { friends: true } : {}), ...(a ? { tester: { status: a.status, note: clip(a.note, 400), evidence: (a.evidence ?? []).slice(0, 6).map(e => clip(e, 300)), ...two } } : {}) };
  });
  return {
    schema: 'gf-reader-bundle/1',
    words: { idea: S?.prompt ?? '', references: (S?.references ?? []).map(r => clip(r?.caption ?? r, 300)), answers: (S?.answers ?? []).map(a => clip(a, 600)) },
    rows,
    promises,
    tester: S?.playtest ? { feel: (S.playtest.feel ?? []).map(f => clip(f, 200)), summary: clip(S.playtest.summary, 1200) } : null,
    captures: captures.slice(0, 80).map(c => ({ file: c.file, what: clip(c.what ?? '', 160) })),
  };
}

/** The reader's task: the bundle, the rules of judging, the answer's shape. `play`: the host gives it gamesfun_play too. */
export function readerBrief({ bundle, game = null, play = false, reportHow }) {
  const rows = bundle.rows.map(r => `- \`${r.id}\`${r.core ? ' (core)' : ''} (${r.about}): ${r.words ? `"${r.words}"` : '(asked, not said)'}: ${r.what}`);
  const promises = bundle.promises.map(p => `- \`${p.id}\`${p.row ? ` (line ${p.row})` : ''}${p.friends ? ' (two players)' : ''}: ${p.text}${p.tester ? `\n  the play-tester: ${p.tester.status}${p.tester.note ? `: ${p.tester.note}` : ''}${p.tester.evidence.length ? ` [${p.tester.evidence.join('; ')}]` : ''}${p.tester.seats ? `\n  seats: ${p.tester.seats}` : ''}${p.tester.screens ? `\n  the host's screen: ${p.tester.screens.host}\n  the friend's screen: ${p.tester.screens.friend}` : ''}` : '\n  the play-tester: not asked'}`);
  return [
    '# Second reader', '',
    'A person typed an idea; a game was built from it. Say, line by line, whether the game kept what they asked for. You judge from the evidence below only: you never saw the build, and you never read the game\'s files.', '',
    '## Their words', '', '```text', String(bundle.words.idea).slice(0, 4000), '```',
    ...(bundle.words.references.length ? ['', 'Their references:', ...bundle.words.references.map(r => `- ${r}`)] : []),
    ...(bundle.words.answers.length ? ['', 'What they said later (answers, choices, change requests):', ...bundle.words.answers.map(a => `- "${a}"`)] : []), '',
    '## The ledger: each line of what they asked for', '',
    'Each line quotes their words and says what the builder took them to mean. Judge each line by their words first: when the meaning given narrows or bends their words, mark it by their words and say so in a finding.', '',
    ...rows, '',
    '## What the game promises, and what the play-tester saw', '',
    'These are leads, not proof: a promise is the builder\'s own claim and the play-tester\'s notes are its words. Check them against the captures.', '',
    ...promises, '',
    ...(bundle.tester ? ['The play-tester\'s summary:', '', '```text', bundle.tester.summary, '```', ...(bundle.tester.feel.length ? ['', ...bundle.tester.feel.map(f => `- ${f}`)] : []), ''] : []),
    '## The captures', '',
    ...(bundle.captures.length ? ['Screenshots of the play-tester\'s own screen. Open each one you rely on (read the image file) before you judge with it.', '', ...bundle.captures.map(c => `- ${c.file}${c.what ? `: ${c.what}` : ''}`)] : ['No screenshots were kept for this version.']),
    ...(play ? ['', `You may also play the game yourself with \`gamesfun_play\` ({"game": "${game}", "name", "steps"}; it starts with {"do":"start"}), like a new player: real keys and the mouse, and a screenshot of your own screen per \`shot\`. Never read the game's files.`] : []), '',
    '## How you judge', '',
    '1. Judge what the evidence **shows**, not what anything **says**. A label that reads "laps" is not laps; a lap counter that goes up as a car crosses the line is. A claim no capture shows is a lead: look for it; if nothing shows it, it is `cannot-tell`.',
    `2. Mark every ledger line once: ${MARKS.map(m => `\`${m}\``).join(', ')}. Give one sentence of reason and the captures (file names) or tester notes that support it.`,
    '3. Do not reward effort, polish or ambition beyond the line, and do not punish a choice their words left open. A game that does more is fine; a game that does something else instead is not.',
    '4. `findings`: what the person would notice that the marks do not say: a meaning that narrowed their words, something they asked for that no line holds, something in the game that works against what they asked. One plain sentence each; none is fine.',
    '5. Say in a finding anything on screen that looks made for a tester rather than a player: a readout of the camera or of numbers a player has no use for, a debug line, a marker or a key that only proves something. Name it and where you saw it.', '',
    '## Your answer', '',
    `\`{"schema": "${READING_SCHEMA}", "rows": [{"id", "mark", "why", "evidence": [...]}], "findings": ["…"], "summary": "two sentences: what the game is, and the biggest thing it kept or lost"}\``, '',
    reportHow,
  ].join('\n');
}

/** The reader's own words (its system prompt): who it is, and what holds it to them. */
export function readerWords() {
  return [
    'You are the second reader for a game a friend just built from someone\'s idea. You did not build it and you never read its code: you see only the person\'s words, the promises the builder made, the play-tester\'s log and screenshots of the game (and, when you are given the tool, you play it yourself as a new player).',
    'Your job is one question per line of what they asked for: did the game keep it? Be fair and plain. A thing you cannot see is `cannot-tell`, never `kept`.',
    'Nobody answers questions. Your task message is the whole bundle and ends with how to hand the reading in.',
  ].join('\n');
}

/**
 * Hold a reading to its shape: every live ledger line marked once with a mark, a reason, and evidence for kept or
 * partly. → {ok, problems, rows: {id: {mark, why, evidence}}, findings, summary}
 */
export function readReading(raw, rowIds) {
  const problems = [], rows = {};
  const list = Array.isArray(raw?.rows) ? raw.rows : null;
  if (!list) return { ok: false, problems: ['rows: one entry per ledger line, by its id'], rows, findings: [], summary: '' };
  for (const [i, r] of list.entries()) {
    if (!rowIds.includes(r?.id)) { problems.push(`rows[${i}].id: "${r?.id}" is not a line of the ledger`); continue; }
    if (rows[r.id]) { problems.push(`rows[${i}].id: "${r.id}" is marked twice`); continue; }
    if (!MARKS.includes(r.mark)) { problems.push(`rows[${i}].mark: one of ${MARKS.join(', ')}`); continue; }
    if (!String(r.why ?? '').trim()) { problems.push(`rows[${i}].why: one sentence of reason`); continue; }
    const evidence = Array.isArray(r.evidence) ? r.evidence.map(e => clip(e, 300)).filter(Boolean) : [];
    if ((r.mark === 'kept' || r.mark === 'partly') && !evidence.length) { problems.push(`rows[${i}].evidence: "${r.mark}" needs what shows it (a capture's file name or the tester's note)`); continue; }
    rows[r.id] = { mark: r.mark, why: clip(r.why, 400), evidence: evidence.slice(0, 8) };
  }
  for (const id of rowIds) if (!rows[id] && !problems.some(p => p.includes(`"${id}"`))) problems.push(`rows: no mark for "${id}": every line is kept, partly, lost or cannot-tell`);
  const findings = Array.isArray(raw?.findings) ? raw.findings.map(f => clip(f, 300)).filter(Boolean).slice(0, 12) : [];
  return { ok: !problems.length, problems, rows, findings, summary: clip(raw?.summary, 800) };
}

/** The marks counted: {kept, partly, lost, 'cannot-tell'} and the core score (the rubric's intent kept, 0 to 1). */
export function readingScore(reading, rows) {
  const count = Object.fromEntries(MARKS.map(m => [m, 0]));
  for (const r of Object.values(reading?.rows ?? {})) count[r.mark]++;
  const core = rows.filter(r => r.core);
  const intent = core.length ? core.reduce((s, r) => s + (MARK_SCORE[reading?.rows?.[r.id]?.mark] ?? 0), 0) / core.length : null;
  return { count, intent };
}

/**
 * What the person reads about the reading, first the lines it did not find kept. → '' when every line was kept, or
 * when nothing was read (the outcome says why).
 */
export function readerSays(reading, ledger) {
  if (!reading || reading.status !== 'read') return '';
  const live = liveRows(ledger), not = live.filter(r => reading.rows[r.id] && reading.rows[r.id].mark !== 'kept');
  if (!not.length && !reading.findings.length) return '';
  const end = t => (/[.!?]$/.test(t) ? t : `${t}.`);
  const line = r => end(`${r.what}${r.words ? ` ("${r.words}")` : ''}: ${reading.rows[r.id].mark}, ${reading.rows[r.id].why}`);
  return [
    'A second reader, who saw only your words and the game, did not find everything kept.',
    ...(not.length ? [`${not.map(line).join(' ')}`] : []),
    ...(reading.findings.length ? [`It also noticed: ${reading.findings.map(end).join(' ')}`] : []),
  ].join(' ');
}

/** The delivery ledger's rows with the reader's mark beside each (ledgerVerdict's rows). */
export function withMarks(lv, reading) {
  if (!reading?.rows) return lv;
  return { ...lv, rows: lv.rows.map(r => (reading.rows[r.id] ? { ...r, reader: { mark: reading.rows[r.id].mark, why: reading.rows[r.id].why } } : r)) };
}

/** The reading as the outcome carries it. */
export function readerOutcome(reading, ledger) {
  if (!reading) return { status: 'none', why: 'no reading was made' };
  if (reading.status !== 'read') return { status: reading.status, why: reading.why ?? '' };
  const { count, intent } = readingScore(reading, liveRows(ledger));
  return { status: 'read', marks: count, intent, findings: reading.findings, summary: reading.summary, words: readerSays(reading, ledger), ...(reading.stale ? { stale: true } : {}) };
}

// ---------------------------------------------------------------- the evals' judge
/** The judge's prompt: the set's frozen JUDGE.md, its prompt part (after the first `---` line), {{bundle}} filled in. */
export function judgePrompt(judgeMd, bundleDir) {
  const text = String(judgeMd);
  const i = text.search(/^---\s*$/m);
  const body = i >= 0 ? text.slice(text.indexOf('\n', i) + 1) : text;
  return body.replaceAll('{{bundle}}', bundleDir).trim() + '\n';
}

/** A judgement's shape for a set (paired: ledger marks; breadth: must marks and an outcome). → problems */
export function judgementProblems(j, { set, ids, blindId }) {
  const p = [];
  if (j?.schema !== 'xgk-eval-judgement/1') p.push('schema: "xgk-eval-judgement/1"');
  if (j?.set !== set) p.push(`set: "${set}"`);
  if (j?.blindId !== blindId) p.push(`blindId: "${blindId}"`);
  const key = set === 'paired' ? 'ledger' : 'musts', marks = set === 'paired' ? MARKS : ['present', 'partly', 'absent', 'cannot-tell'];
  const list = Array.isArray(j?.[key]) ? j[key] : [];
  for (const id of ids) {
    const m = list.find(x => x?.id === id);
    if (!m) p.push(`${key}: no mark for "${id}"`);
    else if (!marks.includes(m.mark)) p.push(`${key}: "${id}" is marked "${m.mark}", not one of ${marks.join(', ')}`);
  }
  if (!['absent', 'present'].includes(j?.control?.mark)) p.push('control.mark: absent or present');
  if (set === 'breadth' && !['faithful', 'something-else', 'refused'].includes(j?.outcome)) p.push('outcome: faithful, something-else or refused');
  return p;
}

/** The first JSON object in a reply's text (a reader that answered in prose around it). → object | null */
export function jsonIn(text) {
  const s = String(text ?? '');
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
}
