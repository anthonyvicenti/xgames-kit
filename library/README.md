# The asset library

One library of packs for every runtime, 2D and 3D alike, and the only index of art in the kit. A pack is one licence,
one pinned source, one owner and one visibility; every asset in it has one manifest (`packs/<pack>/assets/<id>.json`,
schema `library/schema/asset.schema.json`) and one preview (`packs/<pack>/previews/<id>.png`). Style is measured at
ingest (the signature in each manifest's `fits.signature`) and judged on the kinds' contact sheets (`fits.kinds`); it is
never a folder.

| Where | What | In git |
|---|---|---|
| `packs/<id>/pack.json` | the pack: licence, source, owner, visibility, signature, fits | yes |
| `packs/<id>/assets/*.json`, `previews/*.png` | one manifest and one preview per asset | yes |
| `packs/<id>/sources.json` | what a manifest leaves out: where the asset was before, full descriptions, roles, play data no manifest field holds yet (a compound collider, a door, what a prop hosts), the measured signature in full, each validator's whole report | yes |
| `packs/<id>/LICENSE.txt` | the licence, its text and every credit line | yes |
| `defaults/sha256/ab/<sha256>` | the small default set the kit ships: the binaries its runtimes, examples and kinds use by default | yes |
| `~/.xgames/store/sha256/ab/<sha256>` | every other binary, by its hash (what ingest, fetch and generate keep) | never |
| `~/.xgames/private-packs/packs/<id>/` | private packs (a paid maker's output, a game's generated art, anything not to be published), laid out as above | never |
| `~/.xgames/quarantine/<sha256>/` | files offered with no licence record | never |

`library.json` holds those paths (each can be overridden by a variable). Where private packs live is an open creator
decision; the default keeps them in the person's home. `policy.json` is the licence policy (own, CC0, MIT and the
other permissive licences first; CC-BY only with its credit line written into the game; a paid maker's output only
with that account's key and the creator's yes); the floor is an open creator decision and is changed there, never in
code. `words.json` is what the resolver reads to match a slot's words (stop words, families of words).

## Commands (`gamesfun art …`, the same as `node builder/art/cli.mjs …`)

```
gamesfun art find "wooden bridge" --kind scenic --3d [--devices phone]
gamesfun art fill <game folder> --kind silly [--write]   every file slot of a game, filled by need and fit
gamesfun art objectives <game folder> [--yes]             what the game's objectives draw, filled by meaning: the
                                                          library, else a maker in the look's style (paid: --yes)
gamesfun art ingest <file|folder|zip|url> --pack <id> [--include <glob>] [--style pixel|drawn] [--licence <spdx> --author … to start a pack]
gamesfun art fetch <pack>/<asset> [--to <file>]           bytes from the store, the default set, a mirror, or rebuilt
gamesfun art check                                        every manifest against the schemas, every binary on this machine
gamesfun art generate --slot <id> --words "…" [--yes]     a model made for a slot (paid: only with --yes)
gamesfun art coverage [--kind <k>] [--case <file>] [--json]   what the library holds for a look: have / off-style / missing / code
gamesfun art harmonize --pack <id> --look <target | config/look.json | game | kind> [--level <id>] [--style pixel|drawn] [--dry]
                                                          the style pass baked: a pack's assets moved toward one look as
                                                          NEW assets in a derived pack (`harmonized` names each original);
                                                          the originals are never written (builder/look/README.md)
```

`COVERAGE.md` is the coverage report: everything we own or may use and its licence, the matrix of what each kind's look
asks for against what is in its style, the artillery proving case, the Meshy pilot judged and the Meshy plan with
credits. `coverage/needs.json` lists what a look asks for; `coverage/cases/*.json` hold a case (a look target, its
needs and its Meshy wave). `builder/art/wave.mjs` makes a case's wave with Meshy, concept art first from one style anchor
(`builder/art/recipe.mjs`), into a private pack.

The MCP server offers the same as `gamesfun_art_find`, `gamesfun_art_fill`, `gamesfun_art_ingest` and
`gamesfun_art_generate`.

Ingest detects the format, optimizes a GLB (dedup, prune, textures capped, meshopt; KTX2 with `--ktx2` when toktx is
installed) or normalizes a PNG, drops a file whose sha256 is already in the library, renders the preview on the
headless GPU, runs the validator (rig-check for bodies, the flat judge for pixel and drawn art, the sound gate for
sounds, budgets for props), measures the signature and writes the manifest. A file offered to a pack that does not
exist, with no licence given, goes to the quarantine folder and never into the index.

The resolver (`builder/art/resolve.mjs`) answers a slot's need: category, dimension and rig must match; a failed
validator or a licence outside the policy is never offered; then the kind's named assets and packs, the words, the
device budgets and the licence order rank what is left. A mix outside the kind is allowed and reported as a finding.
When nothing fits it says so and names the next step (a connection), never a silent stand-in.

## How the kit uses it

