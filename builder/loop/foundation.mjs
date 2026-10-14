// The foundation: what runs the game, how it is played, how it feels, in that order and by different rules.
//   runtime + profile  by hard limits only: the devices, the graphics, the camera and dimension, and what must be built
//                      (the capabilities the ledger's lines need), from the registry's compatibility answers
//   loop               by who acts when (the ledger's acts line), from the registry's loops
//   kind               last, from the creator's words and references (the feel and reference lines name it)
// No word of the idea routes anything here: every choice reads a structured ledger line the agent wrote while quoting
// the creator, and a registry answer computed from manifests. The foundation never refuses an idea: a capability the
// runtime lacks is built in the game, a loop that is not open is built on the closest one, a kind not proven on the
// runtime is proven by this game.
import { limitsOf, liveRows } from './ledger.mjs';
import { provenOn, rid } from './registry.mjs';

const runtimeId = c => rid(c.runtime, c.profile);

/**
 * → {ok, problems, probes, runtime, profile, loop, kind, limits, why: {runtime, loop, kind}, said: [plain words],
 *    candidates, builds: [{capability, row}], loopBuild, kindProof, rehome: [{row, capability}]}
 * `current`: the foundation a change starts from. Its runtime stays while it meets every hard limit, so a change never
 * moves a game to another runtime by ranking alone.
 */
