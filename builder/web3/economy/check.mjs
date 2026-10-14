// The economy checker. Refusals stop an economy from going live: each has a code, what it means for the creator
// and the fix. Warnings are what the creator should know before going live. Pure.
//
// Most refusals are the program's own (launchpad/loot/programs/loot/src in games.fun, cited by file), caught here
// so the creator hears about them in words before a wallet is ever asked. The rest are traps the program's own
// notes name: a stake that empties a lottery's pot (stake.rs), a pool nothing fills, a recipe too big to send.
import { isSignature } from '../gf-web3/chain/base58.js';
import { secretLike } from '../gf-web3/rules.js';
import {
  FEES,
  LIMITS,
  RESERVED_ATTRIBUTES,
  SpecError,
  destination,
  fromUnits,
  isAddress,
  model,
  poolFillers,
  poolTakers,
  sharesOf,
  toBps,
  toSeconds,
  toTime,
  toUnits,
  utf8Bytes,
} from './model.mjs';
import { BUDGET, MAX_TRANSACTION_BYTES, transactionSize } from './txsize.mjs';
import { simulate } from './simulate.mjs';
import { validate } from './validate.mjs';

const label = (part) => `“${part?.name ?? part?.key}”`;

// ---------------------------------------------------------------- secrets

const MNEMONIC_LENGTHS = new Set([12, 15, 18, 21, 24]);
/** A seed phrase: 12 to 24 lower-case words of 3 to 8 letters and nothing else (no sentence is only such words). */
const seedPhrase = (s) => {
  const words = s.trim().split(/\s+/);
  return MNEMONIC_LENGTHS.has(words.length) && words.every((w) => /^[a-z]{3,8}$/.test(w));
};

/** Every place in `value` that looks like a key, a seed phrase or a keypair file. */
export function findSecrets(value, path = 'economy') {
  if (typeof value === 'string') return secretLike(value) || seedPhrase(value) ? [path] : [];
  if (Array.isArray(value)) {
    if (value.length >= 32 && value.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) return [path];
    return value.flatMap((v, i) => findSecrets(v, `${path}[${i}]`));
  }
  // A transaction's signature is as long as a key; gamesfun.json keeps signatures in fields named "signature" only.
  if (value && typeof value === 'object')
    return Object.entries(value).flatMap(([k, v]) => (k === 'signature' && isSignature(v) ? [] : [...(secretLike(`${k}:`) ? [`${path}.${k}`] : []), ...findSecrets(v, `${path}.${k}`)]));
  return [];
}

// ---------------------------------------------------------------- a player's craft, in bytes

/**
 * The transaction a player sends to craft `recipe`, estimated (txsize.mjs): the craft's own accounts, then each
 * line's (craft.rs, `Craft`), a compute limit (a big recipe needs more than the default) and, for each token it
 * gives, the player's token account created if missing.
 */
export function craftSize(recipe, m) {
  const fixed = ['wallet:player', 'pda:game', `pda:recipe/${recipe.key}`, 'pda:collection', 'program:mpl-core', 'program:token', 'program:token-2022', 'pda:platform', 'pda:fees', 'program:system'];
  const rest = [];
  const signers = ['wallet:player'];
  const extra = [{ program: 'compute-budget', accounts: [], data: 5 }];
  let asset = 0;
  const mintOf = (key) => `mint:${key ?? m.currencyKey}`;
  for (const line of recipe.in ?? []) {
    if (line.takes === 'burn') rest.push(`pda:item/${line.item}`, ...Array.from({ length: line.count ?? 1 }, () => `asset:${asset++}`));
    else if (line.takes === 'use' || line.takes === 'renew') rest.push(`pda:item/${line.item}`, `asset:${asset++}`);
    else if (line.takes === 'pay') {
      rest.push(mintOf(line.currency), `ata:player/${line.currency ?? m.currencyKey}`);
      const d = destination(line.to);
      if (d.kind === 'pool') rest.push(`pda:pool/${d.key}`);
      if (d.kind === 'account') rest.push(`account:${d.key}`);
      if (d.kind === 'holder') rest.push(`asset:${d.key}`, `ata:holder/${d.key}`);
    }
  }
  const gives = new Set();
  recipe.out?.forEach((line, i) => {
    if (line.gives === 'item') {
      rest.push(`pda:item/${line.item}`, `new:asset/${i}`);
      signers.push(`new:asset/${i}`);
    } else {
      const currency = line.gives === 'share' ? m.pool.get(line.pool)?.currency : line.currency ?? m.currencyKey;
      const pool = line.gives === 'share' ? line.pool : line.from?.startsWith('pool:') ? line.from.slice(5) : null;
      rest.push(mintOf(currency), ...(pool ? [`pda:pool/${pool}`] : []), `ata:player/${currency}`);
      gives.add(currency);
    }
  });
  for (const currency of gives) extra.push({ program: 'associated-token', accounts: ['wallet:player', `ata:player/${currency}`, 'wallet:player', mintOf(currency), 'program:system', 'program:token'], data: 1 });
  return transactionSize({ signers, instructions: [...extra, { program: 'loot', accounts: [...fixed, ...rest], data: 8 + 4 + 8 }] });
}

// ---------------------------------------------------------------- the checker

/**
 * Checks an economy spec. `network` is the game's (gamesfun.json); `now` (Unix seconds) dates "publish".
 * Returns { ok, refusals: [{ code, where, message, fix }], warnings: [{ code, where, message, fix? }] }.
 */
