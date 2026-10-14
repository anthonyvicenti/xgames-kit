// The Economy tab's decision routes (mounted under /api/web3 by api.mjs). Nothing here signs: the page's wallet signs
// through the flow engine (flow kinds "decide" and "authority", decide-flows.mjs), the keeper with its own key.
//   GET  /economy/decisions        { decisions, waiting: { contests, holds }, authority, owner, keeper, recent }
//   POST /economy/decide/check     { request, wallet? } → { ok, refusals, notes, says, numbers, decision, signer }
//   POST /economy/decide-request   { request } → the keeper's answer (409 when no keeper runs for this game)
// The last is where a decision request from the game arrives (from the page that hosts it, the same origin as these
// routes): it is a claim, and the keeper checks it (decide.mjs) before anything is signed.
import { decodeLoot, LootAccount } from '../gf-web3/chain/loot.js';
import { decisionsOf, ledgerFile, prepareDecision, readLedger, readRequest, waitingDecisions } from './decide.mjs';
import { readEconomy } from './economy.mjs';
import { handle, HttpError, readJson } from './http.mjs';
import { forwardToKeeper, keeperStatus } from './keeper.mjs';

/** ctx: { gameDir(), kitRoot, env() → { rpc, network }, log }. */
export function decideRoutes({ gameDir, kitRoot, env, log }) {
  const load = async () => {
    const { economy } = await readEconomy(gameDir());
    if (!economy) throw new HttpError(409, 'This game has no economy yet.');
    return economy;
  };
  const requestOf = (body) => {
    try {
      return readRequest(body.request ?? body);
    } catch (error) {
      throw new HttpError(400, error.message);
    }
  };
  return [
    {
      method: 'get',
      path: '/economy/decisions',
      handler: handle(async () => {
        const economy = await load();
        const { rpc } = await env();
        const keeper = await keeperStatus(kitRoot, gameDir());
        const out = { decisions: decisionsOf(economy), waiting: { contests: [], holds: [] }, authority: null, owner: null, keeper, recent: [] };
        if (!economy.live?.game) return out;
        const [account] = await rpc.accounts([economy.live.game]);
        if (account) {
          const g = decodeLoot(LootAccount.Game, account.data);
          Object.assign(out, { authority: g.authority, owner: g.owner });
        }
        out.waiting = await waitingDecisions({ economy, rpc }).catch(() => out.waiting);
        out.recent = (await readLedger(ledgerFile(kitRoot, economy.live.game))).slice(-12).reverse();
        return out;
      }, log),
    },
    {
      method: 'post',
      path: '/economy/decide/check',
      handler: handle(async (req) => {
        const body = await readJson(req);
        const request = requestOf(body);
        const economy = await load();
        const { rpc } = await env();
        const ledger = economy.live?.game ? await readLedger(ledgerFile(kitRoot, economy.live.game)) : [];
        const p = await prepareDecision({ economy, request, rpc, signer: body.wallet || null, ledger, by: 'page' });
        return { ok: p.ok, refusals: p.refusals, notes: p.notes, says: p.says, numbers: p.numbers, decision: p.decision ?? null, signer: p.authority ?? null, owner: p.owner ?? null, request };
      }, log),
    },
    {
      method: 'post',
      path: '/economy/decide-request',
      handler: handle(async (req) => forwardToKeeper(kitRoot, gameDir(), requestOf(await readJson(req))), log),
    },
  ];
}
