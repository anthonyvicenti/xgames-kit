# The bridge: contract (version 1)

The studio page sits in front of the person's own running agent session. This file is what the page (`builder/studio/`),
the tools (`builder/mcp/tools/`) and the plugin (`plugin/`) build against. The code is in `builder/bridge/`; the routes are mounted
by `builder/server/routes/session.mjs` on the dev server (`gamesfun dev`).

Nothing here starts an agent, signs anyone in, stores a token of the person's, or sends a request to a model. The
bridge only receives the session's hook posts and hands the page's requests to a wait that the session keeps.

## 1. Rules for every route

- **Base:** `http://127.0.0.1:<port>/api/session/…` on the dev server. Loopback only.
- **Same origin only.** The dev server's own gate (`builder/server/security.mjs`) refuses another Host, another Origin and
  cross-site fetches. No route sends an `access-control-allow-*` header.
- **The run token.** Every route except `GET /api/session/token` needs the token of this run of the server, in the
  header `x-gamesfun-token: <token>`, or as `?token=<token>` (for `EventSource`, which cannot set a header).
  Without it: `401 {"error":"missing or wrong token"}`. The token is new at every start of the server.
- **Bodies** are JSON (`content-type: application/json`), at most 64 KB. Answers are JSON. Errors are
  `{"error": "<plain sentence>"}` with status 400 (bad body), 401, 404 (unknown id), 409 (wrong state).
- **Times** are milliseconds since 1970 (`Date.now()`).
- **Ids never repeat**, also across restarts of the server: `r_<run>_<n>` for a request, `p_<run>_<n>` for a
  permission, where `<run>` is 8 random hex characters chosen at start.

## 2. For the page

### `GET /api/session/token`

