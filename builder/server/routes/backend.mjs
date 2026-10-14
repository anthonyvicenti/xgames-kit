// /api/backend/…: the studio's Backend tab (builder/studio/tabs/backend.js). All of it is builder/lib/backend/; this is its HTTP face.
//   GET  /status                       the game's backend (none is the default), the providers and their sign-ins
//   GET  /check                        the static checks (secrets, row-level security)
//   POST /use      {provider, url, key, players}   write the public settings the person's agent got
//   POST /request  {provider}          → {text}: the words the tab sends the person's session for the agent way
//   POST /disconnect {provider, fromGame}
//   POST /agents/remove                undo "Add Supabase to my agents" for this game (exactly what the kit added)
//   /<provider>/…                      a provider's own routes (builder/lib/backend/providers/<id>.mjs `routes`)
// Tokens and passwords are never logged here; an error is the library's sentence.
import { rm } from 'node:fs/promises';
import path from 'node:path';
import * as B from '../../lib/backend/index.mjs';
import { HttpError, openGame, readJson } from '../http.mjs';

export default function register(router, ctx) {
  // the open game is read at each request (the studio may open another while it runs)
  const game = () => openGame(ctx);
  const fail = e => { throw new HttpError(['NO_TOKEN', 'NO_APP'].includes(e.code) ? 409 : ['SECRET', 'NOT_PUBLIC'].includes(e.code) ? 422 : 400, e.message); };
  const wrap = fn => async (req, res, params) => { try { return await fn(req, res, params); } catch (e) { if (e instanceof HttpError) throw e; fail(e); } };

  router.get('/status', wrap(() => B.status(game())));
  router.get('/check', wrap(() => B.check(game())));
  router.post('/use', wrap(async req => {
    const b = await readJson(req, { limit: 16 * 1024 });
    const r = await B.use(game(), { provider: b.provider ?? 'supabase', url: b.url, key: b.key || null, players: b.players === 'none' ? 'none' : 'anonymous' });
    ctx.events.send('backend', { changed: true });
    return { settings: r.settings };
  }));
  router.post('/request', wrap(async req => {
    const b = await readJson(req, { limit: 1024 });
    return { text: B.agentRequest(b.provider ?? 'supabase', path.basename(game())) };
  }));
  router.post('/disconnect', wrap(async req => {
    const b = await readJson(req, { limit: 1024 });
    const r = await B.provider(b.provider ?? 'supabase').disconnect({});
    if (b.fromGame) {
      await B.config.remove(game());
      await rm(path.join(game(), ...B.CLIENT_IN_GAME), { recursive: true, force: true });
    }
    ctx.events.send('backend', { changed: true });
    return r;
  }));
  router.post('/agents/remove', wrap(async () => ({ agents: await B.mcp.removeFromAgents(game()) })));
  for (const p of B.PROVIDERS.values()) {
    try { p.routes?.(router, ctx, { HttpError, readJson, fail }); } catch (e) { ctx.log(`backend provider ${p.id}: its routes did not load: ${e.message}`); }
  }
}
