# registry/

The catalog computed from manifests: for every runtime, profile, loop, mechanic and kind, whether it **exists** in code,
**passed its tests**, and is **open** to pitches. The pitch offers only what is open, and "can calm run on forge?" is
answered here from manifests, never from prose or a keyword. The runtime × kind matrix is a view of this, never a
folder tree. The registry assists and never refuses an idea: what a runtime lacks is a build item in the spec; only a
hard limit (a device it does not run on, a camera rig it has not got) rules a runtime out.

| File | What |
|---|---|
| `build-catalog.mjs` | reads the manifests, checks each against its schema and against each other, writes `catalog.json`; `--check`, `--matrix`, `--can <kind> <runtime>[/profile]`, `--which devices=phone camera=first …`, `--spec <file>`; exports `buildCatalog`, `can`, `which`, `checkSpec`, `compat`, `createRegistry` |
| `catalog.json` | what it wrote (its inputs hashed: `tests/registry-catalog.test.mjs` fails on a stale one; rebuild it with `node registry/build-catalog.mjs`) |
| `schemas.mjs` | every schema of the kit loaded into one validator (`loadSchemas()`, `SCHEMA.<name>`) |
| `schema/` | the manifests' schemas (runtime, loop, mechanic, kind, common, catalog), each with valid and invalid examples |
| `capabilities.json` | what a profile can do and a mechanic gives; a ledger row's `needs` names them |

The manifests: `runtimes/<id>/runtime.json`, `loops/<id>/loop.json`, `components/<id>/mechanic.json`, `kinds/<id>.json`.
`create` holds a spec v2 to this catalog (`builder/tools/lib/spec.mjs`), `npx gamesfun catalog` and the MCP tool
`gamesfun_catalog` read it, and the build loop's foundation chooses from it. Where everything else is:
[docs/LAYOUT.md](../docs/LAYOUT.md).
