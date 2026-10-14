// The two things a creator approves in their wallet: launching the game's token, and putting the game's economy live
// (its collection, loot game, pools, items, boxes, recipes, schedules, lotteries, stakes; a game's old shop is part of
// it). Each is a flow for flow-engine.mjs: uploads to Arweave through Irys (one signMessage each, paid from the
// wallet's Irys balance; small files are free on Irys), then the transactions, which the wallet approves together in
// one prompt. What lands is written to gamesfun.json as it lands.
import { utf8 } from '../gf-web3/chain/bytes.js';
import { createConfigInstruction, createPoolInstruction, dbcPda, firstBuyInstructions, localPoolConfig, readPoolConfig, readVirtualPool } from '../gf-web3/chain/dbc.js';
import { curveParams, quoteFirstBuy, targetsForPair } from '../gf-web3/chain/dbc-curve.js';
import { decodeLoot, lootPda } from '../gf-web3/chain/loot.js';
import { parseMetaplexMetadata } from '../gf-web3/chain/mint.js';
import { associatedTokenAddress, metadataAddress, NATIVE_MINT, TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from '../gf-web3/chain/pda.js';
import { closeTokenAccount, syncNative, transferLamports } from '../gf-web3/chain/programs.js';
import { compileMessage, MAX_TRANSACTION_BYTES, readMessage, readTransaction, signersOf, wireTransaction } from '../gf-web3/chain/tx.js';
import { explorerUrl } from '../gf-web3/network.js';
import { fromUnits, gamePath, LIMIT, onChainUri, RuleError, text, ticker, toUnits } from '../gf-web3/rules.js';
import { migrateShop } from '../economy/migrate.mjs';
import { model } from '../economy/model.mjs';
import { collectionMetadata, describePair, itemMetadata, mintInfo, tokenMetadata } from './chain.mjs';
import { planToInstructions, publishedAt, publishPlan, readEconomy, recordLanded, resolver } from './economy.mjs';
import { freshKeypair } from './ed25519.mjs';
import { readConfig, readPicture, updateConfig } from './game.mjs';
import { irysNode, itemId, messageToSign, signedItem, unsignedItem } from './irys.mjs';

/** Irys stores files up to this size for free; bigger ones are paid from the wallet's Irys balance. */
export const FREE_UPLOAD_BYTES = 100 * 1024;
/** Pay this much more than the quoted price, so rounding never leaves an upload short. */
const DEPOSIT_MARGIN_PERCENT = 25n;
const MIN_DEPOSIT_LAMPORTS = 1_000_000n;
const BALANCE_POLLS = 30;
const BALANCE_POLL_MS = 2000;
/** SOL a launch needs besides a first buy: the config's, pool's, vaults' and metadata's rent and the fees (about). */
const LAUNCH_RENT_LAMPORTS = 60_000_000n;

const fail = (message) => {
  throw new RuleError(message);
};
const sol = (lamports) => `${fromUnits(lamports, 9)} SOL`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Plain names for the programs a transaction touches, for the approval screen. */
function programNames(network, wallet) {
  return {
    [wallet]: 'your wallet',
    '11111111111111111111111111111111': 'System',
    ComputeBudget111111111111111111111111111111: 'Compute budget',
    TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA: 'SPL Token',
    TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb: 'Token-2022',
    ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL: 'Associated Token Account',
    CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d: 'Metaplex Core',
    metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s: 'Metaplex Token Metadata',
    [network.loot.program]: 'games.fun loot program 0.3',
    [network.launchpad.dbcProgram]: 'Meteora Dynamic Bonding Curve',
  };
}

/** The programs the transactions call, by name, for the approval screen. */
function describe(network, wallet, wires) {
  const names = programNames(network, wallet);
  const programs = new Set();
  for (const wire of wires) {
    const m = readMessage(readTransaction(wire).message);
    for (const ix of m.instructions) programs.add(m.keys[ix.programIndex]);
  }
  return [`Programs: ${[...programs].map((p) => names[p] ?? p).join(', ')}`];
}

/** A legacy transaction from the wallet, signed by any fresh keys it creates. */
function buildWire({ payer, blockhash, instructions, signers = [] }) {
  const message = compileMessage({ payer, blockhash, instructions });
  const signatures = signersOf(message).map((address) => signers.find((s) => s.address === address)?.sign(message));
  const wire = wireTransaction(message, signatures);
  if (wire.length > MAX_TRANSACTION_BYTES) throw new Error(`The transaction is ${wire.length} bytes; the limit is ${MAX_TRANSACTION_BYTES}.`);
  return wire;
}

/** Send signed wires in order, each confirmed before the next; on failure, say which landed. */
async function sendInOrder(rpc, wires, lastValidBlockHeight) {
  const landed = [];
  for (const wire of wires) {
    try {
      const signature = await rpc.send(wire);
      await rpc.confirm(signature, { lastValidBlockHeight });
      landed.push(signature);
    } catch (error) {
      error.landed = landed;
      throw error;
    }
  }
  return landed;
}

// ---------------------------------------------------------------- steps

/**
 * An upload to Arweave through Irys. `build(flow)` returns { label, bytes, contentType }; `done(flow, upload)` records
 * { url, id, contentType, size }. A file over the free size first asks the wallet for an Irys deposit when its
 * balance is short (a SOL transfer the wallet approves), then for the upload's signature.
 */
function uploadStep(ctx, { title, build, done }) {
  const node = irysNode(ctx.network.irys, ctx.fetchImpl ? { fetchImpl: ctx.fetchImpl } : {});
  const state = { item: null, file: null, deposit: null, forceDeposit: false };
  return {
    title,
    async prepare(flow) {
      const file = await build(flow);
      state.file = file;
      const size = file.bytes.length;
      if (size > FREE_UPLOAD_BYTES || state.forceDeposit) {
        const price = await node.price(size + 2048);
        const balance = await node.balance(flow.wallet);
        if (balance < price) {
          let lamports = ((price - balance) * (100n + DEPOSIT_MARGIN_PERCENT)) / 100n;
          if (lamports < MIN_DEPOSIT_LAMPORTS) lamports = MIN_DEPOSIT_LAMPORTS;
          const to = await node.depositAddress();
          const { blockhash, lastValidBlockHeight } = await ctx.rpc.latestBlockhash();
          const wire = buildWire({ payer: flow.wallet, blockhash, instructions: [transferLamports(flow.wallet, to, lamports)] });
          await ctx.rpc.simulate(wire);
          state.deposit = { lamports, to, lastValidBlockHeight };
          return {
            kind: 'transactions',
            transactions: [wire],
            details: [`${file.label} is ${Math.ceil(size / 1024)} KB, over Irys’s free size. This adds ${sol(lamports)} to your Irys storage balance (node ${to}).`],
          };
        }
      }
      state.deposit = null;
      state.item = unsignedItem({ owner: flow.wallet, data: file.bytes, tags: [{ name: 'Content-Type', value: file.contentType }, { name: 'App-Name', value: 'games.fun' }] });
      return {
        kind: 'message',
        text: messageToSign(state.item),
        details: [`${file.label}: ${file.contentType}, ${Math.max(1, Math.ceil(size / 1024))} KB, stored on Arweave through Irys${size <= FREE_UPLOAD_BYTES ? ' (free at this size)' : ''}.`, 'Your wallet signs a receipt code for this file. It moves no funds.'],
      };
    },
    async complete(flow, answer) {
      if (answer.kind === 'transactions') {
        const [signature] = await sendInOrder(ctx.rpc, answer.transactions, state.deposit.lastValidBlockHeight);
        await node.registerDeposit(signature);
        for (let poll = 0; poll < BALANCE_POLLS; poll++) {
          if ((await node.balance(flow.wallet)) > 0n) break;
          await sleep(ctx.balancePollMs ?? BALANCE_POLL_MS);
        }
        state.forceDeposit = false;
        return { result: `Added ${sol(state.deposit.lamports)} to your Irys balance: ${explorerUrl(ctx.network, 'tx', signature)}`, again: true };
      }
      const bytes = signedItem(state.item, answer.signature);
      let id;
      try {
        id = await node.upload(bytes);
      } catch (error) {
        if (/\(402\)/.test(error.message)) {
          state.forceDeposit = true;
          return { result: 'Irys asked for payment for this file. Approve the deposit next.', again: true };
        }
        throw error;
      }
      if (id !== itemId(answer.signature)) throw new Error('Irys stored the file under an unexpected id.');
      const url = node.url(id);
      await done(flow, { url, id, contentType: state.file.contentType, size: state.file.bytes.length });
      return `Uploaded ${state.file.label}: ${url}`;
    },
  };
}

/**
 * The transactions of a flow, approved together. `build(flow, blockhash)` returns { wires, details, simulate: n }
 * (dry-run the first n), `landed(flow, signatures, partial)` records what landed and returns the result line.
 */
function transactionsStep(ctx, { title, build, landed }) {
  const state = { lastValidBlockHeight: null };
  return {
    title,
    async prepare(flow) {
      const { blockhash, lastValidBlockHeight } = await ctx.rpc.latestBlockhash();
      state.lastValidBlockHeight = lastValidBlockHeight;
      const built = await build(flow, blockhash);
      for (const wire of built.wires.slice(0, built.simulate ?? 1)) await ctx.rpc.simulate(wire);
      return { kind: 'transactions', transactions: built.wires, details: [...(built.details ?? []), ...describe(ctx.network, flow.wallet, built.wires)] };
    },
    async complete(flow, answer) {
      try {
        const signatures = await sendInOrder(ctx.rpc, answer.transactions, state.lastValidBlockHeight);
        return await landed(flow, signatures, false);
      } catch (error) {
        if (error.landed?.length) await landed(flow, error.landed, true);
        throw error;
      }
    },
  };
}

// ---------------------------------------------------------------- launch a token

/**
 * Launch the game's token on a Meteora bonding curve of its own: picture and details to Arweave, then the launch's
 * config (games.fun's partner wallet as fee claimer, the 95 / 5 split) and the pool on it, with the creator's
 * optional first buy in the pool's own transaction. One transaction when it fits, else two in order, approved at once.
 * input: { name, symbol, picture, description?, pair? ("SOL" default, "USDC", or a mint), initialBuy? (in the pair,
 * e.g. "0.5"), solUsd? (SOL's dollar price for sizing; devnet reference by default), startCap?, graduationCap? (the
 * curve's market caps in whole pair tokens; needed for a pair with no price) }
 */
export async function launchFlow(ctx, input, wallet) {
  const config = await readConfig(ctx.gameDir);
  if (config.token) fail(config.token.source === 'launched' ? `This game already launched $${config.token.symbol}.` : `This game uses $${config.token.symbol}. Stop using it before launching a new token.`);
  if (config.creator && config.creator !== wallet) fail(`This game belongs to the wallet ${config.creator}. Connect that wallet.`);
  const launch = await launchSteps(ctx, input, wallet, (c, token) => {
    c.creator = wallet;
    c.token = token;
  });
  return {
    kind: 'launch',
    title: `Launch $${launch.symbol} for this game`,
    lines: launch.lines,
    wallet,
    steps: launch.steps,
    context: { mint: launch.mint, pool: launch.pool, config: launch.config },
    onFinish: async () => ({ token: (await readConfig(ctx.gameDir)).token }),
  };
}

/** The creator's own market caps, both or neither, in whole pair tokens. */
function capsOf(input) {
  const start = String(input.startCap ?? '').trim();
  const graduation = String(input.graduationCap ?? '').trim();
  if (!start && !graduation) return null;
  if (!start || !graduation) fail('Set both market caps (start and graduation), or neither.');
  const caps = { initialMarketCap: Number(start), migrationMarketCap: Number(graduation) };
  if (!(caps.initialMarketCap > 0) || !(caps.migrationMarketCap > 0)) fail('Market caps are positive numbers, in whole pair tokens.');
  return caps;
}

/** The pair, its curve and the first buy's quote, checked before anything is uploaded. */
export async function launchPlan(ctx, input, wallet) {
  const { launchpad } = ctx.network;
  const pair = await describePair(ctx.rpc, ctx.network, input.pair ?? launchpad.defaultPair, { solUsd: input.solUsd ?? null });
  if (!pair.meteora.ok) fail(pair.meteora.reason);
  const caps = capsOf(input);
  if (!caps && pair.usd == null) fail(`${pair.symbol} has no price to size the curve with. Fix: set the start and graduation market caps, in ${pair.symbol} (e.g. --start-cap 1000000 --graduation-cap 15000000).`);
  let targets;
  let params;
  try {
    targets = targetsForPair(pair, caps);
    params = curveParams(targets);
  } catch (error) {
    fail(`${error.message}${caps ? '' : ' Fix: set the start and graduation market caps yourself.'}`);
  }
  const buyText = String(input.initialBuy ?? '').trim();
  const firstBuy = buyText && Number(buyText) !== 0 ? toUnits(buyText, pair.decimals) : null;
  let quote = null;
  if (firstBuy !== null) {
    try {
      quote = quoteFirstBuy(params, firstBuy);
    } catch (error) {
      fail(`${error.message} (the graduation amount is ${fromUnits(params.migrationQuoteThreshold, pair.decimals)} ${pair.symbol}).`);
    }
  }
  if (wallet) {
    const lamports = await ctx.rpc.balance(wallet);
    const needLamports = LAUNCH_RENT_LAMPORTS + (pair.native && firstBuy ? firstBuy : 0n);
    if (lamports < needLamports) fail(`Your wallet holds ${sol(lamports)}; launching${pair.native && firstBuy ? ` with a ${buyText} SOL first buy` : ''} needs about ${sol(needLamports)} (the new accounts’ rent and fees${pair.native && firstBuy ? ', plus the buy' : ''}).`);
    if (firstBuy !== null && !pair.native) {
      const have = await ctx.rpc.tokenBalance(associatedTokenAddress(wallet, pair.mint, pair.program === 'token-2022' ? TOKEN_2022_PROGRAM : TOKEN_PROGRAM));
      if (have < firstBuy) fail(`Your wallet holds ${fromUnits(have, pair.decimals)} ${pair.symbol}; the initial buy needs ${buyText}.`);
    }
  }
  return { pair, caps, targets, params, firstBuy, buyText, quote };
}

const capsLine = (plan) => {
  const { pair, targets } = plan;
  const usd = pair.usd != null && !plan.caps ? ` (about $${Math.round(targets.initialMarketCap * pair.usd).toLocaleString('en-US')} to $${Math.round(targets.migrationMarketCap * pair.usd).toLocaleString('en-US')} at ${pair.symbol} = $${pair.usd}, ${pair.usdSource})` : '';
  return `Curve: starts at a ${targets.initialMarketCap} ${pair.symbol} market cap and graduates at ${targets.migrationMarketCap} ${pair.symbol}${usd}; it graduates once ${fromUnits(plan.params.migrationQuoteThreshold, pair.decimals)} ${pair.symbol} is in.`;
};

/**
 * The steps of a token launch (uploads, then the launch transactions), for the launch flow and the economy flow.
 * `record(config, token)` writes the landed token into gamesfun.json (the config is saved after).
 */
async function launchSteps(ctx, input, wallet, record) {
  const name = text(input.name, 'Token name', { maxBytes: LIMIT.TokenNameBytes });
  const symbol = ticker(input.symbol);
  const description = text(input.description, 'Description', { maxChars: LIMIT.DescriptionChars, required: false });
  const picturePath = gamePath(input.picture, 'Picture');
  const picture = await readPicture(ctx.gameDir, picturePath);
  const { launchpad } = ctx.network;
  const plan = await launchPlan(ctx, input, wallet);
  const { pair, params, firstBuy, buyText, quote } = plan;
  const mint = freshKeypair();
  const configKey = freshKeypair();
  const pool = dbcPda.pool(pair.mint, mint.address, configKey.address);
  const local = localPoolConfig({ quoteMint: pair.mint, quoteTokenFlag: pair.program === 'token-2022' ? 1 : 0, params });
  const split = `games.fun’s partner wallet gets ${launchpad.split.partnerLockedLp}%: you keep ${launchpad.split.creatorTradingFeePercentage}% of the trading fees (after Meteora’s own cut), and the pool’s liquidity is locked ${launchpad.split.creatorLockedLp} to you and ${launchpad.split.partnerLockedLp} to games.fun when it graduates.`;
  const links = { image: null, metadata: null };
  const steps = [
    uploadStep(ctx, {
      title: 'Upload the token picture',
      build: async () => ({ label: 'The token picture', bytes: picture.bytes, contentType: picture.contentType }),
      done: async (flow, upload) => {
        links.image = upload.url;
      },
    }),
    uploadStep(ctx, {
      title: 'Upload the token details',
      build: async () => ({ label: 'The token details', bytes: utf8(JSON.stringify(tokenMetadata({ name, symbol, description, image: links.image, contentType: picture.contentType }))), contentType: 'application/json' }),
      done: async (flow, upload) => {
        links.metadata = onChainUri(upload.url);
      },
    }),
    transactionsStep(ctx, {
      title: `Create $${symbol}’s curve, paired with ${pair.symbol}${firstBuy ? ', and make your initial buy' : ''}`,
      build: async (flow, blockhash) => {
        const createConfig = createConfigInstruction({ config: configKey.address, feeClaimer: launchpad.partner, leftoverReceiver: launchpad.partner, quoteMint: pair.mint, payer: wallet, params });
        const createPool = createPoolInstruction({ configAddress: configKey.address, config: local, baseMint: mint.address, creator: wallet, name, symbol, uri: links.metadata });
        let buy = [];
        if (firstBuy) {
          // As the SDK's swap builder orders them: the two token accounts, the SOL wrap for a SOL pair, the swap, and
          // the wrapped SOL account closed after.
          const fb = firstBuyInstructions({ configAddress: configKey.address, config: local, baseMint: mint.address, buyer: wallet, amountIn: firstBuy, minimumAmountOut: quote.minimumAmountOut });
          const [quoteAta, baseAta, swap] = fb.instructions;
          const wrapped = associatedTokenAddress(wallet, NATIVE_MINT);
          buy = pair.native
            ? [quoteAta, baseAta, transferLamports(wallet, wrapped, firstBuy), syncNative(wrapped), swap, closeTokenAccount(wrapped, wallet, wallet)]
            : [quoteAta, baseAta, swap];
        }
        // No compute-budget instruction: the default (200,000 units for each instruction) covers it, and bytes are
        // short. One transaction when it fits; else the config first, then the pool with the buy (they always share
        // a transaction, so the buy pays the minimum fee and nobody trades in between).
        let wires;
        try {
          wires = [buildWire({ payer: wallet, blockhash, instructions: [createConfig, createPool, ...buy], signers: [configKey, mint] })];
        } catch (error) {
          if (!/limit is/.test(error.message)) throw error;
          wires = [
            buildWire({ payer: wallet, blockhash, instructions: [createConfig], signers: [configKey] }),
            buildWire({ payer: wallet, blockhash, instructions: [createPool, ...buy], signers: [mint] }),
          ];
        }
        return {
          wires,
          // The second of two cannot be simulated before the first lands (its config does not exist yet).
          simulate: 1,
          details: [
            `Mint ${mint.address} and curve config ${configKey.address} (fresh addresses; their one-time keys sign here and are then forgotten). Pool ${pool}.`,
            capsLine(plan),
            firstBuy ? `Initial buy: ${buyText} ${pair.symbol} for about ${fromUnits(quote.expectedOut, params.tokenDecimal)} $${symbol} (at least ${fromUnits(quote.minimumAmountOut, params.tokenDecimal)}), at the minimum 1% fee because it shares the pool’s transaction.` : 'No initial buy.',
            split,
            wires.length > 1 ? 'Two transactions, sent in order: the curve config, then the token (with your buy).' : 'One transaction.',
            'Your wallet becomes the token’s creator and pays the network fees and the new accounts’ rent (about 0.03 SOL).',
          ],
        };
      },
      landed: async (flow, signatures, partial) => {
        const signature = signatures[signatures.length - 1];
        // Trust the chain, not the page: the config must carry games.fun's partner and the split, the pool must exist
        // with this mint, config and creator, and the token's metadata must point at the uploaded details.
        const [configAccount, poolAccount, metadataAccount] = await ctx.rpc.accounts([configKey.address, pool, metadataAddress(mint.address)]);
        const cfg = configAccount ? readPoolConfig(configAccount.data) : null;
        const onChain = poolAccount ? readVirtualPool(poolAccount.data) : null;
        if (partial && !onChain) {
          configKey.drop();
          throw new Error(`The curve config ${configKey.address} was created (${signatures[0]}), but the token was not. Nothing else changed; launching again makes a new config.`);
        }
        const checks = {
          configExists: Boolean(cfg),
          feeClaimerIsPartner: cfg?.feeClaimer === launchpad.partner,
          creatorFee: cfg?.creatorTradingFeePercentage === launchpad.split.creatorTradingFeePercentage,
          partnerLockedLp: cfg?.partnerPermanentLockedLiquidityPercentage === launchpad.split.partnerLockedLp,
          quoteMint: cfg?.quoteMint === pair.mint,
          poolExists: Boolean(onChain),
          baseMint: onChain?.baseMint === mint.address,
          config: onChain?.config === configKey.address,
          creator: onChain?.creator === wallet,
          metadata: params.tokenType !== 0 || (metadataAccount ? parseMetaplexMetadata(metadataAccount.data).uri === links.metadata : false),
        };
        mint.drop();
        configKey.drop();
        const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([k]) => k);
        if (failed.length) throw new Error(`The launch transaction ${signature} landed, but the chain does not show the token as expected (${failed.join(', ')}).`);
        await updateConfig(ctx.gameDir, (c) => {
          record(c, {
            mint: mint.address,
            name,
            symbol,
            decimals: params.tokenDecimal,
            program: params.tokenType === 0 ? 'spl-token' : 'token-2022',
            source: 'launched',
            image: links.image,
            metadataUri: links.metadata,
            pool,
            config: configKey.address,
            quoteMint: pair.mint,
            quoteSymbol: pair.symbol,
            split: { creatorTradingFeePercentage: cfg.creatorTradingFeePercentage, partnerLockedLp: cfg.partnerPermanentLockedLiquidityPercentage, creatorLockedLp: cfg.creatorPermanentLockedLiquidityPercentage },
            signature,
            ...(signatures.length > 1 ? { signatures } : {}),
          });
          return c;
        });
        return `$${symbol} is live, paired with ${pair.symbol}: ${explorerUrl(ctx.network, 'tx', signature)}`;
      },
    }),
  ];
  return {
    symbol,
    mint: mint.address,
    pool,
    config: configKey.address,
    steps,
    lines: [
      `${name}${description ? `: ${description}` : ''}`,
      `Picture: ${picture.path}. Network: devnet. Paired with ${pair.symbol}.`,
      capsLine(plan),
      firstBuy ? `Initial buy: ${buyText} ${pair.symbol}.` : 'No initial buy.',
      split,
    ],
  };
}


