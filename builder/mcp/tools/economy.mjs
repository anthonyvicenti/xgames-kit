// MCP tools for a game's economy (devnet): what an economy can be made of, examples to start from, the checker, the
// quick simulation, the cost, the spec in plain words, saving it into the game, and the links the creator's wallet
// signs from (going live, a decision). Behind the same switch as web3_* (on by default; GAMESFUN_WEB3=0 turns it off, builder/lib/web3-switch.mjs).
//
// Read-only, apart from economy_save, which writes the `economy` section of the game's gamesfun.json after the
// checker passes it. No tool signs, holds a key or talks to a wallet: going live and every decision happen in the
// studio page, in the creator's own wallet. The spec format is builder/web3/economy/README.md; the skill that drives these is
// skills/gamesfun-economy.
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check, describe, findSecrets } from '../../web3/economy/check.mjs';
import { carryIds, diff } from '../../web3/economy/compile.mjs';
import { cost, explainCost } from '../../web3/economy/cost.mjs';
import { CASES, referenceOf } from '../../web3/economy/evals/score.mjs';
import { LIMITS, isAddress, model, sharesOf } from '../../web3/economy/model.mjs';
import { explain, round, simulate } from '../../web3/economy/simulate.mjs';
import { explainFull, simulateFull } from '../../web3/economy/sim/index.mjs';
import { playSteps } from '../../web3/economy/steps.mjs';
import { SCHEMA } from '../../web3/economy/validate.mjs';
import { networkConfig } from '../../web3/gf-web3/network.js';
import { readConfig, updateConfig } from '../../web3/node/game.mjs';
import { KIT_ROOT, resolveGame, studioUrl } from '../../web3/node/game-dir.mjs';
import { ledgerFile, linkParams, prepareDecision, readLedger, readRequest } from '../../web3/node/decide.mjs';
import { chainContext } from '../../web3/node/settings.mjs';

const ECONOMY_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web3', 'economy');
const FIXTURES = path.join(ECONOMY_DIR, 'fixtures');
const IDEAS = JSON.parse(readFileSync(path.join(ECONOMY_DIR, 'ideas.json'), 'utf8')).ideas;
const FIXTURE_NAMES = ['coin-flip-arena', 'blind-forge', 'spark-pity', 'halving-seasons', 'scorched-treasury', 'merge-2048', 'stud-farm', 'sacrifice-raffle', 'falling-drop', 'duel-arena', 'starforce', 'level-ladder'];

/** Stand-ins for tests: `status` replaces builder/web3/node/economy.mjs's economyStatus. */
export const seams = { status: undefined };

const kitRoot = (ctx) => ctx?.kitRoot ?? KIT_ROOT;
const envOf = (ctx) => ctx?.env ?? process.env;
const nowOf = (ctx) => ctx?.now ?? Math.floor(Date.now() / 1000);

/** economy_simulate with `full: true` (builder/web3/economy/sim): the real program beside the quick simulation. */
async function fullSimulation(economy, input, from, ctx) {
  const r = await (ctx?.simulateFull ?? simulateFull)(economy, { players: input.players ?? 20, days: input.days, seed: input.seed, now: nowOf(ctx) });
  if (r.mode !== 'full') return { ok: true, from, mode: 'quick', text: `${r.why}\n\n${explain(r.quick, economy)}`, ...(input.json ? { simulation: r.quick } : {}) };
  return { ok: true, from, mode: 'full', text: explainFull(r), flagged: r.flagged, compare: r.compare, notes: r.notes, ...(input.json ? { full: r.full, quick: r.quick } : {}) };
}
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const num = (x) => (Number.isFinite(x) ? String(round(x, 6)) : String(x));

// ---------------------------------------------------------------- where a spec comes from

const game = { type: 'string', description: 'The game folder, relative to the kit root (games/coin-flip). Its gamesfun.json holds the economy. Optional when there is only one game.' };
const specArg = { type: 'object', description: 'An economy spec to work on directly (the "economy" section, or a whole gamesfun.json). Takes precedence over file, example and game.' };
const fileArg = { type: 'string', description: 'A JSON file holding an economy spec (or a whole gamesfun.json), relative to the kit root.' };
const exampleArg = { type: 'string', description: 'An example by name, from economy_examples (coin-flip-arena, e16-plinko, …).' };
const SOURCE = { game, spec: specArg, file: fileArg, example: exampleArg };

function exampleSpec(name) {
  const n = String(name).replace(/\.json$/, '');
  if (FIXTURE_NAMES.includes(n)) return { spec: JSON.parse(readFileSync(path.join(FIXTURES, `${n}.json`), 'utf8')), kind: 'fixture', name: n };
  const c = CASES.find((x) => x.id === n || path.basename(x.reference, '.json') === n);
  if (c) return { spec: referenceOf(c), kind: c.reference.startsWith('fixtures/') ? 'fixture' : 'reference', name: c.reference.startsWith('fixtures/') ? path.basename(c.reference, '.json') : c.id };
  throw new Error(`No example called “${name}”. economy_examples lists them.`);
}

async function gameDirOf(input, ctx) {
  return resolveGame(input.game, { kitRoot: kitRoot(ctx), cwd: kitRoot(ctx) });
}

/** The economy a call means. → { economy, from, gameDir?, config? } */
async function load(input, ctx) {
  const unwrap = (v) => (v && typeof v === 'object' && v.economy && typeof v.economy === 'object' ? v.economy : v);
  if (input.spec) return { economy: unwrap(input.spec), from: 'the spec given' };
  if (input.file) {
    const file = path.resolve(kitRoot(ctx), input.file);
    let value;
    try {
      value = JSON.parse(await readFile(file, 'utf8'));
    } catch (e) {
      throw new Error(e.code === 'ENOENT' ? `${input.file} does not exist.` : `${input.file} is not valid JSON: ${e.message}`);
    }
    return { economy: unwrap(value), from: input.file };
  }
  if (input.example) {
    const ex = exampleSpec(input.example);
    return { economy: ex.spec, from: `the example ${ex.name}` };
  }
  const gameDir = await gameDirOf(input, ctx);
  const config = await readConfig(gameDir);
  const rel = shownDir(gameDir, ctx);
  if (!config.economy) {
    if (config.shop) throw new Error(`${rel} has a shop and no economy yet. Move the shop into an economy first: the studio's Economy tab shows it as one and saves it (then build on what it saved).`);
    throw new Error(`${rel} has no economy yet. Write one (economy_catalog, economy_examples) and save it with economy_save, or pass "spec".`);
  }
  return { economy: config.economy, from: `${rel}/gamesfun.json`, gameDir, config };
}

function shownDir(dir, ctx) {
  const rel = path.relative(kitRoot(ctx), dir);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep).join('/') : dir;
}

const refusalResult = (verdict, from) => ({
  ok: false,
  from,
  refusals: verdict.refusals,
  warnings: verdict.warnings,
  text: `${describe({ refusals: verdict.refusals, warnings: [] })}\n\n${plural(verdict.refusals.length, 'refusal')} in ${from}: fix ${verdict.refusals.length === 1 ? 'it' : 'them'} (each says how), then run economy_check again.`,
});

// ---------------------------------------------------------------- the catalog