No token needed, but the request must carry `Sec-Fetch-Site: same-origin` (every browser sends it for the page's own
`fetch`; another site's page cannot). → `200`

```json
{ "token": "…", "run": "9f3a1c2e", "contract": 1 }
```

`403` when the header is missing or says anything else.

### `GET /api/session/queue`

Everything the page needs to draw itself, in one read. → `200`

```json
{
  "run": "9f3a1c2e",
  "contract": 1,
  "game": "/abs/path/to/games/my-game",
  "transport": { "id": "claude-hooks", "wait": "rewake",
                 "capabilities": { "wakesIdleSession": true, "deliversMidTurn": true, "approvals": "page-and-terminal", "holdsStop": true, "needsShell": false } },
  "sessions": [ Session ],
  "requests": [ Request ],
  "permissions": [ Permission ],
  "loop": { "status": "building", "step": "verify", "why": "…" }
}
```

`loop` is `null` when the game has no loop state file. `requests` holds every request of this run, oldest first
(at most the last 200); `permissions` the last 50.

**Session**

```json
{
  "id": "0a1b…",                  // the agent's own session id
  "agent": "claude-code",
  "cwd": "/abs/path",
  "state": "working",             // "working" | "idle" | "ended"
  "connected": true,              // a wait is open: a request reaches this session now, even idle
  "primary": true,                // requests with no "session" go to this one (the newest that has not ended)
  "permissionMode": "default",    // the person's own mode, as the last event reported it; null until known
  "started": 1791700000000,
  "lastEvent": "tool-start",
  "lastEventAt": 1791700001000,
  "game": null,                   // the game folder this session last drove with a loop tool; null until it calls one
  "waking": false,                // a wake handed it a request under 20 s ago and its first event has not arrived
  "guard": null,                  // or { "status": "waiting-on-creator", "why": "…", "at": … } (section 6)
  "listening": "plugin",          // which wait is open: "plugin" (the hooks' wait), "listener" (`gamesfun session wait`), null
  "channel": "plugin",            // "plugin" when its hooks report it, "terminal" when only the kit's commands do
  "tools": "mcp"                  // "mcp" (an mcp__…__gamesfun_* call was seen), "cli" (`gamesfun tool`/`session`), null
}

A request with no `session` goes to the newest session that is reachable: one its hooks report, or one with a wait or
a listener open. A session known only from a listener that has closed is not a target; the request waits for the
first session that listens.
```

What the page says from it:
- `state: "idle"` and `connected: false`: "Press Enter in the terminal once to reconnect" (the wait has ended; the
  next turn end starts a new one).
- `state: "idle"`, `connected: false` and `waking: true`: "Waking up with your request" (a rewake wait closes when
  it hands a request over; the session's first event follows).
- `state: "working"` and `connected: false`: normal in the middle of a turn. The request is handed over when the turn
  ends.
- No session at all: "Start your agent in this folder" (with the plugin loaded).
- `permissionMode` other than `"default"`: "Your session's own permission mode (`<mode>`) answers before this page
  does; some actions will never ask here."

**Request**

```json
{
  "id": "r_9f3a1c2e_3",
  "text": "make the enemies faster",
  "selection": null,              // or what the page sent, unchanged (an object, at most 4 KB as JSON)
  "session": "0a1b…",             // null until a session takes it
  "state": "waiting",
  "via": null,                    // how it was handed: "wake" | "stop" | "tool" | null
  "created": 1791700000000,
  "handed": null, "seen": null, "done": null,   // the time of each state, or null
  "note": null,                   // the session's own words when it reported the request done
  "refusals": 0,                  // stops refused because of this request (at most 1, then it stalls)
  "stalled": false                // reminded once and still not acted on: the hook is quiet, the page says so
}
```

States, each from a fact the server has:

| State | Meaning | Becomes |
|---|---|---|
| `waiting` | Not yet with a session (it is busy, or no wait is open). May be edited or removed | `handed`, `dropped` |
| `handed` | The transport gave it to the session. Not proof the model read it | `seen`, `done`, `dropped` |
| `seen` | The session did something after it was handed (a prompt or tool event, or it collected it with the tool) | `done`, `dropped` |
| `done` | The session reported it done through the tool, with `note` | (final) |
| `dropped` | Removed by the person, reported dropped by the session, or the session ended. Offer "send again" |

`stalled` (boolean, on a `handed` or `seen` request): the stop guard reminded the session once and it ended its turn
again without reporting. The hook says nothing more about it (no re-send loop); the page shows "Waiting for your
session" with the one step left (type go in its terminal). The person's next prompt in the terminal brings it back
once (`UserPromptSubmit` answers with it), and the session collecting or reporting it clears it. (final) |

Never show a request as done before `done`.

### `POST /api/session/request`

Body `{ "text": "…", "selection": {…}?, "session": "<id>"? }`. `text` is 1 to 8000 characters. With no `session`
the request goes to the primary session; with no session running it waits for the first one that connects.
→ `200` the Request (`state` is `"waiting"`, or already `"handed"` when a wait was open). `400` on a bad body,
`404` on an unknown `session`.

### `PATCH /api/session/request/<id>`

Body `{ "text": "…"?, "selection": {…}|null? }`. Only while `waiting`. → `200` the Request; `409` in any other state.

### `DELETE /api/session/request/<id>`

Only while `waiting`. → `200` the Request with `state: "dropped"`; `409` in any other state.

### `POST /api/session/permission/<id>`

Body `{ "decision": "allow" | "deny", "message": "…"? }` (`message`, at most 500 characters, is told to the model
on a deny). Only a click of the person may call this. → `200` the Permission; `409` when it is no longer waiting
(answered in the terminal, retired or timed out); `400` on another decision.

**Permission**

```json
{
  "id": "p_9f3a1c2e_1",
  "session": "0a1b…",
  "tool": "Bash",
  "input": { "command": "npm test" },      // the tool's input, long strings cut at 2000 characters
  "state": "waiting",                      // "waiting" | "allow" | "deny" | "retired" | "unanswered"
  "mode": "default",                       // the session's permission mode when it asked
  "created": 1791700000000, "resolved": null
}
```

- `retired`: the session stopped waiting for the page. The person answered in the terminal (the terminal's own dialog
  stays live beside the page), or the next event for that tool arrived, or the turn ended. Remove the card.
- `unanswered`: nobody clicked for 240 seconds; the terminal dialog decides.
- The page offers allow and deny only. There is no "always allow" from the page.
- The page must say: "Your terminal can answer this too, and your session's own permission mode and rules decide
  whether a question is asked at all."

### `GET /api/session/events`

Server-sent events. Token as `?token=`. Resume with the `Last-Event-ID` header (what `EventSource` sends by itself)
or `?after=<seq>`: every later event still held is sent first (the last 500 are held), then live ones. A comment line
(`: hb`) is sent every 25 seconds.

```
id: 41
event: tool-start
data: {"seq":41,"t":1791700001000,"kind":"tool-start","session":"0a1b…","tool":"Edit","input":{…}}
```

Every event has `seq`, `t`, `kind` and (except `hello`) `session`.

| `kind` | More fields | From |
|---|---|---|
| `hello` | `run`, `contract` | first event of every connection (no `id`) |
| `session-start` | `cwd`, `source` (`startup`, `resume`, `clear`, `compact`) | the session started |
| `session-end` | `reason` | the session ended |
| `prompt` | `text` (cut at 2000) | the person, or a wake, gave the session a prompt |
| `tool-start` | `tool`, `input` | a tool call is about to run |
| `tool-end` | `tool`, `ok` (boolean), `denied` (boolean) | it ran, failed or was denied |
| `permission-request` | `permission` (a Permission) | the session is about to ask the person |
| `permission-resolved` | `permission` | any change of a Permission's state |
| `stop` | `allowed` (boolean), `reasons` (array of `"build"`, `"unanswered"`, `"new-requests"`, `"rolled-back"`, `"lock"`), `lastMessage` (cut at 2000) | the turn ended, or its end was refused |
| `request` | `request` (a Request; `session` may be null) | any change of a Request |
| `wait` | `open` (boolean), `form` (`rewake` or `monitor`) | the session's wait opened or closed |
| `guard` | `status` (`waiting-on-creator`), `why` | the stop guard gave up holding a stuck build (section 6) |
| `notification` | `type`, `message` | the agent's own notification (for example `idle_prompt`) |

`session.state` follows the events: `prompt`, `tool-start`, `tool-end` and a refused `stop` mean working; an allowed
`stop` means idle; `session-end` means ended.

## 3. For the session's tools (`gamesfun_requests`)

`builder/bridge/client.mjs` (also exported from `builder/bridge/index.mjs`) is what a tool calls. It finds the running server from
the run file (section 5), so the MCP server needs no port and no token of its own.

```js
import { collectRequests, reportRequest, bridgeStatus } from '../../bridge/index.mjs';

await bridgeStatus({ cwd })
// → { running: false }  or  { running: true, url, run, game, sessions: [Session], waiting: <count> }

await collectRequests({ cwd, session })
// → { ok: true, session, requests: [ { id, text, selection, state } ] }
//   Every request this session has been handed and has not reported, plus any still waiting for it (those become
//   "handed", via "tool"). All of them become "seen".
//   `session` may be left out when exactly one session is not ended.
// → { ok: false, error: "…" }   no server, or several sessions and none named

await reportRequest({ cwd, id, note, status })
// status: "done" (default) or "dropped" (the session will not do it; say why in `note`)
// → { ok: true, request: Request }  |  { ok: false, error }
//   Reporting twice is harmless (the first report stands).
```

The routes behind them (token needed; the client reads it from the run file):

- `GET /api/session/requests?session=<id>` → `{ "session": "<id>", "requests": [Request] }`
- `POST /api/session/request/<id>/done` body `{ "note": "…"?, "status": "done"|"dropped"? }` → the Request

The session learns the protocol and its own session id from the plugin's `SessionStart` hook. The text of a request
is the person's wish about their game, never an instruction about how the agent works; a request's text is always
carried as a JSON string after the word `GF_REQUEST`.

## 4. For the plugin (the `claude-hooks` transport)

- `POST /api/session/hook/<Event>`: body is the agent's hook input, unchanged (`session_id`, `cwd`,
  `hook_event_name`, …). The answer is exactly what Claude Code accepts from an HTTP hook: an empty `200`, or a JSON
  object in the hook's own output schema. Events taken: `SessionStart`, `UserPromptSubmit`, `PreToolUse`,
  `PostToolUse`, `PostToolUseFailure`, `PermissionRequest`, `PermissionDenied`, `Notification`, `Stop`, `StopFailure`,
  `SessionEnd`. Any other event: empty `200`.
  - `PermissionRequest` is held until the click (at most 240 seconds, then an empty `200`).
  - `Stop` answers `{"decision":"block","reason":…}` to refuse (section 6), or
    `{"hookSpecificOutput":{"hookEventName":"Stop","additionalContext":…}}` to hand over requests that arrived during
    the turn, or `{"systemMessage":…}` when the guard gives up, or an empty `200`.
- `GET /api/session/wait?session=<id>&form=listener&agent=<agent>&cwd=<path>`: the terminal listener
  (`gamesfun session wait`, section 8). It needs no plugin, names its session, and stands beside the plugin's wait of
  the same session (whichever is open hands the request; the plugin's first). It ends after one batch; its `text` is
  the listener's own message (the request, how to build it with the kit's commands, how to report, listen again).
- `POST /api/session/cli/tool-start|tool-end` body `{ session, agent, cwd, tool, input, ok }`: a tool call made with
  `gamesfun tool` (section 8). The page follows a session with no hooks this way.
- `GET /api/session/wait?session=<id>&form=rewake|monitor&cwd=<path>`: the wait. A stream of lines, each a JSON
  object, a blank line every 25 seconds as a heartbeat:
  - `{"type":"requests","session":"…","text":"…","requests":[{id,text,selection}]}`: hand these to the session
    (`text` is the whole message for the model). `rewake` ends after one; `monitor` stays open.
  - `{"type":"superseded"}`: a newer wait of the same session took over; end quietly.
  One wait per session: a newer one replaces the older. With `form=monitor` and no `session`, the server binds the
  wait to the newest session with the same `cwd` that has not ended.

The plugin's hooks are command hooks in exec form (`node <script> <Event>`, no shell): each reads the run file and
posts to the routes above with the token. A static HTTP hook cannot be used by default, because its URL is fixed in
the plugin and only an environment variable of the person's own shell can fill a header. A person who starts their
session with `GAMESFUN_BRIDGE_TOKEN` set and a fixed port may point HTTP hooks straight at
`/api/session/hook/<Event>` with the header `x-gamesfun-token: $GAMESFUN_BRIDGE_TOKEN`; the route is the same.

**The write guard** (`plugin/scripts/guard.mjs`, a second `PreToolUse` hook, not async, needs no studio): denies
`Edit`, `Write`, `MultiEdit` and `NotebookEdit` on a path under a `.gf-loop/` folder, and `Bash` or `PowerShell` when
the command names such a path and is not plainly a read. A read is let through (decided 2026-10-11, question 28) only
when the guard can show it is one (`readOnlyShell`): every program in the command is on a short list of programs that
only read (`cat`, `head`, `tail`, `ls`, `grep`, `rg`, `find`, `wc`, `jq`, `sort`, `diff`, `stat`, `cd`, `echo`, `test`;
`Get-Content`, `Get-ChildItem`, `Select-String`, `Test-Path`, `ConvertFrom-Json`, `Select-Object` and a few more),
joined only by `|`, `&&`, `||`, `;` or a new line, with no redirect except to `/dev/null` or `2>&1`, no variable, no
command substitution, no bracket or brace outside quotes, no escaped quote, and none of the flags that make a reader
write or run something (`find -exec`/`-delete`/`-fprint`, `sort -o` or any long option, `rg --pre`, `uniq` with two
files). `sed`, `awk`, `tee`, `xargs`, `node`, `python`, `git`, `less` and PowerShell's `ForEach-Object` and
`Where-Object` are not on the list. Everything else that names the folder is refused with the reason it was not
plainly a read. The reason names `gamesfun_ask` and the `Read` tool. The play-tester
subagent (`agent_type` `playtester`) may write only `job/playtest/out/` and `job/playtest/runs/`. It refuses `Edit` and
`Write` on a game's own `spec.json` while that game's run is building with its spec locked (not through a shell
command). It also refuses an
edit inside a game the person has just rolled back, until `gamesfun_next` has been called. The answer is
`{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":…}}`
with exit 0 (hooks documentation read 2026-10-11). It cannot stop a command that builds the path when it runs (a
variable, a glob, a script file), another MCP server's file tool, or anything outside the session; for those the
loop library's lock stands, held in the MCP server's memory. `tests/guard.test.mjs` has both lists.

## 5. Files

| File | Written by | Read by | Holds |
|---|---|---|---|
| `<kit>/.gamesfun/bridge.json` (git-ignored) | the dev server, at start and stop | the plugin's scripts, `builder/bridge/client.mjs`, `doctor` | `{ "schema": "gf-bridge/1", "runs": [ { "url", "token", "run", "pid", "game", "wait", "started" } ] }`, one entry per running dev server |
| `<kit>/.gamesfun/bridge-config.json` | `setWaitForm()` (what `doctor` calls) | the dev server at start | `{ "wait": "rewake" \| "monitor" }` |
| `<game>/.gf-loop/state.json` (schema `gf-loop/1`) | the loop library only, through the loop tools | `builder/bridge/loop-state.mjs` (`readLoopState`, one function) | `status`: `building` \| `waiting-on-creator` \| `delivered` \| `failed` \| `cancelled`; `step`; `why` |
| `<game>/.gf-loop/cancel.json` (schema `gf-cancel/1`) | the dev server's roll-back route (`builder/lib/cancel.mjs`), when the person rolls back a run that is under way | the loop tools (they end the run with the library's `loop.cancel` at their next call and remove the file); `builder/bridge/loop-state.mjs` (`readCancel`) | `reason`, `checkpoint`, `label`, `at`. While it is there, a `building` state is read as `cancelled` |

