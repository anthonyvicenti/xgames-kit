# mechanic: panels

The game's door to the shared panels (`kit/ui/panels`, CONTRACT §6j): a shop, an inventory (bar or grid), choice cards, a dialogue and a text field. It has no behaviour of its own and keeps no state. It brings **words** (one text slot per word of each kind in `params.kinds`: `mechanic.panels.shop-buy`, `input-ok`, ...) and **pictures** (every `assets/panels/<name>.png|jpg|webp|svg` is the image slot `panel.image.<name>`), and hands the panels to `rules.js`.

```js
const panels = ctx.mechanics.get('panels');
const shop = panels.shop({
  items: [{ id: 'boots', name: 'Swift boots', text: 'Run faster', price: 2, image: 'panel.image.boots' }],
  currency: { label: 'Coins', amount: coins },
  onChoose: ({ id }) => host ? buy(me.id, id) : ctx.net.send('buy', { id }, 'host'),
});
shop.update({ items, currency });                       // after a purchase
const r = await panels.dialogue({ speaker: 'Guide', lines: ['Hello!'], choices: [{ id: 'yes', text: 'Hi' }] }).done;
```

Prices, money, stock and what a purchase does are the game's (a shop returns `{id}`; it never moves a coin). A panel is local to the copy that opens it: `for: player.id` opens it on that player's copy only, and an answer is sent to the host with `ctx.net.send`. A panel never pauses the round; a modal one covers the player's own input only. A call that cannot work is refused with the fix in the console (check 3 reads it) and nothing is drawn.

Reference game: `research/gf-three/regressions/bases/coin-corner` (pickup coins, all five kinds, about 70 lines of rules). Check 15's sign is reported only: it is dead when a call was refused.
