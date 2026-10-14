/*! games.fun multiplayer kit: presence.js v1.8.0, how a friend is seen when the players are not characters. MIT.
 *
 * Kit-owned and byte-identical in every game (never edit a copy). Standard: builder/multiplayer/STANDARD.md, "Seeing a
 * friend with no character".
 *
 * The bar (the creator, 2026-10-05): friends are in one game, in sync, and each player sees the others as a character.
 * A board, a card table or a puzzle has no character, so the bar is met by presence (the creator, 2026-10-14: "You can
 * fix seeing your friend default"). Which presence a game gets is its SHAPE, chosen from how friends play together
 * (spec multiplayer.together) and from whether a player is a character at all, never per game:
 *
 *   character  the players walk the world as characters: each sees the others where they really are (no part here)
 *   seats      one shared board or table: every friend has a seat card (name, colour, an avatar that reacts: waiting,
 *              thinking on their turn, placed just after a move, won, lost, away), a live pointer where they point,
 *              and their moves land on everyone's screen as they make them
 *   boards     each player has their own board (falling blocks, a puzzle side by side): each friend's board is drawn
 *              live beside yours, framed in their colour, with their avatar on its rim and their score
 *
 * This file is the part that is not drawing: the shape, and the small state each copy keeps and sends of its own player
 * (the pointer, the mood, the moves made, the last move, the board). Each copy owns its own player's presence and sends
 * it to everyone, at most `rate` times a second and only when it changed; what the host owns (a shared board, the
 * turn, the result) stays the host's and is read from the shared state by whoever draws it. A runtime draws it (three:
 * gf/three/ui/presence.js).
 *
 *   import { shapeOf, createPresence } from './gf/mp/presence.js';
 *   const shape = shapeOf({ together: 'turns', held: ['mark'] });         // 'seats'
 *   const P = createPresence({ shape, send: (type, data) => net.send(type, data, 'all') });
 *   P.set({ pointer: [3, 2] });  P.set({ moves: 4, last: [3, 0], mood: 'placed' });  P.set({ board: { cols, rows, g } });
 *   net.on('presence:me', (d, from) => P.receive(d, from));
 *   every frame: P.frame(dt);  P.of(id) → { id, pointer, mood, moves, last, board, score, at }
 */
export const VERSION = '1.8.0';
export const SHAPES = ['character', 'seats', 'boards'];
export const MOODS = ['waiting', 'thinking', 'placed', 'won', 'lost', 'draw', 'away', 'cheer', 'ouch', 'out'];
/** The message a copy sends of its own player. */
export const MESSAGE = 'presence:me';

const has = (o, k) => Object.prototype.hasOwnProperty.call(o ?? {}, k);

/**
 * What the chosen parts say about the player's body: for each mechanic of the game, every `holds` entry of its
 * manifest whose `when` matches the mechanic's params (a param left out takes the schema's default). An entry's `as` is
 * 'mark' (the player acts through a mark over a shared board: a board's cursor) or 'board' (the player plays a board of
 * their own). → ['mark' | 'board', …]
 *   mechanics   [{id, params}] as the spec or config/game.json has them
 *   manifestOf  id → the part's manifest ({holds, params}) or null
 */
export function heldBy(mechanics = [], manifestOf = () => null) {
  const out = [];
  for (const m of mechanics ?? []) {
    const man = manifestOf(m?.id);
    for (const h of man?.holds ?? []) {
      const p = m?.params ?? {}, defaults = man?.params?.properties ?? {};
      const matches = Object.entries(h?.when ?? {}).every(([k, v]) => (has(p, k) ? p[k] : defaults[k]?.default) === v);
      if (matches && (h.as === 'mark' || h.as === 'board')) out.push(h.as);
    }
  }
  return out;
}

/**
 * The shape of a game's friends, from how they play together and whether a player is a character.
 *   together  versus | coop | teams | turns | own-board | solo (spec multiplayer.together)
 *   presence  what the spec says outright (multiplayer.presence), for a game whose own code holds the players (a
 *             falling-blocks well written in src/): it wins when it is a shape
 *   held      heldBy(…): what the chosen parts say (a part's own board for each player → boards; a mark over one
 *             shared board → seats). `together` alone never makes a shape: own-board with walking characters is a
 *             character game, and the loop writes `presence` when the person's words say the players are no characters
 * → 'character' | 'seats' | 'boards', or null for a solo game
 */
