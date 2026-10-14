# Flows: how a round is played, as a part

Open builder M4-C (2026-10-11). Before it every game ran one fixed flow inside `kit/net/session.js`: lobby, countdown, a timed round, results, replay. Now what happens while the phase is `playing` is a part a game picks, one folder each, with a manifest like a mechanic's. The lobby, the countdown, the results card, the replay, the players and the net are still the session's, for every flow.

| Flow | Loops it plays | What it owns |
|---|---|---|
| `round` | `round`, `run` | one clock (`round.seconds`); `rules.check` may end it sooner. The session's default: a game that names no flow runs it, and it is the code the session ran before, moved |
| `turns` | `turns` | the order, whose turn, a clock per turn, refusing a move out of turn with a reason, the turn on every screen, bots only on their turn, seats that leave or join |
| `match` | `match` | several timed rounds with the rounds won counted (best of N, first to N); the reset between two |
| `endless` | `endless` | no clock: `rules.check` is the only end |

A spec picks one with `loop` (`research/studio-v2/game-spec.schema.json`); `create` writes `config/game.json` → `round.flow` and `round.params` (the flow's own params, defaults filled, each a `round.*` value slot). A timed round writes neither, so its config is what it was.

## A flow module

`kit/loops/<id>/index.js` exports:

- `id`, `params` (JSON Schema of `round.params`), optional `sounds` (`id → [label, preset, bus]`) and `botsAlone({min, max})` (how many bots play with one person; absent: every seat).
- `create(ctx, params, session)` → the hooks below. `session` is `{ round, R, rules, players, shared, live, max, enterResults(winners, reason), restart({keep}), topScorers() }`.
- `manifest` (fields: `tools/catalog.mjs` → `LOOP_MANIFEST`).

| Hook | Called | For |
|---|---|---|
| `hostTick(dt)` | host, every frame while playing | the clock, who may act, the end (`session.enterResults`) |
| `begin()` | every copy, when play starts, before `rules.roundStart` | seating |
| `frame(dt)` | every copy, every frame | what a change of its state shows and plays |
| `reset()` | replay and back to the menu | its own counters (its shared state is reset by the session) |
| `end(reason, winners)` | host, `ctx.round.end(...)` from the rules or a mechanic | a flow with rounds inside it takes it as the end of one (the host's End round in the menu always ends the session) |
| `bot(player, dt)` → boolean | host, each bot each frame | false holds the bot (not its turn) or says the flow played for it |
| `hudLeft()` | every frame | the seconds the HUD's clock shows (`Infinity`: none); absent: the round clock |
| `event(name, data, from)` | a message `'<id>:<name>'` | its own messages |
| `observe()` | `window.__game.snapshot().flow` | what the checks read as its sign |

## The manifest, with `turns` as the example

| Field | `turns` |
|---|---|
| `id`, `describe` | `turns`; "Taking turns: one player acts at a time…" (where it runs is `loops/turns/loop.json` → `impl`, the registry's: three standard-3d, scenic-3d and flat-2d) |
| `params` | `turnSeconds` (20), `botThink` (1.1), `first` (rotate, seat, random), `late` (join, wait), `show`, three texts |
| `seconds` | `cap`: `round.seconds` is optional and caps the whole game (`required` for `round` and `match`) |
| `seats` | `{ alone: 'min', late: 'join', why }`: alone, `players.min - 1` bots (at least one), not every seat |
| `needs`, `uses` | nothing; joins `board` when the game has it |
| `refuse` | `spec => [...]`: a board whose own turn clock is on (two owners of one clock), with the way out |
| `state` | `shared.turns`: `o` order, `i` whose turn, `n` moves, `p` turns with no move, `k` refusals, `d` when the turn runs out, `b` a bot's turn, `w` why the last turn ended |
| `events` | the rules hooks it calls: `move`, `turnStart`, `turnTimeout`, `botMove` |
| `sync` | host: the order, the turn, the clock and every move |
| `note` | three lines for the build agent, read only by builds on this loop |
| `stub` | `{ as: 'turns', worked, traps, joined }`: `create` writes the hooks into `rules.js`; with a board, the one `joined` line instead |
| `signs` | `sample`, `judge` (check 15), `pulse` (check 12: moves played in turn, at least 2), `pressed` (check 13's fallback), `short` (what a check cuts for its 25 s round: the turn clock, to 4 s) |

## How `turns` and the board mechanic join

`kit/loops/turns/board.js`, through the board's public interface, with no line in `rules.js`. When play first starts the flow looks for a `board` mechanic and drives it:

| | Who |
|---|---|
| the grid, legal moves, refusals with a reason, pieces, the win, its bots' choice of move, the turn drawn on the board and the goal line | the board, unchanged |
| whose turn is next | the flow: `board.rules({ next })` answers with `ctx.turns.next()`, and `board.setTurn(seat)` follows the flow when the turn changes for the flow's reasons (the clock, a seat that left or is away, a player with no legal move) |
| the turn clock | the flow (`round.params.turnSeconds`, on the HUD's clock). The board's own must be off: `create` refuses `loop: "turns"` with a board whose `turnSeconds` is not 0. When it runs out the flow has the board play a legal move for that player (`board.moves`, `board.play`) |
| counting | `board.onMove` → `ctx.turns.done(player)`, `board.onRefuse` → `ctx.turns.refused(...)`: one count of moves, turns and refusals |
| bots | the flow seats them (one alone, not three) and holds a bot off its turn; on its turn the board thinks and plays, and `rules.bot → board.bot(p, dt)` still only walks it there |
| a seat that leaves | the flow takes it out of the order and hands the board the next seat. The board's seats are fixed for a game, so a player who joins mid-game waits for the next one |

Known limits of the join: the board picks a timeout move from its legal moves at random (its one-ply bot pick is not public); a game that gives the board its own `next` is overridden by the flow.

## Not a flow: a world

`round.mode "world"` (CONTRACT §9) is left as the session's mode. Its tick is one line, but it also changes who the players are (keyed by `cid`), who hosts (handoffs), where a player spawns, what leaving means and that nothing is ever reset. Moving the tick alone into `kit/loops/world` would be a name without the behaviour; moving the rest changes behaviour. Left, and said.

## Not built: `saved`

Progress a player keeps between visits (pets, money, upgrades). It is not the world mode's save path: that saves one shared place (the build mechanic's edits, by room, on the play host), not something per player. What it needs, none of it in this track:

1. **Who the player is across visits.** A stable id from the host page (Studio's play host knows the signed-in player; a bare page has only the tab's `cid`, which a new device loses).
2. **A place to keep it.** A per-player, per-game document on the play host (`get`, `put` with a size cap and a version), beside the world store; alone and offline, `localStorage` with the same shape.
3. **Who may write it.** In a friends game the host's copy decides what was earned, so the host must be the one that signs a player's new progress, or a friend could write themselves anything.
4. **A flow on this shape.** `begin()` loads each player's document into `p.saved` before `rules.roundStart`; the session's end (and a timer) writes it back; the manifest's `state` names the document's fields so a check can read "what I earned is still there after a reload" as this flow's sign.

Until then the catalog keeps `saved` planned and the pitch says so.
