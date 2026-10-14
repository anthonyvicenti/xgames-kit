# Table Four (example)

Four in a row played from the seats, for 2 to 4 players (alone, bots take the other seats). Players take turns: on
your turn point at a column and click (or press E); your disc slides in. Four in a row wins; a full board is a draw.

```bash
npx gamesfun create games/my-game --from table-four
npx gamesfun dev games/my-game
```

What it shows:
- **A board game where nobody is a character, and how a friend is seen there.** The `board` mechanic plays
  `"presence": "cursor"`: each player's body sits at their side and they point with a mark in their colour. With no
  character to look at, the kit shows each friend by presence (`gf/mp/presence.js`, shape `seats`): a seat card down
  the left edge with their name, colour and an avatar that reacts (thinking on their turn, placed just after a move,
  won or lost), their pointer moving over the board with their name, and a ring in their colour where each of their
  discs lands, on every screen. Nothing in `rules.js` draws or sends any of it.
- **The turns loop and the board mechanic**, as in `giant-four`: the host owns the board, a move out of turn is
  refused with the reason, and `rules.js` is only the winner rule.
- **Every colour and number is a slot**, the avatar (`ui.avatar`) and the words under it (`ui.mood-*`) too.

Provenance: written for this kit (the friends-default stream, 2026-10-14), from `giant-four`'s rules. Same owner as
this kit (THIRD_PARTY.md).
