# Library coverage: what art we have for a look, and what Meshy must make

Written 2026-10-14 by the asset audit (the looks layer, wave 1); sections 7 and 8 added by the art wave (looks wave 3)
the same day. Numbers come from `gamesfun art coverage` over this
checkout's packs plus the private packs on the build machine; run it again for today's numbers:

```
gamesfun art coverage [--kind <k>] [--case library/coverage/cases/<id>.json] [--json]
```

How it works: `library/coverage/needs.json` lists what a look usually asks for (characters by body archetype, props
by theme, terrain materials, skies, effects, UI fonts and panels, sounds), by what a thing is and never by a file.
`builder/art/coverage.mjs` asks the resolver for each need and scores every match's measured signature against a style
target (`styleFit`: hue families, saturation and lightness, then surfaces and detail). A kind's target is its own packs'
measured medians (`kindTarget`); a case brings its own target (`library/coverage/cases/*.json`, in the spec's
`gf-look-target/1` shape). Each need comes out as:

- **have**: matches that answer the words and fit the style; `n/wanted` says whether there are as many variants as
  the look wants;
- **off** (off-style): matches whose shapes and surfaces fit and whose colours do not; a style pass that re-tints,
  outlines and ramps materials at load could bring them in (a later wave);
- **MISSING**: nothing answers, or only matches with the wrong shapes or surfaces. Any body that is not humanoid is
  missing whatever the words say, because gf-humanoid-1 is the only rig standard;
- **code**: no asset, but a runtime part draws it (the sky dome, the particle presets, the CSS panels); its colours
  are look slots.

The measures are a guide, not a judge. They score one object's colours against a whole scene's palette, so a grey land
mine or gravestone in a candy world reads as off-style when it is right. A target written from words reads more
saturated than any rendered asset does. The look judge (`builder/look/judge.mjs`) scores the rendered game; this report
only says where to look first.

## In short

- **We have more than the kit showed.** Before this audit the library held 1,954 assets (1,866 public, 88 private). It now
  holds **2,920 in 74 packs (2,796 public, 124 private)**. Some of what was added had been on this machine all along
  and was never indexed: every model of the Kenney kits that games.fun had cached (840 more models), the Studio's first
  Meshy cast, our own artillery icons, two OFL comic fonts, a CC0 particle set and a CC-BY cartoon explosion.
- **Every kind is well covered for humanoids, props, ground, effects, fonts and sounds.** Each kind has 22 to 25
  "have" rows out of 31. The holes are the same in every kind: **no body that is not humanoid** (worm or serpent,
  blob, four-legged, flying). That is a rig-standard gap, and Meshy alone cannot close it. The flat kinds (pixel,
  drawn) also lack monsters and a soil cross-section.
- **The artillery case** (a candy-bright cartoon artillery battle): before the audit, 10 rows were "have", 8 "off" and
  9 "MISSING". Ingesting what we own moved it to 13 / 8 / 6. The 443-credit Meshy pilot moved it to **18 / 6 / 3**
  (the other 2 rows are "code" throughout). What is still missing: a creature team (made, but there is no rig for a
  legless body), a comic "pow" burst, and the land mine (made and in style by eye, but the measure misreads it; see
  above).
- **Meshy closes the case's art gaps in about 2 more waves** (about 1,000 credits; the account has 7,621 until it
  resets on 2026-11-12). The creature archetypes need kit work first: a rig standard per archetype.

## 1. Inventory

### 1a. Everything we own or may use, by source

Licence classes follow `library/policy.json`: own and public domain (no duty), permissive (the notice travels), attribution
(the credit line goes into the game), and paid-maker (Meshy on the creator's paid plan: private packs only, used with
the account's key and the creator's yes). "Prior art" means we may look at it and must not ship it.

