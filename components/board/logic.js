// board: the pure logic (no three.js, no DOM): a grid of pieces, the helpers a game's rules read (lines, flanks, reach),
// the one path every move takes (clean → problem → play), turn order with a simple default, and a one-ply bot.
// Node tests: research/gf-three/tests/k2-board.test.mjs.
//
// Lifted from our own frozen trial research/foundations/trials/grid-tactics (see NOTICE-grid-tactics): the flood fill
// for movement ranges (source/model.mjs `reachable`) and the shape of a move from one player (source/live.mjs
// `cleanOp`, `opProblem`, then play: the checks never touch the board, and a refusal is a reason in words).

const DIRS4 = [[0, -1], [1, 0], [0, 1], [-1, 0]];
const DIRS8 = [...DIRS4, [1, -1], [1, 1], [-1, 1], [-1, -1]];
const LINE_DIRS = [[1, 0], [0, 1], [1, 1], [1, -1]];
export const MAX_SEATS = 4, MAX_KINDS = 6;
const A = 97;                                                   // 'a'

/** A piece as one letter ('.' is an empty cell): the seat (0..3) and the kind (0..5). */
export const pieceChar = (seat, kind = 0) => String.fromCharCode(A + seat * MAX_KINDS + kind);
export const charPiece = ch => { if (!ch || ch === '.') return null; const n = ch.charCodeAt(0) - A; return n < 0 || n >= MAX_SEATS * MAX_KINDS ? null : { seat: Math.floor(n / MAX_KINDS), kind: n % MAX_KINDS }; };
export const emptyGrid = (cols, rows) => '.'.repeat(cols * rows);

/**
 * The board as the rules see it. `wire` is the shared shape ({g, t, n, l, x}); the state is a working copy: the host
 * writes it back with toWire() after a move, every other copy only reads.
 *   s.cols, s.rows, s.seats   the size and how many players take turns
 *   s.turn                    the seat whose turn it is (0 … seats - 1)
 *   s.moves                   moves played so far
 *   s.last, s.from            where the last move ended and (a moved piece) began: [c, r] or null
 *   s.data                    the game's own small JSON (kings, a counter): travels with the board
 *   s.stuck                   true when nobody has a legal move (winner() decides what that means)
 */
