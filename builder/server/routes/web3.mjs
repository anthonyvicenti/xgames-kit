// The dev server's web3 routes, under /api/web3/… (docs/ARCHITECTURE.md, "Dev-server routes"). The handlers live in
// builder/web3/node/api.mjs; each checks its own boundary too (loopback, Host, Origin, JSON, body size) before anything runs.
//   GET  /state  /picture?path=  /flow?id=  /economy/status  /economy/decisions
//   POST /economy/decide/check  /economy/decide-request  (decisions, builder/web3/node/decide-routes.mjs)
//   POST /mint  /token/link  /token/unlink  /shop/currency  /shop/settings  /item/save  /item/remove
//        /box/save  /box/remove  /request/dismiss  /flow/start  /flow/prepare  /flow/complete  /flow/cancel
import { createWeb3Api } from '../../web3/node/api.mjs';

export default function register(router, ctx) {
  // ctx: { gameDir, kitRoot, network, log }. The network is always devnet here (builder/web3/gf-web3/network.js).
  const api = createWeb3Api(ctx);
  for (const route of api.routes) router[route.method](route.path, route.handler);
  return api;
}
