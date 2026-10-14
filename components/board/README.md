# mechanic: board

A grid on the floor of the world. Players take turns placing or moving pieces by rules the game gives; the host owns the board; a move that is not legal or not yours is refused with a reason; bots play through the same path; the world's props are cleared off the area.

Part of the gf-three kit (open builder M4-F, 2026-10-11). Add it to a spec as `{ "id": "board", "as": "...", "params": {...} }`. On three, the standard-3d and flat-2d profiles (never run on scenic-3d; `mechanic.json` impl).

## What the game writes

```js
setup(ctx) {
  const board = ctx.mechanics.get('board');
  board.rules({
    legal: (move, s) => s.empty(...move.to) || 'That cell is taken',     // true, or the reason in words
    winner: s => { const l = s.last && s.line(...s.last, 4); return l ? { seat: s.owner(...s.last), cells: l } : s.full() ? { draw: true } : null; },
  });
}
```

| Callback | What it is | When it is left out |
|---|---|---|
| `legal(move, s)` | `true`, or the reason the move is refused, in the player's words | place: the cell is empty. move: your own piece, not onto your own piece |
| `winner(s)` | `null`, `{ seat, cells, reason }`, `{ seats: [...] }` or `{ draw: true }`. `s.stuck` is true when nobody can move | the board is never decided (a stuck board is a draw) |
| `apply(move, s)` | what the move does to the board (captures, flips) | a placed piece appears; a moved piece takes what stood there |
| `start(s)` | the opening position | an empty board |
| `next(s, move)` | **whose turn is next** (a seat) | the next seat in order that has a legal move |
| `bot(s, seat, rng)` | a bot's move | one ply: win now, do not hand the next player a win, prefer captures and the middle |

A move is `{ type: 'place', to: [c, r], kind }` or `{ type: 'move', from: [c, r], to: [c, r] }`. `legal` and `winner` run on every copy and inside the bot's look ahead: they read the state they are handed and change nothing.

**The state `s`:** `cols`, `rows`, `seats`, `turn`, `moves`, `last`, `from`, `data` (the game's own small JSON, synced), `stuck`; `at(c, r)` → `null | { seat, kind }`, `empty`, `owner`, `set(c, r, piece | null)`, `move(from, to)`, `full()`, `count(seat, kind?)`, `pieces(seat)`, `dropRow(c)`, `line(c, r, need)` (the longest line of one seat through a cell, four directions), `lines(need, seat?)`, `flank(c, r, seat)` (runs of other seats' pieces closed by one of yours, eight directions), `neighbours(c, r, diagonal?)`, `reach(from, steps, cost?, diagonal?)` (a flood fill), `clone()`.

## Params

| Param | Default | |
|---|---|---|
| `cols`, `rows` | 7, 6 | 2 to 12 each. Row 0 is the far (-z) end |
| `cell` | 1.5 | metres; it shrinks so the board, its seats and a walking strip fit the play area |
| `at` | `"centre"` | `"centre"`, a world zone name, or `[x, z]` |
| `input` | `"place"` | `place` (that cell), `drop` (that column; the piece slides to the free cell nearest row 0; a full column is refused), `move` (pick your piece, then where it goes; legal cells light up) |
| `presence` | `"walk"` | see below |
| `action` | `"interact"` | walking: the input that acts on your cell (`interact` or `primary`) |
| `piece`, `pieceSize` | `"disc"`, 0.76 | `disc`, `pawn`, `ball`, `block`, drawn by the kit in the owner's colour; kind 1 and up are drawn taller |
| `cellShape`, `checker` | `"square"`, true | square tiles or round holes; one cell colour or two |
| `turnSeconds` | 30 | when a turn runs out the host plays a move for that player (0: no limit). The simple default until the session flow owns turns |
| `botThink` | 1.1 | seconds before a bot moves |
| `score` | `"win"` | `win` (the winner gets 1), `pieces` (your pieces on the board, live), `none` |
| `endsRound`, `endDelay` | true, 2.2 | a decided board ends the round after the win line has been seen |
| `clear` | 2.4 | world props within this many metres of the board are taken away with their colliders; walls, doors, fences, ceilings and the skyline stay. 0 keeps everything |
| `seats` | true | at round start each player stands at their own side of the board, facing it (two players face each other; four take the four sides) |
| `edgeReach` | 1.8 | walking: how far off the edge you can stand and still act on the nearest edge cell |
| `hints` | true | the mover sees their legal cells |
| colours, sounds, texts | | `boardColor`, `cellColor`, `cellColorB`, `hintColor`, `refuseColor`, `winColor`; `soundPlace`, `soundSelect`, `soundRefuse`, `soundWin`; `textYourTurn`, `textTheirTurn`, `textNotYourTurn`, `textDraw` |

