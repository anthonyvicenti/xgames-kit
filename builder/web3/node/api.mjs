// The dev server's web3 API (mounted by builder/server/routes/web3.mjs under /api/web3): the studio's Economy tab reads
// the game's setup here, edit drafts, and run approvals. The server builds every transaction with the creator's own
// RPC; the creator's wallet signs in the studio page; the server checks what comes back and sends it. It never holds
// the creator's key.
import path from 'node:path';
import { LIMIT, RARITIES, RARITY_WEIGHTS, RuleError } from '../gf-web3/rules.js';
import { chainStatus, mintInfo } from './chain.mjs';
import { economyRoutes } from './economy-routes.mjs';
import { authorityFlow, decideFlow } from './decide-flows.mjs';
import { decideRoutes } from './decide-routes.mjs';
import { linkToken, removeBox, removeItem, saveBox, saveItem, setCurrency, setShop, unlinkToken } from './drafts.mjs';
import { createFlowEngine, FlowError } from './flow-engine.mjs';
import { economyStatus } from './economy.mjs';
import { economyFlow, launchFlow } from './flows.mjs';
import { gameTitle, listPictures, playerLooks, readConfig, readPicture } from './game.mjs';
import { handle, HttpError, readJson, sendBytes } from './http.mjs';
import { getRequest, listRequests, removeRequest } from './requests.mjs';
import { chainContext } from './settings.mjs';

const queryOf = (req) => new URL(req.url ?? '/', 'http://localhost').searchParams;

/**
 * The routes for one dev server. ctx: { gameDir, kitRoot, log }, plus fetchImpl/env/now for tests.
 * Returns { routes: [{ method, path, handler }], engine }.
 */
