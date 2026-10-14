# A game's own server (Railway first)

Leaderboards, saves and a live score feed for one games.fun game. It is one file (`server.js`), has no dependencies
and runs on Node 22 or newer. MIT, like the rest of the kit.

A game needs no server. Add this one when it needs scores that friends on other machines can see, or progress that
follows a player from one browser session to the next. Live play between friends stays on `gf/mp` (WebRTC), not here.

## The one button: `npx gamesfun backend connect railway`

1. Your browser opens Railway's sign-in and consent page. You choose the workspace the kit may use.
2. The kit creates a project with one service, uploads this folder, and adds a volume for the data.
3. It sets the variables below, waits for the deploy, and asks Railway for the service's public domain.
4. It writes **only that public URL** into the game (`backend.json`). Nothing secret reaches the game.

The sign-in is kept outside the game and outside the kit's checkout: in the system keychain where there is one,
else in a file only your user can read. `npx gamesfun backend disconnect railway` deletes the kit's sign-in client
at Railway, which ends every token it was given.

## What a game may call

| Call | Who | What |
|---|---|---|
| `GET /health` | anyone | `{ ok, version }`, Railway's health check |
| `POST /v1/players` | the game | `{ id, token }`: a new anonymous player (30 an hour from one address) |
| `GET /v1/scores/<board>?limit=10` | the game | the top of a board: `[{ name, score, at }]` |
| `POST /v1/scores/<board>` `{ score, name }` | a player's token | keeps the player's best; `{ best, rank }` |
| `GET` / `PUT /v1/saves/me` `{ data }` | a player's token | that player's own save, up to 64 KB |
| `WS /v1/live?board=<board>` | the game | pushes `{ type: 'scores', board, scores }` when the board changes |

"The game" means a web page from one of the origins in `GF_ORIGINS`, matched exactly. Any other page gets 403, for
HTTP and for the WebSocket. In the game, `gf/backend/server.js` makes these calls (`connectGameServer()`).

## Variables

| Name | Set by | What |
|---|---|---|
| `GF_SECRET` | the kit, at random, once | Signs player tokens. It stays on the server: the kit does not keep it and it never reaches the game. |
| `GF_ORIGINS` | the kit | The game's exact origins: the games.fun play host, and `http://127.0.0.1:<port>` for the kit's dev server. |
| `GF_DATA_DIR` | the kit (`/data`, a Railway volume) | Where scores and saves are kept. Without a volume, a deploy wipes them. |
| `GF_TRUST_PROXY` | the kit (`1`) | Railway's proxy sets `X-Forwarded-For`; the per-address limit uses it. |
| `GF_MAX_SCORE`, `GF_MAX_SAVE_BYTES` | you, if you want | The largest score (default 1e9) and save (default 65536 bytes). |
| `PORT` | Railway | The port to listen on. |

## What it does not stop

CORS stops other web pages, not programs. Anyone can ask for a new player and post a score from a script, within the
bounds and rate limits. A game that needs cheat-proof scores must have the server play the round itself, and this
template does not. Player ids never leave the server, and a player can only read and change their own save.

## Running it yourself

```bash
GF_ORIGINS=http://127.0.0.1:5180 GF_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))") node server.js
```

Then point the game at it with `npx gamesfun backend use railway --url http://127.0.0.1:8080`.

## The same template on another host (a deploy button, then paste the URL)

Where a host has no sign-in the kit can use, the studio shows that host's own deploy button and a box to paste the
service's URL. `npx gamesfun backend use <provider> --url https://…` writes it. Each button needs this folder in a
**public Git repository** (a creator step: the kit cannot publish one), plus:

| Host | The button | What it needs beside `server.js` | Notes |
|---|---|---|---|
| Railway | `https://railway.com/new/template/<code>` | A template published from the repo in a Railway workspace. Variables: `GF_SECRET` as `${{secret(43)}}`, `GF_ORIGINS` asked from the person, a volume at `/data` | The kit's sign-in does all of this without the button. |
| Render | `https://render.com/deploy?repo=<repo>` | A `render.yaml` Blueprint: one `web` service, `runtime: node`, `startCommand: node server.js`, `healthCheckPath: /health`, `GF_SECRET` with `generateValue: true`, `GF_ORIGINS` with `sync: false`, a disk at `/data` (disks need a paid plan) | The free plan sleeps after 15 minutes idle. It does not report the URL back: paste `https://<name>.onrender.com`. |
| Fly.io | none (Fly has no deploy button) | A `fly.toml` (`internal_port = 8080`, an `[http_service]` with `/health` checks, a `[mounts]` volume at `/data`); the person runs `fly launch` and `fly secrets set GF_SECRET=…` | Needs a card. Paste `https://<app>.fly.dev`. |
| Cloudflare | `https://deploy.workers.cloudflare.com/?url=<repo>` | **A different template.** Workers do not run `node:http` servers: the same API would be a Worker with a Durable Object per board (storage and hibernating WebSockets) and `GF_SECRET` as a Worker secret | The best fit for live rooms. It clones the repo into the person's own Git account first. |
