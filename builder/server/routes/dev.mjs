// /api/dev/…: the dev server itself (the MCP tool dev_status reads the same facts from .gamesfun/dev.json).
import { shown } from '../../lib/games.mjs';
import { kitsInfo } from '../index.mjs';

export default function register(router, ctx) {
  const started = new Date().toISOString();
  router.get('/status', async () => ({
    url: ctx.url, game: ctx.gameDir ? shown(ctx.gameDir) : null, studio: `${ctx.url}studio/`, play: `${ctx.url}game/`, friends: `${ctx.url}game/gf/mp/`,
    pid: process.pid, started, network: ctx.network, ...(await kitsInfo()),
  }));
}
