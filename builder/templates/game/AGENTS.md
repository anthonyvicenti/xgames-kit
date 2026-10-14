# {{TITLE}}

{{HOOK}}

A multiplayer browser game made with xgames-kit ({{PLACE}}). **The guide is `{{KIT}}/AGENTS.md`**
(the kit root): read it first. If this folder was moved out of the kit, the guide is AGENTS.md in the xgames-kit
repository. Build and change this game through the build loop: call `gamesfun_next {"game": "{{GAME}}"}` first and do
what it says (without the MCP tools: `node bin/gamesfun.mjs tool gamesfun_next --game {{GAME}}` from the kit root).

- Mechanics: {{MECHANICS}}
- Controls: {{CONTROLS}}
- World: {{WORLD}}

## Files

| File | Who edits it |
|---|---|
| `rules.js` | you: this game's own rules (`{{KIT}}/builder/CONTRACT.md` §3) |
| `config/*.json` | you: tuning; every number and colour is a slot (`config/game.json` → `rules.params` for the game's own) |
| `assets/` | through their slots only: `npx gamesfun slots set <id> --file <path>` |
| `spec.json` | the locked spec this game was made from: during a build or change run it is locked (an edit is put back). A different plan is the person's call: ask them |
| `assets.json` | generated from the slot declarations: `npx gamesfun slots write {{GAME}}` after adding a prop, mechanic, rules param or file |
| `multiplayer.json` | mode `live`: friends in one game, each seen as a character |
| `gf/`, `audio/`, `vendor/`, `index.html`, `main.js`, `gf-three.json` | the kit's: **never edit** (verify check 2) |
| `evidence/` | verify's records: append-only |

## Commands (from the kit root)

```bash
npx gamesfun dev {{GAME}}                 # the studio, live reload, two tabs play together on /game/gf/mp/
npx gamesfun verify {{GAME}} --quick      # your quick check inside a round (the loop runs the full verify)
npx gamesfun verify {{GAME}} --check 13   # one check alone while you fix it
npx gamesfun slots list {{GAME}}          # the main slots; --all for every one
npx gamesfun promises {{GAME}}            # what the game promises a player (the play-test list)
```
