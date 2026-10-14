// Today's `shop` section of gamesfun.json (loot program 0.1/0.2: one currency, collectible items, boxes of items)
// → an `economy` section on loot 0.3. The pure `migrateShop` is the in-game kit's (builder/web3/gf-web3/econ/shop.js: no
// Node import, so the game page reads a shop through the same function); the Economy tab shows a game's shop through
// it and saves the economy (builder/web3/node/economy-routes.mjs). There is no command that rewrites a game's file.
//
// Program 0.3 lives at a new address, so a shop that was live on 0.1/0.2 is not live here: its addresses are kept
// under `economy.previous` for the record, and the economy goes live fresh (a new collection and game).
export { keyFrom, leaveOldProgram, migrateShop, shopOnLoot03 } from '../gf-web3/econ/shop.js';
