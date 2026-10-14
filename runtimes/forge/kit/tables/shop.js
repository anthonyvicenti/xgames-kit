// spec.forge.shop: coins worth spending (gf-forge wave 7, track P; owner: forge-feel, research/gf-forge/core/forge-feel/
// src/shop.rs for what each item does, the prices and the purse; the cart's screen is the kit's, gf/forge/shop.js).
// The creator, 2026-10-12: "Also coins still cant be used for much". Asked what coins should buy, they chose the
// pedlar's cart between waves and paying to revive a friend.
//
// Every player keeps a purse: the coins they picked up, less what they spent (the core's, the host's to keep; the HUD's
// coin count is it). With `on`, after a cleared wave (every `every`-th, from wave `from`) the pedlar's cart opens for
// `seconds`: three cards dealt for each player on show at the top (when the cart sells cards), the items under them with
// their name, price and what is left, and the fight goes on when every player has pressed Done or the time is up. On a
// wave with a reward the reward's cards and the cart share one screen and one timer (a game that wants one selection
// system, as the forge zombie game since v8, asks for no reward and sells its cards here).
//
// An item's price for a player is round(price × perLap^lap × perBuy^bought): `lap` is how many times the waves have
// gone round (spec.forge.endless), `bought` how many of it this player bought this visit. A card's is × `rare` or
// `epic` for a rare or an epic card. `stock` is how many one player
// may buy a visit (0: no limit). A visit runs from one cart to the next, so a revive bought in a fight counts there.
// What each kind does:
//   card    (v8, the creator: "We should only have one selection system", then "Cart only, no free cards") three
//           cards dealt for each player as the cart opens (not the reward's three; the family lean, deal.familyBias,
//           applies), shown as real cards; one is bought by its place and that place stays empty until a fresh deal
//   reroll  the three on show dealt again (on a wave with a reward: the reward's three)
//   heal    `share` of full health back at once
//   hone    one upgrade card the player holds, a rarity higher: its change × (1 + `by`) a step (an add × 1.5, a
//           multiplier to the power 1.5 with `by` 0.5); a common can be honed twice, a rare once, an epic not
//   revive  a downed friend back up at once, from anywhere, during the fight too (a small prompt with a key and a
//           button). A revive by holding interact beside them stays free.
import { num, int, bool, words, choice, sound, obj, list, id, defaultsOf } from './fields.js';

export const KINDS = ['card', 'reroll', 'heal', 'hone', 'revive'];

export const item = {
  id: id(),
  kind: choice('card', KINDS, 'Kind', 'card (three cards on show, buy any), reroll (deal the three again), heal, hone (a card a rarity higher), revive (a downed friend up)'),
  name: words('', 'Name', 'What the pedlar calls it', 40),
  text: words('', 'Text', 'What it does, in a few words', 120),
  price: int(10, 0, 65535, 'coins', 'Price', 'Its price on the first time through, before any is bought'),
  perLap: num(1.3, 1, 10, '×', 'Dearer a lap', 'The price is multiplied by this each time the waves go round'),
  perBuy: num(1.5, 1, 10, '×', 'Dearer each bought', 'The price is multiplied by this for each one the player bought this visit'),
  stock: int(1, 0, 15, '', 'Stock a visit', 'How many one player may buy at one cart (0: no limit)'),
  share: num(0.4, 0, 1, '', 'Heal share', 'For kind heal: the share of full health given back'),
  by: num(0.5, 0.05, 4, '×', 'Hone step', 'For kind hone: how much stronger a step makes a card\'s change (0.5: half as much again)'),
  rare: num(1.5, 0.1, 20, '×', 'Rare card price', 'For kind card: a rare card costs the price × this'),
  epic: num(2.2, 0.1, 20, '×', 'Epic card price', 'For kind card: an epic card costs the price × this'),
};

const full = row => ({ ...defaultsOf(item), ...row });
/** The cart a game gets when it names no items (Rust: shop.rs `default_items`, held to defaults.json by a test). */
export const ITEMS = [
  full({ id: 'card', kind: 'card', name: 'Cards', text: 'Three cards on show: buy the one you want', price: 8, perLap: 1.3, perBuy: 1.4, stock: 0, rare: 1.5, epic: 2.2 }),
  full({ id: 'reroll', kind: 'reroll', name: 'Fresh deal', text: 'The three cards dealt again', price: 5, perLap: 1.25, perBuy: 1.5, stock: 3 }),
  full({ id: 'heal', kind: 'heal', name: 'Tonic', text: 'Back 40% of your health', price: 6, perLap: 1.3, perBuy: 1.5, stock: 2 }),
  full({ id: 'hone', kind: 'hone', name: 'Whetstone', text: 'One of your cards a rarity higher', price: 15, perLap: 1.3, perBuy: 1.6, stock: 1 }),
  full({ id: 'revive', kind: 'revive', name: 'Smelling salts', text: 'A fallen friend up at once, from anywhere', price: 10, perLap: 1.3, perBuy: 1.5, stock: 0 }),
];

