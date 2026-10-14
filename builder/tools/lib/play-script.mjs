// The step language of tools/play.mjs (the play-tester's harness): parse and check a script before any browser starts,
// so a bad script costs nothing. Pure; tests in tests/pt-play-script.test.mjs.
//
// A script is a JSON array of steps (or {"steps": [...]}). Seconds are wall-clock seconds of play.
//
//   {"do":"start", "bots":3, "seed":1, "round":60}   open the game (always first; added when missing), the lobby, Play,
//                                                     then a click on the game takes the mouse. round: the round's
//                                                     length in seconds for this run (20–900), else the game's own
//   {"do":"hold", "key":"Mouse", "seconds":2, "shot":"firing", "look":{"dx":200}}
//                                                     hold one key (or "keys":[...] together) for N seconds; "shot" takes
//                                                     a screenshot just before letting go; "look" turns while holding
//   {"do":"press", "key":"KeyE", "times":1}           tap a key (or a mouse button)
//   {"do":"move", "dir":"forward", "seconds":1.5}     walk: forward | back | left | right, or "keys":"WD"; "sprint":true
//   {"do":"look", "dx":300, "dy":-40}                 turn the camera by mouse pixels (about 600 px is a quarter turn)
//   {"do":"fight", "seconds":8, "shot":"fighting", "dir":"back"}
//                                                     a first-person fight (forge): for N seconds, turn to the nearest
//                                                     enemy in view and fire at its body, as a new player's hand does
//                                                     (a quarter second to react to a new one, about a degree off, a
//                                                     shot three times a second); with none in view, look around for
//                                                     one. "dir" walks that way meanwhile (back, left, right, …).
//                                                     A script cannot see the screen, so this is its eyes and hand; it
//                                                     knows nothing a player's screen does not show
//   {"do":"wait", "seconds":3}
//   {"do":"shot", "name":"first-look"}               a screenshot of my own view
//   {"do":"snap", "name":"after-drink"}              the observation, trimmed: phase, time, players, the HUD text
//   {"do":"until", "phase":"results", "timeout":120}  wait until the round reaches a phase
//   {"do":"again"}                                    press "Play again" on the results card
//   {"do":"click", "x":640, "y":360}                  click a point on the screen (a button I can see)
//   {"do":"step", "seconds":20}                       let N seconds of the game go by. On a stepped page (kit/core/step.js:
//                                                     a game's own tests, tools/lib/game-tests.mjs) they pass at once,
//                                                     without waiting; in tools/play.mjs, which plays in real time as a
//                                                     player does, it is a wait
//   {"do":"expect", "path":"players[local].score", "op":">=", "value":1, "why":"a drink in the tank scores"}
//                                                     read a path in window.__game.snapshot() and hold it to a value;
//                                                     the step fails when it does not hold. Paths: dots and [index],
//                                                     [local] (the player on this screen), [key=value] (the first element
//                                                     with that field), "length" of a list. Ops: == != > >= < <= (a
//                                                     number or a string), "exists", "absent", "includes" (a list or a
//                                                     string holds the value), and against an earlier snap of the same
//                                                     path ("since":"<snap name>", default the round's start):
//                                                     "increased", "decreased", "changed", "unchanged"
// A phone (the forge play-tester, builder/spec/prompts/playtest-forge.md): {"do":"start", "touch":true} opens the
// game on a touch screen (play.mjs --size 390x844 or 844x390 picks the phone's size); then fingers, not keys:
//   {"do":"tap", "x":320, "y":700, "seconds":0.1, "shot":"fired"}     one finger down and up (hold it with "seconds")
//   {"do":"drag", "from":[90,700], "to":[90,620], "seconds":1.5, "with":{"from":[300,400], "to":[240,400]}, "shot":"walking"}
//                                                     a finger pressed at "from", slid to "to" and held there until
//                                                     the seconds are up (a stick pushed, a look swiped); "with" is a
//                                                     second finger at the same time (walk while looking or firing)
// A friend (wave 3: two players in one game, each seeing the other): {"do":"start", "friend":true} hosts the game through
// its own friends page and joins a second player, the friend, in a second window (a game folder only; no bots: a
// friends round has none). Every step then plays me, the host, unless it says "who":"friend":
//   {"do":"move", "dir":"forward", "seconds":1, "who":"friend"}       the friend walks (hold, press, move, look too)
//   {"do":"face", "walk":1}                                           both turn to look at each other where they
//                                                     stand, as each would with the mouse ("walk": the friend first
//                                                     walks forward that many seconds, so they are not side by side)
//   {"do":"shot", "name":"my-friend"} and {"do":"shot", "name":"their-view", "who":"friend"}   each player's own screen
// "again" and a phone's fingers are for a round alone.
//
// Keys: Mouse (left button), MouseRight, Space, ShiftLeft, KeyA–KeyZ, Digit0–9, Enter, Escape, Tab, Arrow*; shorthands
// "E" → KeyE, "click" → Mouse, "right click" → MouseRight, "Shift" → ShiftLeft.
export const LIMITS = { steps: 200, holdSeconds: 20, waitSeconds: 120, untilSeconds: 300, totalSeconds: 300, look: 3000, bots: 7 };
export const DOS = ['start', 'hold', 'press', 'move', 'look', 'fight', 'wait', 'shot', 'snap', 'until', 'again', 'click', 'tap', 'drag', 'face', 'step', 'expect'];
/** The steps a friend can be told to do ("who": "friend"). */
export const FRIEND_DOS = ['hold', 'press', 'move', 'look', 'shot', 'snap'];
/** What an expect step can ask of a value; the last four compare it with an earlier snap of the same path. */
export const EXPECT_OPS = ['==', '!=', '>', '>=', '<', '<=', 'exists', 'absent', 'includes', 'increased', 'decreased', 'changed', 'unchanged'];
const SINCE_OPS = ['increased', 'decreased', 'changed', 'unchanged'];
export const PHASES = ['lobby', 'countdown', 'playing', 'results'];
const DIRS = { forward: ['KeyW'], back: ['KeyS'], backward: ['KeyS'], left: ['KeyA'], right: ['KeyD'], 'forward-left': ['KeyW', 'KeyA'], 'forward-right': ['KeyW', 'KeyD'], 'back-left': ['KeyS', 'KeyA'], 'back-right': ['KeyS', 'KeyD'] };
const NAMED = new Set(['Mouse', 'MouseRight', 'Space', 'ShiftLeft', 'ShiftRight', 'Enter', 'Escape', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ControlLeft']);
const ALIAS = { click: 'Mouse', mouse: 'Mouse', lmb: 'Mouse', 'left click': 'Mouse', 'mouse left': 'Mouse', rmb: 'MouseRight', 'right click': 'MouseRight', 'mouse right': 'MouseRight', mouseright: 'MouseRight', space: 'Space', shift: 'ShiftLeft', enter: 'Enter', escape: 'Escape', esc: 'Escape', tab: 'Tab' };

/** A key name as the browser knows it (KeyboardEvent.code, or Mouse / MouseRight), or null. */
export function normKey(k) {
  if (typeof k !== 'string') return null;
  const s = k.trim();
  if (NAMED.has(s) || /^Key[A-Z]$/.test(s) || /^Digit[0-9]$/.test(s)) return s;
  if (/^[A-Za-z]$/.test(s)) return `Key${s.toUpperCase()}`;
  if (/^[0-9]$/.test(s)) return `Digit${s}`;
  return ALIAS[s.toLowerCase()] ?? null;
}
/** A screenshot or snapshot name: lowercase words and dashes, at most 40 characters. */
export const safeName = n => String(n ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

const num = (v, lo, hi) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;

/**
 * → {steps, notes, seconds} with every step normalised ({do, ...}, keys as codes, names safe), or throws an Error whose
 * message lists every problem (one per line, "step N (do): ..."). `input` is an array, {steps}, or JSON text.
 */
export function parseScript(input) {
  let raw = input;
  if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch (e) { throw new Error(`the script is not JSON: ${e.message}`); } }
  if (raw && !Array.isArray(raw) && Array.isArray(raw.steps)) raw = raw.steps;
  if (!Array.isArray(raw)) throw new Error('a script is a JSON array of steps, e.g. [{"do":"start"},{"do":"shot","name":"first-look"}]');
  const problems = [], notes = [], steps = [];
  if (!raw.length) problems.push('the script has no steps');
  if (raw.length > LIMITS.steps) problems.push(`the script has ${raw.length} steps; at most ${LIMITS.steps}`);
  const names = new Set();
  const withFriend = raw[0]?.do === 'start' && raw[0]?.friend === true;
  raw.forEach((s, i) => {
    const at = `step ${i + 1}${s && typeof s.do === 'string' ? ` (${s.do})` : ''}`;
    const bad = m => problems.push(`${at}: ${m}`);
    if (!s || typeof s !== 'object' || Array.isArray(s)) return bad('a step is an object like {"do":"wait","seconds":1}');
    if (!DOS.includes(s.do)) return bad(`"do" must be one of ${DOS.join(', ')}`);
    const st = { do: s.do };
    const seconds = (lo, hi, def) => { const v = s.seconds ?? def; if (!num(v, lo, hi)) bad(`"seconds" must be a number from ${lo} to ${hi}`); else st.seconds = v; };
    const shotName = (field = 'shot') => {
      if (s[field] === undefined) return;
      const n = safeName(s[field]); if (!n) return bad(`"${field}" must be a name, e.g. "firing"`);
      let u = n, k = 2; while (names.has(u)) u = `${n}-${k++}`;
      names.add(u); st[field] = u;
    };
    const look = v => {
      const o = typeof v === 'object' && v ? v : null;
      if (!o) { bad('"look" must be {"dx": pixels, "dy": pixels}'); return null; }
      const dx = o.dx ?? 0, dy = o.dy ?? 0;
      if (!num(dx, -LIMITS.look, LIMITS.look) || !num(dy, -LIMITS.look, LIMITS.look)) { bad(`look dx and dy must be numbers from -${LIMITS.look} to ${LIMITS.look}`); return null; }
      return { dx, dy };
    };
    switch (s.do) {
      case 'start':
        if (i !== 0) bad('"start" must be the first step (one game per run)');
        st.bots = s.bots ?? 3; if (!Number.isInteger(st.bots) || st.bots < 0 || st.bots > LIMITS.bots) bad(`"bots" must be a whole number from 0 to ${LIMITS.bots}`);
        st.seed = s.seed ?? 1; if (!Number.isInteger(st.seed) || st.seed < 0) bad('"seed" must be a whole number');
        if (s.round !== undefined) { if (!num(s.round, 20, 900)) bad('"round" (seconds) must be from 20 to 900'); else st.round = Math.round(s.round); }
        if (s.quality !== undefined) { if (!['low', 'high'].includes(s.quality)) bad('"quality" must be low or high'); else st.quality = s.quality; }
        if (s.touch !== undefined) { if (typeof s.touch !== 'boolean') bad('"touch" must be true or false'); else if (s.touch) st.touch = true; }
        if (s.friend !== undefined) {
          if (typeof s.friend !== 'boolean') bad('"friend" must be true or false');
          else if (s.friend && s.touch === true) bad('"friend" and "touch" cannot go together (a friend is joined from a desktop window)');
          else if (s.friend) { st.friend = true; st.bots = 0; if (s.bots) notes.push(`${at}: a friends round has no bots ("bots" ignored)`); }
        }
        break;
      case 'face':
        if (!withFriend) bad('"face" needs a friend in the game: start with {"do":"start","friend":true}');
        if (s.walk !== undefined) { if (!num(s.walk, 0, 5)) bad('"walk" (seconds the friend walks forward first) must be from 0 to 5'); else if (s.walk > 0) st.walk = s.walk; }
        break;
      case 'tap':
        if (!num(s.x, 0, 4000) || !num(s.y, 0, 4000)) bad('"tap" needs "x" and "y" (screen pixels)'); else { st.x = s.x; st.y = s.y; }
        seconds(0.03, LIMITS.holdSeconds, 0.08);
        shotName();
        break;
      case 'drag': {
        const point = (v, what) => { if (!Array.isArray(v) || v.length !== 2 || !num(v[0], 0, 4000) || !num(v[1], 0, 4000)) { bad(`${what} must be [x, y] in screen pixels`); return null; } return [v[0], v[1]]; };
        const from = point(s.from, '"from"'), to = s.to === undefined ? from : point(s.to, '"to"');
        if (from && to) { st.from = from; st.to = to; }
        if (s.with !== undefined) {
          const w = s.with && typeof s.with === 'object' ? s.with : null;
          const wf = w ? point(w.from, '"with.from"') : (bad('"with" must be {"from": [x, y], "to": [x, y]}'), null), wt = w && wf ? (w.to === undefined ? wf : point(w.to, '"with.to"')) : null;
          if (wf && wt) st.with = { from: wf, to: wt };
        }
        seconds(0.05, LIMITS.holdSeconds, 0.6);
        shotName();
        break;
      }
      case 'hold': {
        const list = s.keys !== undefined ? s.keys : s.key !== undefined ? [s.key] : null;
        if (!Array.isArray(list) || !list.length) { bad('"hold" needs "key" (e.g. "Mouse", "KeyE") or "keys" (a list)'); break; }
        const keys = list.map(normKey);
        if (keys.some(k => !k)) bad(`unknown key ${JSON.stringify(list[keys.indexOf(null)])}; use Mouse, MouseRight, Space, ShiftLeft, KeyA–KeyZ, Digit0–9`);
        st.keys = [...new Set(keys.filter(Boolean))];
        seconds(0.05, LIMITS.holdSeconds, 1);
        shotName();
        if (s.look !== undefined) { const l = look(s.look); if (l) st.look = l; }
        break;
      }
      case 'press': {
        const k = normKey(s.key); if (!k) bad(`"press" needs a known "key" (got ${JSON.stringify(s.key)})`); else st.key = k;
        st.times = s.times ?? 1; if (!Number.isInteger(st.times) || st.times < 1 || st.times > 10) bad('"times" must be 1 to 10');
        shotName();
        break;
      }
      case 'move': {
        let keys = null;
        if (s.dir !== undefined) keys = DIRS[String(s.dir).toLowerCase()] ?? null;
        else if (typeof s.keys === 'string' && /^[WASDwasd]{1,2}$/.test(s.keys)) keys = [...new Set(s.keys.toUpperCase().split(''))].map(c => `Key${c}`);
        if (!keys) { bad(`"move" needs "dir" (${Object.keys(DIRS).join(', ')}) or "keys" like "W" or "WD"`); break; }
        st.keys = s.sprint ? [...keys, 'ShiftLeft'] : keys;
        seconds(0.05, LIMITS.holdSeconds, 1);
        shotName();
        if (s.look !== undefined) { const l = look(s.look); if (l) st.look = l; }
        break;
      }
      case 'look': { const l = look(s); if (l) Object.assign(st, l); break; }
      case 'fight': {
        if (s.dir !== undefined) { const keys = DIRS[String(s.dir).toLowerCase()] ?? null; if (!keys) bad(`"dir" must be one of ${Object.keys(DIRS).join(', ')}`); else st.keys = keys; }
        seconds(0.5, LIMITS.holdSeconds, 5);
        shotName();
        break;
      }
      case 'wait': seconds(0, LIMITS.waitSeconds, undefined); break;
      case 'step': seconds(0, LIMITS.waitSeconds, undefined); break;
      case 'expect': {
        if (typeof s.path !== 'string' || !parsePath(s.path)) bad('"expect" needs a "path" into the snapshot, e.g. "players[local].score" or "shared.pk.p[0]"'); else st.path = s.path.trim();
        st.op = s.op ?? (s.value === undefined ? 'exists' : '==');
        const ordered = ['>', '>=', '<', '<='].includes(st.op);
        if (!EXPECT_OPS.includes(st.op)) bad(`"op" must be one of ${EXPECT_OPS.join(' ')}`);
        else if (SINCE_OPS.includes(st.op) || ['exists', 'absent'].includes(st.op)) { if (s.value !== undefined) bad(`"${st.op}" takes no "value"`); }
        else if (ordered ? typeof s.value !== 'number' || !Number.isFinite(s.value) : !['number', 'string', 'boolean'].includes(typeof s.value) && s.value !== null) bad(`"${st.op}" needs a "value" (${ordered ? 'a number' : 'a number, a string, true, false or null'})`);
        else st.value = s.value;
        if (s.since !== undefined) { if (!SINCE_OPS.includes(st.op)) bad('"since" goes with increased, decreased, changed or unchanged'); else { const n = safeName(s.since); if (!n) bad('"since" names an earlier snap'); else st.since = n; } }
        if (s.why !== undefined) st.why = String(s.why).slice(0, 200);
        break;
      }
      case 'shot': if (s.name === undefined) s.name = `shot-${i + 1}`; { const n = safeName(s.name); if (!n) bad('"name" must be a name'); else { let u = n, k = 2; while (names.has(u)) u = `${n}-${k++}`; names.add(u); st.name = u; } } break;
      case 'snap': st.name = safeName(s.name ?? '') || `snap-${i + 1}`; break;
      case 'until':
        if (!PHASES.includes(s.phase)) bad(`"phase" must be one of ${PHASES.join(', ')}`); else st.phase = s.phase;
        st.timeout = s.timeout ?? 60; if (!num(st.timeout, 1, LIMITS.untilSeconds)) bad(`"timeout" must be 1 to ${LIMITS.untilSeconds} seconds`);
        break;
      case 'again': if (withFriend) bad('"again" is for a round alone (with a friend the round is the room\'s)'); break;
      case 'click':
        if (!num(s.x, 0, 4000) || !num(s.y, 0, 4000)) bad('"click" needs "x" and "y" (screen pixels)'); else { st.x = s.x; st.y = s.y; }
        st.button = s.button === 'right' ? 'right' : 'left';
        break;
    }
    if (s.who !== undefined) {
      if (s.who !== 'friend' && s.who !== 'me') bad('"who" must be "friend" or "me"');
      else if (s.who === 'friend' && !withFriend) bad('"who":"friend" needs a friend in the game: start with {"do":"start","friend":true}');
      else if (s.who === 'friend' && !FRIEND_DOS.includes(s.do)) bad(`a friend can ${FRIEND_DOS.join(', ')}; "${s.do}" is mine`);
      else if (s.who === 'friend') st.who = 'friend';
    }
    if (withFriend && (s.do === 'tap' || s.do === 'drag')) bad('fingers are for a phone alone, not a round with a friend');
    const unknown = Object.keys(s).filter(k => !['do', 'note', ...Object.keys(st), 'key', 'keys', 'dir', 'sprint', 'name', 'look', 'button', 'touch', 'to', 'with', 'who', 'friend', 'walk', 'bots', 'why', 'value', 'since'].includes(k));
    if (unknown.length) notes.push(`${at}: ignored ${unknown.map(k => `"${k}"`).join(', ')}`);
    if (typeof s.note === 'string') st.note = s.note.slice(0, 200);
    steps.push(st);
  });
  if (steps.length && steps[0].do !== 'start' && !problems.some(p => /"start" must be the first/.test(p))) { steps.unshift({ do: 'start', bots: 3, seed: 1 }); notes.unshift('added {"do":"start","bots":3,"seed":1} as the first step'); }
  // the play time the script asks for (until counts its timeout: the most it can take)
  const seconds = steps.reduce((n, st) => n + (st.seconds ?? 0) + (st.do === 'until' ? st.timeout ?? 0 : 0) + (st.do === 'press' ? 0.15 * (st.times ?? 1) : 0) + (st.do === 'face' ? (st.walk ?? 0) + 1 : 0), 0);
  if (seconds > LIMITS.totalSeconds) problems.push(`the script asks for up to ${Math.round(seconds)} s of play; at most ${LIMITS.totalSeconds} s per run (split it into several runs)`);
  if (problems.length) throw new Error(problems.join('\n'));
  return { steps, notes, seconds: Math.round(seconds * 10) / 10 };
}

// ---------------------------------------------------------------------------------------------------------------------
// expect: a path in the observation, held to a value (pure; tools/play.mjs and tools/lib/game-tests.mjs run it)
// ---------------------------------------------------------------------------------------------------------------------

/** A path as its parts, or null when it is not one: "players[local].score" → ['players', {local: true}, 'score']. */
export function parsePath(path) {
  if (typeof path !== 'string' || !path.trim() || path.length > 200) return null;
  const out = [], re = /\.?([A-Za-z_$][\w$-]*)|\[\s*(\d+)\s*\]|\[\s*(local)\s*\]|\[\s*([A-Za-z_$][\w$]*)\s*=\s*([^\]]*?)\s*\]/y;
  const src = path.trim();
  let i = 0;
  while (i < src.length) {
    re.lastIndex = i; const m = re.exec(src);
    if (!m || re.lastIndex === i) return null;
    if (m[1] !== undefined) out.push(m[1]);
    else if (m[2] !== undefined) out.push(Number(m[2]));
    else if (m[3] !== undefined) out.push({ local: true });
    else out.push({ key: m[4], value: m[5] });
    i = re.lastIndex;
  }
  return out.length ? out : null;
}

/** Read a path in a snapshot. → {found, value}; a part that is not there gives found: false (never a throw). */
export function readPath(snapshot, path) {
  const parts = Array.isArray(path) ? path : parsePath(path);
  if (!parts) return { found: false, value: undefined };
  let v = snapshot;
  for (const part of parts) {
    if (v === null || v === undefined) return { found: false, value: undefined };
    if (typeof part === 'number') v = Array.isArray(v) ? v[part] : undefined;
    else if (typeof part === 'string') v = part === 'length' && (Array.isArray(v) || typeof v === 'string') ? v.length : typeof v === 'object' ? v[part] : undefined;
    else if (part.local) v = Array.isArray(v) ? v.find(x => x?.local === true) : undefined;
    else v = Array.isArray(v) ? v.find(x => x && String(x[part.key]) === part.value) : undefined;
    if (v === undefined) return { found: false, value: undefined };
  }
  return { found: true, value: v };
}

/**
 * Does an expect step hold? step: a parsed expect ({path, op, value?, since?}); snapshot: the observation now; base:
 * the observation the "since" ops compare with (the named snap, or the round's start). → {ok, got, line}: `line` says
 * what was expected and what was there, in words a build agent can act on.
 */
export function judgeExpect(step, snapshot, base = null) {
  const now = readPath(snapshot, step.path), show = v => (v === undefined ? 'nothing' : JSON.stringify(v));
  const what = `${step.path} ${step.op}${step.value !== undefined ? ` ${JSON.stringify(step.value)}` : ''}${step.since ? ` since ${step.since}` : ''}`;
  const done = (ok, extra = '') => ({ ok, got: now.found ? now.value : undefined, line: `${what}: ${ok ? 'holds' : 'does NOT hold'} (${step.path} is ${show(now.found ? now.value : undefined)}${extra})${step.why ? `: ${step.why}` : ''}` });
  if (step.op === 'exists') return done(now.found && now.value !== null);
  if (step.op === 'absent') return done(!now.found || now.value === null);
  if (SINCE_OPS.includes(step.op)) {
    if (!base) return done(false, '; there is no earlier snapshot to compare with');
    const was = readPath(base, step.path), a = was.found ? was.value : undefined, b = now.found ? now.value : undefined;
    const num = typeof a === 'number' && typeof b === 'number';
    const ok = step.op === 'changed' ? JSON.stringify(a) !== JSON.stringify(b) : step.op === 'unchanged' ? JSON.stringify(a) === JSON.stringify(b) : num && (step.op === 'increased' ? b > a : b < a);
    return done(ok, `, it was ${show(a)}`);
  }
  if (!now.found) return done(false);
  const v = now.value;
  switch (step.op) {
    case '==': return done(v === step.value);
    case '!=': return done(v !== step.value);
    case '>': return done(typeof v === 'number' && v > step.value);
    case '>=': return done(typeof v === 'number' && v >= step.value);
    case '<': return done(typeof v === 'number' && v < step.value);
    case '<=': return done(typeof v === 'number' && v <= step.value);
    case 'includes': return done(Array.isArray(v) ? v.includes(step.value) : typeof v === 'string' && v.includes(String(step.value)));
    default: return done(false);
  }
}
