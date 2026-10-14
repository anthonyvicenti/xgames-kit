# examples/showcase/

A showcase is a quality bar, not an API sample: one per kind, built against a reference game the creator names, with
captures, pinned versions and evidence beside it, judged blind (clarity, feel, look, "would play again") and then by
the creator. Each folder holds what a minimal example holds (`spec.json`, `rules.js`, `README.md`, `example.json`) plus
its `captures/` and its evidence, and `gamesfun examples` lists it with the minimal ones (`builder/lib/examples.mjs`).

Empty for now: the depth pass makes the first ones. The examples that pass verify today are in
[`../minimal/`](../minimal/). Where everything else is: [docs/LAYOUT.md](../../docs/LAYOUT.md).
