// games.fun host-join (peer-to-peer) multiplayer: the HOST ENGINE.
//
// Runs inside the host player's browser (a module Web Worker, see host-worker.js) and plays the platform's
// outer layer (research/multiplayer/runtime/src/room-do.js) for one match: the game's unchanged room.js and
// bot.js run through the platform's sandbox runner (runHook/runBot from runtime/src/sandbox/core.js, injected
// as `core`), with a seeded RNG and a room clock. Every seat, including the host's own, is a "connection" that
// exchanges JSON text frames with this engine; the engine never touches WebRTC, so the Node tests drive it
// with an in-memory transport.
//
// Pure: no DOM, no timers, no clock of its own; its one import is the word filter (./text-filter.js, kit 1.5.1). The caller supplies clock() (room time, api.now),
// wallClock() (for rate limits), transmit(connId, text) and hangup(connId, reason), and drives tick()/runBots().
//
// World rooms (gf-multiplayer 1.5.0, option `world`): a drop-in room with no rounds of seats. A hello may carry `cid`
// (the tab's 8-character id, stable across a handoff), which every player entry then carries; no resume tokens are
// issued; a seat whose connection closes is removed at once (its seat and its name are free for the next visitor);
// a hello past `maxSeats` connected seats is refused 'full'.
//
// Wire frames (JSON text). Seat → host:
//   {k:'hello', name, resume?, cid?}  first frame from a joiner (the host's own seat is bound by open())
//   {k:'send', data}               a game intent (gf.room.send), data = plain object ≤ 4 KB
//   {k:'name', name}               change this seat's name (gf.room.rename), any time; cleaned, preset-checked, unique
//   {k:'bye'}                      leaving on purpose
// Host → seat:
//   {k:'seat', you, resume, code}  seat reserved (keep `resume` to rejoin after a reload)
//   {k:'lobby', ...}               lobby/roster summary (names only) for the kit's lobby UI
//   {k:'welcome'|'players'|'msg'|'ended'|'error'|'closed', ...}   the gf.room events (same shapes as room-do.js)
//   {k:'renamed', name}            this seat's name as the room keeps it (after a name frame)
//   {k:'refused', reason, code}    join refused (full, ended, closed, bad token)
//   {k:'kicked', reason}
import { cleanSignText } from './text-filter.js';   // kit 1.5.1: the play host's own word filter (creator-studio/lib/world-text.mjs), byte for byte
export const P2P_LIMITS = Object.freeze({
  inboundBytes: 4096,          // one game message (the `data` of a send frame), same as the platform
  frameBytes: 4096 + 256,      // one raw inbound frame (envelope included)
  ratePerSec: 60, burst: 120,  // per connection token bucket
  dropsBeforeKick: 50,         // rate-limited frames before the connection is dropped
  badBeforeKick: 10,           // malformed frames before the connection is dropped
  errorBudget: 5,              // room-module (and bot) failures before the room closes
  stateBytes: 64 * 1024,
  outbox: 64,
  outMessageBytes: 8 * 1024 + 64,
  maxConns: 40,                // attached connections, seated or not
  botRoundsPerTrigger: 16,     // bot-to-bot chains per trigger (turn-based)
  nameChars: 24,
});

const BOT_NAMES = ['Ada', 'Bram', 'Cleo', 'Dex', 'Eve', 'Finn', 'Gus', 'Hana', 'Ivo', 'Juno', 'Kai', 'Lux', 'Mo', 'Nia', 'Oto'];

