// Runs INSIDE a game's own isolate (loaded as a module by the Worker Loader), next to the AI-written
// game.js. Pure: no network, no storage, no clock. The outer layer (room-do.js) passes state in and
// gets {state, outbox, ended, kicks, rng} back, and re-checks everything this file checks: this file
// exists to give the module author clear errors, not to be trusted.
// Also imported directly by the Node unit tests.

export const LIMITS = Object.freeze({
  stateBytes: 64 * 1024,
  outbox: 64,
  messageBytes: 8 * 1024,
  maxPlayersCeiling: 16,
  tickHzCeiling: 30,
});

const HOOKS = new Set(['setup', 'onJoin', 'onLeave', 'onMessage', 'onTick']);

/** Validate and normalise the module's meta. Throws with an author-facing message. */
export function describe(game) {
  if (!game || typeof game !== 'object') throw new Error('room module must `export default { meta, setup, ... }`');
  if (typeof game.setup !== 'function') throw new Error('room module needs setup(api) returning the initial state');
  if (typeof game.onMessage !== 'function') throw new Error('room module needs onMessage(state, player, msg, api)');
  const m = game.meta ?? {};
  const minPlayers = int(m.minPlayers ?? 1, 'meta.minPlayers', 1, LIMITS.maxPlayersCeiling);
  const maxPlayers = int(m.maxPlayers ?? 2, 'meta.maxPlayers', minPlayers, LIMITS.maxPlayersCeiling);
  const tickHz = int(m.tickHz ?? 0, 'meta.tickHz', 0, LIMITS.tickHzCeiling);
  if (tickHz > 0 && typeof game.onTick !== 'function') throw new Error('meta.tickHz > 0 needs onTick(state, dtMs, api)');
  const name = typeof m.name === 'string' ? m.name.slice(0, 60) : 'untitled';
  if (m.rematch !== undefined && typeof m.rematch !== 'boolean') throw new Error('meta.rematch must be true or false');
  // rematch: api.end() records a match result but the room stays open (party games: "play again" with the same group).
  return { name, minPlayers, maxPlayers, tickHz, rematch: m.rematch === true, hooks: [...HOOKS].filter(h => typeof game[h] === 'function') };
}

/**
 * Run one hook.
 * @param game      the module's default export
 * @param hook      'setup' | 'onJoin' | 'onLeave' | 'onMessage' | 'onTick'
 * @param stateJson JSON string of the current state (null for setup)
 * @param args      hook arguments: { player?, msg?, dtMs? }
 * @param ctx       { rng: [a,b,c,d] uint32, now: ms since room start, players: [{id, name, connected}] }
 */
export function runHook(game, hook, stateJson, args, ctx) {
  try {
    if (!HOOKS.has(hook)) throw new Error(`unknown hook ${hook}`);
    const fn = game[hook];
    let state = stateJson == null ? undefined : JSON.parse(stateJson);
    const outbox = [];
    const kicks = [];
    let ended = null;
    const rng = sfc32(ctx.rng);
    const players = (ctx.players ?? []).map(p => ({ ...p }));
    const ids = new Set(players.map(p => p.id));
    const push = (to, msg) => {
      if (outbox.length >= LIMITS.outbox) throw new Error(`more than ${LIMITS.outbox} messages in one hook call`);
      if (!msg || typeof msg !== 'object' || Array.isArray(msg)) throw new Error('messages must be plain objects');
      const size = JSON.stringify(msg).length;
      if (size > LIMITS.messageBytes) throw new Error(`message of ${size} bytes is over ${LIMITS.messageBytes}`);
      outbox.push({ to, msg });
    };
    const api = Object.freeze({
      now: ctx.now ?? 0,
      players,
      random: () => rng.next(),
      randomInt: n => Math.floor(rng.next() * n),
      send(playerId, msg) { if (!ids.has(playerId)) throw new Error(`send to unknown player ${playerId}`); push(playerId, msg); },
      broadcast(msg, exceptId) { push(exceptId ? { except: exceptId } : '*', msg); },
      end(results) { ended = results && typeof results === 'object' ? results : {}; },
      kick(playerId, reason = 'kicked') { if (ids.has(playerId)) kicks.push({ playerId, reason: String(reason).slice(0, 80) }); },
    });

    let ret;
    if (hook === 'setup') ret = fn.call(game, api);
    else if (typeof fn !== 'function') ret = undefined;               // optional hook not implemented
    else if (hook === 'onTick') ret = fn.call(game, state, args.dtMs, api);
    else if (hook === 'onMessage') ret = fn.call(game, state, freeze(args.player), args.msg, api);
    else ret = fn.call(game, state, freeze(args.player), api);        // onJoin / onLeave

    if (ret && typeof ret.then === 'function') throw new Error(`${hook} must be synchronous (it returned a Promise)`);
    if (hook === 'setup') { if (ret === undefined) throw new Error('setup must return the initial state'); state = ret; }
    else if (ret !== undefined) state = ret;                           // hooks may mutate in place or return a new state

    const out = JSON.stringify(state ?? null);
    if (out.length > LIMITS.stateBytes) throw new Error(`state is ${out.length} bytes, over ${LIMITS.stateBytes}`);
    return { ok: true, state: out, outbox, ended, kicks, rng: rng.state() };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e).slice(0, 300) };
  }
}

