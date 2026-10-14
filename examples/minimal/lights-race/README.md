# Lights Race (example)

A lights out race for 2 to 4 players, each on a board of their own (alone, bots race you). Everyone gets the same
board of lights; press a light and it and its four neighbours switch. The first to switch every light off wins.

```bash
npx gamesfun create games/my-game --from lights-race
npx gamesfun dev games/my-game
```

What it shows:
- **Own boards, and how a friend is seen there.** The spec says `"together": "own-board"` and the `board` mechanic
  plays `"boards": "own"`: every player has their own board at once, no turns. Nobody is a character here, so the kit
  shows each friend by presence (`gf/mp/presence.js`, shape `boards`): their board live down the right edge, framed
  in their colour, with their name, score and an avatar on its rim; their pointer and each press show on it as they
  make them. Your own card stands at the left. Nothing in `rules.js` draws or sends any of it.
- **One opening for everyone.** The host deals a seed for the round; `start(s)` makes the board from `s.data.seed`,
  so every board starts the same.
- **The host decides who won.** Each copy owns its own board and sends it through the presence part; the host reads
  every board with the game's `winner` rule and ends the round on the first one cleared.
- **Every colour and number is a slot**, the avatar (`ui.avatar`) and the words under it (`ui.mood-*`) too:
  `npx gamesfun slots list games/my-game --all`.

Provenance: written for this kit (the friends-default stream, 2026-10-14). Same owner as this kit (THIRD_PARTY.md).
