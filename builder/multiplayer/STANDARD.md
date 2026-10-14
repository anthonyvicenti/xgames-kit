# The multiplayer standard

Status: **v2, 2026-10-05.** Two creator messages set it:
- 2026-10-04 ([record](../foundations/evidence/multiplayer-standard-request-2026-10-04.json)): "get every single one of these games a multiplayer capability if it makes sense. The idea is that one player hosts and the others join. We need to make sure most new games we create also have this functionality."
- 2026-10-05, after playing the first version ([record](../foundations/evidence/multiplayer-feedback-2026-10-05.json)): "it seems like the games are not in sync… we should always be able to see some sort of character model for the other player for all these games. No point in multiplayer if you can't see your friends"

v1 of this standard (2026-10-04) counted `race` mode as multiplayer. v2 does not.

## The rule

**Every game carries a `multiplayer.json` and passes the multiplayer gate.** The file says how the game plays with friends, or says in a full sentence why it doesn't. A game with no `multiplayer.json` is unfinished.

**The bar for "plays with friends":** the players are in one game, in sync, and **each player sees the others as a character** in their own view. A number in a side panel is not seeing your friend.

One player hosts in their own browser and the others join with a code or a link (the host-join kit, `p2p/README.md`). There is no game server.

**Friends play friends (creator, 2026-10-08: "We really shouldn't have bots in multiplayer modes").** A round with friends has no bots, and needs two players in the room before the host can start; bots are for playing alone. Every player picks a name before hosting or joining and can change it in the waiting room, the waiting room shows the room once with everyone in the colour their character wears, and the results show each player their own score (kit 1.4.0, `kits/gf-multiplayer/1.4.0/README.md`; gf-three verify check 25).

## The modes