/** What each part is for at play time: who acts, and whether the authority (what only the game knows) is needed. */
const PARTS = {
  tokens: { def: 'token', says: 'The currencies: SOL, the game’s token launched with games.fun on a Meteora curve of its own (source "curve", "pair" SOL by default, USDC or any SPL mint; the creator keeps 95% of its trading fees, games.fun 5%), any existing mint by address launched anywhere (classic or Token-2022, pump.fun included; games.fun takes nothing from it), or a token the game mints itself (points, tickets, shards).', acts: 'nobody: a token is a fact' },
  currency: { says: 'The key of the token that is the game’s own currency: what items are priced in and what the treasury holds. Fixed once live.', acts: '' },
  collection: { def: 'collection', says: 'The Metaplex Core collection the game’s collectibles are minted into. Needed when there are items.', acts: '' },
  items: { def: 'item', says: 'Collectibles (minted to the player) and normal items (kept by the game’s backend): supply, price in the game’s currency, a price that rises or falls, a life (ready after, lasts, uses, cooldown), soulbound.', acts: 'the player buys (0.002 SOL player fee); anyone settles the order' },
  pools: { def: 'pool', says: 'Vaults only the game can spend from: prize pools, a lottery’s pot, stakers’ rewards. `seed` is what the creator puts in at the start.', acts: 'nobody directly: other parts fill and drain them' },
  boxes: { def: 'box', nested: ['outcome', 'rise', 'fall', 'split'], says: 'A paid roll on chain: each outcome gives an item, a prize from a pool, a share of a pool (a jackpot), a burn of the payment, or nothing.', acts: 'the player opens (0.002 SOL); anyone settles. Chance that pays tokens is flagged (W-CHANCE-PRIZE)' },
  payments: { def: 'payment', nested: ['split'], says: 'A player pays for something the game gives off chain (an attempt, an entry), split as it says.', acts: 'the player pays (0.002 SOL)' },
  recipes: { def: 'recipe', nested: ['input', 'output'], says: 'Collectibles and tokens in, collectibles and tokens out: merges, salvage, an exchange, breeding, a daily claim, a token that buys a box.', acts: 'the player crafts (0.002 SOL)' },
  schedules: { def: 'schedule', says: 'On a timer: mint a game token into a pool (halving if asked), burn a share of a pool, or move a share between pools.', acts: 'anyone runs it when it is due (free)' },
  lotteries: { def: 'lottery', says: 'Tickets into a pot, a draw on a timer, up to 8 places. Give it a pot of its own.', acts: 'players buy tickets (0.002 SOL); anyone draws and pays (free). Flagged as chance (W-CHANCE-PRIZE)' },
  stakes: { def: 'stake', says: 'Players lock a token and share whatever arrives in a rewards pool, which must be this stake’s alone. Cannot be edited once open.', acts: 'the player stakes and unstakes (0.002 SOL each)' },
  contests: { def: 'contest', nested: ['split'], says: 'Players put money on a side; the side the authority names shares the pot. Needs the authority while it runs.', acts: 'the authority opens and decides (0.00001 SOL each); players enter (0.002 SOL). Flagged as betting' },
  holds: { def: 'hold', says: 'A player hands a collectible to the game for a time; until it is up the authority says where it goes, after it anyone sends it home. Needs the authority.', acts: 'the player hands it in (0.002 SOL); the authority awards (0.00001 SOL)' },
  decisions: { def: 'decision', says: 'The authority’s rules in words: what only the game knows (who cleared the level, who won) and what the program then does (a payout, a burn, a mint).', acts: 'the authority signs each one (0.00001 SOL): the creator’s wallet from the studio page, or a key of its own' },
  keys: { says: '`authority`: "owner" (the creator’s wallet is both keys) or another wallet’s public address. Never a private key.', acts: '' },
  scenario: { def: 'scenario', says: 'What the quick simulation assumes: how many of each thing a day ("box:flip": 1000), days, how much is staked.', acts: '' },
};
const CONVENTIONS = [
  'Amounts are whole units of their currency: 0.1 is 0.1 SOL. Write "0.1" as text when it must be exact.',
  'Shares are percents with at most two decimals: 2.5 is 2.5%.',
  'Times are durations ("45s", "30m", "6h", "7d", "2w", or seconds); a start is "publish", "publish+7d" or a date like "2026-11-01T18:00:00Z".',
  'Every part has a `key` (lower case, digits, dashes) that other parts name: a box pays from "pool": "house"; a split sends to "pool:house".',
  `A split is up to ${LIMITS.shares} shares of a payment, each { "to": "burn" | "pool:<key>" | "account:<token account>" | "holder:<collectible address>", "percent": n }; what they leave goes to the treasury.`,
  'A box’s outcomes each have a `chance` (percents adding up to 100) or each a `weight` (whole numbers).',
  'Leave out `id` and `index`: they are written when the economy goes live. Leave out `live` too.',
  'Public data only. A spec never holds a private key or a seed phrase (the checker refuses one, E-SECRET).',
  'Devnet only: "network": "devnet" (or leave it out).',
];

function typeOf(node) {
  if (!node) return 'any';
  if (node.$ref) return node.$ref.split('/').pop();
  if (node.const !== undefined) return JSON.stringify(node.const);
  if (node.enum) return node.enum.map((v) => JSON.stringify(v)).join(' | ');
  if (node.anyOf) return node.anyOf.map(typeOf).join(' | ');
  if (node.type === 'array') return `list of ${typeOf(node.items)}${node.maxItems ? ` (at most ${node.maxItems})` : ''}`;
  if (node.type === 'integer' || node.type === 'number') return `${node.type}${node.minimum !== undefined || node.maximum !== undefined ? ` ${node.minimum ?? ''}..${node.maximum ?? ''}` : ''}`;
  return node.type ?? 'object';
}

function fieldsOf(def) {
  const required = new Set(def.required ?? []);
  return Object.entries(def.properties ?? {}).map(([name, p]) => ({ name, type: typeOf(p), ...(required.has(name) ? { required: true } : {}), ...(p.default !== undefined ? { default: p.default } : {}), ...(p.description ? { says: p.description } : {}) }));
}
const fieldLine = (f) => `    ${f.name}${f.required ? '*' : ''}: ${f.type}${f.default !== undefined ? ` (default ${JSON.stringify(f.default)})` : ''}${f.says ? ` — ${f.says}` : ''}`;

function catalogData(only) {
  const defs = SCHEMA.$defs;
  const parts = Object.entries(PARTS)
    .filter(([name]) => !only || name === only)
    .map(([name, p]) => {
      const node = SCHEMA.properties[name];
      const def = p.def ? defs[p.def] : node;
      const nested = (p.nested ?? []).map((n) => ({ name: n, says: defs[n].description ?? '', fields: defs[n].type === 'array' ? [{ name: '(list)', type: typeOf(defs[n]) }] : fieldsOf(defs[n]) }));
      return { part: name, type: typeOf(node), says: p.says, ...(p.acts ? { atPlayTime: p.acts } : {}), fields: def?.properties ? fieldsOf(def) : [], ...(nested.length ? { nested } : {}) };
    });
  return parts;
}

// ---------------------------------------------------------------- examples

