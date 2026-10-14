# mechanic: loot

Drops and choices (gf-scenic wave 1, track M): kills drop coins and sometimes a heal potion (`potionChance`, `potionHeal`) or a weapon (`weaponChance`, the melee mechanic's table, a rarity colour); chests open with interact (E) and spill more; the boss drops a pile and an epic weapon; between levels every player picks one of three upgrade cards (`upgrades`: +damage, faster swings, a shorter dash cooldown, +reach, +knockback, heal to full). Coins count on the HUD.

## Taking things
Coins and potions are taken by walking over them (`touch`; they drift toward a player within `magnet`). Chests and weapons take a press of E within `reach`, with the HUD's prompt ("E: open the chest", "E: take the Axe (epic)"); a weapon taken swaps with the one in hand, which is left where it lay. The cards show at the bottom of the player's screen; a click or the keys 1–3 pick. Bots pick a card after `botPickSeconds`. A +max-hearts card is not offered: the health mechanic has one maximum for everyone.

## What shows
Models: the mechanic's own slots when the game has the files (`assets/models/loot-chest.glb`, `loot-coin.glb`, `loot-potion.glb`: e.g. KayKit's dungeon chest and coin from `research/gf-scenic/library`; the chest's lid, `chestLid`, opens on `chestHinge`), else `prop.<coinProp|potionProp|chestProp>`, else kit primitives in `coin-color`, `potion-color`, `chest-color`, `chest-trim`. Sounds `loot-coin`, `loot-potion`, `loot-chest`, `loot-weapon`, `loot-upgrade`.

## Network ownership
**Host owns** the drops, coins, upgrades and offers. A player's copy takes what its player walks over or presses E at and asks the host (`loot:take` {i, e}); the host checks the distance and applies it. Picks: `loot:pick` {s, i}. Shared `loot`: `d` (`[id, kind, x, z, weapon, rarity]`, at most `maxDrops`), `c` (coins per player), `u` (upgrades per player), `o` (the offer: `[serial, [ids]]`), `p` (the last serial each player picked), `e` (the last take, for its sound everywhere). Events at most a few a second.

## Methods
`coinsOf(p)`, `upgradesOf(p)`, `modsOf(p)` (the melee mods), `drops()`, `drop(kind, x, z, extra)`, `dropFor(enemy)`, `placeChests(n, zone)`, `offerUpgrades()`, `take(p, id)` (host); `interacts`, `interactables()` (verify check 13 opens a chest with E).

## Fixture and tests
`node research/gf-three/tests/k2-fixture.mjs loot` (a coin, a weapon with E, a chest, an upgrade card: the same on both copies). Pure logic: `tests/k2-loot.test.mjs`.