export async function chooseFoundation(ledger, registry, { current = null } = {}) {
  const live = liveRows(ledger);
  const probes = live.filter(r => r.home === 'probe' && !r.probe?.result);
  if (probes.length) return { ok: false, problems: [], probes: probes.map(r => ({ row: r.id, question: r.probe.question, minutes: r.probe.minutes, what: r.what })) };
  const problems = [], said = [];
  const vocab = await registry.vocabulary(), runtimes = await registry.runtimes();
  const limits = limitsOf(ledger, vocab);
  const ask = { devices: limits.devices.value, graphics: limits.graphics?.value ?? null, camera: limits.camera?.value ?? null, dimension: limits.dimension?.value ?? null, needs: limits.needs.map(n => n.capability) };
  const open = new Set(runtimes.filter(r => r.status?.open).map(r => r.id));
  // compat (registry/build-catalog.mjs): {ok, problems, findings, runtimes: {'<runtime>[/<profile>]': {runtime, profile, open, fits, misses, lacks}}}
  const answers = Object.values((await registry.compat(ask)).runtimes ?? {}).filter(c => c.open !== false && open.has(c.runtime));
  if (!answers.length) return { ok: false, problems: ['the registry answered no open runtime: the loop has nothing to build on (registry compat)'], probes: [] };
  const rank = c => runtimes.find(r => r.id === c.runtime)?.rank ?? 99;
  const candidates = answers.map(c => {
    const hard = c.misses.filter(m => limits[m.limit]?.hard), soft = c.misses.filter(m => !limits[m.limit]?.hard);
    return { runtime: c.runtime, profile: c.profile, hard, soft, lacks: c.lacks, score: [hard.length, soft.length, c.lacks.length, rank(c)] };
  }).sort((a, b) => a.score.reduce((d, x, i) => d || x - b.score[i], 0));
  const keep = current && candidates.find(c => c.runtime === current.runtime && (c.profile ?? null) === (current.profile ?? null) && !c.hard.length);
  const chosen = keep ?? candidates[0];
  const rt = runtimes.find(r => r.id === chosen.runtime);

  // the runtime, in plain words: what limits chose it, what it costs, what the person loses by it
  const limitWords = ['devices', 'graphics', 'camera', 'dimension'].filter(k => limits[k]?.hard).map(k => `${k} ${[limits[k].value].flat().join(' and ')}`);
  const whyRuntime = keep ? `${runtimeId(chosen)} stays: it still meets every limit the person set`
    : `${runtimeId(chosen)}: ${limitWords.length ? `meets ${limitWords.join(', ')}` : 'no hard limit was set, so the runtime that meets the defaults and builds the least'}${chosen.lacks.length ? `; builds ${chosen.lacks.length} thing${chosen.lacks.length > 1 ? 's' : ''} it lacks in the game` : ''}`;
  if (rt?.limits) said.push(`${rt.id}: ${rt.limits}`);
  for (const m of chosen.soft) said.push(`The default ${m.limit} (${[m.need].flat().join(', ')}) yield: ${rt?.id ?? chosen.runtime} has ${[m.has].flat().join(', ') || 'none'}, and it is the runtime that meets what the person said.`);
  for (const m of chosen.hard) said.push(`No open runtime meets every limit: ${m.limit} ${[m.need].flat().join(', ')} is not met (${chosen.runtime} has ${[m.has].flat().join(', ') || 'none'}). This is the closest; the game is built toward it and says what differs.`);
  const builds = chosen.lacks.map(c => ({ capability: c, row: limits.needs.find(n => n.capability === c)?.row ?? null }));
  const rehome = builds.filter(b => live.find(r => r.id === b.row)?.home === 'exists');
  for (const b of builds) said.push(`${chosen.runtime} has no ${b.capability}: this game builds it (a promise in spec.build).`);
  // a line a mechanic does, where that mechanic has no implementation on this runtime: built in the game
  const mechanics = await registry.mechanics();
  for (const r of live.filter(x => x.home === 'exists' && /^mechanic:/.test(x.by ?? ''))) {
    const id = r.by.slice(9), m = mechanics.find(x => x.id === id);
    if (m?.runtimes && !m.runtimes.includes(chosen.runtime)) {
      rehome.push({ row: r.id, mechanic: id });
      said.push(`${chosen.runtime} has no ${id} mechanic yet: this game builds what "${r.what}" needs (a promise in spec.build).`);
    }
  }

  // the loop: who acts when
  const acts = live.find(r => r.about === 'acts');
  const loops = await registry.loops();
  const fits = l => l.status?.open && (!l.runtimes || l.runtimes.includes(chosen.runtime));
  const exact = loops.find(l => l.acts === acts?.acts && fits(l));
  let loop = exact?.id ?? null, loopBuild = null, whyLoop;
  if (exact) whyLoop = `${exact.id}: ${acts.words ? `"${acts.words}": ` : ''}${exact.describe}`;
  else {
    const wanted = loops.find(l => l.acts === acts?.acts);
    const closest = [...(wanted?.near ?? []), acts?.closest].map(id => loops.find(l => l.id === id)).find(l => l && fits(l)) ?? loops.find(fits);
    loop = closest?.id ?? null;
    loopBuild = { wants: wanted?.id ?? acts?.acts, closest: loop, how: acts?.how ?? null, row: acts?.id };
    whyLoop = `${wanted?.id ?? acts?.acts} is how this is played and is not open on ${chosen.runtime}: this game builds it on ${loop}`;
    if (acts && acts.home !== 'build') problems.push(`$.rows (${acts.id}): the loop "${wanted?.id ?? acts.acts}" is not open on ${chosen.runtime}, so this game builds it on "${loop}": set home "build", with how (what will be written) and where`);
    said.push(`Who acts when (${wanted?.id ?? acts?.acts}) is built in this game on the ${loop} loop.`);
  }

  // the kind, last: the feel line names it, else a reference does; never a word of the idea
  const kinds = await registry.kinds();
  const named = live.filter(r => r.kind && r.about === 'feel'), refs = live.filter(r => r.kind && r.about === 'reference');
  const from = named.length ? named : refs;
  const distinct = [...new Set(from.map(r => r.kind))];
  let kind = null, kindProof = null, whyKind;
  if (distinct.length > 1) problems.push(`$.rows: the ${named.length ? 'feel' : 'reference'} lines name ${distinct.length} kinds (${distinct.join(', ')}): name one, from the words or reference that matter most to the person`);
  if (distinct.length) {
    kind = distinct[0];
    const k = kinds.find(x => x.id === kind);
    if (!k) problems.push(`$.rows: the registry has no kind "${kind}" (registry kinds); a look none of them has is built in the game: leave kind out of the line and make it a build line`);
    whyKind = `${kind}: ${from.filter(r => r.kind === kind).map(r => (r.words ? `"${r.words}"` : r.what)).join('; ')}`;
    if (k && !provenOn(k, chosen.runtime, chosen.profile)) {
      kindProof = { kind, runtime: chosen.runtime, profile: chosen.profile };
      said.push(`The ${kind} look is not yet proven on ${chosen.runtime}: this game proves it (the look judge's contact sheet is its check).`);
    }
  } else {
    // the runtime's own default when it is proven on the chosen profile, else the first kind proven there
    const proven = k => provenOn(k, chosen.runtime, chosen.profile);
    kind = (proven(kinds.find(k => k.id === rt?.defaultKind)) ? rt.defaultKind : kinds.find(proven)?.id) ?? rt?.defaultKind ?? null;
    whyKind = `${kind}: the person did not say how it should feel, so the look proven on ${runtimeId(chosen)} until they do`;
    said.push(`No feel was named: the ${kind} look for now; a change request can give it another without touching play.`);
  }
  return { ok: !problems.length, problems, probes: [], runtime: chosen.runtime, profile: chosen.profile, loop, kind, limits,
    why: { runtime: whyRuntime, loop: whyLoop, kind: whyKind }, said, candidates: candidates.map(({ score, ...c }) => c), builds, rehome, loopBuild, kindProof };
}