export class HostRoom {
  /**
   * @param {object} o
   * @param {object} o.room, o.bot       the game's room.js / bot.js default exports
   * @param {object} o.core              { describe, runHook, runBot } from runtime/src/sandbox/core.js
   * @param {(seed: string) => number[]} o.seedRng   runtime/src/rng.js seedRng
   * @param {string} o.seed              room seed
   * @param {string} [o.code]            room code (from signaling), shown in welcome
   * @param {string} [o.hostName]
   * @param {'lobby'|'live'} [o.startMode]  'lobby': seats gather, host presses Start (or fill with bots & start).
   *                                        'live': the room is open from the start, like the platform shell.
   * @param {() => number} o.clock       ms since the room started (api.now)
   * @param {() => number} [o.wallClock] ms, monotonic (rate limits); defaults to clock
   * @param {(connId: string, text: string) => void} o.transmit
   * @param {(connId: string, reason: string) => void} [o.hangup]   close a connection's transport
   * @param {() => string} [o.token]     resume-token generator
   * @param {(ev: object) => void} [o.onEvent]  host-side notices: {type:'lobby'|'closed'|'error', ...}
   * @param {string[]} [o.botNames]    names for platform bot seats (from the game's IP pack); defaults to BOT_NAMES
   * @param {{adjectives: string[], nouns: string[]}} [o.namePool]  preset-names mode: every human name must be
   *                                    '<adjective> <noun>' from these lists (no free text); anything else is replaced
   * @param {boolean} [o.world]         a world room (kit 1.5.0): see the top of this file
   * @param {number} [o.maxSeats]       world: the most connected seats (at most meta.maxPlayers)
   * @param {string} [o.hostCid]        world: the host tab's id
   */
  constructor(o) {
    this.room = o.room; this.bot = o.bot; this.core = o.core;
    this.meta = o.core.describe(o.room);
    this.seed = String(o.seed);
    this.rng = o.seedRng(this.seed);
    this.seedRng = o.seedRng;
    this.code = String(o.code ?? 'LOCAL').slice(0, 12);
    this.hostName = cleanName(o.hostName) || 'Host';
    this.startMode = o.startMode === 'live' ? 'live' : 'lobby';
    this.clock = o.clock; this.wallClock = o.wallClock ?? o.clock;
    this.transmitRaw = o.transmit; this.hangupRaw = o.hangup ?? (() => {});
    this.token = o.token ?? (() => globalThis.crypto.randomUUID());
    this.onEvent = o.onEvent ?? (() => {});
    const names = Array.isArray(o.botNames) ? o.botNames.map(cleanName).filter(Boolean).slice(0, 16) : [];
    this.botNames = names.length ? names : BOT_NAMES;
    const pool = o.namePool && typeof o.namePool === 'object' ? o.namePool : null;
    const words = a => Array.isArray(a) ? a.map(cleanName).filter(w => w && !/\s/.test(w)).slice(0, 200) : [];
    this.namePool = pool && words(pool.adjectives).length && words(pool.nouns).length ? { adjectives: words(pool.adjectives), nouns: words(pool.nouns) } : null;
    this.namesIssued = 0;
    this.world = o.world === true;
    this.maxSeats = Math.min(this.meta.maxPlayers, Number.isInteger(o.maxSeats) && o.maxSeats >= 1 ? o.maxSeats : this.meta.maxPlayers);
    this.hostCid = cleanCid(o.hostCid);
    this.state = null;
    this.players = [];            // seats: {id, name, bot?, host?, conn, connected, joined, resume, mem?, rng?, inbox?}
    this.conns = new Map();       // connId → {seat: id|null, tokens, last, drops, bad}
    this.nextSeat = 1;
    this.started = false;
    this.ended = null;            // non-rematch rooms: {results, at}
    this.matches = 0;
    this.closed = null;
    this.locked = false;          // the host locked the room: nobody new joins (gf-multiplayer 1.6.6; a seat's own resume still does)
    this.banned = new Set();      // browsers the host removed (their hello's bid), refused while this host runs the room (1.7.2)
    // A seat whose player has been gone this long is freed (gf-multiplayer 1.7.5; the creator, 2026-10-12: "Disconnected
    // players should just get removed from the lobby", "Lets make the grace period 1 minute"): sweep() removes it as the
    // host's Remove does, with no bar, so the game stops waiting for them. A rejoin within it keeps the seat.
    this.awayMs = Number.isFinite(o.awayMs) && o.awayMs > 0 ? o.awayMs : 60_000;
    this.stats = { hookCalls: 0, tickCalls: 0, errors: 0, botActs: 0, botIntents: 0, msgsIn: 0, msgsOut: 0, rejected: 0, rateDropped: 0, lastError: null };
  }

