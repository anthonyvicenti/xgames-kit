// Meteora Dynamic Bonding Curve (DBC): the instructions a token launch needs (create the launch's own config, create
// the pool on it, and the creator's optional first buy in the same transaction as the pool) and the few config and pool
// fields the kit reads. Discriminators, account orders and account layouts come from the DBC IDL (program version
// 0.2.1) shipped inside @meteora-ag/dynamic-bonding-curve-sdk 1.5.12 (MIT, see THIRD_PARTY.md);
// tests/web3-chain.test.mjs checks the pool and swap builders against what that SDK builds, and
// tests/web3-dbc-config.test.mjs checks createConfig against games.fun's launchpad (launch/own-config.mjs), byte for
// byte. The config's numbers come from dbc-curve.js.
import { addressBytes, encodeBase58 } from './base58.js';
import { compareBytes, concat, readUintLE, uintLE, utf8 } from './bytes.js';
import {
  associatedTokenAddress,
  metadataAddress,
  METAPLEX_METADATA_PROGRAM,
  pdaOf,
  SYSTEM_PROGRAM,
  SYSVAR_INSTRUCTIONS,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
} from './pda.js';
import { createAssociatedTokenAccountIdempotent, meta } from './programs.js';

export const DBC_PROGRAM = 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN';

const DISCRIMINATOR = {
  createConfig: Uint8Array.of(201, 207, 243, 114, 75, 111, 47, 189),
  initializeWithSplToken: Uint8Array.of(140, 85, 215, 176, 102, 54, 104, 79),
  initializeWithToken2022: Uint8Array.of(169, 118, 51, 78, 145, 110, 220, 155),
  swap: Uint8Array.of(248, 198, 158, 145, 225, 117, 135, 200),
};
const ACCOUNT_DISCRIMINATOR = {
  PoolConfig: Uint8Array.of(26, 108, 14, 123, 116, 230, 129, 43),
  VirtualPool: Uint8Array.of(213, 224, 5, 209, 98, 69, 119, 92),
};

/** Byte offsets in a PoolConfig account (bytemuck, 1048 bytes including the discriminator). */
const CONFIG = {
  bytes: 1048,
  quoteMint: 8,
  feeClaimer: 40,
  leftoverReceiver: 72,
  baseFeeMode: 104 + 26,
  activationType: 234,
  tokenDecimal: 235,
  version: 236,
  tokenType: 237,
  quoteTokenFlag: 238,
  partnerPermanentLockedLiquidityPercentage: 239,
  partnerLiquidityPercentage: 240,
  creatorPermanentLockedLiquidityPercentage: 241,
  creatorLiquidityPercentage: 242,
  creatorTradingFeePercentage: 245,
  creatorMigrationFeePercentage: 248,
  migrationQuoteThreshold: 264,
  preMigrationTokenSupply: 344,
  postMigrationTokenSupply: 352,
  enableFirstSwapWithMinFee: 365,
  migratedCompoundingFeeBps: 366,
};
/** Byte offsets in a VirtualPool account (424 bytes). */
const POOL = {
  bytes: 424,
  config: 72,
  creator: 104,
  baseMint: 136,
  baseVault: 168,
  quoteVault: 200,
  baseReserve: 232,
  quoteReserve: 240,
  isMigrated: 305,
};

const TokenType = { SplToken: 0, Token2022: 1 };
const RATE_LIMITER_MODE = 2;

export const dbcPda = {
  poolAuthority: () => pdaOf([utf8('pool_authority')], DBC_PROGRAM),
  eventAuthority: () => pdaOf([utf8('__event_authority')], DBC_PROGRAM),
  /** The pool of a base mint under a config: seeds put the larger of the two mints first. */
  pool: (quoteMint, baseMint, config) => {
    const quote = addressBytes(quoteMint);
    const base = addressBytes(baseMint);
    const [first, second] = compareBytes(quote, base) > 0 ? [quote, base] : [base, quote];
    return pdaOf([utf8('pool'), addressBytes(config), first, second], DBC_PROGRAM);
  },
  tokenVault: (pool, mint) => pdaOf([utf8('token_vault'), addressBytes(mint), addressBytes(pool)], DBC_PROGRAM),
};

