// The play-test proves promises. The black-box tester gets the promise list with the controls, plays as a new player,
// and reports every promise it was asked about as one of:
//   seen         it happened on the tester's own screen (evidence: a screenshot or the HUD's words)
//   not-seen     the tester got where it should happen and it did not
//   unreachable  the tester could not get to where it would happen (a new player's hand, within the play budget)
// A report that leaves an asked promise out, or says seen with no evidence, is not a report: it is refused.
//
// A promise about friends (playing together, against or with each other, seeing each other: the ledger's players
// line) is proven only with two player-driven seats, never with bots (the creator, 2026-10-08: a friends round has no
// bots and needs two players). The tester plays it with {"do":"start","friend":true} (gamesfun_play hosts the game on
// its own friends page and joins a second window through the real lobby), acts as each player, and says what each
// screen saw (`screens`). The loop then reads that run's own record (play.json) with twoSeats(): a friends promise
// seen with bots, or with one player, stays untested.
export const STATUSES = ['seen', 'not-seen', 'unreachable'];
export const PLAY_MINUTES = 8;

/** Was this answer seen as its promise needs (a friends promise: with two player-driven seats)? */
export const seenAsNeeded = (p, a) => a?.status === 'seen' && (!p?.friends || a.two === true);

/** The promises a round asks: all of them the first time; a re-test asks what was not seen, and every build line. */
export function focusOf(promises, prev = null) {
  if (!prev) return promises.map(p => p.id);
  const open = new Set(Object.entries(prev.answers ?? {}).filter(([id, a]) => !seenAsNeeded(promises.find(p => p.id === id), a)).map(([id]) => id));
  return promises.filter(p => open.has(p.id) || p.kind === 'build' || !prev.answers?.[p.id]).map(p => p.id);
}

/** The tester's brief: one message, the promises with the controls. `reportHow`: how this host takes the report. */
export function playtestBrief({ promises, controls = {}, focus, game, round = 1, reportHow, minutes = PLAY_MINUTES }) {
  const asked = promises.filter(p => focus.includes(p.id));
  const keys = Object.entries(controls).map(([a, k]) => `- ${k}: ${a}`).join('\n') || '- (the game shows its controls on screen)';
  return [
    `# Play-test round ${round}`, '',
    `Play the game at ${game} as someone who has never seen it, for about ${minutes} minutes, with real keys and the mouse. You never read or change its files.`, '',
    '## The controls', '', keys, '',
    '## What it promises', '',
    'For each promise below, report exactly one status: `seen` (it happened on your screen: give the screenshot or the HUD words as evidence), `not-seen` (you got where it should happen and it did not), or `unreachable` (you could not get to where it would happen; say how far you got).', '',
    ...asked.map(p => `- \`${p.id}\`${p.core ? ' (core)' : ''}${p.friends ? ' (two players)' : ''}: ${p.text}${p.kind === 'build' ? ' (built new for this game: try it)' : ''}`), '',
    ...(asked.some(p => p.friends) ? ['## Two players', '',
      'A promise marked **(two players)** is about playing with friends. It counts only when two players, each driven by you, are in one game: start a run with `{"do":"start","friend":true}` (the game\'s own friends page: you host, a second window joins through the lobby; a friends round has no bots), act as each (a step with `"who":"friend"` plays the second player), and take a `shot` or `snap` of each screen. Give that run\'s name as `run`, and say what each screen showed in `screens`: `{"host": "…", "friend": "…"}`. Seen with bots, or alone, it stays untested, whatever you report.', '',
      ...(asked.some(p => p.friends && p.sees) ? [`Nobody is a character in this game, so seeing your friend means: ${asked.some(p => p.sees === 'boards') ? 'their own board drawn live beside yours, framed in their colour with their name and an avatar, changing as they play' : 'a seat card for them with their name, colour and an avatar that reacts (thinking on their turn, placed just after a move), their pointer moving where they point, and their moves landing on your screen as they make them'}. Act as one player and capture the other's screen right after: say in \`screens\` exactly what each screen showed of the other player.`, ''] : [])] : []),
    '## Your report', '',
    '`{"promises": [{"id", "status", "evidence": [...], "note", "run"?, "screens"?: {"host", "friend"}}], "feel": ["what a new player would say"], "summary": "…"}`', '',
    reportHow,
  ].join('\n');
}

/**
 * → {ok, problems, answers: {id: {status, evidence, note, run?, screens?}}, feel, summary}. `friends`: the ids asked that
 * are about friends; a friends promise seen needs what each screen showed.
 */
