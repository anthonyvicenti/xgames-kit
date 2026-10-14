# {{TITLE}}

{{HOOK}}

A multiplayer browser game on **runtime godot** (Godot 4.6's web export, profile {{PROFILE}}, camera {{CAMERA}}), made
with xgames-kit. The playbook is `{{KIT}}/AGENTS.md` (the kit root); the runtime's page is
`{{KIT}}/runtimes/godot/README.md`: read its GF table first, it is the whole API. Build and change this game through
the build loop: call `gamesfun_next {"game": "{{GAME}}"}` first and do what it says.

- Controls: {{CONTROLS}}

## Files

| File | Who edits it |
|---|---|
| `project/main.gd`, more scenes and scripts in `project/` | you: the game itself (Godot draws, moves and collides). Talk to the kit through the `GF` autoload |
| `rules.js` | you: the round's rules in JavaScript (scores, the host's shared state); `GF.event(...)` in GDScript arrives as `rules.event(ctx, name, data, 'godot')` |
| `config/*.json` | you: tuning; every number and colour is a slot, read in GDScript with `GF.value(id, fallback)` |
| `assets/` | through their slots only (`GF.texture(id)` reads them at run time): `npx gamesfun slots set <id> --file <path>` |
| `spec.json` | the locked spec this game was made from |
| `project/addons/gf/`, `gf/`, `audio/`, `index.html`, `main.js`, `xgames.json` | the kit's: **never edit** (verify, gate A measure 2) |
| `build/` | the export of `project/`, made by the kit (dev re-exports on every change; verify checks it is current) |
| `evidence/` | verify's records: append-only |

Sounds: `GF.sound(id)` plays a sound listed in `assets.json` → `sounds` through the kit's gf-audio (Godot's own audio
is off). Input: read actions (`move_left`, `move_right`, `move_up`, `move_down`, `jump`, `act`), never raw keys; the
kit takes them away while a menu is open.

## Commands (from the kit root)

```bash
npx gamesfun dev {{GAME}}        # the studio; a change in project/ exports again and the page reloads
npx gamesfun verify {{GAME}}     # the six gates in real Chrome with real input (about 4 minutes)
node runtimes/godot/tools/export.mjs {{GAME}}   # the export alone: GDScript errors show in seconds
```