| Mode | Meets the bar | What friends get | What the game needs | Use it for |
|---|---|---|---|---|
| `live` | **yes** | **One game, and you see each other.** Every player is drawn as a character on everyone's screen. Whatever is shared (enemies, waves, pickups, the clock) exists once, in the host's copy. Everyone starts together and nobody can pause the world. | The game imports the kit's `gf/mp/net.js`: it sends its player's pose and draws the others, and the host's copy owns the shared world. `party/LIVE_HANDBOOK.md` is the how-to; `party/fixtures/arena` is a 130-line example. | **Every game with a player character or a shared space**, new or existing. |
| `room` | **yes** | The same thing, with the rules in a separate module: versus, co-op, turns, hidden roles. | The game is written as a room: `room.js` (the rules, run on the host's machine), `bot.js`, and a client that talks only through `gf.room` (`ROOM_GUIDE.md`). Solo play is the same room with bots. | New games built multiplayer-first, and games with hidden information (each player is sent only their own view). |
| `world` | **yes** | **One shared place that stays.** Opening the page puts you in *the* room for that world (no codes, no Start, no rounds); friends drop in and out, up to 8 at once, each drawn as a character; when the host leaves another copy takes over. What is built is saved on the play host (kit 1.5.0, 2026-10-09; `worlds/PLAN.md`). Since 1.5.1 the room runs every name through the play host's word filter, in every mode. | The friends page in world mode: the world card (a name, Enter), one room per `world:<slug>` key in signaling, the game frame loaded once. The game is a gf-three world (CONTRACT §9: `round.mode` world, a voxel world, the build mechanic). Gate: `party/gate-world.mjs`; gf-three verify's world checks 5, 25, 27. | Sandboxes and hangouts: a place people build or meet, not a match. |
| `race` | **no** | Separate copies of the game on the same seed, and a rail showing each player's number. | Nothing in the game's code: a manifest that says which number ranks a run, and the kit folder `gf/mp/`. | A stopgap only. 56 showcase games have it (2026-10-05) and each needs the `live` conversion; its `upgrade` line says what that is. |
| `solo` | n/a | Nothing. | A `reason`: one full sentence on why playing with friends makes no sense for this game. | A story for one reader, a private toy with nothing to share. |

`live` and `race` run on the same kit (`builder/gf-multiplayer`, vendored at `<game>/gf/mp/`), the same party page and the same room, so a `race` game becomes `live` by changing the game and its manifest, not its plumbing.

## `multiplayer.json`

It sits at the root of the folder the game is served from, beside `assets.json` (a trial's `source/`), so it travels with the game into Studio and into every fork.

```jsonc
// mode "race"
{
  "schemaVersion": 2,
  "mode": "race",
  "title": "Prism Break",
  "players": { "min": 1, "max": 8 },
  "race": {
    "entry": "index.html",
    "seedParam": "seed",            // the query name the game reads its seed from; null when it has none
    "content": "fixed",             // only with seedParam null: "fixed" (same content every run) or "random"
    "query": "mode=classic",        // optional: extra query for every round
    "metric": "score",              // score | time | count
    "direction": "higher",          // which is better
    "unit": "pts",                  // a time metric must say "s" or "ms"
    "maxSeconds": 300,              // the round ends then, whoever is still playing
    "adapter": "observe",
    "observe": {
      "object": "__game", "call": "snapshot",                   // the defaults: window.__game.snapshot()
      "value": "score",                                         // dot path to the number that ranks a run, or
                                                                // {"sum": ["total.strokes", "strokes"]} for a result kept in parts
      "ended": { "path": "phase", "in": ["won", "lost"] },      // what says the run is over
      "won": { "path": "phase", "is": "won" },                  // optional; needed when lower is better
      "started": { "path": "screen", "in": ["play"] },          // optional
      "progress": { "path": "score", "max": 6000 }              // optional: fills the bar (a 0..1 path needs no max)
    }
  },
  "upgrade": "Versus: a cleared row sends a brick row to the others.",   // optional: the shared-world version
  "theme": { "accent": "#ff5ea8", "font": "\"Baloo 2\", sans-serif" },    // optional: the lobby and rail in the game's look
  "check": { "query": "laps=1", "seconds": 120 }                          // optional, the gate only: a short run
}

// mode "live"
{
  "schemaVersion": 2,
  "mode": "live",
  "title": "Dusk Outbreak",
  "players": { "min": 1, "max": 4 },
  "live": {
    "entry": "index.html",
    "seedParam": null,              // a query name the game reads its seed from, or null when it takes net.seed
    "team": true,                   // true: one result for everybody (co-op), reported by the host's copy; false: each player's own
    "metric": "time", "direction": "lower", "unit": "s",
    "maxSeconds": 600,
    "sees": "Each player sees the others as a survivor in their own colour, carrying a shotgun, with their name above.",
    "shares": "The zombies, the waves, the dusk and the clock",      // what exists once, in the host's copy
    "backdrop": "gf-backdrop=1",    // optional (kit 1.4.0): the game's page with this query stands behind the waiting room
    "hud": "game"                   // optional (kit 1.4.0): the game draws everyone's scores and the room (net.room); no rail
  },
  "check": { "near": 2.5, "seconds": 90 }   // optional, the gate only: how far a drawn friend may be from where they really are
}

// mode "solo"
{ "schemaVersion": 2, "mode": "solo", "reason": "A branching story for one reader: there is no result to compare and no moment two players would share." }

// mode "world" (gf-multiplayer 1.5.0)
{ "schemaVersion": 2, "mode": "world", "title": "Blockhaven", "players": { "min": 1, "max": 8 },
  "world": { "entry": "index.html", "query": "", "key": "auto",      // auto: world:<slug> under /p/<slug>/, else a local key
    "tagline": "A block world everyone shares.", "hud": "game",       // hud game: the game shows the room in its own menu
    "sees": "…", "shares": "…" } }

// mode "room"
{ "schemaVersion": 2, "mode": "room", "players": { "min": 2, "max": 4 },
  "room": { "entry": "index.html?mp=1", "module": "room.js", "bot": "bot.js", "start": "lobby" } }
```

- **Conditions** (`ended`, `won`, `started`): `{path, in: [...]}`, `{path, is: value}`, `{path, gte|gt|lte|lt: number}`, `{path, truthy: true|false}`, or `{any: [...]}`, `{all: [...]}`, `{not: {...}}`.
- **Adapter `observe`** reads the read-only QA observation every game already exposes (`new-game-trial` §4). The game changes nothing. An end counts only after the game was seen not ended, and only the first end of a round counts.
- **Adapter `hooks`**: the game calls `gf.run.start()`, `gf.run.progress(x)` and `gf.run.end({won, value})` from `sdk/gf.js` (`CONTRACT.md` §3) and reads its seed from `gf.run.seed`. Use it when a game has no observation, or for a new game. Add `"progress": {"kind": "fraction"|"score"}`.
- **Seeds are digits** (`"1354559097"`), because games read `?seed=` as a number as often as a string.
- **When lower is better** (a time, strokes), give `won`: a run the game called lost never beats a finished one.
- Validator: `validateMultiplayer()` in `party/lib.mjs`.

## The gate

```bash
node builder/multiplayer/party/gate.mjs <game-dir>           # → <trial>/evidence/mp-gate-N/record.json + screenshots
```

One Chrome, a separate context for a host and a joiner, real WebRTC, real mouse and keyboard through the party page. For a `race` game it checks, in order: the manifest; the kit copy is a released kit, byte for byte (any version: legacy games keep theirs); the game on its own loads no kit file and opens no connection; the host opens a room; the joiner joins by the invite link; the host's settings reach the room; both frames get the same seed; the adapter reads both games; the value moves while playing; an end is detected; both pages show the same results and they are the games' own values; the scripted players stayed in round 1; play again deals a new seed; round 2 starts with nobody holding a result; a reload takes the same seat back; the host ends a round; the host leaving closes the room; no errors from the kit.

| Verdict | Exit | Meaning |
|---|---|---|
| `pass` | 0 | Every check passed. |
| `end-unproven` | 3 | Everything passed but no scripted run reached an end, so the `ended` condition was never seen firing. Give `check.query` (a shorter run), `check.steps` (steps that finish a run, with `check.repeat` for a pattern) or `check.seconds`. Not a pass. |
| `fail` | 1 | Anything else. |

The scripted players use random game-like input, the game's own start steps, and whatever `check` gives. A game random input can't score in (catching a fish, timing a tap) may ship `<trial>/mp-driver.mjs`, its own player with real input that reads the game's observation (the contract is at the top of `gate.mjs`). Scripted input never presses the party page's own cards.

**A `live` game** (`gate-live.mjs`) is checked for what the creator asked for. Its observation carries a `net` block (who this copy draws and where, whether each friend's character is on screen, the shared clock, a digest of the shared world; `party/LIVE_HANDBOOK.md`, "What the gate reads"). The gate checks: both games load and say ready; they start within 1.5 s of each other; each copy draws the other player where that player really is; a friend's character is on screen, with a screenshot of that moment; the host's movement shows on the joiner; the shared world agrees on both copies; the world keeps running while the host's tab is in the background; both get the same result; play again; a reloaded joiner drops back into the round and draws the host; the host ends a round; the host leaving closes the room. A person still looks at the screenshot: the gate knows a character is in view, not whether it looks like one.

A `solo` game passes on a real reason. A `room` game is checked for its files; its own `qa.mjs` plays it in two browsers (`p2p/qa.mjs` is the pattern).

**The gate proves the mechanics, not the meaning.** It can't tell that `stats.throws` is the wrong number to rank a bowling game by. Whoever writes the manifest reads the game's README and checks the value is what decides who won.

## Tools (`builder/multiplayer/party/`)

| Tool | What |
|---|---|
| `LIVE_HANDBOOK.md`, `fixtures/arena/` | How to make a game live (what each copy owns, the rules, what the gate reads) and the smallest game that does it. |
| `detect.mjs <game-dir> --out draft.json --report r.json` | Drafts the manifest from a scripted play session and the game's source. No agent. Right on its own for plain score games; read the report's candidates for the rest. |
| `gate.mjs <game-dir> [--draft draft.json] [--signal http]` | The gate. `--draft` tries a manifest with nothing written into the game; `--signal http` plays it over HTTP signaling (`/signal/v1`, the play origin's transport; kit 1.3.0+). |
| `adopt.mjs <game-dir> [--check]` | Copies the current frozen kit (1.3.0) to `<game-dir>/gf/mp/`; `--check` finds drift from it. |
| `serve.mjs <game-dir> [--port 5780]` | The game plus signaling on one port, to try it yourself in two windows. |
| `status.mjs` | Every game in the showcase: its mode, its kit, its last gate verdict → `ROLLOUT.md`. |
| `kit/`, `lib.mjs`, `tests/` | The kit's development sources, the shared library, the tests. |

## Where the standard is enforced

- **New games:** the `new-game-trial` skill (§1 brief, §4b, §5) and the `game-builder` agent require `multiplayer.json` and a gate run; `CLAUDE.md` says so. The brief names the mode before any code is written, because a `room` game is built as a room from the first line.
- **Existing games:** `party/rollout.json` holds the mode chosen for each showcase game and why; `status.mjs` reports which have the manifest, the kit and a passing gate.
- **Asset tools:** `builder/asset-manifest/validate.mjs` treats `gf/mp/` and `multiplayer.json` as kit files, not creator assets.

## Honest limits

- **Not deployed yet.** HTTP signaling for Studio's play origin is built (2026-10-07): `POST /signal/v1` with a long-poll, backed by Postgres (`studio-lib/signal-http.mjs`, migration `0012_signal.sql`). Kit gf-multiplayer 1.3.0 uses it on any host that isn't localhost and keeps the WebSocket on this machine (`p2p/README.md`, "Signaling"). It is verified on a local Studio: two Chrome contexts host and join through `/signal/v1` and play a round (`p2p/evidence/http-signaling-2026-10-07/`). Still missing:
  - the deploy;
  - a "Play with friends" link friends can open;
  - a TURN relay: added 2026-10-08 (Cloudflare Realtime TURN, short-lived credentials from `/signal/v1/ice`; `p2p/README.md`, evidence `research/foundations/evidence/multiplayer-turn-relay-2026-10-08.json`);
  - games on kits before 1.3.0 (every game adopted before 2026-10-07) only know the WebSocket, so they need re-adopting to work off this machine.
- **The host is trusted** and results are each player's own claim (`p2p/README.md`, "Honesty"). Friends only.
- **`race` does not meet the bar** (the creator, 2026-10-05). It stays in the 56 games that have it until each is converted; nothing may describe those games as multiplayer without saying so.
- **Godot and PuzzleScript games** have no observation the shell can read and are served from frozen releases: they need a bridge and a new release each.
- Chrome only so far. No phone, Safari, real-network or human test.

## Next

1. Deploy the HTTP signaling (built 2026-10-07: the routes, migration 0012 and kit 1.3.0; `p2p/README.md`, "Production options" E), then add a "Play with friends" button in Studio and on the demo pages. A TURN relay is a separate decision. Until then the local showcase host (`node research/foundations/showcase/serve.mjs`, port 5260) carries WebSocket signaling and links every adopted game's party page.
2. The creator picks which `race` games deserve the `room` rewrite.
3. Live ghosts in `race` for course games (the other players' karts and runners drawn in your world).
4. A bridge for Godot releases.