const SYNONYMS = {
  gacha: ['box', 'boxes', 'pull'], loot: ['box', 'boxes'], mystery: ['box', 'boxes'], pack: ['box', 'boxes'], roll: ['box', 'boxes'],
  staking: ['stake', 'stakes'], stake: ['stake', 'stakes'], yield: ['stake', 'stakes'], earn: ['stake', 'stakes'],
  raffle: ['lottery', 'lotteries'], lottery: ['lottery', 'lotteries'], draw: ['lottery', 'lotteries'], jackpot: ['share', 'pool'],
  craft: ['recipe', 'recipes'], crafting: ['recipe', 'recipes'], merge: ['recipe', 'recipes'], breed: ['recipe', 'recipes', 'life'], breeding: ['recipe', 'recipes', 'life'],
  season: ['schedule', 'schedules'], seasons: ['schedule', 'schedules'], halving: ['schedule', 'schedules'], emission: ['schedule', 'schedules'],
  bet: ['contest', 'contests'], betting: ['contest', 'contests'], duel: ['contest', 'contests'], wager: ['contest', 'contests'],
  shop: ['item', 'items'], nft: ['item', 'items'], nfts: ['item', 'items'], collectible: ['item', 'items'], burn: ['burn'], deflation: ['burn'],
  leaderboard: ['decision', 'decisions'], tournament: ['contest', 'decision', 'decisions'], prize: ['pool', 'pools'],
  'token-2022': ['token-2022'], pump: ['pump.fun'], 'pump.fun': ['pump.fun'], flip: ['coin', 'flip', 'box', 'boxes'],
};
const words = (s) => String(s ?? '').toLowerCase().match(/[a-z0-9][a-z0-9.+-]*/g) ?? [];
const STOP = new Set(['a', 'an', 'the', 'and', 'or', 'of', 'to', 'in', 'for', 'with', 'my', 'our', 'that', 'is', 'it', 'on', 'every', 'each', 'make', 'me', 'game', 'i', 'want']);

function partsUsed(spec) {
  const out = Object.keys(PARTS).filter((k) => Array.isArray(spec?.[k]) && spec[k].length);
  const all = JSON.stringify(spec ?? {});
  for (const [f, re] of [['rise', /"rise"/], ['fall', /"fall"/], ['life', /"life"/], ['holder', /holder:/], ['burn', /"burn"/], ['token-2022', /token-2022/], ['pump.fun', /pump\.fun/], ['share', /"gives":"share"/]]) if (re.test(all.replace(/\s/g, ''))) out.push(f);
  return out;
}

function exampleEntries() {
  const entries = [];
  for (const name of FIXTURE_NAMES) {
    const spec = exampleSpec(name).spec;
    const c = CASES.find((x) => x.reference === `fixtures/${name}.json`);
    entries.push({ kind: 'fixture', name, title: spec.name, prompt: spec.prompt, parts: partsUsed(spec), ...(c ? { eval: c.id } : {}) });
  }
  for (const c of CASES.filter((x) => !x.reference.startsWith('fixtures/'))) {
    const spec = referenceOf(c);
    entries.push({ kind: 'reference', name: c.id, title: spec.name, prompt: c.prompt, parts: partsUsed(spec), eval: c.id });
  }
  return entries;
}

/** Where to start an idea from: the example written from it, else the nearest fixture ideas.json names. */
function startOf(idea) {
  const c = CASES.find((x) => x.ideas.includes(idea.n));
  if (c) return c.reference.startsWith('fixtures/') ? path.basename(c.reference, '.json') : c.id;
  return idea.start ?? null;
}

/** How well an entry's words and parts answer a query: a word it has, a word it starts with, a part the query names. */
function score(text, query, parts = []) {
  const have = new Set(words(text));
  const uses = new Set(parts);
  let s = 0;
  for (const w of words(query).filter((x) => !STOP.has(x))) {
    if (have.has(w)) s += 2;
    else if ([...have].some((h) => h.length > 3 && w.length > 3 && (h.startsWith(w) || w.startsWith(h)))) s += 1;
    for (const syn of SYNONYMS[w] ?? []) s += (have.has(syn) ? 1 : 0) + (uses.has(syn) ? 2 : 0);
  }
  return s;
}

// ---------------------------------------------------------------- explain

function splitWords(split, m) {
  const shares = sharesOf(split);
  if (!shares.length) return 'all of it to your treasury';
  const left = 100 - shares.reduce((n, s) => n + Number(s.percent), 0);
  const to = (s) => (s.kind === 'burn' ? 'burned' : s.kind === 'pool' ? `to the pool “${s.key}”` : s.kind === 'holder' ? 'to whoever holds that collectible' : `to the account ${s.key.slice(0, 4)}…`);
  return `${shares.map((s) => `${s.percent}% ${to(s)}`).join(', ')}${left > 0 ? `, ${num(left)}% to your treasury` : ''}`;
}