export function readReport(raw, asked, { friends = [] } = {}) {
  const problems = [], answers = {};
  const list = Array.isArray(raw?.promises) ? raw.promises : null;
  if (!list) return { ok: false, problems: ['promises: the list of answers, one per promise asked'], answers, feel: [], summary: '' };
  for (const [i, a] of list.entries()) {
    if (!asked.includes(a?.id)) { problems.push(`promises[${i}].id: "${a?.id}" was not asked this round`); continue; }
    if (!STATUSES.includes(a.status)) { problems.push(`promises[${i}].status: one of ${STATUSES.join(', ')}`); continue; }
    if (a.status === 'seen' && !(Array.isArray(a.evidence) && a.evidence.length)) { problems.push(`promises[${i}].evidence: "seen" needs what you saw (a screenshot path or the HUD's words)`); continue; }
    if (a.status !== 'seen' && !String(a.note ?? '').trim()) { problems.push(`promises[${i}].note: say what happened instead${a.status === 'unreachable' ? ', and how far you got' : ''}`); continue; }
    const screens = a.screens && typeof a.screens === 'object' ? { host: String(a.screens.host ?? '').slice(0, 600), friend: String(a.screens.friend ?? '').slice(0, 600) } : null;
    if (friends.includes(a.id) && a.status === 'seen' && !(screens?.host.trim() && screens?.friend.trim())) { problems.push(`promises[${i}].screens: "${a.id}" is a two-player promise: say what each screen showed, {"host": "…", "friend": "…"} (when you played it alone or with bots, say that: it stays untested)`); continue; }
    answers[a.id] = { status: a.status, evidence: a.evidence ?? [], note: String(a.note ?? '').slice(0, 600), ...(a.run ? { run: String(a.run).slice(0, 60) } : {}), ...(screens ? { screens } : {}) };
  }
  for (const id of asked) if (!answers[id] && !problems.some(p => p.includes(`"${id}"`))) problems.push(`promises: no answer for "${id}": every promise asked is seen, not-seen or unreachable`);
  return { ok: !problems.length, problems, answers, feel: Array.isArray(raw?.feel) ? raw.feel.slice(0, 12) : [], summary: String(raw?.summary ?? '').slice(0, 1200) };
}

