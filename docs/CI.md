# CI: what runs on a GitHub runner, and what cannot

The workflow (`.github/workflows/check.yml`) runs on GitHub's Linux, Windows and macOS runners. This page says what a
runner is, what the CI profile leaves out and why, what a run costs, the faults the first runs on each system found and
how they were fixed, and what a person on a real Windows machine or a Mac still has to try by hand (section 8).

## 1. What the runners are

Read from the workflow's "Runner facts" step and each gate record's `graphics` (October 2026):

| Runner | Processors | Memory | Chrome | WebGL is drawn by |
|---|---|---|---|---|
| `ubuntu-latest` | 2 (AMD EPYC or Intel Xeon) | 7.8 GB | 154.0.8037.97 | SwiftShader, on the processor |
| `windows-latest` | 2 (AMD EPYC) | 8.0 GB | 154.0.8037.58 | SwiftShader, on the processor |
| `macos-latest` | 3 (Apple M1, virtual) | 7.0 GB | 152.0.7977.83 | "Apple Paravirtual device" through Metal: a virtual graphics card |

So Linux and Windows have no graphics card, and macOS has a virtual one. All three images carry Google Chrome; the
workflow names its path per system (`CHROME_PATH`). The workflow sets `GF_VERIFY_SOFTWARE=1`, which makes verify and
the multiplayer gate launch Chrome without graphics flags.

A page that draws a game on two processors with no graphics card renders at one or two frames a second (measured
under SwiftShader: about 1.6), so a round, which the checks wait for with timeouts of 60 s and less, never reaches play.
A click can take 30 seconds to be answered (section 7, fault 4). That is why the profile (section 3) runs only the
checks that do not play a round.


## 2. Scenic games

Read from the kit's tools (`builder/tools/lib/paths.mjs`, `launchForGame`; `builder/qa/browser.mjs`):

- A scenic game draws with three's `WebGPURenderer`. Verify normally launches Chrome's headless shell with Vulkan flags
  and requires a **hardware** WebGPU adapter; SwiftShader's fallback adapter counts as none (`NoWebGPUError`).
- On a runner there is no adapter, so `launchForGame` falls back to WebGL2 inside `WebGPURenderer` and notes it. With
  `GF_VERIFY_SOFTWARE=1` it skips the WebGPU probe and launches plain Chrome (no WebGPU, so the same WebGL2 backend),
  on SwiftShader.
- The headless shell the probe wants comes from `npx playwright install chromium-headless-shell`, which a runner does
  not have. If the shell is missing and software mode is off, `launchChrome` throws something other than
  `NoWebGPUError` and the fallback does not trigger. The profile sets software mode, so it avoids that path.
- A look judged from a software frame is meaningless: scenic CI checks behaviour, never looks.

The workflow's `scenic` job creates `isle-run` and runs the same profile as the party job. Measured below (section 3):
the scenic game's lobby legs pass under software rendering just as the party game's do.

### Vista games are not in CI

A vista game (engine `vista`, the example `lantern-cove`) draws only with WebGPU: its core has no WebGL path, and it
needs an adapter with at least 31 sampled and 5 storage textures per shader stage (`runtimes/vista/kit/gpu.js`).
The kit's verify refuses to run it without a hardware adapter ("cannot be verified on this machine"), and a runner has
none, so neither job creates one. What CI does hold for vista runs without a browser, in `npm test`: its
licences and files (`tests/layers.test.mjs`), the example's rules (`tests/examples.test.mjs`)
and the catalog lines. Its verify (17 checks, 14 more "not yet for vista") runs by hand on a machine with a graphics
card: `npx gamesfun create games/cove --from lantern-cove`, then `npx gamesfun verify games/cove
--release`.

### Forge games are not in CI either

The forge engine has no example yet (its free stand-in art is still to be made). Its verify runs on WebGPU only
(`rendererFor('forge')` in `builder/tools/lib/paths.mjs`: without an adapter it says "cannot be verified on this machine"), and
a runner has no adapter, so no job will create one. In `npm test`, without a browser: its files and
licences, both prebuilt builds against the sha256 `BUILD.json` pins (`tests/layers.test.mjs`),
and the catalog lines (`tests/forge.test.mjs`).

## 3. The CI profile: `ci-software`