A script finds its run by looking for `.gamesfun/bridge.json` in, in order: the file named by
`GAMESFUN_BRIDGE_FILE`; the session's working directory and each folder above it; the project folder
(`CLAUDE_PROJECT_DIR`) and above; the script's own folder and above. Among the runs whose process is alive it takes
the one whose `game` is the working directory, inside it or above it, else the newest.

The token in the run file is the bridge's own, good for one run of a loopback server. It is not a credential of the
person's and gives no access to their agent or account.

## 6. The stop guard

Asked at every turn end of a session. It refuses the stop (the agent continues with the reason as its next
instruction) in two cases, both bounded:

1. **The build is not finished.** The game's loop state says `status: "building"`. Only `building` holds a session:
   `waiting-on-creator`, `delivered`, `failed` and no file all let it stop. The reason names `step` and `why`.
   At most 3 refusals while the loop state does not change (any change of `step`, `round` or `updated` starts the
   count again). After the third, the bridge stops holding: it marks the session `guard:
   {"status":"waiting-on-creator","why":…}`, sends the `guard` event, tells the person in the terminal
   (`systemMessage`) and lets the session stop until the loop state changes. The bridge never writes the loop state.
   **Which game, which session.** The game that decides is the one the session drives: the bridge notes the `game`
   argument of every loop tool call it sees (`mcp__…__gamesfun_step_*`, `_next`, `_change`, `_ask`, `_rollback`), so
   a session building another game than the studio shows is held by that game's state. A session that has called no
   loop tool is judged by the studio's game. When the state file carries a `session` field, only that session is
   held (the library has no such field today, and an MCP server is not told its session's id); else the sessions that
   drive the game, when any does; else every session whose working directory is the game folder, inside it or above it.
   **While the play-tester subagent has the round** (the state's `step` is `playtest` and `handed.step` is `playtest`):
   one refusal, which tells the session to wait for the report if the subagent is playing and to start it if it is
   not; later stops for the same state are let through with no notice to the person, because an agent may run the
   subagent in the background and end its turn to wait, and the report wakes it. Once the report is there (`out/playtest.json`,
   written after the hand-over) the round is the session's again and the build holds it as usual.
   **While one of our own tools is running on the game** (the MCP server marks each call in
   `<game>/.gf-loop/running/`; `builder/bridge/loop-state.mjs` `readRunning`): the turn end is a wait for that tool's result,
   which wakes the session. Nothing is refused and nothing is counted, for the build or for a request.
   **A roll-back from the page cancels a run that is under way** (the reasons are in `builder/mcp/tools/loop.mjs`,
   `applyCancel`): the dev server cannot write the loop's state, so it leaves `cancel.json`; from that moment the
   build holds nobody. The session is told once, with one refused stop (`reasons: ["rolled-back"]`): the run is
   cancelled, do not put the undone changes back, call `gamesfun_next` (which ends the run in the state file and puts
   back anything written since the roll-back). The plugin's write guard also refuses an edit of that game until then.
   **The locked spec** (the loop library's lock; `builder/bridge/loop-state.mjs` `readLock` calls the library's
   `lockProblems(state.lock, lockFiles({job, game}))` and reads `state.refusals`). A session of this game is held,
   with `reasons: ["lock"]`: while a locked spec file is edited on the disk and the run is building (at most 2
   refusals for one edit, then the person is told in the terminal; the loop puts the file back at its next step
   either way); and once for each refusal on the loop's record that no round's message has told the session yet
   (`spec-changed`, `state-changed`, `lock-changed`, `promises-shrunk`, `no-repair`, `brief-changed`).
2. **A request is unanswered.** A request this session was handed and has not reported. One refusal for each
   request (a reminder); then it is `stalled` and the hook is quiet about it, never dropped for it (2026-10-12: the
   same request re-sent three times got the same answer three times). A request the wait handed over less than 3 seconds ago does not refuse
   the stop: its wake is already bringing it.

Requests that arrived while the session was busy are handed over at the same moment, in the same answer (state
`handed`, via `"stop"`), so they do not wait for the next wake.

While the build holds a session (case 1 is refusing), an open request is named in the reason and not counted: the
session finishes the build first, and the request is not dropped for it. The session's `gamesfun_requests` tool
refuses a "done" report while the game's run is not delivered.

Claude Code itself ends a turn after eight refused stops in a row; the bounds above keep the bridge under that.

## 7. Transports

One interface (`builder/bridge/transport.mjs`), one built implementation.

| | `claude-hooks` (built) | `codex-hooks` (not built) | `claude-channel` (not built; only with `GAMESFUN_BRIDGE_CHANNEL=1`) |
|---|---|---|---|
| Page to session | the wait: an `asyncRewake` command hook on `SessionStart` and `Stop` (default), or the plugin's monitor (fallback) | a `Stop` command hook that returns the request as its reason. **No wake of an idle session**: "If no turn is active, Codex waits until the next user turn" | a channel notification with the request id in `meta` |
| Session to page | command hooks post each event | command hooks post each event (Codex has no HTTP hooks) | the same hooks (a channel carries no tool events) |
| Approvals | `PermissionRequest` hook, held for the click | `PermissionRequest` hook; allow or deny only (`updatedInput`, `updatedPermissions` and `interrupt` fail closed) | the channel's permission relay |
| Stop guard | `Stop` hook, `decision: "block"` | `Stop` hook, `decision: "block"` (continues with the reason as a new prompt) | the same `Stop` hook (a channel has none) |
| Report | the tool `gamesfun_requests` | the same tool | the same tool (a channel's notifications are not acknowledged) |

### The three systems, for each mechanism of `claude-hooks`

| Mechanism | Needs a shell | Windows | macOS | Linux |
|---|---|---|---|---|
| Event, approval and stop hooks (`node hook.mjs <Event>`, exec form) | no | `node.exe` on `PATH`; no Git Bash needed | `node` on `PATH` | `node` on `PATH` |
| The wait, default (`asyncRewake` command hook, exec form) | no | the same | the same | the same |
| The wait, fallback (plugin monitor) | yes ("The command runs in a shell") | only with Git Bash installed | yes | yes |
| The run file (`.gamesfun/bridge.json`, written then renamed) | no | rename falls back to a plain write when the file is held open | atomic rename | atomic rename |
| The local server | no | binds `127.0.0.1` | the same | the same |

## 8. With no plugin and no MCP tools: the terminal

A session that ran the one line has neither the plugin's hooks nor the kit's MCP tools loaded until a reload, and it
must not need them (a first run once built nothing). Three commands cover it, in `bin/gamesfun.mjs`:

| Command | What it does |
|---|---|
| `session wait` | The listener (`form=listener`). Run in the background. Ends with the request when the page sends one; an agent that is woken when a background command ends (Claude Code) wakes. Codex does not start a turn for it, so the page tells the person to type go in Codex. The session id is `CLAUDE_CODE_SESSION_ID` (the id the hooks send), else `GAMESFUN_SESSION`, else one per kit folder. |
| `tool <name> '<json>'` | Any MCP tool, run once: the same handler, input check, running mark and answer. It posts `cli/tool-start` and `cli/tool-end`. The loop's in-memory copy of its state lasts one call, as across an MCP server restart. |
| `session report <id> "<note>"` | `gamesfun_requests` with `done`, including its refusal while the build is not delivered; `--dropped "<why>"` declines. `session requests` collects, `session status` shows what the studio sees. |

Every message a session gets (the protocol words, a request, a reminder, the listener's message) says the terminal is
a full substitute for the tools, unless the session was seen using the MCP tools.
