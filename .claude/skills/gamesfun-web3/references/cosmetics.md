# The cosmetics loop: own it, wear it, everyone sees it

An item's `look` is a **gf-three loadout fragment** (gf-three CONTRACT §6e), written on the item in the game's
economy spec (`economy` → `items[].look`, with `economy_save` or the Economy tab). It holds the player-look slots that
owning the item changes:

```json
{ "values": { "character.tint.player": "#ffcc00", "mechanic.projectile.color": "#2457ff" },
  "files":  { "character.hat.player": "assets/models/hat-gold.glb" } }
```

- **Slots.** These are the game's `scope: "player"` slots. Ask `web3_player_looks`, or read
  `assets.json`. Every gf-three game has `character.tint.player` (body colour),
  `character.hat.player` and `character.body.player` (models), and each aimed mechanic's
  `mechanic.projectile.color`.
- **Values.** A colour is `#rrggbb`. A number, a toggle or an enum option is also allowed.
- **Files.** A file is a path inside the game, or an https URL every player can load. A body has to
  be a gf-humanoid-1 rig. `data:` and `blob:` URLs are refused.

## Wear what the player owns

**No code.** The kit's wallet view (home menu or pause menu, gf-three CONTRACT §6g W1) lists the items the page says
the player owns, each with **Wear**. A click sends the page `gf:wear`; the page builds the loadout from the items' looks
and answers with `gf:loadout` (§6e). gf-three's `kit/net/looks.js` applies it to this player, and every other copy in
the match draws it too (the `lk`/`lo` loadout messages). You write no wallet, ownership or multiplayer code for this,
and `rules.js` never imports `gf/web3/`.

- **One item per slot.** The page decides which owned item fills a slot until the player picks one with Wear
  (gf-web3's own rule, page side: the rarest wins, and the choice is remembered per game and wallet).
- **Invalid looks are dropped.** gf-three checks the loadout against the game's slots again and drops anything that
  doesn't fit (P4: never fatal).
- **Guests** wear the game's defaults.
- **Checking it:** verify check 22 frames the game in a stand-in page with a test wallet and two items, presses Wear,
  and checks the player is drawn in the item's colour. `?gf-loadout=` (§6e) previews a loadout with no page at all.

## Making a look exist

When an item should change something the game doesn't have yet (a rainbow skin, a trail), add a
player-look slot to the game first (gf-three CONTRACT §6e: `config/game.json` → `loadout.slots`,
`tools/slots.mjs`). Then set the item's `look` to it in the economy spec. Once players own copies, an item's look can't
change. Make a new item instead.