export function check(economy, { network = 'devnet', now = Math.floor(Date.now() / 1000) } = {}) {
  const refusals = [];
  const warnings = [];
  const refuse = (code, where, message, fix) => refusals.push({ code, where, message, fix });
  const warn = (code, where, message, fix) => warnings.push({ code, where, message, ...(fix ? { fix } : {}) });
  const result = () => ({ ok: refusals.length === 0, refusals, warnings });

  for (const where of findSecrets(economy))
    refuse('E-SECRET', where, 'This looks like a private key, a seed phrase or a keypair file. Anything in the economy is public: whoever reads it could take the wallet.', 'Delete it now and move the funds of that wallet to a new one. A spec only ever holds public addresses.');
  if (network !== 'devnet' || (economy?.network && economy.network !== 'devnet'))
    refuse('E-NETWORK', 'economy.network', `The economy names the network “${economy?.network ?? network}”. The kit runs economies on devnet only: mainnet waits for an audit, a multisig and counsel.`, 'Set the network to "devnet".');
  for (const e of validate(economy)) refuse('E-SCHEMA', e.path, `${e.path} ${e.message}.`, 'Fix that field (web3/economy/README.md says what each one takes).');
  if (refusals.length) return result();

  const m = model(economy, { now });
  const units = (amount, token, where, what = 'This amount') => {
    if (!token) return null;
    try {
      return toUnits(amount ?? 0, token.decimals ?? 0);
    } catch (err) {
      refuse(err.code ?? 'E-AMOUNT', where, `${what}: ${err.message}`, err.fix ?? 'Fix the amount.');
      return null;
    }
  };
  const seconds = (duration, where) => {
    try {
      return toSeconds(duration);
    } catch (err) {
      refuse(err.code, where, err.message, err.fix);
      return 0;
    }
  };
  const percent = (value, where) => {
    if (value === undefined) return 0;
    const bps = toBps(value);
    if (bps === null) refuse('E-PERCENT', where, `${value}% is finer than the program counts (hundredths of a percent).`, 'Round it to two decimals.');
    return bps ?? 0;
  };

  // ---- keys and ids
  for (const [list, kind] of Object.entries({ tokens: 'token', items: 'item', pools: 'pool', boxes: 'box', payments: 'payment', recipes: 'recipe', schedules: 'schedule', lotteries: 'lottery', stakes: 'stake', contests: 'contest', holds: 'hold', decisions: 'decision' })) {
    const seen = new Set();
    for (const [i, part] of (economy[list] ?? []).entries()) {
      if (seen.has(part.key)) refuse('E-KEY-DUP', `economy.${list}[${i}].key`, `Two ${list} are called “${part.key}”: the other parts could not tell which one they mean.`, `Give each ${kind} its own key.`);
      seen.add(part.key);
    }
    const field = list === 'pools' ? 'index' : 'id';
    const ids = new Set();
    for (const [i, part] of (economy[list] ?? []).entries()) {
      if (part[field] === undefined) continue;
      if (ids.has(part[field])) refuse('E-KEY-DUP', `economy.${list}[${i}].${field}`, `Two ${list} have the program number ${part[field]}: the second would overwrite the first.`, `Remove the ${field} from the newer one; it gets a free number when it goes live.`);
      ids.add(part[field]);
    }
  }

  // ---- tokens and the game's currency
  const sols = (economy.tokens ?? []).filter((t) => t.source === 'sol');
  if (sols.length > 1) refuse('E-TOKEN', 'economy.tokens', 'SOL is listed more than once.', 'Keep one token with source "sol".');
  for (const [i, t] of (economy.tokens ?? []).entries()) {
    const where = `economy.tokens[${i}]`;
    const tok = m.tokens.get(t.key);
    if (t.source === 'sol' && t.mint && !tok.wsol) refuse('E-TOKEN', `${where}.mint`, `“${t.key}” is SOL, but names another mint.`, 'Remove the mint: SOL needs none.');
    if (t.source === 'existing' && (!t.mint || t.decimals === undefined))
      refuse('E-TOKEN', where, `“${t.key}” is an existing token, so the economy needs its mint address and its decimals.`, 'Add "mint" (the token’s address) and "decimals" (6 for most coins, 9 for SOL-like ones).');
    if (t.source === 'game' && t.program === 'token-2022')
      refuse('E-NOT-YET', `${where}.program`, `“${t.key}” is a token the game mints itself, and those are classic SPL tokens for now.`, 'Remove "program", or use an existing Token-2022 mint (source "existing").');
    if (t.source === 'curve' && t.decimals !== undefined && t.decimals !== 6) warn('W-TOKEN', `${where}.decimals`, `Tokens launched on a curve have 6 decimals (9 when the pair is priced very low); “${t.key}” says ${t.decimals}.`, 'Remove "decimals", or check the launched mint.');
    if (t.pair !== undefined && t.source !== 'curve') warn('W-TOKEN', `${where}.pair`, `“${t.key}” is not launched here, so its "pair" is not used.`, 'Remove "pair": it only says what a token launched on a curve trades against.');
    const p = t.powers ?? {};
    if (p.nonTransferable) refuse('E-TOKEN', `${where}.powers`, `“${t.key}” cannot be transferred, so it cannot pay for anything, fill a pool or be staked.`, 'Use another token.');
    const powers = [
      p.freeze && 'freeze any account holding it, including the game’s pools and the vault that holds open orders (orders refund after 7 days)',
      p.permanentDelegate && 'move or burn it out of any account, the game’s pools included',
      p.transferHook && 'run its own program on every transfer, which can refuse one (a refused settle refunds after 7 days)',
      p.transferFeePercent > 0 && `keep ${p.transferFeePercent}% of every transfer (pools and prizes receive that much less)`,
      p.pausable && 'pause every transfer of it',
      p.defaultFrozen && 'start every new account frozen',
      p.mintAuthority === 'someone else' && 'mint more of it whenever its owner wants',
    ].filter(Boolean);
    if (powers.length) warn('W-MINT-POWERS', `${where}.powers`, `Whoever controls the mint of “${t.key}” can ${powers.join('; ')}. The program treats that as the token’s own business: players should know.`, 'Use a mint without those powers, or say so where players buy.');
    if (t.source === 'existing' && !t.powers)
      warn('W-MINT-POWERS', where, `We cannot read the mint of “${t.key}” from here, so we do not know what its owner can do (freeze, a permanent delegate, a transfer hook or fee).`, 'Look the mint up on an explorer and list what it can do under "powers".');
  }
  if (!m.currency) {
    if (m.currencyKey) refuse('E-REF', 'economy.currency', `The game’s currency “${m.currencyKey}” is not in the tokens.`, 'Add it to "tokens", or name one that is there.');
    else refuse('E-CURRENCY', 'economy.currency', 'The economy has no currency: the program needs one for the shop’s prices and the treasury.', 'Add a token (for example { "key": "sol", "source": "sol" }) and name it in "currency".');
    return result();
  }
  const game = m.currency;

  /** A token named by key (or the game's), refused when it is not there. */
  const token = (key, where) => {
    const t = m.tokens.get(key ?? m.currencyKey);
    if (!t) refuse('E-REF', where, `There is no token “${key}”.`, 'Add it to "tokens", or name one that is there.');
    return t;
  };
  const pool = (key, where) => {
    const p = m.pool.get(key);
    if (!p) refuse('E-REF', where, `There is no pool “${key}”.`, 'Add it to "pools", or name one that is there.');
    return p;
  };
  const item = (key, where) => {
    const it = m.item.get(key);
    if (!it) refuse('E-REF', where, `There is no item “${key}”.`, 'Add it to "items", or name one that is there.');
    return it;
  };
  for (const p of m.pools) if (!m.tokens.has(p.currency)) refuse('E-REF', `economy.pools.${p.key}.currency`, `The pool “${p.key}” holds “${p.currency}”, which is not in the tokens.`, 'Add the token, or name one that is there.');

  /**
   * A split carried out in `tok`: percents, at most 4 shares and 100% (state.rs check_shares), pools of the same
   * token, and no share that burns in wrapped SOL (state.rs check_later_shares: the program refuses it).
   * `all`: the payment is not in the game's currency, so the shares must take all of it (the treasury holds only
   * the game's currency; catalog.rs upsert_box).
   */
  const split = (list, tok, where, { all = false, what }) => {
    const shares = sharesOf(list);
    shares.forEach((s, i) => percent(s.percent, `${where}[${i}].percent`));
    const total = shares.reduce((n, s) => n + (s.bps ?? 0), 0);
    if (shares.length > LIMITS.shares) refuse('E-SPLIT', where, `${what} has ${shares.length} shares; the program takes at most ${LIMITS.shares}.`, 'Merge shares that go to the same place, or drop one.');
    if (total > 10_000) refuse('E-SPLIT', where, `${what}’s shares add up to ${total / 100}%, more than the whole payment.`, 'Make them add up to 100% or less; the treasury gets what they leave.');
    if (all && total !== 10_000 && tok)
      refuse('E-SPLIT-ALL', where, `${what} is paid in ${tok.symbol}, not the game’s ${game.symbol}, and the treasury only holds ${game.symbol}: its shares add up to ${total / 100}%, so the rest would have nowhere to go.`, 'Make its shares add up to exactly 100%, or price it in the game’s currency.');
    for (const [i, s] of shares.entries()) {
      if (s.kind === 'pool') {
        const p = pool(s.key, `${where}[${i}].to`);
        if (p && tok && p.currency !== tok.key) refuse('E-POOL-MINT', `${where}[${i}].to`, `${what} is paid in ${tok.symbol}, but the pool “${p.key}” holds ${m.tokens.get(p.currency)?.symbol ?? p.currency}.`, `Send it to a pool of ${tok.symbol}.`);
      }
      if (tok?.wsol && (s.kind === 'burn' || s.kind === 'holder'))
        refuse('E-WSOL-BURN', `${where}[${i}].to`, `${what} is paid in SOL, and wrapped SOL cannot be burned${s.kind === 'holder' ? ' (a share for a collectible’s holder is burned when nobody holds it)' : ''}.`, 'Send that share to a pool or an account instead.');
    }
    return total;
  };

  const feeNote = (price, tok, where, what) => {
    if (!tok?.wsol || price === null || price === 0n) return;
    const ratio = Number(FEES.player) / Number(price);
    if (ratio >= 0.01)
      warn('W-FEE', where, `Every ${what} also pays games.fun’s player fee of 0.002 SOL: ${(ratio * 100).toFixed(1)}% on top of its ${fromUnits(price, 9)} SOL price.`, 'Fine for a game; a higher price makes the fee a smaller part of it.');
  };

  // ---- the collection and items
  if (utf8Bytes(m.collection.name) > LIMITS.nameBytes) refuse('E-COLLECTION', 'economy.collection.name', `The collection’s name is longer than ${LIMITS.nameBytes} bytes.`, 'Shorten it.');
  if (toBps(m.collection.royaltyPercent) === null) refuse('E-PERCENT', 'economy.collection.royaltyPercent', 'The royalty is finer than hundredths of a percent.', 'Round it to two decimals.');
  const given = new Set();
  for (const b of m.boxes) for (const o of b.outcomes ?? []) if (o.gives === 'item') given.add(o.item);
  for (const r of m.recipes) for (const o of r.out ?? []) if (o.gives === 'item') given.add(o.item);
  for (const d of m.decisions) if (d.does === 'make') given.add(d.item);
  for (const it of m.items) {
    const where = `economy.items.${it.key}`;
    if (utf8Bytes(it.name) > LIMITS.nameBytes) refuse('E-ITEM', `${where}.name`, `${label(it)} is longer than ${LIMITS.nameBytes} bytes, the most the program keeps.`, 'Shorten the name.');
    if (utf8Bytes(it.uri) > LIMITS.uriBytes) refuse('E-ITEM', `${where}.uri`, `${label(it)}’s link is longer than ${LIMITS.uriBytes} bytes.`, 'Use a shorter link.');
    const price = units(it.price, game, `${where}.price`, `${label(it)}’s price`);
    if (it.rise) {
      units(it.rise.step, game, `${where}.rise.step`, `${label(it)}’s rise`);
      percent(it.rise.growthPercent, `${where}.rise.growthPercent`);
    }
    if (it.fall) {
      const step = units(it.fall.step, game, `${where}.fall.step`, `${label(it)}’s fall`);
      if (step === 0n || seconds(it.fall.every, `${where}.fall.every`) === 0) refuse('E-PRICE', `${where}.fall`, `${label(it)}’s price falls by nothing, or never (state.rs Fall::check).`, 'Give the fall a step above 0 and a time above 0.');
      units(it.fall.floor, game, `${where}.fall.floor`, `${label(it)}’s floor`);
    }
    if ((it.kind ?? 'collectible') === 'normal' && (it.life || it.soulbound || it.burnable))
      warn('W-ITEM', where, `${label(it)} is a normal item, kept by the game’s backend: its life, soulbound and burnable settings only apply to collectibles, so the program drops them.`, 'Make it a collectible, or remove those settings.');
    split(it.split, game, `${where}.split`, { what: `${label(it)}’s sale` });
    feeNote(price, game, `${where}.price`, `purchase of ${label(it)}`);
    if (price === 0n && !given.has(it.key))
      warn('W-ITEM', where, `Nobody can get ${label(it)}: it is not for sale (price 0), and no box, recipe or decision gives it.`, 'Give it a price, or put it in a box or a recipe.');
  }

  // ---- pools: what fills them and what takes from them
  const takers = poolTakers(m);
  const fillers = poolFillers(m);
  for (const p of m.pools) {
    const where = `economy.pools.${p.key}`;
    const tok = m.tokens.get(p.currency);
    units(p.seed, tok, `${where}.seed`, `The seed of “${p.key}”`);
    const takes = takers.filter((t) => t.pool === p.key);
    const fills = fillers.filter((f) => f.pool === p.key);
    if (takes.length && !fills.length)
      refuse('E-POOL-DRY', where, `The pool “${p.key}” is paid out of (${takes.map((t) => t.by).join(', ')}) but nothing ever fills it, so every one of those payouts would fail or be skipped.`, 'Seed it ("seed"), send it a share of a sale (a split to "pool:' + p.key + '"), or fill it with a schedule.');
    if (!takes.length && !fills.length) warn('W-POOL', where, `The pool “${p.key}” is never used.`, 'Remove it, or use it.');
    if (fills.length && !takes.length)
      warn('W-POOL', where, `Money goes into “${p.key}” (${fills.map((f) => f.by).join(', ')}) and nothing in the economy takes it out: only the authority can, with a payout.`, 'Add what pays from it (a box prize, a lottery, a stake, a recipe), or a decision that pays out of it.');
    const stake = takes.find((t) => t.by.startsWith('stake:'));
    if (stake) {
      const others = takes.filter((t) => t !== stake);
      if (others.length)
        refuse('E-POOL-SHARED', where, `The stake ${label(m.stake.get(stake.by.slice(6)))} takes everything that arrives in “${p.key}”, and ${others.map((t) => t.by).join(', ')} also take from it: whoever comes first empties it for the others (stake.rs).`, 'Give the stake a rewards pool of its own, and feed it with a share or a schedule.');
    }
    const lottery = takes.find((t) => t.by.startsWith('lottery:'));
    if (lottery && !stake) {
      const others = takes.filter((t) => t !== lottery);
      if (others.length) warn('W-POOL-SHARED', where, `The pot “${p.key}” of ${lottery.by} is also taken from by ${others.map((t) => t.by).join(', ')}: until its winners are paid it is a pool like any other, and the winners share what is left.`, 'Give the lottery a pot of its own.');
    }
  }

  // ---- boxes
  let chance = false;
  /** Fixed prizes from a pool, for the seed check below. */
  const prizes = [];
  for (const b of m.boxes) {
    const where = `economy.boxes.${b.key}`;
    const tok = token(b.currency, `${where}.currency`);
    const price = units(b.price, tok, `${where}.price`, `${label(b)}’s price`);
    if (price === 0n) refuse('E-PRICE', `${where}.price`, `${label(b)} costs nothing, and the program does not open a box for free (order.rs NotForSale).`, 'Give it a price above 0.');
    if (b.rise) {
      units(b.rise.step, tok, `${where}.rise.step`, `${label(b)}’s rise`);
      percent(b.rise.growthPercent, `${where}.rise.growthPercent`);
    }
    if (b.fall) {
      const step = units(b.fall.step, tok, `${where}.fall.step`, `${label(b)}’s fall`);
      if (step === 0n || seconds(b.fall.every, `${where}.fall.every`) === 0) refuse('E-PRICE', `${where}.fall`, `${label(b)}’s price falls by nothing, or never (state.rs Fall::check).`, 'Give the fall a step above 0 and a time above 0.');
    }
    split(b.split, tok, `${where}.split`, { all: tok && tok.key !== game.key, what: label(b) });
    feeNote(price, tok, `${where}.price`, `opening of ${label(b)}`);
    const outcomes = b.outcomes ?? [];
    const withChance = outcomes.filter((o) => o.chance !== undefined).length;
    const withWeight = outcomes.filter((o) => o.weight !== undefined).length;
    if (withChance && withWeight) refuse('E-ODDS', `${where}.outcomes`, `${label(b)} mixes chances and weights, so its odds cannot be read.`, 'Give every outcome a chance (percents adding up to 100), or every one a weight.');
    else if (withChance + withWeight < outcomes.length) refuse('E-ODDS', `${where}.outcomes`, `Some outcomes of ${label(b)} have no chance.`, 'Give every outcome a chance (percents adding up to 100) or a weight.');
    else if (withChance) {
      const total = outcomes.reduce((n, o) => n + o.chance, 0);
      if (Math.abs(total - 100) > 1e-9) refuse('E-ODDS', `${where}.outcomes`, `${label(b)}’s chances add up to ${+total.toFixed(6)}%, not 100%.`, 'Make them add up to 100.');
      if (outcomes.some((o) => Math.abs(o.chance * 10_000 - Math.round(o.chance * 10_000)) > 1e-6)) refuse('E-ODDS', `${where}.outcomes`, `A chance in ${label(b)} has more than four decimals.`, 'Round it to four decimals, or use weights.');
    }
    for (const [i, o] of outcomes.entries()) {
      const at = `${where}.outcomes[${i}]`;
      if (o.gives === 'item') {
        if (!o.item) refuse('E-ODDS', at, `An outcome of ${label(b)} gives an item but does not say which.`, 'Add "item".');
        else item(o.item, `${at}.item`);
      }
      if (o.gives === 'pay' || o.gives === 'share') {
        chance = true;
        const p = o.pool ? pool(o.pool, `${at}.pool`) : refuse('E-ODDS', at, `An outcome of ${label(b)} pays from a pool but does not say which.`, 'Add "pool".');
        if (o.gives === 'pay' && p) {
          const amount = units(o.amount, m.tokens.get(p.currency), `${at}.amount`, `${label(b)}’s prize`);
          if (amount === 0n) refuse('E-ODDS', `${at}.amount`, `An outcome of ${label(b)} pays nothing (catalog.rs BadEntries).`, 'Give it an amount above 0, or make it "nothing".');
        }
        if (o.gives === 'share' && !(percent(o.percent, `${at}.percent`) > 0)) refuse('E-ODDS', `${at}.percent`, `An outcome of ${label(b)} pays a share of 0% (catalog.rs BadEntries).`, 'Give it a percent above 0.');
      }
      if (o.gives === 'pay' && o.pool && m.pool.get(o.pool)) prizes.push({ box: b, at, pool: m.pool.get(o.pool), amount: Number(o.amount) });
      if (o.gives === 'burn' && tok?.wsol) refuse('E-WSOL-BURN', at, `${label(b)} is paid in SOL, and wrapped SOL cannot be burned (catalog.rs).`, 'Make that outcome "nothing", or send its share somewhere.');
    }
    // A prize bigger than what its pool holds at the first open (its seed, plus this open's own share) cannot be paid
    // yet: the roll skips it and lands on another outcome (PROGRAM-0.3.md "The roll skips … a prize its pool does not hold").
    const biggest = new Map();
    for (const z of prizes.filter((x) => x.box === b)) if (!(biggest.get(z.pool.key)?.amount >= z.amount)) biggest.set(z.pool.key, z);
    for (const z of biggest.values()) {
      const p = z.pool;
      const sym = m.tokens.get(p.currency)?.symbol ?? p.currency;
      const seed = Number(p.seed ?? 0);
      const ownShare = (b.currency ?? m.currencyKey) === p.currency ? (Number(b.price) * sharesOf(b.split).filter((x) => x.kind === 'pool' && x.key === p.key).reduce((n, x) => n + (x.bps ?? 0), 0)) / 10_000 : 0;
      if (Number.isFinite(z.amount) && seed + ownShare < z.amount)
        warn('W-PRIZE-SEED', `economy.pools.${p.key}.seed`, `“${p.key}” starts with ${+seed.toFixed(9)} ${sym}${ownShare ? ` (and ${+ownShare.toFixed(9)} more from each open)` : ''}, but a win in ${label(b)} pays ${z.amount} ${sym}: the first winner gets nothing until the pool fills, because the program skips a prize its pool cannot pay and the roll lands on another outcome.`, `Seed “${p.key}” with at least ${+(z.amount - ownShare).toFixed(9)} ${sym}; more rides out a run of wins (the simulation suggests how much).`);
    }
    if (b.stockOdds && !outcomes.some((o) => o.gives === 'item' && m.item.get(o.item)?.supply > 0))
      warn('W-ODDS', `${where}.stockOdds`, `${label(b)} has odds that shrink with stock, but none of its items has a limited supply, so nothing changes.`, 'Give its items a supply, or turn stockOdds off.');
  }

  // ---- payments
  for (const p of m.payments) {
    const where = `economy.payments.${p.key}`;
    const tok = token(p.currency, `${where}.currency`);
    const amount = units(p.amount, tok, `${where}.amount`, `${label(p)}’s amount`);
    if (amount === 0n) refuse('E-PRICE', `${where}.amount`, `${label(p)} is a payment of 0 (pay.rs ZeroAmount).`, 'Give it an amount above 0.');
    split(p.split, tok, `${where}.split`, { all: tok && tok.key !== game.key, what: label(p) });
    feeNote(amount, tok, `${where}.amount`, `payment of ${label(p)}`);
  }

  // ---- recipes (craft.rs upsert_recipe)
  for (const r of m.recipes) {
    const where = `economy.recipes.${r.key}`;
    const ins = r.in ?? [];
    const outs = r.out ?? [];
    if (!ins.length && !outs.length) refuse('E-RECIPE', where, `${label(r)} takes nothing and gives nothing.`, 'Add what it takes and what it gives.');
    let taken = 0;
    for (const [i, line] of ins.entries()) {
      const at = `${where}.in[${i}]`;
      if (line.takes === 'pay') {
        const tok = token(line.currency, `${at}.currency`);
        const amount = units(line.amount, tok, `${at}.amount`, `What ${label(r)} takes`);
        if (amount === 0n) refuse('E-RECIPE', `${at}.amount`, `${label(r)} takes an amount of 0.`, 'Give it an amount above 0.');
        feeNote(amount, tok, `${at}.amount`, `craft of ${label(r)}`);
        if (!line.to) refuse('E-RECIPE', `${at}.to`, `${label(r)} takes ${tok?.symbol ?? 'a token'} but does not say where it goes.`, 'Add "to": "burn", "pool:<key>", "account:<address>" or "holder:<address>".');
        else split([{ to: line.to, percent: 100 }], tok, `${at}`, { what: label(r) });
        continue;
      }
      const it = line.item ? item(line.item, `${at}.item`) : refuse('E-RECIPE', at, `A line of ${label(r)} hands something in but does not say which item.`, 'Add "item".');
      if (!it) continue;
      if ((it.kind ?? 'collectible') !== 'collectible') refuse('E-RECIPE', `${at}.item`, `${label(r)} takes ${label(it)}, a normal item: only collectibles can be handed in.`, `Make ${label(it)} a collectible.`);
      if (line.takes === 'burn' && it.soulbound) refuse('E-RECIPE', `${at}.item`, `${label(r)} burns ${label(it)}, which is soulbound and can never be burned, so nobody could ever craft it (craft.rs).`, 'Use it and keep it ("takes": "use"), or make the item not soulbound.');
      taken += line.takes === 'burn' ? line.count ?? 1 : 1;
    }
    if (taken > LIMITS.collectiblesPerCraft) refuse('E-RECIPE', `${where}.in`, `${label(r)} takes ${taken} collectibles; one craft takes at most ${LIMITS.collectiblesPerCraft}.`, 'Take fewer, or split it into two recipes.');
    let made = 0;
    for (const [i, line] of outs.entries()) {
      const at = `${where}.out[${i}]`;
      if (line.gives === 'item') {
        const it = line.item ? item(line.item, `${at}.item`) : refuse('E-RECIPE', at, `A line of ${label(r)} gives an item but does not say which.`, 'Add "item".');
        if (it && (it.kind ?? 'collectible') !== 'collectible') refuse('E-RECIPE', `${at}.item`, `${label(r)} gives ${label(it)}, a normal item: a recipe makes collectibles.`, `Make ${label(it)} a collectible.`);
        made += 1;
      } else if (line.gives === 'tokens') {
        const tok = token(line.currency, `${at}.currency`);
        const amount = units(line.amount, tok, `${at}.amount`, `What ${label(r)} gives`);
        if (amount === 0n) refuse('E-RECIPE', `${at}.amount`, `${label(r)} gives an amount of 0.`, 'Give it an amount above 0.');
        if (!line.from) refuse('E-RECIPE', `${at}.from`, `${label(r)} gives ${tok?.symbol ?? 'a token'} but does not say where from.`, 'Add "from": "mint" (the game mints it) or "pool:<key>".');
        else if (line.from === 'mint') {
          if (tok && !tok.gameMints) refuse('E-MINT-NOT-OURS', `${at}.from`, `${label(r)} mints ${tok.symbol}, but the game cannot mint it: only a token the game makes itself can be minted.`, `Pay it from a pool ("from": "pool:<key>"), or use a token with source "game".`);
        } else {
          const p = pool(line.from.slice(5), `${at}.from`);
          if (p && tok && p.currency !== tok.key) refuse('E-POOL-MINT', `${at}.from`, `${label(r)} gives ${tok.symbol} from “${p.key}”, which holds ${m.tokens.get(p.currency)?.symbol}.`, `Pay it from a pool of ${tok.symbol}.`);
        }
      } else if (line.gives === 'share') {
        if (line.pool) pool(line.pool, `${at}.pool`);
        else refuse('E-RECIPE', at, `${label(r)} gives a share but does not say of which pool.`, 'Add "pool".');
        if (!(percent(line.percent, `${at}.percent`) > 0)) refuse('E-RECIPE', `${at}.percent`, `${label(r)} gives a share of 0%.`, 'Give it a percent above 0.');
      }
    }
    for (const [i, need] of (r.needs ?? []).entries())
      if (need.place >= taken) refuse('E-RECIPE', `${where}.needs[${i}]`, `${label(r)} asks something of collectible number ${need.place}, but it only takes ${taken} (the first is 0).`, 'Point it at a collectible the recipe takes.');
    for (const [i, keep] of (r.keeps ?? []).entries()) {
      if (keep.from >= taken || keep.to >= made) refuse('E-RECIPE', `${where}.keeps[${i}]`, `${label(r)} carries “${keep.key}” from collectible ${keep.from} to new collectible ${keep.to}, but it takes ${taken} and makes ${made} (the first of each is 0).`, 'Point it at collectibles the recipe takes and makes.');
      if (RESERVED_ATTRIBUTES.includes(keep.key)) refuse('E-RECIPE', `${where}.keeps[${i}].key`, `“${keep.key}” is a number the program writes itself and cannot be carried over.`, 'Carry a key the game wrote.');
      if ((r.keeps ?? []).slice(0, i).some((k) => k.key === keep.key && k.to === keep.to)) refuse('E-RECIPE', `${where}.keeps[${i}]`, `${label(r)} carries “${keep.key}” to the same collectible twice.`, 'Keep one.');
    }
    if (!refusals.some((x) => x.where.startsWith(where))) {
      const bytes = craftSize(r, m);
      if (bytes > MAX_TRANSACTION_BYTES)
        refuse('E-TX-SIZE', where, `Crafting ${label(r)} would take about ${bytes} bytes, more than the ${MAX_TRANSACTION_BYTES} a transaction can hold, so no player could craft it.`, 'Take or give fewer collectibles, or split it into two recipes.');
      else if (bytes > BUDGET)
        warn('W-TX-SIZE', where, `Crafting ${label(r)} takes about ${bytes} of ${MAX_TRANSACTION_BYTES} bytes: it fits only if the player’s wallet adds nothing of its own.`, 'Take or give fewer collectibles if players see it fail.');
    }
    const hooks = [...ins, ...outs].map((l) => m.tokens.get(l.currency ?? (l.pool ? m.pool.get(l.pool)?.currency : undefined))).filter((t) => t?.powers?.transferHook);
    if (hooks.length) warn('W-TX-SIZE', where, `${label(r)} moves ${hooks[0].symbol}, whose transfer hook adds accounts of its own to every craft; we cannot count them from here.`, 'Try a craft on devnet before players do.');
  }

  // ---- schedules (schedule.rs upsert_schedule)
  for (const s of m.schedules) {
    const where = `economy.schedules.${s.key}`;
    if (seconds(s.every, `${where}.every`) <= 0) refuse('E-SCHEDULE', `${where}.every`, `${label(s)} never comes round (every 0).`, 'Give it a time like "1d".');
    try {
      toTime(s.start, now);
    } catch (err) {
      refuse(err.code, `${where}.start`, err.message, err.fix);
    }
    if (s.does === 'issue') {
      const p = s.pool ? pool(s.pool, `${where}.pool`) : refuse('E-SCHEDULE', where, `${label(s)} mints but does not say into which pool.`, 'Add "pool".');
      const tok = token(s.currency ?? p?.currency, `${where}.currency`);
      if (tok && !tok.gameMints) refuse('E-MINT-NOT-OURS', where, `${label(s)} mints ${tok.symbol}, but the game cannot mint it: only a token the game makes itself can be minted.`, 'Fill the pool with a share of sales or a move from another pool, or use a token with source "game".');
      if (p && tok && p.currency !== tok.key) refuse('E-POOL-MINT', `${where}.pool`, `${label(s)} mints ${tok.symbol} into “${p.key}”, which holds ${m.tokens.get(p.currency)?.symbol}.`, `Mint into a pool of ${tok.symbol}.`);
      if (units(s.amount, tok, `${where}.amount`, `What ${label(s)} mints`) === 0n) refuse('E-SCHEDULE', `${where}.amount`, `${label(s)} mints 0.`, 'Give it an amount above 0.');
    } else {
      if (!(percent(s.percent, `${where}.percent`) > 0)) refuse('E-SCHEDULE', `${where}.percent`, `${label(s)} ${s.does === 'burn' ? 'burns' : 'moves'} 0%.`, 'Give it a percent above 0.');
      if (s.does === 'burn') {
        const p = s.pool ? pool(s.pool, `${where}.pool`) : refuse('E-SCHEDULE', where, `${label(s)} burns but does not say from which pool.`, 'Add "pool".');
        if (p && m.tokens.get(p.currency)?.wsol) refuse('E-WSOL-BURN', `${where}.pool`, `${label(s)} burns SOL from “${p.key}”, and wrapped SOL cannot be burned.`, 'Move it to another pool instead.');
      } else {
        const from = s.from ? pool(s.from, `${where}.from`) : refuse('E-SCHEDULE', where, `${label(s)} moves money but does not say from which pool.`, 'Add "from".');
        const to = s.to ? pool(s.to, `${where}.to`) : refuse('E-SCHEDULE', where, `${label(s)} moves money but does not say to which pool.`, 'Add "to".');
        if (from && to && from.key === to.key) refuse('E-SCHEDULE', where, `${label(s)} moves money from “${from.key}” into itself.`, 'Name two different pools.');
        if (from && to && from.currency !== to.currency) refuse('E-POOL-MINT', where, `${label(s)} moves from “${from.key}” to “${to.key}”, which hold different tokens.`, 'Name two pools of the same token.');
      }
    }
  }

  // ---- lotteries (lottery.rs upsert_lottery)
  for (const l of m.lotteries) {
    const where = `economy.lotteries.${l.key}`;
    const p = pool(l.pot, `${where}.pot`);
    const potToken = p && m.tokens.get(p.currency);
    const ticket = l.ticketCurrency ? token(l.ticketCurrency, `${where}.ticketCurrency`) : potToken;
    if (units(l.price, ticket, `${where}.price`, `${label(l)}’s ticket`) === 0n) refuse('E-LOTTERY', `${where}.price`, `${label(l)}’s tickets are free, and the program refuses that (BadLottery).`, 'Give a ticket a price above 0.');
    if (seconds(l.every, `${where}.every`) <= 0) refuse('E-LOTTERY', `${where}.every`, `${label(l)} never draws (every 0).`, 'Give it a time like "7d".');
    try {
      toTime(l.firstDraw, now);
    } catch (err) {
      refuse(err.code, `${where}.firstDraw`, err.message, err.fix);
    }
    const places = (l.places ?? [100]).map((v, i) => percent(v, `${where}.places[${i}]`));
    const total = places.reduce((a, b) => a + b, 0);
    if (total > 10_000) refuse('E-LOTTERY', `${where}.places`, `${label(l)}’s places add up to ${total / 100}% of the pot, more than all of it.`, 'Make them add up to 100% or less.');
    else if (total < 10_000) warn('W-LOTTERY', `${where}.places`, `${label(l)}’s places add up to ${total / 100}%: the other ${(10_000 - total) / 100}% of each pot stays in it for the next round, as do places nobody won.`);
    const cut = percent(l.cutPercent, `${where}.cutPercent`);
    if (cut && l.ticketCurrency) refuse('E-LOTTERY', `${where}.cutPercent`, `${label(l)}’s tickets are burned, so there is nothing to take a cut of (lottery.rs).`, 'Remove the cut.');
    if (cut && potToken && potToken.key !== game.key) refuse('E-LOTTERY', `${where}.cutPercent`, `${label(l)}’s cut goes to the treasury, which holds ${game.symbol}, but its pot is in ${potToken.symbol}.`, `Remove the cut, or send part of ticket money elsewhere another way.`);
    if (ticket?.wsol && l.ticketCurrency) refuse('E-WSOL-BURN', `${where}.ticketCurrency`, `${label(l)}’s tickets are burned, and wrapped SOL cannot be burned.`, 'Sell tickets into the pot instead (no ticketCurrency).');
    chance = true;
  }

  // ---- stakes (stake.rs)
  for (const s of m.stakes) {
    const where = `economy.stakes.${s.key}`;
    token(s.stakes, `${where}.stakes`);
    const p = pool(s.rewards, `${where}.rewards`);
    const lock = seconds(s.lock, `${where}.lock`);
    const feeds = m.schedules.filter((x) => (x.does === 'move' && x.to === s.rewards) || (x.does === 'issue' && x.pool === s.rewards));
    const gap = Math.max(0, ...feeds.map((x) => toSeconds(x.every)));
    if (p && lock < gap)
      warn('W-STAKE-LOCK', `${where}.lock`, `${label(s)} locks for ${lock ? s.lock : 'no time'}, less than the ${gap} seconds between its rewards: someone can stake a large sum just before a reward lands and leave right after, taking most of it.`, `Lock for at least as long as the gap between rewards (${gap} seconds).`);
    else if (p && lock === 0)
      warn('W-STAKE-LOCK', `${where}.lock`, `${label(s)} has no lock: someone can stake a large sum just before a big reward lands and leave right after.`, 'Give it a lock, such as "1d".');
  }

  // ---- contests (contest.rs open_contest)
  for (const c of m.contests) {
    const where = `economy.contests.${c.key}`;
    const tok = token(c.currency, `${where}.currency`);
    if (seconds(c.entriesClose, `${where}.entriesClose`) > seconds(c.resultDue, `${where}.resultDue`) && c.resultDue !== undefined)
      refuse('E-CONTEST', where, `${label(c)}’s entries close after its result is due (BadContest).`, 'Close entries before the result is due.');
    if (c.sideNames && c.sideNames.length !== c.sides) warn('W-CONTEST', `${where}.sideNames`, `${label(c)} has ${c.sides} sides and ${c.sideNames.length} names for them.`, 'Name each side once.');
    split(c.split, tok, `${where}.split`, { what: label(c) });
    warn('W-CHANCE-PRIZE', where, `${label(c)} lets players put money on an outcome: that is betting, which is regulated in most places once it is real money. The kit runs it on devnet only.`);
  }

  // ---- holds (hold.rs)
  for (const h of m.holds) {
    const where = `economy.holds.${h.key}`;
    const it = item(h.item, `${where}.item`);
    if (it && ((it.kind ?? 'collectible') !== 'collectible' || it.soulbound)) refuse('E-HOLD', `${where}.item`, `${label(h)} holds ${label(it)}, which is ${it.soulbound ? 'soulbound' : 'a normal item'}: only a collectible that can move can be held.`, 'Hold a collectible that is not soulbound.');
    seconds(h.for, `${where}.for`);
  }

  // ---- decisions: what only the game knows
  for (const d of m.decisions) {
    const where = `economy.decisions.${d.key}`;
    if (d.does === 'payout' || d.does === 'burn') {
      const p = d.pool ? pool(d.pool, `${where}.pool`) : refuse('E-DECISION', where, `${label(d)} ${d.does === 'payout' ? 'pays out' : 'burns'} but does not say from which pool.`, 'Add "pool".');
      if (d.does === 'burn' && p && m.tokens.get(p.currency)?.wsol) refuse('E-WSOL-BURN', `${where}.pool`, `${label(d)} burns SOL, and wrapped SOL cannot be burned.`, 'Pay it out instead.');
      if (p && d.amount !== undefined) units(d.amount, m.tokens.get(p.currency), `${where}.amount`, `${label(d)}’s amount`);
      if (d.percent !== undefined) percent(d.percent, `${where}.percent`);
    }
    if (d.does === 'issue') {
      const tok = token(d.currency, `${where}.currency`);
      if (tok && !tok.gameMints) refuse('E-MINT-NOT-OURS', where, `${label(d)} mints ${tok.symbol}, but the game cannot mint it.`, 'Pay it from a pool instead, or use a token with source "game".');
    }
    if (['make', 'unmake', 'set'].includes(d.does)) {
      const it = d.item ? item(d.item, `${where}.item`) : refuse('E-DECISION', where, `${label(d)} works on a collectible but does not say which item.`, 'Add "item".');
      if (it && (it.kind ?? 'collectible') !== 'collectible') refuse('E-DECISION', `${where}.item`, `${label(d)} works on ${label(it)}, which is a normal item, not a collectible.`, `Make ${label(it)} a collectible.`);
      if (it && d.does === 'unmake' && !it.burnable) refuse('E-DECISION', `${where}.item`, `${label(d)} burns ${label(it)}, but only items marked burnable can be burned by the game (make.rs).`, `Mark ${label(it)} "burnable": true before any is issued.`);
    }
    if (d.does === 'award' && !(d.hold && m.hold.get(d.hold))) refuse('E-REF', `${where}.hold`, `${label(d)} awards a held collectible but names no hold that exists.`, 'Name one of "holds".');
    if ((d.does === 'decide' || d.does === 'open_contest') && !(d.contest && m.contest.get(d.contest))) refuse('E-REF', `${where}.contest`, `${label(d)} works on a contest but names none that exists.`, 'Name one of "contests".');
    // A claim comes from code in the player's browser: proof ties it to a payment on chain, caps bound what it moves.
    const capToken = d.pool ? m.tokens.get(m.pool.get(d.pool)?.currency) : d.currency ? m.tokens.get(d.currency) : null;
    if (d.proof) {
      if (!m.payments.some((p) => p.key === d.proof.payment)) refuse('E-REF', `${where}.proof.payment`, `${label(d)} asks for proof of the payment “${d.proof.payment}”, which is not one of the economy’s payments.`, 'Name one of "payments" (the attempt players pay for).');
      seconds(d.proof.after, `${where}.proof.after`);
      seconds(d.proof.within, `${where}.proof.within`);
    }
    for (const k of ['each', 'perPlayerPerDay', 'perDay']) if (d.caps?.[k] !== undefined && capToken) units(d.caps[k], capToken, `${where}.caps.${k}`, `${label(d)}’s cap`);
    if (d.caps?.each !== undefined && d.amount !== undefined && Number(d.amount) > Number(d.caps.each))
      refuse('E-CAPS', `${where}.caps.each`, `${label(d)} moves ${d.amount} each time, more than its own cap of ${d.caps.each}: the keeper and the page would refuse every one.`, 'Raise the cap or lower the amount.');
    const moves = ['payout', 'issue', 'make'].includes(d.does);
    if (d.signedBy === 'keeper' && moves && !(d.caps?.each !== undefined && d.caps?.perDay !== undefined))
      refuse('E-KEEPER-CAPS', `${where}.caps`, `${label(d)} is signed by the keeper on a claim from the game, and a game runs in the player’s browser: anyone there can claim. Confirming the player really beat the game is yours to do on your own end (your own server or backend) before the keeper is asked; the caps the keeper keeps limit what a false claim can take.`, 'Add "caps": { "each": …, "perPlayerPerDay": …, "perDay": … } (and "proof": { "payment": … } to tie each claim to a paid attempt).');
    if (d.signedBy === 'keeper' && moves && !d.proof)
      warn('W-KEEPER-PROOF', `${where}.proof`, `${label(d)} pays on the game’s word alone. Anyone who can post a claim (a player from the browser console, any friend in the room) can collect it up to its caps. Confirming the player really beat the game is yours to do on your own end (your own server or backend).`, 'Confirm wins on your own server before asking the keeper, and add "proof": { "payment": "<the attempt players pay for>", "after": "<the least time a clear takes>" }.');
    if (d.signedBy && d.signedBy !== 'page' && m.authority === 'owner')
      warn('W-AUTHORITY', where, `${label(d)} is signed by ${d.signedBy === 'keeper' ? 'the local keeper' : 'your server'}, but the authority is still your own wallet${d.signedBy === 'keeper' ? ': until the keeper’s key is the authority, it cannot sign, and your wallet signs from the studio page' : ': that would put your wallet’s key on a machine that signs by itself'}.`, d.signedBy === 'keeper' ? 'Make the keeper its own key on your machine (npx gamesfun economy keeper --new-key <file outside the game>) and press "Let my keeper decide" in the Economy tab once it is live: that writes the key’s address here as "keys.authority".' : 'Give the authority its own address ("keys.authority"), made for that machine.');
  }
  const needs = [
    ...m.decisions.map((d) => `${label(d)} (when ${d.when})`),
    ...m.contests.map((c) => `naming who won ${label(c)}`),
    ...m.holds.map((h) => `saying where ${label(h)}’s collectibles go`),
  ];
  if (needs.length)
    warn('W-AUTHORITY', 'economy.keys.authority', `This economy needs the authority while it runs, for what only the game knows: ${needs.join('; ')}. ${m.authority === 'owner' ? 'That is your wallet, signing from the studio page.' : `That is the key ${m.authority}.`}`);

  if (chance) warn('W-CHANCE-PRIZE', 'economy', 'Players pay for a chance at money (a box that pays a prize, a lottery). That is gambling in many places once it is real money; the kit runs it on devnet only, and mainnet waits for counsel.');

  for (const key of Object.keys(m.scenario.perDay ?? {})) {
    const [kind, name] = key.split(':');
    const list = { box: m.box, item: m.item, recipe: m.recipe, lottery: m.lottery, stake: m.stake, contest: m.contest, hold: m.hold, payment: new Map(m.payments.map((p) => [p.key, p])) }[kind];
    if (!list?.has(name)) warn('W-SCENARIO', `economy.scenario.perDay.${key}`, `The scenario counts “${key}”, which is not in the economy.`, 'Remove it, or fix the name.');
  }
  for (const key of Object.keys(m.scenario.staked ?? {})) if (!m.stake.has(key)) warn('W-SCENARIO', `economy.scenario.staked.${key}`, `The scenario stakes in “${key}”, which is not a stake.`, 'Remove it, or fix the name.');
  if (typeof m.authority === 'string' && m.authority !== 'owner' && !isAddress(m.authority)) refuse('E-SCHEMA', 'economy.keys.authority', 'The authority is not an address.', 'Write "owner" or a wallet’s public address.');

  // ---- pools that run dry at the scenario's rates. E-POOL-DRY refuses a pool nothing ever fills (the program could
  // never pay from it); one that is filled but pays out faster drains and then skips or fails what it owes: a warning.
  if (!refusals.length) {
    let sim = null;
    try {
      sim = simulate(economy, { now });
    } catch {
      sim = null;
    }
    for (const p of sim?.pools ?? []) {
      if (p.lasts !== 'runs dry' || !(p.lastsDays < sim.scenario.days)) continue;
      const sym = m.tokens.get(p.token)?.symbol ?? p.token;
      const days = sim.scenario.days;
      const short = p.outPerDay - p.inPerDay;
      const need = !p.outs.some((o) => o.percentPerDay !== undefined) && short > 0 ? +(short * days).toFixed(6) : null;
      const takers = p.outs.map((o) => o.by).join(', ');
      warn('W-POOL-RUNS-DRY', `economy.pools.${p.key}`, `At the scenario’s rates “${p.key}” pays out ${+p.outPerDay.toFixed(6)} ${sym} a day (${takers}) and takes in ${+p.inPerDay.toFixed(6)}: its seed of ${p.seed} ${sym} is gone on day ${p.lastsDays} of ${days}. After that what it owes is skipped or fails until money comes in.`, `Seed it with ${need !== null ? `at least ${need} ${sym} (${days} days at that rate)` : 'more'}, fill it with a share of a sale (a split to "pool:${p.key}") or a schedule, or pay less from it.`);
    }
  }

  return result();
}

/** A one-line summary for each refusal and warning, as a person reads them. */
export function describe({ refusals, warnings }) {
  return [
    ...refusals.map((r) => `✗ ${r.code} ${r.message}\n    Fix: ${r.fix}`),
    ...warnings.map((w) => `! ${w.code} ${w.message}${w.fix ? `\n    ${w.fix}` : ''}`),
  ].join('\n');
}

export { SpecError };
