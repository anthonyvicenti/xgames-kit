// The creation loop as MCP tools (the factory; builder/mcp/tools/loop.mjs binds it to this kit). A person's own agent
// session runs the loop; the order is held here and in the library, never by a prompt. Each tool opens the loop on the game, runs its step, and answers with the next tool.
// A tool called out of order is refused with the reason and the right tool.
//
//   gamesfun_step_ledger → gamesfun_step_foundation → gamesfun_step_pitch → gamesfun_step_spec → gamesfun_step_create
//   → gamesfun_step_look (the look, before the build) → gamesfun_step_design (the play, before the build) → [the build round] → gamesfun_step_fix → [gamesfun_step_economy] → [gamesfun_step_backend] → gamesfun_step_verify
//   → gamesfun_step_playtest → gamesfun_step_read (the second reader) → gamesfun_step_deliver
//   a fail: gamesfun_step_repair (the stop rule and the ladder) → [the round] → gamesfun_step_fix → …
//   the top of the ladder: gamesfun_ask; the person's answer: gamesfun_step_ledger {answer}; after delivery: gamesfun_change
//
// No tool starts an agent or calls a model. The play-test's report comes only from gamesfun_playtest_report with the
// round's one-time token, which only the play-tester's task message carries; the second reader's reading only from
// gamesfun_reader_report with its own token (`bind.reports` keeps both channels; in memory unless the kit gives its
// sealed store, which also holds across processes: builder/lib/loop-seal.mjs).
//
// `loopTools(bind)` makes the tools for a kit. bind: {
//   registry,                 the registry (builder/loop/registry.mjs)
//   root,                     the kit's root: a `game` argument is resolved against it
//   store(G),                 the state store for a game (the kit passes its sealed store: lib/loop-seal.mjs)
//   tools(G),                 {create, fix, verify, hash, checkSpec?, ownFiles?} for a game (builder/loop/loop.mjs)
//   versions(G)?,             {keep, restore, has} (the kit's checkpoints)
//   limits?, gameRef(G)?,     model names; what the play-tester is given (a served URL)
//   say(G, key, detail)?      progress: the keys of Studio's LADDER_SAY (builder/loop/ladder.mjs SAY), with the round as detail
//   reports?                  {issue(G, {focus, message, channel}) → token, current(G, channel) → token | null,
//                              check(G, token, channel) → problem | null, keep(G, report, channel), take(G, channel) → report | null}:
//                              the one-time tokens and what was handed in with them; channel 'playtest' (the report) or
//                              'reader' (the second reader's reading) (default: memory)
//   parts?(G)                 {economy?, backend?}: the optional parts' adapters for this game (builder/loop/parts.mjs)
//   handed?(G, round)         a building round was just handed over (the kit checkpoints the game before the session works)
//   session?(G, id), sessionOf?(G)  the session id a call gave, and the one to keep in the state (a stop guard holds it)
//   extra?                    {next(G, state) → fields for gamesfun_next's answer}
// }
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { openLoop } from '../loop/loop.mjs';
import { ORDER, ROUND_STEPS, actionOf, toolOf } from '../loop/order.mjs';
import { readReport } from '../loop/playtest.mjs';
import { READER_AGENT, readReading } from '../loop/reader.mjs';
import { liveRows } from '../loop/ledger.mjs';
import { proofOf } from '../loop/state.mjs';
import { NEXT_OUTPUT, PLAYTEST_REPORT, READING, REPORT_OUTPUT, STEP_OUTPUT } from './schemas.mjs';

export const TOOL_NAMES = { ledger: 'gamesfun_step_ledger', foundation: 'gamesfun_step_foundation', pitch: 'gamesfun_step_pitch', spec: 'gamesfun_step_spec', fix: 'gamesfun_step_fix', ask: 'gamesfun_ask', quick: 'gamesfun_verify', play: 'gamesfun_play', art: 'gamesfun_art_generate', remove: 'gamesfun_remove' };
export const PLAYTESTER = 'playtester';
/** The MCP server's instructions (builder/mcp/server.mjs): the order in one line. */
export const INSTRUCTIONS = `xgames-kit makes multiplayer browser games with your own coding agent. Read AGENTS.md in the kit root first. A game is made through the creation loop, and the tools hold its order: call gamesfun_next {"game": "games/<name>"} first (also after a restart), then the tool each answer names: ${[...new Set(ORDER.map(o => o.tool))].join(' → ')}. A tool called out of order is refused with the right one. A change request after delivery: gamesfun_change. gamesfun_rollback undoes a round; gamesfun_requests brings the studio page's requests; gamesfun_dev_start plays a game with two tabs.`;