## A player's presence (open question G5: both are here, the pitch asks)

- **`walk`**: your body walks beside and on the board. The cell under your feet (or the nearest edge cell when you stand beside it) carries a ring in your colour on every screen; the action plays it. Friends see each other as characters, as in any kit game. The board has no step and pieces have no colliders: a body walks through a piece.
- **`cursor`**: your body stands at your side of the board and its controls are held off (the mechanic owns `player.control`). You move a mark in your colour (a ring, a pointer and your name): the mouse where it is free (the `follow` camera) or the middle of the screen where the mouse is taken (`third`), the move keys or the stick one cell a step, and a click, E or the interact button plays. Friends see your body at the table and your mark moving, at most 10 changes a second. With a fixed camera (`follow`, `top`) the mechanic turns it square on from your side and centres it on the board.

## Turn order is an input

The mechanic does not own turn order. It asks `next(state, move)` after every move, and takes `board.setTurn(seat)` from the host at any time. With neither, it uses the simplest rule inside `logic.js` `playMove`: the next seat in order that has a legal move, the first mover moving on by one each replay. The turn timer (`turnSeconds`) is part of the same default. A session flow replaces all three by giving `next`, calling `setTurn`, and setting `turnSeconds` to 0.

## Network ownership and message rates

**The host owns** the grid, the turn, the result and the turn clock. `ctx.shared` key `board`: `g` (one letter a cell: at most 144 B), `t`, `n`, `l`, `o`, `b`, `w`, `d`, `k`, `x` (the game's own `state.data`: keep it small). Events: `board:move` (a player's copy → the host, one a move), `board:no` (the host → the refused player, with the reason), `board:cur` (a cursor mark changed cell → everyone, at most 10 a second a player; cosmetic). A move is its sender's: the host ignores a `board:move` whose sender is not the player it names. Every copy checks a move before sending it, so a person hears the reason at once; only the host's answer counts.

## Methods for rules.js

- `rules({...})`, `state`, `turn()` → `{ seat, player, mine, left }`, `result()`, `seatOf(player)`, `seatPlayer(seat)`, `moves(seat?)`, `problem(player, move)`, `cellAt(x, z)`, `centre(c, r)`, `cursor(player?)`.
- `play(player, move)` for a player this copy owns → `null`, or the reason. Host: `setTurn(seat)`.
- Host callbacks: `onMove({ player, seat, move, state, auto })`, `onRefuse({ player, why, cell })`, `onEnd({ winners, seats, cells, reason, draw })`, `onTurn({ seat, player })`.
- `bot(player, dt)` from `rules.bot`: the bot walks to its cell before it plays. Without it a bot still plays, from where it stands.
- QA: `observe()` (give it to `rules.observe` and it is in `window.__game.snapshot().rules`), `screen()` (each cell's place on this screen in CSS pixels), `interactables()` (walking, `place` or `drop`: the local player's legal cells on their turn, each marked `turn: true` with its `verb`), `points()` (a cursor: what the local player may click now, in CSS pixels; with input `move` the pieces that can move, then where the picked one may go) and `presence(p)` (a cursor: where a player's mark is, so the kit's observation and the two-player gate read the mark as the player's place).

## Sounds

The module exports `sounds` (`board-place`, `board-select`, `board-refuse`, `board-win`: label, gf-audio preset, bus). `create` lists them in `assets.json` with the game's own (tools/create.mjs hands a mechanic module's `sounds` to `specToConfig`; before 2026-10-11 only the tools' own table could). A piece landing is heard on every copy, from the shared state.

## What is not done

- Pieces are kit primitives in the player's colour. A model per kind (a slot a creator swaps) is not there.
- scenic-3d: never run; the registry manifest (`mechanic.json`) does not list it.
- "Clear this area" is done when the game starts, on every copy, from the world's own prop list. A world that knows about a stage (and spawns players round it) would be the better home; the layout file still lists the props.
- No undo, no hidden information, no dice, no hands of cards, no simultaneous turns. One board a game.
- Cursor presence on a phone: the stick steps the mark and the on-screen button plays. Not run on a phone.
- A player who leaves mid-game keeps their seat; their turns are played by the turn timer.

## Fixture and tests

- Pure logic and the check 15 sign: `node --test research/gf-three/tests/k2-board.test.mjs`.
- Two-player fixture: `node research/gf-three/tests/k2-fixture.mjs board` (three in a row over WebRTC: a move on both copies; out of turn refused on the player's own copy and by the host; a taken cell; a move sent in another player's name ignored; the win line, the score and the end of the round agree).
- What verify's checks 7, 12 and 13 need to judge a turn-based board game: `research/open-builder/findings/m4f-board.md`.

Lifted from our own trial `research/foundations/trials/grid-tactics`: see `NOTICE-grid-tactics`.
