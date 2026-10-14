---
name: multiplayer
description: Keep a game live multiplayer on any runtime - friends in one game, in sync, each seeing the others (as a character, or, when nobody is one, as a seat card, pointer and moves, or their own board beside yours) - by putting shared decisions on the host, sending events on edges, and testing with two browser tabs through the local signaling server. Use when writing game logic other players must see, when two players disagree about what happened, when a board, card or puzzle game needs friends to see each other, or when someone asks to play with friends.
---

# Multiplayer

The bar: friends are in one game, in sync, and each player sees the others. Every game is `live` (`multiplayer.json`
→ `"mode": "live"`) on every runtime (three, forge, vista, godot). One player hosts in their own browser; the others
join with a code or an invite link; game traffic goes peer to peer over WebRTC. There is no game server. The shared
kit (`gf/mp/`, gf-multiplayer 1.8.0) and each runtime's own net layer do the networking: poses, drawing friends, the
round, loadouts, presence. Background: `builder/multiplayer/STANDARD.md` and `builder/multiplayer/party/LIVE_HANDBOOK.md`.

## How a friend is seen

How each player sees the others is the game's shape (`gf/mp/presence.js`, STANDARD.md "Seeing a friend with no
character"), chosen from how friends play together and whether a player is a character. Never chosen per game:

| Shape | When | What each screen shows of a friend |
|---|---|---|
| `character` | the players walk the world | their character in their colour, where they really are |
| `seats` | nobody is a character, one shared board or table (turns, four in a row, cards) | a seat card (name, colour, an avatar that reacts: thinking on their turn, placed just after a move, won or lost), their pointer where they point, a ring where each of their moves lands |
| `boards` | nobody is a character, each player has their own board (puzzles side by side, falling blocks) | their board live beside yours, framed in their colour, with their name, avatar and score |

- The parts decide it: the board mechanic played from the seats (`presence: "cursor"`) is `seats`; with
  `boards: "own"` it is `boards`. `create` writes the shape into `config/game.json` → `players.presence`, the avatar
  stand-in into the `ui.avatar` slot and the mood words into `ui.mood-*`. Nothing in the game's code draws or sends it.
- A game whose own code holds the players (a falling-blocks well in `src/`) says it in its spec,
  `multiplayer.presence: "seats" | "boards"`, and hands its state to the part every time it changes (three:
  `ctx.presence.set({ pointer: [c, r], moves, last: [c, r], board: { cols, rows, g }, mood, score })`; `g` is one
  letter a cell, `.` empty).
- Nobody asks the creator what a friend looks like: the shape answers it. A question about the body is only for
  whether the players are characters at all (walk the giant board, or play it from the seats).
- The three runtime draws seats and boards today (`gf/three/ui/presence.js`); forge, vista and godot games all have
  characters. A game on another runtime that needs seats or boards builds the drawing in the game.

## The rules that keep copies in sync

- **The host decides.** Anything everyone must agree on (scores, who is out, what a pickup did, an enemy's health, who
  won a race of own boards) is decided on the host's copy. Other copies show it. In a rules.js game (three) that is
  the copy where `ctx.host` is true; a forge or vista game plays from its tables and its runtime keeps the host's world;
  a Godot game reaches the kit through its JavaScript bridge (`runtimes/godot/INTEGRATION.md`).
- **Shared state** goes through the runtime's shared store (three: `ctx.shared.register(key, initial)`: the host
  writes, others read, batched into one `net.world` message of at most 3.5 KB) or player fields the kit already sends
  (`p.score`).
- **Events are edges**: one message for a moment (a grab, a refill, a catch, a move), never per frame (three:
  `ctx.net.send(name, data, to)` with `to` = `'all'`, `'host'` or a player id, handled in `rules.event`).
- **Each copy owns its players**: a copy simulates its own human (and, on the host, the bots) and reads input only for
  them. On own boards each copy owns its player's board; the host only reads it.
- **Randomness** from the seeded generator (three: `ctx.rng()`), never `Math.random`; an opening everyone shares comes
  from one seed the host deals.
- **Limits** (gf-multiplayer): 4 KB a message, at most 60 messages per player per second.
- Never pause during a live round: the world keeps running when a tab is in the background.
- A player's look (body, hat, colour, shot colour) can differ per player: read it per player (three:
  `ctx.assets.value(slotId, fallback, { player: p })`), never one value for everyone.

## Play it with two tabs

```bash
npx gamesfun dev games/<name>
```

The dev server is also the signaling server (WebSocket `/signal`, and HTTP `/signal/v1`), on 127.0.0.1 only.
1. Open `http://127.0.0.1:<port>/game/gf/mp/` (the studio's "Play with friends" link). Type a name, press **Host**.
2. Copy the invite link (it has `?join=CODE`) and open it in a second tab or window. Type a name, press **Join**.
3. The host presses **Start**. Check on both screens: the other player is shown as the shape says (where they really
   are; or their seat card, pointer and moves; or their board beside yours), changes when they act, scores match, the
   round ends with the same results, **Play again** starts round 2 for both.

Verify measure 5 (gate E) does the same with two headless Chrome pages over real WebRTC, plus a reload mid-round, the
host leaving, the loadout leg and, when nobody is a character, the presence leg: each player makes moves with the
mouse, and each must land on the other's screen within 3 s. Run it with the rest: `npx gamesfun verify games/<name> --quick`.

## When copies disagree

- A score differs: the score is decided on a copy that is not the host. Move it to the host.
- Something happens twice: both copies run an effect on an event; let the host decide and others only show it.
- A friend is invisible or frozen: never hide or teleport players by hand; the kit owns poses (three: `p.teleport`,
  `p.knock` are callable from any copy and do the right thing).
- A friend's board or moves do not show (no character): the game's own code holds the players and never hands its
  state to the presence part, or the spec says `character` for a game whose players are a board.
- A joiner sees a different world: world layout comes from config and the seed; never build it from `Math.random`.

## Beyond this machine

Local signaling (`gamesfun dev`) only answers this machine: two tabs, or two windows, play together. games.fun's own
play host has HTTP signaling at `/signal/v1` and a relay for networks that can't connect directly (gf-multiplayer 1.6.4 and newer),
but whether a game built with this kit may use it by default is not decided yet. Until it is, say plainly that friends
elsewhere cannot join a locally built game.
