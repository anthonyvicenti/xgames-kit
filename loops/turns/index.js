// loop: turns (open builder M4-C). One player acts at a time, in order. The host owns the order, whose turn it is and
// the turn clock; a move goes to the host, who plays it or refuses it with a reason the player reads; the turn is shown
// on every screen; a bot acts on its own turn only; a seat that leaves is taken out of the order and one that joins
// goes to its end. The lobby, countdown, results and replay are the session's, as for every flow.
//
// The game gives the moves (rules.js hooks, all optional):
//   move(ctx, player, move)       host: play it and return nothing; or return the reason it is not allowed (words the
//                                 player reads); or { again: true } to keep the turn (a capture that goes on)
//   turnStart(ctx, player)        every copy: a turn began (highlight, a sound, a hint)
//   turnTimeout(ctx, player)      host: the turn clock ran out → a move to play for them, or nothing (the turn passes)
//   botMove(ctx, bot)             host: the move a bot plays on its turn, after it has thought (params.botThink).
//                                 A game with bot(ctx, p, dt) instead gets it called on the bot's turn only, and that
//                                 hook calls ctx.turns.submit(move, p) when the bot is where it wants to be
//   check(ctx)                    host: is the game over? as in a timed round
// and asks for one from input: ctx.turns.submit(move) (any copy, for its own player).
//
// A mechanic that plays its own moves (the board, kit/mechanics/board) joins with ctx.turns.drive(...): README.md here.
//
//   ctx.turns.current()  order()  isTurn(p = ctx.me)  left()  number
//   ctx.turns.submit(move, p = ctx.me) → null when it went (or was sent to the host), else the reason
//   host: ctx.turns.pass(why = 'pass')  done(player, { again })  next()  seat(p)
//   ctx.turns.onTurn(fn)   every copy: { player, number, why }      onMove(fn) / onRefuse(fn)   host
import { boardAdapter } from './board.js';

export const id = 'turns';
const D = { turnSeconds: 20, botThink: 1.1, first: 'rotate', late: 'join', show: true, textYourTurn: 'Your turn', textTheirTurn: '{name}\'s turn', textNotYourTurn: 'Not your turn' };
const num = (description, minimum, maximum, d) => ({ type: 'number', minimum, maximum, default: d, description });
const str = (description, d) => ({ type: 'string', maxLength: 40, default: d, description });
export const params = { type: 'object', additionalProperties: false, properties: {
  turnSeconds: num('Seconds a turn may take before the host ends it: rules.turnTimeout may play a move for that player, else the turn passes (0: no limit)', 0, 300, D.turnSeconds),
  botThink: num('Seconds a bot waits on its turn before it acts', 0, 10, D.botThink),
  first: { enum: ['rotate', 'seat', 'random'], default: D.first, description: 'Who goes first: rotate (the lowest seat, then the next seat each replay), seat (always the lowest seat), random' },
  late: { enum: ['join', 'wait'], default: D.late, description: 'A player who arrives mid-game: join (the end of the order) or wait (the next game)' },
  show: { type: 'boolean', default: D.show, description: 'The goal line says whose turn it is (off when a mechanic shows it itself)' },
  textYourTurn: str('Goal line on your turn', D.textYourTurn), textTheirTurn: str('Goal line on another player\'s turn ({name})', D.textTheirTurn), textNotYourTurn: str('Refusal when it is not your turn', D.textNotYourTurn),
} };
/** The kit sounds this flow plays (create lists them in assets.json → sounds): id → [label, preset, bus]. */
export const sounds = { 'turn-pass': ['The turn passes to someone else', 'click', 'ui'], 'turn-yours': ['It is your turn', 'confirm', 'ui'], 'turn-refuse': ['A move is refused', 'error', 'ui'] };
/** Alone: the fewest bots the game can be played with (players.min - 1, at least one), not every seat. */
export function botsAlone({ min = 2 } = {}) { return Math.max(1, (Number(min) || 2) - 1); }

