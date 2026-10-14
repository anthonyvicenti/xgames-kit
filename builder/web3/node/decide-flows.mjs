// The two decision flows the creator approves in their wallet on the studio page (flow-engine.mjs runs them):
//   decide     one decision (decide.mjs prepareDecision), signed by the creator's wallet when it is the game's authority
//   authority  "Let my keeper decide" / "Take it back": one owner-signed update_game that names the game's authority
// What lands is written down: a decision in the game's ledger (.gamesfun/web3/decisions/<game>.jsonl), a new authority
// in gamesfun.json (economy.keys.authority, and live.published.keys so the next publish does not undo it).
import { isAddress } from '../gf-web3/chain/base58.js';
import { decodeLoot, LootAccount, updateGameIx } from '../gf-web3/chain/loot.js';
import { compileMessage, MAX_TRANSACTION_BYTES, signersOf, wireTransaction } from '../gf-web3/chain/tx.js';
import { explorerUrl } from '../gf-web3/network.js';
import { RuleError } from '../gf-web3/rules.js';
import { appendLedger, ledgerFile, prepareDecision, readLedger, readRequest } from './decide.mjs';
import { readEconomy } from './economy.mjs';
import { updateConfig } from './game.mjs';

const fail = (message) => {
  throw new RuleError(message);
};
const short = (a) => (a ? `${a.slice(0, 4)}…${a.slice(-4)}` : '');
export const refusalWords = (refusals) => refusals.map((r) => `${r.message}${r.fix ? ` Fix: ${r.fix}` : ''}`).join(' ');

/** One transaction from `payer`, signed now by the fresh keys among `signers`. */
export function decisionWire({ payer, blockhash, instructions, signers = [] }) {
  const message = compileMessage({ payer, blockhash, instructions });
  const wire = wireTransaction(message, signersOf(message).map((a) => signers.find((s) => s.address === a)?.sign(message)));
  if (wire.length > MAX_TRANSACTION_BYTES) throw new Error(`The decision’s transaction is ${wire.length} bytes; the limit is ${MAX_TRANSACTION_BYTES}.`);
  return wire;
}

/** Plain lines for the approval screen: the numbers, the notes. */
const linesOf = (p) => [...p.numbers.map(([k, v]) => `${k}: ${v}`), ...p.notes];

/**
 * Flow kind "decide": input is a request (decide.mjs readRequest). ctx: { gameDir, rpc, network, kitRoot }.
 * Refused up front, in plain words, when the economy's rules say no; checked again when the wallet is asked.
 */
export async function decideFlow(ctx, wallet, input) {
  const request = readRequest(input);
  const { economy } = await readEconomy(ctx.gameDir);
  if (!economy) fail('This game has no economy yet.');
  const ledgerPath = ledgerFile(ctx.kitRoot, economy.live?.game ?? 'not-live');
  const first = await prepareDecision({ economy, request, rpc: ctx.rpc, signer: wallet, ledger: await readLedger(ledgerPath), by: 'page' });
  if (!first.ok) fail(refusalWords(first.refusals));
  const state = { prepared: null, lastValidBlockHeight: null };
  return {
    kind: 'decide',
    title: first.says,
    lines: [`Decision “${first.decision.key}”: ${first.decision.when}.`, ...linesOf(first)],
    wallet,
    steps: [
      {
        title: first.says,
        async prepare() {
          const fresh = await readEconomy(ctx.gameDir);
          const p = await prepareDecision({ economy: fresh.economy, request, rpc: ctx.rpc, signer: wallet, ledger: await readLedger(ledgerPath), by: 'page' });
          if (!p.ok) fail(refusalWords(p.refusals));
          const { blockhash, lastValidBlockHeight } = await ctx.rpc.latestBlockhash();
          const wire = decisionWire({ payer: wallet, blockhash, instructions: p.instructions, signers: p.signers });
          await ctx.rpc.simulate(wire);
          state.prepared = p;
          state.lastValidBlockHeight = lastValidBlockHeight;
          return { kind: 'transactions', transactions: [wire], details: [`${p.says}.`, ...linesOf(p), 'Program: games.fun loot program 0.3, signed by you as the game’s authority.'] };
        },
        async complete(flow, answer) {
          const p = state.prepared;
          const signature = await ctx.rpc.send(answer.transactions[0]);
          await ctx.rpc.confirm(signature, { lastValidBlockHeight: state.lastValidBlockHeight });
          for (const k of p.signers) k.drop?.();
          await appendLedger(ledgerPath, { at: new Date().toISOString(), ...p.record, verdict: 'done', signature });
          return `${p.says}: ${explorerUrl(ctx.network, 'tx', signature)}`;
        },
      },
    ],
    onFinish: async (flow) => ({ decided: true, says: first.says, results: flow.results }),
  };
}

