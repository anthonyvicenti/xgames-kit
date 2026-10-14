# The bridge, proven in a real session

Test code only. `tests/bridge.test.mjs` proves the bridge with no model. This folder proves it with a person's own
Claude Code: the studio (`gamesfun dev`), a child session with `plugin/` loaded, and small steps typed and posted.

- `child.mjs`: starts your own interactive `claude` in a scratch folder (cheap model, default permission mode, only
  the scratch project's settings) and lets a script type into it. Linux and macOS only (it uses `script`).
- `mcp-fixture.mjs`: a stand-in for the loop tools: `gamesfun_requests` (calls `builder/bridge/client.mjs`, as the real tool
  does) and `gamesfun_next` (marks the scratch game delivered).
- `drive.mjs`: post a request as the page does, follow it, answer an approval, set the scratch game's loop state,
  save the server's record of a run.
- The records of the runs are in `builder/bridge/runs/`.

## By hand, on Windows and macOS (not yet run there)

No harness is needed: use two terminals and a browser.

1. `node bin/gamesfun.mjs create games/try --from soak-squad`, then `node bin/gamesfun.mjs dev games/try`.
2. In the kit folder, in another terminal: `node bin/gamesfun.mjs connect`, then `claude` (accept the trust
   question). (`claude --plugin-dir plugin` loads the plugin for one session without installing it.)
   `node bin/gamesfun.mjs doctor --skip-graphics` should now say the bridge has 1 session with the wait open.
3. With the session idle, send a request (the studio's Session tab, or
   `node tests/bridge-live/drive.mjs http://127.0.0.1:5180 request "make the title bigger"`): the terminal should wake
   within a second with a `GF_REQUEST` line.
4. Ask the session for a shell command it has no rule for: the approval shows in `drive.mjs … queue`; answer it with
   `drive.mjs … permission allow` and again with `deny`.
5. `drive.mjs … loop building games/try`, then type `Say only: finished.`: the stop is refused with the next step.
6. Windows only: repeat step 3 in a terminal with no Git Bash on `PATH` (the default wait needs no shell), then
   `node bin/gamesfun.mjs doctor --bridge-wait monitor`, restart `dev`, and see whether the monitor starts at all.
