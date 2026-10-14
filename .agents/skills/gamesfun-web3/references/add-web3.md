# A game made before the economy: the shop and the `web3_*` drafts

New work starts from the `gamesfun-economy` skill: the economy spec covers a shop and much more, and the kit's menu
draws its buttons. This page is for a game that already has a `shop` in its `gamesfun.json`, or a creator who uses the
older shop commands.

## 1. Nothing goes in the game's code

`npx gamesfun create` copies the in-game kit into every game at `gf/web3/` and writes a `gamesfun.json`
stub there. Like everything under `gf/`, that copy belongs to the kit, so never edit it, and don't import it from
`rules.js`: the page that hosts the game runs it, and the kit's menu and HUD show the wallet, the owned items and the
economy's buttons (gf-three CONTRACT §6g W1, W2; `buy-button.md`). A game whose `rules.js` already calls gf-web3 keeps
working: gf-web3 reads an old `shop` as the economy it stands for.

## 2. Draft the shop (no signature needed)

The shop drafts still work and change only `gamesfun.json`:

```bash
npx gamesfun web3 status --game games/bean-brawl
npx gamesfun web3 currency SOL                     # or USDC, token (the game's own), or a mint
npx gamesfun web3 item add --name "Golden Hat" --picture assets/hat.png --rarity Rare --price 0.05 \
  --look '{"values":{"character.tint.player":"#ffcc00"}}'
npx gamesfun web3 item add --name "Ice Skin" --picture assets/skin.png --rarity Epic   # no price: boxes only
npx gamesfun web3 box add --name "Mystery Box" --price 0.01                           # odds from rarity
```

The MCP tools are the same operations: `web3_status`, `web3_list_pictures`, `web3_player_looks`,
`web3_add_item`, `web3_update_item`, `web3_add_box`, `web3_set_currency`, `web3_link_token`.

- **Pictures** must be PNG, JPEG, WebP or GIF files inside the game folder (`web3_list_pictures`).
  Up to 100 KB is free on Irys devnet. A bigger picture asks the wallet for a small SOL deposit first.
- **What an item does in the game** is its `look`. Its slot ids come from `web3_player_looks`. See
  `cosmetics.md`.
- **Currency.** A shop needs no token. It can be priced in SOL or in any token, classic SPL or
  Token-2022, and the currency is fixed once it is live.
- **A token** is optional. To use one the creator already has, launched anywhere (games.fun takes no
  share of its fees), use `gamesfun web3 link --mint <address>`. To launch one with games.fun (the
  creator keeps 95% of its trading fees, games.fun gets 5%), see step 4.

## 3. Move it into the economy

A shop is part of the game's economy now (the Economy tab replaced the Token and Shop tabs). It moves on its own when
it goes live and when the Economy tab saves; to move it now and keep going with the `economy_*` tools, open the
Economy tab and save it there. Its items and boxes keep their names, prices
and looks. A shop that was live on loot 0.1 or 0.2 is kept under `economy.previous` and goes live fresh on 0.3.

## 4. Ask the human to approve

```bash
npx gamesfun web3 launch --name "Bean Brawl" --symbol BEAN --picture assets/icon.png   # optional; paired with SOL
#   --pair USDC (or a mint), --buy 0.5 (in the pair), --sol-usd 150, --start-cap N --graduation-cap N
npx gamesfun web3 shop publish
```

Or use `web3_prepare_launch` and `web3_prepare_publish`. Each one prints a step for the human. Relay
it as-is: "Open the studio's Economy tab and press **Review and approve**." The studio shows every step
before the wallet asks (`creator-flow.md`). Afterwards, `npx gamesfun economy status games/<name>` shows each part on
chain.

## 5. Check it

- Owned cosmetics: `cosmetics.md`
- The economy's buttons in the menu: `buy-button.md`
- Test it: `testing.md`
