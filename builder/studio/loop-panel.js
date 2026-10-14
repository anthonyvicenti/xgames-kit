// The creation loop on the studio page: where the run stands (the stages), and the loop itself as the person follows
// it: what they asked for (the ledger, each line in their words with its home, how it stands, and the second reader's
// mark), the foundation and why, the promises and how each stands, the ladder, the second reader's findings, and an
// economy or a backend when the game keeps one. Drawn from loopView (lib/loop-state.js); reads nothing itself.
//   loopPanel(view, {open})  → an element (data-part="loop-panel"); `open` lists the sections drawn open
//   stagesView(raw)          → the stages bar (data-part="stages"), or null when there is no loop
import { STAGES, stageOf } from './lib/loop-state.js';

const el = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'className') e.className = v; else e.setAttribute(k, v === true ? '' : v);
  }
  e.append(...kids.flat().filter(k => k != null && k !== false));
  return e;
};
const chip = (word, tone, title = null) => el('span', { className: `chip-s ${tone}`, title }, word);
const TONE = { proven: 'good', seen: 'good', kept: 'good', exists: 'quiet', build: 'go', probe: 'warn', cut: 'quiet', failed: 'bad', 'not-seen': 'bad', unreachable: 'bad', lost: 'bad', partly: 'warn', untested: 'warn', 'cannot-tell': 'warn' };
const STATUS_WORD = { proven: 'proven', failed: 'failed', untested: 'untested', cut: 'cut', seen: 'seen', 'not-seen': 'not seen', unreachable: 'unreachable' };

/** The stages a person follows, the one under way marked (a run waiting on them in amber). */
export function stagesView(raw) {
  const s = stageOf(raw);
  if (s.index < 0) return null;
  return el('ol', { className: 'stages', 'aria-label': 'Where the build is', 'data-part': 'stages' }, ...STAGES.map((st, i) => el('li', {
    className: i < s.index || (s.done && i === s.index) ? 'done' : i === s.index ? (s.waiting ? 'now waiting' : 'now') : '',
    'aria-current': i === s.index ? 'step' : null,
  }, st.label)));
}

function section(id, title, sub, body, open) {
  return el('details', { className: 'loop-sec', 'data-sec': id, open: open.includes(id) || null },
    el('summary', {}, el('span', { className: 'loop-sec-title' }, title), sub ? el('span', { className: 'loop-sec-sub' }, sub) : null), body);
}

function ledgerSection(v, open) {
  const n = s => v.lines.filter(l => l.status === s).length;
  const delivered = v.lines.some(l => l.status);
  const sub = delivered ? `${n('proven')} proven · ${n('failed')} failed · ${n('untested')} untested${v.cut ? ` · ${v.cut} cut` : ''}` : `${v.lines.length} line${v.lines.length === 1 ? '' : 's'}`;
  const body = el('ul', { className: 'ledger-lines' }, ...v.lines.map(l => el('li', { 'data-line': l.id, 'data-home': l.home, ...(l.status ? { 'data-status': l.status } : {}) },
    el('div', { className: 'line-words' }, l.words ? `“${l.words}”` : el('span', { className: 'muted' }, l.asked ? '(asked: your answer goes here)' : '(you did not say: the usual)'), l.core ? el('span', { className: 'core', title: 'Without it, it is not the game you asked for' }, 'core') : null),
    el('div', { className: 'line-what' }, l.what),
    el('div', { className: 'line-chips' },
      chip(l.homeWords, TONE[l.home] ?? 'quiet', l.how ?? l.by ?? l.cutBy ?? null),
      l.status ? chip(STATUS_WORD[l.status] ?? l.status, TONE[l.status] ?? 'quiet') : null,
      // the second reader's mark when it is not "kept" (the reader section counts every mark)
      l.reader && l.reader.mark !== 'kept' ? chip(`reader: ${l.reader.mark}`, TONE[l.reader.mark] ?? 'quiet', l.reader.why) : null),
    l.reader && l.reader.mark !== 'kept' ? el('div', { className: 'line-why small' }, l.reader.why) : null)));
  return section('ledger', 'What you asked for', sub, body, open);
}

function foundationSection(f, open) {
  const row = (label, value, why) => el('div', { className: 'found-row' }, el('div', { className: 'found-k' }, label), el('div', {}, el('b', {}, value), why ? el('div', { className: 'small muted' }, why) : null));
  const body = el('div', { className: 'found' },
    row('Runs on', f.place, f.why.runtime), row('Plays as', f.loop, f.why.loop), row('Feels', f.kind, f.why.kind),
    f.said.length ? el('ul', { className: 'found-said small' }, ...f.said.map(s => el('li', {}, s))) : null);
  return section('foundation', 'Foundation', `${f.place} · ${f.loop} · ${f.kind}`, body, open);
}

function promisesSection(v, open) {
  const by = s => v.promises.filter(p => p.status === s).length;
  const played = v.promises.some(p => p.status);
  const sub = played ? `${by('proven') + by('seen')} seen or proven · ${by('failed') + by('not-seen') + by('unreachable')} not · ${v.promises.filter(p => !p.status || p.status === 'untested').length} unchecked` : `${v.promises.length} to prove`;
  const body = el('ul', { className: 'promise-list' }, ...v.promises.map(p => el('li', { 'data-promise': p.id, ...(p.status ? { 'data-status': p.status } : {}) },
    el('code', {}, p.id), ' ', el('span', {}, p.text.replace(/^Built new for this game, and I can see it working when I play: /, 'Built new: ')), ' ',
    p.status ? chip(STATUS_WORD[p.status] ?? p.status, TONE[p.status] ?? 'quiet') : chip('not played yet', 'quiet'))));
  return section('promises', 'Promises', sub, body, open);
}

