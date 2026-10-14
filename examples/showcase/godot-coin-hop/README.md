# Coin Hop (showcase candidate, runtime godot)

A side-on scramble on runtime godot: jump the ledges and grab more coins than your friends. The coins are marks on the
map (`world.map`, legend `o`); `files/project/main.gd` draws them and reports a touch with `GF.event("coin", {i})`;
`rules.js` owns them on the host (`ctx.shared`), gives the point and takes the coin for everyone. `files/tests/
coins.play.mjs` is the game's own two-player test (verify's measure 35).

```bash
npx gamesfun create games/coin-hop-godot --from godot-coin-hop
npx gamesfun verify games/coin-hop-godot
```

A candidate, not yet a showcase: the creator has not named a reference game for it and nobody has played it. The same
idea on the three runtime's flat profile is `examples/minimal/coin-hop`.