`.github/ci-profile.json` is the file `gamesfun verify --quick --profile .github/ci-profile.json` reads (the kit's
`verify.mjs`; the shape is held by `checkProfile` in `tools/lib/verdict.mjs`, and `tests/ci.test.mjs` checks the file
against it). It sets `GF_VERIFY_SOFTWARE=1` before any browser starts and lists the checks left out, each with its
reason. Everything else a build's verify runs, runs. A skipped check is recorded in `verdict.json` as skipped with its
reason, never as passed; the verdict carries `profile` and `profilePass`, `pass` stays false, and the command prints
`PROFILE ci-software OK (not a full pass)` and exits 0 when everything that ran passed. `"legs": "lobby"` on check 5
runs the gate's lobby legs only (room, WebRTC, both games in the room) and records the check as skipped.

Measured on SwiftShader on two processors (`taskset -c 0-1`): `create` 1 s, then the profile's verify 7 s for the party
game and 9 s for the scenic one, PROFILE OK.

Skipped, with the reason written in the profile: 3 boots to play, 4 slot coverage, 5 in-round and loadout legs, 6 a round
to results, 7 audio of the solo round, 10 fair play, 12 something happens, 13 controls, 15 the loop is alive, 16 hits,
20 the menu, 21 the HUD, 22 the wallet in the menu, 24 plays inside a post, 25 friends. They all play a running game, and
a software-rendered page draws about 1.6 frames a second. 8, 31 and 34 are release-only and not in `--quick`.

### Stepped time does not bring 13 or 16 inside five minutes

With stepped time (`?gf-step=1`, `kit/core/step.js`) checks 10, 13, 16 and 35 count in the game's own time. Tried alone
under the same software rendering with a 300 s limit, each twice:

| Check | Party (`soak-squad`) | Scenic (`isle-run`) |
|---|---|---|
| 13 controls work | 2 of 2 not finished in 300 s: jump and interact pass, the run step is cut off (the page is closed by the limit) | 2 of 2 not finished in 300 s |
| 16 hits read | passes in 1 s, both times, because the game has no weapon (not applicable): proves nothing | 2 of 2 not finished in 300 s: 0 swings reached an enemy |

So neither goes in the profile. Stepped time moves the game's clock; the page still draws at a few frames a second, and
the checks wait for frames.

## 4. What the workflow runs

Two jobs, `party` and `scenic`, each able to run on Linux, Windows and macOS. Pushes to `main`, pull requests and runs
by hand all run **Linux only**; Windows and macOS run only when a run by hand asks for them (section 5
says why):

```bash
gh workflow run check.yml --ref <branch>                               # every job, Linux only (the default)
gh workflow run check.yml --ref <branch> -f system=windows -f job=scenic
gh workflow run check.yml --ref <branch> -f system=linux-windows       # everything but macOS
gh workflow run check.yml --ref <branch> -f system=all                 # every job on every system (about 53 plan minutes)
```

`system` is `linux` (the default), `windows`, `macos`, `linux-windows` or `all`; `job` is `all`, `party` or `scenic`.
Runs started by hand never cancel each other; a newer push cancels the run of an older one.

What each system runs, the same on all three:

| Step | party job | scenic job |
|---|---|---|
| `npm ci`, runner facts (processors, memory, Chrome's version) | yes | yes |
| `npm test` (the smoke test skips on every system) | yes | no |
| `sync-skills --check`, `doctor --skip-graphics`, `examples`, `catalog --all` | yes | no |
| `create` from the example | `soak-squad`, then `giant-four` (the turn-based board game) | `isle-run` |
| `verify --quick --profile .github/ci-profile.json` | yes, once for each of the two games | yes |
| the evidence uploaded (`verdict.json`, the gate's `record.json` and its picture) | yes | yes |

Inside verify, on every system and for both games:

- **Run and passed:** 1 manifests, 2 kit copies unedited, 11 set dressing, 14 looks honoured, 17 the world is complete,
  18 sounds play, 19 bodies hold their shape, and check 5's lobby legs (the gate's `record.json`: manifest valid, kit
  identical, entry exists, solo untouched, shell boots, host opens a room, a joiner joins over WebRTC, no kit errors;
  8 of 8).
- **Run, with nothing to check in these two examples:** 23 looks like the references (the examples list no style
  references) and 35 the game's own tests (the examples carry none). Both report that, and count as passed.
- **Skipped by the profile, each recorded as skipped with its reason:** 3, 4, 5 (the in-round legs and the loadout leg),
  6, 10, 12, 13, 15, 16, 25, 38, 39. They all play a running game.
- **Skipped by `--quick`:** 9 the contact sheet and perf. 7, 8, 20–22, 24, 31 and 34 are release-only: they test the
  kit, not the game (`builder/GATES.md`).

The verdict is never a full pass: it prints `PROFILE ci-software OK (not a full pass)` and exits 0 when everything
that ran passed. No step is `continue-on-error` (`tests/ci.test.mjs` holds that); a check that cannot run on a runner
leaves the profile by name, with its reason.

What the lobby legs do not cover on Linux and Windows: the lobby's backdrop (the game's world behind the waiting room).
The kit leaves it out on a machine that draws on its processor (section 7, fault 4), so there the legs run without
it. On macOS, with its virtual card, the backdrop is drawn and the legs pass with it.

