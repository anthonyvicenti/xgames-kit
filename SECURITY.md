# Security

## Reporting a problem

Please do not open a public issue for a security problem. Report it privately through GitHub's private vulnerability
reporting on this repository (the **Security** tab → **Report a vulnerability**), with what you found, how to show it,
and what it lets someone do. We reply privately with what we will do about it. The repository is private for
now; a contact address for people without access will be named here when it is public.

In scope: this repository's own code (the CLI, the studio and dev server, the MCP server, the Claude Code plugin, the
web3 layer). A problem in the kit's layers (`builder/`, `runtimes/`, `components/`, `loops/`, `worlds/`) is in scope too; report it
the same way.

## The trust model, in one paragraph

Everything runs on the person's own machine, under their own agent and login: the dev server listens on 127.0.0.1
only, and nothing here calls a model or signs the person in anywhere on its own. The web3 parts run on Solana
**devnet only**; the kit never holds a private key, and every transaction is signed by the person's own wallet in
their own browser (a tool prepares a step and a link, it never signs). Keys never go in a game: `publish` refuses a
game with anything that looks like a key, a backend keeps only its public settings in `backend.json`, and sign-in
tokens live in the system's own secret store (keychain, Secret Service, DPAPI, else a 0600 file in the person's config
folder). The build loop's seal and the play-test token (`builder/lib/loop-seal.mjs`) keep an agent session honest about its
own build; they are not a defence against other software on the machine, which can read the same config folder.