const tokenProgramOf = (flag) => (flag === TokenType.Token2022 ? TOKEN_2022_PROGRAM : TOKEN_PROGRAM);

const startsWith = (data, prefix) => data.length >= prefix.length && prefix.every((b, i) => data[i] === b);
const address = (data, at) => encodeBase58(data.subarray(at, at + 32));

/** The PoolConfig fields a launch needs. Throws when the data is not a PoolConfig. */
export function readPoolConfig(data) {
  if (data.length !== CONFIG.bytes || !startsWith(data, ACCOUNT_DISCRIMINATOR.PoolConfig)) throw new Error('Not a DBC pool config');
  return {
    quoteMint: address(data, CONFIG.quoteMint),
    feeClaimer: address(data, CONFIG.feeClaimer),
    leftoverReceiver: address(data, CONFIG.leftoverReceiver),
    baseFeeMode: data[CONFIG.baseFeeMode],
    activationType: data[CONFIG.activationType],
    tokenDecimal: data[CONFIG.tokenDecimal],
    tokenType: data[CONFIG.tokenType],
    quoteTokenFlag: data[CONFIG.quoteTokenFlag],
    // The split games.fun's registry reads (loot program venue.rs uses the same offsets).
    partnerPermanentLockedLiquidityPercentage: data[CONFIG.partnerPermanentLockedLiquidityPercentage],
    partnerLiquidityPercentage: data[CONFIG.partnerLiquidityPercentage],
    creatorPermanentLockedLiquidityPercentage: data[CONFIG.creatorPermanentLockedLiquidityPercentage],
    creatorLiquidityPercentage: data[CONFIG.creatorLiquidityPercentage],
    creatorTradingFeePercentage: data[CONFIG.creatorTradingFeePercentage],
    creatorMigrationFeePercentage: data[CONFIG.creatorMigrationFeePercentage],
    migratedCompoundingFeeBps: Number(readUintLE(data, CONFIG.migratedCompoundingFeeBps, 2)),
    migrationQuoteThreshold: readUintLE(data, CONFIG.migrationQuoteThreshold, 8),
    preMigrationTokenSupply: readUintLE(data, CONFIG.preMigrationTokenSupply, 8),
    postMigrationTokenSupply: readUintLE(data, CONFIG.postMigrationTokenSupply, 8),
    enableFirstSwapWithMinFee: data[CONFIG.enableFirstSwapWithMinFee] === 1,
  };
}

/** The VirtualPool fields the status read shows. */
export function readVirtualPool(data) {
  if (data.length !== POOL.bytes || !startsWith(data, ACCOUNT_DISCRIMINATOR.VirtualPool)) throw new Error('Not a DBC pool');
  return {
    config: address(data, POOL.config),
    creator: address(data, POOL.creator),
    baseMint: address(data, POOL.baseMint),
    baseVault: address(data, POOL.baseVault),
    quoteVault: address(data, POOL.quoteVault),
    baseReserve: readUintLE(data, POOL.baseReserve, 8),
    quoteReserve: readUintLE(data, POOL.quoteReserve, 8),
    isMigrated: data[POOL.isMigrated] === 1,
  };
}

const borshString = (text) => {
  const bytes = utf8(text);
  return concat(uintLE(bytes.length, 4), bytes);
};

const u8 = (n) => Uint8Array.of(n);
const u16 = (n) => uintLE(n, 2);
const u32 = (n) => uintLE(n, 4);
const u64 = (n) => uintLE(n, 8);
const u128 = (n) => uintLE(n, 16);
const bool = (b) => u8(b ? 1 : 0);
const option = (value, encode) => (value == null ? u8(0) : concat(u8(1), encode(value)));