  get stateJson() { return this.state; }

  /** Run setup and seat the host on connection 'local'. */
  open() {
    this.#setup();
    const host = { id: `p${this.nextSeat++}`, name: this.#uniqueName(this.#policyName(this.hostName)), host: true, conn: 'local', connected: true, joined: false, resume: null };
    if (this.world && this.hostCid) host.cid = this.hostCid;
    this.players.push(host);
    this.conns.set('local', this.#limiter(host.id));
    this.#tx('local', { k: 'seat', you: host.id, resume: null, code: this.code, host: true });
    if (this.startMode === 'live') this.start({});
    else this.#lobby();
  }

  // ---------- transport side ----------

  /** A transport connection opened (a joiner's data channel). It must say hello before anything else. */
  attach(connId) {
    connId = String(connId);
    if (this.closed) { this.#tx(connId, { k: 'closed', reason: this.closed }); this.hangupRaw(connId, 'closed'); return false; }
    if (this.conns.size >= P2P_LIMITS.maxConns) { this.#tx(connId, { k: 'refused', reason: 'the host has too many connections', code: 'busy' }); this.hangupRaw(connId, 'busy'); return false; }
    this.conns.set(connId, this.#limiter(null));
    return true;
  }

  /** A raw inbound frame from a connection (untrusted text). */
  receive(connId, text) {
    const c = this.conns.get(connId);
    if (!c || this.closed) return;
    const now = this.wallClock();
    c.tokens = Math.min(P2P_LIMITS.burst, c.tokens + ((now - c.last) / 1000) * P2P_LIMITS.ratePerSec); c.last = now;
    if (c.tokens < 1) {
      c.drops++; this.stats.rateDropped++; this.stats.rejected++;
      if (c.drops >= P2P_LIMITS.dropsBeforeKick) this.#drop(connId, 'rate limit');
      return;
    }
    c.tokens -= 1;
    this.stats.msgsIn++;
    let f = null;
    if (typeof text === 'string' && text.length <= P2P_LIMITS.frameBytes) { try { f = JSON.parse(text, dropDangerousKeys); } catch { f = null; } }
    if (!f || typeof f !== 'object' || Array.isArray(f) || typeof f.k !== 'string') return this.#bad(connId, c, typeof text === 'string' && text.length > P2P_LIMITS.frameBytes ? 'message too large' : 'messages must be JSON objects');

    if (f.k === 'hello') return this.#hello(connId, c, f);
    if (f.k === 'bye') return this.detach(connId, 'left');
    if (f.k === 'name') return this.#rename(connId, c, f);
    if (f.k !== 'send') return this.#bad(connId, c, 'unknown frame');
    const p = c.seat && this.players.find(q => q.id === c.seat);
    if (!p) return this.#bad(connId, c, 'say hello first');
    const data = f.data;
    let size = Infinity;
    try { size = JSON.stringify(data).length; } catch {}
    if (!data || typeof data !== 'object' || Array.isArray(data) || size > P2P_LIMITS.inboundBytes) return this.#bad(connId, c, size > P2P_LIMITS.inboundBytes && size !== Infinity ? 'message too large' : 'messages must be JSON objects');
    if (!p.joined) { this.#tx(connId, { k: 'error', reason: 'the game has not started yet' }); return; }
    if (this.ended) { this.#tx(connId, { k: 'error', reason: 'match has ended' }); return; }
    this.#call('onMessage', { player: { id: p.id, name: p.name }, msg: data });
  }

  /** A transport connection closed (or the joiner said bye). The seat is kept for a rejoin. */
  detach(connId, why = 'disconnected') {
    const c = this.conns.get(connId);
    if (!c) return;
    this.conns.delete(connId);
    const p = c.seat && this.players.find(q => q.id === c.seat);
    if (p && p.conn === connId && this.world && !p.host) {
      // A world keeps no seat for a rejoin: the seat and the name are free for the next visitor at once.
      p.conn = null; p.connected = false;
      this.players = this.players.filter(q => q !== p);
      if (p.joined && !this.closed) {
        this.#broadcastFrame({ k: 'players', players: this.publicPlayers() });
        this.#call('onLeave', { player: { id: p.id, name: p.name } });
      }
      this.#lobby();
    } else if (p && p.conn === connId) {
      p.conn = null; p.connected = false; p.awayAt = this.clock();
      if (p.joined && !this.closed) {
        this.#broadcastFrame({ k: 'players', players: this.publicPlayers() });
        this.#call('onLeave', { player: { id: p.id, name: p.name } });
      }
      // Before the match starts, a joiner who leaves on purpose gives the seat back.
      if (!p.joined && why === 'left') this.players = this.players.filter(q => q !== p);
      this.#lobby();
    }
    if (why !== 'transport') this.hangupRaw(connId, why);
  }

  // ---------- host controls ----------

  /** Open the room to play: seat bots (fill), then welcome and onJoin every seated human (host first). */
  start({ fill = false, bots = 0 } = {}) {
    if (this.closed || this.started) return false;
    this.started = true;
    const humans = this.players.filter(p => !p.bot);
    const want = fill ? this.meta.maxPlayers - humans.length : Math.max(0, bots | 0);
    const n = Math.max(0, Math.min(this.meta.maxPlayers - humans.length, want));
    for (let i = 0; i < n; i++) this.#addBot();
    this.#joinAll();
    this.#lobby();
    return true;
  }

  /** Non-rematch games: start a new match with the same seats (fresh setup, everyone re-joins). */
  rematch() {
    if (this.closed || !this.started || !this.ended || this.meta.rematch) return false;
    this.ended = null;
    this.#setup();
    for (const p of this.players) { p.joined = false; if (p.bot) { p.mem = null; p.inbox = []; } }
    this.#joinAll();
    this.#lobby();
    return true;
  }

  /** Host kicks a seat (never its own). Since gf-multiplayer 1.7.2 (the creator, 2026-10-12: "Admin can kick") the
   *  browser it came from (its hello's bid) can't join again while this host runs the room. */
  kick(playerId, reason = 'removed by the host') {
    const p = this.players.find(q => q.id === playerId);
    if (!p || p.host || this.closed) return false;
    if (p.bid) this.banned.add(p.bid);
    this.#removeSeat(p, String(reason).slice(0, 80));
    return true;
  }

  /** Free the seats of players gone longer than awayMs (1.7.5); the worker calls it every few seconds. → how many. */
  sweep() {
    if (this.closed) return 0;
    const now = this.clock(), gone = this.players.filter(p => !p.host && !p.bot && !p.connected && p.awayAt != null && now - p.awayAt >= this.awayMs);
    for (const p of gone) this.#removeSeat(p, 'disconnected');
    return gone.length;
  }

  /** The host locks or unlocks the room (gf-multiplayer 1.6.6; the creator, 2026-10-11: "We cant lock it so others cant
   *  join"): while locked, a new hello is refused 'locked'; players already in, and a seat coming back, are not affected.
   *  A world is one shared room per game and is never locked. */
  lock(on) {
    if (this.world || this.closed) return false;
    this.locked = !!on;
    this.#lobby();
    return true;
  }

  /** The host leaves: the room ends for everyone (v1 has no host migration). */
  close(reason = 'the host closed the game') {
    if (this.closed) return;
    this.closed = String(reason).slice(0, 120);
    for (const connId of [...this.conns.keys()]) this.#tx(connId, { k: 'closed', reason: this.closed });
    for (const connId of [...this.conns.keys()]) if (connId !== 'local') this.hangupRaw(connId, 'closed');
    this.conns.clear();
    for (const p of this.players) { p.connected = !!p.bot; p.conn = null; }
    this.onEvent({ type: 'closed', reason: this.closed });
  }

  // ---------- clock ----------

  /** One room tick (meta.tickHz > 0): onTick, then every bot acts once. */
  tick(dtMs) {
    if (this.closed || !this.meta.tickHz || !this.started || this.ended) return;
    this.stats.tickCalls++;
    this.#call('onTick', { dtMs });
    this.runBots();
  }

  /** True when a turn-based bot has unread messages (the caller schedules runBots after a short pause). */
  botsWaiting() { return !this.closed && !this.ended && this.players.some(p => p.bot && p.joined && p.inbox.length); }

  runBots() {
    if (this.closed) return false;
    let any = false;
    for (let round = 0; round < P2P_LIMITS.botRoundsPerTrigger; round++) {
      let acted = false;
      for (const b of this.players) {
        if (!b.bot || !b.joined || this.closed || this.ended) continue;
        const inbox = b.inbox; b.inbox = [];
        if (!inbox.length && !this.meta.tickHz) continue;
        const res = this.core.runBot(this.bot, b.mem, inbox, b.id, { rng: b.rng, now: this.clock() });
        this.stats.botActs++;
        const bad = !res?.ok ? res?.error ?? 'no result'
          : res.msg != null && (typeof res.msg !== 'object' || Array.isArray(res.msg) || JSON.stringify(res.msg).length > P2P_LIMITS.inboundBytes) ? 'bad bot message' : null;
        if (bad) { this.#fail(`bot ${b.id}: ${bad}`); continue; }
        b.mem = res.mem; b.rng = res.rng;
        if (res.msg) { acted = any = true; this.stats.botIntents++; this.#call('onMessage', { player: { id: b.id, name: b.name }, msg: res.msg }); }
      }
      if (this.meta.tickHz || !acted) break;
    }
    return any;
  }

  // ---------- views ----------

  publicPlayers() {
    return this.players.filter(p => p.joined).map(p => ({ id: p.id, name: p.name, connected: p.connected, ...(p.bot ? { bot: true } : {}), ...(p.cid ? { cid: p.cid } : {}) }));
  }

  lobbyView() {
    return {
      code: this.code, started: this.started, ended: !!this.ended, closed: this.closed, startMode: this.startMode,
      meta: { name: this.meta.name, minPlayers: this.meta.minPlayers, maxPlayers: this.meta.maxPlayers, tickHz: this.meta.tickHz, rematch: this.meta.rematch },
      seats: this.players.map(p => ({ id: p.id, name: p.name, connected: p.connected, ...(p.bot ? { bot: true } : {}), ...(p.host ? { host: true } : {}), ...(p.cid ? { cid: p.cid } : {}) })),
      matches: this.matches, locked: this.locked,
      ...(this.world ? { world: true, maxSeats: this.maxSeats } : {}),
    };
  }

  // ---------- internals ----------

  #setup() {
    this.stats.hookCalls++;
    const res = this.core.runHook(this.room, 'setup', null, {}, { rng: this.rng, now: this.clock(), players: [] });
    const problem = !res?.ok ? res?.error ?? 'no result' : checkResult(res);
    if (problem) throw new Error(`room setup failed: ${problem}`);
    this.state = res.state; this.rng = res.rng;
  }

  // Preset-names mode: only '<adjective> <noun>' from the pool; anything else gets a generated name. Without a pool,
  // names are cleaned free text (the room module can still choose not to display them).
  #policyName(name) {
    const P = this.namePool;
    if (!P) return name;
    const [a, n, ...rest] = String(name).split(' ');
    if (!rest.length && P.adjectives.includes(a) && P.nouns.includes(n)) return name;
    const k = this.namesIssued++ * 7919 + this.players.length * 104729;
    return `${P.adjectives[k % P.adjectives.length]} ${P.nouns[Math.floor(k / P.adjectives.length) % P.nouns.length]}`;
  }

  // Two players never share a display name: "Sam", "Sam 2", "Sam 3" (bots keep their " (bot)" names).
  #uniqueName(name, except = null) {
    const taken = new Set(this.players.filter(p => p !== except).map(p => p.name));
    if (!taken.has(name)) return name;
    for (let i = 2; ; i++) { const cand = `${name.slice(0, P2P_LIMITS.nameChars - String(i).length - 1)} ${i}`; if (!taken.has(cand)) return cand; }
  }

  #hello(connId, c, f) {
    if (c.seat) return this.#bad(connId, c, 'already seated');
    if (this.world) return this.#worldHello(connId, c, f);
    const name = this.#uniqueName(this.#policyName(cleanName(f.name) || 'Player'));
    const resume = typeof f.resume === 'string' && f.resume.length <= 64 ? f.resume : null;
    if (resume) {
      const p = this.players.find(q => !q.bot && !q.host && q.resume === resume);
      if (!p) return this.#hello(connId, c, { ...f, resume: undefined });   // 1.7.5: a seat freed after the grace, or a made-up token: a new player
      if (p.conn && p.conn !== connId) {                        // a newer connection replaces the old one
        const old = p.conn; this.conns.delete(old);
        this.#tx(old, { k: 'closed', reason: 'replaced by a newer connection' }); this.hangupRaw(old, 'replaced');
      }
      c.seat = p.id; p.conn = connId; p.connected = true; delete p.awayAt;
      this.#tx(connId, { k: 'seat', you: p.id, resume: p.resume, code: this.code });
      if (p.joined) this.#welcome(p, true);
      else if (this.started) this.#join(p, false);
      this.#lobby();
      return;
    }
    const bid = cleanBid(f.bid);
    if (bid && this.banned.has(bid)) return this.#refuse(connId, 'the host removed you from this room', 'removed');
    if (this.ended) return this.#refuse(connId, 'this match has already ended', 'ended');
    if (this.locked) return this.#refuse(connId, 'the host has locked this room', 'locked');
    if (this.players.length >= this.meta.maxPlayers) return this.#refuse(connId, 'this room is full', 'full');
    const p = { id: `p${this.nextSeat++}`, name, conn: connId, connected: true, joined: false, resume: this.token() };
    if (bid) p.bid = bid;
    this.players.push(p);
    c.seat = p.id;
    this.#tx(connId, { k: 'seat', you: p.id, resume: p.resume, code: this.code });
    if (this.started) this.#join(p, false);
    this.#lobby();
  }

  // A world room's visitor: no resume token; a tab coming back (same cid) before its old connection was noticed gone
  // replaces its old seat, so no ghost holds a seat; past maxSeats connected seats, 'full'.
  #worldHello(connId, c, f) {
    const cid = cleanCid(f.cid);
    const old = cid && this.players.find(q => q.cid === cid && !q.host && !q.bot);
    if (old) {
      const conn = old.conn;
      if (conn) { this.#tx(conn, { k: 'closed', reason: 'replaced by a newer connection' }); this.detach(conn, 'replaced'); }
      else this.players = this.players.filter(q => q !== old);
    }
    const bid = cleanBid(f.bid);
    if (bid && this.banned.has(bid)) return this.#refuse(connId, 'the host removed you from this world', 'removed');
    if (this.closed || this.ended) return this.#refuse(connId, 'this world is not open', 'ended');
    if (this.players.filter(p => !p.bot).length >= this.maxSeats) return this.#refuse(connId, 'this world is full', 'full');
    const name = this.#uniqueName(this.#policyName(cleanName(f.name) || 'Player'));
    const p = { id: `p${this.nextSeat++}`, name, conn: connId, connected: true, joined: false, resume: null };
    if (cid) p.cid = cid;
    if (bid) p.bid = bid;
    this.players.push(p);
    c.seat = p.id;
    this.#tx(connId, { k: 'seat', you: p.id, resume: null, code: this.code });
    if (this.started) this.#join(p, false);
    this.#lobby();
  }

  // A seat changes its name (kit 1.4.0; creator 2026-10-08: "New users can't name before joining a room or change name
  // in a room before the game"). The same cleaning, preset pool and uniqueness as a hello. Everyone in the match gets the
  // new roster ('players'); the seat is told the name the room kept ('renamed').
  #rename(connId, c, f) {
    const p = c.seat && this.players.find(q => q.id === c.seat);
    if (!p) return this.#bad(connId, c, 'say hello first');
    const want = cleanName(f.name);
    if (!want) return this.#tx(connId, { k: 'renamed', name: p.name });
    const name = this.#uniqueName(this.#policyName(want), p);
    if (name !== p.name) {
      p.name = name;
      if (p.joined) this.#broadcastFrame({ k: 'players', players: this.publicPlayers() });
      this.#lobby();
    }
    this.#tx(connId, { k: 'renamed', name: p.name });
  }

  #joinAll() {
    // Humans first in seat order (the host is p1), then bot seats. Rooms must never make a bot the host.
    for (const p of this.players.filter(q => !q.bot)) if (p.connected) this.#join(p, false);
    for (const p of this.players.filter(q => q.bot)) this.#join(p, false);
  }

  #join(p, rejoin) {
    p.joined = true;
    if (!p.bot) this.#welcome(p, rejoin);
    else this.#broadcastFrame({ k: 'players', players: this.publicPlayers() });
    this.#call('onJoin', { player: { id: p.id, name: p.name, rejoin } });
  }

  #welcome(p, rejoin) {
    this.#tx(p.conn, { k: 'welcome', you: p.id, name: p.name, resume: p.resume, code: this.code,
      meta: { name: this.meta.name, minPlayers: this.meta.minPlayers, maxPlayers: this.meta.maxPlayers, tickHz: this.meta.tickHz },
      players: this.publicPlayers(), ended: this.ended?.results ?? null });
    this.#broadcastFrame({ k: 'players', players: this.publicPlayers() });
    if (rejoin) this.#call('onJoin', { player: { id: p.id, name: p.name, rejoin: true } });
  }

  #addBot() {
    const i = this.players.filter(p => p.bot).length;
    const id = `p${this.nextSeat++}`;
    this.players.push({ id, name: `${this.botNames[i % this.botNames.length]} (bot)`, bot: true, conn: null, connected: true, joined: false, resume: null, mem: null, rng: this.seedRng(`${this.seed}:bot:${id}`), inbox: [] });
  }

  #removeSeat(p, reason) {
    const wasJoined = p.joined;
    this.players = this.players.filter(q => q !== p);
    if (p.conn) { const conn = p.conn; this.conns.delete(conn); this.#tx(conn, { k: 'kicked', reason }); this.hangupRaw(conn, 'kicked'); }
    if (wasJoined) {
      this.#broadcastFrame({ k: 'players', players: this.publicPlayers() });
      this.#call('onLeave', { player: { id: p.id, name: p.name } });      // 1.7.2: the room drops a removed seat too
    }
    this.#lobby();
  }

  #call(hook, args) {
    if (this.closed) return false;
    this.stats.hookCalls++;
    const res = this.core.runHook(this.room, hook, this.state, args, { rng: this.rng, now: this.clock(), players: this.publicPlayers() });
    const problem = !res?.ok ? res?.error ?? 'no result' : checkResult(res);
    if (problem) { this.#fail(`${hook}: ${problem}`); return false; }
    this.state = res.state; this.rng = res.rng;

    for (const { to, msg } of res.outbox) {
      const text = JSON.stringify({ k: 'msg', data: msg });
      if (text.length > P2P_LIMITS.outMessageBytes) continue;
      for (const p of this.players) {
        if (!p.joined) continue;
        const hit = to === '*' || (typeof to === 'string' && to === p.id) || (to && typeof to === 'object' && to.except !== p.id);
        if (!hit) continue;
        if (p.bot) { p.inbox.push(msg); if (p.inbox.length > 200) p.inbox.shift(); }
        else if (p.connected && p.conn) this.#send(p.conn, text);     // ONLY the addressed seat's connection
      }
    }
    for (const { playerId, reason } of res.kicks) {
      const p = this.players.find(q => q.id === playerId);
      if (p && !p.host) this.#removeSeat(p, reason);
    }
    if (res.ended && this.meta.rematch) {
      this.matches++;
      this.#broadcastFrame({ k: 'ended', results: res.ended, match: this.matches });
      this.#lobby();
    } else if (res.ended && !this.ended) {
      this.matches++;
      this.ended = { results: res.ended, at: this.clock() };
      this.#broadcastFrame({ k: 'ended', results: res.ended });
      this.#lobby();
    }
    return true;
  }

  #fail(problem) {
    this.stats.errors++;
    this.stats.lastError = problem.slice(0, 300);
    this.onEvent({ type: 'error', problem: this.stats.lastError, count: this.stats.errors });
    this.#broadcastFrame({ k: 'error', reason: 'the room hit an error in its game code' });
    if (this.stats.errors >= P2P_LIMITS.errorBudget) this.close('game code failed too many times');
  }

  #bad(connId, c, reason) {
    c.bad++; this.stats.rejected++;
    this.#tx(connId, { k: 'error', reason });
    if (c.bad >= P2P_LIMITS.badBeforeKick) this.#drop(connId, 'too many malformed messages');
  }

  #drop(connId, reason) {
    if (connId === 'local') return;          // the host never disconnects itself for flooding its own worker
    this.#tx(connId, { k: 'kicked', reason });
    this.detach(connId, reason);
  }

  #refuse(connId, reason, code) {
    this.#tx(connId, { k: 'refused', reason, code });
    this.conns.delete(connId);
    this.hangupRaw(connId, code);
  }

  #lobby() {
    if (this.closed) return;
    const view = this.lobbyView();
    this.#broadcastFrame({ k: 'lobby', ...view });
    this.onEvent({ type: 'lobby', lobby: view });
  }

  #broadcastFrame(frame) {
    const text = JSON.stringify(frame);
    for (const [connId, c] of this.conns) if (c.seat) this.#send(connId, text);
  }
  #tx(connId, frame) { if (connId) this.#send(connId, JSON.stringify(frame)); }
  #send(connId, text) { this.stats.msgsOut++; try { this.transmitRaw(connId, text); } catch {} }
  #limiter(seat) { return { seat, tokens: P2P_LIMITS.burst, last: this.wallClock(), drops: 0, bad: 0 }; }
}

