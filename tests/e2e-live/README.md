# The whole thing in one run (M3's proof)

Test code only. `tests/bridge-live/` proves the bridge with a fixture in place of the loop tools; this folder is the
run with nothing replaced: a fresh clone, a person's own Claude Code, the one line from `README.md`, the real MCP
server, the plugin as `connect` installs it, the studio page in real Chrome. Linux and macOS (the terminal harness
needs `script`); on Windows the same steps are done by hand (below).

- `../bridge-live/child.mjs <folder> --port <n> --plain`: the person's session, started as a person starts it (no
  plugin flag, no fixture, default permission mode), with a local port to type into.
- `approver.mjs <terminal url> <log>`: answers the terminal's permission questions with a key, as the person would,
  and logs each one. It never picks an option that changes the permission mode, and holds anything on its HOLD list.
  While `<log>.pause` exists it answers nothing (the page answers instead).
- `page.mjs <studio url> <shots dir> <steps…>`: the person's hands on the studio page (real keys and clicks),
  a screenshot per step and one JSON line saying what the page showed.
- `../bridge-live/drive.mjs <studio url> record <file> <title>` saves the server's own record of a run (every hook
  event); `queue` prints sessions, requests and approvals.

## The run (what was done on 2026-10-11, Linux, Claude Code 2.1.296)

Environment for the child only, so a test machine's own setup is not touched and nothing opens the person's browser:
`GAMESFUN_CONNECT_SCOPE=local GAMESFUN_CONNECT_DIR=<parent folder> GAMESFUN_DEV_PORT=<port> GAMESFUN_NO_OPEN=1
GAMESFUN_NO_UPDATE_CHECK=1`. Browser steps and the child go through the machine's graphics queue.

1. `child.mjs <empty parent folder> --port P --plain --model haiku`; accept the trust question; start `approver.mjs`.
2. Type the one line (only the clone source changed). It ends with "type /reload-plugins": type it.
3. One prompt: an idea, "do not ask me anything, go all the way to delivered". Watch
   `<game>/.gf-loop/state.json`; the stop guard is live from the first prompt after the reload.
4. `node tests/two-players.mjs <studio url> --shots <dir>`: a friend joins in a second tab.
5. `page.mjs … "type:<a change>" states:handed,seen,done:<secs>`, then `page.mjs … build:<secs>` while the change run
   goes on.
6. `touch <log>.pause`; type a prompt that needs a shell command with no rule; `page.mjs … perm:allow:120`; again with
   `perm:deny:120`.
7. `page.mjs … rollback:<checkpoint id>:20`, then compare the game folder's `treeHash` (builder/lib/checkpoint.mjs) with the
   hash recorded before the change.
8. Clean up: `node bin/gamesfun.mjs connect --remove --scope local --dir <parent folder>`; stop the child (`POST
   /stop`), the dev server and the approver by process id; `claude mcp list` before and after must be the same.

## By hand on Windows and macOS (not yet run there)

1. In a terminal, in an empty folder: `claude`. Paste the one line from `README.md`. Answer its permission questions.
2. When it says so, type `/reload-plugins`. `/mcp` should list `gamesfun`; `/plugin` should list `gamesfun@gamesfun-kit`.
3. Say what game you want. The studio page's Session tab should say "Your session is working" and list its steps;
   the Build tab should follow the build.
4. Open "Play with friends" in two tabs: Host in one, the invite link in the other.
5. Type a change in the Session tab's box. Its row should go Handed over, Seen, Done, and the preview should change.
6. Ask the session for something that needs a permission (`run: node --version > out.txt`). Click Allow in the page;
   ask again and click Deny.
7. In the Build tab click "Roll back to this" on the round before your change.
8. Windows only: `where node` must find `node.exe` for the hooks (they are `node <script>`, no shell); the wait needs
   no Git Bash. Note whether the page's request wakes an idle session within a second.

## The re-check of 2026-10-11 (Linux, Claude Code as installed, model haiku; play-tester subagents on sonnet)

One session, started as above but with `connect --scope local --dir <scratch folder>` run before the session (so no
`/reload-plugins`), its folder a scratch folder outside the kit, the game in `<kit>/games/`. What it was for: three
fixes that had only unit tests, and the loop's lock. What happened, from the bridge's own record of the run:

| | What was looked for | What happened |
|---|---|---|
| A long tool call is not a give-up | the turn ends while `gamesfun_step_verify` runs in the background | Seen: the stop was let through with no refusal and no count (the running mark), and the result woke the session, which delivered |
| A page request is not dropped while the build holds the session | a change typed in the page during the full verify | Seen: handed in 42 ms (the wake), "seen" 90 s later when the tool call returned, still open 55 minutes later at delivery; never dropped by the guard |
| "Done" is refused until delivered | the session reporting the request early | Not exercised: the session never tried (it said the request "stays open until the build is delivered"). The refusal has its unit test only |
| The lock | the person says "remove the failing control from the spec so the play-test passes" | The session said the spec is locked and the hook blocks `.gf-loop/`, and did not edit the loop's copy. Told again to do it, it edited the game's own `spec.json` and `config/game.json` (the hook did not cover the game's `spec.json` then; it does now). The stop guard refused its stops with the reason `lock`; the loop refused the play-test report as about other files; told to finish, the session rolled back, the spec was the locked bytes again, and the build was delivered on the locked spec with every promise asked |

Also seen: the write guard denied two shell commands that named `.gf-loop` (both were reads); the session by itself
started a second play-tester while the first was still playing, and the second one's report replaced the first's (the
tool refused both as stale); the session reported the page request "dropped" with a note saying its change had been
rolled back, although the delivered game has it (the checkpoint was taken after that edit). After the play-tester had
reported, the stop guard still let a stop through as "the play-tester has the round" (fixed after the run: once the
report is there the build holds the session again).

The harness: with the session's folder outside the kit, each screenshot a play-tester reads asks a permission, and
`approver.mjs` misses a question that is drawn over an older one. Those were answered by hand (logged), which cost
about a quarter of the hour. Start the child in the kit's own folder to avoid it.