const text = v => ({ content: [{ type: 'text', text: JSON.stringify(v, null, 2) }], structuredContent: v });
/** MCP tool hints, honest per tool (tests/seams.test.mjs holds every tool to all four). */
const HINT = { read: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, step: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }, writes: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } };

/** The play-test's token and report, in this process only (a test, a host that keeps nothing on disk). */
export function memoryReports() {
  const tokens = new Map(), reports = new Map(), k = (G, c = 'playtest') => `${G.game}#${c}`;
  return {
    issue: async (G, { channel } = {}) => { const t = randomBytes(12).toString('hex'); tokens.set(k(G, channel), { token: t, used: false }); reports.delete(k(G, channel)); return t; },
    current: async (G, channel) => { const t = tokens.get(k(G, channel)); return t && !t.used ? t.token : null; },
    check: async (G, token, channel) => { const t = tokens.get(k(G, channel)); return !t || t.token !== token ? `this is not the token of the ${channel === 'reader' ? 'reading' : 'play-test'} round under way` : t.used ? 'that token was already used: one report per round' : null; },
    keep: async (G, report, channel) => { tokens.get(k(G, channel)).used = true; reports.set(k(G, channel), report); },
    take: async (G, channel) => { const r = reports.get(k(G, channel)) ?? null; reports.delete(k(G, channel)); return r; },
  };
}
const refusal = (code, why, next = null, more = {}) => ({ isError: true, ...text({ refused: code, why, ...(next ? { next } : {}), ...more }) });

/** Where the loop stands and which tool is next, from the state alone. */
/**
 * Where the loop stands and which tool is next, from the state alone, with `action`: the next call as data ({tool,
 * args, returns, or?}: builder/loop/order.mjs actionOf), so a host that is not an MCP client never parses `do`.
 */
export function where(S, game) {
  const w = whereOf(S, game), h = S?.handed;
  const action = !S || S.step === 'done' ? (w.tool ? { tool: w.tool, args: w.args } : { tool: w.after?.tool ?? null, args: w.after?.args ?? null })
    : S.status === 'waiting-on-creator' ? actionOf({ waiting: 'creator', about: S.waiting?.about })
    : h ? actionOf({ waiting: S.step === 'playtest' ? 'playtest' : 'agent', kind: h.kind, step: S.step })
    : { tool: w.tool, args: w.args };
  if (action?.args && game != null) action.args = { game, ...action.args };
  if (action?.or?.args && game != null) action.or.args = { game, ...action.or.args };
  return { ...w, action };
}

