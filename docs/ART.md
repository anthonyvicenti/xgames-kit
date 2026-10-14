# Art: the asset library, and pictures and models from whichever maker you have

Every picture and model in a game is a slot, and `create` fills every slot from the asset library (`library/`: packs of
models, pictures, sounds and fonts, each with its licence; see `library/README.md`), so a game always runs and its art
is credited. This page is about finding, making or bringing the art you want. Nothing here signs you in anywhere, stores a key, or sends
a request to a model on your subscription: your own agent session and your own keys do the making.

## The order of choice

For each piece of art the kit picks the first of these that applies, and says why:

1. **Art you provide.** A file you hand over always wins.
2. **The asset library.** What it has that fits the slot and the game's kind costs nothing and carries its licence
   (`npx gamesfun art find "wooden bridge" --kind scenic --3d`). `art request` names its pick; `--fresh` asks for a
   new one instead.
3. **A connection you offered.** A maker whose key is in your environment, or a connection you added to your agent and
   named. A model made for a slot (`npx gamesfun art generate --slot prop.token --words "a giant gold coin" --yes`)
   goes into the game's own private pack in the library, is validated, and fills the slot from there.
4. **Your own session.** The agent you are already talking to makes it. No extra key.
5. **The kit's stand-ins.** What `create` put there when nothing else was.

```bash
npx gamesfun art find "<words>" [--kind <k>] [--3d|--2d]   # search the library, best first, with each licence
npx gamesfun art fill [<game>] [--write]       # every file slot of a game, from the library by need and fit
npx gamesfun doctor            # the "Art" line: which maker pictures and 3D models will come from, and why
npx gamesfun art who           # the same per kind (picture, sheet, tile, model), with every maker passed over and why
npx gamesfun art makers        # the whole table: what each maker makes, costs, and the licence of what it gives you
```

## With no key at all: your session draws it

