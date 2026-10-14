import { guard, parse, UsageError } from '../lib/cli.mjs';
import path from 'node:path';
import { isGame, resolveGame, shown } from '../lib/games.mjs';
import { openUrl } from '../lib/open.mjs';
import { forgetDevServer, recordDevServer } from '../lib/state.mjs';
import { startDevServer } from '../server/index.mjs';
import { onlineWords } from '../server/online.mjs';
import { devGodotGame, isGodotGame } from '../../runtimes/godot/gamesfun.mjs';

const usage = `Usage: gamesfun dev [dir] [--port <n>] [--no-open]

Open the studio on this machine (127.0.0.1 only). With no folder (and not run inside a game), it opens on the start
page: describe a new game, open one of yours in games/, or start from an example. With a game folder, it opens on that
game: the conversation with your agent session on the left, the game and its tools (slots, verify, any tabs in
studio/tabs/) on the right. Files reload as you (or your agent) save them. Two tabs on /game/gf/mp/ play together through the local
signaling server. A game on multiplayer kit 1.6.4 or newer opens its rooms online, so a friend on another machine can
join (docs/ONLINE.md); GAMESFUN_ONLINE=off keeps rooms on this machine, GAMESFUN_ONLINE=<https://…/signal/v1> uses a
signaling server of your own. Stop with Ctrl+C.
  --port <n>   that port exactly (default: the first free of 5180–5189, else any free port)
  --no-open    don't open a browser
The environment variables GAMESFUN_DEV_PORT=<n> and GAMESFUN_NO_OPEN=1 do the same when the options are not given
(a test machine sets them, so the one line runs unchanged without opening the person's browser).`;

/** The port and whether to open a browser, from the options, else the environment. */
export function devOptions(values, env = process.env) {
  const port = values.port ?? (/^\d{1,5}$/.test(env.GAMESFUN_DEV_PORT ?? '') ? env.GAMESFUN_DEV_PORT : null);
  const open = !values['no-open'] && !/^(1|true|yes|on)$/i.test(String(env.GAMESFUN_NO_OPEN ?? '').trim());
  return { port: port ? Number(port) : null, open };
}

export default {
  name: 'dev',
  summary: 'serve a game with the studio, live reload and local multiplayer',
  usage,
  run: args => guard(async () => {
    const { values, positionals } = parse(args, { port: { type: 'string' }, 'no-open': { type: 'boolean' } }, usage);
    if (values.port && !/^\d{1,5}$/.test(values.port)) throw new UsageError(`--port takes a number\n\n${usage}`);
    // a folder given, or the game this is run inside; else the start page (the person's games are listed there)
    const gameDir = positionals[0] ? await resolveGame(positionals[0]) : isGame(process.cwd()) ? path.resolve(process.cwd()) : null;
    const { port, open } = devOptions(values);
    const srv = await startDevServer({ gameDir, port, log: (...a) => console.log(...a) });
    const entry = { pid: process.pid, url: srv.url, port: srv.port, game: gameDir ? shown(gameDir) : null, gameDir, started: new Date().toISOString() };
    await recordDevServer(entry);
    const godot = gameDir && isGodotGame(gameDir) ? await devGodotGame(gameDir) : null;   // runtime godot: export on change
    const failed = srv.router.areas().filter(a => !a.ok);
    console.log(`gamesfun dev: ${gameDir ? shown(gameDir) : 'the start page (no game open: describe one, or open one of yours)'}`);
    console.log(`  studio   ${srv.url}studio/`);
    if (gameDir) {
      console.log(`  play     ${srv.url}game/                 (alone, with bots)`);
      console.log(`  friends  ${srv.url}game/gf/mp/           (Host here, open the invite link in another tab)`);
      console.log(`  online   ${onlineWords(await srv.online())}   (docs/ONLINE.md)`);
    }
    console.log(`  api      ${srv.router.areas().filter(a => a.ok).map(a => `/api/${a.area}`).join(', ')}`);
    for (const f of failed) console.log(`  routes   ${f.file} did not load: ${f.error}`);
    console.log('Live reload is on. Ctrl+C stops the server.');
    if (open) openUrl(`${srv.url}studio/`);
    await new Promise(resolve => {
      const stop = async () => { godot?.close(); await srv.close(); await forgetDevServer(process.pid).catch(() => {}); resolve(); };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
      process.once('SIGHUP', stop);
    });
    return 0;
  }),
};
