# mechanic: station

Interact with a prop: an in-world screen (text and progress on a CanvasTexture, never art) shows the task, who is working it and the quota. Hold, tap or stand to work it.

Part of the gf-three kit (track K2). Add it to a spec as `{ "id": "station", "as": "...", "params": {...} }`; `create` fills the defaults.

## Params
`stations` (`[{zone}]`, `[{at: [x,y,z]}]`, `[{prop: 'desk', index: 0}]`, each with an optional `title`), `mode` (`hold`|`tap`|`stand`), `taskSeconds`, `taps`, `cooldown`, `keepProgress`, `range`, `action`, `quota`, `quotaLabel`, texts (`title`, `idleText`, `busyText`, `mineText`, `doneText`), `pointsPerTask`, screen size and colours.

## Controls (CONTRACT §6d)
The prompt near a free station goes through `ctx.ui.prompt(text, 'station')`, so it shares the line with the pickup and
carry prompts. `interactables()` lists the free stations with their range, mode, seconds and taps (verify check 13
walks to one and holds or taps the action).

## Slots
`mechanic.station.screen-color` (tags the screen), `.stand-color` (the stand under a free-standing screen), `.accent` (progress bar), `.text-color`, `.title`, `.quota`, `.task-seconds` ... The text on the screen is drawn at run time from these text slots.

## Network ownership and message rates
**Host owns** each station's state and the quota. `ctx.shared` key `station`: `s` = `[state, workerSeat, progress%, cool*10]` per station (about 16 B), `q` = `[done, needed]`, `x` = custom screen text set by rules (about 80 B each when used). Events: `station:use` (hold start/stop, 2 per task) and `station:tap` (tap mode, at most about 10/s per tapping player). Screens redraw only when their text changes. Peak: 10 events/s per player in tap mode, otherwise about 1/s.

## Netcode traps (PLAN 2.6)
Work states change on the host; the sound and the screen follow the edge of the state on every copy.

## Methods for rules.js
- `use(player, i, on)` (hold/stand), `tap(player, i)`, any copy for an owned player; with `action` set, owned players' input is read automatically.
- Every copy: `state(i)`, `nearest(player)`, `quota()` `{done, needed, met}`, `count()`. Host: `show(i, {title, lines, bar})`, `addQuota(n)`, `onComplete(fn)` `{station, player, quota}`, `onStart`, `onCancel`.

Example: `station.onComplete(({ quota }) => { if (quota.met) ctx.round.end('quota met', everyone); });`

## Fixture and tests
- Pure logic: `research/gf-three/tests/k2-station.test.mjs`.
- Two-player fixture: `fixture/spec.json` (mini-spec), `fixture/rules.js` (the tiny game, exposes `window.__fx`), `fixture/scenario.mjs`. Run: `node research/gf-three/tests/k2-fixture.mjs station` (creates the game with `tools/create.mjs` into the scratchpad, serves it, plays host + joiner over WebRTC in two headless contexts). The generated game is not kept in the repo (it is reproducible from those three files). Checks: two players: the joiner holds the action at the station, the host sees it busy with the joiner's name and the progress rise, the task completes on both, quota counts on both, a second worker is refused while it is busy.