export function createState({ cols, rows, seats = 2 }, wire = null) {
  let g = (wire?.g && wire.g.length === cols * rows ? wire.g : emptyGrid(cols, rows)).split('');
  const inside = (c, r) => Number.isInteger(c) && Number.isInteger(r) && c >= 0 && r >= 0 && c < cols && r < rows;
  const idx = (c, r) => r * cols + c, cellOf = i => [i % cols, Math.floor(i / cols)];
  const s = {
    cols, rows, seats, turn: wire?.t ?? 0, moves: wire?.n ?? 0,
    last: Number.isInteger(wire?.l?.[1]) && wire.l[1] >= 0 ? cellOf(wire.l[1]) : null,
    from: Number.isInteger(wire?.l?.[0]) && wire.l[0] >= 0 ? cellOf(wire.l[0]) : null,
    data: wire?.x ? JSON.parse(JSON.stringify(wire.x)) : {}, stuck: false,
    inside, index: idx, cell: cellOf,
    /** The piece on a cell: null, or { seat, kind }. */
    at: (c, r) => (inside(c, r) ? charPiece(g[idx(c, r)]) : null),
    empty: (c, r) => inside(c, r) && g[idx(c, r)] === '.',
    /** The seat that holds a cell (-1: nobody, or off the board). */
    owner: (c, r) => (inside(c, r) ? charPiece(g[idx(c, r)])?.seat ?? -1 : -1),
    /** Put a piece on a cell ({ seat, kind }), or null to clear it. */
    set(c, r, piece) { if (inside(c, r)) g[idx(c, r)] = piece ? pieceChar(piece.seat, piece.kind ?? 0) : '.'; },
    /** Move the piece on `from` to `to` (whatever stood there is taken). → the piece taken, or null */
    move(from, to) { const p = s.at(...from), took = s.at(...to); if (!p) return null; s.set(...from, null); s.set(...to, p); return took; },
    full: () => !g.includes('.'),
    /** How many pieces a seat has (of one kind when given). */
    count: (seat, kind = null) => g.reduce((n, ch) => { const p = charPiece(ch); return n + (p && p.seat === seat && (kind === null || p.kind === kind) ? 1 : 0); }, 0),
    /** A seat's pieces: [{ c, r, kind }]. */
    pieces: seat => g.map((ch, i) => ({ p: charPiece(ch), i })).filter(x => x.p && x.p.seat === seat).map(x => ({ c: x.i % cols, r: Math.floor(x.i / cols), kind: x.p.kind })),
    /** Where a piece dropped into a column lands: the free cell nearest row 0, or -1 when the column is full. */
    dropRow(c) { for (let r = 0; r < rows; r++) if (g[idx(c, r)] === '.') return r; return -1; },
    /** The cells of the longest line of one seat through (c, r), in the four directions: [[c, r] …], or null when it is shorter than `need`. */
    line(c, r, need = 1) {
      const seat = s.owner(c, r); if (seat < 0) return null;
      let best = [[c, r]];
      for (const [dc, dr] of LINE_DIRS) {
        const cells = [[c, r]];
        for (const k of [1, -1]) { let x = c + dc * k, y = r + dr * k; while (s.owner(x, y) === seat) { cells.push([x, y]); x += dc * k; y += dr * k; } }
        if (cells.length > best.length) best = cells;
      }
      return best.length >= need ? best : null;
    },
    /** The first line of `need` or more anywhere on the board (for a seat when given): { seat, cells }, or null. */
    lines(need, seat = null) { for (let i = 0; i < g.length; i++) { const p = charPiece(g[i]); if (!p || (seat !== null && p.seat !== seat)) continue; const l = s.line(...cellOf(i), need); if (l) return { seat: p.seat, cells: l }; } return null; },
    /** The cells a piece of `seat` placed on (c, r) would flank: runs of other seats' pieces closed by one of its own, in eight directions. */
    flank(c, r, seat) {
      const out = [];
      for (const [dc, dr] of DIRS8) {
        const run = []; let x = c + dc, y = r + dr;
        while (s.owner(x, y) >= 0 && s.owner(x, y) !== seat) { run.push([x, y]); x += dc; y += dr; }
        if (run.length && s.owner(x, y) === seat) out.push(...run);
      }
      return out;
    },
    /** The cells beside (c, r) that are on the board: four, or eight with diagonals. */
    neighbours: (c, r, diagonal = false) => (diagonal ? DIRS8 : DIRS4).map(([dc, dr]) => [c + dc, r + dr]).filter(([x, y]) => inside(x, y)),
    /**
     * Every cell within `steps` of `from`: a flood fill (grid-tactics' movement range). cost(c, r) → what entering the
     * cell costs (1), or Infinity when it cannot be entered; the default enters empty cells only. → Map "c,r" → cost
     */
    reach(from, steps, cost = (c, r) => (s.empty(c, r) ? 1 : Infinity), diagonal = false) {
      const key = (c, r) => `${c},${r}`, best = new Map([[key(...from), 0]]), open = [[0, ...from]];
      while (open.length) {
        open.sort((a, b) => a[0] - b[0]);
        const [d, c, r] = open.shift();
        if (d > best.get(key(c, r))) continue;
        for (const [x, y] of s.neighbours(c, r, diagonal)) {
          const nd = d + cost(x, y);
          if (!(nd <= steps) || (best.has(key(x, y)) && best.get(key(x, y)) <= nd)) continue;
          best.set(key(x, y), nd); open.push([nd, x, y]);
        }
      }
      best.delete(key(...from));
      return best;
    },
    /** A copy to try a move on (a bot's look ahead). */
    clone: () => createState({ cols, rows, seats }, s.toWire()),
    grid: () => g.join(''),
    toWire: () => ({ g: g.join(''), t: s.turn, n: s.moves, l: [s.from ? idx(...s.from) : -1, s.last ? idx(...s.last) : -1], x: s.data }),
  };
  return s;
}

/** What a player sends, made safe: { type: 'place', to, kind } or { type: 'move', from, to }; null when it is neither. */
export function cleanMove(m) {
  if (!m || typeof m !== 'object') return null;
  const cell = v => (Array.isArray(v) && v.length === 2 && Number.isInteger(v[0]) && Number.isInteger(v[1]) ? [v[0], v[1]] : null);
  const to = cell(m.to); if (!to) return null;
  if (m.type === 'move') { const from = cell(m.from); return from ? { type: 'move', from, to } : null; }
  if (m.type === 'place') return { type: 'place', to, kind: Number.isInteger(m.kind) && m.kind >= 0 && m.kind < MAX_KINDS ? m.kind : 0 };
  return null;
}

/** The legal rule a game gets when it gives none: place on an empty cell; move your own piece to a cell that is not yours. */
export function defaultLegal(m, s) {
  if (m.type === 'place') return s.empty(...m.to) ? true : 'That cell is taken';
  if (s.owner(...m.from) !== s.turn) return 'Pick one of your own pieces';
  return s.owner(...m.to) === s.turn ? 'Your own piece is there' : true;
}
/** What a move does when the game gives no apply: a placed piece appears; a moved piece takes what stood there. */
export function defaultApply(m, s) { if (m.type === 'place') s.set(...m.to, { seat: s.turn, kind: m.kind ?? 0 }); else s.move(m.from, m.to); }

