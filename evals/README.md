# evals/

The frozen eval sets and their runner: `paired/` (the phase 5 gate, old loop against new), `breadth/` (one prompt for
each of the 25 most-played archetypes), `depth/` (one showcase per kind, judged blind), and `cases/` (T1 to T7 as spec
v2). **Append only**: a set is frozen with a date and a hash and never edited; a better case is a new case. How a run
works: [RUNNER.md](RUNNER.md). Records go to `evals/records/` (git-ignored); private inputs stay outside the
repository (`XGK_EVAL_PRIVATE`).
