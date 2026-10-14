# Publishing a game to games.fun

games.fun hosts the games you publish: you need no server, domain or hosting account. Your game gets a link anyone can
play, alone or with friends. Your own backend and database, if the game has one, stay yours (`gamesfun backend`).

```bash
npx gamesfun login                    # once: your browser opens games.fun; sign in and allow this computer
npx gamesfun publish games/my-game    # checks, uploads what changed, prints the link
npx gamesfun publish games/my-game    # later: a new version at the same link
npx gamesfun logout                   # ends this computer's sign-in
```

The studio page (`npx gamesfun dev`) has the same steps in its **Publish** tab, and your agent has them as MCP tools
(`gamesfun_login`, `gamesfun_publish_check`, `gamesfun_publish`, `gamesfun_publish_status`).

## What happens when you publish

1. **Your files.** Everything in the game folder goes up except `evidence/` (verify's screenshots), `supabase/` (your
   backend's server-side SQL), `node_modules/` and hidden files and folders (`.gitignore`, `.gamesfun/`). A `.env` file
   or a link in the folder stops it: move it out of the game.
2. **No secrets.** Every text file is checked for anything that looks like a key: private keys, cloud and payment keys,
   AI keys, a Supabase service-role or secret key, a database address with a password. Published files are public, file
   by file. A browser game may carry only keys made to be public: a Supabase publishable or anon key, with row-level
   security on. games.fun runs the same check again on its side.
3. **Your backend.** If the game has `backend.json` (written by `gamesfun backend connect`), the origins it lists are
   the only other sites the published game may talk to; everything else is blocked by the page's security policy. A
   backend on your own machine (`localhost`) cannot be reached from a published game, so it is refused.
4. **The checks.** `verify --quick` must pass on exactly the files you publish. It runs now (about 2 minutes) unless
   nothing changed since it last passed. A game whose checks fail is saved as a **private draft**: a version in your
   games.fun Studio with no public link, and you are told which checks failed.
5. **Upload.** Only files games.fun does not have yet go up. An update usually sends one or two files.
6. **The link.** Unlisted: only people you give it to will find it. It stays the same through every update. Nothing is
   listed on games.fun unless you ask for that later (not available yet).

`npx gamesfun publish --check` runs steps 1 to 3 without publishing. `--status` shows the link and the account.
`--draft` saves a private version without publishing. `--new` publishes the folder as a new game with a new link.

## Your sign-in

`gamesfun login` never sees your password: your browser signs in to games.fun, and games.fun hands this computer a
publish token for 30 days. The kit keeps it outside every game and outside this folder:

| System | Where |
|---|---|
| macOS | your login keychain |
| Linux | your keyring (Secret Service, through `secret-tool`) when it is installed and a session bus runs; otherwise a file only you can read under `~/.config/gamesfun/secrets/` |
| Windows | a file in your profile, encrypted for your Windows user (DPAPI), under `%APPDATA%\gamesfun\secrets\` |

The kit has one secret store, `builder/lib/secret-store.mjs` (docs/BACKEND.md), shared with the backend's sign-ins; the
token is kept there under `publish-<16 hex>`, a name no backend sign-in uses. `credentials.json` in the same folder
holds only the public part (which games.fun, which email, until when).
`GAMESFUN_CREDENTIALS=file` (or `GAMESFUN_SECRET_STORE=file`) always uses the file. On a machine without a browser (SSH, a container),
`npx gamesfun login --code` prints a link to open anywhere and asks for the code it shows. Only approve a sign-in you
started yourself.

## Limits

One game: 3,000 files, 100 MB, 32 MB per file. One account: 30 publishes and 1 GB of new files a day, 20 games.
games.fun can take a game down, and stop an account from publishing, for breaking its content rules.

`GAMESFUN_STUDIO=http://localhost:5191` publishes to a games.fun Studio running on your own machine instead (for
developing games.fun itself).
