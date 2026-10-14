# Never put a secret in a game

Everything in a game folder ships to every player: `gamesfun.json`, the game's code, its pictures, its
models. A secret placed there is published.

| Never in a game | Where it belongs |
| --- | --- |
| A private key, a keypair file (a JSON array of 64 numbers), a seed phrase | Only in the human's wallet. The kit never needs one: wallets sign in the human's browser. |
| An RPC URL with a key (`?api-key=…`, Helius, QuickNode, Alchemy paths) | `npx gamesfun web3 settings --rpc <url>`, or the `GAMESFUN_RPC_URL` environment variable. It is kept in the kit's git-ignored `.gamesfun/web3.json`. |
| API tokens, bearer tokens, `.env` values | Outside the game, and never committed |

What the kit does about it:

- `gamesfun.json` keeps only known public fields: addresses, names, prices, https links and looks.
  Writing anything that looks like a key, a keyed URL or a seed phrase is refused with a plain error.
- In-game, `gfWeb3.configure({ rpc })` refuses a keyed URL.
- The studio shows the creator's RPC masked (`https://devnet.helius-rpc.com/…`).
- The only keys the kit ever makes are the fresh, one-time addresses a new token (its base mint) and
  a new shop (its collection) need. Each signs its part of one transaction in memory and is then
  dropped. It is never written to disk.

If the human pastes a key or a seed phrase into the chat, tell them not to, and that they should treat
the key as exposed and move its funds to a new wallet. Never write it anywhere.