function ladderSection(v, open) {
  const L = v.ladder, c = v.counts;
  const sub = L.climbs.length ? `climbed: ${L.climbs.map(x => x.skipped ? `${x.rung} (skipped)` : x.rung).join(' → ')}` : c.repairs ? `${c.repairs} repair round${c.repairs === 1 ? '' : 's'}, no climb` : 'no repairs yet';
  const body = el('div', { className: 'ladder' },
    el('p', { className: 'small' }, `${c.rounds} round${c.rounds === 1 ? '' : 's'} so far: ${c.repairs} repair, ${c.specialist} specialist; ${c.verifies} verify run${c.verifies === 1 ? '' : 's'}, ${c.playtests} play-test${c.playtests === 1 ? '' : 's'}.${L.strong ? ' On the stronger model.' : ''}`),
    el('ol', { className: 'rungs' }, ...['model', 'specialist', 'generate', 'ask'].map(r => {
      const hit = L.climbs.find(x => x.rung === r);
      return el('li', { 'data-rung': r, className: hit ? (hit.skipped ? 'skipped' : 'climbed') : L.rung === r ? 'climbed' : '' }, { model: 'Stronger model', specialist: 'Specialist rounds', generate: 'Paid generation', ask: 'Questions for you' }[r], hit ? el('span', { className: 'small muted' }, ` (${hit.skipped ? `skipped: ${hit.skipped}` : hit.reason}${hit.areas ? `: ${hit.areas.join(', ')}` : ''})`) : null);
    })),
    L.owed.length ? el('p', { className: 'small muted' }, `Still owed on this rung: ${L.owed.join(', ')}.`) : null,
    L.failing.length ? el('p', { className: 'small muted' }, `Failing now: ${L.failing.slice(0, 6).join('; ')}`) : null,
    el('p', { className: 'small muted' }, 'When a repair fails the same way twice, or an old failure comes back, the loop climbs instead of repeating. Cost never ends a build; the top rung asks you.'));
  return section('ladder', 'Ladder', sub, body, open);
}

function readerSection(r, open) {
  if (r.status !== 'read') return section('reader', 'Second reader', r.status === 'off' ? 'off here' : 'no reading', el('p', { className: 'small muted' }, r.why || 'The second reader has not read this version.'), open);
  const m = r.marks;
  const body = el('div', { className: 'reader' },
    el('p', { className: 'small muted' }, 'A reader that never saw the build: it saw only your words, the promises and screenshots of the game, and marked each line.'),
    r.words ? el('p', { className: 'reader-words' }, r.words) : null,
    r.summary ? el('p', {}, r.summary) : null,
    r.findings.length ? el('ul', { className: 'reader-findings' }, ...r.findings.map(f => el('li', {}, f))) : el('p', { className: 'small muted' }, 'No findings beyond the marks.'),
    ...(r.notKept?.length ? [el('p', { className: 'small muted' }, 'Lines it did not find kept:'), el('ul', { className: 'reader-findings' }, ...r.notKept.map(l => el('li', {}, `“${l.words ?? l.what}”: ${l.reader.mark}, ${l.reader.why}`)))] : []));
  return section('reader', 'Second reader', `${m.kept} kept · ${m.partly} partly · ${m.lost} lost · ${m['cannot-tell']} can't tell`, body, open);
}

function partSection(id, p, open) {
  const title = id === 'economy' ? 'Economy' : 'Backend';
  const sub = p.state ? p.state.replaceAll('-', ' ') : p.check ? (p.check.ok ? 'check passed' : 'check failed') : p.kept === false ? 'left out' : 'kept';
  const body = el('div', { className: 'part' },
    p.option ? el('p', { className: 'small' }, `${p.kept ? 'Kept' : 'Left out'} (${p.by}: “${p.option}”).`) : null,
    p.check ? el('p', { className: 'small' }, p.check.ok ? 'The check passed.' : `The check refused: ${p.check.problems.join('; ')}`) : null,
    p.words ? el('p', {}, p.words) : null,
    p.link ? el('p', {}, el('a', { href: p.link, target: '_blank', rel: 'noopener' }, 'Open the approval page')) : null);
  return section(id, title, sub, body, open);
}

/** The loop panel: every section the state has. */
export function loopPanel(v, { open = ['ledger'] } = {}) {
  if (!v?.present) return null;
  const secs = [];
  if (v.lines.length) secs.push(ledgerSection(v, open));
  if (v.foundation) secs.push(foundationSection(v.foundation, open));
  if (v.promises.length) secs.push(promisesSection(v, open));
  if (v.counts.rounds || v.ladder.climbs.length) secs.push(ladderSection(v, open));
  if (v.reader) secs.push(readerSection({ ...v.reader, notKept: v.lines.filter(l => l.reader && l.reader.mark !== 'kept') }, open));
  for (const [id, p] of Object.entries(v.parts ?? {})) secs.push(partSection(id, p, open));
  if (!secs.length) return null;
  return el('div', { className: 'loop-panel', 'data-part': 'loop-panel' }, ...secs);
}
