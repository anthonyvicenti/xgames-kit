// What the game promises a player, from the locked spec and the ledger, and how each promise is settled.
//   row.<id>       a ledger line a registry part does (home exists): the creator's words, proven on the tester's screen
//   build.<n>      a spec.build line: what this game writes because nothing in the kit does it ("the build writes it");
//                  core, and proven only by the play-tester seeing it work
//   control.<a>    a control of the spec: the key does what it says
//   loop.closes    the loop's own promise (its manifest): a round ends, is won or lost, and replays
//   play.<n>       a "what makes it play" line of the play target (spec.play.target.makes, builder/play/design.mjs):
//                  core, and proven only by the play-tester seeing it on their own screen
// Each ledger line is proven by its promises: delivery carries every line as proven, failed or untested.
// A promise about friends (`friends: true`: the ledger's players line, and a build line that serves it) is proven by
// the play-tester only with two player-driven seats (playtest.mjs twoSeats); seen with bots or alone it stays untested.
import { liveRows } from './ledger.mjs';
import { SEES } from '../gf-multiplayer/source/presence.js';
import { playPromises } from '../play/design.mjs';

export const PLAY = 'play';
const gate = g => `gate:${g}`;
/** A ledger line's gate, beside the play-test, by what the line is about. */
const GATE_OF = { acts: 'D', players: 'E', devices: 'B', action: 'C' };

/**
 * The promise list for a locked spec. Pure, given the loop manifest (registry.manifest('loop', id)) and how friends are
 * seen (`friends`: pitch.mjs friendsShapeOf): with no character, a friends promise says what each screen shows instead.
 */
export function promisesOf({ spec, ledger, loopManifest = null, friends = null }) {
  const sees = friends === 'seats' || friends === 'boards' ? { sees: friends, text: ` Nobody is a character here, so on each screen ${SEES[friends]}.` } : null;
  const out = [], live = liveRows(ledger);
  // the lines about friends: how friends play together (anything but solo)
  const friendRows = new Set(live.filter(r => r.about === 'players' && r.together !== 'solo').map(r => r.id));
  for (const r of live.filter(x => x.home === 'exists')) {
    const proofs = r.about === 'devices' ? [gate('B')] : [...(GATE_OF[r.about] ? [gate(GATE_OF[r.about])] : []), PLAY];
    const text = r.about === 'devices' ? `It plays on ${[r.devices].flat().join(' and ')}.` : r.words ? `${r.what} (you said: "${r.words}")` : r.what;
    out.push({ id: `row.${r.id}`, kind: 'row', row: r.id, text: friendRows.has(r.id) && sees ? text + sees.text : text, core: !!r.core, proofs, ...(friendRows.has(r.id) ? { friends: true, ...(sees ? { sees: sees.sees } : {}) } : {}) });
  }
  (spec?.build ?? []).forEach((b, i) => out.push({
    id: `build.${i + 1}`, kind: 'build', row: b.row ?? null, ...(b.kind ? { look: b.kind } : {}), where: b.where,
    text: `Built new for this game, and I can see it working when I play: ${b.what}`, how: b.how, core: true, confirm: true, proofs: [PLAY], ...(friendRows.has(b.row) ? { friends: true } : {}),
  }));
  for (const p of playPromises(spec?.play?.target)) out.push(p.friends && sees ? { ...p, text: p.text + sees.text, sees: sees.sees } : p);
  for (const [action, keys] of Object.entries(spec?.controls ?? {})) out.push({ id: `control.${action}`, kind: 'control', text: `${keys}: ${action}`, action, keys, core: false, proofs: [gate('C'), PLAY] });
  out.push({ id: 'loop.closes', kind: 'loop', text: loopManifest?.promise ?? `A ${spec?.loop ?? 'round'} can be won or lost, ends, and plays again.`, core: true, proofs: [gate('D'), PLAY] });
  return out;
}

/** The list is never shorter than at the lock: a promise the game stopped making is put back as it was worded then. → ids put back */
export function holdPromises(list, locked) {
  if (!Array.isArray(list) || !Array.isArray(locked)) return [];
  const back = locked.filter(p => !list.some(q => q.id === p.id));
  list.push(...back.map(p => ({ ...p, heldFromLock: true })));
  return back.map(p => p.id);
}

const answerOf = (pt, id) => (pt?.answers instanceof Map ? pt.answers.get(id) : pt?.answers?.[id]) ?? null;

/**
 * Settle each promise from the verdict's gates and the play-test's answers.
 *   proven    every proof that ran agrees, and a promise that needs the tester's eyes (a build line) was seen
 *   failed    a gate it rests on failed, or the tester did not see it or could not reach it
 *   untested  nothing that ran answers it (a gate this runtime skipped, a play-test that did not ask)
 * → [{...promise, status, by: [{proof, status, note?}]}]
 */