export function createWeb3Api(ctx) {
  const engine = ctx.engine ?? createFlowEngine(ctx.now ? { now: ctx.now } : {});
  const kitRoot = ctx.kitRoot ?? process.cwd();
  let chain = null;
  const chainCtx = async () => {
    // The dev server takes the network from the game's gamesfun.json (or GAMESFUN_NETWORK): devnet only here.
    if (ctx.network && ctx.network !== 'devnet') throw new HttpError(409, `The games.fun kit runs on devnet only; this game names ${ctx.network}.`);
    return (chain ??= await chainContext(kitRoot, { env: ctx.env ?? process.env, fetchImpl: ctx.fetchImpl }));
  };
  const gameDir = () => {
    if (!ctx.gameDir) throw new HttpError(409, 'Open a game first (gamesfun dev games/<name>).');
    return path.resolve(ctx.gameDir);
  };
  const env = async () => {
    const c = await chainCtx();
    return { gameDir: gameDir(), network: c.network, rpc: c.rpc, fetchImpl: ctx.fetchImpl };
  };

  async function state(req) {
    const dir = gameDir();
    const c = await chainCtx();
    const config = await readConfig(dir);
    let status = null;
    let chainError = null;
    if (queryOf(req).get('chain') !== '0') {
      try {
        status = await chainStatus(c.rpc, c.network, config, { pictureHash: async (p) => readPicture(dir, p).then((x) => x.sha256).catch(() => null) });
      } catch (error) {
        chainError = `Could not read the chain: ${error.message}`;
      }
    }
    return {
      network: {
        id: c.network.id,
        chain: c.network.chain,
        explorer: c.network.explorer,
        launch: {
          pairs: c.network.launchpad.pairs,
          defaultPair: c.network.launchpad.defaultPair,
          pairPrices: c.network.launchpad.pairPrices,
          split: c.network.launchpad.split,
        },
        currencies: c.network.currencies,
        playerFeeLamports: c.network.loot.playerFeeLamports,
        projectFeeLamports: c.network.loot.projectFeeLamports,
      },
      rpc: { shown: c.shown, custom: c.custom },
      game: { title: await gameTitle(dir), folder: path.basename(dir) },
      config,
      chain: status,
      chainError,
      looks: await playerLooks(dir),
      pictures: await listPictures(dir),
      requests: await listRequests(kitRoot, dir),
      flows: engine.list(),
      rules: { limits: LIMIT, rarities: RARITIES, weights: RARITY_WEIGHTS },
    };
  }

  /** The chain's counts for an item ({ issued, out }), so a draft edit can refuse to change what players own. */
  async function countsOf(id) {
    if (id === undefined || id === null || id === '') return {};
    const c = await chainCtx();
    const config = await readConfig(gameDir());
    if (!config.shop?.collection) return {};
    const status = await chainStatus(c.rpc, c.network, config).catch(() => null);
    const item = status?.shop?.items?.[Number(id)];
    return item ? { issued: item.issued, out: item.out } : {};
  }

  async function startFlow(req) {
    const body = await readJson(req);
    const e = await env();
    let request = null;
    if (body.requestId) {
      request = await getRequest(kitRoot, e.gameDir, body.requestId);
      if (!request) throw new HttpError(404, 'That request is gone.');
    }
    const kind = request?.kind ?? body.kind;
    const input = request?.input ?? body.input ?? {};
    let spec;
    if (kind === 'launch') spec = await launchFlow(e, input, body.wallet);
    // A game's shop is part of its economy (decision 2, 2026-10-11): the old "publish" starts the economy flow.
    else if (kind === 'economy' || kind === 'publish') spec = await economyFlow(e, body.wallet, input);
    // A decision (decide-flows.mjs): one the creator signs as the game's authority, or a new authority (the keeper).
    else if (kind === 'decide') spec = await decideFlow({ ...e, kitRoot }, body.wallet, input);
    else if (kind === 'authority') spec = await authorityFlow(e, body.wallet, input);
    else throw new HttpError(400, 'Unknown kind of request.');
    if (request) {
      const finish = spec.onFinish;
      spec.onFinish = async (flow) => {
        await removeRequest(kitRoot, request.id);
        return finish ? finish(flow) : null;
      };
    }
    return engine.start(spec);
  }

  const routes = [
    ...economyRoutes({ gameDir, log: ctx.log }),
    ...decideRoutes({ gameDir, kitRoot, env, log: ctx.log }),
    { method: 'get', path: '/state', handler: handle(state, ctx.log) },
    {
      method: 'get',
      path: '/picture',
      handler: handle(async (req, res) => {
        const picture = await readPicture(gameDir(), queryOf(req).get('path') ?? '');
        sendBytes(res, picture.contentType, picture.bytes);
      }, ctx.log),
    },
    { method: 'post', path: '/mint', handler: handle(async (req) => mintInfo((await chainCtx()).rpc, (await readJson(req)).mint, { network: (await chainCtx()).network }), ctx.log) },
    { method: 'post', path: '/token/link', handler: handle(async (req) => ({ config: await linkToken(await env(), await readJson(req)) }), ctx.log) },
    { method: 'post', path: '/token/unlink', handler: handle(async (req) => (await readJson(req), { config: await unlinkToken(await env()) }), ctx.log) },
    { method: 'post', path: '/shop/currency', handler: handle(async (req) => ({ config: await setCurrency(await env(), await readJson(req)) }), ctx.log) },
    { method: 'post', path: '/shop/settings', handler: handle(async (req) => ({ config: await setShop(await env(), await readJson(req)) }), ctx.log) },
    {
      method: 'post',
      path: '/item/save',
      handler: handle(async (req) => {
        const body = await readJson(req);
        return saveItem(await env(), body, await countsOf(body.id));
      }, ctx.log),
    },
    { method: 'post', path: '/item/remove', handler: handle(async (req) => ({ config: await removeItem(await env(), await readJson(req)) }), ctx.log) },
    { method: 'post', path: '/box/save', handler: handle(async (req) => saveBox(await env(), await readJson(req)), ctx.log) },
    { method: 'post', path: '/box/remove', handler: handle(async (req) => ({ config: await removeBox(await env(), await readJson(req)) }), ctx.log) },
    {
      method: 'post',
      path: '/request/dismiss',
      handler: handle(async (req) => {
        const { id } = await readJson(req);
        if (!(await getRequest(kitRoot, gameDir(), id))) throw new HttpError(404, 'That request is gone.');
        await removeRequest(kitRoot, id);
        return { dismissed: true };
      }, ctx.log),
    },
    { method: 'post', path: '/flow/start', handler: handle(startFlow, ctx.log) },
    {
      method: 'get',
      path: '/economy/status',
      handler: handle(async (req) => economyStatus(gameDir(), { ...(await env()), receipts: Number(queryOf(req).get('receipts') ?? 5) }), ctx.log),
    },
    {
      method: 'post',
      path: '/flow/prepare',
      handler: handle(async (req) => {
        const body = await readJson(req);
        return engine.prepare(body.flowId, body.wallet);
      }, ctx.log),
    },
    {
      method: 'post',
      path: '/flow/complete',
      handler: handle(async (req) => {
        const body = await readJson(req);
        return engine.complete(body.flowId, body);
      }, ctx.log),
    },
    { method: 'post', path: '/flow/cancel', handler: handle(async (req) => engine.cancel((await readJson(req)).flowId), ctx.log) },
    { method: 'get', path: '/flow', handler: handle(async (req) => engine.get(queryOf(req).get('id')), ctx.log) },
  ];
  return { routes, engine };
}

export { FlowError, RuleError };
