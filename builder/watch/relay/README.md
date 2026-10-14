# Watch relay (track R of "watch then play")

A dumb fan-out relay: a streamer's browser publishes a game's state feed on one WebSocket, viewers' browsers subscribe read-only. It keeps the latest key frame plus the deltas after it for late viewers, counts viewers, and binds a channel to its streamer's secret (as a sha256). It reads only a frame's `k` and size, never its content. Plan and contracts: [watch/PLAN.md](../PLAN.md) (§3.1 channel, §3.2 this protocol, §3.3 the feed).

MIT, like the rest of the kit files. The Node server uses the repo's vendored ws (`builder/multiplayer/p2p/vendor/ws`, MIT).

## Layout

| File | What |
|---|---|
| `core.mjs` | The rules as pure logic: `Channel` (hello/claim, replace, size limits, rate bucket, key-frame cache, caps, slow viewers, read-only, grace, `end`, counts, expiry, voice), `Repeater` (one share of a channel's viewers, 2026-10-12), `shardFor`, plus `route`, `originOk`, `parseOrigins`, `httpAnswer`. Sockets, clock, one wake-up timer and storage are injected |
| `node.mjs` | `attachWatchRelay(server, opts)` for any `http.Server`, and a CLI |
| `cloudflare/` | `worker.mjs` (route + origin check + `/health`), `channel.mjs` (the Durable Object logic, testable under Node), `wrangler.toml` |
| `tests/` | `core.test.mjs` (units), `tree.test.mjs` (a channel and its repeaters, voice, the per-address rules), `channel-do.test.mjs` (the DO class on a fake runtime), `node.test.mjs` (`--data`, CLI, mount), `e2e.test.mjs` (real WebSockets; takes a base URL), `load.mjs` (thousands of scripted viewers against a test copy) |

## Protocol in short

All under `/watch/v1/`; `<id>` is `^[a-z0-9]{12}$` (else 400).

- `GET /watch/v1/<id>` gives `{v, id, live, viewers, meta, since}` (`since` is epoch ms), `no-store`, CORS `*`. `GET /watch/v1/health` gives `{ok: true}`.
- WebSocket `?role=pub` is the streamer (first frame `hello` within 5 s: `{k:'hello', v:1, key, meta}`), a bare WebSocket is a viewer. `Origin`, when present, must be in `WATCH_ORIGINS` (403 before the upgrade).
- Streamer frames: `key` (64 KB), `d` (16 KB), `meta` (2 KB), `a` (4 KB: voice, since 2026-10-12), `bye`, `ping`. At most 40 a second, burst 80, else close 4008. `a` frames also have a byte budget (8,000 bytes a second, burst 16,000): past it a frame is dropped, the stream goes on. They are fanned out as they come and never cached (a late viewer gets no old voice).
- Viewers get `state`, then the cached key frame and deltas, then every `key`/`d`/`meta`, `viewers` (at most once a second) and `end` (`bye` at once, `lost` after a 10 s grace).
- Close codes: 1008 viewer sent anything but `ping`; 4003 wrong key; 4008 rate; 4009 replaced; 4010 slow viewer (more than 1 MiB buffered); 4029 channel full (200 viewers on Node; on Cloudflare every repeater full) or one network's limit.
- Two codes the plan does not name: **4000** for a first frame that is not a valid `hello` (or no hello within 5 s, or a binary streamer frame) and **1009** for a frame over its limit. Both come after `{k:'error', code}`.
- `end` is not followed by a `state` frame; the viewer socket stays open, and `state` (live) plus a key frame follow when the streamer returns.

## A few thousand viewers: repeaters (2026-10-12)

The creator: "How hard is it to scale this up to at least a few thousand?". One Durable Object sending every frame to every viewer tops out in the hundreds, so on Cloudflare a channel's viewers are spread over **repeaters**: `WATCH_SHARDS` objects named `<id>~<n>`, each holding up to `WATCH_SHARD_VIEWERS` viewers (80 × 250 = 20,000 in `wrangler.toml`; it was 20 × 250 = 5,000 until the creator, the same day: "I can update to a paid plan, lets cap at 20k"). Viewer 20,001 is told the stream is full and retries every 20 s. Checked on a test copy with 80 repeaters of 5: 460 viewers, exactly 400 in, 60 told full (some after trying all 80 repeaters), the count exact, every frame delivered. A crowd of thousands needs Workers Paid (Durable Object requests and time).

- The streamer still talks to the channel's own object (`<id>`), which keeps the key, the meta and the cache, and now also counts **relays**: a repeater's one WebSocket to it (`?role=relay`), made object to object, never through the Worker (the Worker answers 403 to `role=relay`, `shard` or `last` from outside). The channel sends a relay exactly what it sends a viewer.
- A repeater forwards everything down to its viewers as it came, keeps the state, the key frame and the deltas after it for newcomers, answers `ping`, and says how many it serves (`{k:'count', n}`, at most once a second, capped at `WATCH_SHARD_VIEWERS` by the channel). The channel counts them in: the streamer, every viewer and `GET /watch/v1/<id>` see the whole audience (up to about two seconds late).
- A full stream stays cheap (`cloudflare/viewers.mjs`): the Worker first asks the channel how many are watching (one request); at the cap a viewer goes straight to its own repeater with `last=1` (let in if a seat came free, else told full), and the stream is remembered as full in that Worker for 10 s. Before this, every retry of every turned-away viewer tried all 80 repeaters.
- The Worker starts a viewer at the repeater its address picks (`shardFor`: one network's viewers share a repeater, so the per-address cap holds); a full repeater answers 503 before the upgrade and the next one is tried; the last takes the socket and turns it away the usual way (`state` full, 4029). `WATCH_SHARD_BY=random` spreads one address over all of them (a load test from one machine).
- A repeater with no viewers lets its line go after 30 s (`WATCH_LINGER_MS`) and may hibernate; a broken line (a deploy) comes back with backoff while viewers keep their sockets. `WATCH_SHARDS=0` keeps the old shape: every viewer on the channel's object, capped at `WATCH_MAX_VIEWERS`.
- One network: phones on one carrier share an address, so the per-address cap is 32 (it was 8) and joins are paced: at most 40 new viewers at once from one address, then one a second (`WATCH_MAX_PER_IP`, `WATCH_IP_JOIN_BURST`). Node uses the same rules on the channel's own viewers.

Node (local play, verify, the worlds server) has no repeaters: a few hundred viewers at most on one machine.

**Load test** (`tests/load.mjs`): one scripted streamer (a key frame every 2 s, deltas and voice 10 a second each) and N scripted viewers, against a test copy of the relay that lets one address in N times:

```bash
node watch/relay/tests/load.mjs https://<test relay> --viewers 3000 --ramp 30 --seconds 60 --out load.json
```

## Run it locally

```bash
source ~/.nvm/nvm.sh && nvm use                     # Node 24.19.0
node builder/watch/relay/node.mjs --port 5831      # ws://127.0.0.1:5831/watch/v1/<id>
node builder/watch/relay/node.mjs --port 5831 --data /tmp/watch.json --origins http://localhost:5830 --max-viewers 200
```

Or mount it on a server you already have (builder/world-server/serve.mjs does):

```js
import { attachWatchRelay } from '../watch/relay/node.mjs';
const relay = attachWatchRelay(server, { path: '/watch/v1/', origins: [...], maxViewers: 200, log });
// first thing in the request handler:  if (relay.handleHttp(req, res)) return;
```

`options`: `path` (default `/watch/v1/`), `origins` (array or comma string; default env `WATCH_ORIGINS`; unset = allow all), `maxViewers` (default env `WATCH_MAX_VIEWERS`, else 200), `data` (JSON file; keys are stored as sha256 only, cached frames never), `log`, and test knobs `graceMs`, `helloMs`, `now`, `limits`. Returns `{handleHttp(req, res) → boolean, close(), stats()}`.

## Tests

```bash
node --test watch/relay/tests/*.test.mjs                  # units + Node e2e (63 tests, 1 skipped: Worker only)

# the same e2e suite against the Worker, locally:
cd watch/relay/cloudflare
npx wrangler@4.140.0 dev --port 5832 --ip 127.0.0.1 --persist-to <scratch dir> \
  --var WATCH_ORIGINS:https://play.example --var WATCH_MAX_VIEWERS:3 --var WATCH_GRACE_MS:600 --var WATCH_HELLO_MS:800
# in another shell, from the repo top:
WATCH_URL=http://127.0.0.1:5832 node --test --test-force-exit watch/relay/tests/e2e.test.mjs
```

Known limits of the Worker run (wrangler 4.140.0, workerd local): a close the server starts on a socket the client has not sent a frame on yet is not delivered (the `state {full:true}` and `error` frames are). The cap test therefore asserts only `full: true` there, and the hello-timeout test sends one `ping` first. The slow-viewer test is skipped there: Durable Object sockets expose no buffered size, so that rule is a no-op on Cloudflare (the 200-viewer cap and 16 KB deltas keep it small in practice). It has not been checked whether production behaves the same as local on the first point.

## Deploy to Cloudflare

**Deployed 2026-10-10** at the creator's OK ("sure deploy the worker"): `https://gf-watch.anthony-6be.workers.dev`, so Studio's `WATCH_RELAY_URL` is `wss://gf-watch.anthony-6be.workers.dev/watch/v1/` (record: `../evidence/relay-deploy-2026-10-10.json`). Check it with `node watch/relay/tests/prod-smoke.mjs` (13 checks; pass another base as the first argument).

Wrangler 4.140.0's `deploy` uploads the script and then fails on a follow-up lookup ("This Worker does not exist on your account", code 10007) before it turns on the workers.dev address. The upload stands; the address was turned on once through the API (`POST /accounts/<id>/workers/scripts/gf-watch/subdomain {"enabled": true}`) and stays on through later deploys. The Workers free plan works (SQLite-backed Durable Object).

1. A Cloudflare account, then either `npx wrangler@4.140.0 login`, or an API token with **Workers Scripts: Edit** exported as `CLOUDFLARE_API_TOKEN` (plus `CLOUDFLARE_ACCOUNT_ID` when the account has more than one).
2. `cd watch/relay/cloudflare`
3. Check `wrangler.toml`: `WATCH_ORIGINS` is the play origin `https://games-fun-play.vercel.app` (comma-separate more, e.g. `http://localhost:5830` for local pages; unset allows every origin), `WATCH_MAX_VIEWERS` is `"200"`. The migration `v1` creates the class `Channel` with `new_sqlite_classes`.
4. `npx wrangler@4.140.0 deploy`. The URL is `https://gf-watch.<subdomain>.workers.dev`; the relay is `wss://gf-watch.<subdomain>.workers.dev/watch/v1/`.
5. Check: `curl https://gf-watch.<subdomain>.workers.dev/watch/v1/health` gives `{"ok":true}`. Then set the play host's `WATCH_RELAY_URL` to that `wss://…/watch/v1/` (track S).
6. A custom route (for example `watch.games.fun/watch/v1/*`) can be added under `routes` in `wrangler.toml`; the path must stay `/watch/v1/`.

`WATCH_MAX_PER_IP` (default 32 since 2026-10-12, it was 8; `0` turns it off): at most that many viewers of one channel's object or repeater from one client address (`CF-Connecting-IP` on Cloudflare, the socket's address on Node), so one network can't fill the audience; joins from one address are also paced (40 at once, then one a second; `WATCH_IP_JOIN_BURST`). The one turned away gets `{k:'state', full: true, why: 'network'}` and close 4029, and the kit tries again in 20 s.

Do not set `WATCH_GRACE_MS` or `WATCH_HELLO_MS` in production (test knobs; defaults are 10 s and 5 s).

## Cost notes (Cloudflare Durable Objects, check current pricing before relying on these)

- Requests: each WebSocket connection counts as one request; **incoming** WebSocket messages are billed at 20 to 1 (20 messages = 1 request); **outgoing** messages are free. A stream is mostly outgoing fan-out, and the streamer's ~10 frames a second is the incoming part (about 0.5 request a second).
- Duration: billed while the object is awake. With the Hibernation API it sleeps between messages, but a live stream sends every 100 ms, so a live channel is effectively always awake (128 MB). Viewers add no duration beyond that.
- `ping` is answered by `setWebSocketAutoResponse` without waking the object.
- Storage: one small key-value record per channel plus the id; writes happen on go-live, end, meta changes and key binding, not per frame. Channels are deleted 30 days after last use (alarm).
- Worker requests: one per HTTP GET and per WebSocket connect.
- With repeaters (2026-10-12): every repeater in use is awake while its stream is live (its line to the channel keeps it in memory), so a stream with 4,000 viewers on 20 repeaters is about 21 objects awake. Each repeater's frames from the channel arrive on a WebSocket it opened itself; each viewer's WebSocket connect adds one Worker request and one Durable Object request, plus one per repeater tried while the first ones are full. Voice adds about 10 incoming messages a second to the channel (0.5 request a second at 20 to 1).

## Notes on behaviour

- After a Durable Object wakes, its cache is empty: a new viewer gets `state` and then waits for the streamer's next key frame (the kit sends one every 2 s). Viewer counts are recounted from `ctx.getWebSockets('viewer')`.
- Keys and meta are in memory on Node (and in `--data` when given). Cached frames are never persisted.
- The relay never forwards anything from a viewer.
