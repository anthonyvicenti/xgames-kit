---
name: swap-assets
description: Change how a gf-three game looks or tunes without touching code - list its slots, set a colour or number, replace a model, picture or sound with the person's own file (or a Meshy-generated one), and prove the swap shows. Use when someone asks to recolour, resize, retune, reskin, or use their own model, image or sound in a game.
---

# Swap assets

Every visible model, texture and tuning value of a gf-three game is a **slot** in its `assets.json` (R1-R5 in
AGENTS.md). A value slot points into a config file; a file slot is a file at a fixed path. Swapping either is a data
change: the game reads it through the kit.

## Find the slot

```bash
npx gamesfun slots list games/<name>              # the main tier (about 40), grouped, with current values
npx gamesfun slots list games/<name> --all        # every slot (often 300+)
npx gamesfun slots list games/<name> --all --group props --json
npx gamesfun slots get <id> --game games/<name>   # one slot: where it lives, its constraints, its licence
```

Ids follow a pattern: `character.body.<role>`, `character.tint.<role>`, `prop.<name>`, `prop.<name>.count`,
`world.<template>.ground.color`, `look.<group>.<name>`, `mechanic.<id>.<param>`, `rules.<param>`, `ui.<name>`.

## Change a value

```bash
npx gamesfun slots set world.backyard.ground.color '#5aa05a' --game games/<name>
npx gamesfun slots set round.seconds 90 --game games/<name>
npx gamesfun slots set rules.tank-seconds 10 --game games/<name>
```

The value is checked against the slot (colour format, min and max, enum options, text length). A negative number
works as is (`slots set look.sun.x -0.4`).

## Replace a file

```bash
npx gamesfun slots set prop.bucket --file path/to/bucket.glb --game games/<name>
npx gamesfun slots set world.backyard.ground.pattern --file grass.png --game games/<name>
```

The new file must be the same kind as the slot's file (a `.glb` stays a `.glb`, a `.png` a `.png`) and within its
byte budget; it is written to the slot's own path, so nothing else changes. Then:
- **Bodies** (`character.body.<role>`) must be on the gf-humanoid-1 rig: `npx gamesfun rig-check body.glb` first (R4).
- **Licences travel with the game**: add the file's source, author and licence to the game's `ATTRIBUTION.md`. Use
  only files the person made or that carry a permissive licence (CC0, CC-BY with its credit line, MIT, ...).
- Props are fitted to their slot's size by the kit; a model in metres with its base at y = 0 looks right first time.

## Generate a model (optional, costs credits)

Only with the person's own Meshy key (`MESHY_API_KEY` in `.env`, git-ignored) and their go-ahead:

```bash
npx gamesfun meshy prop --prompt "a red fire hydrant" --out games/<name>/scratch/hydrant.glb --size 1.0
npx gamesfun meshy character --prompt "a chunky robot chef" --out games/<name>/scratch/chef.glb
npx gamesfun meshy status                 # credits spent, the cap (GF_MESHY_CAP)
```

About 36 credits for a prop and 41 for a character, several minutes each. Then `slots set` the file into its slot.
Meshy output is recorded as CC BY 4.0 crediting Meshy until the person confirms their plan's terms.

## Prove it shows

`npx gamesfun dev games/<name>` reloads the game as files change; the studio's "Slots & assets" tab does the same
swaps with a click and a "Show" button for each model. Then `npx gamesfun verify games/<name> --quick`: check 4
(every visible mesh is a slot) and check 8 (a swapped body and prop are on screen) must pass.

## When something isn't a slot

If a thing on screen has no slot, the game drew it in code: move it to a slot (a prop in `config/world.json` or a
mechanic param) rather than editing the drawing code, and run `npx gamesfun slots write games/<name>`.