`tests/layers.test.mjs` (inside `npm test`) holds the kits a game vendors to their recorded hashes on every system
(`kit.json`, `SHA256SUMS`, forge's `BUILD.json`); `.gitattributes` keeps the kit's layers free of line-ending
conversion (the old `tests/kits.test.mjs` passed on Windows from the first run with the same rule on `kits/`).
The workflow is checked with `npx @action-validator/cli .github/workflows/check.yml`.

## 5. Cost of a run

Rates, from GitHub's docs "Actions runner pricing" (read 2026-10-10): Linux $0.006 a minute, Windows 2-core $0.010,
macOS $0.062. The included-minutes multipliers are Linux 1, Windows 2, macOS 10. Each job rounds up to a whole minute.

Job wall time in the green runs:

| Job | Linux | Windows | macOS |
|---|---|---|---|
| party | 75 to 101 s | 160 to 189 s | 66 to 107 s |
| scenic | 46 s | 65 to 68 s | 62 to 65 s |
| verify alone, party / scenic | 15 to 18 s / 28 to 30 s | 19 to 21 s / 26 to 31 s | 17 s / 41 s |

| One run of everything | Job minutes (rounded up per job) | Plan minutes |
|---|---|---|
| Linux | 3 | 3 |
| Windows | 5 | 10 |
| macOS | 4 | 40 |
| **All three** | 12 | **about 53** (about $0.32 at the rates) |

On the Free plan (2000 minutes a month) that is about 37 full runs. The numbers above are computed from the jobs' start
and end times, not read from a bill.

**Keep runs on Linux.** The included minutes go fast when every run takes all three systems: macOS is ten times a Linux
minute and Windows twice. So every automatic run, and every run by hand without `-f system=`, is Linux only (about 6
plan minutes a run as billed, against about 53 for all three). Windows and macOS are for a change that touches them,
asked for by name.

## 6. What a runner still cannot check

- **Anything that plays a round** on Linux and Windows: a page that draws a game on two processors gives 1 to 2 frames
  a second. Stepped time moves the game's clock, not the drawing (section 3).
- **Looks.** A frame from SwiftShader or from a virtual card says nothing about how a game looks.
- **WebGPU.** No runner has a hardware WebGPU adapter; the scenic game runs on WebGL2 inside `WebGPURenderer`. The
  WebGPU path of the scenic engine has been run by hand on Linux with a desktop GPU only. A vista game cannot run on a
  runner at all, and verify does not run a forge game there (section 2).
- **macOS could run more than the profile lets it** (it has a virtual card and three processors). Which of the skipped
  checks hold there was not tried; each try costs ten times a Linux minute.
- **The network between two machines.** The gate's two players are two pages of one Chrome on one machine.

## 7. The first runs on three systems: each fault, its cause, its fix

The first run on Windows and macOS failed five of six jobs: both Windows jobs, both Linux jobs, and
the macOS scenic job, which showed green only because its verify step was `continue-on-error`.

| # | System | What was seen | Cause | Fix, and where |
|---|---|---|---|---|
| 1 | Windows | `npm test`: `one-line.test.mjs` read `'1\r\n'` where it wrote `'1\n'` | The test's own little repository had no `.gitattributes`, and Git for Windows checks text out with CRLF (`core.autocrlf=true`). The kit's repository has the line; a real clone is not affected | The fixture carries the kit's `* text=auto eol=lf` line. `tests/one-line.test.mjs` |
| 2 | Windows | `npm test`: `web3-routes.test.mjs`, `write ECANCELED` on an upload the server refuses | The server answers 413 and closes while the body is still being written. The helper already took `ECONNRESET` and `EPIPE` as that refusal; Windows reports `ECANCELED` (or `ECONNABORTED`) | The helper knows the two Windows codes. `tests/web3/helpers.mjs` |
| 3 | Windows | `create --from isle-run`: "world/world.js does not import (Cannot find module …\\gf-scenic\\three\\core\\util.js" | The tools map `gf-scenic/three/…` to the shared kit when a module is read in Node, and decided "is this file under that folder" with `startsWith(folder + '/')`, never true for a Windows path. Every scenic `create` failed on Windows | `below(base, file)` in `tools/lib/paths.mjs`, by the system's own path rules, tested for Windows from any system; used by `kit-import.mjs` and `likeness-check.mjs` |
| 4 | Linux, Windows (both engines) | Check 5's lobby legs: "timed out waiting for both players in the room", or the joiner "Could not connect to the host", after 2 to 5 minutes; on Windows a click on Host or Join timed out after 30 s | The lobby shows the game's own world behind the waiting room, drawn by the host's page and by the friend's. On two processors with no graphics card that took the whole machine: pages stopped answering and the join ran into the kit's 20 s limit. Reproduced on Linux with SwiftShader on two processors: with the backdrop the join never completed, without it it took 1.6 s. It would do the same to a player on such a machine | The kit leaves the backdrop out on a machine that draws on its processor (`kit/core/quality.js` `drawsOnCard`, asked before anything is loaded; the seat colours still reach the lobby). Two questions, because headless Chrome on Linux grants a `failIfMajorPerformanceCaveat` context that Chrome on Windows refuses: the context, then the renderer's name |
| 5 | Linux (local) | The same steps had passed on the maintainer's machine "under software rendering" in 7 s | Three things. The gate did not read `GF_VERIFY_SOFTWARE` and launched Chrome with the graphics-card flags; on that machine those flags gave no WebGL at all, so the backdrop drew nothing; and the machine has 24 processors. Not a different Chrome, a timeout or the network | The gate launches plain Chrome under `GF_VERIFY_SOFTWARE` and records what drew (`record.json` → `renderer`, `graphics`). A join that fails now says where both pages stood, the WebRTC states in order, and a timeline of seconds per check |
| 6 | macOS (both engines; the party job passed once and failed twice) | The lobby legs: the joiner "Could not connect to the host" after 20 s, on pages that answered at once | Not the adapters' routing: the connection never got that far. Every signaling message was delivered (6 relayed), and both connections stayed in the state "new". The gate's probe showed the only WebRTC candidate is a host candidate behind an mDNS name (`<uuid>.local`), which that machine does not look up (two connections in one page: not connected in 8 s); with real addresses in the candidates the same two connected in 0.1 s. (`record.json` → `webrtc`) | QA Chrome that plays two players on one machine launches with `WebRtcHideLocalIpsWithMdns` off (`builder/qa/browser.mjs` `LOCAL_WEBRTC_OFF`), in one `--disable-features` switch together with Playwright's own list, because Chrome keeps only the last such switch. The gate and `launchForGame` use it. After a failed join the gate runs the probe with and without it |

After the fixes every job was green on every system.

**Fault 7, open (it is in the multiplayer kit).** Once in a few Linux runs of the party game's lobby legs, the two pages were
connected and nothing moved after that: the friend's page stayed on "Connected. Waiting for the host…" with its channel
open, and the host never answered the friend's first message on the data channel. It is not fault 4 (no backdrop is
drawn on that runner) and not fault 6 (the connection opened). It has been reported upstream; until it is found, a red
`party` job with exactly this line is run again before anything else is suspected.

