# The gates' regressions

Every problem a person finds by playing becomes a broken example here that a gate must fail, for the reason it names
([../../GATES.md](../../GATES.md), "Never again, with gates"). If no gate fails it, the gate that should have is widened
for the whole class of problem; a numbered check or a prompt rule is never added (at most 8 gates, 5 prompt rules).

```
node builder/gates/regress.mjs              # every regression, on the GPU (wrap it in the machine's GPU queue)
node builder/gates/regress.mjs --only car-strafes
node builder/gates/regress.mjs --record     # all green: writes last-green.json (commit it)
node builder/gates/regress.mjs --keep       # leaves the games it made in the system's temporary folder
```

`tests/gates-regressions.test.mjs` (npm test) checks every `regression.json` and fails while `last-green.json` was
recorded on other files than the gates as they are (verify, `builder/tools/lib/*-check.mjs`, the verdict rule, the
stepped clock, the runner and this folder): a change to a gate lands with a green run recorded on the GPU.

## A regression

`<id>/regression.json`:

| field | |
|---|---|
| `base` | a folder of `bases/`: a locked spec v2 (`spec.json`), the game's own files as a build wrote them (`rules.js`, `src/`), and `base.json` → `patches`, the config the build tuned (JSON pointers, as Studio's overrides set them) |
| `files` | `{"<path in the game>": "<file in this folder>"}`: the smallest change that brings the mistake back (the game's own files only; an edited kit copy is gate A's) |
| `patches` | config set by JSON pointer after the base's |
| `mustFail` | the gates that must fail; `measure`, the measure inside the gate that sees it; `detail`, a pattern its words must match |
| `mustPass` | instead, for a control: the same base, the mistake absent, passes that measure |
| `run` | optional: `{"check": [n…]}` or `{"gate": "C"}`; the default is the measure alone (`verify --check <measure>`) |
| `why`, `evidence` | what happened, in the words of the record that found it, and where that record is |

Each one runs on a fresh game made in the system's temporary folder: `create` from the base's spec, the base's files and
patches, then the change, then verify. So it runs from any checkout, on the kit as it is.

## Now

| id | gate · measure | what |
|---|---|---|
| `car-strafes` | C · 13 | a car whose A and D slide it sideways, as a walker strafes (PA10, 2026-10-13: verify passed three times on a car nobody could drive) |
| `car-controls-unshown` | C · 13 | PA10's controls as delivered: steer, accelerate and brake named, shown on no screen, skipped by verify |
| `camera-keys-dead` | C · 13 | the same class for a camera: a row says Q and E turn the camera, and nothing turns it |
| `slow-bots-race` | control · D · 12 | PA10's race at the bot pace a new player found fair (0.72): the first score comes at the finish line, after the check's old fixed window; it passes because fair play's pages play on to the game's own round while nothing has scored |
| `car-drives` | control | the same car as the build wrote it, its controls as rows with what each does: passes 13 |
| `board-friend-unseen` | E · 5 | a board played from the seats whose settings say the players are characters: the friend sits still and nothing says what they do (the creator, 2026-10-14: "You can fix seeing your friend default") |
| `own-board-unseen` | E · 5 | an own-boards game shown as seats: the friend's board, the thing they play, is on no screen but theirs |
| `table-four-friends-seen` | control | the same board with its default (seats): each screen shows the other's seat card, pointer and every disc they drop |
| `lights-race-friends-seen` | control | own boards with their default (boards): each screen shows the other's board live |
| `objective-out-of-reach` | D · 6 | the creator's look test (2026-10-14): "We were supposed to collect berries, but there were no berries anywhere ... those are impossible to get". Here Critter Lob's own code places its berries past the yard's fence; seeds and bots as the example has them. The play leg: most objectives cannot be reached |
| `idle-round` | D · 6 | the look test's levels as delivered: create's stub rules (nothing fires, bots never act), three berries that do not come back. The play leg: nothing meaningful for 30 s and more |
| `critter-lob-plays` | control | Critter Lob as the example writes it: measure 6 with its play leg passes |
| `look-greyed` | F · 23 | a game whose colour grade drifted to greys while every functional gate passes: the look judge holds it to the look target its spec locks and names the colour it lost (the looks layer, 2026-10-14) |
| `look-yard-holds` | control | the same game with the look its target was measured from: 23 passes |
| `pickups-at-sea-level` | D · 6 | the creator's case (2026-10-14): berries put at y = 0 on island terrain, in the sea or inside the ground ("there were no berries anywhere ... boxes [in the ocean] impossible to get") |
| `pickups-walled-off` | D · 6 | a berry on real ground in plain sight that a ring of raised ground walls off |
| `pickups-on-reachable-ground` | control | the same island level with the pickup part placing its berries itself (world.place): passes 6 |
| `island-no-connector` | D · 6 | the creator after the berry fix (2026-10-14): "making all area reachable". Berry Isles where the world may only cut ramps (`reach.kinds: ["ramp"]`, a look with no bridge, sandbar or pad): no ramp crosses 12 m of sea, so the east island and the gatehouse's island are left across the water; the reach leg names each area, where and why |
| `ruin-on-cliff` | D · 6 | the same level with its connectors off (`reach.connect: false`), as the composed levels were made: the gatehouse crowns the west island's hill, a cliff 3 m above where the composer's bridge lands, and nothing climbs it |
| `areas-joined` | control | the same level as the world makes it: its connectors (ramps, a bridge, pads) join every area; 6 passes |
| `objective-standin` | F · 14 | the look test's levels after stream reach: the berries on reachable ground, their slot still the kit's stand-in crate ("I think in the ocean I saw some boxes"); the thing to collect must look like it |
| `objective-wrong-model` | F · 14 | the same slot holding a library model that means something else (a CC0 barrel): not a stand-in, not a berry |
| `objective-in-library` | control | the same level as create makes it now: its art step fills the berry from the library by meaning (a CC0 strawberry): passes 14 |
| `creature-biped` | A · 19 | a biped skeleton in a blob's body slot (the looks pilot's moss-mole on Meshy's humanoid rig, 2026-10-14; the stand-in is the kit's bean): the slot asks for gf-blob-1 |
| `creature-torn` | A · 19 | a blob whose skeleton was fitted off the body (its Top joint metres above it): the creature judge refuses a joint off the body |
| `creature-holds` | control | the kit's slime on gf-blob-1 passes 19: the creature judge poses it through every action |

The base `kart-loop` is PA10's Island Circuit (builder/loop/evidence/2026-10-13-pa10-headless.json): made by the kit's
own build loop, no upstream code; its art comes from the library when `create` fills its slots.

The base `berry-isles` is the kit's Critter Lob (its rules and CC0 slime) on the terrain world composed as the kit's
Tower Isles example (islands round a ruined tower, a gatehouse and a bridge from the library): the composed island level
the creator played, in the kit's own pieces.

The base `look-yard` is the kit's Soak Squad example with a look target measured from its own sheet framings (no reference art).

The bases `table-four`, `lights-race` and `critter-lob` are the kit's own examples of the same names (examples/minimal),
written for this kit with no upstream code (`critter-lob` here wears the kit's CC0 slime, so it is made the same on any
checkout). `creature-biped/bean-classic.glb` is the kit's own CC0 bean (library pack gf-beans). `objective-standin/crate.glb`
is the kit's own CC0 stand-in crate; `objective-wrong-model/barrel.glb` is KayKit's CC0 dungeon barrel as the library
holds it (each folder's ATTRIBUTION.txt).

The games.fun regressions (research/gf-three/regressions, 88 of them) stay there as history: they are run by games.fun's
`regress.mjs` on its own kit, never from here.