export const fields = {
  on: bool(false, 'Pedlar\'s cart', 'After a cleared wave a cart opens where the coins players picked up buy things; coins also raise a downed friend'),
  seconds: num(20, 3, 180, 's', 'Cart time', 'Seconds the cart stays open: when every player has pressed Done, or at its end, the fight goes on'),
  every: int(1, 1, 64, '', 'Every so many waves', 'The cart opens after every so many cleared waves (1: after each)'),
  from: int(1, 1, 1000, '', 'From wave', 'The first wave after which the cart opens'),
  items: { ...list(item, 'Items', { min: 0, max: 8 }), default: ITEMS },
  text: obj({
    title: words('The pedlar\'s cart', 'title', 'The cart\'s heading', 60),
    sub: words('Coins buy what the road ahead needs', 'line', 'Under the heading', 80),
    leave: words('Done', 'done button', 'Leaves the cart (the fight goes on when everyone has pressed it)', 30),
    left: words('You left the cart', 'after leaving', 'While friends still shop', 60),
    waiting: words('Waiting for {names}', 'waiting line', 'After this player left, while friends still shop; {names} are theirs', 80),
    coins: words('{n}', 'purse', 'The player\'s coins; {n} is the number', 30),
    stockLeft: words('{n} left', 'stock', 'How many more this visit; {n} is the number', 30),
    soldOut: words('Sold out', 'sold out', 'The visit\'s stock is bought', 30),
    poor: words('Not enough coins', 'too dear', 'Said when an item is too dear', 40),
    none: words('Nothing to use it on', 'no target', 'Said when an item has nothing to work on (full health, no friend down)', 60),
    hone: words('Hone which card?', 'hone heading', 'Over the cards a hone can raise', 60),
    buy: words('Buy', 'buy button', 'Under a card on show, before its price', 20),
    sold: words('Sold', 'sold place', 'Where a card bought was, until a fresh deal', 30),
    score: words('Score', 'score', 'Beside the purse in the cart\'s heading', 20),
    timeLeft: words('Time left', 'time left', 'Over the clock', 30),
    purse: words('Coins', 'purse label', 'Over the player\'s coins in the cart\'s heading', 20),
    pickHint: words('Choose a card to see what it changes', 'card hint', 'Where the inspector goes before a card is chosen', 80),
    back: words('Back', 'back button', 'Out of choosing a card to hone', 30),
    raise: words('Pay to raise {name}', 'paid revive', 'The button in a fight while a friend is down (not the free hold-to-revive); {name} is theirs', 50),
    keys: words('1–3 choose a card, again to buy · {a}–{b} buy · Enter: buy the chosen card, or Done · Esc: let go of it', 'key help', 'The line under the items for a keyboard; {a} and {b} are the first and last item keys', 140),
    // v8 review fixes (the creator: "Have we logically reviewed the interface so its makes sense from a users
    // perspective"): a greyed item says why on its tile, a risen price says so, the last seconds are counted down
    need: words('Need {n} more', 'too dear, on the tile', 'On a greyed tile or Buy button: how many coins short; {n} is the number', 40),
    full: words('Full health', 'heal, nothing to heal', 'On a greyed heal tile', 40),
    noHone: words('Nothing to hone', 'hone, no card', 'On a greyed hone tile: no card held that can be raised', 40),
    noneDown: words('No friend is down', 'revive, no one down', 'On a greyed revive tile', 40),
    handFull: words('Your hand is full', 'hand full', 'On a greyed card or fresh deal: no room for another card', 40),
    rise: words('Each card bought here raises the next one\'s price', 'rising prices', 'One line in a cart that sells cards dearer each one bought', 80),
    packing: words('The cart leaves in {n}…', 'last seconds', 'In the cart\'s heading for its last 10 seconds; {n} is the seconds', 50),
    honeTitle: words('{name} · {price} coins: make one of your cards a rarity higher', 'hone chooser heading', 'Over the cards a hone can raise; {name} and {price} are the item\'s', 90),
  }, 'Pedlar\'s cart words'),
  sounds: obj({
    open: sound('shop-open', 'gem', 'The cart opens'),
    buy: sound('shop-buy', 'coin', 'A purchase'),
    deny: sound('shop-deny', 'error', 'Too dear, sold out, or nothing to use it on'),
  }),
};

export const owner = 'forge-feel (shop.rs: the purse, the cart, the items and their prices) and the kit\'s cart screen (gf/forge/shop.js)';