**Claude Code.** Claude does not make raster pictures. Anthropic's words: "Claude is an image understanding model
only. It can interpret and analyze images, but it cannot generate, produce, edit, manipulate, or create images."
([vision docs](https://platform.claude.com/docs/en/build-with-claude/vision), read 2026-10-11). So "use Claude for
art" means art the model **writes**: an SVG for drawn art, a pixel grid for pixel art. The kit turns that text into
a PNG and checks it.

**Codex.** Codex has its own image tool: "Built-in image generation uses gpt-image-2 and counts toward your general
Codex usage limits. Image generations use included limits 3–5x faster on average than similar turns without image
generation" ([Codex docs](https://learn.chatgpt.com/docs/image-generation), read 2026-10-11). Its skill says the
built-in tool "Does not require `OPENAI_API_KEY`". In a Codex session the kit asks for single pictures and tiles in
drawn style from that tool, and for body sheets and all pixel art as SVG or a pixel grid (one prompt to an image model
does not give six frames of one character on a grid, and a shrunk painting is not pixel art).

How it goes, in your agent:

1. You say what you want ("make the player a fox"). The agent calls `gamesfun_art_request` (or `npx gamesfun art
   request --slot character.body.player --subject "a fox in a red scarf"`).
2. The tool answers with a **ticket** and a **request**: the exact size, the style (pixel or drawn), the game's
   palette and art direction, and for a body the six frames (idle, walk1, walk2, air, act, down), which way it
   faces, where the feet go and which parts take the player's colour. The first request for a game fixes its style,
   palette and one line of art direction; every later request repeats them, so the pictures belong together.
3. Your session writes the answer itself, as text: one SVG, or a pixel grid (one character a pixel).
4. The agent hands it back with `gamesfun_art_take`. The kit draws it to a PNG (SVG in the browser the kit already
   uses, with scripting off and the network cut; a pixel grid with no browser at all) and **checks** it.
5. A refusal lists what to change ("\"idle\": the figure is 236 of 256 pixels tall…"), and the session redraws. A
   pass is written through the slot, and the picture comes back so the session can look at it.

What to expect: clean, simple, consistent art. Good enough to play with and to tell characters apart; not the
painted look of an image model.

## Connecting a maker (your key, your bill)

Put the key in your **environment** (your shell profile, or the way your system sets variables). The kit reads it
only at the moment of a call and never writes it anywhere. Meshy's key may also live in `.env` at the kit's root
(git-ignored; `.env.example`), as before.

| Maker | Makes | Set | Cost (read 2026-10-11) | What you may do with the output |
|---|---|---|---|---|
| OpenAI Images | pictures, tiles (drawn) | `OPENAI_API_KEY` | By tokens. OpenAI's per-picture figures for gpt-image-2 at 1024x1024: low $0.006, medium $0.053, high $0.211 ([pricing](https://developers.openai.com/api/docs/pricing)) | "Customer … owns all Output." ([Services Agreement §4.1](https://cdn.openai.com/osa/openai-services-agreement.pdf)) |
| Meshy | 3D models (GLB), humanoid rigs | `MESHY_API_KEY` | Prepaid credits; a key "requires a paid plan". About 36 credits a prop, 41 a rigged body with the kit's tools ([pricing](https://docs.meshy.ai/en/api/pricing)) | "If you are on a premium plan, you own all assets you create with Meshy." "If you are on a free plan, we grant you a CC BY 4.0 license instead." ([plans](https://www.meshy.ai/pricing)) |
| Tripo | 3D models (GLB) | `TRIPO_API_KEY` | Credits per task; the docs do not say how many. "Failed and cancelled tasks are not charged." ([billing](https://developers.tripo3d.com/en/docs/billing.md)) | **Not established**: Tripo's terms page refused our fetch. Read <https://www.tripo3d.ai/terms> before you ship a Tripo model |

Prices and terms change. The table is what each service's own page said on the date shown; `npx gamesfun art makers`
prints the same rows with their links. Read the page before you rely on a number.

A paid maker is never called without your yes: `gamesfun art make <ticket>` prints the request it would send and the
cost, and only `--yes` sends it. Spend is noted in `.gamesfun/art/spend.jsonl` (Meshy also keeps its own ledger and
cap: `npx gamesfun meshy status`).

**Any other maker** (Higgsfield, fal, Replicate, Recraft, Ideogram, Google's Gemini API, …): add its MCP server or
command-line tool to your own agent the way that service documents, then offer it by name:

```bash
GF_ART_PICTURE=connection:higgsfield      # also GF_ART_SHEET, GF_ART_TILE, GF_ART_MODEL
```

The kit then asks your session to make the picture with that connection and hand back the file, and checks it like
any other. The kit does not talk to the service and does not see its key.

**Several makers at once:** the one you name wins (`GF_ART_PICTURE=openai-images`, `GF_ART_MODEL=tripo`); otherwise
the first in `builder/art/providers.json`. `GF_ART_PICTURE=session` keeps your session drawing even when a key is set;
`stand-in` turns making off.

## Your own files

To keep a set of your own models or pictures for every game, take them into a pack of the library:
`npx gamesfun art ingest ~/art/props/ --pack my-props --licence LicenseRef-Own --author "me" --private` (a private pack
stays on your machine). For one game's slot:

```bash
npx gamesfun art request --slot prop.coin --subject "my coin" --game games/my-game   # opens a ticket
npx gamesfun art take <ticket> --file ~/Pictures/coin.png                            # checked, then written
```

or, skipping the checks, the plain slot swap: `npx gamesfun slots set prop.coin --file coin.png`.

## What is checked before anything is kept

| Art | Checked | Not checked (look at it) |
|---|---|---|
| A body sheet | six square cells; every cell drawn; the figure's height; feet on the bottom rows (side-on) or the centre (top-down); walk frames differ; margins (drawn); hard pixels (pixel) | whether it is the same character in every frame, whether the walk reads as a walk, whether it is good |
| A picture | the size; something drawn; a see-through ground; nothing cut off at an edge | whether it is what you asked for |
| A tile | square; no see-through pixel; the edges continue across the repeat | whether the repeat is too obvious |
| A concept picture, before a 3D model is paid for | one subject, whole, on a plain ground, big enough | likeness |
| A 3D model | a real GLB; a triangle budget by role (body 40,000, prop 15,000, scenery 30,000, small 5,000); file size | a floor slab the maker invented, which way it faces, its look |

The sheet numbers are games.fun's `gf-flat-1` standard (`builder/art/standard.mjs` holds this kit's copy).

## Adding a maker to the kit

One row in `builder/art/providers.json` (what it makes, how it is reached, what it can do, its cost and licence with the
page and the date). A maker reached by a key also needs one small file in `builder/art/adapters/` exporting
`plan(ticket, row)` (the request, with no call made) and `make(ticket, row, { env, fetch, dir })` (the call, returning
a file). `tests/art.test.mjs` holds every row to the shape.