/**
 * The checks, without touching the board: null when `seat` may play `move` now, otherwise the reason in words.
 * R = the game's rules ({ legal, apply, winner, next }); over = the game already has a result.
 */
export function moveProblem(s, R, seat, move, { over = false } = {}) {
  if (over) return 'The game is over';
  if (seat !== s.turn) return 'Not your turn';
  const m = cleanMove(move);
  if (!m) return 'That is not a move';
  if (!s.inside(...m.to) || (m.from && !s.inside(...m.from))) return 'That is off the board';
  if (m.type === 'move' && !s.at(...m.from)) return 'No piece there';
  let ok; try { ok = (R?.legal ?? defaultLegal)(m, s); } catch (e) { return `The rules threw: ${String(e?.message ?? e).slice(0, 80)}`; }
  return ok === true || ok === undefined || ok === null ? null : typeof ok === 'string' && ok ? ok : 'Not a legal move';
}

/** Every move `seat` could make now, by how the game takes input ('place' | 'drop' | 'move'), legal ones only. */
export function candidates(s, R, seat, input = 'place') {
  const out = [], was = s.turn; s.turn = seat;
  const ok = m => moveProblem(s, R, seat, m) === null;
  if (input === 'drop') { for (let c = 0; c < s.cols; c++) { const r = s.dropRow(c); if (r >= 0 && ok({ type: 'place', to: [c, r] })) out.push({ type: 'place', to: [c, r], kind: 0 }); } }
  else if (input === 'place') { for (let r = 0; r < s.rows; r++) for (let c = 0; c < s.cols; c++) if (ok({ type: 'place', to: [c, r] })) out.push({ type: 'place', to: [c, r], kind: 0 }); }
  else for (const p of s.pieces(seat)) for (let r = 0; r < s.rows; r++) for (let c = 0; c < s.cols; c++) { if (c === p.c && r === p.r) continue; const m = { type: 'move', from: [p.c, p.r], to: [c, r] }; if (ok(m)) out.push(m); }
  s.turn = was;
  return out;
}

/** winner(state) as the game gave it, made uniform: null, or { seats: [winning seats], cells, reason, draw }. */
export function resultOf(s, R) {
  let w = null; try { w = R?.winner?.(s) ?? null; } catch { w = null; }
  if (!w) return s.stuck ? { seats: [], cells: [], reason: 'nobody can move', draw: true } : null;
  const seats = Array.isArray(w.seats) ? w.seats : Number.isInteger(w.seat) && w.seat >= 0 ? [w.seat] : [];
  return { seats: seats.filter(x => x >= 0 && x < s.seats), cells: Array.isArray(w.cells) ? w.cells : [], reason: String(w.reason ?? (seats.length ? 'won' : 'draw')).slice(0, 60), draw: !seats.length };
}

/**
 * Play a checked move on the host's state: apply it, count it, then the result or the next turn.
 * Turn order is an input: R.next(state, move) → the next seat. The default here is the simplest one (the next seat in
 * order that has a legal move); a session flow replaces it by giving `next`.
 * → { result: null | { seats, cells, reason, draw } }
 */
export function playMove(s, R, move, input = 'place') {
  const m = cleanMove(move), seat = s.turn;
  (R?.apply ?? defaultApply)(m, s);
  s.moves += 1; s.last = m.to; s.from = m.type === 'move' ? m.from : null; s.stuck = false;
  let result = resultOf(s, R);
  if (result) return { result };
  let next = null;
  if (typeof R?.next === 'function') { try { next = R.next(s, m); } catch { next = null; } }
  if (!Number.isInteger(next) || next < 0 || next >= s.seats) {
    next = -1;
    for (let k = 1; k <= s.seats; k++) { const cand = (seat + k) % s.seats; if (candidates(s, R, cand, input).length) { next = cand; break; } }
  }
  if (next < 0) { s.stuck = true; s.turn = (seat + 1) % s.seats; result = resultOf(s, R); return { result }; }
  s.turn = next;
  return { result: null };
}

/**
 * A bot's move: one that wins now; else one that does not hand the next player a win; else any, nearer the middle
 * first. One ply each way, through the same legal, apply and winner the players go through. rng() → 0..1. → move | null
 */
