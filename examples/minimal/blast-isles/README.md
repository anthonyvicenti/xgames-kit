# Blast Isles (example)

Turn-based artillery with physical comedy, built only from shared parts a spec picks. Take turns: look where you want
the shot to go, hold primary to charge, let go to fire, mind the wind. A blast throws every critter near it flying; they
tumble, bounce, bowl each other over, and splash into the sea.

```bash
npx gamesfun create games/my-isles --from blast-isles
npx gamesfun dev games/my-isles
```

What it shows:
- `components/aim`: the ballistic aim (power charge, the view's pitch as the angle, wind per turn on the HUD's strip, a
  trajectory preview, weapons as data on the weapon wheel), joined to the `turns` loop: one player acts, the others hold
  still, the camera follows the shot on every screen, the turn passes when everything has come to rest.
- `components/knockback`: a blast throws every body in range; the host simulates each flight once (bounces, the sea,
  the bodies it bowls over) and every copy plays that path, the critter tumbling on it.
- `components/carve` with `collapse`: craters, and the ground they leave hanging falls.
- `components/hazards`: the sea takes a critter out for a moment; it comes back on dry ground every seat can reach.
- `ctx.juice`: shake, hitstop and slow motion sized by each blast, within the player's Reduce motion setting.

`rules.js` only scores. The bodies are the looks pilot's private critters when they are on the machine, else the kit's
CC0 stand-in blob (`xk-creature-bodies`).

Provenance: written for this kit (2026-10-14). Same owner as this kit (THIRD_PARTY.md).