/** ConfigParameters, Borsh, in the IDL's field order. */
export function encodeConfigParameters(p) {
  const f = p.poolFees;
  const vesting = (v) => concat(u8(v.vestingPercentage), u16(v.bpsPerPeriod), u16(v.numberOfPeriods), u32(v.cliffDurationFromMigrationTime), u32(v.frequency));
  return concat(
    u64(f.baseFee.cliffFeeNumerator), u16(f.baseFee.firstFactor), u64(f.baseFee.secondFactor), u64(f.baseFee.thirdFactor), u8(f.baseFee.baseFeeMode),
    option(f.dynamicFee, (d) => concat(u16(d.binStep), u128(d.binStepU128), u16(d.filterPeriod), u16(d.decayPeriod), u16(d.reductionFactor), u32(d.maxVolatilityAccumulator), u32(d.variableFeeControl))),
    u8(p.collectFeeMode), u8(p.migrationOption), u8(p.activationType), u8(p.tokenType), u8(p.tokenDecimal),
    u8(p.partnerLiquidityPercentage), u8(p.partnerPermanentLockedLiquidityPercentage), u8(p.creatorLiquidityPercentage), u8(p.creatorPermanentLockedLiquidityPercentage),
    u64(p.migrationQuoteThreshold), u128(p.sqrtStartPrice),
    u64(p.lockedVesting.amountPerPeriod), u64(p.lockedVesting.cliffDurationFromMigrationTime), u64(p.lockedVesting.frequency), u64(p.lockedVesting.numberOfPeriod), u64(p.lockedVesting.cliffUnlockAmount),
    u8(p.migrationFeeOption),
    option(p.tokenSupply, (t) => concat(u64(t.preMigrationTokenSupply), u64(t.postMigrationTokenSupply))),
    u8(p.creatorTradingFeePercentage), u8(p.tokenUpdateAuthority),
    u8(p.migrationFee.feePercentage), u8(p.migrationFee.creatorFeePercentage),
    u8(p.migratedPoolFee.collectFeeMode), u8(p.migratedPoolFee.dynamicFee), u16(p.migratedPoolFee.poolFeeBps),
    u64(p.poolCreationFee),
    vesting(p.partnerLiquidityVestingInfo), vesting(p.creatorLiquidityVestingInfo),
    u8(p.migratedPoolBaseFeeMode),
    u16(p.migratedPoolMarketCapFeeSchedulerParams.numberOfPeriod), u16(p.migratedPoolMarketCapFeeSchedulerParams.sqrtPriceStepBps),
    u32(p.migratedPoolMarketCapFeeSchedulerParams.schedulerExpirationDuration), u64(p.migratedPoolMarketCapFeeSchedulerParams.reductionFactor),
    bool(p.enableFirstSwapWithMinFee), u16(p.compoundingFeeBps), new Uint8Array(2),
    u32(p.curve.length), ...p.curve.map((c) => concat(u128(c.sqrtPrice), u128(c.liquidity))),
  );
}

/**
 * createConfig: a config of the launch's own (a fresh keypair that signs once), with games.fun's partner wallet as
 * fee claimer and leftover receiver, quoted in the pair's mint; the creator pays its rent. `params` from
 * dbc-curve.js curveParams. No partner signature: the fee claimer and leftover receiver are plain accounts.
 */
export function createConfigInstruction({ config, feeClaimer, leftoverReceiver = feeClaimer, quoteMint, payer, params }) {
  return {
    programId: DBC_PROGRAM,
    keys: [
      meta(config, true, true),
      meta(feeClaimer, false, false),
      meta(leftoverReceiver, false, false),
      meta(quoteMint, false, false),
      meta(payer, true, true),
      meta(SYSTEM_PROGRAM, false, false),
      meta(dbcPda.eventAuthority(), false, false),
      meta(DBC_PROGRAM, false, false),
    ],
    data: concat(DISCRIMINATOR.createConfig, encodeConfigParameters(params)),
  };
}

/** The fields createPoolInstruction and firstBuyInstructions read, for a config this transaction creates. */
export const localPoolConfig = ({ quoteMint, quoteTokenFlag = 0, params }) => ({
  quoteMint,
  quoteTokenFlag,
  tokenType: params.tokenType,
  tokenDecimal: params.tokenDecimal,
  baseFeeMode: params.poolFees.baseFee.baseFeeMode,
  enableFirstSwapWithMinFee: params.enableFirstSwapWithMinFee,
  migrationQuoteThreshold: params.migrationQuoteThreshold,
});

