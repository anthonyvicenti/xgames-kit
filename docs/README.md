# The docs

For people who make games with the kit, and for the agents and maintainers who work on it. The front page is the
[README](../README.md); agents start at [AGENTS.md](../AGENTS.md) and the skills in [`skills/`](../skills/).

## Making games

| Doc | What it is |
|---|---|
| [ONE-LINE.md](ONE-LINE.md) | The one line a person pastes into Claude Code or Codex: each step it runs, and what the agent does when a step fails. |
| [TRY-IT.md](TRY-IT.md) | One page for a person trying the kit by hand on Windows or a Mac: what to install, what to see, what to send us. |
| [MCP.md](MCP.md) | The MCP server: its tools, their hints and schemas, and how to add it to Claude Code, Codex, Cursor, opencode or Cline. |
| [ART.md](ART.md) | Pictures and models from whichever maker you have (your session, a key, a file), checked before they go in a slot. |
| [ONLINE.md](ONLINE.md) | Playing with friends on other machines: games.fun's play host, your own, or this machine only. |
| [PUBLISH.md](PUBLISH.md) | Putting a game on games.fun at an unlisted link: signing in, what is checked, what is refused. |
| [BACKEND.md](BACKEND.md) | A game's own backend (scores, saves, accounts) on Supabase or Railway, connected by the person's own agent. |
| [LICENSING.md](LICENSING.md) | Licensing in plain words: what MIT lets you do, and what a game you make has to carry. |

## Working on the kit

| Doc | What it is |
|---|---|
| [LAYOUT.md](LAYOUT.md) | Where everything is: the layers, a game's tree assembled from them, old path → new path, and why. |
| [ARCHITECTURE.md](ARCHITECTURE.md) | The layout, how the tools run, the seams (commands, MCP tools, routes, studio tabs) and who owns what. |
| [DEVELOPING.md](DEVELOPING.md) | Tests, the kit's layers, how the tools are run, the tool faults worked around here, skills, cross-platform rules. |
| [CI.md](CI.md) | What a GitHub runner can and cannot check, the CI profile, the cost per run, and what the first runs on each system found. |
| [../CONTRIBUTING.md](../CONTRIBUTING.md) | Branches, commit messages, editing the kit, adding a check (a broken example a gate must fail), tests to run. |
| [../CHANGELOG.md](../CHANGELOG.md) | What changed, by version. |
| [../SECURITY.md](../SECURITY.md) | How to report a security problem, and the trust model. |

`try-it/` holds the pictures TRY-IT.md shows.