/** The spec in plain words, from the checker, the simulation, the cost and the play-time steps. Deterministic. */
export function explainEconomy(economy, { now = Math.floor(Date.now() / 1000) } = {}) {
  const verdict = check(economy, { now });
  if (!verdict.ok) return { ok: false, refusals: verdict.refusals, warnings: verdict.warnings, text: describe({ refusals: verdict.refusals, warnings: [] }) };
  const m = model(economy, { now });
  const sim = simulate(economy, { now });
  const c = cost(economy, { now });
  const play = playSteps(economy);
  const sym = (key) => m.tokens.get(key)?.symbol ?? key;
  const lines = [];
  const section = (title, rows) => {
    if (rows.length) lines.push('', title, ...rows.map((r) => `- ${r}`));
  };

  const ONE = { tokens: 'token', items: 'item', pools: 'pool', boxes: 'box', payments: 'payment', recipes: 'recipe', schedules: 'schedule', lotteries: 'lottery', stakes: 'stake', contests: 'contest', holds: 'hold', decisions: 'decision' };
  const counted = Object.keys(ONE).filter((k) => economy[k]?.length).map((k) => plural(economy[k].length, ONE[k], k));
  lines.push(`${economy.name ?? 'This economy'}: ${counted.join(', ') || 'nothing yet'}. The game’s currency is ${m.currency?.symbol ?? '(none)'}${m.currency ? ` (${m.currency.source === 'sol' ? 'SOL' : m.currency.source === 'curve' ? 'its token on games.fun’s curve' : m.currency.source === 'game' ? 'a token the game mints' : `an existing ${m.currency.program === 'token-2022' ? 'Token-2022 ' : ''}mint`})` : ''}. Devnet only.`);
  if (economy.prompt) lines.push(`Asked for: “${economy.prompt}”`);

  const fee = num(sim.fees.playerSol);
  const actions = [];
  for (const it of sim.items) {
    const src = m.item.get(it.key);
    actions.push(`Buy “${it.name}”: ${num(it.price)} ${sym(it.token)} + ${fee} SOL player fee${src.supply ? `; ${src.supply} exist` : ''}${src.rise ? '; the price rises after every sale' : ''}${src.fall ? `; the price falls ${src.fall.step} every ${src.fall.every}${src.fall.floor !== undefined ? ` to at least ${src.fall.floor}` : ''}` : ''}${src.soulbound ? '; soulbound' : ''}. The money: ${splitWords(src.split, m)}.`);
  }
  for (const b of sim.boxes) {
    const src = m.box.get(b.key);
    const back = b.returnPercent !== null ? `gives back ${num(b.expectedBack)} ${sym(b.token)} on average (${num(b.returnPercent)}% of its price; the house keeps ${num(b.houseEdgePercent)}%)` : 'gives back what its items are worth to the player';
    const outs = b.outcomes.map((o) => `${num(o.chance)}% ${o.gives === 'pay' ? `${num(o.amount)} ${sym(o.token)} from “${o.pool}”` : o.gives === 'share' ? `${o.percent}% of “${o.pool}”` : o.gives === 'item' ? `${o.item}` : o.gives === 'burn' ? 'burned' : 'nothing'}`).join(', ');
    actions.push(`Open “${b.name}”: ${num(b.price)} ${sym(b.token)} + ${fee} SOL player fee + ${num(b.oracleFee)} SOL to MagicBlock’s oracle for the roll${b.realCost?.totalSol !== undefined ? ` (${num(b.realCost.totalSol)} SOL in all with the network fee)` : ''}; ${back}. Odds: ${outs}. The money: ${src.outcomes.some((o) => o.gives === 'burn') ? 'on a burn, all of it is burned; otherwise ' : ''}${splitWords(src.split, m)}.`);
  }
  for (const p of sim.payments) actions.push(`Pay “${p.name}”: ${num(p.amount)} ${sym(p.token)} + ${fee} SOL player fee. The money: ${splitWords(m.payments.find((x) => x.key === p.key)?.split, m)}.`);
  for (const r of sim.recipes) actions.push(`Craft “${r.name}”: ${r.takes.join(' + ') || 'nothing'} → ${r.gives.join(' + ') || 'nothing'} (+ ${fee} SOL player fee).`);
  for (const l of sim.lotteries) actions.push(`Buy tickets for “${l.name}”: ${num(l.price)} ${sym(l.token)} a ticket + ${fee} SOL player fee. Drawn every ${num(l.roundDays)} days; the pot reaches about ${num(l.potBeforeDraw)} ${sym(l.potToken)} and pays ${l.prizes.map(num).join(' / ')}; a ticket is worth ${num(l.expectedPerTicket)} on average${l.returnPercent !== null ? ` (${num(l.returnPercent)}%)` : ''}${l.cutPercent ? `; ${num(l.cutPercent)}% of ticket money goes to your treasury` : ''}.`);
  for (const s of sim.stakes) actions.push(`Stake ${sym(s.stakes)} in “${s.name}”: ${num(s.rewardsPerDay)} ${sym(s.rewardsToken)} a day shared by everyone staked${s.perThousandStakedPerDay !== undefined ? ` (${num(s.perThousandStakedPerDay)} a day for each 1,000 staked${s.yearlyPercent !== undefined ? `, ${num(s.yearlyPercent)}% a year` : ''})` : ''}${m.stake.get(s.key)?.lock ? `; locked for ${m.stake.get(s.key).lock} after each stake` : ''}.`);
  for (const ct of sim.contests) actions.push(`Back a side in “${ct.name}” (+ ${fee} SOL player fee): ${ct.says}; the authority names the side that won.`);
  for (const h of m.holds) actions.push(`Hand in a ${h.item} for “${h.name}”${h.for ? ` for ${h.for}` : ''}: the authority says where it goes; after the time is up anyone can send it home.`);
  section('What players do, what it costs and what it is worth', actions);

  section('How the pools fill and drain', sim.pools.map((p) => {
    const fate = p.lasts === 'runs dry' ? `runs dry in about ${num(p.lastsDays)} days` : p.lasts === 'settles' ? `settles at about ${num(p.settlesAt)}` : p.lasts === 'shrinks' ? `shrinks to about ${num(p.after)} after ${sim.scenario.days} days` : p.lasts === 'grows' ? `grows to about ${num(p.after)} after ${sim.scenario.days} days` : 'holds steady';
    const by = (rows) => rows.map((r) => (r.percentPerDay !== undefined ? `${r.by} ${num(r.percentPerDay)}% of what it holds a day` : `${r.by} ${num(r.perDay)} a day`)).join(', ') || 'nothing';
    const moves = m.schedules.filter((x) => x.does === 'move' && x.to === p.key).map((x) => `schedule:${x.key} ${x.percent}% of “${x.from}” every ${x.every}`);
    const ins = [...(p.ins.length ? [by(p.ins)] : []), ...moves].join(', ') || 'nothing';
    return `“${p.key}” (${sym(p.token)}): starts at ${num(p.seed)}; in: ${ins}; out: ${by(p.outs)}; it ${fate}.`;
  }));
  section('What runs by itself', [...sim.schedules.map((s) => `“${m.schedules.find((x) => x.key === s.key)?.name ?? s.key}” ${s.says}; anyone can run it when it is due.`), ...sim.lotteries.map((l) => `“${l.name}” is drawn every ${num(l.roundDays)} days by MagicBlock’s oracle; anyone can ask for the draw (${num(sim.fees.oracleSol)} SOL to the oracle) and pay the places.`)]);
  const authority = play.filter((s) => s.signer === 'authority');
  section(`What only the authority signs while it runs (${m.authority === 'owner' ? 'your wallet, from the studio page' : `the key ${m.authority}`})`, authority.map((s) => `${s.says} (${s.part}, ${s.ix}).`));
  // Confirming someone beat the game is the game owner's to do, on their own end: the kit cannot tell a real win from a faked one.
  if (authority.length) lines.push('- Checking that a player really beat the game, before any of these pays them, is up to you, on your own server or backend: the game runs in the player’s browser and the kit can’t tell a real win from a faked one.');

  const s = c.setup;
  lines.push('', 'What setting it up costs');
  lines.push(`- About ${num(s.totalSol)} SOL in all, in ${plural(s.transactions, 'transaction')} (${plural(s.approvals, 'wallet approval')}): rent ${num(s.rentSol)} SOL for ${plural(s.accounts.length, 'account')}, program fees ${num(s.programFeesSol)} SOL, network fees ${num(s.networkFeesSol)} SOL${Object.keys(s.seeds).length ? `, seeds ${Object.entries(s.seeds).map(([k, v]) => `${num(v)} ${k}`).join(', ')}` : ''}.`);
  for (const n of s.notes) lines.push(`- ${n}`);

  const d = sim.perDay;
  const list = (map) => Object.entries(map).map(([k, v]) => `${num(v)} ${sym(k)}`).join(', ') || 'nothing';
  lines.push('', `Each day, if ${Object.entries(sim.scenario.perDay).map(([k, v]) => `${v} × ${k}`).join(', ') || `${sim.scenario.defaultPerDay} of each thing`} happen${Object.keys(sim.scenario.perDay).length ? ` (anything else ${sim.scenario.defaultPerDay})` : ''}`);
  lines.push(`- Players pay ${list(d.players.pay)} and get back ${list(d.players.getBack)} on average, plus ${num(d.players.playerFeesSol)} SOL in player fees${d.players.oracleFeesSol ? ` and ${num(d.players.oracleFeesSol)} SOL to MagicBlock’s oracle` : ''}.`);
  lines.push(`- Your treasury gets ${list(d.creator.treasury)}; burned: ${list(d.burned)}; games.fun’s fees: ${num(d.platform.totalSol)} SOL.`);
  for (const n of sim.notes) lines.push(`- ${n}`);

  const flagged = verdict.warnings.filter((w) => w.code === 'W-CHANCE-PRIZE');
  const others = verdict.warnings.filter((w) => w.code !== 'W-CHANCE-PRIZE');
  if (flagged.length) section('Chance that pays money (flagged)', [...new Set(flagged.map((w) => w.message))]);
  section('Know before going live', others.map((w) => `${w.message}${w.fix ? ` ${w.fix}` : ''}`));
  lines.push('', 'Devnet only: nothing here is real money. Going live is one approval in your own wallet, in the studio.');
  return { ok: true, text: lines.join('\n').trim(), warnings: verdict.warnings, needsAuthority: authority.length > 0, chance: flagged.length > 0, setupSol: s.totalSol };
}