/** The foundation as the ledger keeps it (ledger.schema.json $defs/foundation): what was chosen, why, what it builds. */
export function foundationSummary(f) {
  const drop = o => (o ? Object.fromEntries(Object.entries(o).filter(([, v]) => v != null)) : o);
  return drop({ runtime: f.runtime, profile: f.profile, loop: f.loop, kind: f.kind, why: f.why, said: f.said?.slice(0, 20), builds: f.builds, loopBuild: drop(f.loopBuild), kindProof: drop(f.kindProof) });
}

/**
 * Probe results back into the ledger: each probed line gets its home (exists or build) with the evidence.
 * results: [{row, home, evidence, by?, how?, where?}] → {ledger, problems}
 */
export function resolveProbes(ledger, results = []) {
  const next = structuredClone(ledger), problems = [];
  for (const r of next.rows.filter(x => x.home === 'probe' && !x.probe?.result)) {
    const got = results.find(x => x?.row === r.id);
    if (!got) { problems.push(`probes: no result for "${r.id}" (${r.probe.question})`); continue; }
    if (!['exists', 'build'].includes(got.home)) { problems.push(`probes (${r.id}).home: exists or build`); continue; }
    if (!got.evidence) { problems.push(`probes (${r.id}).evidence: what the probe saw (a file, a measure, a note)`); continue; }
    if (got.home === 'exists' && !got.by) { problems.push(`probes (${r.id}).by: what in the registry does it`); continue; }
    if (got.home === 'build' && (!got.how || !got.where)) { problems.push(`probes (${r.id}): a build line needs how and where`); continue; }
    r.probe.result = got.home; r.probe.evidence = String(got.evidence).slice(0, 400);
    r.home = got.home;
    for (const k of ['by', 'how', 'where']) if (got[k]) r[k] = got[k];
  }
  return { ledger: next, problems };
}

/** Lines whose capability the chosen runtime lacks become build lines (the loop's words; spec.build carries the agent's). */
export function rehomeLedger(ledger, foundation) {
  const next = structuredClone(ledger);
  for (const b of foundation.rehome ?? []) {
    const r = next.rows.find(x => x.id === b.row);
    if (!r) continue;
    r.home = 'build';
    r.how = r.how ?? `a module in src/ that gives ${foundation.runtime} the ${b.capability ?? `${b.mechanic} mechanic`} this line needs`;
    r.where = r.where ?? 'module';
    r.rehomed = { from: 'exists', ...(b.capability ? { capability: b.capability } : { mechanic: b.mechanic }), runtime: foundation.runtime };
    delete r.by;
  }
  return next;
}

/**
 * A runtime change, as the person is shown it before anything is moved: what is made again, kept, rewritten and lost.
 * → {from, to, consequences: [plain sentences], devices: {lost, gained}}
 */
export async function migrationOf(before, after, { spec = null, registry, ownFiles = [] } = {}) {
  const runtimes = await registry.runtimes(), mechanics = await registry.mechanics();
  const prof = (f) => runtimes.find(r => r.id === f.runtime)?.profiles?.find(p => (p.id ?? null) === (f.profile ?? null)) ?? {};
  const was = prof(before), will = prof(after);
  const lost = (was.devices ?? []).filter(d => !(will.devices ?? []).includes(d)), gained = (will.devices ?? []).filter(d => !(was.devices ?? []).includes(d));
  const mech = (spec?.mechanics ?? []).map(m => m.id ?? m);
  const missing = mech.filter(id => !mechanics.find(m => m.id === id)?.runtimes?.includes(after.runtime));
  const engineFiles = ownFiles.filter(f => /^(src|overrides)\//.test(f));
  const consequences = [
    `The game is made again on ${rid(after.runtime, after.profile)} from its spec: a new create, then a build round.`,
    `Kept: the ledger, the spec's rules, controls and promises${mech.length - missing.length ? `, and ${mech.length - missing.length} of its ${mech.length} mechanics, which ${after.runtime} has` : ''}; every slot is filled again from the library for the new runtime.`,
    ...(missing.length ? [`Built new on ${after.runtime}: ${missing.join(', ')} (${after.runtime} has no such mechanic yet), each a promise in spec.build.`] : []),
    ...(engineFiles.length ? [`Rewritten: ${engineFiles.length} file${engineFiles.length > 1 ? 's' : ''} of the game's own engine code (src/, overrides/) written for ${before.runtime}, which do not run on ${after.runtime}.`] : []),
    ...(lost.length ? [`Lost: it will no longer play on ${lost.join(', ')} (${runtimes.find(r => r.id === after.runtime)?.limits ?? after.runtime}).`] : []),
    ...(gained.length ? [`Gained: it will also play on ${gained.join(', ')}.`] : []),
    ...(after.kind !== before.kind ? [`The look moves from ${before.kind} to ${after.kind}.`] : []),
    'Every promise is proven again: the six gates and the play-test run on the new game before it is delivered.',
  ];
  return { from: rid(before.runtime, before.profile), to: rid(after.runtime, after.profile), consequences, devices: { lost, gained }, rebuilt: missing };
}