## 8. What a person on a real Windows machine or a Mac still has to try by hand

A runner is a virtual machine without a real graphics card, and it ran the profile only. None of this has been done on
a person's machine:

1. **A full `gamesfun verify` (no profile) of a party game** on Windows and on a Mac with a real graphics card: every
   check that plays a round (3, 4, 5 in full, 6, 7, 10, 12, 13, 15, 16, 20 to 22, 24, 25).
2. **A scenic game on WebGPU**: Direct3D 12 on Windows, Metal on a Mac. `builder/qa/browser.mjs` `gpuLaunchPlan` marks both
   rows `measured: false`.
3. **Two players on one Mac**, in `gamesfun dev` and in verify's check 25: the flag of fault 6 is passed by the QA
   browser, not by a person's own Chrome. Two tabs of a person's Chrome on one Mac depend on mDNS lookups (macOS asks
   for the Local Network permission); two friends on two machines do not.
4. **The lobby with its backdrop on a real card** on Windows and on a Mac, and the lobby without it on a machine that
   has none (a remote desktop, a virtual machine): the waiting room should stand on the page's own background.
5. **`npx gamesfun` from a fresh clone** in PowerShell and in Terminal: `create`, `dev`, the Studio page, `doctor` with
   its graphics probe (the runners ran `--skip-graphics`).
6. **A path with a space or a non-ASCII letter** (`C:\Users\José\My Games`), and a clone with `core.autocrlf=true` on
   Windows: `npm test` held on the runner's `D:\a\…` path only.
7. **Chrome installed per user, Edge only, or no Chrome** (Playwright's Chromium is then downloaded): the runners
   carry Chrome in the usual place.