export function settlePromises(list, { verdict = null, playtest = null } = {}) {
  return (list ?? []).map(p => {
    const by = p.proofs.map(proof => {
      if (proof === PLAY) {
        const a = answerOf(playtest, p.id);
        if (!a) return { proof, status: 'untested' };
        // a friends promise seen with bots, or alone, proves nothing about friends
        if (p.friends && a.status === 'seen' && a.two !== true) return { proof, status: 'untested', note: `seen without two players: ${a.twoWhy ?? 'no run of two player-driven seats'}` };
        return { proof, status: a.status === 'seen' ? 'proven' : a.status === 'unreachable' ? 'unreachable' : 'failed', ...(a.note ? { note: a.note } : {}), ...(p.friends && a.two ? { seats: 'two players' } : {}) };
      }
      // gate:C (the gate) or gate:C/13 (one measure of it), read from the verdict (builder/gates/verdict.schema.json)
      const [, letter, measure] = /^gate:([A-F])(?:\/(\w+))?$/.exec(proof) ?? [];
      const g = verdict?.gates?.[letter];
      if (!g || !g.ran?.length) return { proof, status: 'untested', note: `gate ${letter} did not run here${g?.skipped?.length ? ` (${g.skipped.map(s => s.why ?? s.measure).join('; ')})` : ''}` };
      if (measure) {
        const m = x => String(x?.measure ?? x) === measure;
        return { proof, status: g.passed?.some(m) ? 'proven' : g.failed?.some(m) ? 'failed' : 'untested' };
      }
      return { proof, status: g.ok ? 'proven' : 'failed' };
    });
    const failed = by.some(x => x.status === 'failed'), unreachable = by.some(x => x.status === 'unreachable');
    const needsEyes = (p.confirm || p.friends) && by.find(x => x.proof === PLAY)?.status !== 'proven';
    const status = failed ? 'failed' : unreachable ? 'unreachable' : needsEyes ? 'untested' : by.some(x => x.status === 'proven') ? 'proven' : 'untested';
    return { ...p, status, by };
  });
}

/**
 * The ledger as delivered: every line the creator gave, with how it stands. A line is proven when every promise that
 * serves it is proven, failed when any failed, else untested. A line the creator cut says so, with their words.
 * → {rows: [{id, about, words, what, home, status, promises: [{id, status}]}], proven, failed, untested, cut}
 */
export function ledgerVerdict(ledger, settled) {
  const lines = (ledger?.rows ?? []).map(r => {
    if (r.cut) return { id: r.id, about: r.about, words: r.words, what: r.what, home: r.home, status: 'cut', cutBy: r.cut.words, promises: [] };
    const mine = (settled ?? []).filter(p => p.row === r.id);
    const status = !mine.length ? 'untested' : mine.some(p => p.status === 'failed' || p.status === 'unreachable') ? 'failed' : mine.every(p => p.status === 'proven') ? 'proven' : 'untested';
    return { id: r.id, about: r.about, words: r.words ?? null, what: r.what, home: r.home, status, promises: mine.map(p => ({ id: p.id, status: p.status })) };
  });
  const ids = s => lines.filter(r => r.status === s).map(r => r.id);
  return { rows: lines, proven: ids('proven'), failed: ids('failed'), untested: ids('untested'), cut: ids('cut') };
}

/** The promise ledger as a file (gf-promises/1): the locked spec's sha, and every promise as it was settled. */
export const promisesDoc = ({ specSha, spec, settled }) => ({
  schema: 'gf-promises/1', spec: specSha, runtime: spec?.runtime, ...(spec?.title ? { title: String(spec.title).slice(0, 60) } : {}),
  ...(spec?.controls ? { hud: Object.entries(spec.controls).map(([a, k]) => `${k}: ${a}`).join(' · ').slice(0, 300) } : {}),
  promises: settled,
});

/** The outcome's name, from the version's proof. The first word a creator reads is the truth. */
export function outcomeOf({ verdictOk, ledger, stale = [], fallback = null }) {
  if (!verdictOk && !fallback) return 'delivered-unverified';
  if (stale.length) return 'delivered-stale-proof';
  if (fallback || ledger.failed.length || ledger.untested.length) return 'delivered-with-issues';
  return 'delivered';
}

/**
 * The version in the person's terms, from the spec and the ledger as delivered: what the game is, and what of theirs
 * works. Never a round's own words (a repair round's note is about the work, not the game). → one short paragraph
 */
export function creatorSummary({ spec, ledger, lv }) {
  const lines = (ledger?.rows ?? []).filter(r => !r.cut), status = new Map((lv?.rows ?? []).map(r => [r.id, r.status]));
  const what = rs => rs.map(r => r.what.replace(/[.!?]+$/, '').replace(/^./, c => c.toLowerCase()));
  const works = lines.filter(r => status.get(r.id) === 'proven' && !['devices'].includes(r.about));
  const ordered = [...works.filter(r => r.core), ...works.filter(r => !r.core)].slice(0, 6);
  const head = [spec?.title, spec?.hook].filter(Boolean).map(t => String(t).trim().replace(/[.!?]*$/, '.')).join(' ');
  const has = ordered.length ? ` What you asked for that works now: ${what(ordered).join('; ')}.` : '';
  const not = lines.length - works.length - lines.filter(r => r.about === 'devices').length;
  return `${head}${has}${not > 0 ? ` ${not} more line${not === 1 ? '' : 's'} of what you asked for ${not === 1 ? 'is' : 'are'} not working or not checked yet (below).` : ''}`.trim().slice(0, 1200);
}

/** What the creator reads first when the version is not yet everything they asked for. */
export function notYetWords(lv, ledger) {
  const what = id => ledger.rows.find(r => r.id === id)?.what ?? id;
  const parts = [];
  if (lv.failed.length) parts.push(`not working yet: ${lv.failed.map(what).join('; ')}`);
  if (lv.untested.length) parts.push(`not checked by anything yet: ${lv.untested.map(what).join('; ')}`);
  return parts.length ? `Not yet the game you asked for: ${parts.join('. ')}.` : '';
}
