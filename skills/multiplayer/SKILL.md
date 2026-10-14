---
name: multiplayer
description: Keep a gf-three game live multiplayer - friends in one game, in sync, each seeing the others as a character - by putting shared decisions on the host, sending events on edges, and testing with two browser tabs through the local signaling server. Use when writing rules.js logic other players must see, when two players disagree about what happened, or when someone asks to play with friends.
---

# Multiplayer

The bar: friends are in one game, in sync, and each player sees the others as a character where they really are. Every
gf-three game is `live` (`multiplayer.json` → `"mode": "live"`). One player hosts in their own browser; the others
join with a code or an invite link; game traffic goes peer to peer over WebRTC. There is no game server. The kit
(`gf/mp/`, gf-multiplayer 1.7.4) and gf-three's `kit/net/` do the networking: poses, drawing friends, the round,
loadouts. Background: `builder/multiplayer/STANDARD.md` and `builder/multiplayer/party/LIVE_HANDBOOK.md`.

## The rules that keep copies in sync

- **The host decides.** Anything everyone must agree on (scores, who is out, what a pickup did, an enemy's health) is
  decided on the copy where `ctx.host` is true. Other copies show it.
- **Shared state** goes through `ctx.shared.register(key, initial)` (the host writes, others read; batched into one
  `net.world` message, at most 3.5 KB) or player fields the kit already sends (`p.score`).
- **Events are edges**: `ctx.net.send(name, data, to)` with `to` = `'all'`, `'host'` or a player id, for a moment
  (a grab, a refill, a catch), never per frame. Handle them in `rules.event(ctx, name, data, from)`.
- **Each copy owns its players**: `ctx.players.owned()` are the ones this copy simulates (its human, and bots on the
  host). Read input from `p.actions` only for owned players.
- **Randomness** from `ctx.rng()` (seeded), never `Math.random`.
- **Limits** (gf-multiplayer): 4 KB a message, at most 60 messages per player per second.
- Never pause during a live round: the world keeps running when a tab is in the background.
- A player's look (body, hat, colour, shot colour) can differ per player: read it with
  `ctx.assets.value(slotId, fallback, { player: p })`, never one value for everyone.

## Play it with two tabs

```bash
npx gamesfun dev games/<name>
```

The dev server is also the signaling server (WebSocket `/signal`, and HTTP `/signal/v1`), on 127.0.0.1 only.
1. Open `http://127.0.0.1:<port>/game/gf/mp/` (the studio's "Play with friends" link). Type a name, press **Host**.
2. Copy the invite link (it has `?join=CODE`) and open it in a second tab or window. Type a name, press **Join**.
3. The host presses **Start**. Check on both screens: the other player is drawn where they really are, moves when they
   move, scores match, the round ends with the same results, **Play again** starts round 2 for both.

Verify check 5 does the same with two headless Chrome pages over real WebRTC, plus a reload mid-round, the host
leaving and the loadout leg. Run it with the rest: `npx gamesfun verify games/<name> --quick`.

## When copies disagree

- A score differs: the score is decided on a non-host copy. Move it under `if (ctx.host)`.
- Something happens twice: both copies run an effect on an event; let the host decide and others only show it.
- A friend is invisible or frozen: never hide or teleport players by hand; the kit owns poses
  (`p.teleport`, `p.knock` are callable from any copy and do the right thing).
- A joiner sees a different world: world layout comes from config and the seed; never build it from `Math.random`.

## Beyond this machine

Local signaling (`gamesfun dev`) only answers this machine: two tabs, or two windows, play together. games.fun's own
play host has HTTP signaling at `/signal/v1` and a relay for networks that can't connect directly (gf-multiplayer 1.6.4 and newer),
but whether a game built with this kit may use it by default is not decided yet. Until it is, say plainly that friends
elsewhere cannot join a locally built game.
