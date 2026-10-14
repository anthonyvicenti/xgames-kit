# The gamesfun MCP server

`builder/mcp/server.mjs` speaks MCP over stdio. Its tools are the kit's operations; the build loop is driven through them
(AGENTS.md, skill `build-loop`). `node bin/gamesfun.mjs tool --list` lists every tool, and
`node bin/gamesfun.mjs tool <name> '<JSON>'` runs any of them from a terminal with the same arguments and the same
answer, for an agent without MCP.

| Tools | Do |
|---|---|
| the build loop (`builder/mcp/tools/loop.mjs`, `loop-requests.mjs`) | `gamesfun_next` says where a game's build stands and which tool is next; `gamesfun_step_pitch`, `_spec`, `_create`, `_fix`, `_verify`, `_playtest` and `_deliver` each run one step of the loop library (`builder/loop/`) and refuse a call out of order; `gamesfun_ask`, `gamesfun_change`, `gamesfun_rollback`, `gamesfun_keep_edits`, `gamesfun_play`, `gamesfun_playtest_report` (the play-tester's, with its round's token) and `gamesfun_requests` go with them. The `build-loop` skill (generated from the tools) has every tool and its arguments |
| core (`builder/mcp/tools/core.mjs`) | `gamesfun_catalog`, `gamesfun_examples`, `gamesfun_games`, `gamesfun_create`, `gamesfun_verify` (your quick check; `check` for one), `gamesfun_slots_list`, `gamesfun_slots_set`, `gamesfun_dev_status`, `gamesfun_dev_start`, `gamesfun_dev_stop` |
| art, backend, publish (`art.mjs`, `backend.mjs`, `publish.mjs`) | pictures and models from whichever maker the person has; a game's own backend; signing in and publishing to games.fun |
| web3 and economy (`web3.mjs`, `economy.mjs`) | the older shop and token drafts (skill `gamesfun-web3`) and a game's economy (skill `gamesfun-economy`). On by default since 2026-10-12; `GAMESFUN_WEB3=0` in the server's environment hides them |

What every tool carries (MCP 2025-06-18):
- **annotations**: `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`, set per tool from what its
  handler does (`tests/seams.test.mjs` fails a shipped tool without all four);
- **an input schema**, checked with Ajv (JSON Schema draft-07) before the handler runs, on the server and on the
  terminal path alike; a bad argument is refused with the place and the reason (`report.promises[0].pass must be
  boolean or null`);
- **an output schema** where the answer has a stable shape (the loop's step tools, `gamesfun_next`, rollback, play,
  the play-test report, verify, catalog, slots): the answer is then sent as `structuredContent` too, and its text part
  is the same JSON as always.

No tool signs: going live, a token launch and the old shop publish each end at the studio's Economy tab, where the
creator approves in their own wallet. Paths in tool arguments are relative to the kit root, wherever the agent starts
the server from. Requires `npm ci` first.

## Claude Code

Nothing to do: `.mcp.json` at the root declares the server, and Claude Code asks you to approve it the first time you
open the folder. By hand: `claude mcp add gamesfun -- node builder/mcp/server.mjs` (from the kit root).

## Codex

In `~/.codex/config.toml` (use the absolute path of your checkout; on Windows write it with forward slashes or
doubled backslashes):

```toml
[mcp_servers.gamesfun]
command = "node"
args = ["/path/to/xgames-kit/mcp/server.mjs"]
```

## Cursor

In `.cursor/mcp.json` at the root of this folder (or Cursor's global MCP settings):

```json
{
  "mcpServers": {
    "gamesfun": { "command": "node", "args": ["${workspaceFolder}/mcp/server.mjs"] }
  }
}
```

## opencode

In `opencode.json` at the root of this folder:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "gamesfun": { "type": "local", "command": ["node", "builder/mcp/server.mjs"], "enabled": true }
  }
}
```

## Cline and others

Any client that starts a stdio server: command `node`, argument the absolute path of `builder/mcp/server.mjs`.

## Notes

- `gamesfun_verify` takes about 2 minutes with `quick`; clients with a short tool timeout should use the CLI instead
  (`npx gamesfun verify <game> --quick`).
- The server never writes to stdout except the protocol; its logs go to stderr.
- Tools that would spend money or change chain state return a step for the person ("open this link and approve in
  your wallet"); none signs anything.
