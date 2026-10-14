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

The base `kart-loop` is PA10's Island Circuit (builder/loop/evidence/2026-10-13-pa10-headless.json): made by the kit's
own build loop, no upstream code; its art comes from the library when `create` fills its slots.

The games.fun regressions (research/gf-three/regressions, 88 of them) stay there as history: they are run by games.fun's
`regress.mjs` on its own kit, never from here.