function whereOf(S, game) {
  const call = (tool, more = {}) => ({ tool, args: { game, ...more } });
  if (!S) return { status: null, step: null, ...call('gamesfun_step_ledger', { idea: '<the person\'s words>' }), do: 'No run has started for this game. Start with the person\'s idea: the ledger round.' };
  const base = { status: S.status, step: S.step, why: S.why, ...(S.ladder ? { ladder: { rung: S.ladder.rung, strong: S.ladder.strong, climbs: S.ladder.climbs, owed: S.ladder.queue } } : {}) };
  if (S.status === 'waiting-on-creator') {
    const a = S.waiting?.about;
    const after = a === 'looks' ? call('gamesfun_step_look', { pick: { option: '<id>', words: '<their words>' } })
      : a === 'cards' ? call('gamesfun_step_pitch', { choice: { card: '<id>', answers: {}, words: '<their words>' } })
      : a === 'migration' ? { ...call('gamesfun_step_foundation', { approve: '<their words>' }), or: call('gamesfun_step_foundation', { decline: '<their words>' }) }
      : call('gamesfun_step_ledger', { answer: { words: '<their words>' } });
    const show = a === 'looks' ? { looks: S.look?.options } : a === 'cards' ? { pitch: S.pitch } : a === 'migration' ? { migration: S.change?.migration } : { questions: S.questions };
    return { ...base, tool: null, args: null, waitingOn: 'the person', about: a, after, ...show,
      do: a === 'looks' ? 'Show the person each look\'s contact sheet (`looks[].sheet`; a score when the judge gave one) and wait for their pick.' : a === 'cards' ? 'Show the person the cards (and the ledger\'s questions) and wait for their choice.' : a === 'migration' ? 'Show the person the migration and its consequences, in these words, and wait. Their yes goes in `approve`; their no in `decline` (the game stays on its runtime and the ledger is amended with their words).' : 'Ask the person these questions, plainly, and wait. Their answer re-enters at the ledger; "deliver it as it is" is an answer too ({deliver: true}).' };
  }
  if (S.step === 'done') return { ...base, tool: null, args: null, ...(S.outcome ? { outcome: S.outcome.outcome } : {}), after: call('gamesfun_change', { request: '<their words>' }), do: S.status === 'delivered' ? 'Delivered. Tell the person what is proven, failed and untested (the outcome\'s ledger). A change request starts with gamesfun_change.' : `This run ended (${S.status}). A new request starts with gamesfun_change.` };
  const h = S.handed;
  if (h && ROUND_STEPS.includes(S.step)) return { ...base, ...call('gamesfun_step_fix', { summary: '…', controls: '…' }), round: { kind: h.kind, model: h.model, area: h.area, message: h.message }, do: 'The round is yours (its brief is in `round`). Do the work, run gamesfun_verify until it passes, then call gamesfun_step_fix.' };
  if (h && S.step === 'playtest') return { ...base, ...call('gamesfun_step_playtest'), round: { kind: 'playtest', model: h.model, message: h.message }, do: `The play-test is with the ${PLAYTESTER} subagent; do not change the game while it plays. When it has reported, call gamesfun_step_playtest.` };
  if (h && S.step === 'read') return { ...base, ...call('gamesfun_step_read'), round: { kind: 'read', model: h.model, message: h.message }, do: `The reading is with the ${READER_AGENT} subagent; do not change the game while it reads. When it has handed its reading in, call gamesfun_step_read.` };
  if (h && S.step === 'ask') return { ...base, ...call('gamesfun_ask', { message: '…', questions: [] }), round: { kind: 'ask', message: h.message }, do: 'Write the person\'s questions and call gamesfun_ask.' };
  if (h) return { ...base, ...call(S.step === 'pitch' ? 'gamesfun_step_spec' : toolOf(S.step)), round: { kind: h.kind, message: h.message }, do: S.step === 'pitch' ? 'The pitch round is yours: pass the cards (`pitch`), or the spec when the person already chose, to gamesfun_step_spec.' : 'The round is yours: pass its result to the tool.' };
  if (S.step === 'build') return { ...base, ...call('gamesfun_step_fix'), do: 'Take the build round: the tool hands you its brief.' };
  return { ...base, ...call(toolOf(S.step)), do: ORDER.find(o => o.step === S.step)?.does ?? '' };
}