export function create(ctx, params, S) {
  const P = { ...D, ...params };
  const { round, R, rules, players } = S;
  // what a creator tuned in Studio (a round.* value slot) wins over the config the page loaded
  const kebab = k => k.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`);
  const V = k => { const sid = `round.${kebab(k)}`; try { return ctx.assets?.has?.(sid) ? ctx.assets.value(sid, P[k]) : P[k]; } catch { return P[k]; } };
  // o: player ids in turn order · i: whose turn (index into o) · n: moves played · p: turns that ended with no move
  // (the clock ran out, the player left or could not act) · k: moves refused · d: the round second this turn runs out
  // (0: untimed) · w: why the last turn ended · b: 1 when it is a bot's turn
  const T = ctx.shared.register('turns', { o: [], i: 0, n: 0, p: 0, k: 0, d: 0, w: '', b: 0 });
  const L = { turn: [], move: [], refuse: [] };
  const say = (list, e) => { for (const fn of [...list]) { try { fn(e); } catch (err) { console.error(err); } } };
  const unsub = (list, fn) => () => { const i = list.indexOf(fn); if (i >= 0) list.splice(i, 1); };
  const plans = new Map();
  let driven = null, shownKey = '', checkAcc = 0, lastRefusal = null;

  const playing = () => round.phase === 'playing';
  const present = p => !!p && !p.ghost && p.connected !== false;
  const current = () => (T.o.length ? players.get(T.o[T.i]) ?? null : null);
  const order = () => T.o.map(pid => players.get(pid)).filter(Boolean);
  const canAct = p => { if (!present(p)) return false; if (driven?.seated && !driven.seated(p)) return false; try { return driven?.canAct ? driven.canAct(p) !== false : rules.canAct ? rules.canAct(ctx, p) !== false : true; } catch (e) { console.error(e); return true; } };
  const clockFor = () => (V('turnSeconds') > 0 ? Math.round((round.clock + V('turnSeconds')) * 10) / 10 : 0);
  /** The index of the next player in order who is here, from `from` (-1: nobody else). */
  function nextIndex(from = T.i) {
    const n = T.o.length;
    for (let k = 1; k <= n; k++) { const j = (from + k) % n; if (present(players.get(T.o[j])) && (!driven?.seated || driven.seated(players.get(T.o[j])))) return j; }
    return -1;
  }
  /** Host: this turn is over; the next player in order who is here gets one. */
  function advance(why) {
    const j = nextIndex();
    if (j >= 0) T.i = j;
    T.d = clockFor(); T.w = why; plans.clear();
    if (driven?.setTurn) { const p = current(); if (p) { try { driven.setTurn(p); } catch (e) { console.error(e); } } }
  }
  function showRefusal(why) {
    lastRefusal = { by: ctx.me?.id ?? null, why, at: ctx.time?.now ?? 0 };
    ctx.ui?.toast?.(why); ctx.audio?.play('turn-refuse', { optional: true });
  }
  function refuse(p, why) {
    T.k += 1;
    say(L.refuse, { player: p, why });
    if (!p || p.isBot) return;
    if (p.local) showRefusal(why); else ctx.net.send('turns:no', { why: String(why).slice(0, 80) }, p.id);
  }
  /** Host: the one path a move takes. → null when played, else the reason. */
  function hostSubmit(p, move, { auto = false } = {}) {
    if (!ctx.host) return 'Only the host plays moves';
    let why = !playing() ? 'The round is not running' : !p || !T.o.includes(p.id) ? 'You are not in this game yet' : current() !== p ? V('textNotYourTurn') : null, again = false;
    if (!why) {
      let r; try { r = rules.move ? rules.move(ctx, p, move) : undefined; } catch (e) { console.error(e); r = 'The rules could not play that'; }
      if (typeof r === 'string' && r) why = r; else if (r === false) why = 'Not a legal move'; else again = !!r && r.again === true;
    }
    if (why) { refuse(p, why); return why; }
    played(p, move, { again, auto });
    return null;
  }
  /** Host: a move was played (by hostSubmit, or by a mechanic that plays its own and tells the flow: done). */
  function played(p, move, { again = false, auto = false } = {}) {
    T.n += 1;
    say(L.move, { player: p, move, auto, again });
    if (again) { T.d = clockFor(); T.w = 'again'; plans.delete(p.id); } else advance('move');
  }
  /** Host: the turn ends with no move. */
  function pass(why = 'pass') { if (!ctx.host || !playing() || !T.o.length) return; T.p += 1; advance(why); }

  /** Host, every frame while playing: who is here, the turn clock, the game's own end. */
  function seats() {
    const here = players.list().filter(p => !p.ghost), ids = new Set(here.map(p => p.id));
    // a seat that left is out of the order; the turn goes on from where it was
    if (T.o.some(pid => !ids.has(pid))) {
      const cur = T.o[T.i], gone = !ids.has(cur);
      const o = T.o.filter(pid => ids.has(pid));
      let i = o.indexOf(cur);
      if (gone) { let k = T.i; i = -1; for (let s = 1; s <= T.o.length && i < 0; s++) i = o.indexOf(T.o[(k + s) % T.o.length]); if (i < 0) i = 0; }
      T.o = o; T.i = Math.max(0, i);
      if (gone && o.length) { T.p += 1; T.d = clockFor(); T.w = 'left'; plans.clear(); if (driven?.setTurn) { const p = current(); if (p) driven.setTurn(p); } }
    }
    // a seat that joined goes to the end of the order (params.late "wait": at the next game)
    if (P.late === 'join') { const add = here.filter(p => !T.o.includes(p.id) && (!driven?.seated || driven.seated(p))).sort((a, b) => (a.seat ?? 0) - (b.seat ?? 0)); if (add.length) T.o = [...T.o, ...add.map(p => p.id)]; }
  }
  /** Host: the game's own end, and the cap on the whole game when the config gives one (round.seconds). */
  function ends(dt) {
    if (round.phase !== 'playing') return;
    if (Number.isFinite(R.seconds) && R.seconds - round.clock <= 0) return S.enterResults(null, 'time');
    if ((checkAcc += dt) >= 0.1) {
      checkAcc = 0;
      let r = null; try { r = rules.check?.(ctx) ?? null; } catch (e) { console.error(e); }
      if (r) S.enterResults(Array.isArray(r.winners) ? r.winners : null, r.reason ?? 'won');
    }
  }
  const api = {
    id,
    /** Whose turn it is (a player), or null before anyone is seated. */
    current,
    /** The players in turn order. */
    order,
    isTurn: (p = ctx.me) => !!p && playing() && current() === p,
    /** Seconds left of this turn, or null when turns are untimed. */
    left: () => (playing() && T.d > 0 ? Math.max(0, T.d - round.clock) : null),
    /** Turns begun so far in this game (1 on the first). */
    get number() { return T.n + T.p + 1; },
    /** A player's place in the order (0 first), or -1. */
    seat: p => (p ? T.o.indexOf(p.id) : -1),
    /** Host: who plays after the current player (nobody's turn changes). */
    next() { const j = nextIndex(); return j >= 0 ? players.get(T.o[j]) ?? null : null; },
    /** Any copy, for a player it owns: ask for a move. The copy says "not your turn" at once; the host decides the rest. */
    submit(move, p = ctx.me) {
      if (!p || !(p.owned || ctx.host)) return 'Not your player';
      if (ctx.host) return hostSubmit(p, move);
      if (!playing()) return 'The round is not running';
      if (current() !== p) { const why = V('textNotYourTurn'); showRefusal(why); return why; }
      ctx.net.send('turns:move', { m: move ?? null }, 'host');
      return null;
    },
    pass,
    /** Host: a mechanic that plays its own moves says one was played ({ again: true } keeps the turn). */
    done(p, o = {}) { if (ctx.host && playing() && p && current() === p) played(p, o.move ?? null, o); },
    /** Host: a move was refused by a mechanic that judges its own (so the count is the flow's on every screen). */
    refused(p, why) { if (ctx.host) { T.k += 1; say(L.refuse, { player: p, why }); } },
    /**
     * Join a mechanic that plays its own moves (the board): it tells the flow when one was played, the flow tells it
     * whose turn it is. d = { seated(p) → is this player in the mechanic's game, canAct(p) → has a move now,
     * setTurn(p) host: hand it the turn, onMove(fn({ player, again })) the mechanic played a move, timeout(p) → host:
     * play for a player whose clock ran out (true when it did), bots: true when the mechanic plays for bots itself,
     * shows: true when it says whose turn it is itself }. README.md has the board's five lines.
     */
    drive(d = {}) {
      driven = d;
      if (typeof d.onMove === 'function') d.onMove(e => { if (ctx.host && e?.player) api.done(e.player, { move: e.move ?? null, again: !!e.again, auto: !!e.auto }); });
      if (typeof d.onRefuse === 'function') d.onRefuse(e => api.refused(e?.player ?? null, e?.why ?? ''));
      return api;
    },
    onTurn(fn) { L.turn.push(fn); return unsub(L.turn, fn); },
    onMove(fn) { L.move.push(fn); return unsub(L.move, fn); },
    onRefuse(fn) { L.refuse.push(fn); return unsub(L.refuse, fn); },

    // ---- what the session and the boot call ----
    /** Every copy, when play starts: the host seats the round's players in order. */
    begin() {
      shownKey = ''; plans.clear(); checkAcc = 0;
      // a board in the game plays its own moves: the flow joins it once (board.js), with no line in rules.js
      if (!driven) { const b = ctx.mechanics?.get?.('board'); if (b && !b.standin && typeof b.setTurn === 'function') api.drive(boardAdapter(ctx, b, api)); }
      if (!ctx.host) return;
      const list = players.list().filter(p => !p.ghost).sort((a, b) => (a.seat ?? 0) - (b.seat ?? 0));
      const n = Math.max(1, list.length);
      const first = P.first === 'seat' ? 0 : P.first === 'random' ? Math.floor((ctx.rng?.() ?? Math.random()) * n) % n : ((round.number ?? 1) - 1) % n;
      Object.assign(T, { o: list.map(p => p.id), i: first, n: 0, p: 0, k: 0, d: clockFor(), w: 'start', b: list[first]?.isBot ? 1 : 0 });
    },
    reset() { shownKey = ''; plans.clear(); },
    hostTick(dt) {
      round.clock += dt;
      // a mechanic that seats its own players does so in the frame play starts; once its game is decided no turn runs
      const held = !!driven && ((driven.ready && !driven.ready()) || (driven.over && driven.over()));
      if (held) { if (driven.over?.() && T.d) T.d = 0; return ends(dt); }
      seats();
      const cur = current();
      // a mechanic that seats its own players (the board) has the turn where the flow says
      if (cur && driven?.turnOf) { try { if (driven.turnOf() !== cur && driven.setTurn) driven.setTurn(cur); } catch (e) { console.error(e); } }
      if (T.o.length && (!cur || !canAct(cur))) {
        // away, or with no move: the turn passes to someone who can act. When nobody here has a move the game is over;
        // when nobody is here the table waits
        const here = order().filter(present);
        if (here.some(canAct)) pass(present(cur) ? 'no move' : 'away');
        else if (here.length && (driven?.canAct || rules.canAct) && T.n > 0) return S.enterResults(null, 'nobody can move');
        // no move was ever possible (the rules refuse everything): the turn still goes round on its clock, so the
        // flow's signs can say that nothing is ever played, instead of a round that ends as it starts
        else if (cur && present(cur) && T.d > 0 && round.clock >= T.d) pass('no move');
      } else if (cur && T.d > 0 && round.clock >= T.d) {
        // the turn clock ran out: the game (or the mechanic) may play for them; else the turn passes
        let went = false;
        try {
          if (driven?.timeout) went = driven.timeout(cur) === true;
          else { const m = rules.turnTimeout?.(ctx, cur); if (m !== undefined && m !== null) went = hostSubmit(cur, m, { auto: true }) === null; }
        } catch (e) { console.error(e); }
        if (!went && current() === cur) pass('timeout');
      }
      ends(dt);
    },
    /** Every copy, every frame: a turn that began is said once (the goal line, a sound, rules.turnStart). */
    frame() {
      if (ctx.host) { const b = current()?.isBot ? 1 : 0; if (T.b !== b) T.b = b; }
      if (!playing() || !T.o.length) { if (shownKey) { shownKey = ''; if (V('show') && !driven?.shows) ctx.ui?.goal?.(null); } return; }
      const cur = current(), key = `${round.number}:${T.n + T.p}:${T.o[T.i]}`;
      if (key === shownKey || !cur) return;
      const first = !shownKey; shownKey = key;
      if (V('show') && !driven?.shows) ctx.ui?.goal?.(cur === ctx.me ? V('textYourTurn') : String(V('textTheirTurn')).replace('{name}', cur.name ?? 'Someone'));
      // a turn that comes to this screen's own player is said louder than one that passes between others: in a game
      // of waiting, the player looks away
      if (!first) ctx.audio?.play(cur === ctx.me ? 'turn-yours' : 'turn-pass', { optional: true });
      try { rules.turnStart?.(ctx, cur); } catch (e) { console.error(e); }
      say(L.turn, { player: cur, number: T.n + T.p + 1, why: T.w });
    },
    /** The clock the HUD shows: this turn's; with untimed turns the cap on the game, or none (Infinity). */
    hudLeft: () => (playing() && T.d > 0 ? Math.max(0, T.d - round.clock) : Number.isFinite(R.seconds) ? Math.max(0, R.seconds - round.clock) : Infinity),
    /** Host, for each bot every frame: may rules.bot run for it now? A bot acts on its own turn only. */
    bot(p, dt) {
      if (current() !== p || !playing()) { p.bot?.stop?.(); plans.delete(p.id); return false; }
      if (driven?.bots) return true;                         // the mechanic thinks and plays for its bots
      let plan = plans.get(p.id);
      if (!plan) { plan = { wait: V('botThink') + (ctx.rng?.() ?? 0) * 0.6 }; plans.set(p.id, plan); }
      if ((plan.wait -= dt) > 0) { p.bot?.stop?.(); return false; }
      if (rules.bot) return true;                            // the game steers it and submits when it is there
      p.bot?.stop?.();
      let m; try { m = rules.botMove?.(ctx, p); } catch (e) { console.error(e); }
      if (m === undefined || m === null || hostSubmit(p, m) !== null) { if (current() === p) pass('bot'); }
      return false;
    },
    event(name, d, from) {
      if (name === 'no') { showRefusal(String(d?.why ?? 'Refused').slice(0, 80)); return; }
      if (name !== 'move' || !ctx.host) return;
      // a move is its sender's: nobody plays for another player
      const p = players.get(from); if (!p || p.isBot) return;
      hostSubmit(p, d?.m ?? null);
    },
    /** window.__game.snapshot().flow: what the checks read as this flow's sign. */
    observe: () => ({ id, order: [...T.o], turn: T.o[T.i] ?? null, bot: !!current()?.isBot, moves: T.n, passed: T.p, refused: T.k, left: T.d > 0 ? Math.round(Math.max(0, T.d - round.clock) * 10) / 10 : null, why: T.w, lastRefusal }),
  };
  ctx.turns = api;
  return api;
}

// ---------------------------------------------------------------------------------------------------------------------
// The part's manifest (tools/catalog.mjs LOOP_MANIFEST lists the fields). The tools read it in Node; nothing in play does.
// ---------------------------------------------------------------------------------------------------------------------
export const manifest = {
  id, params,
  describe: 'Taking turns: one player acts at a time, in order; a move out of turn is refused with a reason; a clock for each turn; bots act on their own turn',
  seconds: 'cap',
  seats: { alone: 'min', late: 'join', why: 'alone, one bot per seat the game needs (players.min - 1, at least one), not every seat; a seat that leaves is out of the order, one that joins goes to its end (params.late)' },
  needs: { parts: [], world: [] },
  uses: ['board'],
  // what create refuses in a spec on this loop, with the way out (the flow owns the turn clock; a board has one too)
  refuse: spec => (spec.mechanics ?? []).filter(m => m.id === 'board' && (m.params?.turnSeconds ?? 30) !== 0).map(() => 'loop "turns" with the board mechanic: both have a turn clock. The flow owns it (round.params.turnSeconds): set the board\'s params.turnSeconds to 0'),
  state: { key: 'turns', fields: { o: 'player ids in turn order', i: 'whose turn: an index into o', n: 'moves played', p: 'turns that ended with no move (the clock, a player who left or could not act)', k: 'moves refused', d: 'the round second this turn runs out (0: untimed)', b: '1 when it is a bot\'s turn', w: 'why the last turn ended: start, move, again, timeout, left, away, no move, pass, bot' } },
  events: [
    { name: 'move', on: 'host', args: '(ctx, player, move) → nothing | the reason it is refused | { again: true }', when: 'the player whose turn it is asked for a move (ctx.turns.submit(move) on their copy): play it here' },
    { name: 'turnStart', on: 'every copy', args: '(ctx, player)', when: 'a turn began' },
    { name: 'turnTimeout', on: 'host', args: '(ctx, player) → a move | nothing', when: 'the turn clock ran out: a move to play for them, or nothing and the turn passes' },
    { name: 'botMove', on: 'host', args: '(ctx, bot) → a move | nothing', when: 'a bot\'s turn, after it has thought: the move it plays' },
  ],
  sync: { owner: 'host', how: 'the host owns the order, whose turn it is, the turn clock and every move; a copy sends its move and is told why when it is refused' },
  note: [
    'The kit keeps the order, whose turn it is, the turn clock, the "not your turn" refusal, the goal line and the bots\' waiting: write move(ctx, player, move) and call ctx.turns.submit(move) from the player\'s input.',
    'Keep the game\'s state in ctx.shared and draw from it on every copy; play each sound where the state changes (in update), so every screen hears a move.',
    'round.seconds is a cap on the whole game, not its length: end it in check(ctx) when the game is decided.',
  ],
  stub: {
    as: 'turns',
    // when the spec has a mechanic this flow joins (uses), the stub says this and writes none of the flow's hooks
    joined: 'The board plays its own moves and the flow joins it by itself: write no move(), botMove() or turnTimeout(). The flow owns the order, the turn clock (round.params.turnSeconds, on the HUD), a seat that leaves or joins and how many bots play alone; ctx.turns.current(), isTurn() and onTurn(fn) are there to read.',
    worked: 'move(ctx, p, m) { if (S.cells[m.cell]) return \'That cell is taken\'; S.cells[m.cell] = p.id; }   // then in update: if (ctx.me.actions.interact.pressed) ctx.turns.submit({ cell: cellUnder(ctx.me) });',
    traps: [
      'move() runs on the host only and is the one place a move changes the game: never change shared state from input',
      'a bot that has neither botMove(ctx, p) nor bot(ctx, p, dt) passes every turn',
      'score as the game goes (a point a capture, a line\'s length) or once in check(): results() reads p.score either way',
    ],
  },
  signs: {
    // n: moves, np: turns begun, k: refusals, len: seats, bot: is it a bot's turn, d: is the turn timed
    sample: sh => (sh.turns ? { turns: [sh.turns.n ?? 0, (sh.turns.n ?? 0) + (sh.turns.p ?? 0), sh.turns.k ?? 0, (sh.turns.o ?? []).length, sh.turns.b ? 1 : 0, sh.turns.d > 0 ? 1 : 0] } : null),
    judge: v => {
      let moves = 0, turns = 0, seated = 0, botStall = 0;
      for (const p of v.pages) {
        let since = null;
        for (const s of p.samples) {
          const t = s.sh?.turns; if (!Array.isArray(t) || s.ph !== 'playing') { since = null; continue; }
          moves = Math.max(moves, t[0]); turns = Math.max(turns, t[1]); seated = Math.max(seated, t[3]);
          const at = s.t ?? s.w ?? 0;
          if (t[4]) { if (!since || since.np !== t[1]) since = { at, np: t[1] }; botStall = Math.max(botStall, at - since.at); } else since = null;
        }
      }
      const P = v.game.round?.params ?? {}, limit = (P.botThink ?? 1.1) + 14;
      if (!seated) { v.add('players are seated', 'dead', 'shared.turns.o', `no round seated anyone in the turn order (${v.names})`, 'the turns flow seats the round\'s players when play starts: is the round reaching "playing"?'); return; }
      v.add('players are seated', 'ok', 'shared.turns.o', `${seated} in the turn order`);
      if (botStall > limit) v.add('a bot plays its turn', 'dead', 'shared.turns.i, n, p', `a bot held the turn for ${Math.round(botStall)} s`, 'give the rules botMove(ctx, p) → a move, or have bot(ctx, p, dt) call ctx.turns.submit(move, p); open the game with ?bots=1 and read the console');
      else if (!turns) v.add('the turn passes', 'dead', 'shared.turns.n, p', `the turn never left the first player on any page (${v.names})`, 'a turn ends on a move (rules.move accepts it) or when the turn clock runs out (round.params.turnSeconds > 0)');
      else if (!moves) v.add('a move is played', 'dead', 'shared.turns.n', `the turn passed ${turns} time${turns === 1 ? '' : 's'} and no move was ever played: bots and the turn clock only pass`, 'rules.botMove(ctx, p) must return a move rules.move accepts; rules.turnTimeout(ctx, p) may play for an idle player');
      else v.add('a move is played', 'ok', 'shared.turns.n, p', `${moves} move${moves === 1 ? '' : 's'} played over ${turns} turn${turns === 1 ? '' : 's'}`);
    },
    // verify check 12, "something happens", for this flow: moves were played and the turn went round
    pulse: { what: 'moves played in turn', min: 2, of: snapshot => snapshot?.flow?.moves ?? 0, fix: 'no move was played in a whole round with a bot: rules.botMove(ctx, p) must return a move that rules.move accepts (or bot(ctx, p, dt) must call ctx.turns.submit); rules.turnTimeout may play for an idle player' },
    // verify check 13, when no mechanic exposes anything to walk to: the press reached the flow (a move played, or
    // refused with a reason the player reads). The clock running is not a change.
    pressed: (before, after) => { const a = before?.shared?.turns, b = after?.shared?.turns; return !!a && !!b && ((b.n ?? 0) > (a.n ?? 0) || (b.k ?? 0) > (a.k ?? 0)); },
    // a check's short round (25 s): a turn clock that lets the turn go round in it, as round.seconds is cut for it
    short: () => [{ file: 'config/game.json', pointer: '/round/params/turnSeconds', value: 4 }],
  },
};
