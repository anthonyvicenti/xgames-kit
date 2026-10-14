// `gamesfun web3 …`: the game's token, shop, items and loot boxes on Solana devnet, from the terminal.
// Drafts (items, boxes, the shop's currency, linking a token) change gamesfun.json directly. Anything that signs or
// spends (launching a token, putting the shop on sale) becomes a request the creator approves in the studio with
// their own wallet; this command prints where. It never signs and never holds a key.
import { parseArgs } from 'node:util';
import { web3Action } from '../web3/node/actions.mjs';

const USAGE = `Usage: gamesfun web3 <action> [options]      (devnet only)

  status                       What the game has: token, shop, items, boxes, checked on chain
  launch --name N --symbol S --picture P [--description D] [--pair SOL|USDC|MINT] [--buy AMOUNT]
         [--sol-usd PRICE] [--start-cap N --graduation-cap N]
                               Ask to launch the game's token on a Meteora curve of its own (you approve it
                               in the studio). Paired with SOL unless --pair says otherwise; --buy is in the
                               pair. The curve is sized to start near $5k and graduate near $75k (SOL at a
                               devnet reference $100 unless --sol-usd); a pair with no price needs both caps,
                               in whole pair tokens. You keep 95% of its trading fees; games.fun gets 5%.
  link --mint ADDRESS          Use a token you already have, launched anywhere (no signature; games.fun takes
                               no share of its fees)
  unlink                       Stop using a linked token
  currency SOL|USDC|token|MINT
                               What players pay with (fixed once the shop is live)
  item add --name N --picture P [--rarity R] [--price X] [--description D]
           [--supply N] [--soulbound] [--look JSON]
  item set --id N [any of the above]      item remove --id N      item list
  box add --name N --price X [--odds "1:60,2:25"]   (no --odds: every item, weighted by rarity)
  box set --id N [...]          box remove --id N      box list
  shop publish                 Ask to put everything waiting on sale (one approval in the studio)
  requests                     What is waiting for your approval
  settings [--rpc URL | --clear-rpc]    Your own devnet RPC (kept in .gamesfun/, never in a game)

Options: --game <folder> (default: this folder, or the only game in games/), --json`;

const OPTIONS = {
  game: { type: 'string' },
  json: { type: 'boolean' },
  offline: { type: 'boolean' },
  name: { type: 'string' },
  symbol: { type: 'string' },
  picture: { type: 'string' },
  description: { type: 'string' },
  buy: { type: 'string' },
  pair: { type: 'string' },
  'sol-usd': { type: 'string' },
  'start-cap': { type: 'string' },
  'graduation-cap': { type: 'string' },
  mint: { type: 'string' },
  id: { type: 'string' },
  rarity: { type: 'string' },
  price: { type: 'string' },
  supply: { type: 'string' },
  soulbound: { type: 'boolean' },
  look: { type: 'string' },
  odds: { type: 'string' },
  rpc: { type: 'string' },
  'clear-rpc': { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
};

export default {
  name: 'web3',
  summary: 'Token, shop, items and loot boxes on Solana devnet (approve in the studio)',
  usage: USAGE,
  async run(args) {
    let parsed;
    try {
      parsed = parseArgs({ args, options: OPTIONS, allowPositionals: true, strict: true });
    } catch (error) {
      console.error(`${error.message}\n\n${USAGE}`);
      return 1;
    }
    const [action, sub] = parsed.positionals;
    if (!action || parsed.values.help) {
      console.log(USAGE);
      return action ? 0 : 1;
    }
    try {
      const result = await web3Action(action, sub, parsed.values);
      console.log(parsed.values.json ? JSON.stringify({ ...result.data, ...(result.approve ? { approve: result.approve } : {}) }, (k, v) => (typeof v === 'bigint' ? v.toString() : v), 2) : result.text);
      return 0;
    } catch (error) {
      console.error(error.message);
      return 1;
    }
  },
};