export function loopTools(bind) {
  const queue = new Map(), reports = bind.reports ?? memoryReports();
  const serial = (key, fn) => { const run = (queue.get(key) ?? Promise.resolve()).then(fn, fn); queue.set(key, run.catch(() => {})); return run; };
  const placeOf = arg => {
    if (typeof arg !== 'string' || !arg.trim()) throw new Error('game is required: the game folder, e.g. games/my-game');
    const game = path.resolve(bind.root ?? process.cwd(), arg);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(path.basename(game))) throw new Error(`${arg}: a game folder is named with letters, digits, dashes and dots`);
    return { arg, game };
  };
  const open = async G => openLoop({
    registry: bind.registry, game: G.game, gameRef: bind.gameRef?.(G) ?? G.arg, store: bind.store(G), tools: bind.tools(G), versions: bind.versions?.(G),
    limits: bind.limits, toolNames: TOOL_NAMES, ...(bind.say ? { say: (key, detail) => bind.say(G, key, detail) } : {}),
    ...(bind.sessionOf?.(G) ? { session: bind.sessionOf(G) } : {}),
    parts: bind.parts?.(G) ?? {}, readerPlays: true,
    reportHow: `Call the tool \`gamesfun_playtest_report\` with {"game": "${G.arg}", "token": "<the report token in your task message>", "report": { … }}. It checks the report and tells you what to fix; a report refused for its shape leaves the token unused.`,
    readerHow: `Call the tool \`gamesfun_reader_report\` with {"game": "${G.arg}", "token": "<the reading token in your task message>", "reading": { … }}. It checks the reading and tells you what to fix; a reading refused for its shape leaves the token unused.`,
  });
  const answer = async (G, L, r) => {
    const S = L.state, w = where(S, G.arg);
    const out = { ran: r?.ran ?? null, why: r?.why ?? S.why, ...w };
    for (const k of ['refused', 'problems', 'outcome']) if (r?.[k]) out[k] = r[k];
    if (r?.waiting === 'playtest') {
      const token = await reports.issue(G, { focus: r.focus, message: r.message, channel: 'playtest' });
      out.round = { kind: 'playtest', model: r.model, message: `${r.message}\n\nYour report token: ${token}` };
      out.do = `Start the ${PLAYTESTER} subagent with \`round.message\` as its whole task. Never play-test your own game, and do not change the game while it plays. Then call gamesfun_step_playtest.`;
    }
    if (r?.waiting === 'reader') {
      const token = await reports.issue(G, { message: r.message, channel: 'reader' });
      out.round = { kind: 'read', model: r.model, message: `${r.message}\n\nYour reading token: ${token}` };
      out.do = `Start the ${READER_AGENT} subagent with \`round.message\` as its whole task. Never read your own game for the record, and do not change the game while it reads. Then call gamesfun_step_read.`;
    }
    if (r?.waiting === 'agent' && ROUND_STEPS.includes(S.step)) await bind.handed?.(G, { step: S.step, kind: r.kind, area: r.area ?? null });
    if (S.lock && S.step !== 'ledger') { const p = proofOf(S, await bind.tools(G).hash(G.game)); out.proof = { verify: p.verify, playtest: p.playtest }; }
    return text(out);
  };
  /** Run one tool: the steps it may run, in order; a call made at another step is refused with the right tool. */
  const stepTool = (steps, prepare = null, { then = [] } = {}) => async (args) => {
    const G = placeOf(args.game);
    return serial(G.game, async () => {
      const L = await open(G);
      const S = L.state;
      if (S.status === 'waiting-on-creator' && !prepare) return refusal('waiting-on-creator', 'the person has the next move', where(S, G.arg).after?.tool, where(S, G.arg));
      if (!steps.includes(S.step) && !(prepare && S.step === 'done')) { const w = where(S, G.arg); return refusal('out-of-order', `the loop is at "${S.step}"${S.handed ? ' with a round handed over' : ''}: ${w.tool ?? w.after?.tool} is next`, w.tool ?? w.after?.tool, { step: S.step }); }
      const input = prepare ? await prepare(args, L, G) : inputOf(args);
      if (input?.refusal) return input.refusal;
      let r = await L.step(input ?? {}, { expect: steps });
      if (r.refused === 'out-of-order') return refusal(r.refused, r.why, toolOf(r.next));
      // a step that leads straight into one this tool also runs (a chosen spec is checked; a plan the build round
      // cannot start goes to its questions) runs it in the same call
      if (!r.waiting && then.includes(r.next) && r.next !== r.ran) r = await L.step({}, { expect: r.next });
      return answer(G, L, r);
    });
  };
  const inputOf = a => Object.fromEntries(Object.entries(a).filter(([k]) => k !== 'game' && k !== 'session'));
  const gameProp = { type: 'string', description: 'The game folder, relative to the kit root (e.g. games/my-game), or absolute.' };
  const sessionProp = { type: 'string', description: 'Your session id (the plugin tells you at session start). Optional: it lets the studio\'s stop guard hold this session, and no other, while the run is not over.' };
  const schema = (props = {}, required = ['game']) => ({ type: 'object', properties: { game: gameProp, session: sessionProp, ...props }, required, additionalProperties: false });
  const tool = (t, hints = HINT.step, outputSchema = STEP_OUTPUT) => ({ ...t, annotations: hints, outputSchema, handler: async (args, ctx) => {
    if (typeof args?.session === 'string' && args.session.trim() && typeof args.game === 'string') await bind.session?.(placeOf(args.game), args.session.trim());
    return t.handler(args, ctx);
  } });

  return [
    {
      name: 'gamesfun_next',
      description: 'Where the creation loop of a game stands and which tool comes next: the status, the step, the round that is with you (its brief), the ladder (the rung, what it climbed and why), what the person is asked, and whether the proof on record is about the files as they are. Reads only. Call it first in a new session, after a restart, or whenever you are unsure.',
      inputSchema: schema(),
      handler: async args => {
        const G = placeOf(args.game);
        return serial(G.game, async () => {
          const S = await bind.store(G).load(), out = where(S, G.arg);
          if (S?.lock) { const p = proofOf(S, await bind.tools(G).hash(G.game)); out.proof = { verify: p.verify, playtest: p.playtest }; }
          // the play-test or reading round under way: its message again, with the token while it is unused
          if (S?.handed && S.step === 'playtest') { const t = await reports.current(G, 'playtest'); out.round = { ...out.round, message: `${S.handed.message}${t ? `\n\nYour report token: ${t}` : ''}` }; }
          if (S?.handed && S.step === 'read') { const t = await reports.current(G, 'reader'); out.round = { ...out.round, message: `${S.handed.message}${t ? `\n\nYour reading token: ${t}` : ''}` }; }
          Object.assign(out, (await bind.extra?.next?.(G, S)) ?? {});
          return text(out);
        });
      },
    },
    {
      name: 'gamesfun_step_ledger',
      description: 'Step 1, before any card: the requirements ledger. First call with `idea` (the person\'s words): hands you the ledger round. Call again with `ledger`: it is checked (every line in the person\'s own words with a home: exists, build or probe; questions only about how friends play and what a player is, and only when their words leave it open). Also where the person\'s answer to a question comes back in (`answer`: {words} or {deliver: true}): it re-enters at the ledger.',
      inputSchema: schema({ idea: { type: 'string' }, references: { type: 'array' }, ledger: { type: 'object' }, answer: { type: 'object', properties: { words: { type: 'string' }, deliver: { type: 'boolean' } } } }),
      handler: async args => {
        const G = placeOf(args.game);
        return serial(G.game, async () => {
          const L = await open(G), S = L.state;
          if (args.answer) {
            if (!(S.status === 'waiting-on-creator' && S.waiting?.about === 'questions')) return refusal('no-question', 'nothing is asked of the person right now', where(S, G.arg).tool);
            const r = await L.step({ answer: args.answer }, { expect: 'ask' });
            if (r.next !== 'ledger') return answer(G, L, r);
            return answer(G, L, await L.step({}, { expect: 'ledger' }));
          }
          if (S.status === 'waiting-on-creator') return refusal('waiting-on-creator', 'the person has the next move', where(S, G.arg).after?.tool, where(S, G.arg));
          if (S.step !== 'ledger') return refusal('out-of-order', `the loop is at "${S.step}": ${where(S, G.arg).tool} is next`, where(S, G.arg).tool);
          return answer(G, L, await L.step(inputOf(args), { expect: 'ledger' }));
        });
      },
    },
    {
      name: 'gamesfun_step_foundation',
      description: 'Step 2: the foundation. The runtime and profile by hard limits only (devices, graphics, camera, what must be built), from the registry\'s compatibility answers; the loop by who acts when; the kind last, from the person\'s words and references. Answers each choice with why, and what the person should hear plainly (a device limit, something this game builds). A ledger line that needs a probe gets a bounded probe round first (`probes`). For a change that needs another runtime, the person sees the migration and its consequences; pass their yes as `approve`, or their no as `decline` (the game keeps its runtime, and their words amend the ledger).',
      inputSchema: schema({ probes: { type: 'array' }, approve: { type: 'string', description: 'The person\'s yes to a migration, in their words.' }, decline: { type: 'string', description: 'The person\'s no to a migration, in their words: the game stays on its runtime and the ledger is amended.' } }),
      handler: stepTool(['foundation'], async (args, L, G) => {
        if (L.state.status === 'waiting-on-creator' && !(L.state.waiting?.about === 'migration' && (args.approve || args.decline))) return { refusal: refusal('waiting-on-creator', 'the person has the next move', where(L.state, G.arg).after?.tool, where(L.state, G.arg)) };
        return inputOf(args);
      }, { then: ['ledger'] }),
    },
    {
      name: 'gamesfun_step_pitch',
      description: 'Step 3: hands you the pitch round on the foundation: 2–3 cards, each keeping every line of the ledger (a line the kit lacks is built and named in v1.build; only what the person cut is "not yet"). When the person has chosen, call it with `choice`: {card, answers, words}.',
      inputSchema: schema({ choice: { type: 'object' } }),
      handler: stepTool(['pitch'], async (args, L, G) => {
        if (L.state.status === 'waiting-on-creator' && !(L.state.waiting?.about === 'cards' && args.choice)) return { refusal: refusal('waiting-on-creator', 'the cards are with the person: call this tool with their choice', null, where(L.state, G.arg)) };
        return args.choice ? { choice: args.choice } : {};
      }),
    },
    {
      name: 'gamesfun_step_spec',
      description: 'Step 4: checks your answer. The cards (`pitch`) against the ledger and the foundation (nothing narrowed, every build line named), or a spec (`spec`) the same way; a valid spec is locked and every "the build writes it" line becomes a promise. Problems come back with the round handed to you again.',
      inputSchema: schema({ pitch: { type: 'object' }, spec: { type: 'object' } }),
      handler: stepTool(['pitch', 'spec'], null, { then: ['spec'] }),
    },
    {
      name: 'gamesfun_step_create',
      description: 'Step 5: makes the game from the locked spec on its runtime and hands you the build round: a one-page brief from the manifests of only what the spec chose, with every promise the build writes.',
      inputSchema: schema(),
      handler: async args => {
        const G = placeOf(args.game);
        return serial(G.game, async () => {
          const L = await open(G);
          if (L.state.step !== 'create') return refusal('out-of-order', `the loop is at "${L.state.step}": ${where(L.state, G.arg).tool ?? where(L.state, G.arg).after?.tool} is next`, where(L.state, G.arg).tool);
          let r = await L.step({}, { expect: 'create' });
          if (r.next === 'look') r = await L.step({}, { expect: 'look' });
          if (!r.waiting && r.next === 'design') r = await L.step({}, { expect: 'design' });
          return answer(G, L, !r.waiting && r.next === 'build' ? await L.step({}, { expect: 'build' }) : r);
        });
      },
    },
    {
      name: 'gamesfun_step_look',
      description: 'The look, before the build round (builder/look). When the style target has to be read from the references and the person\'s words, the round hands you the frames and a fixed rubric: read every frame and pass your answer as `judged`. Then 2–3 readings of the target are drawn as contact sheets on the game\'s own world and bodies; show the person the sheets and pass their pick as `pick`: {option, words}. The pick goes into config/look.json and the build round follows.',
      inputSchema: schema({ judged: { type: 'object', description: 'The rubric\'s answer: lighting, materials, shapes, camera, ui, vfx, reads, avoid, outline, roles.' }, pick: { type: 'object', properties: { option: { type: 'string' }, words: { type: 'string' } }, description: 'The look the person picked, and their words.' } }),
      handler: stepTool(['look'], async (args, L, G) => {
        if (L.state.status === 'waiting-on-creator' && !(L.state.waiting?.about === 'looks' && args.pick)) return { refusal: refusal('waiting-on-creator', 'the looks are with the person: call this tool with their pick', null, where(L.state, G.arg)) };
        return { ...(args.judged ? { judged: args.judged } : {}), ...(args.pick ? { pick: args.pick } : {}) };
      }, { then: ['look', 'design'] }),
    },
    {
      name: 'gamesfun_step_design',
      description: 'The play, before the build round (builder/play/design.mjs). The first call hands you the designer round: the person\'s words, the ledger, the foundation\'s parts with their params, the world and the references, and the play target\'s fields. Design how it plays (reason from the genre their words point to; never narrow the idea) and pass the target as `target`: verbs, beats, the objective and how it is reached on this world, touchpoints, risk, pacing numbers, events, feel, the failures it avoids, what makes it play (3–6 lines, each a promise the play-tester checks), mechanics, build lines, params and bots. It is checked; its mechanics and build lines join the spec, and the build round follows.',
      inputSchema: schema({ target: { type: 'object', description: 'The play target (builder/spec/play-target.schema.json), less schema, from, confidence and sources.' } }),
      handler: stepTool(['design'], async args => (args.target ? { target: args.target } : {}), { then: ['build'] }),
    },
    {
      name: 'gamesfun_step_fix',
      description: 'Ends your round (the build round, a repair, specialist or generation round) and runs the mechanical repairs. Pass `summary` (2–4 sentences on what the person will see) and `controls`. With no round handed yet, it hands you the build round instead.',
      inputSchema: schema({ summary: { type: 'string' }, controls: { type: 'string' } }),
      handler: async args => {
        const G = placeOf(args.game);
        return serial(G.game, async () => {
          const L = await open(G), S = L.state;
          if (!['build', 'repair', 'fix'].includes(S.step) || (S.step === 'repair' && !S.handed)) return refusal('out-of-order', `the loop is at "${S.step}": ${where(S, G.arg).tool ?? where(S, G.arg).after?.tool} is next`, where(S, G.arg).tool);
          let r = { ran: null };
          if (S.step !== 'fix') {
            if (!S.handed) return answer(G, L, await L.step({}, { expect: 'build' }));
            r = await L.step({ summary: args.summary ?? '', controls: args.controls ?? '' }, { expect: ['build', 'repair'] });
            if (r.next !== 'fix') return answer(G, L, r);
          }
          return answer(G, L, await L.step({}, { expect: 'fix' }));
        });
      },
    },
    {
      name: 'gamesfun_step_economy',
      description: 'Only for a game whose person kept an economy: the kit\'s economy checker on the economy the build round saved in gamesfun.json (economy_check). Refusals come back as a repair round, under the stop rule like a failed gate. Nothing is signed: going live is the person\'s own approval at delivery.',
      inputSchema: schema(),
      handler: stepTool(['economy']),
    },
    {
      name: 'gamesfun_step_backend',
      description: 'Only for a game whose person kept a backend: no secret in the game\'s files and row-level security on every table (backend_check). Refusals come back as a repair round. Connecting their own account is the person\'s, whenever they like; the game plays in the browser until then.',
      inputSchema: schema(),
      handler: stepTool(['backend']),
    },
    {
      name: 'gamesfun_step_verify',
      description: 'Step: the six gates on the files as they are (in real Chrome; minutes). The verdict is recorded with the hash of the files, so it counts only for them; each gate names what ran, passed and was skipped on this runtime. Pass: the play-test. Fail: gamesfun_step_repair.',
      inputSchema: schema(),
      handler: stepTool(['verify']),
    },
    {
      name: 'gamesfun_step_playtest',
      description: `The black-box play-test. First call: hands the ${PLAYTESTER} subagent the promise list with the controls (start it with the message; never test your own game; do not change the game while it plays). Second call: reads its report, each promise seen, not seen or unreachable. A report about files that changed since the hand-over is refused and the play-test handed over again.`,
      inputSchema: schema(),
      handler: stepTool(['playtest'], async (args, L, G) => {
        if (!L.state.handed) return {};
        const rep = await reports.take(G, 'playtest');
        if (!rep) return { refusal: refusal('no-report', `no report yet: the ${PLAYTESTER} subagent reports with gamesfun_playtest_report`, 'gamesfun_playtest_report') };
        return { report: rep };
      }),
    },
    {
      name: 'gamesfun_playtest_report',
      description: `For the ${PLAYTESTER} subagent only: hands in its report for the round under way, with the round's one-time token from its task message. Every promise asked is seen (with evidence), not-seen or unreachable (with a note). Problems come back and nothing is kept.`,
      inputSchema: schema({ token: { type: 'string', minLength: 1, description: 'This round\'s report token, from the task message the play-tester was started with.' }, report: PLAYTEST_REPORT }, ['game', 'token', 'report']),
      handler: async args => {
        const G = placeOf(args.game);
        return serial(G.game, async () => {
          const S = await bind.store(G).load();
          if (!(S?.step === 'playtest' && S.handed)) return refusal('out-of-order', 'no play-test round is under way for this game');
          const bad = await reports.check(G, args.token, 'playtest');
          if (bad) return refusal('bad-token', bad);
          const focus = S.handed.focus ?? [];
          const r = readReport(args.report, focus, { friends: focus.filter(id => (S.promises ?? []).find(p => p.id === id)?.friends) });
          if (!r.ok) return refusal('bad-report', 'the report is not complete yet; nothing was kept (the token is still yours)', null, { problems: r.problems });
          await reports.keep(G, args.report, 'playtest');
          return text({ ok: true, kept: true, do: 'The report is in. The session reads it with gamesfun_step_playtest.' });
        });
      },
    },
    {
      name: 'gamesfun_step_read',
      description: `The second reader, before delivery. First call: hands the ${READER_AGENT} subagent the person's words, the ledger, the promises with the play-tester's log and the captures, never your transcript or the spec (start it with the message; never read your own game for the record; do not change the game while it reads). Second call: takes its reading, every ledger line kept, partly, lost or cannot-tell. Advisory: it never sends the loop back, and its marks and findings join the delivery ledger.`,
      inputSchema: schema(),
      handler: stepTool(['read'], async (args, L) => {
        if (!L.state.handed) return {};
        const reading = await reports.take(placeOf(args.game), 'reader');
        if (!reading) return { refusal: refusal('no-reading', `no reading yet: the ${READER_AGENT} subagent hands it in with gamesfun_reader_report`, 'gamesfun_reader_report') };
        return { reading };
      }),
    },
    {
      name: 'gamesfun_reader_report',
      description: `For the ${READER_AGENT} subagent only: hands in its reading for the round under way, with the round's one-time token from its task message. Every ledger line is marked kept, partly, lost or cannot-tell, with a reason (and evidence for kept or partly). Problems come back and nothing is kept.`,
      inputSchema: schema({ token: { type: 'string', minLength: 1, description: 'This round\'s reading token, from the task message the reader was started with.' }, reading: READING }, ['game', 'token', 'reading']),
      handler: async args => {
        const G = placeOf(args.game);
        return serial(G.game, async () => {
          const S = await bind.store(G).load();
          if (!(S?.step === 'read' && S.handed)) return refusal('out-of-order', 'no reading round is under way for this game');
          const bad = await reports.check(G, args.token, 'reader');
          if (bad) return refusal('bad-token', bad);
          const r = readReading(args.reading, liveRows(S.ledger).map(x => x.id));
          if (!r.ok) return refusal('bad-reading', 'the reading is not complete yet; nothing was kept (the token is still yours)', null, { problems: r.problems });
          await reports.keep(G, args.reading, 'reader');
          return text({ ok: true, kept: true, do: 'The reading is in. The session takes it with gamesfun_step_read.' });
        });
      },
    },
    {
      name: 'gamesfun_step_repair',
      description: 'Hands you the next repair round after a failed verify or play-test. The stop rule holds: when a round fails on the same set as the last, or an earlier set comes back, the loop climbs the ladder instead of repeating: the stronger model, then one specialist round per area stuck (art, sound, netcode, feel, code), then a paid generation round, then questions for the person (gamesfun_ask). Cost never ends a build. End each round with gamesfun_step_fix.',
      inputSchema: schema(),
      handler: async args => {
        const G = placeOf(args.game);
        return serial(G.game, async () => {
          const L = await open(G), S = L.state;
          if (S.step !== 'repair' || S.handed) return refusal('out-of-order', `the loop is at "${S.step}"${S.handed ? ' with a round handed over' : ''}: ${where(S, G.arg).tool} is next`, where(S, G.arg).tool);
          const r = await L.step({}, { expect: 'repair' });
          return answer(G, L, r.next === 'ask' && !r.waiting ? await L.step({}, { expect: 'ask' }) : r);
        });
      },
    },
    {
      name: 'gamesfun_ask',
      description: 'Questions for the person. At the top of the ladder: write at most 3 questions (with options and a default) and one or two plain sentences on what is in the way; the run waits on their answer. From inside the build round: for a plan that cannot start at all. From inside a repair round: you give that round up with the reason; it counts as a round that changed nothing, so the ladder climbs. Never a way around a failing gate.',
      inputSchema: schema({ message: { type: 'string' }, questions: { type: 'array' } }, ['game', 'message']),
      handler: stepTool(['ask', 'build', 'repair'], async (args, L) => {
        const q = { message: args.message, questions: args.questions ?? [] };
        if (L.state.step === 'ask') return { questions: q };
        if (!L.state.handed) return { refusal: refusal('no-round', 'no round of yours is under way', where(L.state, null).tool) };
        return { gaveUp: args.message, questions: q };
      }, { then: ['ask'] }),
    },
    {
      name: 'gamesfun_step_deliver',
      description: 'The last step: hands the version over with its ledger, every line the person gave proven, failed or untested (and the lines they cut). Proof must be about the files as they are: stale proof sends the loop back to verify or the play-test.',
      inputSchema: schema(),
      handler: stepTool(['deliver']),
    },
    {
      name: 'gamesfun_change',
      description: 'A change request on a game whose run is over: it re-enters at the ledger. The ledger is amended in the person\'s words; a change of look never changes play (the spec round is held to it), and a change that needs another runtime is shown as a migration with its consequences before anything moves.',
      inputSchema: schema({ request: { type: 'string', minLength: 1 } }, ['game', 'request']),
      handler: async args => {
        const G = placeOf(args.game);
        return serial(G.game, async () => {
          const L = await open(G);
          // a game made outside the loop (create, a composed level) has no run: the loop takes it as it is first
          const made = !L.state.lock && !L.state.prompt ? await readFile(path.join(G.game, 'spec.json'), 'utf8').then(JSON.parse, () => null) : null;
          const r = made ? await L.adopt(made, args.request) : await L.change(args.request);
          if (r.refused) return refusal(r.refused, r.why, where(L.state, G.arg).tool);
          return answer(G, L, await L.step({}, { expect: 'ledger' }));
        });
      },
    },
  ].map(t => tool(t, HINTS_OF[t.name] ?? HINT.step, t.name === 'gamesfun_next' ? NEXT_OUTPUT : t.name === 'gamesfun_playtest_report' || t.name === 'gamesfun_reader_report' ? REPORT_OUTPUT : STEP_OUTPUT));
}
/** The hints that differ from a plain step: reading only, or a step that writes the game's files. */
const HINTS_OF = { gamesfun_next: HINT.read, gamesfun_step_create: HINT.writes, gamesfun_step_fix: HINT.writes, gamesfun_step_deliver: HINT.writes };