// ---------------------------------------------------------------- links

/** The studio's link for the economy tab, or null when no studio runs for this game. */
async function studioLink(gameDir, ctx, params) {
  const url = await studioUrl({ gameDir, kitRoot: kitRoot(ctx), env: envOf(ctx) });
  if (!url) return { url: null, link: null };
  const u = new URL(url);
  u.hash = `economy?${new URLSearchParams(params).toString()}`;
  return { url, link: u.toString() };
}

// ---------------------------------------------------------------- the tools


export const tools = [
  {
    name: 'economy_catalog',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description:
      'Read this first when a creator asks for an economy (a shop, loot boxes, a lottery, staking, crafting, seasons, a token, anything players pay or earn in a game). Returns what a game economy can be made of on games.fun’s loot program 0.3 (devnet): each part (tokens, items, pools, boxes, payments, recipes, schedules, lotteries, stakes, contests, holds, decisions, keys, scenario) with what it is for, who acts at play time and its fee, and its fields from the schema; plus the writing conventions (units, percents, durations, keys, splits) and the devnet currencies usable without an address. Pass `part` for one part with its nested shapes (a box’s outcomes, a recipe’s inputs and outputs). Read-only.',
    inputSchema: { type: 'object', properties: { part: { type: 'string', enum: Object.keys(PARTS), description: 'One part, with its nested shapes.' } }, additionalProperties: false },
    async handler({ part } = {}) {
      const parts = catalogData(part);
      const currencies = networkConfig('devnet').currencies.map((c) => ({ symbol: c.symbol, mint: c.mint, decimals: c.decimals, write: c.kind === 'sol' ? '{ "key": "sol", "source": "sol" }' : `{ "key": "${c.kind}", "source": "existing", "symbol": "${c.symbol.replace('-dev', '')}", "mint": "${c.mint}", "decimals": ${c.decimals} }` }));
      const text = [
        part ? `The part “${part}” of an economy (web3/economy/economy.schema.json; * = required):` : 'An economy is the "economy" section of a game’s gamesfun.json, on games.fun’s loot program 0.3, devnet only. Its parts (* = required field):',
        ...parts.flatMap((p) => [`\n${p.part} (${p.type}): ${p.says}${p.atPlayTime ? `\n  At play time: ${p.atPlayTime}.` : ''}`, ...p.fields.map(fieldLine), ...(p.nested ?? []).flatMap((n) => [`  ${n.name}: ${n.says}`, ...n.fields.map((f) => `  ${fieldLine(f)}`)])]),
        ...(part ? [] : ['\nWriting it:', ...CONVENTIONS.map((c) => `- ${c}`), '\nDevnet currencies usable without looking up an address:', ...currencies.map((c) => `- ${c.symbol}: ${c.write}`), '\nNext: economy_examples to find the nearest example, then write the spec and run economy_check.']),
      ].join('\n');
      return { text, parts, ...(part ? {} : { conventions: CONVENTIONS, currencies, fees: { playerSol: 0.002, projectSol: 0.00001, says: '0.002 SOL when a player signs for something of their own; 0.00001 SOL for the authority’s and other charged calls; setup pays rent and network fees only.' } }) };
    },
  },
  {
    name: 'economy_examples',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description:
      'Find an economy to start from. With `query` (a few words of what the creator wants: "gacha with pity", "staking", "weekly lottery", "breeding"), returns the closest worked examples (complete specs that pass the checker) and the closest of 100 economy ideas, each idea with how it fits the program (Alone: runs with no game key; Key: needs the authority; Server or Gap: the program cannot do the core of it) and the example to start from. With `name`, returns that example’s whole spec to copy and change. With neither, lists every example. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What the creator wants, in a few words.' },
        name: { type: 'string', description: 'An example’s name (from a listing) to get its whole spec.' },
        fit: { type: 'string', enum: ['Alone', 'Key', 'Server', 'Gap'], description: 'Only ideas with this fit.' },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: 'How many of each kind to return (default 6).' },
      },
      additionalProperties: false,
    },
    async handler({ query, name, fit, limit = 6 } = {}) {
      if (name) {
        const ex = exampleSpec(name);
        const verdict = check(ex.spec);
        return { name: ex.name, kind: ex.kind, spec: ex.spec, checks: verdict.ok ? 'clean' : verdict.refusals.map((r) => r.code), text: `${ex.spec.name}: ${ex.spec.prompt ?? ''}\nCopy the spec, change it to what the creator asked, then run economy_check on it.${ex.spec.tokens?.some((t) => t.source === 'existing' && /placeholder/i.test(t.name ?? '')) ? ' Its existing mint is a placeholder: use the creator’s own.' : ''}` };
      }
      const examples = exampleEntries();
      if (!query) {
        return {
          examples,
          ideas: { count: IDEAS.length, byFit: Object.fromEntries(['Alone', 'Key', 'Server', 'Gap'].map((f) => [f, IDEAS.filter((i) => i.fit === f).length])), says: 'Pass a query to search the 100 ideas.' },
          text: [`${examples.length} worked examples (economy_examples {"name": "<name>"} gives the whole spec):`, ...examples.map((e) => `- ${e.name}: ${e.title}. ${e.prompt ?? ''} [${e.parts.join(', ')}]`), `\nAnd ${IDEAS.length} economy ideas: pass a query to search them.`].join('\n'),
        };
      }
      const exHits = examples.map((e) => ({ e, s: score(`${e.name} ${e.title} ${e.prompt}`, query, e.parts) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, limit).map((x) => x.e);
      const ideaHits = IDEAS.filter((i) => !fit || i.fit === fit)
        .map((i) => ({ i, s: score(`${i.name} ${i.section} ${i.says} ${i.how}`, query, i.parts) + (i.fit === 'Alone' ? 0.5 : i.fit === 'Key' ? 0.25 : 0) }))
        .filter((x) => x.s > 0.5)
        .sort((a, b) => b.s - a.s)
        .slice(0, limit)
        .map(({ i }) => ({ n: i.n, name: i.name, fit: i.fit, says: i.says, how: i.how, parts: i.parts, startFrom: startOf(i), ...(i.fit === 'Gap' ? { note: 'The program cannot do the core of this yet (see how). Tell the creator, and offer the nearest thing it can do.' } : i.fit === 'Server' ? { note: 'The main rule runs on the game’s own server; the economy only takes the money in and pays it out.' } : {}) }));
      const text = [
        exHits.length ? `Examples closest to “${query}” (economy_examples {"name": …} gives the whole spec):` : `No worked example matches “${query}”. Start from the nearest idea below, or from economy_catalog.`,
        ...exHits.map((e) => `- ${e.name}: ${e.title}. ${e.prompt ?? ''} [${e.parts.join(', ')}]`),
        ideaHits.length ? '\nIdeas (from 100):' : '',
        ...ideaHits.map((i) => `- #${i.n} ${i.name} (${i.fit}${i.startFrom ? `; start from ${i.startFrom}` : ''}): ${i.says} How: ${i.how}`),
      ].filter(Boolean).join('\n');
      return { examples: exHits, ideas: ideaHits, text };
    },
  },
  {
    name: 'economy_check',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description:
      'Check an economy spec before anything else is done with it: refusals (each with a code, what it means and its fix) stop it from going live; warnings are what the creator should hear (chance that pays tokens, a mint’s powers, the player fee on a cheap item, decisions the authority must sign). Give the spec inline (`spec`), a file, an example name, or a game (its gamesfun.json). Returns { ok, refusals, warnings, text }. Run it after every change to the spec. Read-only.',
    inputSchema: { type: 'object', properties: SOURCE, additionalProperties: false },
    async handler(input, ctx) {
      const { economy, from } = await load(input, ctx);
      const verdict = check(economy, { now: nowOf(ctx) });
      const head = verdict.refusals.length || verdict.warnings.length ? describe(verdict) : 'No problems found.';
      const tail = verdict.ok ? `\nReady to go live (${plural(verdict.warnings.length, 'warning')}). Next: economy_simulate and economy_explain, and tell the creator what it means in words.` : `\n${plural(verdict.refusals.length, 'refusal')}: fix ${verdict.refusals.length === 1 ? 'it' : 'each one'} as its fix says, then check again.`;
      return { ok: verdict.ok, from, refusals: verdict.refusals, warnings: verdict.warnings, text: `${head}${tail}` };
    },
  },
  {
    name: 'economy_simulate',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description:
      'The quick simulation of an economy (expected values from the spec alone, instant): what each box, ticket and craft gives back against its price, the house edge, each pool’s money in and out per day and whether it runs dry, settles or grows, what players, the creator’s treasury and games.fun’s fees get each day. `scenario` overrides the spec’s own (how many of each a day: {"perDay": {"box:flip": 1000}}, "days", "staked"). Refuses a spec with refusals (run economy_check). Returns { text, summary } (`json: true` adds every row). `full: true` runs the full simulation instead: the real loot program in LiteSVM, synthetic players doing the scenario through the in-game kit’s own calls for its days, and each of its numbers beside the quick one, flagged where they differ by more than chance (takes seconds to minutes; needs devnet once for the program bytes, cached after, and installs LiteSVM into the user’s cache folder on first use; without them it says so and returns the quick simulation). Signs nothing with a real key and sends nothing to any network.',
    inputSchema: {
      type: 'object',
      properties: {
        ...SOURCE,
        scenario: { type: 'object', description: 'What to assume instead of the spec’s scenario: { "days": 30, "perDay": { "<kind>:<key>": n }, "staked": { "<stake key>": amount } }.' },
        json: { type: 'boolean', description: 'Also return every row of the simulation.' },
        full: { type: 'boolean', description: 'Run the full simulation (the real program in LiteSVM) and compare it with the quick one.' },
        players: { type: 'integer', minimum: 1, maximum: 200, description: 'Full simulation: how many synthetic players (20).' },
        days: { type: 'number', exclusiveMinimum: 0, maximum: 365, description: 'Full simulation: how many days (the scenario’s).' },
        seed: { type: 'string', description: 'Full simulation: the seed of its randomness (the same seed gives the same run).' },
      },
      additionalProperties: false,
    },
    async handler(input, ctx) {
      const { economy: base, from } = await load(input, ctx);
      const economy = input.scenario ? { ...base, scenario: { ...(base.scenario ?? {}), ...input.scenario, perDay: { ...(base.scenario?.perDay ?? {}), ...(input.scenario.perDay ?? {}) } } } : base;
      const verdict = check(economy, { now: nowOf(ctx) });
      if (!verdict.ok) return refusalResult(verdict, from);
      if (input.full) return fullSimulation(economy, input, from, ctx);
      const sim = simulate(economy, { now: nowOf(ctx) });
      const summary = {
        boxes: sim.boxes.map((b) => ({ key: b.key, price: b.price, returnPercent: b.returnPercent, houseEdgePercent: b.houseEdgePercent })),
        lotteries: sim.lotteries.map((l) => ({ key: l.key, potBeforeDraw: l.potBeforeDraw, prizes: l.prizes, returnPercent: l.returnPercent })),
        stakes: sim.stakes.map((s) => ({ key: s.key, rewardsPerDay: s.rewardsPerDay, yearlyPercent: s.yearlyPercent })),
        pools: sim.pools.map((p) => ({ key: p.key, inPerDay: p.inPerDay, outPerDay: p.outPerDay, lasts: p.lasts, ...(p.lastsDays !== undefined ? { lastsDays: p.lastsDays } : {}), ...(p.settlesAt !== undefined ? { settlesAt: p.settlesAt } : {}), after: p.after })),
        perDay: sim.perDay,
      };
      return { ok: true, from, text: explain(sim, economy), summary, ...(input.json ? { simulation: sim } : {}) };
    },
  },
  {
    name: 'economy_cost',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description:
      'What an economy costs: going live (each account’s rent, the program’s fees, network fees, the seeds the creator puts into pools, how many transactions and wallet approvals) and each action while it runs, for whoever signs it (a player’s 0.002 SOL fee and the deposits they get back). Refuses a spec with refusals. Returns { text, setup, actions }. Read-only.',
    inputSchema: { type: 'object', properties: { ...SOURCE, json: { type: 'boolean', description: 'Also return every account the setup opens.' } }, additionalProperties: false },
    async handler(input, ctx) {
      const { economy, from } = await load(input, ctx);
      const c = cost(economy, { now: nowOf(ctx) });
      if (!c.ok) return refusalResult(c, from);
      const { accounts, ...setup } = c.setup;
      return { ok: true, from, text: explainCost(c), setup: input.json ? c.setup : { ...setup, accounts: accounts.length }, actions: c.actions };
    },
  },
  {
    name: 'economy_explain',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description:
      'The economy in plain words for the creator, built from the checker, the simulation and the cost (no guessing, the same text every time): what each player action costs and is worth, where each payment goes, how each pool fills and drains, what runs by itself, what only the authority signs while it runs, what setting it up costs, what happens in a day, chance that pays money (flagged), and what to know before going live. Use it to tell the creator what they are getting before every change is settled, and before economy_publish. Read-only.',
    inputSchema: { type: 'object', properties: SOURCE, additionalProperties: false },
    async handler(input, ctx) {
      const { economy, from } = await load(input, ctx);
      const r = explainEconomy(economy, { now: nowOf(ctx) });
      if (!r.ok) return { ...refusalResult({ refusals: r.refusals, warnings: r.warnings }, from) };
      return { ...r, from };
    },
  },
  {
    name: 'economy_save',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    description:
      'Save an economy spec into the game: it becomes the "economy" section of the game’s gamesfun.json (the rest of the file stays). Only a spec the checker passes is saved; otherwise the refusals come back and nothing is written. When the game’s economy is already live, its parts keep their program ids and its live addresses, and a change the program cannot make (an open stake, a pool’s token, the currency) is refused. A game with an old `shop` must move it first (npx gamesfun economy migrate <game> --write). This is the only economy tool that writes anything; it never signs and spends nothing.',
    inputSchema: { type: 'object', required: ['spec'], properties: { game, spec: { type: 'object', description: 'The economy (or a whole gamesfun.json, whose "economy" is taken).' } }, additionalProperties: false },
    async handler(input, ctx) {
      const gameDir = await gameDirOf(input, ctx);
      const rel = shownDir(gameDir, ctx);
      let economy = structuredClone(input.spec?.economy && typeof input.spec.economy === 'object' ? input.spec.economy : input.spec);
      const secrets = findSecrets(economy);
      if (secrets.length) return { saved: false, refusals: [{ code: 'E-SECRET', where: secrets.join(', '), message: 'This looks like a private key or a seed phrase. Nothing was saved.', fix: 'Remove it. A spec only holds public addresses; never ask the creator for a key.' }], text: 'Nothing was saved: the spec holds something that looks like a key or a seed phrase. Remove it.' };
      const config = await readConfig(gameDir);
      if (config.shop && !config.economy) return { saved: false, refusals: [{ code: 'E-SHOP', where: 'gamesfun.json shop', message: `${rel} still has a shop; the economy replaces it.`, fix: `Move it first in the studio's Economy tab (it shows the shop as an economy and saves it). Then build on that economy (economy_check {"game": "${rel}"}) and save again.` }], text: `Nothing was saved: ${rel} still has a shop. Move it into an economy first in the studio's Economy tab.` };
      const old = config.economy;
      const now = nowOf(ctx);
      let verdict;
      if (old?.live?.game) {
        economy = { ...carryIds(old, economy), live: old.live };
        const d = diff(old, economy, { now });
        verdict = d.ok ? check(economy, { now }) : { ok: false, refusals: d.refusals, warnings: d.warnings ?? [] };
      } else verdict = check(economy, { now });
      if (!verdict.ok) return { saved: false, refusals: verdict.refusals, warnings: verdict.warnings, text: `Nothing was saved.\n${describe({ refusals: verdict.refusals, warnings: [] })}\nFix ${verdict.refusals.length === 1 ? 'it' : 'them'} and save again.` };
      await updateConfig(gameDir, (c) => ({ ...c, economy }));
      return {
        saved: true,
        file: `${rel}/gamesfun.json`,
        live: Boolean(old?.live?.game),
        warnings: verdict.warnings,
        text: `Saved the economy in ${rel}/gamesfun.json (${plural(verdict.warnings.length, 'warning')}).${old?.live?.game ? ' It is live: going live again publishes only what changed.' : ''} Next: economy_explain {"game": "${rel}"} for the creator, then economy_publish when they say so.`,
      };
    },
  },
  {
    name: 'economy_publish',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    description:
      'Prepare putting the game’s saved economy live on devnet. This does NOT publish and never signs: it checks the saved spec, adds up what going live costs, and returns the studio link where the creator reviews every step and approves it in their own wallet (the Economy tab’s “Put it live”, which starts the `economy` flow). Use it only when the creator says to go live, after economy_save. If the studio is not running it says how to start it. Returns { ok, approve: { link, url, flow, step }, cost, text }.',
    inputSchema: { type: 'object', properties: { game }, additionalProperties: false },
    async handler(input, ctx) {
      const gameDir = await gameDirOf(input, ctx);
      const rel = shownDir(gameDir, ctx);
      const { economy, from } = await load({ game: input.game }, ctx);
      const verdict = check(economy, { now: nowOf(ctx) });
      if (!verdict.ok) return refusalResult(verdict, from);
      const c = cost(economy, { now: nowOf(ctx) });
      const { url, link } = await studioLink(gameDir, ctx, { flow: 'economy' });
      let request = null;
      try {
        const req = await import('../../web3/node/requests.mjs');
        if (req.REQUEST_KINDS?.includes('economy')) request = await req.queueRequest(kitRoot(ctx), { kind: 'economy', gameDir, input: {}, from: 'mcp', summary: `Put ${economy.name ?? 'the economy'} live (about ${c.setup.totalSol} SOL).` });
      } catch {
        /* the request list is optional: the tab's button starts the same flow */
      }
      const where = link ? `${link} (the studio’s Economy tab)` : `the studio’s Economy tab (start it with: npx gamesfun dev ${rel})`;
      const step = `Open ${where} and press “Put it live”. Your wallet shows every step and its cost before anything is signed.`;
      const live = Boolean(economy.live?.game);
      return {
        ok: true,
        approve: { flow: 'economy', tab: 'economy', url, link, step, ...(request ? { requestId: request.id } : {}) },
        cost: { totalSol: c.setup.totalSol, transactions: c.setup.transactions, approvals: c.setup.approvals, seeds: c.setup.seeds },
        warnings: verdict.warnings,
        text: `${live ? `${economy.name ?? 'The economy'} is live already: the approval holds only what changed since.` : `Going live costs about ${c.setup.totalSol} SOL on devnet (${plural(c.setup.transactions, 'transaction')}, ${plural(c.setup.approvals, 'wallet approval')}).`}\nWaiting for the creator: ${step} Nothing is signed until they approve it in their wallet.`,
      };
    },
  },
  {
    name: 'economy_status',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description:
      'A live economy on devnet: whether it is live, each part on chain (and whether it differs from the spec), each pool’s balance, and recent receipts. Use it after the creator approved going live, or when they ask how it is doing. Read-only; reads the chain.',
    inputSchema: { type: 'object', properties: { game, offline: { type: 'boolean', description: 'Skip the chain; say only what the spec records.' } }, additionalProperties: false },
    async handler(input, ctx) {
      const gameDir = await gameDirOf(input, ctx);
      const rel = shownDir(gameDir, ctx);
      const config = await readConfig(gameDir);
      const live = config.economy?.live ?? null;
      let economyStatus = seams.status;
      if (economyStatus === undefined) {
        try {
          economyStatus = (await import('../../web3/node/economy.mjs')).economyStatus ?? null;
        } catch (e) {
          // not written yet: say so; anything else (a bug in it) is the real error
          if (e.code !== 'ERR_MODULE_NOT_FOUND' || !String(e.message).includes('economy.mjs')) throw e;
          economyStatus = null;
        }
      }
      if (!config.economy) return { available: Boolean(economyStatus), live: false, text: `${rel} has no economy yet.` };
      if (!economyStatus || input.offline) {
        const recorded = live?.game ? `The spec records it live: game ${live.game}${live.at ? ` (since ${live.at})` : ''}.` : 'The spec records nothing live yet.';
        return { available: Boolean(economyStatus), live: Boolean(live?.game), recorded: live, text: economyStatus ? recorded : `economy_status is not available yet: the loot 0.3 chain reader (web3/node/economy.mjs) is still being written. ${recorded}` };
      }
      const s = await economyStatus(gameDir, { kitRoot: kitRoot(ctx), env: envOf(ctx), ...(ctx?.fetchImpl ? { fetchImpl: ctx.fetchImpl } : {}) });
      const parts = s.parts ?? [];
      const text = [
        s.live ? `${config.economy.name ?? rel} is live on devnet${s.game ? ` (game ${s.game})` : ''}.` : `${config.economy.name ?? rel} is not live yet.`,
        ...parts.map((p) => `- ${p.part} “${p.key}”: ${p.onChain ? (p.differs ? 'on chain, but differs from the spec (publish the change)' : 'on chain') : 'not on chain yet'}`),
        ...(s.pools ?? []).map((p) => `- pool ${p.index}: ${p.balance} (${p.mint})`),
        s.receipts?.length ? `${plural(s.receipts.length, 'recent receipt')}.` : '',
      ].filter(Boolean).join('\n');
      return { available: true, ...s, text };
    },
  },
  {
    name: 'economy_decide',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description:
      'Prepare one of the authority’s decisions for the creator’s wallet to sign: a payout from a pool, a contest’s winning side (or opening it), where a held collectible goes. Name a decision from the spec’s "decisions" (or "contest:<key>" / "hold:<key>") and its details; returns the studio link whose Economy tab shows it with the economy’s checks (the amount within the spec, the pool can cover it, a real receiver, the proof and caps the spec asks for) and a "Sign in my wallet" button. When the economy is live it also runs those checks now (`check`). A decision the spec gives the keeper ("signedBy": "keeper") is signed by the creator’s local keeper instead, once it is the game’s authority (npx gamesfun economy keeper). Never signs, never asks for a key. Returns { link, decision, says, signer, check }.',
    inputSchema: {
      type: 'object',
      required: ['decision'],
      properties: {
        game,
        decision: { type: 'string', description: 'A key from the spec’s decisions, or "contest:<key>" (name the winner), or "hold:<key>" (say where it goes).' },
        to: { type: 'string', description: 'The public wallet address that receives it (a payout, an award). Never a private key.' },
        amount: { type: ['string', 'number'], description: 'How much, in whole units of the pool’s token (instead of the decision’s own amount).' },
        percent: { type: 'number', minimum: 0, maximum: 100, description: 'A share of what the pool holds (instead of an amount).' },
        side: { type: 'integer', minimum: 0, maximum: 254, description: 'For a contest: the winning side, from 0.' },
        open: { type: 'boolean', description: 'For a contest: open a new round instead of naming a winner.' },
        asset: { type: 'string', description: 'For a hold: the held collectible’s address.' },
        attempt: { type: 'string', description: 'For a decision with proof: the signature of the transaction in which the receiver paid for the attempt.' },
        id: { type: 'string', description: 'The game’s own id for this result (a run, a match): each id is decided once.' },
      },
      additionalProperties: false,
    },
    async handler(input, ctx) {
      const gameDir = await gameDirOf(input, ctx);
      const { economy } = await load({ game: input.game }, ctx);
      const bad = findSecrets({ to: input.to, amount: input.amount, asset: input.asset, id: input.id });
      if (bad.length) throw new Error('That looks like a private key. A decision only ever needs a public address: never ask the creator for a key.');
      const request = readRequest({ decision: input.decision, to: input.to, amount: input.amount, percent: input.percent, side: input.side, open: input.open, asset: input.asset, attempt: input.attempt, id: input.id });
      const m = model(economy);
      const [kind, key] = input.decision.includes(':') ? input.decision.split(':') : ['decision', input.decision];
      let d;
      if (kind === 'decision') d = m.decisions.find((x) => x.key === key);
      else if (kind === 'contest' && m.contest.has(key)) d = input.open ? { key: input.decision, does: 'open_contest', contest: key, when: `opening “${m.contest.get(key).name}”` } : { key: input.decision, does: 'decide', contest: key, when: `naming who won “${m.contest.get(key).name}”` };
      else if (kind === 'hold' && m.hold.has(key)) d = { key: input.decision, does: 'award', hold: key, when: `saying where “${m.hold.get(key).name}”’s collectible goes` };
      if (!d) throw new Error(`No decision “${input.decision}” in the economy. It has: ${[...m.decisions.map((x) => x.key), ...m.contests.map((c) => `contest:${c.key}`), ...m.holds.map((h) => `hold:${h.key}`)].join(', ') || 'none'}.`);
      if (input.to !== undefined && !isAddress(input.to)) throw new Error('"to" must be a wallet’s public address.');
      if (input.amount !== undefined && !/^\d+(\.\d+)?$/.test(String(input.amount))) throw new Error('"amount" must be a number of whole units, like 0.5.');
      const contest = d.contest ? m.contest.get(d.contest) : null;
      if (d.does === 'decide') {
        if (input.side === undefined) throw new Error(`Say which side won: "side", from 0 to ${(contest?.sides ?? 2) - 1}.`);
        if (contest && input.side >= contest.sides) throw new Error(`“${contest.name}” has ${contest.sides} sides: "side" is 0 to ${contest.sides - 1}.`);
      }
      const pool = d.pool ? m.pool.get(d.pool) : null;
      const sym = pool ? m.tokens.get(pool.currency)?.symbol : '';
      const amount = input.amount ?? (input.percent === undefined ? d.amount : undefined);
      const percent = input.percent ?? (amount === undefined ? d.percent : undefined);
      const says =
        d.does === 'payout' ? `Pay ${amount !== undefined ? `${amount} ${sym}` : `${percent ?? 100}% of what it holds`} from the pool “${d.pool}” to ${input.to ?? d.to ?? '(say who: "to")'}`
        : d.does === 'decide' ? `Name side ${input.side}${contest?.sideNames?.[input.side] ? ` (${contest.sideNames[input.side]})` : ''} as the winner of “${contest?.name ?? d.contest}”`
        : d.does === 'open_contest' ? `Open a new round of “${contest?.name ?? d.contest}”`
        : d.does === 'award' ? `Send the held collectible to ${input.to ?? d.to ?? '(say where: "to")'}`
        : `${d.does} (${d.when})`;
      const params = linkParams({ ...request, ...(amount !== undefined ? { amount: String(amount) } : {}), ...(percent !== undefined ? { percent: String(percent) } : {}) });
      const { url, link } = await studioLink(gameDir, ctx, params);
      const keeper = d.signedBy === 'keeper';
      const signer = keeper ? `the creator’s local keeper (npx gamesfun economy keeper), once its key is the game’s authority${m.authority === 'owner' ? '; until then the creator’s wallet, from the page' : ''}` : m.authority === 'owner' ? 'the creator’s wallet' : `the authority key ${m.authority} (not the creator’s wallet: that key’s own machine signs, such as the local keeper)`;
      const live = Boolean(economy.live?.game);
      // Live: the same checks the page and the keeper run, read from the chain (refusals in plain words, with fixes).
      let checked = null;
      if (live) {
        try {
          const chain = await (ctx?.chain ?? chainContext(kitRoot(ctx), { env: envOf(ctx), ...(ctx?.fetchImpl ? { fetchImpl: ctx.fetchImpl } : {}) }));
          const ledger = await readLedger(ledgerFile(kitRoot(ctx), economy.live.game));
          const p = await prepareDecision({ economy, request, rpc: chain.rpc, signer: null, ledger, by: 'page' });
          checked = { ok: p.ok, says: p.says, refusals: p.refusals, notes: p.notes, numbers: p.numbers };
        } catch (error) {
          checked = { ok: null, error: `Could not read the chain: ${error.message}` };
        }
      }
      const checkText = checked?.refusals?.length ? `\nIt would be refused now: ${checked.refusals.map((r) => `${r.message} Fix: ${r.fix}`).join(' ')}` : checked?.error ? `\n${checked.error}` : '';
      return {
        link,
        url,
        decision: { ...params, does: d.does, when: d.when },
        signer,
        live,
        says: checked?.ok ? checked.says : says,
        check: checked,
        text: `${checked?.ok ? checked.says : says}. Signed by ${signer}.${live ? '' : ' The economy is not live yet: it has to go live (economy_publish) before any decision.'}${checkText}\nLink: ${link ?? `the studio’s Economy tab (start it with: npx gamesfun dev ${shownDir(gameDir, ctx)})`}, with ${new URLSearchParams(params).toString()}.\nThe creator opens it, reads the checks and signs in their wallet ("Sign in my wallet"): it is prepared, not signed.`,
      };
    },
  },
];

export default tools;
