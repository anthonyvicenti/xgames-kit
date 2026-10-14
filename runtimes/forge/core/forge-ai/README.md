forge-ai is track A's (research/rust-engine/PLAN.md §4): gf-forge's enemies and encounters, plugged into forge-core's
schedule (gf-forge/core/ARCHITECTURE.md), every number from the tables (`spec.forge.enemies`, `waves`;
gf-forge/kit/tables/enemies.js and waves.js declare every field, its default and range). The module list,
the commands (ops 96..=103), the events out (custom kinds 40..=45) and the rule events are in `src/lib.rs`'s header.

What runs:
- **Six archetypes on one body of rules** (`enemy.rs`): chaser, runner, caster, shield, brute, boss. Arrival from the
  ground; chase on a flow field; attack tokens (at most `attackers` on one player, the rest circle on a ring);
  eye-glow tells; the chaser's 0.5 m lunge in 67 ms, the caster's lane-seeking cast and orb, the shield region and its
  block, break and overwhelm, the brute's slam that knocks a player down (fair play: one a player per 3 s, ≤ 0.8 s),
  the boss's phases, roar, slams, combos, summons and charge; hit reactions by side (flash, white eyes, the hit clip,
  a spring on the bone hit), staggers and knockdowns with a get-up; crowd separation; stuck recovery (a detour, the
  grid learns the obstacle it missed, rising again elsewhere after six tries).
- **Navigation** (`nav.rs`): a walkable grid from the static world (ball overlaps at chest height), a flow field per
  target (Dial's algorithm), grid line of sight; a 30 m arena's field costs about 33 µs natively.
- **The wave director** (`director.rs`): spawn mix and pacing, emerge points 7-10 m from a player, wave rule events,
  the reward pause, the boss wave.
- **Bots** (`bots.rs`): forge players whose Control and Look a brain writes (fight, seek, wander), driven by OP_BOT
  from gf/forge/ai.js (the shared `p.bot` API, `rules.bot`).
- **The AI view** (`view.rs`): eye colour and intensity, the hit flash, state, flags, orb lights per row, the
  director, the boss bar: what the renderer (track R) draws and the JS reads.
- **Animation for crowds** (`anim.rs`): `core.anim` replaced by the same with enemies' poses every other step.
- **QA** (`profile.rs`, `fixture.rs`): per-system time; the AI fixture runner (gf-forge/fixtures/ai).

```bash
cargo test -p forge-ai                                                     # 10 tests (every fixture's targets too)
cargo run --release -p forge-ai --example ai-fixture -- gf-forge/fixtures/ai/chaser.json [--json] [--trace]
node gf-forge/tools/ai-tables.mjs --write                         # after enemies.js changes (a test holds Rust to it)
```
