# The economy's buttons in a game

**You don't write them.** The page that hosts the game offers the economy's actions, and the kit's menu and HUD
draw them (gf-three CONTRACT §6g W2). A game with no economy, or a game opened with no page that offers one, shows
nothing of it, so it looks exactly as before.

## How they get there

1. **The economy is the spec.** Every action a player can take comes from the `economy` section of `gamesfun.json`:
   an item for sale is a Buy, a box is an Open, a lottery is Buy tickets, a stake is Stake and Unstake, a contest is
   Enter, a recipe is Craft, a hold is Hold, and whatever is due is Claim. `playerActions(economy)`
   (`builder/web3/economy/actions.mjs`) is that list: `[{ id, part, kind, label, price, says, where, asks }]`. The label is
   the part's name, `says` is what it does in a player's words (prices and odds included).
2. **The page offers them.** `{ type: 'gf:host', v: 1, …, economy: { actions: [{ id, kind, label, price, says, where }] } }`,
   and on every change `{ type: 'gf:economy', v: 1, balances, tickets, stakes, claimable, pending, error }`.
3. **The kit draws them where `where` says:**
   - `menu`: buttons in the wallet view (from the home menu or the pause menu), under the wallet;
   - `pause`: buttons in the pause menu, under the wallet button;
   - `results`: buttons on the results card, between the scores and Play again (alone; with friends the party
     page's card is the result and has none);
   - `hud`: lines in the HUD's player card (a balance, tickets, a stake, what is claimable), once the page's state
     has one.

   For now the spec has no field for `where`: a claim goes to `results` and everything else to `menu`.
4. **A click only tells the page**: `{ type: 'gf:econ-action', id }`. The page asks the player's wallet, signs with
   gf-web3 (`gfWeb3.economy.act(id)`), and sends a new `gf:economy`. While an action's id is in `pending` its button
   waits ("…", disabled); `error` shows under the buttons in the player's words.

## What you can change

- **Which buttons exist, their names and prices:** change the economy spec (`economy_save`, or the Economy tab).
- **What a bought item does to its owner:** its `look` (`cosmetics.md`).
- **Nothing in the game's code.** No overlay, no `gf/web3/` import, no price in `rules.js`, no `ctx.economy` (there is
  none). Rules never see the economy: a game is never scored by what someone paid.

## Checking it

`gamesfun verify` check 22 frames the game in a stand-in page: with no offer nothing of the economy is on screen;
with one action per place, each button shows only where its `where` says, a real click sends `gf:econ-action` with its
id, and the HUD line follows the page's state. `window.__game.menu().economy` and `window.__game.hud().economy` show
what was offered, the state and the clicks.

## Before the economy

Games made with gf-web3 2.0.0 drew their own shop: a DOM overlay in `rules.js` calling `gfWeb3.shop.buy` and
`gfWeb3.openBox`. Those games keep working (gf-web3 reads their old `shop` as the economy it stands for), but don't
write a new one: the kit's menu draws the same buttons, signed by the page, for every game.
