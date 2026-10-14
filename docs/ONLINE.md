# Playing with friends: ours, yours, or just this machine

A game made with the builder lets friends join it. The game itself runs in one player's browser (the host) and the friends connect to that browser. A small server only introduces them while they connect: it hands out a six-letter room code and passes along the messages two browsers need to find each other. It never sees the game.

There are three ways to get that introduction.

| | Who runs it | Works for | Limits |
|---|---|---|---|
| **Two tabs on this machine** | the game's own dev server | you, in two windows | none |
| **Ours** (`games-fun-play.vercel.app`) | games.fun | friends anywhere | rate limits and a daily cap; it can be switched off |
| **Yours** | you | friends anywhere | whatever you set |

## When online play is off or full

Our server is free for games people run themselves, for now, and it has a cap. When the game says

- "online play for games run from other sites is off for now", or
- "too many rooms from this network: try again in 12 minutes", or
- "online play is at its daily limit for games run from other sites: try again in 5 hours",

that is the cap, not a fault in your game. You can wait, play in two tabs on this machine, or run your own (below).

## Run your own

You need a machine your friends can reach over `https` (a small server, or a tunnel such as Cloudflare Tunnel; a game served over `https` cannot talk to a plain `http` server). From a checkout of this repository, with Node 24:

```
node builder/multiplayer/p2p/serve-signal.mjs --port 5352 --allow '*'
```

`--allow` names the pages that may use your server (their address, such as `http://localhost:5173`), or `*` for any page. It stores nothing; restarting forgets every open room.

Then open your game with `?signal=https://YOUR-HOST/signal/v1` added to its address (the invite link you send a friend keeps it).

**Different networks.** Most pairs of home networks connect directly. About one pair in six or ten cannot (a strict router, a phone on mobile data, a VPN) and needs a relay (TURN). Set one on your server and it is handed to every page:

```
TURN_URLS=turn:relay.example:3478 TURN_USERNAME=user TURN_CREDENTIAL=secret node builder/multiplayer/p2p/serve-signal.mjs
```

A relay carries all of a failing pair's game traffic and is usually billed by the gigabyte. Anyone playing can read its credentials, so use a service that gives short-lived ones (Cloudflare Realtime TURN, coturn with a shared secret) rather than a password you care about.

## What this does and does not protect

The host's browser runs the game, so a determined host can cheat. Do not use this for ranked play, prizes or money. Friends can see each other's names and where they are in the game; nothing else is shared.
