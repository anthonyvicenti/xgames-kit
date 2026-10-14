// What a player can do in an economy, for the menu and HUD binding and the agent tools: `playerActions(economy)`, the
// list of buttons a game would show, and `economyState(economy, reads, player)`, the state the page sends the game.
// Pure, and works in Node and the browser. The code lives with the in-game kit (builder/web3/gf-web3/econ/actions.js), which
// a game carries at gf/web3/ and whose `economy.act(id)` performs each action from its id; this re-exports it so the
// tools and the kit can never disagree.
//
// playerActions → [{ id, part, kind, label, price?, says, where, asks? }]
//   id      "box:flip:open", "lottery:weekly:tickets", "contest:duel:enter:1", "stake:backers:claim" …: everything
//           gfWeb3.economy.act(id, answers) needs, with the spec
//   kind    buy | openBox | pay | craft | buyTickets | stake | unstake | hold | enter | claim
//   price   { amount: "0.1", currency: "SOL" } when the action has one price
//   says    what it does, in a player's words (prices and odds included)
//   where   menu | pause | results | hud. The spec has no field for it yet: claim goes to results, the rest to menu
//   asks    { count | amount: { default, min?, says } }: a number the page may ask the player for; the default works
export { economyState, parseActionId, PLACES, playerActions } from '../gf-web3/econ/actions.js';
