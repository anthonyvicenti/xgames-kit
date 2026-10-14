---
name: gamesfun-web3
description: How web3 reaches a games.fun gf-three game (Solana devnet) - the wallet, owned items and their looks, and the economy's buttons in the kit's own menu and HUD - and the old shop and token commands. Use when the user asks for NFTs, items, cosmetics, skins, a wallet or sign-in in their game, when a game's gamesfun.json, gf/web3 kit, `gamesfun web3` command or web3_* tools come up, or when someone asks how an economy's buttons get into a game. To design an economy (shop, loot boxes, lotteries, staking, crafting, a token), use the gamesfun-economy skill.
---

# Web3 for a games.fun game (devnet)

A game can have an **economy**: a token, collectible items (Metaplex Core NFTs), loot boxes rolled on chain with
MagicBlock VRF, lotteries, stakes, crafting and more, all on games.fun's loot program 0.3. Players can play as
**guests**. A wallet is optional. Everything runs on **Solana devnet**. This kit has no mainnet.

**The game's agent writes no wallet or economy code.** The economy is data: the `economy` section of the game's
`gamesfun.json`, designed from the creator's words with the `gamesfun-economy` skill and the `economy_*` tools. The
buttons come for free:

- The page that hosts the game owns the wallet and signs (the games.fun `/play` page does the wallet today; the
  studio's preview, being built, is the first page to offer an economy). It offers the economy's actions to the game through `gf:host` → `economy.actions`
  (`{ id, kind, label, price, says, where }`) and says the player's state in `gf:economy`.
- The kit's own home menu, pause menu, results card and HUD draw each action where its `where` says, and a click only
  tells the page (`gf:econ-action`). The page signs (or not) and answers with a new state (gf-three CONTRACT §6g W2;
  verify check 22 plays it). W2 is in this kit (`builder/ui/menu.js`, `runtimes/three/kit/net/host.js`); a game made
  by an older kit without it draws no economy buttons, and the answer is to create it again, not to write them.
- The wallet itself, the player's items and **Wear** are in the kit's menu too (§6g W1). Wearing sends the page a
  `gf:wear`; the page answers with the loadout, gf-three applies it, and every player in the match sees it.

So `rules.js` never imports `gf/web3/`, never signs, never prices and never draws a shop. `create` still
copy the in-game kit to `gf/web3/` (it belongs to the kit, never edit it): it is what the page runs, as
`gfWeb3.economy.*` (`references/api.md`). An older game whose `rules.js` already calls gf-web3 keeps working.

| Part | Who | Where |
| --- | --- | --- |
| Design the economy (token, items, boxes, prices, lotteries…) | You, from the creator's words | the `gamesfun-economy` skill, the `economy_*` tools, the studio's **Economy tab** |
| Put it live | The creator, in their own wallet | the Economy tab's "Put it live" (`economy_publish` hands over the link) |
| The buttons, the HUD lines, the wallet, owned looks | Nobody writes them | the kit's menu and HUD, fed by the page (§6g W1, W2) |
| What owning an item changes | You, in the item's `look` | `references/cosmetics.md` |
| Signing a player's moves | The page, with the player's wallet | gf-web3 `gfWeb3.economy.*` (page side only) |

## Rules (always)

1. **You never sign, and you never ask for keys.** Going live leaves a **request** or a link. Tell the human to open
   the studio (`npx gamesfun dev games/<name>`), go to the **Economy tab**, look it over, press the button and confirm
   in their wallet. Never ask for a seed phrase, a private key or a keypair file. If they decline, don't repeat the
   request.
2. **Never put a secret in a game.** A game folder is public: `gamesfun.json`, game code, pictures. That rules out
   private keys, seed phrases, API keys and keyed RPC URLs (`?api-key=`, Helius, QuickNode). The creator's RPC goes in
   `gamesfun web3 settings --rpc <url>` (the kit's git-ignored `.gamesfun/`). See `references/secrets.md`.
3. **Guests play.** Never block a game on a wallet. The kit's menu asks for one only when the player presses Connect
   or an economy button.
4. **No wallet or economy code in the game.** Not in `rules.js`, not in `main.js`, never under `gf/`. If a game needs
   a button the economy doesn't offer, change the economy (the spec), not the game.
5. **Don't hand-edit addresses in `gamesfun.json`.** Ids and `live` are written when it goes live. Change the spec
   through the `economy_*` tools or the Economy tab. Schemas: `builder/web3/economy/economy.schema.json`,
   `builder/web3/gamesfun.schema.json`.
6. **Ownership is read from the chain, and loadouts are trusted on the client for now.** That's fine for cosmetics.
   Don't sell power: an item changes how a player looks, not how the game is scored.

## Do this

- Design an economy from a sentence: the `gamesfun-economy` skill.
- Make an item change how its owner looks: `references/cosmetics.md`
- What the creator approves and what it costs: `references/creator-flow.md`
- Test it: `references/testing.md`
- The page side (`gfWeb3.economy.*`, what the page runs to sign): `references/api.md`
- A game made before the economy, with a `shop` and the old `web3_*` drafts: `references/add-web3.md`
- How the in-game buttons work, and the old hand-drawn shop overlay: `references/buy-button.md`