// ---------------------------------------------------------------- put the economy live

/** A plan's transactions as wires: each plan transaction is one, split in two only if it does not fit after all. */
function economyWires({ wallet, blockhash, built, keys }) {
  const out = [];
  const signersFor = (names) => names.map((n) => keys[n]).filter(Boolean);
  const wireOf = (instructions, stepList) => {
    const names = [...new Set(stepList.flatMap((s) => s.signers.filter((x) => x.startsWith('new:'))))];
    return buildWire({ payer: wallet, blockhash, instructions, signers: signersFor(names) });
  };
  for (const tx of built.transactions) {
    try {
      out.push({ wire: wireOf(tx.instructions, tx.stepList), steps: tx.stepList, says: tx.says });
    } catch (error) {
      if (!/limit is/.test(error.message) || tx.instructions.length < 2) throw error;
      // The compiler sizes conservatively, but a Token-2022 mint's extras are only known now: split by step.
      let group = { instructions: [], steps: [] };
      const flush = () => group.instructions.length && out.push({ wire: wireOf(group.instructions, group.steps), steps: group.steps, says: [...new Set(group.steps.map((s) => s.says))] });
      tx.instructions.forEach((ix, i) => {
        const trial = { instructions: [...group.instructions, ix], steps: [...group.steps, tx.stepList[i]] };
        try {
          wireOf(trial.instructions, trial.steps);
          group = trial;
        } catch {
          flush();
          group = { instructions: [ix], steps: [tx.stepList[i]] };
        }
      });
      flush();
    }
  }
  return out;
}