/** A tab's id (kit 1.5.0): 8 base-36 characters, else null. */
export function cleanCid(v) { return typeof v === 'string' && /^[a-z0-9]{8}$/.test(v) ? v : null; }
/** A browser's id (gf-p2p.js keeps one in localStorage): what a kick bars from coming back (1.7.2). */
export function cleanBid(v) { return typeof v === 'string' && /^[a-z0-9]{12}$/.test(v) ? v : null; }

export function cleanName(v) {
  if (typeof v !== 'string') return '';
  const plain = v.replace(/[\u0000-\u001f\u007f-\u009f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, P2P_LIMITS.nameChars);
  // kit 1.5.1: a name floats over a player's head for everyone, so it goes through the same filter as a sign's words
  // (slurs and strong profanity masked with '*'; the play-test of 2026-10-09 showed a slur name to every player).
  // A name with no letter or digit left (all masked, or only stars and dots) is no name: the caller falls back to 'Player'.
  if (!plain) return '';
  let kept;
  try { kept = (cleanSignText(plain).text.split('\n')[0] || '').slice(0, P2P_LIMITS.nameChars).trim(); } catch { kept = plain; }
  return /[\p{L}\p{N}]/u.test(kept) ? kept : '';
}

// Defence in depth against prototype pollution inside room modules (same as room-do.js).
function dropDangerousKeys(key, value) {
  return key === '__proto__' || key === 'constructor' || key === 'prototype' ? undefined : value;
}

/** The module's result is untrusted: re-check shape and limits (same checks as room-do.js). */
function checkResult(res) {
  if (typeof res.state !== 'string' || res.state.length > P2P_LIMITS.stateBytes) return 'state missing or over 64 KB';
  if (!Array.isArray(res.rng) || res.rng.length !== 4 || !res.rng.every(n => Number.isInteger(n) && n >= 0 && n <= 0xffffffff)) return 'bad rng state';
  if (!Array.isArray(res.outbox) || res.outbox.length > P2P_LIMITS.outbox) return 'outbox missing or over 64 messages';
  if (!Array.isArray(res.kicks) || res.kicks.length > 16) return 'bad kicks';
  if (res.ended != null) {
    if (typeof res.ended !== 'object') return 'bad end results';
    if (JSON.stringify(res.ended).length > 8192) return 'end results over 8 KB';
  }
  return null;
}