/**
 * Flow kind "authority": input { authority: <a wallet's public address> | "owner" }. The game's owner signs one
 * update_game; the spec then says the same (keys.authority), so the next publish keeps it.
 */
export async function authorityFlow(ctx, wallet, input = {}) {
  const want = String(input.authority ?? '').trim();
  if (want !== 'owner' && !isAddress(want)) fail('Name the new authority: a wallet’s public address (your keeper’s, from npx gamesfun economy keeper --new-key), or "owner" to take it back.');
  const { economy } = await readEconomy(ctx.gameDir);
  const gameAddress = economy?.live?.game;
  if (!gameAddress) fail('The economy is not live yet. Put it live first; the authority is set then.');
  const [account] = await ctx.rpc.accounts([gameAddress]);
  if (!account) fail(`The game ${short(gameAddress)} is not on devnet.`);
  const game = decodeLoot(LootAccount.Game, account.data);
  if (game.owner !== wallet) fail(`Only the game’s owner (${short(game.owner)}) can change who decides. Connect that wallet.`);
  const authority = want === 'owner' ? wallet : want;
  if (authority === game.authority) fail(want === 'owner' ? 'Your wallet already decides for this game.' : `${short(authority)} already decides for this game.`);
  const keeper = want !== 'owner';
  const title = keeper ? `Let ${short(authority)} decide for this game` : 'Take the decisions back: your wallet signs them again';
  const state = { lastValidBlockHeight: null };
  return {
    kind: 'authority',
    title,
    lines: keeper
      ? [`From now on the key ${authority} signs this game’s decisions (payouts, contest results, awards) instead of your wallet. The program checks that signature and nothing else; the caps and proof in the spec are the keeper’s own rules.`, 'You stay the owner: you can take it back at any time, with one approval.']
      : [`Your wallet ${short(wallet)} signs this game’s decisions again; the key ${short(game.authority)} can no longer pay out or decide anything.`],
    wallet,
    steps: [
      {
        title,
        async prepare() {
          const { blockhash, lastValidBlockHeight } = await ctx.rpc.latestBlockhash();
          state.lastValidBlockHeight = lastValidBlockHeight;
          const ix = updateGameIx({ owner: wallet, game: gameAddress, treasury: game.treasury, update: { authority } });
          const wire = decisionWire({ payer: wallet, blockhash, instructions: [ix] });
          await ctx.rpc.simulate(wire);
          return { kind: 'transactions', transactions: [wire], details: [`update_game on games.fun’s loot program 0.3: authority ${short(game.authority)} → ${short(authority)}. Nothing else changes.`, 'Your wallet pays the network fee only.'] };
        },
        async complete(flow, answer) {
          const signature = await ctx.rpc.send(answer.transactions[0]);
          await ctx.rpc.confirm(signature, { lastValidBlockHeight: state.lastValidBlockHeight });
          const keys = { authority: keeper ? authority : 'owner' };
          await updateConfig(ctx.gameDir, (c) => {
            if (!c.economy) return c;
            c.economy.keys = { ...(c.economy.keys ?? {}), ...keys };
            const live = (c.economy.live ??= {});
            live.authority = authority;
            if (live.published) live.published.keys = { ...(live.published.keys ?? {}), ...keys };
            live.transactions = [...(live.transactions ?? []), { signature, parts: ['game'] }].slice(-60);
            return c;
          });
          return `${keeper ? `${short(authority)} decides now` : 'Your wallet decides again'}: ${explorerUrl(ctx.network, 'tx', signature)}`;
        },
      },
    ],
    onFinish: async () => ({ authority }),
  };
}
