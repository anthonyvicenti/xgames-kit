# Critter Lob (example)

Round little critters on a sunny lawn, 1–3 players (bots fill empty seats): hop about, grab berries for points, and lob
seeds to bowl a friend over. A bowled-over critter tumbles, rolls and pops back up. Most berries when the time runs out
wins.

```bash
npx gamesfun create games/my-game --from critter-lob
npx gamesfun dev games/my-game
```

What it shows:
- **Bodies that are not people** (`runtimes/three/kit/character/CREATURES.md`). The player's body is a blob
  (`characters[].body.archetype: "blob"`, the `gf-blob-1` standard): no clip file, procedural motion from the same words a
  person's clips answer (a waddling hop, a squash on landing, a lunge to throw, a jiggle when hit, a tumble when knocked,
  hops and a spin to celebrate). Friends see it move the same way from the pose alone.
- **A body per seat** (`characters[].seats`): each friend is a different critter. The spec names the looks pilot's three
  critters (Meshy models rigged by the kit's autorig, in a private pack); on a checkout without that pack every seat
  wears the kit's own CC0 slime (`xk-creature-bodies/slime-blue`, the `standIn`), tinted per seat.
- **Mechanics, not hand-written physics.** `projectile` (seeds from the hips of a small body), `pickup` (berries, E),
  `health` (a hit knocks over; a creature tumbles as one Rapier body and gets up where it lands). `rules.js` adds the
  celebration when a berry is taken and the bots.

Written for this kit (2026-10-14, the looks layer's body archetypes); no upstream code.
