// games.fun host-join kit: the module Web Worker that hosts the room on the host player's machine.
// The room state, bot seats and every seat's inbox live only here. The host's page (gf-p2p.js) relays raw
// frames between this worker and the joiners' WebRTC data channels, and its own game client receives only
// the frames addressed to the host's seat ('local'), exactly like a joiner.
//
// Page → worker: {k:'init', roomUrl, botUrl, code, hostName, startMode, seed?, world?, maxSeats?, hostCid?}
//                {k:'attach', id} · {k:'in', id, text} · {k:'detach', id}   (id 'local' = the host's own seat)
//                {k:'start', fill, bots} · {k:'rematch'} · {k:'kick', playerId} · {k:'close', reason}
// Worker → page: {k:'out', id, text} (a frame for connection id) · {k:'hangup', id, reason}
//                {k:'lobby', lobby} · {k:'closed', reason} · {k:'fatal', error} · {k:'stats', stats}
import { HostRoom } from './host-engine.js';
import * as core from './sandbox-core.js';
import { seedRng } from './rng.js';

const BOT_DELAY_MS = 450;          // turn-based bots answer after a short, human-feeling pause (like room-do.js)
let host = null, t0 = 0, tickTimer = null, lastTick = 0, botTimer = null, sweepTimer = null;
const SWEEP_MS = 5000;             // 1.7.5: how often a seat gone past the grace (host.awayMs, a minute) is freed
const clock = () => Math.floor(performance.now() - t0);

function post(m) { self.postMessage(m); }

function scheduleBots() {
  if (!host || host.meta.tickHz > 0 || botTimer || !host.botsWaiting()) return;
  botTimer = setTimeout(() => { botTimer = null; if (host) { host.runBots(); scheduleBots(); } }, BOT_DELAY_MS);
}

function syncTick() {
  const want = host && !host.closed && host.started && !host.ended && host.meta.tickHz > 0;
  if (want && !tickTimer) {
    lastTick = clock();
    tickTimer = setInterval(() => {
      const now = clock(); const dt = Math.min(250, now - lastTick); lastTick = now;
      host.tick(dt);
      if (!host.started || host.ended || host.closed) syncTick();
    }, Math.round(1000 / host.meta.tickHz));
  } else if (!want && tickTimer) { clearInterval(tickTimer); tickTimer = null; }
}

// Messages are handled strictly in order (init awaits the room module import before anything else runs).
let queue = Promise.resolve();
self.onmessage = e => { queue = queue.then(() => handle(e.data || {})); };

async function handle(d) {
  try {
    if (d.k === 'init' && !host) {
      const [roomMod, botMod] = await Promise.all([import(d.roomUrl), import(d.botUrl)]);
      const seed = typeof d.seed === 'string' && d.seed ? d.seed.slice(0, 64) : Array.from(crypto.getRandomValues(new Uint32Array(4)), x => x.toString(36)).join('');
      t0 = performance.now();
      host = new HostRoom({
        room: roomMod.default, bot: botMod.default, core, seedRng, seed, code: d.code, hostName: d.hostName, startMode: d.startMode, botNames: Array.isArray(d.botNames) ? d.botNames : undefined, namePool: d.namePool && typeof d.namePool === 'object' ? d.namePool : undefined,
        world: d.world === true, maxSeats: d.maxSeats, hostCid: d.hostCid,     // a world room (gf-multiplayer 1.5.0)
        clock, wallClock: () => performance.now(),
        transmit: (id, text) => post({ k: 'out', id, text }),
        hangup: (id, reason) => post({ k: 'hangup', id, reason }),
        onEvent: ev => {
          if (ev.type === 'lobby') post({ k: 'lobby', lobby: ev.lobby });
          else if (ev.type === 'closed') { post({ k: 'closed', reason: ev.reason }); syncTick(); }
          else if (ev.type === 'error') post({ k: 'stats', stats: { ...host.stats } });
        },
      });
      host.open();
      sweepTimer = setInterval(() => { if (!host || host.closed) { clearInterval(sweepTimer); return; } host.sweep(); }, SWEEP_MS);
    } else if (!host) {
      return;
    } else if (d.k === 'attach') host.attach(String(d.id));
    else if (d.k === 'in') host.receive(String(d.id), d.text);
    else if (d.k === 'detach') host.detach(String(d.id), 'transport');
    else if (d.k === 'start') host.start({ fill: !!d.fill, bots: d.bots | 0 });
    else if (d.k === 'rematch') host.rematch();
    else if (d.k === 'kick') host.kick(String(d.playerId));
    else if (d.k === 'lock') host.lock(d.on === true);
    else if (d.k === 'close') host.close(d.reason || 'the host closed the game');
    else if (d.k === 'stats') post({ k: 'stats', stats: { ...host.stats, matches: host.matches, seats: host.players.length } });
    syncTick();
    scheduleBots();
  } catch (err) {
    post({ k: 'fatal', error: String(err?.message ?? err).slice(0, 300) });
  }
}
