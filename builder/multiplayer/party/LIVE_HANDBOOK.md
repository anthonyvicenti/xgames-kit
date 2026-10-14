# Making a game live: friends in one game, who see each other

The bar, from the creator on 2026-10-05: "we should always be able to see some sort of character model for the other player for all these games. No point in multiplayer if you can't see your friends", and the games must be "in sync". A rail of numbers beside separate copies of a game (mode `race`) does not meet it.

A **live** game (`multiplayer.json` mode `live`) puts every player in the same game:

1. **You see your friends.** Every other player is drawn as a character in your view, with their name, where they really are, moving as they move.
2. **One world.** Whatever players share (enemies, pickups, the ball, the waves, the clock) exists once, in the **host's** copy, and every other copy shows the host's instead of simulating its own.
3. **It starts together and never pauses.** Everyone's round begins at the same moment, and no player can freeze the world: not with a pause key, not by switching windows.

One player hosts in their browser; the others join by code. There is no server. The kit carries the messages: `gf/mp/net.js` in the game (read its header: it is the whole API, about 40 lines of comment), the party page around it, and the room on the host's machine.

Reference implementation, 130 lines: `multiplayer/party/fixtures/arena/index.html`. Read it before you start. Then read the finished conversion closest to your game (its README "Multiplayer", its AGENT_NOTES.md, the file that draws the friends, its `qa-live.mjs`) and copy its patterns instead of deriving them again. All are under `research/foundations/trials/`:

| Your game | Copy from | What it shows |
|---|---|---|
| 3D, first person, enemies | `dusk-outbreak`, `fps-arena` | a body for friends (`src/friends.js`), an honest `onScreen` (`src/sight.mjs`), bots with several targets, down and revive |
| 2D, enemies | `twin-stick`, `brawler` | host-owned enemies and shots in a small world, batched hits, friends through the player's own look |
| A course everyone runs | `flight-rings` | nothing shared but the start, friends at speed, edge tags, a HUD list of the others' progress |
| A race with AI rivals and items | `kart-racing` | players and AI on one grid, host-owned items and hits, standings with everyone |
| Turns | `bowling` | one shared lane, a turn order, a stall timer, late and leaving players, where waiting players stand |
| Two players fighting, or shooter and keeper, or one table | `fighter`, `penalty-shootout`, `pool` | the copy that is hit decides the hit; roles that swap; a host-simulated table with turns, a person at the rail |
| Two players against each other, one ball | `table-tennis` | each copy decides only its own touch of the ball and sends that one stroke; both fly the ball on the same physics; the host owns the score and the serve; a leaver forfeits |
| A splat (PlayCanvas) scene | `splat-fps` | the mannequin in PlayCanvas (`friends.mjs`), an honest `onScreen` against the collision proxy (`sight.mjs`), a friend on the map |
| A course with vehicles | `apex-courier`, `tidewind` | grid slots by seat, a 3-2-1, cars or boats passing through each other; tidewind: one host-owned weather for everyone |

Measured on those six (2026-10-05): 24 to 92 minutes and 240k to 420k tokens a game on the cheaper model, 114 and 172 minutes on the top model for the two hardest.

## The shape of the change

Played alone the game must stay exactly what it was. `net.active` is false there and every `net` call does nothing, so you write one code path with a few `if (net.active)` branches, not two games.

```js
import { net } from '../gf/mp/net.js';        // path relative to the importing file; kit-owned, never edited
const owner = !net.active || net.host;        // does this copy own the shared world?
```