/**
 * Run the game's bot (bot.js, shipped with every room module). A bot is a *client-side* player: it sees
 * only the messages its seat received, never the room state. Used by the room probe and to fill seats.
 *   act(mem, inbox, you, api) → a message object to send, or null.  mem is the bot's own JSON memory.
 */
export function runBot(bot, memJson, inbox, you, ctx) {
  try {
    if (!bot || typeof bot.act !== 'function') throw new Error('bot.js must `export default { act(mem, inbox, you, api) }`');
    const mem = memJson == null ? {} : JSON.parse(memJson);
    const rng = sfc32(ctx.rng);
    const api = Object.freeze({ now: ctx.now ?? 0, random: () => rng.next(), randomInt: n => Math.floor(rng.next() * n) });
    const msg = bot.act(mem, inbox, you, api);
    if (msg && typeof msg.then === 'function') throw new Error('bot.act must be synchronous');
    if (msg != null && (typeof msg !== 'object' || Array.isArray(msg))) throw new Error('bot.act must return a plain object or null');
    const out = JSON.stringify(mem);
    if (out.length > LIMITS.stateBytes) throw new Error('bot memory over 64 KB');
    if (msg != null && JSON.stringify(msg).length > 4096) throw new Error('bot message over 4 KB');
    return { ok: true, mem: out, msg: msg ?? null, rng: rng.state() };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e).slice(0, 300) };
  }
}

/** Values that must never appear in anything sent to playerId (bot.secrets, optional). Used by the leak check. */
export function runSecrets(bot, stateJson, playerId) {
  try {
    if (!bot || typeof bot.secrets !== 'function') return { ok: true, values: [] };
    const v = bot.secrets(JSON.parse(stateJson), playerId);
    if (!Array.isArray(v)) throw new Error('bot.secrets must return an array');
    // Strings only (≥ 2 chars): bare numbers would match everywhere. Encode numeric secrets as strings.
    return { ok: true, values: v.filter(x => typeof x === 'string' && x.length >= 2).slice(0, 100) };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e).slice(0, 300) };
  }
}

function sfc32([a, b, c, d]) {
  return {
    next() {
      a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
      let t = (a + b) | 0; a = b ^ (b >>> 9); b = (c + (c << 3)) | 0; c = (c << 21) | (c >>> 11);
      d = (d + 1) | 0; t = (t + d) | 0; c = (c + t) | 0;
      return (t >>> 0) / 4294967296;
    },
    state: () => [a >>> 0, b >>> 0, c >>> 0, d >>> 0],
  };
}

function int(v, name, min, max) {
  if (!Number.isInteger(v) || v < min || v > max) throw new Error(`${name} must be an integer ${min}..${max}`);
  return v;
}
function freeze(p) { return p ? Object.freeze({ ...p }) : p; }