/**
 * Create a pool (and its base mint, with Metaplex metadata for a classic SPL base) under a config.
 * `config` is the decoded PoolConfig. The base mint and the payer sign.
 */
export function createPoolInstruction({ configAddress, config, baseMint, creator, payer = creator, name, symbol, uri }) {
  const pool = dbcPda.pool(config.quoteMint, baseMint, configAddress);
  const spl = config.tokenType === TokenType.SplToken;
  const keys = [
    meta(configAddress, false, false),
    meta(dbcPda.poolAuthority(), false, false),
    meta(creator, true, false),
    meta(baseMint, true, true),
    meta(config.quoteMint, false, false),
    meta(pool, false, true),
    meta(dbcPda.tokenVault(pool, baseMint), false, true),
    meta(dbcPda.tokenVault(pool, config.quoteMint), false, true),
    ...(spl ? [meta(metadataAddress(baseMint), false, true), meta(METAPLEX_METADATA_PROGRAM, false, false)] : []),
    meta(payer, true, true),
    meta(tokenProgramOf(config.quoteTokenFlag), false, false),
    meta(spl ? TOKEN_PROGRAM : TOKEN_2022_PROGRAM, false, false),
    meta(SYSTEM_PROGRAM, false, false),
    meta(dbcPda.eventAuthority(), false, false),
    meta(DBC_PROGRAM, false, false),
  ];
  const data = concat(
    spl ? DISCRIMINATOR.initializeWithSplToken : DISCRIMINATOR.initializeWithToken2022,
    borshString(name),
    borshString(symbol),
    borshString(uri),
  );
  return { programId: DBC_PROGRAM, keys, data, pool };
}

/**
 * The creator's first buy on a pool the same transaction creates: their token accounts (idempotent), then a swap
 * from the quote token into the new token. With `enableFirstSwapWithMinFee` the program charges the minimum fee
 * when it can see (through the instructions sysvar) that the pool was created in this transaction.
 */
export function firstBuyInstructions({ configAddress, config, baseMint, buyer, amountIn, minimumAmountOut }) {
  const pool = dbcPda.pool(config.quoteMint, baseMint, configAddress);
  const quoteProgram = tokenProgramOf(config.quoteTokenFlag);
  const baseProgram = config.tokenType === TokenType.SplToken ? TOKEN_PROGRAM : TOKEN_2022_PROGRAM;
  const input = associatedTokenAddress(buyer, config.quoteMint, quoteProgram);
  const output = associatedTokenAddress(buyer, baseMint, baseProgram);
  const sysvar = config.enableFirstSwapWithMinFee || config.baseFeeMode === RATE_LIMITER_MODE;
  const swap = {
    programId: DBC_PROGRAM,
    keys: [
      meta(dbcPda.poolAuthority(), false, false),
      meta(configAddress, false, false),
      meta(pool, false, true),
      meta(input, false, true),
      meta(output, false, true),
      meta(dbcPda.tokenVault(pool, baseMint), false, true),
      meta(dbcPda.tokenVault(pool, config.quoteMint), false, true),
      meta(baseMint, false, false),
      meta(config.quoteMint, false, false),
      meta(buyer, true, false),
      meta(baseProgram, false, false),
      meta(quoteProgram, false, false),
      meta(DBC_PROGRAM, false, false), // referral token account: none (Anchor passes the program id)
      meta(dbcPda.eventAuthority(), false, false),
      meta(DBC_PROGRAM, false, false),
      ...(sysvar ? [meta(SYSVAR_INSTRUCTIONS, false, false)] : []),
    ],
    data: concat(DISCRIMINATOR.swap, uintLE(amountIn, 8), uintLE(minimumAmountOut, 8)),
  };
  return {
    instructions: [
      createAssociatedTokenAccountIdempotent(buyer, buyer, config.quoteMint, quoteProgram),
      createAssociatedTokenAccountIdempotent(buyer, buyer, baseMint, baseProgram),
      swap,
    ],
    output,
  };
}