| Part of the game | Alone | Live, host's copy | Live, any other copy |
|---|---|---|---|
| Your own player (movement, aim, weapon, health) | simulate | simulate | **simulate** (never wait on the network for your own controls) |
| The other players | none | draw from `net.peers()` | draw from `net.peers()` |
| Shared things (enemies, waves, pickups, clock) | simulate | simulate, against **every** player, and `net.world(...)` it | **do not simulate**: show `net.shared().state` |
| Something you do to a shared thing (a hit, a pickup) | apply | apply | `net.send('hit', {...}, 'host')`; the host applies it and it comes back in the world |
| Something a shared thing does to you (a zombie hits you) | apply | apply locally, or `net.send('hurt', {...}, playerId)` for another player | apply when the host's `hurt` arrives |
| Random numbers that shape the shared world | seed | seed from `net.seed` | not needed |
| Start | title screen | `net.onStart(start)` after `net.ready()`, no title | the same |
| Pause | as before | a menu over a world that keeps running | the same |
| The frame loop | `net.loop(frame)` | `net.loop(frame)` | `net.loop(frame)` |
| The end | as before | decide it, `net.finish({won, value})`, put it in the world | take it from the world |
| The round is over for everyone (a result, the host's End round, the time cap) | n/a | `net.onEnd(stop)`: stop the world and its sound | the same |

`net.loop(frame)` replaces the game's `requestAnimationFrame` chain (the frame function no longer schedules itself). Alone it is exactly `requestAnimationFrame`. Live, it keeps a background tab stepping, so a host who switches windows does not freeze everyone.

**Which pattern fits the game:**
- **Enemies or other things that react to players** (shooters, survival, dungeon, brawler, tower defence): the full table above. The host owns the enemies; players own themselves.
- **A course everyone runs** (racing, flying, golf, platformer, runner): the shared world is only the level and the start signal. Draw the others as characters on your course (no collisions is fine: say so in `sees`). `shares` is "Nothing but the level and the start".
- **Turns at one table** (bowling, golf, pool, darts): the host owns the table and rolls every shot on the real rules; a player's finished input travels as one event and every copy draws the host's result. The host keeps the turn order by seat, gives a stalled player a null turn after a time limit, skips a leaver, and lets a late player in from the next round with what they missed scored as nothing.
- **A board or a table** (cards, tactics, puzzle versus): the shared world is the board, the turn and the timer. A player's "character" is their piece, hand or cursor with their name and colour, drawn for everyone.
- **A game that is one person's business** (a story, a private toy): it is `solo`. Don't fake it.

## Rules

- **Draw a character, not a dot in a list.** Each other player is a model or sprite of the same kind as the player's own character, in that player's colour (`peer.color`) or with a clear name tag (`peer.name`), animated at least between standing and moving. In a game that never shows a person (first person, or a game about a ball), add a body for the others: `third-person-adventure/source/assets/hero/hero.glb`, the Quaternius Universal Animation Library mannequin (CC0; copy its LICENSE.txt, add provenance, attribution and a model slot). It needs three's meshopt decoder vendored (`fps-arena/source/vendor/three/examples/jsm/libs/`) and has no crouch or two-handed clip. **A friend must never look like an enemy or an AI rival:** `operative.glb` is the enemy in fps-arena.
- **Draw the others through the same look as the player's own character.** Whatever makes the player's picture a creator can replace in Studio (a model slot read through gf-assets, or in a 2D game the character painted once into its own canvas through `gf/looks.js` and copied each frame, as `brawler/source/src/render.js` does since 2026-10-05) is what the other players are drawn from, tinted or tagged with their colour. A second per-frame painter for the others would show a creator's replaced picture for one player and not the rest.
- **In a game with `gf/looks.js`, the line a look is made on is that picture's identity.** Each replaceable picture is a `drawn` slot in `assets.json` whose `drawn.sig` is a file:line:column pair and whose `bake.hash` is the hash of the file. Adding or removing a line above the looks leaves every picture slot pointing at the wrong line: the game still plays, and a creator's replaced picture silently stops showing. So: keep one `look(…)` per line, each assigned to a named property, and keep the old per-frame painters in the `else` branches; a new replaceable thing is one new `x.y = look(…)` line. Never regenerate `assets.json` or change a slot id (`asset-manifest/curate.mjs <dir> --apply <table.json>` adds and relabels); leave `source/art/**` and `source/enrich-report.json` to the capture. After the LAST edit to a file that holds looks, in this order: `enrich.mjs <dir> --write art` (never `--fresh` or `--allow-loss`), `validate.mjs <dir>` (0 errors; `scan-code.mjs <dir> --reanchor` fixes stale anchors), `looks-check.mjs <dir> --count` (the same names as before, none lost), and one `swap-proof.mjs <dir> --slot <a look's slot id> --out <scratch>` (exit 0: the replaced picture is on screen). All four are in `asset-manifest/`.
- **Never trust yourself with what is shared.** A copy that is not the host's never spawns, moves or kills a shared thing on its own; it asks the host.
- **Never make the player wait.** Their own movement, aim and shots happen at once on their own screen. Only the consequences for shared things travel.
- **Stay inside the limits.** One message is at most 4096 bytes of JSON, and a player may send 60 messages a second (a burst of 120 is tolerated). Over that, the host's own messages are dropped silently and another player is disconnected. Pose (15 a second) and world (12 a second) are the kit's; that leaves about 30 a second for events on the host and 45 on the others. Never send an event per frame, and batch what happens in one frame into one message (all the pellets of one shot, not one message per pellet).
- **Poses are small and flat:** `net.pose({x, y, z, yaw, anim, hp})`, a few numbers and a word. The kit sends 15 a second and interpolates on the other side (fields named `yaw`, `angle`, `facing`, `rot`… turn the short way).
- **The world is under 3.5 KB:** short keys, rounded numbers, only what the others must draw (Dusk Outbreak with four players peaks at 2.4 KB). The kit sends 12 a second and `net.shared().state` is blended between the last two (lists of `{id, …}` match by id). **Every number in `state` is blended**, so a number that must not be (a wave index, a count, a state code) is read from `net.shared().latest`, or sent as a string.
- **Sounds and effects for shared things come from changes in the world, not from events.** A copy that is not the host's compares each new world with the last (a zombie that was alive is dead, a wave number went up) and plays from that, keyed on the thing's id so it never doubles. Events are for what only one player needs to be told ("you were hurt").
- **A player can arrive late or come back after a reload.** They get `net.onStart` at once and the next world from the host; their own player starts fresh. Nothing may depend on having seen the round's first message.
- **The host leaving ends the round** for everyone (the party page says so). Don't build host migration.
- **No pause in a live round.** Esc or P may open the menu, release the mouse and stop that player's own input; the world goes on, and the menu says so. Remove every pause on `blur`, `visibilitychange` and pointer-lock loss when `net.active`. **Escape always gives the mouse back** and never re-takes it: the player needs it for the party page's buttons.
- **Clamp the frame step at zero** as well as at its maximum (`dt = Math.max(0, Math.min(0.05, …))`). `net.loop` never hands the frame an older time than the call before, but a game's own clock arithmetic should not depend on it.
- **Call `net.pose` and `net.world` every frame.** The kit sends each when it is due; don't keep your own timers for them.
- **Give the others something to do when a player is out.** In co-op, a player at zero health is down, not gone: they come back (at the next wave, after a timer, when a friend reaches them). The round is lost only when everyone is down.
- **Scale it.** More players, more or tougher enemies; one number in the config, with a slot.
- **Sound and effects for what the others do** (their shots, their hits) play at their position, quieter with distance.
- **A player's place in the room** is `net.you.seat` and `player.seat` (0 for the host, then 1, 2, 3): use it to start players apart and to pick a colour or a skin.
- **A player always sees their friends, including on their own turn.** In a turn game, the waiting players stand where the active player's camera sees them, not behind it. *(bowling was sent back for this)*
- **The player's colour can clash with the game's palette** (the second seat is pink; so were twin-stick's enemies). The name tag and a ring or outline in the colour are what tell a friend apart; don't rely on body colour alone, and never on colour alone to tell a friend from an AI rival.
- **`net.peers()` state is blended too.** A field in a pose that must not be blended (a lap, a state code, a finish time) is a string.
- **A world full of short-lived things** (shots, swarms) is read from `net.shared().latest` and smoothed per entity by the game; `blend` only suits a few long-lived things with ids.
- **The end arrives in two messages:** the world that says who won, and `net.onEnd`. Put the result in the world first and call `net.finish` a moment later (brawler waits 0.45 s), or a guest sees "round over" before the reason. Keep the shared clock rising until `net.onEnd`.
- **A copy that joins late is not told so:** compare the host's clock with zero.
- **The party page ignores Play again for 0.7 s** after results appear, and reveals a round within 0.1 s of the other copies; a game that needs a tighter start counts from the host's clock.
- **Never change the shared working tree with git** (`stash`, `checkout`, `restore`, `reset`): other builders and sessions have uncommitted work in it. To prove solo play is unchanged, write the old file to a scratch directory (`git show HEAD:<path> > <scratch>/<slug>-old.mjs`) and compare seeded runs of the old and new rules step for step.
- **Never regenerate `assets.json`.** Add slots in place. The gate's scripted player comes from its `check.play` block: a manifest that loses it turns a passing gate into "the value never moved". *(fruit-slice)*
- **Keep the loop's first frame as it was** when `net.loop(frame)` replaces the game's own `requestAnimationFrame` start: a game that started its clock on the first frame (or skipped the first tick) must still do so, or solo play starts one step out. *(tidewind, trick-board, endless-runner; caught by `play-compare.mjs`)*
- **Scope new CSS** to the live layer (`.tags .tag`): a bare `.tag` restyled apex-courier's title label. *(apex-courier)*
- **Report progress to the party page's side list** with `net.progress(share, value)` (share of the course 0 to 1, and the score or distance), a few times a second at most; without it the list shows nothing all round (several wave 2 games).
- **Prove the page, not only the rules:** `asset-manifest/play-compare.mjs <committed copy> <working copy>` in lockstep, with the new snapshot fields left out of `--state`.
- **`won` is `true`, `false` or `null`.** When lower is better, the room ranks a `won: false` run below every finished one; a round with no win or loss, only a number (strokes, a bag weight), reports `won: null` and is ranked by its value. *(mini-golf)*
- **A winner ranks first (kit 1.2.3).** The room puts a `won: true` run above every run that did not win, then orders by value. In a last-one-standing versus, report `won: true` for the survivor and `won: false` for each player who goes out, and the results card names the survivor even when someone who went out had more points. *(falling-blocks)*
- **No character? Draw the friend's board.** In a puzzle or arcade game the friend is their own board or view drawn live and smaller beside yours, framed in their colour with their name, with a small character of theirs that reacts (cheers, ducks, wilts), plus versus pressure where the genre has it (rows sent to the friend). Each copy owns its own board and sends it in its pose; the host owns only the clock. *(falling-blocks, a pilot the creator has not judged yet)*
- **Two players against each other:** the copy that is hit decides the hit, with its own block and invincible frames (fighter); one role each and the swap from the host (penalty-shootout); turns on one host-simulated table (pool). A host alone in a live room keeps the game's CPU opponent where it has one (fighter, table-tennis) or plays both seats (pool), never a dead screen.
- **An event that arrives between steps** must not go into a list the next `step()` clears (`g.events`); handle it on arrival. *(fighter)*
- **A player who does not move** (an anchored angler) reports a point that does move as `me` for the gate, e.g. the rod tip, and sets `check.near` to match. *(fishing)*
- **Don't edit `gf/mp/`.** If the kit is missing something, stop and say exactly what.

## What the gate reads

`window.__game.snapshot()` gains a `net` block (null when played alone). The gate (`gate.mjs` → `gate-live.mjs`) checks it from both browsers:

```js
net: net.active ? {
  you: net.you.id, host: net.host, started: net.started,
  me: { x, y, z },                                   // where this player is, world units
  peers: net.peers().map(p => ({ id: p.id, name: p.name, x, y, z, onScreen })),
        // where THIS copy is drawing each other player, and whether their character is inside this player's view now
        // (project the drawn position through the camera: in front, inside the frustum, not hidden by the HUD)
  over: net.over,                                    // true once the round has ended for everyone (net.onEnd fired)
  clock,                                             // seconds of shared time, the host's, rising while the round runs; on
                                                     // another copy the last one the host sent, never run on by that copy's frames
  shared,                                            // a short string, equal on every copy when the shared world is in sync:
                                                     // e.g. `${wave}|${phase}|${ids of live enemies, sorted}`; '-' when only the level is shared
} : null
```

`onScreen` means a player could actually see the friend: in front of the camera, inside the view, and not hidden behind something big in the way (Dusk Outbreak first said true for a friend standing behind a zombie).

The gate's players press random keys and click at random. In a game with enemies they die in seconds, and the checks that need a round in progress never run. Give the gate a gentler round with `check.query` (a real query the game reads, such as a test config with low damage and a short first wave); the gate's record says it was used, and real play never is.

`check.near` is in the game's own units (pixels in a 2D game) and has to allow for speed: a friend is drawn 130 ms behind, which is 5 m for a glider at cruise. The live gate plays random input only, and a round that ends early (every player out, or a one-frame game) loses the later checks: give the gate a round that lasts with `check.query`.

It checks: both games say `ready`; they start within 1.5 s of each other; each copy draws the other player within `check.near` world units (default 2.5) of where that player is; a friend's character is on screen at some point (it takes the screenshot at that moment: look at it); the host's movement shows on the joiner; `shared` agrees in at least 80% of samples; the shared clock keeps running while the host's tab is in the background (its pace on the joiner with the host's tab behind another, held to its pace with the tab in front, read just before and after: a busy machine slows both alike); both get the same result; play again; a reloaded joiner drops back in and draws the host; the host ends a round; the host leaving closes the room.

## `multiplayer.json`

```json
{
  "schemaVersion": 2,
  "mode": "live",
  "title": "Dusk Outbreak",
  "players": { "min": 1, "max": 4 },
  "live": {
    "entry": "index.html",
    "seedParam": null,
    "team": true,
    "metric": "time", "direction": "lower", "unit": "s",
    "maxSeconds": 600,
    "sees": "Each player sees the others as a survivor in their own colour, carrying a shotgun, with their name above.",
    "shares": "The zombies, the waves, the dusk and the clock"
  },
  "check": { "near": 2.5, "seconds": 90 }
}
```

`team: true` is one result for everybody (co-op), reported by the host's copy with `net.finish`; since kit 1.4.0 the host also sends every player's own score (`net.finish({won, value, values: {p1: 40, p2: 12}})`), so the results show each player theirs instead of the host's number for all (creator, 2026-10-08: "Final scores seem to always be the same regardless"). No bots with friends: a live round holds the players in the room and nobody else (kit 1.4.0). `team: false`: each copy reports its own (a race you can see each other in). `sees` and `shares` are sentences a person reads to check the claim.

## Steps

```bash
source ~/.nvm/nvm.sh && nvm use                                   # Node 24.19.0
node builder/multiplayer/party/adopt.mjs <trial>/source          # copies the kit, net.js included, to source/gf/mp/
node multiplayer/party/serve.mjs <trial>/source --port <your port>   # http://127.0.0.1:<port>/gf/mp/ in two windows
node builder/multiplayer/party/gate.mjs <trial>/source --no-record           # while you work
node builder/multiplayer/party/gate.mjs <trial>/source                      # the record: <trial>/evidence/mp-gate-N/
```

1. Read the game's README, AGENT_NOTES.md and its rules module. Decide the pattern and write down, in two lists, what each copy owns and what the host owns.
2. Keep the rules module pure and testable: add the multiplayer rules there (targets, remote hits, down and revive, scaling) with unit tests, not in the view code.
3. Wire `net` in the shell file: ready and start, pose out, peers in, world out or in, events, finish, `net.loop`.
4. Draw the others. Then the things the others do.
5. The game's own `qa.mjs` and tests must still pass untouched for solo play. Then the gate. Then write a co-op QA of your own (`qa-live.mjs`, two browser contexts through `startParty` from `party/lib.mjs`, real input) for the rules the gate can't know: a joiner's shot hurts the host's enemy, an enemy hurts the joiner, a downed player comes back, the round is won and lost for both. Evidence in `evidence/qa-live-N/`.
6. Screenshots are JPEG, about eight a run. **Look at the screenshots of every run, passing or not.** `*-sees-the-*.jpg` must show a friend's character, recognisable, with a name. In the pilot both real bugs (a light that flashed on from a negative frame step, an `onScreen` that was true behind a zombie) were found by looking at pictures from runs that passed.
7. Code changed, so run the asset tools again (`validate.mjs`, `check.mjs --tree`, `scan-code.mjs --reanchor` if the game has code slots), add slots for new models, text and tuning, and update README, AGENT_NOTES.md and ATTRIBUTION.md.
