# mechanic: build

Place, break and paint blocks in a voxel world (`kit/world/voxel`), put up signs, and set off boom blocks. Everything is shared with everyone in the world and saved on the play host. CONTRACT §9; research/worlds/PLAN.md.

## Who owns what

| | |
|---|---|
| Every copy | Its own player's tools. The hotbar, break, paint and signs. The face under the cursor (or the tap) is picked from the voxel grid. Its own edits show at once and wait for the host's word (`pending`). |
| The host | The order of every edit. It checks each edit again (`logic.mjs check`: bounds, the floor, the spawn square, one block per cell, paint, sign words, a standing player), applies the rate limit (`rate`, `burst`) and the boom cooldown, numbers the edit in the room's log and sends it to everyone. It saves to the play host every `saveEvery` s and on `pagehide`, sets off the boom blocks, and catches up anyone who arrives. |
| The play host | Every saved edit (`kit/net/persist.js`; `creator-studio/lib/world-core.mjs`). It checks the same hard limits from the published `config/world.json` and drops an edit id it already has. |
| Alone | The game's own page with nobody else (`!ctx.net.active`) is a practice copy. It loads the world and polls the play host, so it keeps up with it, but it never pushes an edit (`saves()` is false). Changing the shared world takes being in its room: seen by everyone, and one of its 8 seats. The play-test of 2026-10-09 found the bare page's edits reaching the world with no author. |

A standing player blocks a cell, except the edit's own author. The author's copy lets the edit through once their feet are 0.4 above the cell's floor (a pillar jump) and lifts them onto the block. The host never refuses an edit for its author's body, which it sees a moment late.

## Net (`ctx.net` events, prefixed `build:`)

| Event | Direction | Data |
|---|---|---|
| `e` | a guest → the host | an edit `[u, x, y, z, v, text?, face?]` |
| `ed` | the host → all | `{l: [[r, ...edit], ...], s, g}`: accepted edits in the room's order `r`. `s` is the room's last saved `r`; `g` is the world seq the host has |
| `no` | the host → the author | `{u, x, y, z, v, t?, f?, r}`: refused, with the cell as the host has it and the reason |
| `sync` | an arriving copy → the host | `{g, t: [facts], p: [mine], last}`: the world seq its load reached, the edits it saw from an earlier room that may not be saved, and its own unanswered edits |
| `bulk` | the host → that copy | `{l, n, done, s, g}`: the room's edits its load lacked, in order, in paced chunks under 3.4 KB |
| `pop` | the host → all | `{x, y, z}`: a boom went off (the crater's cells come as edits) |
| `reload` | the host → all | the operator restored the world: load it again |

## Handoffs

When the host leaves, gf-multiplayer 1.5.0 re-forms the room and one copy becomes the host (`roomChanged`: the room's code or `ctx.host` changed).
- **The new host** starts a new log and queues what it holds that may not be saved: the old room's unsaved tail and its own unanswered edits. The server drops repeats. It then polls the play host for anything an earlier host saved that it never got.
- **Every other copy** polls the play host for edits after its `g`, then sends `sync`. Its facts are taken with only the hard limits, so every copy ends up alike. Its own edits are re-checked as new ones.
- The host answers with `bulk`.
- An edit id a copy has already applied is never applied twice (`applied`, the last 80 000).

## Params (`config/game.json` → `mechanics[build].params`)

`hotbar` (block ids, keys 1–9 and 0 pick the first ten), `reach` (blocks from the head), `rate`, `burst`, `paint`, `signs`, `boomFuse`, `boomRadius`, `boomCooldown`, `boomPush`, `boomChain`, `saveEvery`, `pollEvery`, and the sound ids `soundPlace`, `soundBreak`, `soundPaint`, `soundSign`, `soundFuse`, `soundBoom`, `soundDenied`, `highlight`. Slots: `mechanic.build.*`.

## Controls

| Input | What it does |
|---|---|
| Click (a tap) | Use the tool: place the selected block on the face aimed at (or over a plant), paint the block, or open a sign's words |
| Right click (a long press) | Break the block |
| X | The break tool |
| P | The paint tool (the hotbar shows the colours; 1–0 pick one, the first is "wash off") |
| E | Change the sign aimed at |
| Wheel (first person) | The next or previous block, or colour while painting (the orbit camera zooms with it instead) |

What is aimed at: the face under the crosshair in first person with the mouse taken (`camera: "first"`, CONTRACT §9), else the face under the cursor or the tap (the orbit camera, first person in a post that refuses the lock, and phones). In first person with the mouse not yet taken, the prompt says "Click to look around with the mouse"; the sign editor gives the mouse back while it is open and takes it again when it closes.

Keys pressed in the same frame apply in the order they went down (`input.keysPressed()`). In the sign editor, Enter starts a new line (up to 3), Ctrl+Enter or the button puts the sign up, and Escape cancels. A phone shows about 6 slots of the hotbar; arrows at its ends show there are more, and the hotbar scrolls to the selected slot.

A sign faces the side it was put on, or the player when it stands on top of a block. Its words are tidied (`tidyText`: 3 lines, 60 characters) and filtered (`kit/net/world-text.js`, the same filter the play host runs).

## Observation

`observe()` (`window.__game.build()`) returns:
- `tool`, `slot`, `color`, `hotbar`, `pick` (the cell, its normal, where a block would go, `far`, `sign`);
- `saves` (this copy pushes to the play host: in a room, as its host), `pending`, `log`, `savedThrough`, `feed`, `synced`, `fuses`, `room`, `host`;
- `ui` (the hotbar's state);
- `stats`: `placed`, `broken`, `painted`, `signs`, `booms`, `refused` and `refusedBy`, `sent`, `accepted`, `saved`, `syncs`, `bulkSent`, `handoffs`, `tailsTaken`.

`edit(x, y, z, block, {tint, text, face})` makes an edit as this copy's player would (QA, fixtures).
