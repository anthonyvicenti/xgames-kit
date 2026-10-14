# The economy evals

Twenty frozen prompts in `builder/web3/economy/evals/cases.json`, one sentence each: a coin-flip arena, a mystery-box drop,
a plain shop, a daily lottery, stake-to-earn, merges, a pity gacha, halving seasons, a duel, a Token-2022 coin, a
pump.fun coin, a burning treasury, a sacrifice raffle, a falling price, a level ladder, plinko, breeding, enhancing,
a weekly leaderboard, founder passes. The goal is 15 of 20.

To run them: for each case, give an agent the prompt with this skill and the `economy_*` tools, and save the spec it
settles on as `<out>/<id>.json` (the economy section, or a whole gamesfun.json). Then:

```bash
node builder/web3/economy/evals/score.mjs <out>              # PASS/FAIL per case, each failed check named
node builder/web3/economy/evals/score.mjs <out> --min 15     # exit 1 under 15
node builder/web3/economy/evals/score.mjs --references       # each case's reference spec (20 of 20)
```

`node builder/web3/economy/evals/run.mjs --out <folder outside the kit> [--holdout]` does the whole run with headless Claude
Code (a fresh copy of the kit and a game per case, the case's sentence alone, then the scorer). As the kit ships,
`economy_examples` holds every case's reference, so add `--holdout` for a fair number: it takes each case's own
reference out of its copy first. Results so far: `builder/web3/economy/evals/results/`.

A case passes when the spec is valid, checks with no refusals, simulates and costs, and every one of its checks
holds: parts present, key numbers within the range the prompt implies (a weekly lottery with three places, about 10%
of every flip into its pot, a house edge near what was asked), and the right warnings raised (chance flagged, the
authority named). `score.mjs`'s header says how a check reads the spec. Each case has a reference spec that passes
it, and no reference passes more than one other case.