export function pickMove(s, R, seat, input = 'place', rng = Math.random) {
  const list = candidates(s, R, seat, input);
  if (!list.length) return null;
  const mid = [(s.cols - 1) / 2, (s.rows - 1) / 2];
  let best = null, bestScore = -Infinity;
  for (const m of list) {
    const t = s.clone(); t.turn = seat;
    const before = t.count(seat), others = s.seats > 1 ? [...Array(s.seats).keys()].filter(k => k !== seat).reduce((n, k) => n + t.count(k), 0) : 0;
    const { result } = playMove(t, R, m, input);
    let score = rng() * 2 - (Math.abs(m.to[0] - mid[0]) + Math.abs(m.to[1] - mid[1])) * 0.35;
    if (result && result.seats.includes(seat)) score += 1000;
    else if (result && !result.draw) score -= 1000;
    else if (!result) {
      // does the next player win at once after this?
      const nxt = t.turn;
      if (nxt !== seat) for (const reply of candidates(t, R, nxt, input).slice(0, 40)) { const u = t.clone(); const r2 = playMove(u, R, reply, input).result; if (r2 && r2.seats.includes(nxt)) { score -= 400; break; } }
      // pieces gained and taken count a little (captures)
      const after = t.count(seat), othersAfter = [...Array(s.seats).keys()].filter(k => k !== seat).reduce((n, k) => n + t.count(k), 0);
      score += (after - before - 1) * 3 + (others - othersAfter) * 6;
    }
    if (score > bestScore) { bestScore = score; best = m; }
  }
  return best;
}

/** How a legal cell is shown to the mover. A round cell is the shape of a disc, so a solid fill there reads as a piece
 *  (a third player's, in a game of two: the parent's look at Four Flat, 2026-10-11): it gets a ring in the hint colour
 *  and a faint tint of its cell, never a fill. A square tile is not a piece's shape and keeps its fill. → { tint, ring }:
 *  tint is how far the cell's colour goes toward the hint colour (0..1); ring says a ring is drawn on the cell. */
export const HINT_TINT_MAX_ROUND = 0.2;
export function hintStyle(cellShape) {
  return cellShape === 'round' ? { tint: 0.12, ring: true } : { tint: 0.55, ring: false };
}

/** Where the seats stand round a board: seat k of n → { side: 's' | 'n' | 'e' | 'w', along: -1..1 }. Two face each other.
 *  `order` (letters of s, n, e, w; the board's seatSides) lists the sides in seat order; several seats on one side
 *  spread along it (along -1..1). */
export function seatSide(k, n, order = '') {
  const sides = order ? [...order] : n <= 2 ? ['s', 'n'] : ['s', 'n', 'e', 'w'];
  const per = Math.ceil(n / sides.length), i = Math.floor(k / sides.length);
  return { side: sides[k % sides.length], along: per > 1 ? (i / (per - 1)) * 2 - 1 : 0 };
}

/** Board geometry: cell centres and the cell under a point. origin {x, z} is the middle; row 0 is the -z end ("back"),
 *  or the +z end with rowZero "front" (from above: the bottom of the screen). */
export function geometry({ cols, rows, cell, x = 0, z = 0, rowZero = 'back', seatSides = '' }) {
  const w = cols * cell, d = rows * cell, front = rowZero === 'front';
  const zRow = r => (front ? rows - 1 - r : r);                       // the row index counted from the -z end
  return {
    cols, rows, cell, x, z, w, d, rowZero: front ? 'front' : 'back',
    centre: (c, r) => ({ x: x + (c - (cols - 1) / 2) * cell, z: z + (zRow(r) - (rows - 1) / 2) * cell }),
    /** The cell under (px, pz); a point within `reach` metres outside the board gives the nearest edge cell; else null. */
    cellAt(px, pz, reach = 0) {
      const fx = (px - x) / cell + cols / 2, fz = (pz - z) / cell + rows / 2;
      const out = Math.max(-fx, fx - cols, -fz, fz - rows, 0) * cell;
      if (out > reach) return null;
      return [Math.max(0, Math.min(cols - 1, Math.floor(fx))), zRow(Math.max(0, Math.min(rows - 1, Math.floor(fz))))];
    },
    /** Where seat k of n stands: `gap` metres off its side, facing the middle (yaw 0 looks along +z). */
    seat(k, n, gap = 1.4) {
      const { side, along } = seatSide(k, n, seatSides);
      const ax = along * Math.min(w / 2, cell * 1.6), az = along * Math.min(d / 2, cell * 1.6);
      const p = side === 's' ? { x: x + ax, z: z + d / 2 + gap } : side === 'n' ? { x: x + ax, z: z - d / 2 - gap } : side === 'e' ? { x: x + w / 2 + gap, z: z + az } : { x: x - w / 2 - gap, z: z + az };
      return { ...p, y: 0, yaw: Math.atan2(x - p.x, z - p.z) };
    },
    contains: (px, pz, margin = 0) => Math.abs(px - x) <= w / 2 + margin && Math.abs(pz - z) <= d / 2 + margin,
  };
}
