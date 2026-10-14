// The one place games.fun's chain addresses live. Everything here is public: program ids, the partner wallet, quote
// mints, the Irys node. No key, token or keyed RPC URL ever belongs in this file.
// Devnet only: there is deliberately no mainnet entry (mainnet needs an explicit decision and its own review).
// Source: games.fun's devnet addresses (loot 0.3.2; no MAIN pairing) and its mint information.

export const DEVNET = 'devnet';

const devnet = Object.freeze({
  id: DEVNET,
  /** The Wallet Standard chain a wallet signs for. */
  chain: 'solana:devnet',
  /** A public RPC that needs no key. The creator may use their own (gamesfun web3 settings --rpc); players use this. */
  rpcUrl: 'https://api.devnet.solana.com',
  explorer: 'https://explorer.solana.com/{kind}/{id}?cluster=devnet',
  /** Irys (Arweave) bundler node, paid in devnet SOL. Devnet uploads are not permanent. */
  irys: Object.freeze({ node: 'https://devnet.irys.xyz', gateway: 'https://devnet.irys.xyz', currency: 'solana' }),
  /**
   * Meteora Dynamic Bonding Curve launches, as games.fun's launchpad makes them since 2026-10-12: every launch creates
   * a config of its own (gf-web3/chain/dbc-curve.js), paired with SOL by default, USDC-dev as the other quick pick, or
   * any SPL mint DBC takes. games.fun's partner wallet is the config's fee claimer and leftover receiver and gets 5%:
   * the creator keeps 95% of the trading fee (after Meteora's own cut), and the graduated pool's LP is locked 95 to the
   * creator and 5 to the partner (games.fun's 95 / 5 split; no MAIN pairing for now). A token launched anywhere
   * else pays games.fun nothing and works with every part of an economy. Tokens launched before 2026-10-12 on the
   * shared MAIN-dev configs (`antisnipe-v1` and the others, 50 / 50) keep working: a pool names its own config.
   */
  launchpad: Object.freeze({
    dbcProgram: 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN',
    partner: '8yPDcNeKHwfSmyx9MPNpgqU8o1W4xiCHxzYty7w3rnNV',
    split: Object.freeze({ creatorTradingFeePercentage: 95, partnerLockedLp: 5, creatorLockedLp: 95 }),
    /** The pair a launch takes when none is named. */
    defaultPair: 'SOL',
    /** Pairs offered without typing an address (any other SPL mint DBC takes works by address). */
    pairs: Object.freeze([
      Object.freeze({ symbol: 'SOL', mint: 'So11111111111111111111111111111111111111112', decimals: 9, native: true }),
      Object.freeze({ symbol: 'USDC-dev', mint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU', decimals: 6, native: false }),
    ]),
    /**
     * Dollar prices that size a launch's curve (start about $5,000, graduation about $75,000). DEVNET REFERENCE
     * PRICES, NOT MARKET PRICES: devnet SOL has no market, so it is sized at a round $100 (the launchpad's
     * `pairPrices` idea in its <network>.json); USDC-dev is $1. The creator can override SOL's (`--sol-usd`, the
     * Economy tab) or set the market caps themselves; a mint not listed here has no price, so its launch needs them.
     * Nothing is fetched from a price service.
     */
    pairPrices: Object.freeze({
      So11111111111111111111111111111111111111112: 100,
      '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU': 1,
    }),
  }),
  /**
   * The games.fun loot program 0.3.2 (items, shop, loot boxes and every other economy piece), its platform record and
   * its two flat fees in lamports: the player fee when a player signs for something of their own (a purchase, a box,
   * tickets, a stake), the project fee for everything else that is charged. Each fee lands in the game's own fee box.
   * The platform account holds the fees in force; these are what it was set up with (games.fun launchpad/loot
   * devnet-deploy-0.3.1-result.json, 2026-10-12: 0.3 with the audit's fixes, at a new address since the layouts changed;
   * upgraded in place the same day to the 95 / 5 registry rules, devnet-upgrade-0.3.1-95-5-result.json, and to 0.3.2,
   * the cleanup, devnet-upgrade-0.3.2-result.json).
   * Shops take SOL, any classic SPL token and any Token-2022 token.
   */
  loot: Object.freeze({
    program: 'GVzbAquLbqGxWzzjEAYvGyj1a3SHEcBr3gM9fseTg73o',
    platform: '3ASM4DQfuvjL2J6ZXLZ9dBrF8c3kbxibutgJjy2mFkCt',
    playerFeeLamports: 2_000_000,
    projectFeeLamports: 10_000,
    partner: '8yPDcNeKHwfSmyx9MPNpgqU8o1W4xiCHxzYty7w3rnNV',
    token2022: true,
  }),
  /**
   * Currencies a shop can be priced in without typing an address (any other mint, classic or Token-2022, works by
   * address). games.fun has no token of its own for now (2026-10-12), so there is no MAIN here.
   */
  currencies: Object.freeze([
    Object.freeze({ kind: 'sol', symbol: 'SOL', mint: 'So11111111111111111111111111111111111111112', decimals: 9 }),
    Object.freeze({ kind: 'usdc', symbol: 'USDC-dev', mint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU', decimals: 6 }),
  ]),
  /**
   * Devnet test mints the kit names when they carry no metadata of their own. Names only: none of them is a quick
   * pick. MAIN-dev was the quote of launches before 2026-10-12; games already priced in it keep working (it is a mint
   * like any other).
   */
  knownMints: Object.freeze([
    Object.freeze({ symbol: 'USDC-dev', name: 'USD Coin (devnet)', mint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU', decimals: 6 }),
    Object.freeze({ symbol: 'MAIN-dev', name: 'MAIN-dev (a devnet test token)', mint: '4ikj24Byduo7WZGhnxNYkqstpm9xUVeZH7eLQbjGDL7N', decimals: 6 }),
  ]),
});

export const NETWORKS = Object.freeze({ [DEVNET]: devnet });

/** The network by name. Anything but devnet is refused: there is no mainnet in this kit. */
export function networkConfig(name = DEVNET) {
  if (name !== DEVNET) throw new Error(`The games.fun kit runs on devnet only (asked for ${String(name)}).`);
  return NETWORKS[name];
}

/** An explorer link for an address, a transaction or a token. */
export const explorerUrl = (network, kind, id) =>
  network.explorer.replace('{kind}', kind).replace('{id}', encodeURIComponent(id));