/** The gamesfun_play runs an answer rests on: its `run`, and every run its evidence names (runs/<name>/…). */
export function runsOf(answer) {
  const out = new Set(answer?.run ? [answer.run] : []);
  for (const e of answer?.evidence ?? []) { const m = /(?:^|\/)runs\/([a-z0-9][a-z0-9-]{0,40})\//.exec(String(e)); if (m) out.add(m[1]); }
  return [...out];
}

const ACTS = new Set(['hold', 'press', 'move', 'look', 'fight']);
/**
 * Did this run (its play.json, builder/tools/play.mjs) have two player-driven seats? It was a friends run (hosted on the
 * game's friends page, a second window joined: no bots), each player acted, each screen was captured, and no screen
 * showed a bot. → {ok, why}
 */
export function twoSeats(play) {
  if (!play || typeof play !== 'object') return { ok: false, why: 'no record of that run' };
  if (play.friend !== true) return { ok: false, why: 'the run was not a friends run (start it with {"do":"start","friend":true})' };
  const steps = Array.isArray(play.steps) ? play.steps : [], mine = x => x.who !== 'friend', theirs = x => x.who === 'friend';
  const why = [];
  if (!steps.some(x => mine(x) && ACTS.has(x.do) && !x.error)) why.push('the host player did nothing');
  if (!steps.some(x => theirs(x) && ACTS.has(x.do) && !x.error)) why.push('the friend did nothing');
  if (!steps.some(x => mine(x) && (x.do === 'shot' || x.do === 'snap'))) why.push('no capture of the host\'s screen');
  if (!steps.some(x => theirs(x) && (x.do === 'shot' || x.do === 'snap'))) why.push('no capture of the friend\'s screen');
  const snaps = steps.filter(x => x.do === 'snap' && Array.isArray(x.state?.players));
  if (snaps.some(x => x.state.players.some(p => p.bot))) why.push('a screen showed a bot');
  if (snaps.length && !snaps.some(x => x.state.players.filter(p => !p.bot).length >= 2)) why.push('no screen showed two players');
  return why.length ? { ok: false, why: why.join('; ') } : { ok: true, why: 'two players in one game, each acting, each screen captured, no bot' };
}

/** A round's answers merged into what earlier rounds proved (a re-test asks only part of the list). */
export function mergeAnswers(prev, now) {
  return { ...(prev?.answers ?? {}), ...now.answers };
}

/**
 * How a black-box tester plays here: its hands are the `gamesfun_play` tool (builder/tools/lib/play-script.mjs is the
 * step language). The play-tester's own prompt carries it (plugin/agents/playtester.md, the headless host's tester).
 */
export const PLAY_GUIDE = [
  'You play through the tool `gamesfun_play` {"game", "name", "steps"}: a script of steps run in Chrome with real keys and the mouse, one screenshot of your own view per `shot`, and the HUD\'s words for each `snap`. Read the screenshot files it names before you judge anything.',
  'Steps (seconds are seconds of play):',
  '- `{"do":"start","bots":3,"seed":1,"round":60}` opens the game, the lobby and Play (always first). `{"do":"start","friend":true}` hosts a second player in a second window; a step with `"who":"friend"` plays them, and `{"do":"face"}` turns both to look at each other.',
  '- `{"do":"move","dir":"forward","seconds":1.5}` (forward, back, left, right; `"keys":"WD"`), `{"do":"look","dx":300,"dy":-40}` (about 600 px is a quarter turn), `{"do":"hold","key":"Mouse","seconds":2,"shot":"firing"}`, `{"do":"press","key":"KeyE"}`, `{"do":"wait","seconds":3}`.',
  '- `{"do":"shot","name":"first-look"}` (a screenshot), `{"do":"snap","name":"after"}` (phase, time, players, the HUD text), `{"do":"until","phase":"results","timeout":120}`, `{"do":"again"}` (Play again on the results card), `{"do":"click","x":640,"y":360}`.',
  '- On a phone: `{"do":"start","touch":true}`, then `{"do":"tap","x":320,"y":700}` and `{"do":"drag","from":[90,700],"to":[90,620],"seconds":1.5}`. In first person, `{"do":"fight","seconds":8}` turns to the nearest enemy you can see and fires as a new player would.',
  'Keys: Mouse, MouseRight, Space, ShiftLeft, KeyA–KeyZ, Digit0–9, Enter, Escape, Tab, Arrow*.',
  'Play in several short runs (first look and controls, then each promise, then a whole round to its end). You never read or change the game\'s files: if the screen does not show it, it did not happen for a player.',
].join('\n');

/**
 * The play-tester's own words (its system prompt): who it is, its task, how it plays, how it judges. The kit's plugin
 * agent (plugin/agents/playtester.md, scripts/gen-loop.mjs) and the headless host's tester (headless.mjs) both carry it.
 */
export function testerWords() {
  return [
    `A friend just made this game and you are the first person to play it. Play it like a new player for about ${PLAY_MINUTES} minutes, then say honestly, promise by promise, what you saw **on your own screen**. Nobody answers questions.`,
    '',
    'You are a black-box tester. You see what a player sees: the screen, the HUD and the play log. **Never open the game\'s files** (its code, `config`, `assets`, `rules.js`), the loop\'s folder or the kit\'s source. If the screen does not show it, it did not happen for a player.',
    '',
    '## Your task',
    '',
    'Your task message is this round\'s brief: the controls, the promises to check (each by its id) and how to report. It ends with the round\'s report token: pass it as `"token"` to `gamesfun_playtest_report`, beside `"game"` and `"report"`. It works once, so check the report before you send it; a report the tool refuses for its shape leaves the token unused. You write no file and run no command.',
    '',
    '## How you play',
    '',
    PLAY_GUIDE,
    '',
    '## Judge',
    '',
    `Every promise you are asked about gets exactly one status: ${STATUSES.map(s => `\`${s}\``).join(', ')}.`,
    '- `seen`: it happened on your own screen. Give the evidence: a screenshot path from `gamesfun_play`, or the HUD\'s words from a snap.',
    '- `not-seen`: you got to where it should happen and it did not. Say what happened instead in `note`.',
    '- `unreachable`: you could not get to where it would happen with a new player\'s hand in the time you had. Say how far you got.',
    '- A promise marked **built new for this game** is a part the game wrote for itself: always try it.',
    '- A promise marked **(two players)** is about friends: play it with `{"do":"start","friend":true}`, act as each player, capture each screen, and give the run as `run` and what each screen showed as `screens`. With bots or alone it stays untested.',
    '- When nobody in the game is a character (a board, a table, cards, a puzzle), you see a friend by their seat card (name, colour, an avatar that reacts), their pointer and their moves landing on your screen, or by their own board drawn live beside yours: a friends promise is seen only when each screen showed that of the other.',
    '- A control is not seen when pressing it does nothing you can see, or does it somewhere you cannot see (behind you, off screen, under your own character).',
    '- If the game does not load or play at all, every promise is `unreachable`, with what you saw in the note.',
    '',
    '## What holds you to this',
    '',
    'Not only these words. The loop reads only a report written through `gamesfun_playtest_report` with the round\'s token, so a report the main session wrote is refused. In Claude Code the kit\'s plugin also denies your Read outside your own play-test folder and the report tool to anyone but you.',
    '',
    'When the report is in, answer with two or three plain sentences: what worked, what did not, what you could not reach.',
  ].join('\n');
}
