// The curve of a game token's own Meteora DBC config, worked out the way games.fun's launchpad does it
// (launchpad/curve/params.mjs: buildCurveWithMarketCap of @meteora-ag/dynamic-bonding-curve-sdk 1.5.12, MIT, see
// THIRD_PARTY.md), without that SDK: plain BigInt, and a small stand-in for decimal.js at its defaults (20 significant
// digits, rounding half up), which the SDK's curve builder computes with. Every launch gets a config of its own, sized
// to the same dollar curve as the launchpad's: start about $5,000, graduation about $75,000 (PAIR_USD).
//
// The split (games.fun's 95 / 5): the creator keeps 95% of the trading fee left after Meteora's cut, and the graduated pool's LP is locked 95 to
// the creator and 5 to games.fun's partner wallet. No migration fee, no compounding.
//
// The arithmetic is ported from the SDK (MIT, author Dann Wee, MeteoraAg; THIRD_PARTY.md). decimal.js's rounding is
// reproduced, not copied.
//
// tests/web3-dbc-config.test.mjs holds what this builds to what the launchpad's own code builds for the same inputs,
// byte for byte (fixture made by tests/web3/fixtures/generate-dbc-config.mjs from the launchpad).

// ---------------------------------------------------------------- the launch's fixed shape

/** games.fun's share of a token launched with it (launchpad/launch/split.mjs). */
export const SPLIT = Object.freeze({ creatorTradingFeePercentage: 95, partnerLockedLp: 5, creatorLockedLp: 95 });
/** The dollar curve every pair is sized to (launchpad/curve/params.mjs PAIR_USD). */
export const PAIR_USD = Object.freeze({ initialMarketCap: 5_000, migrationMarketCap: 75_000 });
export const TOTAL_SUPPLY = 1_000_000_000;
export const BASE_DECIMALS = 6;

/**
 * The fee block every launch carries (launchpad DEFAULT_TARGETS.fees: anti-snipe 50% at activation decaying
 * exponentially to 1% over 120 s in 60 periods, dynamic fee on, the creator's bundled first buy at the minimum fee).
 * These are what the SDK's getFeeSchedulerParams(5000, 100, exponential, 60, 120) and getDynamicFeeParams(100) give;
 * the kit does not offer other fee schedules, so they are constants here (the byte-match test holds them).
 */
export const FEES = Object.freeze({
  baseFee: Object.freeze({ cliffFeeNumerator: 500_000_000n, firstFactor: 60, secondFactor: 2n, thirdFactor: 631n, baseFeeMode: 1 }),
  dynamicFee: Object.freeze({ binStep: 1, binStepU128: 1_844_674_407_370_955n, filterPeriod: 10, decayPeriod: 120, reductionFactor: 5000, maxVolatilityAccumulator: 14_460_000, variableFeeControl: 956 }),
});

const ONE_Q64 = 1n << 64n;
export const MIN_SQRT_PRICE = 4_295_048_016n;
export const MAX_SQRT_PRICE = 79_226_673_521_066_979_257_578_248_091n;
const FEE_DENOMINATOR = 1_000_000_000n;
const SWAP_BUFFER_PERCENTAGE = 25n;
const U64_MAX = (1n << 64n) - 1n;

// ---------------------------------------------------------------- decimal.js at its defaults, for this builder only

const PRECISION = 20;
const pow10 = (n) => 10n ** BigInt(n);
const digits = (c) => (c === 0n ? 1 : c.toString().length);