const refusalText = (refusals) => refusals.map((r) => `${r.message}${r.fix ? ` Fix: ${r.fix}` : ''}`).join(' ');

/**
 * Everything the game's economy still needs on chain, in one wallet approval for the transactions (more when it
 * takes more transactions than one approval holds): a token launched on a curve of its own first (its uploads and its
 * own transaction), item pictures and details to Arweave, then the setup the compiler plans (builder/web3/economy/compile.mjs).
 * Once it is live, a change publishes only what differs from what is on chain (`diff`). Each transaction that lands
 * is written to gamesfun.json at once (economy.live). A game that still has a `shop` has it moved into its economy.
 * input: { picture? (for a token launched on a curve), description?, initialBuy?, pair?, solUsd?, startCap?, graduationCap?
 * (as launchFlow's), tokens?: { <key>: { picture, pair, … } } }
 */
export async function economyFlow(ctx, wallet, input = {}) {
  const read = await readEconomy(ctx.gameDir);
  const { config } = read;
  if (!read.economy) fail('This game has no economy yet. Write one into gamesfun.json (web3/economy/README.md has the parts and an example), or add an item in the studio.');
  if (config.creator && config.creator !== wallet) fail(`This game belongs to the wallet ${config.creator}. Connect that wallet.`);
  const live = read.economy.live ?? {};
  if (live.game) {
    const account = await ctx.rpc.account(live.game);
    const owner = account ? decodeLoot('Game', account.data).owner : null;
    if (owner && owner !== wallet) fail(`This economy’s game belongs to ${owner}. Connect that wallet.`);
  }
  const startedAt = Math.floor(Date.now() / 1000);
  const first = publishPlan(read.economy, { now: publishedAt(read.economy, startedAt) });
  if (!first.plan.ok) fail(`The economy is not ready to go live. ${refusalText(first.plan.refusals)}`);
  const m = model(first.next, { now: first.now });
  // Every mint the spec names must be on this network, in the token program it says.
  for (const t of m.tokens.values()) {
    if (t.wsol || !t.mint || t.mint.startsWith('@')) continue;
    const info = await mintInfo(ctx.rpc, t.mint).catch((e) => fail(`${t.symbol}: ${e.message}`));
    if (info.program !== t.program) fail(`${t.symbol} (${t.mint}) is a ${info.program === 'token-2022' ? 'Token-2022' : 'classic SPL'} token, but the economy says ${t.program}. Fix: set "program": "${info.program}" on the token "${t.key}".`);
  }

  const steps = [];
  const lines = [];
  // 1. Tokens to launch on a Meteora curve of their own: the token launch, as one part of the economy.
  for (const t of m.tokens.values()) {
    if (t.source !== 'curve' || !t.mint.startsWith('@')) continue;
    const own = input.tokens?.[t.key] ?? {};
    const picture = own.picture ?? input.picture;
    if (!picture) fail(`Launching ${t.symbol} needs a picture. Fix: pass one (npx gamesfun economy publish --picture assets/icon.png), or launch it from the token part of the Economy tab.`);
    const launch = await launchSteps(ctx, { name: t.name, symbol: t.symbol, description: own.description ?? input.description ?? '', picture, initialBuy: own.initialBuy ?? input.initialBuy ?? '', pair: own.pair ?? t.pair ?? input.pair, solUsd: own.solUsd ?? input.solUsd, startCap: own.startCap ?? input.startCap, graduationCap: own.graduationCap ?? input.graduationCap }, wallet, (c, token) => {
      if (!c.economy && c.shop) c.economy = migrateShop(c).config.economy;
      const spec = c.economy.tokens.find((x) => x.key === t.key);
      Object.assign(spec, { mint: token.mint, decimals: token.decimals, program: token.program, venue: 'games.fun', ...(token.image ? { image: token.image } : {}), ...(token.metadataUri ? { uri: token.metadataUri } : {}) });
      delete c.shop;
      c.creator ??= wallet;
      c.token ??= token;
    });
    steps.push(...launch.steps);
    lines.push(`First: launch $${launch.symbol} on a Meteora curve of its own (two uploads, then the launch: one or two transactions).`);
  }

  // 2. Pictures and details to Arweave, for items with a picture and no details yet, and the collection's.
  const economyName = read.economy.name ?? m.name;
  const pictureOf = new Map();
  for (const it of m.items) if (it.picture && !it.uri) pictureOf.set(it.key, await readPicture(ctx.gameDir, it.picture).catch(() => null));
  const writeItem = (key, fields) =>
    updateConfig(ctx.gameDir, (c) => {
      if (!c.economy && c.shop) {
        c.economy = migrateShop(c).config.economy;
        delete c.shop;
      }
      Object.assign(c.economy.items.find((i) => i.key === key), fields);
      return c;
    });
  for (const it of m.items) {
    const picture = pictureOf.get(it.key);
    if (!picture) continue;
    if (!it.image)
      steps.push(uploadStep(ctx, { title: `Upload the picture of ${it.name}`, build: async () => ({ label: `The picture of ${it.name}`, bytes: picture.bytes, contentType: picture.contentType }), done: async (flow, upload) => writeItem(it.key, { image: upload.url }) }));
    steps.push(
      uploadStep(ctx, {
        title: `Upload the details of ${it.name}`,
        build: async () => {
          const now = (await readEconomy(ctx.gameDir)).economy.items.find((i) => i.key === it.key);
          return { label: `The details of ${it.name}`, bytes: utf8(JSON.stringify(itemMetadata({ name: economyName }, { ...now, rarity: now.rarity ?? 'Common', soulbound: !!now.soulbound }, now.image, picture.contentType))), contentType: 'application/json' };
        },
        done: async (flow, upload) => writeItem(it.key, { uri: onChainUri(upload.url) }),
      }),
    );
  }
  const collectionImage = () => readEconomy(ctx.gameDir).then(({ economy }) => economy.collection?.image ?? economy.items?.find((i) => i.image)?.image ?? null);
  if (!live.collection && !m.collection.uri && (read.economy.collection?.image || pictureOf.size || m.items.some((i) => i.image))) {
    steps.push(
      uploadStep(ctx, {
        title: 'Upload the collection’s details',
        build: async () => ({ label: 'The collection details', bytes: utf8(JSON.stringify(collectionMetadata({ name: m.collection.name, description: m.collection.description }, await collectionImage(), 'image/png'))), contentType: 'application/json' }),
        done: async (flow, upload) =>
          updateConfig(ctx.gameDir, (c) => {
            if (!c.economy && c.shop) {
              c.economy = migrateShop(c).config.economy;
              delete c.shop;
            }
            c.economy.collection = { ...(c.economy.collection ?? {}), uri: onChainUri(upload.url) };
            return c;
          }),
      }),
    );
  }

  // 3. The setup, in as few approvals as the transactions need.
  const keys = {};
  const state = { prepared: null, lastValidBlockHeight: null, approvals: 0 };
  const rent = async (bytes) => BigInt(await ctx.rpc.call('getMinimumBalanceForRentExemption', [Number(bytes)]));
  const ownerTransactions = (plan) => plan.transactions.filter((t) => t.signer === 'owner');
  const waiting = (plan) => plan.transactions.filter((t) => t.signer !== 'owner');
  steps.push({
    title: live.game ? 'Put the changes live' : `Put ${economyName} live`,
    async prepare(flow) {
      const fresh = await readEconomy(ctx.gameDir);
      const { plan, next, now } = publishPlan(fresh.economy, { now: publishedAt(fresh.economy, startedAt) });
      if (!plan.ok) fail(`The economy is not ready to go live. ${refusalText(plan.refusals)}`);
      const mine = ownerTransactions(plan);
      if (!mine.length) fail(waiting(plan).length ? `What is left needs the authority’s wallet (${model(next).authority}).` : 'Everything is already live.');
      for (const tx of mine) for (const name of tx.signers) if (name.startsWith('new:') && !keys[name]) keys[name] = freshKeypair();
      const liveNow = fresh.economy.live ?? {};
      const ctxBuild = { economy: next, owner: wallet, keys, rpc: ctx.rpc, rent, collection: liveNow.collection ?? keys['new:collection']?.address };
      const { blockhash, lastValidBlockHeight } = await ctx.rpc.latestBlockhash();
      const built = await planToInstructions({ ...plan, transactions: mine.slice(0, LIMIT.PublishTransactions) }, ctxBuild);
      const wires = economyWires({ wallet, blockhash, built, keys }).slice(0, LIMIT.PublishTransactions);
      const resolve = resolver(ctxBuild);
      state.prepared = { wires, next, now, ctxBuild, collection: ctxBuild.collection, treasury: resolve(`ata:owner/${model(next).currencyKey}`), authority: resolve('@wallet:authority') };
      state.lastValidBlockHeight = lastValidBlockHeight;
      await ctx.rpc.simulate(wires[0].wire);
      const more = mine.length - built.transactions.length;
      const kinds = (prefix) => wires.flatMap((w) => w.steps).filter((s) => s.id.startsWith(prefix)).length;
      return {
        kind: 'transactions',
        transactions: wires.map((w) => w.wire),
        details: [
          ...(liveNow.game ? ['Only what changed since it went live.'] : [`A new collection ${keys['new:collection']?.address ?? ''} (Metaplex Core): your wallet is its update authority; the loot program may mint into it. The game ${lootPda.game(ctxBuild.collection)} on games.fun’s loot program 0.3 is yours: you own it and change it.`]),
          ...wires.map((w, i) => `Transaction ${i + 1}: ${w.says.join('; ')}.`),
          ...plan.notes.filter((n) => !/Compute units/.test(n)),
          `${wires.length} transaction${wires.length === 1 ? '' : 's'}, one approval: ${kinds('pool:')} pool(s), ${kinds('item:')} item(s), ${kinds('box:')} box(es), ${kinds('recipe:')} recipe(s), ${kinds('schedule:')} schedule(s), ${kinds('lottery:')} lotter${kinds('lottery:') === 1 ? 'y' : 'ies'}, ${kinds('stake:')} stake(s).`,
          ...(more > 0 ? [`${more} more transaction${more === 1 ? '' : 's'} after this approval: your wallet asks again.`] : []),
          `Your wallet pays the network fees and each new account’s rent; games.fun’s loot program charges no fee to set an economy up.`,
        ],
      };
    },
    async complete(flow, answer) {
      const p = state.prepared;
      const landed = [];
      const mints = Object.fromEntries(Object.entries(keys).filter(([n]) => n.startsWith('new:mint/')).map(([n, k]) => [n.slice('new:mint/'.length), k.address]));
      for (const [i, wire] of answer.transactions.entries()) {
        let signature;
        try {
          signature = await ctx.rpc.send(wire);
          await ctx.rpc.confirm(signature, { lastValidBlockHeight: state.lastValidBlockHeight });
        } catch (error) {
          if (landed.length) flow.results.push(`Part of it landed (${landed.length} of ${answer.transactions.length} transactions): ${landed.map((s) => explorerUrl(ctx.network, 'tx', s)).join(' ')}. Press Approve again for the rest.`);
          throw error;
        }
        landed.push(signature);
        await updateConfig(ctx.gameDir, (c) => {
          let next = c;
          if (!next.economy && next.shop) {
            next = migrateShop(next).config;
            delete next.shop;
          }
          return recordLanded(next, { signature, steps: p.wires[i].steps, next: p.next, owner: wallet, collection: p.collection, treasury: p.treasury, authority: p.authority, mints, at: new Date(p.now * 1000).toISOString() });
        });
      }
      state.approvals += 1;
      const links = landed.map((s) => explorerUrl(ctx.network, 'tx', s)).join(' ');
      const after = publishPlan((await readEconomy(ctx.gameDir)).economy, { now: p.now });
      const left = after.plan.ok ? ownerTransactions(after.plan).length : 0;
      if (left) return { result: `Landed ${landed.length} transaction${landed.length === 1 ? '' : 's'}: ${links}. ${left} more to approve.`, again: true };
      const authority = after.plan.ok ? waiting(after.plan).length : 0;
      return `${live.game ? 'Your changes are live' : 'Your economy is live'}: ${links}${authority ? ` (${authority} transaction${authority === 1 ? '' : 's'} wait for the authority’s wallet)` : ''}`;
    },
  });

  const owners = ownerTransactions(first.plan).length;
  return {
    kind: 'economy',
    title: live.game ? `Put the changes to ${economyName} live` : `Put ${economyName} live`,
    lines: [
      ...read.notes.filter((n) => !/^There is no shop/.test(n)),
      ...lines,
      `Priced in ${m.currency?.symbol ?? 'its currency'}. ${owners} transaction${owners === 1 ? '' : 's'} (${Math.max(1, Math.ceil(owners / LIMIT.PublishTransactions))} approval${owners > LIMIT.PublishTransactions ? 's' : ''}) ${live.game ? 'for what changed' : 'to set it up'}.`,
      ...first.plan.warnings.slice(0, 5).map((w) => `Note: ${w.message}`),
      ...m.items.filter((i) => !i.uri && !i.picture && !i.image).slice(0, 3).map((i) => `${i.name} has no picture: it goes live without one (wallets show its name).`),
    ],
    wallet,
    steps,
    onFinish: async () => {
      for (const k of Object.values(keys)) k.drop?.();
      const { economy } = await readEconomy(ctx.gameDir);
      return { game: economy.live?.game ?? null, collection: economy.live?.collection ?? null, explorer: economy.live?.game ? explorerUrl(ctx.network, 'address', economy.live.game) : null };
    },
  };
}

/** The shop's old publish: a game's shop is part of its economy now, so this is the economy flow. */
export const publishFlow = (ctx, wallet, input) => economyFlow(ctx, wallet, input);