- **The art order** is: what the person provided, the library, a connection (a paid maker on the person's own key), the
  person's own session, the kit's stand-ins (`builder/art/providers.mjs`).
- **create** fills a new game's default slots through one call, `libraryFill()` in `builder/art/fill.mjs`: a missing
  file slot takes the asset of its own name in the runtime's packs, then the resolver's pick for the game's kind.
- **The runtimes** read the library through `builder/art/views.mjs`. A runtime's own names (a world template's prop
  ids, a default body, a "library:<id>") resolve in the packs it lists, in order: `runtimes/three/art.json`, the scenic
  profile's `art.json`, the forge's `cast.json` (which also holds what the forge draws by role and each piece's play
  data). Any name may also be a full ref, `<pack>/<id>`.
- **Generated art** (a spec's `fill.from: generate`, the build loop's generate rung, the Studio worker) is the
  connection step: `builder/art/generate.mjs` calls the maker (Meshy first), takes the model into the game's private
  pack (`game-<folder>`, LicenseRef-Meshy-Paid) through ingest, and fills the slot from it.

## Where a binary comes from

`fetchAsset` (`builder/art/store.mjs`) looks, in order: the local store; the kit's default set (`defaults/`); each
mirror in `library.json` (`mirrors`, or `XGAMES_MIRRORS`: a folder, or a URL with `{sha256}` and `{ab}` in it); the
pack's pinned source, when the asset is that file unchanged; and the pack's rebuild line, when it is an `art ingest` of
a pinned zip (`builder/art/rebuild.mjs`: the zip is downloaded, its sha256 checked against the pack's, and ingest
replayed; Kenney Tiny Town rebuilds 132 of 132 files byte for byte). Every file is checked against its hash before it
is kept.

Today that means: the default set (the 670 binaries the runtimes and examples used before the library, the kinds' fonts
and block bodies, the vista core's world and sounds) is in every clone; the 2D Kenney packs ingested from their zips
(Tiny Town, Tiny Dungeon, the New Platformer Pack, Toon Characters, Background Elements) rebuild from kenney.nl on first
use; the 18 retargeted Kenney blocky characters rebuild the same way through their retarget step. Nothing else is
reachable from a fresh clone until a mirror exists.

### A public mirror (a creator decision, not built)

What it would be: a read-only, content-addressed bucket of every public pack's binaries, `https://<host>/sha256/<ab>/<sha256>`,
listed in `library.json` → `mirrors`. Fetch already reads it and checks every hash, so a mirror needs no trust: a
wrong or tampered file is refused. Publishing is one command over `library/packs` (every public asset whose bytes are
in the store), run by the maintainer after an ingest. Private packs are never published.

Choices for the creator:
1. **Where:** a Cloudflare R2 bucket with a public custom domain (no egress fees; the play host already uses Cloudflare),
   or GitHub release assets on the public xgames-kit repository (free, but 2 GB per file and a release per upload), or
   the Vercel play host's static storage (already deployed; bandwidth is billed).
2. **What it holds:** every public pack (about 75 MB today, growing with every ingest), or only what the default set
   does not (then the default set stays in git), or everything with the default set leaving git (smaller clones, but a
   clone then needs the network before its first game).
3. **Who may publish:** the maintainer only (recommended), or CI on merge to main.

Until then the default set ships in git and `art fetch` rebuilds what has a rebuild line.

## Gaps (2026-10-13, and 2026-10-14 from the coverage audit: `COVERAGE.md` §6)

- Body archetypes (2026-10-14, closed): a worm, blob, four-legged or flying body is on its own rig standard
  (`runtimes/three/kit/character/CREATURES.md`; a body manifest's `use.rig` and `use.archetype`). rig-check judges it with
  the creature judge, `art ingest --autorig <archetype>` (or `gamesfun art autorig`) rigs a plain mesh, and
  `xk-creature-bodies` holds one stand-in of each. The pilot's three critters are rigged as blobs in
  `looks-pilot-artillery` (`*-blob`, private); Meshy's own rig of the moss-mole (`moss-mole-rigged`) stays failed.
- The style measures in `builder/art/coverage.mjs` read grey or white objects as off-style and a words-only target as
  more saturated than any rendered asset: a guide for where to look, not a verdict.
- `quiver-outpost-fx` and `xk-artillery-icons` are reachable only from the store that ingested them until a mirror exists;
  the `kenney-*-full` packs and the particle pack rebuild from their pinned zips, the two fonts fetch from GitHub.

- `kenney-background-elements-remastered`: nine small trees are under gf-flat-1's 64 px floor for a drawn prop and fail
  the flat judge; the resolver never offers them.
- `vista-core-world`: the two keepers (joe, marta) are the vendored core's own Rocketbox figures; its stall and guide code
  animates them on their own rig. Putting them on gf-humanoid-1 needs that core code changed, so they stay as they are
  (their manifests say rig rocketbox, so no gf-humanoid-1 slot is offered them).
- `quaternius-ual-bodies/ual-mannequin-standin`: the stand-in tier's mannequin, on the Universal Animation Library's
  own bone names; rig-check fails it, so the resolver never offers it (the passing `ual-mannequin` is the body).
- The schema has no place yet for a compound or ramp collider, a door, what a prop hosts, a non-hex light colour or a
  material role: they live in the pack's `sources.json` under the asset (`views.mjs` reads them); `SCHEMA-REQUESTS.md`
  is the record of the earlier requests.
