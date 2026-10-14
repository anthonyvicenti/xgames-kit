# Telling the creator what they get

The creator reads your words, not the spec. After every change, run `economy_explain` and turn it into a few short
lines in this order. Use the tools' numbers; round them sensibly; name currencies by symbol.

1. **What each play costs and is worth.** "A flip costs 0.1 SOL plus a 0.002 SOL fee and gives back 0.088 SOL on
   average (88%)." For a box of items, what the odds are; for a lottery, what the pot reaches and what each place
   wins; for a stake, what a day of rewards is.
2. **Where the money goes.** "88% of each flip goes back into the house pool, 10% into the lottery, 2% to stakers."
3. **How the pools fill and drain.** "The house pool pays out what comes in; luck swings it about 7 SOL a week, so
   start it with about 22 SOL." A pool that runs dry is the first thing to say.
4. **What setting it up costs.** "Going live costs about 5.02 SOL on devnet, in one wallet approval: 5 SOL is the
   seed, the rest is rent and fees." A token launched with games.fun is its own approval first (the creator keeps
   95% of its trading fees, games.fun gets 5%; a token launched elsewhere pays games.fun nothing).
5. **What they decide while it runs.** If anything needs the authority (a payout, a contest's winner, a held item),
   say what and how often: "Each week you sign the top three's payouts from the studio page." If a payout rewards
   beating the game (a clear, a win, a score), add: "Checking that a player really beat the game is up to you, on
   your own server or backend: the kit can't tell a real win from a faked one."
6. **Chance that pays money, flagged.** If the checker raised `W-CHANCE-PRIZE`: "Players pay for a chance at money.
   That is gambling in many places once it is real money; this runs on devnet only."
7. **Anything else the checker warned about**, in a sentence each (a mint that can freeze accounts, a fee that is
   large next to a cheap price).

Don'ts:
- Don't show mints, account addresses, PDAs, lamports, rent per account or instruction names unless asked.
- Don't promise returns, profits or "passive income". Say what the program does, with the numbers.
- Don't hide a gap: if the program can't do what they asked, the first line says so and offers the nearest thing.
- Ask one question at a time, and only when the answer changes the spec (an existing coin's mint, a referrer's
  address, how often they expect players to play).