| Source | What (counts) | Licence class | Style | In the library |
|---|---|---|---|---|
| The kit's library before this audit (58 public packs) | 1,866: props 342, pictures 643, tiles 358, textures 125, sprites 33, sounds 116, bodies 60, effects 10, fonts 6, clips 2, viewmodels 2 | public domain (most), permissive (MIT folio, Rocketbox, vista core; OFL fonts), attribution (Poly Pizza, 10) | mixed: Kenney flat low-poly, KayKit painted, grim forge, voxel, pixel, drawn 2D | yes |
| Cached Kenney kits (the old kit's curate step had kept 170 of them) | 840 more models: nature 323, fantasy town 155, toy car 157, platformer 126, survival 79 | public domain (CC0) | flat-colour low-poly, one swatch texture, Kenney units | **ingested now** (`kenney-*-full`, each with a rebuild line from the pinned zip) |
| More cached Kenney kits | about 1,300 models: building 79, marble 162, prototype 145, city 176, car 50, food 192, furniture 106, holiday 97, minigolf 123, mini kits 120, modular buildings 104 | public domain | same | not yet: ingest them when a look asks (one command each, about 5 s a kit) |
| Kenney Particle Pack (from kenney.nl) | 80 white particle sprites: smoke, fire, flame, spark, star, dirt, scorch, magic, muzzle, trails | public domain | tintable shapes | **ingested now** (`kenney-particle-pack`) |
| Comic fonts (google/fonts, pinned commits) | Bangers (hand-lettered comic), Bungee (blocky signage) | permissive (OFL) | comic display | **ingested now** (`ofl-bangers`, `ofl-bungee`) |
| Quiver's Outpost Assault art (a port in games.fun) | 2 cartoon explosion flipbooks; also 257 top-down military sprites | attribution (CC BY 4.0) | soft cartoon, top-down | **explosions ingested now** (`quiver-outpost-fx`); the military sprites are not (off every kind's style) |
| Crumble Cove, our own artillery game (games.fun trial) | 6 SVG weapon icons; two critter crews drawn in code (Moss Moles, Ember Newts) | own | flat with dark ink | **icons ingested now** (`xk-artillery-icons`); the critters became the pilot's creatures in 3D (below) |
| Studio v2 Meshy cast (the first live Studio builds, 2026-10-07/08) | 4 rigged toon bodies (player, caller, boss, monster), 2 props (token, portal); the gecko was already in `generated-bodies` | paid-maker | chunky toon, painted | **ingested now, private** (`studio-meshy-toon`); boss and monster fail the model judge (the face stretches in two clips) |
| Forge Meshy sets (grim skeletons, hunters, Zombie Town's townsfolk and street) | 15 bodies, 37 gear and cards, 35 ruins | paid-maker | grim, hand-painted, dark | yes, private (`forge-grim-*`) |
| Forge code-made town, world, fx, sounds | 116 | own / public domain | grim stylised | yes (`forge-*`) |
| This audit's Meshy pilot | 1 style anchor, 3 critters, 8 props, 6 terrain textures, 11 concept pictures, 1 rig probe | paid-maker | candy cartoon, painted | **yes, private** (`looks-pilot-artillery`) |
| Code-drawn pictures from the 2D art pass (games.fun trials) | 707 PNGs across 47 games | own or the game's upstream licence, per game | each game's own | not ingested: every game's licence has to be checked, and each set is one game's look. Ingest one game's set when a look asks for it |
| gf-audio presets | 31 synthesised sounds, including big and small explosions, a blaster thump and a splash | own (ZzFX, MIT) | code | code: they are presets, not files |
| AI pictures in two old trials (a painted card game, a dog sprite sheet) | 2 atlases, 1 panorama | no licence on record | painterly | no: ask the creator |
| The creator's uploaded sounds (four zombie deaths, 2026-10-08) | 4 mp3 | the creator's upload, origin not recorded | n/a | no: ask the creator where they came from |
| The private reference library (about 400 games and scraped repositories) | about 57,000 art files; only about 2,500 to 3,000 carry a licence that allows use, and nearly all of those are Kenney, KayKit, Quaternius, ambientCG or Poly Haven packs we can take from their own sources | mixed: most have no licence, are non-commercial or copyleft | mostly realistic or low-poly fantasy; nothing candy-bright | no: prior art. Worth taking from their upstream sources later: Poly Haven soil and mud textures (CC0, for realistic looks), Kenney Impact and Interface sounds, the Kenney Pirate Kit (cannons, barrels) |

### 1b. The library now, by pack

Counts by category, licence class and measured style (`fits.signature` medians; "dense" is 30+ triangles a metre,
"textured" means half or more of the surface carries a texture).

| pack | licence | owner | vis | assets | by category | style (measured) |
|---|---|---|---|---|---|---|
| flat-standins-drawn | CC0-1.0 | own | public | 15 | sprite 2, picture 6, tile 7 | orange/grey/yellow, mid-saturated, inked |
| flat-standins-pixel | CC0-1.0 | own | public | 15 | sprite 2, picture 6, tile 7 | brown/orange/grey, mid-saturated |
| folio-nature | MIT | third-party | public | 15 | prop 13, texture 2 | grey/orange/yellow, mid-saturated, flat colour, low-poly |
| forge-fx | CC0-1.0 | own | public | 10 | VFX 10 | grey/orange/red, saturated |
| forge-props | CC0-1.0 | own | public | 4 | viewmodel 1, prop 3 | grey/green/brown, muted, flat colour, mid-poly |
| forge-sounds | CC0-1.0 | third-party | public | 73 | sound 73 |  |
| forge-textures-night | CC0-1.0 | third-party | public | 5 | texture 5 | grey/brown, muted |
| forge-town | CC0-1.0 | own | public | 53 | prop 34, texture 19 | brown/grey, muted, textured, low-poly |
| forge-world | CC0-1.0 | own | public | 49 | prop 30, viewmodel 1, texture 18 | grey/green/orange, muted, textured, low-poly |
| gf-beans | CC0-1.0 | own | public | 4 | body 4 | purple/cyan/pink, saturated, flat colour, dense |
| gf-voxel-blocks | CC0-1.0 | third-party | public | 32 | texture 32 | orange/green/grey, mid-saturated |
| humanoid-clips | CC0-1.0 | own | public | 2 | clip 2 | flat colour |
| kaykit-adventurers | CC0-1.0 | third-party | public | 26 | prop 19, body 7 | grey/orange/cyan, muted, textured, mid-poly |
| kaykit-dungeon-remastered | CC0-1.0 | third-party | public | 68 | prop 67, texture 1 | grey/orange/brown, muted, textured, low-poly |
| kaykit-halloween | CC0-1.0 | third-party | public | 24 | prop 23, texture 1 | grey/orange, muted, textured, mid-poly |
| kaykit-skeletons | CC0-1.0 | third-party | public | 20 | prop 11, body 9 | grey/orange, muted, textured, mid-poly |
| kenney-background-elements-remastered | CC0-1.0 | third-party | public | 89 (9 failed) | picture 89 | cyan/grey/green, saturated |
| kenney-blocky-characters | CC0-1.0 | third-party | public | 18 | body 18 | orange/grey/blue, mid-saturated, textured, low-poly |
| kenney-car-kit | CC0-1.0 | third-party | public | 1 | prop 1 | orange/blue, saturated, flat colour, mid-poly |
| kenney-city-kit-commercial | CC0-1.0 | third-party | public | 8 | prop 8 | grey/blue/cyan, muted, flat colour, low-poly |
| kenney-city-kit-roads | CC0-1.0 | third-party | public | 4 | prop 4 | blue/grey, muted, flat colour, low-poly |
| kenney-city-kit-suburban | CC0-1.0 | third-party | public | 7 | prop 7 | grey/cyan/orange, muted, flat colour, low-poly |
| kenney-fantasy-town-kit | CC0-1.0 | third-party | public | 12 | prop 12 | blue/cyan/orange, mid-saturated, flat colour, low-poly |
| kenney-fantasy-town-kit-full | CC0-1.0 | third-party | public | 155 | prop 155 | orange/blue/grey, mid-saturated, flat colour, low-poly |
| kenney-food-kit | CC0-1.0 | third-party | public | 8 | prop 8 | orange/red/grey, mid-saturated, flat colour, mid-poly |
| kenney-furniture-kit | CC0-1.0 | third-party | public | 34 | prop 34 | orange/grey/cyan, saturated, flat colour, low-poly |
| kenney-holiday-kit | CC0-1.0 | third-party | public | 2 | prop 2 | blue/orange/red, mid-saturated, flat colour, mid-poly |
| kenney-mini-arcade | CC0-1.0 | third-party | public | 2 | prop 2 | grey/blue/red, muted, flat colour, low-poly |
| kenney-mini-arena | CC0-1.0 | third-party | public | 7 | prop 7 | orange/grey/blue, mid-saturated, flat colour, low-poly |
| kenney-mini-forest | CC0-1.0 | third-party | public | 1 | prop 1 | orange/grey/red, mid-saturated, flat colour, low-poly |
| kenney-mini-market | CC0-1.0 | third-party | public | 10 | prop 10 | grey/blue/orange, muted, flat colour, low-poly |
| kenney-mini-skate | CC0-1.0 | third-party | public | 2 | prop 2 | orange/grey/blue, mid-saturated, flat colour, low-poly |
| kenney-minigolf-kit | CC0-1.0 | third-party | public | 3 | prop 3 | blue/red/cyan, mid-saturated, flat colour, dense |
| kenney-modular-buildings | CC0-1.0 | third-party | public | 4 | prop 4 | orange/grey, saturated, flat colour, low-poly |
| kenney-nature-kit | CC0-1.0 | third-party | public | 6 | prop 6 | cyan/orange/red, saturated, flat colour, mid-poly |
| kenney-nature-kit-full | CC0-1.0 | third-party | public | 323 | prop 323 | cyan/orange/grey, saturated, flat colour, mid-poly |
| kenney-new-platformer-pack | CC0-1.0 | third-party | public | 438 | picture 214, texture 32, tile 187, sprite 5 | grey/orange/cyan, mid-saturated, inked |
| kenney-particle-pack | CC0-1.0 | third-party | public | 80 | VFX 80 | grey, muted |
| kenney-platformer-kit | CC0-1.0 | third-party | public | 27 | prop 27 | orange/grey/blue, mid-saturated, flat colour, low-poly |
| kenney-platformer-kit-full | CC0-1.0 | third-party | public | 126 | prop 126 | orange/grey/blue, mid-saturated, flat colour, low-poly |
| kenney-survival-kit | CC0-1.0 | third-party | public | 1 | prop 1 | grey/blue/orange, muted, flat colour, mid-poly |
| kenney-survival-kit-full | CC0-1.0 | third-party | public | 79 | prop 79 | orange/blue/grey, mid-saturated, flat colour, mid-poly |
| kenney-tiny-dungeon | CC0-1.0 | third-party | public | 131 | tile 56, picture 75 | blue/pink/orange, muted, inked |
| kenney-tiny-town | CC0-1.0 | third-party | public | 132 | tile 89, picture 43 | pink/orange/blue, mid-saturated |
| kenney-toon-characters | CC0-1.0 | third-party | public | 270 | picture 270 | orange/blue/grey, mid-saturated |
| kenney-toy-car-kit-full | CC0-1.0 | third-party | public | 157 | prop 157 | orange/blue/red, mid-saturated, flat colour, low-poly |
| kit-standins | CC0-1.0 | own | public | 6 | prop 6 | blue/red/orange, saturated, flat colour, dense |
| kit-textures | CC0-1.0 | own | public | 7 | texture 7 | grey, muted |
| ofl-bangers | OFL-1.1 | third-party | public | 1 | UI/font 1 |  |
| ofl-bungee | OFL-1.1 | third-party | public | 1 | UI/font 1 |  |
| ofl-fredoka | OFL-1.1 | third-party | public | 1 | UI/font 1 |  |
| ofl-grenze | OFL-1.1 | third-party | public | 2 | UI/font 2 |  |
| ofl-lilita-one | OFL-1.1 | third-party | public | 1 | UI/font 1 |  |
| ofl-silkscreen | OFL-1.1 | third-party | public | 1 | UI/font 1 |  |
| ofl-vt323 | OFL-1.1 | third-party | public | 1 | UI/font 1 |  |
| poly-pizza-cc-by | CC-BY-3.0 | third-party | public | 10 | prop 10 | grey/orange/red, muted, flat colour, low-poly |
| polyhaven | CC0-1.0 | third-party | public | 1 | texture 1 | orange/yellow/brown, muted |
| quaternius-props | CC0-1.0 | third-party | public | 9 | prop 9 | grey, muted, flat colour, dense |
| quaternius-ual-bodies | CC0-1.0 | third-party | public | 14 (1 failed) | body 14 | brown/grey/orange, muted, flat colour, mid-poly |
| quiver-outpost-fx | CC-BY-4.0 | third-party | public | 2 | VFX 2 | pink/grey/red, mid-saturated |
| rocketbox-adults | MIT | third-party | public | 6 | body 6 | grey/brown/orange, muted, textured, dense |
| vista-core-world | MIT | third-party | public | 10 (2 failed) | prop 4, body 2, texture 4 | grey/brown, muted, flat colour, dense |
| vista-sounds | CC0-1.0 | third-party | public | 43 | sound 43 |  |
| xk-artillery-icons | CC0-1.0 | own | public | 6 | picture 6 | grey/red/purple, muted, inked |
| xk-blocky-bodies | CC0-1.0 | own | public | 4 | body 4 | grey/orange/blue, mid-saturated, flat colour, low-poly |
| xk-pixel-folk | CC0-1.0 | own | public | 24 | sprite 24 | grey/orange/brown, mid-saturated, inked |
| xk-pixel-town | CC0-1.0 | own | public | 35 | picture 23, tile 12 | grey/brown/green, mid-saturated |
| xk-voxel-blocks | CC0-1.0 | own | public | 59 | texture 59 | grey/brown/orange, mid-saturated |
| forge-grim-bodies | LicenseRef-Meshy-Paid | generated | private | 15 | body 15 | grey/blue/brown, muted, textured, dense |
| forge-grim-gear | LicenseRef-Meshy-Paid | generated | private | 37 | UI/card 17, viewmodel 5, prop 15 | grey/brown, muted, textured, dense |
| forge-grim-ruins | LicenseRef-Meshy-Paid | generated | private | 35 | prop 35 | grey/brown/yellow, muted, textured, mid-poly |
| generated-bodies | CC-BY-4.0 | generated | private | 1 | body 1 | yellow/grey/green, muted, textured, dense |
| looks-pilot-artillery | LicenseRef-Meshy-Paid | generated | private | 30 (4 failed) | texture 6, picture 12, prop 8, body 4 | grey/red/brown, mid-saturated, textured, dense |
| studio-meshy-toon | LicenseRef-Meshy-Paid | generated | private | 6 (2 failed) | body 4, prop 2 | grey/yellow/brown, muted, textured, dense |

Totals: {"packs":74,"assets":2920,"failed":18,"byCategory":{"sprite":33,"picture":744,"tile":358,"prop":1268,"texture":187,"VFX":92,"viewmodel":7,"sound":116,"body":88,"clip":2,"UI/font":8,"UI/card":17},"byLicenceClass":{"public-domain":2745,"permissive":39,"attribution":13,"paid-maker":123},"byVisibility":{"public":2796,"private":124}}

## 2. Coverage matrix: the eight kinds

Each cell gives the status and how many matches are in style (or, for "off", how many a style pass could fix) against
how many variants the look wants. pixel and drawn are flat (2D) kinds, so for them a body is a sprite sheet, a prop is
a picture and a texture is a tile. The rows are `library/coverage/needs.json`.

| need | blocky | calm | dark | drawn (2D) | lofi | pixel (2D) | scenic | silly |
|---|---|---|---|---|---|---|---|---|
| char-humanoid | have 46/4 | have 55/4 | have 65/4 | have 26/4 | have 29/4 | have 31/4 | have 68/4 | have 23/4 |
| char-monster | have 12/3 | have 25/3 | have 25/3 | **MISSING** | have 7/3 | **MISSING** | have 25/3 | have 6/3 |
| char-worm | **MISSING** | **MISSING** | **MISSING** | **MISSING** | **MISSING** | **MISSING** | **MISSING** | **MISSING** |
| char-blob | **MISSING** | **MISSING** | **MISSING** | **MISSING** | **MISSING** | **MISSING** | **MISSING** | **MISSING** |
| char-quadruped | **MISSING** | **MISSING** | **MISSING** | **MISSING** | **MISSING** | **MISSING** | **MISSING** | **MISSING** |
| char-flyer | **MISSING** | **MISSING** | **MISSING** | **MISSING** | **MISSING** | **MISSING** | **MISSING** | **MISSING** |
| props-nature | have 76/6 | have 11/6 | have 39/6 | have 11/6 | have 140/6 | have 18/6 | have 46/6 | have 146/6 |
| props-town | have 33/6 | have 17/6 | have 42/6 | have 15/6 | have 21/6 | have 22/6 | have 47/6 | have 25/6 |
| props-dungeon | have 17/6 | have 29/6 | have 39/6 | have 6/6 | have 8/6 | have 9/6 | have 41/6 | have 7/6 |
| props-containers | have 25/3 | have 13/3 | have 24/3 | have 6/3 | have 14/3 | have 6/3 | have 28/3 | have 15/3 |
| props-melee | have 4/3 | have 18/3 | have 18/3 | off 9/3 | have 2/3 | have 6/3 | have 17/3 | have 2/3 |
| props-ranged | off 6/3 | have 10/3 | have 10/3 | off 2/3 | off 9/3 | have 2/3 | have 7/3 | off 9/3 |
| props-explosives | have 1/3 | have 2/3 | have 2/3 | have 4/3 | off 3/3 | have 3/3 | have 2/3 | have 1/3 |
| props-pickups | have 9/3 | have 4/3 | have 6/3 | have 23/3 | have 8/3 | have 20/3 | have 8/3 | have 6/3 |
| props-food | have 5/3 | off 6/3 | off 6/3 | have 1/3 | have 6/3 | have 2/3 | have 1/3 | have 6/3 |
| props-vehicles | have 5/2 | have 4/2 | have 5/2 | have 4/2 | have 3/2 | have 14/2 | have 5/2 | have 2/2 |
| mat-grass | have 6/1 | have 5/1 | have 5/1 | have 36/1 | have 1/1 | have 18/1 | have 4/1 | have 2/1 |
| mat-soil | have 5/1 | have 4/1 | have 5/1 | have 33/1 | have 1/1 | have 21/1 | have 5/1 | have 2/1 |
| mat-rock | have 4/1 | have 15/1 | have 19/1 | have 34/1 | have 1/1 | have 42/1 | have 9/1 | have 1/1 |
| mat-sand | have 1/1 | off 3/1 | off 3/1 | have 28/1 | have 1/1 | have 2/1 | off 3/1 | have 2/1 |
| mat-cross-section | have 1/1 | off 3/1 | off 3/1 | **MISSING** | have 1/1 | **MISSING** | off 3/1 | have 2/1 |
| sky | code | code | code | have 1/1 | code | off 1/1 | code | code |
| clouds | have 2/1 | off 1/1 | have 3/1 | have 17/1 | have 2/1 | have 12/1 | have 2/1 | have 2/1 |
| vfx-explosion | have 2/1 | have 2/1 | have 2/1 | have 2/1 | off 2/1 | have 2/1 | have 2/1 | off 2/1 |
| vfx-smoke | have 3/1 | have 4/1 | have 5/1 | have 3/1 | have 1/1 | have 3/1 | have 4/1 | have 1/1 |
| vfx-impact | have 8/1 | have 8/1 | have 11/1 | have 8/1 | have 7/1 | have 8/1 | have 8/1 | have 7/1 |
| ui-display-font | have 4/1 | have 4/1 | have 4/1 | have 4/1 | have 4/1 | have 4/1 | have 4/1 | have 4/1 |
| ui-comic-font | have 1/1 | have 1/1 | have 1/1 | have 1/1 | have 1/1 | have 1/1 | have 1/1 | have 1/1 |
| ui-panel | have 1/1 | have 2/1 | have 2/1 | have 1/1 | have 1/1 | have 1/1 | have 2/1 | have 1/1 |
| snd-explosion | have 2/1 | have 2/1 | have 2/1 | have 2/1 | have 2/1 | have 2/1 | have 2/1 | have 2/1 |
| snd-impact | have 14/1 | have 14/1 | have 14/1 | have 14/1 | have 14/1 | have 14/1 | have 14/1 | have 14/1 |

Totals: blocky 25 have, 4 missing, 1 off-style, 1 code; calm 22 have, 4 missing, 4 off-style, 1 code; dark 23 have, 4 missing, 3 off-style, 1 code; drawn 23 have, 6 missing, 2 off-style; lofi 23 have, 4 missing, 3 off-style, 1 code; pixel 24 have, 6 missing, 1 off-style; scenic 24 have, 4 missing, 2 off-style, 1 code; silly 24 have, 4 missing, 2 off-style, 1 code

Reading it:
- **Body archetypes are the one gap every kind shares.** The library has 88 bodies, every one humanoid (gf-humanoid-1,
  apart from the vista core's two keepers on their own Rocketbox rig). A worm, blob, four-legged or flying character
  has nothing to stand on until the kit has a rig standard for that archetype: its bones, its clips and a rig-check.
  Generating more meshes does not fix that.
- **Fonts and sounds are not measured.** Their rows only say that something answers the words; whether it suits a kind
  is judged by eye or ear. With Bangers and Bungee in, every kind has a heavy display face and a comic face.
- **The flat kinds** lack a monster sprite sheet and a soil cross-section tile. Meshy makes 3D models, so those come
  from the picture makers (the session or OpenAI Images, `builder/art/providers.json`) or the kit's own pixel tools.
- **"have" counts are generous for 3D kinds**: a Kenney flat-colour prop fits most bright kinds by its measures. The kind
  sheets (`kinds/sheets/`) and the look judge decide what a kind really accepts.

## 3. The proving case: a candy-bright cartoon artillery battle

`library/coverage/cases/artillery-cartoon.json` holds the case: a style target written from words (from: words,
confidence 0.4, made from the brief's "what makes it read"; the look-target stream's target, measured from the local
reference frames, replaces it), 29 needs and the pilot wave. It names no game, and no reference image ever reaches a
maker.

| need | status | in style / wanted | best match | gap |
|---|---|---|---|---|
| creature-team | **MISSING** | 0/4 |  | no rig standard for a blob body (gf-humanoid-1 is the only one): a new body archetype |
| creature-fallback | have | 2/4 | gf-beans/bean-gumdrop | 2 of 4 in style, 2 more with a style pass |
| launcher | off | 0/1 | looks-pilot-artillery/launcher | 1 answer the words but not the style: colours yellow/green against cyan/brown; saturation 0.494 against 0.78; lightness 0.261 against 0.53; no ink outline (a runtime outl |
| grenade | have | 1/1 | looks-pilot-artillery/grenade |  |
| dynamite | have | 1/1 | looks-pilot-artillery/dynamite |  |
| mine | **MISSING** | 0/1 | looks-pilot-artillery/land-mine | only wrong-style matches (looks-pilot-artillery/land-mine: colours grey/red against cyan/brown; saturation 0.154 against 0.78; surface textured against painted; no ink ou |
| gun | off | 0/1 | forge-grim-gear/hunter-pistol | 5 answer the words but not the style: colours grey/orange against cyan/brown; saturation 0.256 against 0.78; lightness 0.297 against 0.53; no ink outline (a runtime outli |
| melee | off | 0/1 | kenney-survival-kit-full/tool-hammer | 2 answer the words but not the style: colours blue/orange against cyan/brown; saturation 0.416 against 0.78; no ink outline (a runtime outline pass draws one) |
| crates | have | 8/3 | kenney-platformer-kit-full/crate-item |  |
| barrel | have | 2/1 | kenney-survival-kit-full/barrel |  |
| gravestone | off | 0/1 | looks-pilot-artillery/gravestone | 5 answer the words but not the style: colours brown/grey against cyan/brown; saturation 0.362 against 0.78; no ink outline (a runtime outline pass draws one) |
| girder | have | 10/1 | kenney-nature-kit-full/bridge-woodnarrow |  |
| scenery | have | 114/6 | kenney-platformer-kit/flowers-tall |  |
| ground-top | have | 2/2 | kenney-new-platformer-pack/terrain-grass-ramp-long-a |  |
| ground-soil | have | 2/2 | looks-pilot-artillery/rock-soil |  |
| ground-cross-section | have | 2/1 | looks-pilot-artillery/rock-soil |  |
| ground-rock | have | 1/1 | looks-pilot-artillery/rock-soil |  |
| water | off | 0/1 | xk-voxel-blocks/water | 1 answer the words but not the style: colours blue against cyan/brown; no ink outline (a runtime outline pass draws one) |
| sky | code | 0/1 |  | drawn by runtimes/three/kit/look/sky.js (a gradient dome; colours are look slots) |
| clouds | have | 2/2 | poly-pizza-cc-by/cloud-puffy |  |
| explosion | off | 0/1 | quiver-outpost-fx/explosion-flipbook-large | 2 answer the words but not the style: colours pink/red against cyan/brown; saturation 0.423 against 0.78; no ink outline (a runtime outline pass draws one) |
| smoke | have | 1/1 | forge-fx/smoke |  |
| debris | have | 2/1 | kenney-particle-pack/dirt-01 |  |
| comic-burst | **MISSING** | 0/1 |  | nothing in the library answers "comic burst, starburst, pow" |
| ui-display-font | have | 3/1 | ofl-bangers/bangers |  |
| ui-comic-font | have | 1/1 | ofl-bangers/bangers |  |
| ui-panel | code | 0/1 |  | drawn by builder/ui/panels (CSS panels; ink and colours from the theme) |
| snd-explosion | have | 2/1 | forge-sounds/boss-slam-boom |  |
| snd-launch | have | 1/1 | forge-sounds/evade-whoosh |  |

Case totals: 3 missing, 18 have, 6 off-style, 2 code

Before the audit the case had 10 rows "have", 8 "off" and 9 "MISSING" (with 2 "code" throughout). After ingesting
what we own, without the pilot, it had 13, 8 and 6. With the pilot it has 18, 6 and 3. The rows the pilot moved:
grenade, dynamite, the soil, the soil cross-section and the rock ground went to "have", and the launcher went from
"MISSING" to "off". The rows the ingest moved: the barrel and debris to "have" (the Kenney survival kit and the
particle pack), the comic font to "have" (Bangers), and the explosion and melee rows to "off" (the Quiver flipbooks and
the survival kit's hammer).

## 4. The Meshy pilot (wave `looks-pilot-artillery-2026-10-14`, cap 600)

**Spent: 443 credits.** The account balance went from 8,064 to 7,621; the ledger is `~/.xgames/meshy-ledger.jsonl`,
outside every repository. The spend was 6 for the anchor, 11 × 36 for three critters and eight props, 6 × 6 for the
textures, and 5 for one rig probe. Made with `node builder/art/wave.mjs run library/coverage/cases/artillery-cartoon.json
--yes --rig-probe moss-mole`. The files and every prompt and task id are in the private pack `looks-pilot-artillery`
and in the wave's record (`~/.xgames/waves/looks-pilot-artillery-2026-10-14/wave-record.json`).

**The method (concept art first, one style anchor per look).**
1. One anchor picture, made by text-to-image from the style target's words: colours given as words (a picture model
   draws a hex code as text), the shading, the shapes, "what makes it read". No reference image is used, and no name.
   It shows a critter, a crate, a soil chunk, a bomb and an explosion on one sheet.
2. A concept for each asset: image-to-image with the anchor as the only reference, the subject alone on white. A
   concept that will become a model is asked for without drawn outlines, because the game draws ink and painted
   lines would bake into the texture.
3. A model from each concept (image-to-3D, about 6,000 triangles, base at 0, in metres). A texture is made tileable by
   swapping its halves and cross-fading the seams (`makeTileable`).

**The creatures are our own.** The three critters are Crumble Cove's crews (our artillery game, drawn in code) brought
into 3D: the Moss Mole (leaf green, headband, pink nose), the Ember Newt (orange, spiky crest), and a third crew made
for this wave, the Tide Puff (sky blue, fin ears, freckles). They are round, legless and big-eyed. They are not worms,
and nothing in them comes from the reference game.

**Judged** (the kit's validators at ingest, the coverage measures against the case target, and a look at every
preview against the anchor):

| Piece | Validator | Style fit (colour / shape) | By eye against the anchor |
|---|---|---|---|
| moss-mole, ember-newt, tide-puff (bodies, about 6,200 triangles) | **rig-check FAILS: no skinned mesh** (expected: there is no rig standard for a blob) | 0.59 / 0.70 / 0.70 | on model, faithful to the concepts, clean silhouettes; tiny nub feet |
| moss-mole-rigged (Meshy's auto-rig, the 5-credit probe) | **model judge FAILS**: the face stretches 21.9% of the head's size in the head-hit clip, and there is no left hand | 0.58 | Meshy forces its biped skeleton onto a legless body: the archetype gap, confirmed |
| grenade, dynamite, oil drum, weapon crate (props) | budget ok (5,600 to 6,200 triangles) | 0.71 / 0.63 / 0.64 / 0.61 | in style; the crate came out open-topped |
| launcher | budget ok | 0.52 (dark olive reads under the bright target) | in style, but it **kept a stand**: the prompt said "on its own base" for every prop. Fixed for the next wave (`held: true` floats it) |
| land mine, gravestone, health crate | budget ok | 0.42 / 0.54 / 0.42 | in style by eye. They are grey or white by design, which the colour measure reads as off |
| meadow, candy and rock top and soil textures (1024 px) | picture-check ok | 0.31 to 0.71 | candy and rock read well. **meadow-soil has a pale streak on one edge** that shows at the seam (remake it, 6 credits), and the candy soil shows a little ghosting in the cross-fade |
| 11 concept pictures | flat judge ok | n/a | usable as 2D icons as they are (a weapon wheel, a flat version of the game); one stray "BOMB" lettering on the anchor despite "no text" |

What it shows: one anchor keeps 17 Meshy pieces in one look, and the pieces come back faithful to their concepts. The
weak points are the prompt (held props, an open crate), the measure (grey objects), and the body archetype, which only
the kit can fix.

## 5. The Meshy plan: what to make, in our own design, with credits

The recipe (`builder/art/recipe.mjs`, run by `builder/art/wave.mjs`): one anchor per look (text-to-image, 6), then per
item a concept (image-to-image from the anchor, 6), plus image-to-3D for a body or prop (30), plus rigging for a
humanoid body only (5). Textures and pictures stop at the concept. In credits: a look costs 6 to start, a prop 36, a
humanoid body 41, a non-humanoid body 36 (no rig yet), and a texture or picture 6. Every wave has its own cap in the
ledger, and `GF_MESHY_CAP` may only lower it. The account had 7,621 credits after the pilot; the monthly 8,064 resets on
2026-11-12. The creator wants Meshy used as much as possible, in waves with caps.

| Wave | What | Archetype / rig | Credits (cap) | Prerequisite |
|---|---|---|---|---|
| 2: finish the artillery case (not run; wave 3 below took its set dressing, held weapons and creature rows at level scale) | the look's own scenery (a round tree, a bush, a boulder, a mushroom, a flower clump, a signpost: 6 × 36); held weapons with no base (a blaster, a bat, a homing rocket, our own gull bomber, a bouncing critter bomb: 5 × 36); a girder and a flag (2 × 36); a fourth crew (36); 2D pieces from the same anchor (4 explosion stages, 3 comic "pow" bursts, 2 sky panoramas, a water tile, 2 panel frames: 12 × 6); a remade meadow soil (6) | props: none; the 4th crew: blob, unrigged | about 580 (600) | none: run it when the creator says yes |
| 3: body archetypes | 3 variants each of a worm or serpent, a blob, a four-legged animal and a flyer, in the anchor of the look that asks first (12 × 36) | the rig standards landed (CREATURES.md: gf-worm-1, gf-blob-1, gf-quadruped-1, gf-flyer-1, the kit's autorig); wave 3 made 2 worms and a blob, all passing rig-check | about 430 (450) | none now; the quadruped and flyer rows are still open |
| 4: one anchor per kind | an anchor sheet and 6 signature props for each kind whose looks drift most (silly, scenic, dark, calm, blocky, lofi), so a build can fill gaps in its kind's style (6 × (6 + 6 × 36)) | props | about 1,330 (1,400) | the look judge's verdict on which kinds drift |
| per game | a game's own missing pieces at build time, from its own look target's anchor (the loop's generate rung) | as the game needs | per game (each game's own cap) | already wired: `fill.from: generate`, `builder/art/generate.mjs` |

Waves 2 to 4 come to about 2,340 credits, under a third of a month. The flat kinds' gaps (a monster sprite sheet, a soil
cross-section tile) are not Meshy work: they go to the picture makers or the kit's pixel tools.

## 6. Findings

1. **The library was missing what this machine had.** 840 Kenney models had been downloaded long ago and were never
   indexed; about 1,300 more from eleven other cached kits can go in with one command each (`art ingest <zip> --pack
   kenney-<kit>-full --include 'Models/GLB format/*.glb'`) when a look asks for them.
2. **No body archetype besides humanoid**, in any kind. Meshy's rig is biped-only. On a legless critter it produced a
   rig that the model judge fails. This is kit work (a rig standard per archetype), not generation work.
3. **The style measure has known limits.** It scores one object's colours against a scene's palette, so grey or
   white objects read as off. A target written from words reads more saturated than rendered assets. Treat "off"
   and "MISSING" as places to look, and let the look judge decide on the rendered game.
4. **Two Studio Meshy bodies fail the model judge** (`studio-meshy-toon/boss` and `/monster`: the face stretches in the
   knockdown and throw clips). The resolver will not offer them until they are fixed or remade.
5. **The Meshy gecko's record still says CC BY 4.0** (`generated-bodies`), while the creator ruled on 2026-10-10 that the
   account is paid. Bring it in line when that pack is next touched.
6. **What a fresh clone can reach.** The `kenney-*-full` packs and the particle pack rebuild from their pinned zips, and
   the two fonts fetch from their pinned GitHub files. The Quiver explosions and the artillery icons are only in this
   machine's store until a public mirror exists (a creator decision, `library/README.md`).
7. **Not ingested, on purpose:** the 707 code-drawn pictures of the 2D games (each game's licence has to be checked first),
   the AI pictures of two old trials and the creator's four uploaded sounds (no record of where they came from: the
   creator's call), and everything in the private reference library (prior art; the few usable rows are packs we take
   from their own sources).

## 7. Wave 3: the artillery case at level scale (wave `looks-wave3-artillery-levels-2026-10-14`, cap 1,000)

The case's references swing between three looks, so the case was split by level: `library/coverage/cases/artillery-levels.json`
holds the measured style facts of each look (palette, light, materials, shapes, place) with every line of words our own,
24 needs (15 of them a level's set pieces, each held to its own level's target), and the wave. The reference frames,
their names and their sha256s stay local; the case names no game (a test checks).

**Spent: 918 credits of the 1,000 cap.** The account went from 7,621 to 6,703 (the ledger `~/.xgames/meshy-ledger.jsonl`, the
record `~/.xgames/waves/looks-wave3-artillery-levels-2026-10-14/wave-record.json`). 18 for three anchors, 22 × 36 for the
pieces, and 3 × 36 for three pieces made again. Everything is in the private pack `looks-artillery-levels`
(LicenseRef-Meshy-Paid): 3 anchors, 22 models and their 22 concepts.

**Concept art first, one anchor per look.** `wave.mjs` now takes `wave.looks`: one anchor per look, its prompt built from
the look's measured facts (colours as words, shading, shapes, light) and a `keep` list we wrote. A target measured from
reference frames never sends its `reads` to a maker (they describe the reference's own art), so `keep` is the only
description of the look an anchor gets. Every piece of a level is an image-to-image concept from that level's anchor;
creatures and weapons come from the sunny anchor and serve every level. A set piece's concept stands on flat ground
with no base (it stands on the world's ground).

| Look | Our anchor shows | Set pieces (our designs) |
|---|---|---|
| sunny castle isles | a cream-plaster keep under terracotta cone roofs, a curly palm, a cobbled arch bridge, a grass-over-sandstone chunk, a critter | cone-roof castle (8 m), castle wall ruin, arched stone bridge, curly palm tree, leaning pine tree |
| violet dusk fortress | a blue-grey tower with a deep-teal and gold onion dome, a stubby gatehouse, a pine, a stone-cliff islet, a lantern | onion-dome tower (9 m), fortress gatehouse, domed kiosk, rampart corner, crumbling stone stair |
| sunset canyon sands | a banded sandstone mesa, a rock arch, a rope-and-plank bridge, a carved temple wall, a desert palm | sandstone mesa (9 m), sandstone rock arch, carved temple wall, rope-plank bridge, rope-ladder lookout |
| (creatures, weapons: sunny anchor) | | noodle eel and sprout grub (gf-worm-1), jelly drop (gf-blob-1); fizz blaster, firework rocket, bounce bomb, prize trophy |

**Judged.** Every piece went through the kit's validators at ingest (the triangle budget; rig-check on the standard for
the three creatures, which the kit's autorig rigged with no credits: all three pass), and `wave.mjs judge` held its
measured signature to its own look's anchor (`builder/art/anchor.mjs`: the anchor's colours with its plain background
left out, the look's surfaces and shapes; a piece under 0.5, or 0.15 under its look's median, is an outlier). Then a
look at every preview against its anchor.

| Piece | Anchor fit | Level fit | Verdict |
|---|---|---|---|
| cone-roof castle, castle wall ruin | 0.81, 0.70 | 0.74, 0.71 | in |
| arched stone bridge | 0.61 → 0.82 | 0.53 → 0.81 | **made again** (by eye: black-and-white checkered cobbles, which the anchor itself drew, read as another set; remade all cream and sandstone) |
| curly palm, leaning pine | 0.61, 0.60 | 0.53, 0.63 | in (the scene measure reads a vivid palm as too saturated; by eye it fits) |
| onion-dome tower, gatehouse, domed kiosk, rampart corner, stone stair | 0.72 to 0.82 | 0.77 to 0.87 | in (the rampart corner came out as a squat square bastion, no flagpole: acceptable) |
| sandstone mesa, rock arch, rope-plank bridge, rope-ladder lookout | 0.65 to 0.83 | 0.69 to 0.75 | in |
| carved temple wall | 0.75 → 0.74 | 0.68 → 0.67 | **made again** (by eye: black burnt patches at its foot) |
| noodle eel, sprout grub, jelly drop | 0.59, 0.68, 0.63 | 0.57 | in; rig-check passes on gf-worm-1 / gf-blob-1 |
| fizz blaster, firework rocket, prize trophy | 0.60, 0.65, 0.63 | 0.54 to 0.58 | in |
| bounce bomb | 0.47 → 0.45 | 0.42 → 0.37 | **made again** (the judge's one outlier: a dark navy bomb). The remake (cherry red, yellow band) still measures under the floor (saturated, and 106 triangles a metre on a 0.5 m prop); by eye it is in style, so it was kept and not made a third time |

**Placed by the world.** The set dressing is per level now: a look's `world.props.dressing` (plain words) is matched in the
look's own packs first, then the runtime's; a piece from the look's own pack is not held to the scene-palette floor
(it was judged against its anchor). The terrain world levels up to four **sites** away from the seats (`worlds/terrain`
`sites`, preferring places a seat looks at) and the scenery stands one landmark on each, with its collider from the
catalog (`art ingest --collider box|cylinder|trunk|none`, fitted to the measured size); the islands out at sea are
crowned with the same landmarks (no collider). Small props keep an even mix, and no one small prop takes more than a
third of the places.

**Re-rendered, per level, against the level-matched render before this wave** (the look judge's side by side, each
level held to its own reference frames; local sheets: `$XGK_EVAL_PRIVATE/looks/out/art-wave/`):

| Level | Before | After | The judge |
|---|---|---|---|
| sunny castle isles | 45 | 48 | after first: "its white tower with terracotta cone roofs brings in the toy-castle silhouette and colours" |
| violet dusk fortress | 44 | 46 | after first: "blue stone onion-domed tower, palm trees ... the cool blue-violet toy castles and island scenery" |
| sunset canyon sands | 40 | 42 | after first, slightly: "a rope bridge, leaning palms and a toy-like island structure" |

By eye: the pieces are the best art the case has had (one anchor per level holds each set together, and they read as
the kinds of things the levels show without copying them), but **the renders move little** (+2 to +3). The sheet's play
camera stands low and close (about 2 m behind the critter, 6 degrees down), so a landmark 10 m or more from a seat is
small at the edge of the frame or behind a hill; the references frame their castles in the middle distance from higher
up. What would move the look next is the camera and composition (a framing that shows the level's landmarks, landmarks
closer to the play), not more art.

**Coverage of the case** (`art coverage --case library/coverage/cases/artillery-levels.json`): before the wave 14 have,
6 off-style and 4 missing; after it **19 have and 5 off-style, nothing missing**. Every level set-piece row is "have"; the
off-style rows are the sunny palm (the scene measure again), held guns, the rocket, the prize and the health crate,
which the whole-case target reads as too saturated or too dense. Read "have" with care: the word match is loose (it
calls a brick a ruin and a wooden arch a rock arch), so the per-level rows the wave made are the ones to trust.

## 8. What a full art set costs, per kind

`recipe.mjs setItems(needs, {flat, setPieces})` prices a whole set for one look from `library/coverage/needs.json`: every
body, prop, texture and picture a need counts, made new in one style, plus 12 set pieces (two levels of six) and one
anchor a level. Fonts, sounds and what a runtime draws stay as they are. A flat kind's bodies, props and set pieces are
pictures (4 frames a body). The gap fill prices only the rows each kind lacks today (`art coverage`), with 6 set pieces
and one anchor.

| Kind | Whole set (credits) | Gap fill (credits) | What the gaps are |
|---|---|---|---|
| blocky | 2,459 | 654 | worms 2, a blob, quadrupeds 2, flyers 2, ranged 3, explosives 2 |
| calm | 2,459 | 666 | creatures (7), explosives, food 3, sand, a soil cross-section, clouds |
| dark | 2,459 | 630 | creatures (7), explosives, food 3, sand, a soil cross-section |
| lofi | 2,459 | 552 | a quadruped, a flyer, melee, ranged 3, explosives 3, an explosion |
| scenic | 2,459 | 588 | creatures (7), explosives, food 2, sand |
| silly | 2,459 | 624 | worms 2, a quadruped, flyers 2, melee, ranged 3, explosives 2, an explosion |
| drawn (2D) | 714 | 360 | monsters 3, creatures (8), melee 3, ranged 3, food 2, a soil cross-section (all pictures) |
| pixel (2D) | 714 | 324 | monsters 3, creatures (8), ranged, food, a soil cross-section (all pictures) |

A 3D whole set is 2,459 credits: 2 anchors (12), 72 concepts (432), 66 models (1,980) and Meshy's rig
on its 7 humanoids (35). All eight whole sets come to **16,182 credits, about two months of the plan**; filling only the gaps comes to **4,398**, about half a
month. A kind's set is one look; a game with several levels wants one anchor and its set pieces per level on top (this
wave: about 200 credits a level for five set pieces). The pixel and drawn sets are pictures; Meshy's image-to-image makes
them at 6 credits, but the kit's pixel tools or the session's own picture maker may suit those kinds better.

