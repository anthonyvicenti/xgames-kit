// gf-web3's version: the in-game kit a game carries at gf/web3/ (refreshed whole by create and upgrade).
// 2.0.0: talks to the loot program 0.3 (a buy is two approvals; orders() and finish(); Token-2022 shops).
// 2.1.0: the economy: gfWeb3.economy (buy, openBox, pay, craft, buyTickets, stake, unstake, hold, enter, claim, act,
//        actions, state and the reads), named by the keys of gamesfun.json's economy section. Adds econ/.
// 2.2.0: loot 0.3.1 (devnet GVzbAquL…, the audit's fixes): every fee into the game's fee box, a refund's voided serial
//        back in stock, unstake's `forfeit`; an economy live on 0.3 (88Labq6t…) reads as not live and goes live fresh.
// 2.3.0: launches as games.fun's launchpad makes them since 2026-10-12: a DBC config of each launch's own (chain/dbc.js
//        createConfigInstruction, chain/dbc-curve.js), paired with SOL by default, USDC-dev or any SPL mint, split
//        95 / 5 (the creator keeps 95% of the trading fees); no MAIN quick pick or launch pair (games.fun has no token
//        for now); the loot IDL's four registry messages at 95 / 5 (the program upgraded in place on devnet).
// 2.4.0: loot 0.3.2 (the cleanup, upgraded in place on devnet): set_platform's next admin and update_game's new owner
//        sign their handover (updateGameIx `newOwner`), take_back takes no fee accounts, settle_prize no signer.
export const VERSION = '2.4.0';