export function shapeOf({ together = 'versus', presence = null, held = [] } = {}) {
  if (together === 'solo') return null;
  if (SHAPES.includes(presence)) return presence;
  if (held.includes('board')) return 'boards';
  if (held.includes('mark')) return 'seats';
  return 'character';
}

/** What each shape shows a friend, in plain words (the standard, the play-tester's brief, the gate's failures). */
export const SEES = {
  character: 'each friend is a character in their colour, where they really are',
  seats: 'each friend has a seat card with their name, colour and an avatar that reacts (thinking on their turn, placed just after a move, won or lost), a pointer where they point, and their moves land on your screen as they make them',
  boards: 'each friend\'s own board is drawn live beside yours, framed in their colour, with their name, their avatar on its rim and their score',
};

const cell = v => (Array.isArray(v) && v.length === 2 && Number.isInteger(v[0]) && Number.isInteger(v[1]) && v[0] >= 0 && v[1] >= 0 && v[0] < 64 && v[1] < 64 ? [v[0], v[1]] : null);
/** A board as it travels: {cols, rows, g: one letter a cell ('.' empty)}, at most 64 by 64. */
const board = b => {
  if (!b || typeof b !== 'object') return null;
  const cols = b.cols | 0, rows = b.rows | 0, g = String(b.g ?? '');
  return cols > 0 && rows > 0 && cols <= 64 && rows <= 64 && g.length === cols * rows ? { cols, rows, g } : null;
};
/** One player's presence made safe (what a copy sends, or what arrived). */
export function clean(d) {
  const out = {};
  if (!d || typeof d !== 'object') return out;
  if (has(d, 'pointer')) out.pointer = cell(d.pointer);
  if (has(d, 'mood')) out.mood = MOODS.includes(d.mood) ? d.mood : 'waiting';
  if (has(d, 'moves')) out.moves = Math.max(0, Math.min(1e6, d.moves | 0));
  if (has(d, 'last')) out.last = cell(d.last);
  if (has(d, 'board')) out.board = board(d.board);
  if (has(d, 'score')) out.score = Number.isFinite(d.score) ? d.score : null;
  return out;
}

/**
 * Each copy's presence state. `send(type, data)` reaches every other copy; `now()` is seconds.
 *   set(patch)            this copy's own player: {pointer, mood, moves, last, board, score}
 *   receive(data, from)   a friend's, as it arrived (from: the sender's player id)
 *   frame(dt)             send what changed, at most `rate` a second
 *   of(id)                {id, pointer, mood, moves, last, board, score, at (seconds since it last changed), mine}
 *   ids()                 every player heard from, and this one
 *   forget(id)            a player left
 */
export function createPresence({ shape = 'seats', me = () => null, send = () => {}, now = () => (globalThis.performance?.now?.() ?? Date.now()) / 1000, rate = 10 } = {}) {
  const peers = new Map(), mine = { moves: 0, mood: 'waiting', pointer: null, last: null, board: null, score: null };
  let sent = '', wait = 0, mineAt = now();
  const key = o => JSON.stringify([o.pointer, o.mood, o.moves, o.last, o.board?.g ?? null, o.score]);
  const api = {
    shape, version: VERSION,
    set(patch) { const c = clean(patch); if (key({ ...mine, ...c }) !== key(mine)) mineAt = now(); Object.assign(mine, c); },
    receive(d, from) {
      if (typeof from !== 'string' && typeof from !== 'number') return;
      const id = String(from), was = peers.get(id) ?? { moves: 0, mood: 'waiting', pointer: null, last: null, board: null, score: null, at: now() };
      const c = clean(d), next = { ...was, ...c };
      if (key(next) !== key(was)) next.at = now();
      peers.set(id, next);
    },
    frame(dt = 0) {
      wait = Math.max(0, wait - dt);
      const k = key(mine);
      if (k === sent || wait > 0) return;
      sent = k; wait = 1 / rate;
      try { send(MESSAGE, { pointer: mine.pointer, mood: mine.mood, moves: mine.moves, last: mine.last, board: mine.board, score: mine.score }); } catch { /* alone: nobody to tell */ }
    },
    of(id) {
      const self = id != null && String(id) === String(me() ?? '');
      const o = self ? { ...mine, at: mineAt } : peers.get(String(id));
      return o ? { id: String(id), ...o, at: Math.max(0, now() - o.at), mine: self } : null;
    },
    ids: () => [...new Set([...(me() != null ? [String(me())] : []), ...peers.keys()])],
    forget(id) { peers.delete(String(id)); },
    get local() { return { ...mine }; },
  };
  return api;
}