/** A decimal c × 10^e (c ≥ 0), exact. */
const norm = (c, e) => {
  if (c === 0n) return { c: 0n, e: 0 };
  while (c % 10n === 0n) (c /= 10n), (e += 1);
  return { c, e };
};
/** Rounded to 20 significant digits, half up (what every decimal.js operation does to its result). */
const round = (c, e) => {
  const k = digits(c) - PRECISION;
  if (k <= 0) return norm(c, e);
  const p = pow10(k);
  let q = c / p;
  if (2n * (c % p) >= p) q += 1n;
  return norm(q, e + k);
};
/** Exact, from a JS number (its shortest decimal form, as decimal.js reads it), a bigint or a decimal string. */
export function dec(v) {
  if (typeof v === 'bigint') return norm(v, 0);
  const s = String(v).toLowerCase();
  const m = /^(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/.exec(s);
  if (!m) throw new RangeError(`Not a decimal: ${s}`);
  const frac = m[2] ?? '';
  return norm(BigInt(m[1] + frac), Number(m[3] ?? 0) - frac.length);
}
const align = (a, b) => {
  const e = Math.min(a.e, b.e);
  return [a.c * pow10(a.e - e), b.c * pow10(b.e - e), e];
};
const D = {
  mul: (a, b) => round(a.c * b.c, a.e + b.e),
  add: (a, b) => {
    const [x, y, e] = align(a, b);
    return round(x + y, e);
  },
  sub: (a, b) => {
    const [x, y, e] = align(a, b);
    if (y > x) throw new RangeError('negative decimal');
    return round(x - y, e);
  },
  // Correctly rounded: the truncated quotient carries 22+ digits, and half up needs nothing past them.
  div: (a, b) => {
    if (b.c === 0n) throw new RangeError('division by zero');
    if (a.c === 0n) return { c: 0n, e: 0 };
    const s = Math.max(0, PRECISION + 2 + digits(b.c) - digits(a.c));
    return round((a.c * pow10(s)) / b.c, a.e - b.e - s);
  },
  // Correctly rounded the same way: the integer square root is a truncation of the true root.
  sqrt: (a) => {
    if (a.c === 0n) return { c: 0n, e: 0 };
    let t = Math.max(0, 2 * (PRECISION + 3) - digits(a.c));
    if ((a.e - t) % 2 !== 0) t += 1;
    return round(isqrt(a.c * pow10(t)), (a.e - t) / 2);
  },
  floor: (a) => (a.e >= 0 ? a.c * pow10(a.e) : a.c / pow10(-a.e)),
  toNumber: (a) => Number(`${a.c}e${a.e}`),
};
const HUNDRED = dec(100);
const ZERO = dec(0);
const TWO_POW_64 = dec(ONE_Q64);

/** floor(sqrt(n)): Newton's method from above (one step from any start lands at or above the root). */
function isqrt(n) {
  if (n < 2n) return n;
  let x = 1n << BigInt(Math.ceil(n.toString(2).length / 2));
  for (;;) {
    const y = (x + n / x) >> 1n;
    if (y >= x) return x;
    x = y;
  }
}

// ---------------------------------------------------------------- the curve's integer math (SDK, BN → BigInt)

const minBig = (a, b) => (a < b ? a : b);
const subChecked = (a, b) => {
  if (b > a) throw new RangeError('SafeMath: subtraction overflow');
  return a - b;
};
const mulDivUp = (x, y, d) => (x === 0n || y === 0n || d === 1n ? x * y : (x * y + d - 1n) / d);
const mulDivDown = (x, y, d) => (x === 0n || y === 0n || d === 1n ? x * y : (x * y) / d);
const liquidityFromBase = (base, sqrtMax, sqrtPrice) => (base * sqrtPrice * sqrtMax) / subChecked(sqrtMax, sqrtPrice);
const liquidityFromQuote = (quote, sqrtMin, sqrtPrice) => (quote << 128n) / subChecked(sqrtPrice, sqrtMin);
const deltaBase = (lower, upper, liquidity, up) => {
  const num = subChecked(upper, lower);
  const den = lower * upper;
  return up ? mulDivUp(liquidity, num, den) : mulDivDown(liquidity, num, den);
};
const deltaQuote = (lower, upper, liquidity, up) => {
  const prod = liquidity * subChecked(upper, lower);
  return up ? (prod + (1n << 128n) - 1n) / (1n << 128n) : prod >> 128n;
};
const nextSqrtFromQuoteIn = (sqrtPrice, liquidity, amount) => sqrtPrice + (amount << 128n) / liquidity;

/** DAMM v2: the base tokens that go into the graduated pool with this much quote at this price. */
function migrationBaseToken(quoteAmount, sqrtMigrationPrice) {
  const liquidity = liquidityFromQuote(quoteAmount, MIN_SQRT_PRICE, sqrtMigrationPrice);
  return deltaBase(sqrtMigrationPrice, MAX_SQRT_PRICE, liquidity, true);
}
function migrationThresholdPrice(threshold, sqrtStartPrice, curve) {
  let next = sqrtStartPrice;
  const total = deltaQuote(next, curve[0].sqrtPrice, curve[0].liquidity, true);
  if (total > threshold) return nextSqrtFromQuoteIn(next, curve[0].liquidity, threshold);
  let left = threshold - total;
  next = curve[0].sqrtPrice;
  for (let i = 1; i < curve.length; i++) {
    const max = deltaQuote(next, curve[i].sqrtPrice, curve[i].liquidity, true);
    if (max > left) return nextSqrtFromQuoteIn(next, curve[i].liquidity, left);
    left -= max;
    next = curve[i].sqrtPrice;
  }
  if (left !== 0n) throw new RangeError(`Not enough liquidity, migrationThreshold: ${threshold}  amountLeft: ${left}`);
  return next;
}
function baseTokenForSwap(sqrtStartPrice, sqrtMigrationPrice, curve) {
  let total = 0n;
  for (let i = 0; i < curve.length; i++) {
    const lower = i === 0 ? sqrtStartPrice : curve[i - 1].sqrtPrice;
    if (curve[i].sqrtPrice > sqrtMigrationPrice) {
      total += deltaBase(lower, sqrtMigrationPrice, curve[i].liquidity, true);
      break;
    }
    total += deltaBase(lower, curve[i].sqrtPrice, curve[i].liquidity, true);
  }
  return total;
}

// ---------------------------------------------------------------- targets (launchpad/curve/params.mjs)

const need = (ok, message) => {
  if (!ok) throw new RangeError(message);
};
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const int = (v, name, min, max) => need(Number.isInteger(v) && v >= min && v <= max, `${name} must be a whole number from ${min} to ${max} (got ${JSON.stringify(v)})`);

/**
 * { initialMarketCap, migrationMarketCap } in whole pair tokens, quoteDecimals, baseDecimals (6 or 9). The same rules
 * as the launchpad's validateTargets for the parts a creator can set.
 */
export function validateTargets(t) {
  need(isNum(t.initialMarketCap) && t.initialMarketCap > 0, 'The start market cap must be a positive number.');
  need(isNum(t.migrationMarketCap) && t.migrationMarketCap > 0, 'The graduation market cap must be a positive number.');
  need(t.migrationMarketCap >= 2 * t.initialMarketCap, 'The graduation market cap must be at least 2 times the start market cap.');
  need(t.migrationMarketCap <= 10_000 * t.initialMarketCap, 'The graduation market cap must be at most 10,000 times the start market cap.');
  int(t.baseDecimals, 'baseDecimals', 6, 9);
  int(t.quoteDecimals, 'The pair’s decimals', 0, 9);
  need(BigInt(TOTAL_SUPPLY) * pow10(t.baseDecimals) < 2n ** 64n, 'totalSupply * 10^baseDecimals overflows u64');
  need(t.migrationMarketCap * 10 ** t.quoteDecimals < 2 ** 63, 'The graduation market cap is too large for this pair (it overflows u64 in base units).');
  // The SDK's builder fails once the graduation price reaches 1 quote atom per base atom.
  need(t.migrationMarketCap * 10 ** t.quoteDecimals < TOTAL_SUPPLY * 10 ** t.baseDecimals,
    'graduation price would reach 1 pair atom per token atom: set smaller market caps');
  return t;
}

const sig6 = (n) => Number(n.toPrecision(6));

/**
 * The curve's targets for a pair: { decimals, usd } (usd null when the pair has no price); caps = the creator's own
 * { initialMarketCap, migrationMarketCap } in whole pair tokens, which win over the dollar sizing (launchpad
 * targetsForPair). A cheap pair with many decimals gets 9 base decimals for room under the 1-atom limit.
 */
export function targetsForPair(pair, caps = null) {
  const own = caps && (caps.initialMarketCap != null || caps.migrationMarketCap != null);
  let initial;
  let migration;
  if (own) {
    initial = Number(caps.initialMarketCap);
    migration = Number(caps.migrationMarketCap);
  } else {
    need(pair.usd > 0, `${pair.symbol ?? 'This token'} has no price to size the curve with: set the start and graduation market caps (in ${pair.symbol ?? 'the pair token'}).`);
    initial = sig6(PAIR_USD.initialMarketCap / pair.usd);
    migration = sig6(PAIR_USD.migrationMarketCap / pair.usd);
  }
  const targets = { initialMarketCap: initial, migrationMarketCap: migration, quoteDecimals: pair.decimals, baseDecimals: BASE_DECIMALS };
  try {
    validateTargets(targets);
  } catch (error) {
    if (!/1 pair atom per token atom/.test(error.message)) throw error;
    targets.baseDecimals = 9;
  }
  return validateTargets(targets);
}

// ---------------------------------------------------------------- the config's parameters

/**
 * ConfigParameters for createConfig from targets: the SDK's buildCurveWithMarketCap with the launchpad's defaults
 * (no migration fee, no vesting, no leftover, DAMM v2, SPL token, immutable metadata, timestamps), amounts as BigInt.
 */
export function curveParams(targets) {
  const t = validateTargets({ baseDecimals: BASE_DECIMALS, ...targets });
  const bd = t.baseDecimals;
  const qd = t.quoteDecimals;
  const totalSupply = D.floor(D.mul(dec(TOTAL_SUPPLY), dec(10 ** bd)));

  // getPercentageSupplyOnMigration (no vesting, no leftover), then the threshold (no migration fee).
  const sqrtRatio = D.sqrt(D.div(dec(t.initialMarketCap), dec(t.migrationMarketCap)));
  const numerator = D.sub(D.mul(HUNDRED, sqrtRatio), D.mul(D.add(ZERO, ZERO), sqrtRatio));
  const percentage = D.toNumber(D.div(numerator, D.add(dec(1), sqrtRatio)));
  const quoteAmountUi = D.div(D.mul(dec(t.migrationMarketCap), dec(percentage)), HUNDRED);
  const threshold = D.toNumber(D.div(D.mul(quoteAmountUi, HUNDRED), D.sub(HUNDRED, ZERO)));

  // buildCurve
  const migrationBaseSupply = D.div(D.mul(dec(TOTAL_SUPPLY), dec(percentage)), HUNDRED);
  const migrationQuoteAmount = D.div(D.mul(dec(threshold), D.sub(HUNDRED, ZERO)), HUNDRED);
  const migrationPrice = D.div(migrationQuoteAmount, migrationBaseSupply);
  const migrationQuoteThreshold = D.floor(D.mul(dec(threshold), dec(10 ** qd)));
  const migrateSqrtPrice = D.floor(D.mul(D.sqrt(D.div(migrationPrice, dec(10 ** (bd - qd)))), TWO_POW_64));
  const migrationQuoteAtoms = D.floor(D.mul(migrationQuoteAmount, dec(10 ** qd)));
  const migrationBaseAmount = migrationBaseToken(migrationQuoteAtoms, migrateSqrtPrice);
  const swapAmount = subChecked(totalSupply, migrationBaseAmount);

  // getFirstCurve
  const denominator = D.div(D.mul(dec(swapAmount), D.sub(HUNDRED, ZERO)), HUNDRED);
  const sqrtStartPrice = D.floor(D.div(D.mul(dec(migrateSqrtPrice), dec(migrationBaseAmount)), denominator));
  const curve = [{
    sqrtPrice: migrateSqrtPrice,
    liquidity: minBig(liquidityFromBase(swapAmount, migrateSqrtPrice, sqrtStartPrice), liquidityFromQuote(migrationQuoteThreshold, sqrtStartPrice, migrateSqrtPrice)),
  }];

  // getTotalSupplyFromCurve, and the rest of the supply on a last segment up to the highest price.
  const sqrtMigrationPrice = migrationThresholdPrice(migrationQuoteThreshold, sqrtStartPrice, curve);
  const swapBase = baseTokenForSwap(sqrtStartPrice, sqrtMigrationPrice, curve);
  const swapBuffer = minBig(swapBase + (swapBase * SWAP_BUFFER_PERCENTAGE) / 100n, baseTokenForSwap(sqrtStartPrice, MAX_SQRT_PRICE, curve));
  const migrationQuote = D.floor(D.div(D.mul(dec(migrationQuoteThreshold), D.sub(HUNDRED, ZERO)), HUNDRED));
  const totalDynamicSupply = swapBuffer + migrationBaseToken(migrationQuote, sqrtMigrationPrice);
  const lastLiquidity = liquidityFromBase(subChecked(totalSupply, totalDynamicSupply), MAX_SQRT_PRICE, migrateSqrtPrice);
  if (lastLiquidity !== 0n) curve.push({ sqrtPrice: MAX_SQRT_PRICE, liquidity: lastLiquidity });

  // What the SDK's validateConfigParameters would refuse, for these shapes.
  need(migrationQuoteThreshold > 0n && migrationQuoteThreshold <= U64_MAX, 'The graduation amount does not fit the curve.');
  need(sqrtStartPrice >= MIN_SQRT_PRICE && sqrtStartPrice < curve[0].sqrtPrice, 'The start price does not fit the curve: set other market caps.');
  for (let i = 0; i < curve.length; i++) {
    need(curve[i].liquidity > 0n && curve[i].sqrtPrice <= MAX_SQRT_PRICE && (i === 0 || curve[i].sqrtPrice > curve[i - 1].sqrtPrice), 'The curve is not valid for these market caps.');
  }

  return {
    poolFees: { baseFee: { ...FEES.baseFee }, dynamicFee: { ...FEES.dynamicFee } },
    collectFeeMode: 0, // fees in the quote token
    migrationOption: 1, // DAMM v2
    activationType: 1, // timestamps
    tokenType: 0, // SPL token
    tokenDecimal: bd,
    partnerLiquidityPercentage: 0,
    partnerPermanentLockedLiquidityPercentage: SPLIT.partnerLockedLp,
    creatorLiquidityPercentage: 0,
    creatorPermanentLockedLiquidityPercentage: SPLIT.creatorLockedLp,
    migrationQuoteThreshold,
    sqrtStartPrice,
    lockedVesting: { amountPerPeriod: 0n, cliffDurationFromMigrationTime: 0n, frequency: 0n, numberOfPeriod: 0n, cliffUnlockAmount: 0n },
    migrationFeeOption: 6, // customizable
    tokenSupply: { preMigrationTokenSupply: totalSupply, postMigrationTokenSupply: totalSupply },
    creatorTradingFeePercentage: SPLIT.creatorTradingFeePercentage,
    tokenUpdateAuthority: 1, // immutable
    migrationFee: { feePercentage: 0, creatorFeePercentage: 0 },
    migratedPoolFee: { collectFeeMode: 0, dynamicFee: 1, poolFeeBps: 100 },
    poolCreationFee: 0n,
    partnerLiquidityVestingInfo: { vestingPercentage: 0, bpsPerPeriod: 0, numberOfPeriods: 0, cliffDurationFromMigrationTime: 0, frequency: 0 },
    creatorLiquidityVestingInfo: { vestingPercentage: 0, bpsPerPeriod: 0, numberOfPeriods: 0, cliffDurationFromMigrationTime: 0, frequency: 0 },
    migratedPoolBaseFeeMode: 0,
    migratedPoolMarketCapFeeSchedulerParams: { numberOfPeriod: 0, sqrtPriceStepBps: 0, schedulerExpirationDuration: 0, reductionFactor: 0n },
    enableFirstSwapWithMinFee: true,
    compoundingFeeBps: 0,
    curve,
    // Not encoded: for the quote and the approval screen.
    migrationSqrtPrice: sqrtMigrationPrice,
  };
}

// ---------------------------------------------------------------- the creator's first buy, quoted offline

/** The minimum base fee the bundled first buy pays (exponential scheduler at its last period; SDK pow in Q64). */
export function minBaseFeeNumerator(fee = FEES.baseFee) {
  if (fee.firstFactor === 0) return fee.cliffFeeNumerator;
  if (fee.baseFeeMode === 0) return fee.cliffFeeNumerator - BigInt(fee.firstFactor) * fee.thirdFactor;
  const base = ONE_Q64 - (fee.thirdFactor << 64n) / 10_000n;
  let result = ONE_Q64;
  let b = base;
  let exp = fee.firstFactor;
  while (exp > 0) {
    if (exp & 1) result = (result * b) / ONE_Q64;
    b = (b * b) / ONE_Q64;
    exp >>= 1;
  }
  return (fee.cliffFeeNumerator * result) / ONE_Q64;
}

/**
 * What a first buy of `amountIn` (pair base units) bought in the pool's own creation transaction receives: the SDK's
 * swapQuoteExactIn on a fresh pool with the minimum fee (the config's enableFirstSwapWithMinFee). `minimumAmountOut`
 * keeps 0.5% slack, for rounding only: the pool and the buy share one transaction, so nothing trades in between,
 * and a buy charged the anti-snipe fee instead (not in the creation transaction) fails rather than overpays.
 */
export function quoteFirstBuy(params, amountIn, { slackBps = 50n } = {}) {
  const amount = BigInt(amountIn);
  if (amount <= 0n) throw new RangeError('The initial buy must be more than 0.');
  if (amount >= params.migrationQuoteThreshold) throw new RangeError('An initial buy must stay below the curve’s graduation amount; it would graduate the token at launch.');
  const fee = (amount * minBaseFeeNumerator(params.poolFees.baseFee) + FEE_DENOMINATOR - 1n) / FEE_DENOMINATOR;
  // Meteora's protocol cut comes out of that fee, not out of the buyer's tokens.
  let left = amount - fee;
  let price = params.sqrtStartPrice;
  let out = 0n;
  for (const segment of params.curve) {
    const stop = minBig(params.migrationSqrtPrice, segment.sqrtPrice);
    if (stop <= price) continue;
    const max = deltaQuote(price, stop, segment.liquidity, true);
    if (left < max) {
      const next = nextSqrtFromQuoteIn(price, segment.liquidity, left);
      out += deltaBase(price, next, segment.liquidity, false);
      left = 0n;
      break;
    }
    out += deltaBase(price, stop, segment.liquidity, false);
    left -= max;
    price = stop;
    if (stop === params.migrationSqrtPrice) break;
  }
  if (left !== 0n) throw new RangeError('That initial buy is larger than the curve holds before graduation.');
  if (out === 0n) throw new RangeError('That initial buy is too small to receive any tokens.');
  return { amountIn: amount, fee, expectedOut: out, minimumAmountOut: (out * (10_000n - slackBps)) / 10_000n };
}
