// mechanic: build (worlds, CONTRACT §9; research/worlds/PLAN.md). Place, break and paint blocks in a voxel world
// (kit/world/voxel), put up signs, and set off boom blocks; everything is shared with everyone in the world and saved
// on the play host. README.md beside this file has the whole of it; in short:
//
//   every copy   its own player's tools: the hotbar (blocks), break, paint, signs; the face under the cursor (or the
//                tap) is picked from the voxel grid; its own edits show at once and wait for the host's word
//   the host     the order of every edit: it checks each one again (bounds, the spawn square, the rate, the words on
//                a sign), numbers it, sends it to everyone, saves it (the world store, every saveEvery s and when the
//                tab goes), sets off the boom blocks, and catches up anyone who arrives (their own load from the play
//                host, then the room's edits it did not have)
//   a handoff    the host leaves: the new host saves what it has that the play host may not, and takes each guest's
//                unsaved tail (edits it never got) as new edits; nothing a player saw is lost unless every copy that
//                had it is gone in the same couple of seconds
//
// Net (ctx.net events, prefixed build:): e (an edit to the host), ed (accepted edits, in the room's order, to all),
// no (refused, with the cell as the host has it), sync (a copy arriving: the world seq it has and its unsaved tail),
// bulk (the room's edits it lacks), pop (a boom went off), reload (the world was restored: load it again).
//
// Watch then play (gf-multiplayer 1.6.0, research/watch/PLAN.md): a viewer gets 'ed', 'pop' and 'reload' like any
// guest, but can't ask the host to catch it up. So the streamer's copy puts the room's entries the play host may not
// have yet into each key frame (watchKey: the host's from its log, a guest's from its tail), and a viewer that tunes in
// loads the world as usual, polls the play host for what was saved since, then takes those entries (watchStart).
// Joining starts over as a guest does (watchEnd, then the usual sync).
import * as THREE from 'three';
import { check, createLimiter, createRoomLog, createFeed, craterCells, editId, tidyText, faceToward, paintable } from './logic.mjs';
import { cleanSignText } from '../../net/world-text.js';
import { createBuildUi, cubeIcon, signIcon } from './ui.js';

export const id = 'build';
export const examples = ['build houses with friends in a block world', 'a sandbox island anyone can change', 'paint and sign your builds'];

const D = {
  hotbar: [], reach: 7, rate: 8, burst: 20, paint: true, signs: true, boomFuse: 3, boomRadius: 2.6, boomCooldown: 10, boomPush: 8, boomChain: true,
  saveEvery: 2, pollEvery: 15, soundPlace: 'block-place', soundBreak: 'block-break', soundPaint: 'paint', soundSign: 'sign', soundFuse: 'fuse', soundBoom: 'boom', soundDenied: 'denied',
  highlight: '#ffffff', ghost: '#ffffff',
};
const num = (description, minimum, maximum) => ({ type: 'number', description, minimum, maximum });
export const params = {
  type: 'object', additionalProperties: true,
  properties: {
    hotbar: { type: 'array', items: { type: 'string' }, maxItems: 20, default: [], description: 'Block ids on the hotbar, in order (keys 1-9 and 0 pick the first ten). Empty: every block players may place' },
    reach: { ...num('How far a player reaches, in blocks from their head', 3, 14), default: D.reach },
    rate: { ...num('Edits a player may make per second (the host refuses more)', 1, 30), default: D.rate },
    burst: { ...num('Edits a player may make at once before the rate applies', 1, 60), default: D.burst },
    paint: { type: 'boolean', default: true, description: 'The paint tool' },
    signs: { type: 'boolean', default: true, description: 'Signs (the world needs a sign block: voxel.signBlock)' },
    boomFuse: { ...num('Seconds from placing a boom block to its pop', 0.5, 10), default: D.boomFuse },
    boomRadius: { ...num('Radius of a boom\'s crater, in blocks', 1, 5), default: D.boomRadius },
    boomCooldown: { ...num('Seconds before the same player can place another boom block', 0, 120), default: D.boomCooldown },
    boomPush: { ...num('How hard a boom pushes players near it (m/s)', 0, 20), default: D.boomPush },
    boomChain: { type: 'boolean', default: true, description: 'A boom inside a crater goes off at once' },
    saveEvery: { ...num('Seconds between the host\'s saves to the play host', 1, 10), default: D.saveEvery },
    pollEvery: { ...num('Seconds between the host\'s looks at the play host for other writers', 5, 120), default: D.pollEvery },
    soundPlace: { type: 'string', default: D.soundPlace }, soundBreak: { type: 'string', default: D.soundBreak }, soundPaint: { type: 'string', default: D.soundPaint },
    soundSign: { type: 'string', default: D.soundSign }, soundFuse: { type: 'string', default: D.soundFuse }, soundBoom: { type: 'string', default: D.soundBoom }, soundDenied: { type: 'string', default: D.soundDenied },
    highlight: { type: 'string', default: D.highlight, description: 'Colour of the outline round the block under the cursor' },
  },
};
const kebab = s => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
const vs = (name, label, type, extra = {}) => ({ id: `mechanic.build.${kebab(name)}`, label, group: 'mechanics', type, source: { pointer: `{base}/${name}` }, tier: 'advanced', facet: type === 'color' ? 'look' : 'gameplay', ...extra });
export const slots = [
  vs('reach', 'How far a player reaches', 'number', { tier: 'main', rank: 50, constraints: { min: 3, max: 14, unit: 'blocks' } }),
  vs('boomRadius', 'Boom crater size', 'number', { tier: 'main', rank: 51, constraints: { min: 1, max: 5, unit: 'blocks' } }),
  vs('boomFuse', 'Boom fuse', 'number', { constraints: { min: 0.5, max: 10, unit: 's' } }),
  vs('boomCooldown', 'Time between a player\'s booms', 'number', { constraints: { min: 0, max: 120, unit: 's' } }),
  vs('rate', 'Edits per second per player', 'number', { constraints: { min: 1, max: 30 } }),
  vs('highlight', 'Block outline colour', 'color', { rank: 30 }),
  vs('hotbar', 'Hotbar blocks', 'json', { rank: 52 }),
];

const REASON = {
  bounds: 'That is outside the world', floor: 'The bottom of the world stays', protected: 'The spawn square stays as it is',
  block: 'That block can only be found, not placed', tint: 'That can\'t be painted', unbreakable: 'That one won\'t break',
  same: null, text: 'A sign needs words', face: 'A sign hangs on a side', occupied: 'Someone is standing there', rate: 'Slow down a little',
  reach: 'Too far away', boom: 'Your next boom block is not ready yet', locked: 'This world is locked right now', bad: null,
};

export function create(ctx, params = {}) {
  const P = { ...D, ...params };
  let V = null, G = null, store = null, ui = null, seaT = 0;
  const T = { tool: 'place', slot: 0, color: 1 };
  let hotbar = [];                      // [{n (block number), id, label, icon}]
  let counter = 0, cid = 'solo';
  const pending = new Map();            // my edits waiting for the host: u → {e, old}
  const applied = new Set();            // edit ids this copy has applied (a handoff's tails are never applied twice)
  const appliedOrder = [];
  const limiter = createLimiter({ rate: P.rate, burst: P.burst });
  const lastBoom = new Map();           // player id → time of their last boom block
  const log = createRoomLog();          // the host's
  const feed = createFeed();            // a guest's
  const tail = [];                      // a guest's recent room entries [{r, e}] (its share of what may not be saved)
  let outbox = [], outT = 0, saveT = 0, pollT = 0, roomCode = null, wasHost = null, synced = false, enteredAt = null;
  const fuses = new Map();              // cell index → {x, y, z, at (ctx.time.now when it pops), mesh}
  const stats = { refusedBy: {}, placed: 0, broken: 0, painted: 0, signs: 0, booms: 0, refused: 0, sent: 0, accepted: 0, saved: 0, syncs: 0, bulkSent: 0, handoffs: 0, tailsTaken: 0, lastPick: null };
  const mark = () => ({ s: log.savedThrough, g: store?.seq ?? 0 });
  // Only a room saves (its host's copy). Alone, the game's bare page, is a practice copy: it loads the shared world and
  // keeps up with it, but nothing built there is saved, so nobody can change the world without being in it, seen by
  // everyone and counted in its 8 seats (play-test 2026-10-09: the bare page's edits reached the world with no author).
  const saves = () => store?.mode === 'server' && !!ctx.net.active;
  let shared = null;

  // ---- three.js: the outline round the picked block, the ghost where a block would go, fuses, debris ----
  const outline = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1.006, 1.006, 1.006)), new THREE.LineBasicMaterial({ color: P.highlight, transparent: true, opacity: 0.9, depthTest: true }));
  outline.visible = false; outline.renderOrder = 3; outline.name = 'build-outline';
  const ghost = new THREE.Mesh(new THREE.BoxGeometry(1.002, 1.002, 1.002), new THREE.MeshBasicMaterial({ color: P.ghost, transparent: true, opacity: 0.22, depthWrite: false }));
  ghost.visible = false; ghost.renderOrder = 2; ghost.name = 'build-ghost';
  const fuseGeo = new THREE.BoxGeometry(1.04, 1.04, 1.04);
  const fuseMat = new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0, depthWrite: false });
  const DEBRIS = 220, debris = new THREE.InstancedMesh(new THREE.BoxGeometry(0.16, 0.16, 0.16), new THREE.MeshStandardMaterial({ roughness: 0.9 }), DEBRIS);
  debris.count = 0; debris.frustumCulled = false; debris.name = 'build-debris';
  const bits = [];                      // {p, v, life, color}
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(1, 1, 1), tmp = new THREE.Vector3(), col = new THREE.Color();
  for (const o of [outline, ghost, debris]) ctx.assets?.tag?.(o, 'mechanic.build.highlight');

  // ---- helpers ----
  const now = () => ctx.time.now;
  const valueAt = (x, y, z) => G.get(x, y, z);
  const blockAt = (x, y, z) => G.block(x, y, z);
  const entryOf = b => V.table.list[b - 1] ?? null;
  const W = () => ({ size: G.size, floor: V.floor, protect: V.protect, table: V.table, signN: V.signN, get: valueAt });
  // Who stands in a cell. The author of an edit may build under their own feet in a jump (a pillar): their own copy lets
  // it through once their feet are 0.4 above the cell's floor, and lifts them onto the block; the host never refuses an
  // edit for its author's own body, which it sees a moment late (play-test 2026-10-09: a pillar jump needed ~330 ms timing).
  const occupiedBy = (x, y, z, author = null) => ctx.players.list().some(p => {
    if (!(p.owned || p.drawn)) return false;
    if (author !== null && p.id === author && (p !== ctx.me || p.position.y >= y + 0.4)) return false;
    const h = p.character?.height ?? 1.7, r = 0.3, f = p.position;
    return f.x + r > x && f.x - r < x + 1 && f.z + r > z && f.z - r < z + 1 && f.y + h > y + 0.05 && f.y < y + 1 - 0.05;
  });
  const mine = (x, y, z) => occupiedBy(x, y, z, ctx.me?.id ?? null);
  // one toast per reason at a time (a held click or a quick row of them says it once)
  const said = new Map();
  const say = reason => {
    const t = REASON[reason];
    if (t && now() - (said.get(reason) ?? -9) > 1.6) { ctx.ui.toast(t); said.set(reason, now()); }
    stats.refusedBy[reason] = (stats.refusedBy[reason] ?? 0) + 1;
    ctx.audio.play(P.soundDenied, { optional: true });
  };
  const remember = u => { applied.add(u); appliedOrder.push(u); if (appliedOrder.length > 80000) applied.delete(appliedOrder.shift()); };
  const textOf = s => cleanSignText(tidyText(s)).text;

  /** Show an edit on this copy (the world, effects, fuses). */
  function show(e, { local = false, from = null } = {}) {
    const [u, x, y, z, v, text, face] = e;
    const before = G.get(x, y, z);
    const old = V.apply(x, y, z, v, { text, face });
    if (u) remember(u);
    if (local) V.remeshNow(x, y, z);
    const b = v & 255, wb = before & 255;
    // effects: a break throws its block's bits; a boom block starts its fuse
    if (!b && wb) burst(x, y, z, wb, 7);
    if (b && b !== wb && entryOf(b)?.boom) startFuse(x, y, z);
    if ((!b || entryOf(b)?.boom !== true) && fuses.has(G.index(x, y, z))) stopFuse(G.index(x, y, z));
    if (!local && from !== null) {
      const at = { x: x + 0.5, y: y + 0.5, z: z + 0.5 };
      if (!b && wb) ctx.audio.play(P.soundBreak, { at, optional: true });
      else if (b && !wb) ctx.audio.play(entryOf(b)?.boom ? P.soundFuse : P.soundPlace, { at, optional: true, gainDb: -3 });
      else if (b && b === wb && (v >> 8) !== (before >> 8)) ctx.audio.play(P.soundPaint, { at, optional: true, gainDb: -4 });
    }
    return old;
  }

  // ---- the host: accept, refuse, send, save ----
  /** A player's edit (this copy's own: from 'self'; a guest's: their id), checked against the world as it is now. */
  function accept(e, from) {
    if (applied.has(e[0])) return null;
    const author = from === 'self' ? ctx.me?.id ?? null : from;
    const why = check(W(), e, { occupied: (x, y, z) => occupiedBy(x, y, z, author) });
    if (why) return why;
    const who = from === 'self' ? ctx.me.id : from;
    if (!limiter.take(who, now())) return 'rate';
    const b = e[4] & 255;
    if (b && entryOf(b)?.boom && !blockAt(e[1], e[2], e[3])) {
      if (now() - (lastBoom.get(who) ?? -1e9) < P.boomCooldown) return 'boom';
      lastBoom.set(who, now());
    }
    if (V.signN && b === V.signN) e = [e[0], e[1], e[2], e[3], e[4], textOf(e[5]), e[6]];
    if (from !== 'self') show(e, { from });
    adopt(e);
    stats.accepted++;
    return null;
  }
  /** An edit the room already showed (a handoff's tail): only the hard limits apply, so every copy ends up alike. */
  function takeFact(e) {
    if (!Array.isArray(e) || applied.has(e[0])) return false;
    const [, x, y, z, v] = e;
    const [sx, sy, sz] = G.size;
    if (!(x >= 0 && y >= (V.floor ?? 1) && z >= 0 && x < sx && y < sy && z < sz) || V.protectedAt(x, y, z)) return false;
    if ((v & 255) > V.table.list.length || (v >> 8) > V.table.paint.length) return false;
    if (V.signN && (v & 255) === V.signN) e = [e[0], x, y, z, v, textOf(e[5]), [0, 1, 4, 5].includes(e[6]) ? e[6] : 5];
    show(e, { from: 'fact' });
    adopt(e);
    stats.tailsTaken++;
    return true;
  }
  /** Into the room's log, to everyone, and to the play host: an edit this copy already shows. */
  function adopt(e) {
    const x = log.add(e);
    outbox.push([x.r, ...e]);
    if (saves()) store.queue([e]);
  }
  function refuse(e, why, to) {
    const [u, x, y, z] = e;
    const cur = valueAt(x, y, z), s = V.signs.get(G.index(x, y, z));
    if (to === 'self') revert(u, cur, s, why);
    else ctx.net.send('build:no', { u, x, y, z, v: cur, ...(s ? { t: s.text, f: s.face } : {}), r: why }, to);
  }
  /** Send what was accepted since the last frame, in messages under ~3.4 KB. */
  function flushOut() {
    if (!outbox.length) return;
    let batch = [], size = 0;
    const send = () => { if (batch.length) { ctx.net.send('build:ed', { l: batch, ...mark() }); stats.sent += batch.length; } batch = []; size = 0; };
    for (const x of outbox) { const n = JSON.stringify(x).length + 1; if (size + n > 3400) send(); batch.push(x); size += n; }
    send();
    outbox = [];
  }
  async function save() {
    if (!saves() || !store.queued || store.busy) return;
    const r = await store.flush();
    if (!r) return;
    for (const [u, g] of r.ok ?? []) log.saved(u, g);
    stats.saved += r.ok?.length ?? 0;
    // over the play host's rate: the same edits go again with a later save (its limits are per minute)
    const again = (r.refused ?? []).filter(([, why]) => why === 'rate').map(([u]) => log.get(u)?.e).filter(Boolean);
    if (again.length) { store.queue(again); saveT = -Math.min(20, 2 + again.length / 100); }
    const lost = (r.refused ?? []).filter(([, why]) => why !== 'rate');
    if (lost.length) console.warn(`gf-three build: the play host refused ${lost.length} edit(s): ${lost.slice(0, 3).map(x => x[1]).join(', ')}`);
    stats.serverRefused = (stats.serverRefused ?? 0) + lost.length;
    for (const e of r.others ?? []) fromStore(e);
    if (r.reset) reloadAll();
    if (shared && ctx.host) { shared.s = log.savedThrough; shared.g = store.seq; }
  }
  /** An edit some other writer saved (the operator, a host before this one): shown here and sent to the room. */
  function fromStore(se) {
    const [g, u, x, y, z, v, text, face] = se;
    if (applied.has(u)) return;
    const e = text !== undefined ? [u, x, y, z, v, text, face] : [u, x, y, z, v];
    show(e, { from: 'store' });
    if (ctx.host) { const r = log.add(e); log.saved(u, g); outbox.push([r.r, ...e]); }
  }
  async function poll() {
    if (store?.mode !== 'server') return;
    const r = await store.poll();
    if (r.reset) { reloadAll(); return; }
    for (const e of r.edits) fromStore(e);
  }

  // ---- every copy: my own edit ----
  function edit(x, y, z, v, extra = []) {
    const e = [editId(cid, counter++), x, y, z, v, ...extra];
    const why = check(W(), e, { occupied: mine });
    if (why) { say(why); stats.refused++; return false; }
    const b = v & 255, wb = blockAt(x, y, z);
    const kind = !b ? 'break' : V.signN && b === V.signN ? 'sign' : wb === b ? 'paint' : entryOf(b)?.boom ? 'boom' : 'place';
    if (kind === 'boom' && now() - (lastBoom.get(ctx.me.id) ?? -1e9) < P.boomCooldown) { say('boom'); return false; }
    if (ctx.host) {
      const r = accept(e, 'self');
      if (r) { say(r); stats.refused++; return false; }
      show(e, { local: true });
    } else {
      const old = show(e, { local: true });
      pending.set(e[0], { e, old });
      ctx.net.send('build:e', e, 'host');
      if (kind === 'boom') lastBoom.set(ctx.me.id, now());
    }
    const at = { x: x + 0.5, y: y + 0.5, z: z + 0.5 };
    const sound = { break: P.soundBreak, sign: P.soundSign, paint: P.soundPaint, boom: P.soundFuse, place: P.soundPlace }[kind];
    stats[{ break: 'broken', sign: 'signs', paint: 'painted', boom: 'placed', place: 'placed' }[kind]]++;
    ctx.audio.play(sound, { at, optional: true });
    // the body turns to the block and reaches for it; a block placed under my own feet (a pillar jump) lifts me onto it
    const me = ctx.me;
    if ((kind === 'place' || kind === 'boom') && entryOf(b)?.solid) {
      const f = me.position;
      if (f.x + 0.3 > x && f.x - 0.3 < x + 1 && f.z + 0.3 > z && f.z - 0.3 < z + 1 && f.y < y + 1 && f.y + (me.character?.height ?? 1.7) > y) me.controller?.teleport({ x: f.x, y: y + 1.01, z: f.z }, me.yaw, { keepCamera: true });
    }
    me.controller?.faceTo?.(Math.atan2(x + 0.5 - me.position.x, z + 0.5 - me.position.z), 0.45);
    me.act?.('interact', 0.3);
    return true;
  }
  function revert(u, v, s, why) {
    const p = pending.get(u); pending.delete(u);
    const e = p?.e;
    if (e) { V.apply(e[1], e[2], e[3], v, s ? { text: s.text, face: s.face } : {}); V.remeshNow(e[1], e[2], e[3]); }
    stats.refused++;
    if (why) say(why);
  }

  // ---- the room: who is host, arriving, handoffs ----
  function roomChanged() {
    // with friends, only once this copy is in the room (not on the world card, not mid-handoff)
    if (ctx.net.active && ctx.net.status !== 'in') return;
    const code = ctx.net.room?.code ?? null;
    const host = !!ctx.host;
    if (code === roomCode && host === wasHost) return;
    const first = wasHost === null;
    roomCode = code; wasHost = host; synced = false;
    if (!ctx.net.active) { synced = true; return; }
    if (host) becomeHost(first);
    else requestSync();
  }
  function becomeHost(first) {
    // a new room: a fresh log. What this copy shows that the play host may not have (the old room's unsaved tail, its
    // own edits the old host never answered) goes into the new room and out with the next save; the server drops any
    // edit id it already has.
    if (!first) stats.handoffs++;
    const mine = [...pending.values()].map(p => p.e);
    pending.clear();
    const unsaved = tail.filter(x => x.r > (shared?.s ?? 0)).map(x => x.e);
    log.reset(); feed.reset(); tail.length = 0;
    if (saves() && unsaved.length) store.queue(unsaved);
    for (const e of mine) adopt(e);
    if (shared) { shared.s = 0; shared.g = store?.seq ?? 0; }
    synced = true;
    // anything an earlier host saved that this copy never got
    poll();
  }
  async function requestSync() {
    // first what the play host has after what this copy loaded, then the room's own edits after that
    if (store?.mode === 'server') { const r = await store.poll(); if (r.reset) { reloadAll(); return; } for (const e of r.edits) fromStore(e); }
    const facts = tail.filter(x => x.r > (shared?.s ?? 0)).map(x => x.e);
    const mine = [...pending.values()].map(p => p.e);
    tail.length = 0; feed.reset();
    // facts: the old room's edits this copy saw (the new host may not have them); mine: my edits nobody answered yet
    const parts = [];
    for (let i = 0; i < facts.length; i += 40) parts.push({ t: facts.slice(i, i + 40) });
    for (let i = 0; i < mine.length; i += 40) parts.push({ p: mine.slice(i, i + 40) });
    if (!parts.length) parts.push({});
    parts.forEach((part, i) => ctx.net.send('build:sync', { g: store?.seq ?? 0, ...part, last: i === parts.length - 1 }, 'host'));
    stats.syncs++;
  }
  function onSync(d, from) {
    if (!ctx.host || !d) return;
    for (const e of Array.isArray(d.t) ? d.t : []) takeFact(e);
    for (const e of Array.isArray(d.p) ? d.p : []) { if (!isEditLike(e)) continue; const r = accept(e, from); if (r) refuse(e, r, from); }
    if (d.last === false) return;
    // then everything of the room's that its load from the play host did not have, in order, paced; `base` tells it
    // where the room's order picks up (the entries before are in its world already)
    const { base, list } = log.since(Number(d.g) || 0);
    sendBulk(from, list.map(x => [x.r, ...x.e]), base);
  }
  const isEditLike = e => Array.isArray(e) && typeof e[0] === 'string' && Number.isInteger(e[1]);
  function sendBulk(to, list, base = 0) {
    const chunks = [];
    let batch = [], size = 0;
    for (const x of list) { const n = JSON.stringify(x).length + 1; if (size + n > 3300) { chunks.push(batch); batch = []; size = 0; } batch.push(x); size += n; }
    chunks.push(batch);
    let i = 0;
    const next = () => {
      if (i >= chunks.length) return;
      ctx.net.send('build:bulk', { l: chunks[i], n: log.length, base, done: i === chunks.length - 1, ...mark() }, to);
      stats.bulkSent++; i++;
      if (i < chunks.length) setTimeout(next, 70);
    };
    next();
  }
  function ingest(list, m, base = 0) {
    const ready = [...(base ? feed.skipTo(base) : []), ...feed.ingest(list)];
    for (const x of ready) {
      const e = x.slice(1);
      tail.push({ r: x[0], e }); if (tail.length > 4000) tail.splice(0, 1000);
      if (pending.has(e[0])) { pending.delete(e[0]); V.apply(e[1], e[2], e[3], e[4], { text: e[5], face: e[6] }); remember(e[0]); continue; }
      if (applied.has(e[0])) continue;
      show(e, { from: 'host' });
    }
    if (m && store) store.seq = m.g ?? 0;
  }

  // ---- booms ----
  function startFuse(x, y, z) {
    const i = G.index(x, y, z);
    if (fuses.has(i)) return;
    const mesh = new THREE.Mesh(fuseGeo, fuseMat.clone()); mesh.position.set(x + 0.5, y + 0.5, z + 0.5); mesh.renderOrder = 2;
    ctx.assets?.tag?.(mesh, 'mechanic.build.highlight');
    ctx.scene.add(mesh);
    fuses.set(i, { x, y, z, at: now() + P.boomFuse, mesh, t0: now() });
  }
  function stopFuse(i) { const f = fuses.get(i); if (!f) return; f.mesh.removeFromParent(); f.mesh.material.dispose(); fuses.delete(i); }
  function pop(f) {
    const i = G.index(f.x, f.y, f.z);
    stopFuse(i);
    if (!ctx.host) return;
    const b = blockAt(f.x, f.y, f.z);
    if (!b || !entryOf(b)?.boom) return;
    stats.booms++;
    const cells = craterCells(W(), [f.x, f.y, f.z], P.boomRadius, { rnd: ctx.rng ?? Math.random });
    if (!cells.some(c => c[0] === f.x && c[1] === f.y && c[2] === f.z)) cells.unshift([f.x, f.y, f.z]);
    let k = 0;
    const chain = [];
    for (const [x, y, z] of cells) {
      const cb = blockAt(x, y, z);
      if (P.boomChain && cb && entryOf(cb)?.boom && !(x === f.x && y === f.y && z === f.z)) { chain.push([x, y, z]); continue; }
      const e = [`${cid}.b${(counter++).toString(36)}`, x, y, z, 0];
      show(e, { from: 'boom' }); adopt(e);
      k++;
    }
    ctx.net.send('build:pop', { x: f.x, y: f.y, z: f.z });
    popHere(f.x, f.y, f.z);
    for (const [x, y, z] of chain) { const j = G.index(x, y, z); const g = fuses.get(j); if (g) g.at = Math.min(g.at, now() + 0.15); else { startFuse(x, y, z); fuses.get(j).at = now() + 0.15; } }
    void k;
  }
  function popHere(x, y, z) {
    const at = { x: x + 0.5, y: y + 0.5, z: z + 0.5 };
    ctx.audio.play(P.soundBoom, { at, optional: true });
    burst(x, y, z, 0, 46, 9);
    // push my own player away (every copy pushes its own: fair play F6, a shove never knocks over)
    const me = ctx.me, d = tmp.set(me.position.x - at.x, me.position.y + 0.9 - at.y, me.position.z - at.z), dist = d.length();
    if (dist < P.boomRadius + 3 && me.controller) {
      const k = P.boomPush * (1 - dist / (P.boomRadius + 3)); d.normalize();
      me.push?.({ x: d.x * k, y: Math.max(2.5, d.y * k + 3), z: d.z * k });
    }
    if (dist < 14) shake = Math.max(shake, 0.35 * (1 - dist / 14));
  }
  let shake = 0;

  // ---- debris ----
  const avgColor = b => { const e = entryOf(b); return e?.avg ?? '#9a8f80'; };
  function burst(x, y, z, b, n = 8, speed = 4) {
    const c = b ? avgColor(b) : '#ffcf5a';
    for (let k = 0; k < n && bits.length < DEBRIS; k++) {
      const a = Math.random() * Math.PI * 2, up = Math.random();
      bits.push({ p: new THREE.Vector3(x + 0.2 + Math.random() * 0.6, y + 0.2 + Math.random() * 0.6, z + 0.2 + Math.random() * 0.6), v: new THREE.Vector3(Math.cos(a) * speed * (0.3 + Math.random() * 0.7), 2 + up * speed, Math.sin(a) * speed * (0.3 + Math.random() * 0.7)), life: 0.6 + Math.random() * 0.5, color: b ? c : (k % 3 ? '#ffcf5a' : '#5a5148'), s: 0.6 + Math.random() * 0.8 });
    }
  }
  function updateDebris(dt) {
    let n = 0;
    for (let i = bits.length - 1; i >= 0; i--) {
      const d = bits[i]; d.life -= dt;
      if (d.life <= 0) { bits.splice(i, 1); continue; }
      d.v.y -= 18 * dt; d.p.addScaledVector(d.v, dt);
      if (G.solidAt(Math.floor(d.p.x), Math.floor(d.p.y), Math.floor(d.p.z))) { d.p.y = Math.floor(d.p.y) + 1.02; d.v.multiplyScalar(0.3); d.v.y = Math.abs(d.v.y) * 0.3; }
    }
    for (const d of bits) {
      sc.setScalar(d.s * Math.min(1, d.life * 3));
      m4.compose(d.p, q, sc); debris.setMatrixAt(n, m4); debris.setColorAt(n, col.set(d.color)); n++;
    }
    debris.count = n; debris.instanceMatrix.needsUpdate = true; if (debris.instanceColor) debris.instanceColor.needsUpdate = true;
  }

  // ---- the operator restored the world: everyone loads it again ----
  async function reloadAll() {
    if (ctx.host) ctx.net.send('build:reload', {});
    await V.reload?.();
    log.reset(); feed.reset(); tail.length = 0; pending.clear(); outbox = [];
    for (const i of [...fuses.keys()]) stopFuse(i);
    ctx.ui.toast('The world was restored');
  }

  // ---- picking and the player's tools ----
  const ray = { from: new THREE.Vector3(), dir: new THREE.Vector3() };
  let pick = null;
  function updatePick() {
    pick = null;
    const r = ctx.me?.controller?.rig?.ray?.();
    if (!r || ui?.editing) return;
    ray.from.copy(r.from); ray.dir.copy(r.dir);
    const hit = V.pick(ray.from, ray.dir, 80);
    if (!hit) return;
    const head = { x: ctx.me.position.x, y: ctx.me.position.y + 1.5, z: ctx.me.position.z };
    const [x, y, z] = hit.cell;
    const far = Math.hypot(x + 0.5 - head.x, y + 0.5 - head.y, z + 0.5 - head.z) > P.reach + 0.5;
    const b = hit.v & 255, e = entryOf(b);
    // the cell a placed block goes in: in front of the face, or the plant's own cell
    const place = e?.kind === 'plant' ? [x, y, z] : [x + hit.normal[0], y + hit.normal[1], z + hit.normal[2]];
    pick = { cell: [x, y, z], normal: hit.normal, face: hit.face, v: hit.v, block: b, entry: e, place, far, sign: V.signN && b === V.signN };
  }
  function useTool(action) {
    held.swing = 1;
    if (!pick) return;
    if (pick.far) { say('reach'); return; }
    const [x, y, z] = pick.cell;
    if (action === 'secondary' || T.tool === 'break') { edit(x, y, z, 0); return; }
    if (pick.sign && T.tool !== 'paint') { editSign(pick.cell); return; }
    if (T.tool === 'paint') {
      if (!paintable(pick.entry)) { say('tint'); return; }
      const tint = T.color === 0 ? 0 : T.color;
      edit(x, y, z, (pick.v & 255) | (tint << 8));
      return;
    }
    const h = hotbar[T.slot]; if (!h) return;
    const [px, py, pz] = pick.place;
    if (V.signN && h.n === V.signN) {
      if (!P.signs) return;
      // a sign faces the side it was put on, or the player when it stands on top of a block
      const face = [0, 1, 4, 5].includes(pick.face) ? pick.face : faceToward([px, py, pz], ctx.me.position);
      const why = check(W(), ['', px, py, pz, h.n, 'x', face], { occupied: mine });
      if (why) { say(why); return; }
      ui.editSign('', text => { const t = textOf(text ?? ''); if (text === null || !t) return; edit(px, py, pz, h.n, [t, face]); });
      return;
    }
    edit(px, py, pz, h.n);
  }
  function editSign([x, y, z]) {
    const s = V.signs.get(G.index(x, y, z));
    if (!s) return;
    if (V.protectedAt(x, y, z)) { say('protected'); return; }
    ui.editSign(s.text, text => { if (text === null) return; const t = textOf(text); if (!t || t === s.text) return; edit(x, y, z, V.signN, [t, s.face]); });
  }
  const firstPerson = () => ctx.me?.controller?.rig?.state.mode === 'first';
  // the words under the crosshair: how to build, until the player has; in first person with the mouse not taken, always
  // how to take it (a click there only takes the mouse)
  function hintNow(fresh) {
    const inp = ctx.input;
    if (inp?.touch) return fresh ? 'Tap to build · hold to break' : null;
    if (firstPerson() && !inp?.aimFree && !inp?.locked) return 'Click to look around with the mouse';
    if (!fresh) return null;
    return firstPerson() && !inp?.aimFree ? 'Click to build · right click breaks · wheel: next block' : 'Click to build · right click breaks · drag to look';
  }
  function selectSlot(i) { if (i < 0 || i >= hotbar.length) return; T.slot = i; T.tool = 'place'; ui.select(i, 'place'); ui.say(hotbar[i].label); }
  function selectColor(i) { T.color = i; T.tool = 'paint'; ui.select(i, 'paint'); ui.say(i === 0 ? 'Wash off paint' : 'Paint'); }
  function setTool(t) {
    if (t === 'break') { T.tool = T.tool === 'break' ? 'place' : 'break'; ui.select(T.slot, T.tool); ui.say(T.tool === 'break' ? 'Break' : hotbar[T.slot]?.label ?? ''); }
    if (t === 'paint' && P.paint) { if (T.tool === 'paint') { T.tool = 'place'; ui.select(T.slot, 'place'); ui.say(hotbar[T.slot]?.label ?? ''); } else selectColor(T.color || 1); }
  }

  function updateHighlight() {
    if (!pick || ctx.me?.alive === false) { outline.visible = ghost.visible = false; return; }
    outline.visible = true;
    outline.position.set(pick.cell[0] + 0.5, pick.cell[1] + 0.5, pick.cell[2] + 0.5);
    const red = pick.far || V.protectedAt(...pick.cell);
    outline.material.color.set(red ? '#ff5a5a' : T.tool === 'paint' ? (V.table.paint[T.color - 1] ?? '#ffffff') : P.highlight);
    outline.material.opacity = pick.far ? 0.45 : 0.9;
    const placing = T.tool === 'place' && !pick.sign && hotbar[T.slot];
    if (placing && !pick.far) {
      const [x, y, z] = pick.place;
      const bad = !!check(W(), ['', x, y, z, hotbar[T.slot].n, ...(V.signN && hotbar[T.slot].n === V.signN ? ['x', 5] : [])], { occupied: mine });
      ghost.visible = true; ghost.position.set(x + 0.5, y + 0.5, z + 0.5);
      ghost.material.color.set(bad ? '#ff5a5a' : P.ghost); ghost.material.opacity = bad ? 0.18 : 0.22;
    } else ghost.visible = false;
  }

  // ---- what the player holds, in first person: the hotbar's block (painted while painting), a pick while breaking.
  // A child of the camera, small and close (inside the body's own reach, so it never pokes into a wall), lit by the
  // world's light where it is; it bobs as the player walks, swings on a click and dips when it changes. ----
  const held = { group: new THREE.Group(), mesh: null, key: '', swing: 0, dip: 0, phase: 0, last: null };
  held.group.name = 'held';
  function updateHeld(dt, playing) {
    const cam = ctx.camera, show = playing && !!V.heldMesh && firstPerson() && ctx.me?.local && ctx.me.alive !== false && !ctx.menu?.view && !ui?.editing;
    held.group.visible = !!show;
    if (!show || !cam) return;
    if (!cam.parent) ctx.scene.add(cam);
    if (held.group.parent !== cam) cam.add(held.group);
    const h = hotbar[T.slot];
    const key = T.tool === 'break' || !h ? 'pick' : T.tool === 'paint' ? `b${h.n}:${T.color}` : `b${h.n}`;
    if (key !== held.key) {
      if (held.mesh) { held.mesh.geometry.dispose(); held.mesh.removeFromParent(); }
      held.mesh = key === 'pick' ? V.heldMesh({ tool: 'pick' }) : V.heldMesh({ block: h.n | (T.tool === 'paint' && T.color ? T.color << 8 : 0) });
      if (held.mesh) {
        if (key === 'pick') { held.mesh.scale.setScalar(0.11); held.mesh.rotation.set(0.5, -0.4, -0.55); }
        else { held.mesh.scale.setScalar(0.085); held.mesh.rotation.set(0.32, 0.72, 0); }
        held.group.add(held.mesh);
      }
      if (held.key) held.dip = 1;
      held.key = key;
    }
    if (!held.mesh) return;
    // walking bob: from how fast the camera moves over the ground
    const p = cam.getWorldPosition(new THREE.Vector3());
    const speed = held.last && dt > 0 ? Math.min(8, Math.hypot(p.x - held.last.x, p.z - held.last.z) / dt) : 0;
    held.last = p;
    held.phase += speed * dt * 1.6;
    const bob = Math.min(1, speed / 5);
    held.swing = Math.max(0, held.swing - dt * 4.5); held.dip = Math.max(0, held.dip - dt * 4);
    const sw = Math.sin((1 - held.swing) * Math.PI) * (held.swing > 0 ? 1 : 0);
    held.group.position.set(0.15 + Math.cos(held.phase) * 0.006 * bob - sw * 0.03, -0.14 + Math.abs(Math.sin(held.phase)) * 0.008 * bob - held.dip * held.dip * 0.12 - sw * 0.02, -0.27 - sw * 0.04);
    held.group.rotation.set(-sw * 0.7, sw * 0.2, 0);
    held.mesh.updateWorldMatrix(true, false);
    const at = held.mesh.getWorldPosition(new THREE.Vector3());
    held.mesh.userData.relight?.(at.x, at.y, at.z);
  }

  return {
    id: 'build', interacts: true, aimed: false, stats,
    setup(c) {
      V = ctx.world.voxel;
      if (!V) throw new Error('gf-three build: needs a voxel world (config/world.json template "voxel")');
      G = V.grid; store = V.store;
      cid = ctx.net.active ? (ctx.net.you ?? 'p') : `s${Math.random().toString(36).slice(2, 8)}`;
      shared = ctx.shared.register('build', { s: 0, g: 0 });
      ctx.scene.add(outline, ghost, debris);
      ctx.input?.unmap?.(['KeyF', 'KeyJ', 'KeyQ', 'KeyK']);     // F is the shove; Q, J and K mean nothing here
      // the hotbar: the params' list, else every block a player may place
      const ids = P.hotbar?.length ? P.hotbar : V.table.list.filter(b => b.place && (b.kind !== 'sign' || P.signs)).map(b => b.id);
      const imgs = V.textureImages ?? {};
      hotbar = ids.map(id => V.table.byId.get(id)).filter(Boolean).map(b => ({ n: b.n, id: b.id, label: b.label,
        icon: b.kind === 'sign' ? signIcon(imgs[b.tex.side] ?? null) : cubeIcon(imgs[b.tex.top] ?? null, imgs[b.tex.side] ?? null) }));
      for (const b of V.table.list) b.avg = V.textureAverage?.(b.tex.side) ?? null;
      ui = createBuildUi(ctx, { blocks: hotbar, paint: V.table.paint, keys: !ctx.input?.touch, onSlot: selectSlot, onTool: setTool, onColor: selectColor });
      ui.select(0, 'place');
      // the host's tab going away: what it accepted and has not saved yet goes out at once (keepalive)
      addEventListener('pagehide', () => { if (ctx.host && saves()) store?.unload(); });
      void c;
    },
    update(dt) {
      if (!V) return;
      roomChanged();
      const playing = ctx.round?.phase === 'playing';
      // the hotbar is for playing: not over the home menu, the pause menu or a backdrop
      const showBar = playing && !ctx.menu?.view;
      if (ui && ui.root.style.display !== (showBar ? '' : 'none')) ui.root.style.display = showBar ? '' : 'none';
      // keys: 1-9 and 0 pick from the hotbar (colours while painting), X breaks, P paints, E changes a sign
      const inp = ctx.input;
      if (playing && inp && !ui.editing && !ctx.menu?.view) {
        // in the order the keys went down: P then 3 in one frame paints with colour 3, 3 then P picks block 3 and paints
        const keys = inp.keysPressed?.() ?? [...Array.from({ length: 10 }, (_, k) => `Digit${(k + 1) % 10}`), 'KeyX', 'KeyP'].filter(c => inp.keyPressed(c));
        for (const code of keys) {
          const d = /^Digit(\d)$/.exec(code);
          if (d) { const k = (Number(d[1]) + 9) % 10; if (T.tool === 'paint') { if (k <= V.table.paint.length) selectColor(k); } else selectSlot(k); }
          else if (code === 'KeyX') setTool('break');
          else if (code === 'KeyP') setTool('paint');
        }
        // the wheel picks the next block (or colour) where it does not zoom: the first-person camera
        const w = firstPerson() ? inp.wheel ?? 0 : 0;
        if (w) {
          const step = w > 0 ? -1 : 1;
          if (T.tool === 'paint') selectColor((T.color + step + V.table.paint.length + 1) % (V.table.paint.length + 1));
          else selectSlot((T.slot + step + hotbar.length) % hotbar.length);
        }
      }
      if (playing && ctx.me?.local && ctx.me.alive !== false) {
        updatePick();
        const acts = ctx.me.actions;
        if (!ui.editing) {
          if (acts?.primary?.pressed) useTool('primary');
          else if (acts?.secondary?.pressed) useTool('secondary');
          else if (acts?.interact?.pressed && pick?.sign && !pick.far) editSign(pick.cell);
        }
        // a first-time hint until the player has built something: the first thing anyone wonders in a new world
        const fresh = stats.placed + stats.broken + stats.painted + stats.signs === 0 && ctx.time.now - (enteredAt ??= ctx.time.now) < 45;
        const hint = hintNow(fresh);
        ctx.ui.prompt(pick?.sign && !pick.far && !ui.editing ? (ctx.input?.touch ? 'Tap the sign to change it' : 'E or click: change the sign') : hint, 'build');
      } else pick = null;
      updateHighlight();
      updateHeld(dt, playing);
      // out at sea under the water (over the fence on a pillar, say): back to a spawn after a moment, never stuck
      const me = ctx.me;
      if (playing && me?.owned && me.controller && V.seaAt?.(me.position.x, me.position.z) && me.position.y < V.water - 1.6) {
        if ((seaT += dt) > 1.5) { seaT = 0; const s = ctx.world.spawn(me.seat ?? 0); me.controller.teleport(s, s.yaw); ctx.ui.toast('Back to the island'); }
      } else seaT = 0;
      // fuses: flash faster as they burn; the host sets them off
      for (const f of [...fuses.values()]) {
        const left = f.at - now(), rate = left < 1 ? 14 : 6;
        f.mesh.material.opacity = 0.18 + 0.5 * Math.max(0, Math.sin((now() - f.t0) * rate));
        if (left <= 0) { if (ctx.host) pop(f); else if (left < -1.5) stopFuse(G.index(f.x, f.y, f.z)); }
      }
      updateDebris(dt);
      if (shake > 0) { shake = Math.max(0, shake - dt * 1.6); ctx.camera.position.x += (Math.random() - 0.5) * shake; ctx.camera.position.y += (Math.random() - 0.5) * shake; }
      // the host: send what it accepted, save on a timer, look for other writers now and then
      if (ctx.host) {
        flushOut();
        if ((saveT += dt) >= P.saveEvery) { saveT = 0; save(); }
        if ((pollT += dt) >= (ctx.net.active ? P.pollEvery : Math.min(P.pollEvery, 6))) { pollT = 0; poll(); }
      }
    },
    event(name, d, from) {
      if (!V) return;
      if (name === 'e' && ctx.host && Array.isArray(d)) { const r = accept(d, from); if (r) refuse(d, r, from); }
      else if (name === 'ed' && !ctx.host && d && Array.isArray(d.l)) ingest(d.l, d);
      else if (name === 'bulk' && !ctx.host && d && Array.isArray(d.l)) { ingest(d.l, d, Number(d.base) || 0); if (d.done) synced = true; }
      else if (name === 'no' && d && typeof d.u === 'string') revert(d.u, d.v ?? 0, typeof d.t === 'string' ? { text: d.t, face: d.f } : null, d.r);
      else if (name === 'sync') onSync(d, from);
      else if (name === 'pop' && d && !ctx.host) { stopFuse(G.index(d.x, d.y, d.z)); popHere(d.x, d.y, d.z); }
      else if (name === 'reload' && !ctx.host) reloadAll();
    },
    hostChanged(isHost) { void isHost; /* roomChanged() picks it up next frame, with the new room's code */ },
    /** The streamer: the room's entries a viewer's load from the play host may lack → {base, l: [[r, ...edit]]}. */
    watchKey() {
      if (!V || !ctx.net.active || ctx.net.status !== 'in') return null;
      let base, list;
      if (ctx.host) { const x = log.since(store?.seq ?? 0); base = x.base; list = x.list.map(y => [y.r, ...y.e]); }
      else { base = shared?.s ?? 0; list = tail.filter(y => y.r > base).map(y => [y.r, ...y.e]); }
      if (list.length > 400) { list = list.slice(-400); base = list[0][0] - 1; }      // a key frame stays small
      return { base, l: list };
    },
    /** A viewer tuning in: what the play host saved since this copy loaded, then the stream's unsaved entries. */
    watchStart(d) {
      if (!V || !d || !Array.isArray(d.l) || ctx.net.status === 'in') return;
      const base = Number.isInteger(d.base) && d.base > 0 ? d.base : 0;
      const list = d.l.filter(x => Array.isArray(x) && Number.isInteger(x[0]) && x[0] > base && typeof x[1] === 'string');
      feed.reset(); tail.length = 0;
      const go = () => { ingest(list, null, base); synced = true; };
      if (store?.mode === 'server') store.poll().then(r => { if (r.reset) reloadAll(); else for (const e of r.edits) fromStore(e); go(); }, go);
      else go();
    },
    /** A viewer joined: the room catches it up as it does any guest. */
    watchEnd() { feed.reset(); tail.length = 0; synced = false; },
    /** A viewer: the stream's room changed (its host left): the new room numbers its edits from 1 (play-test 1: the
     *  first block after a handoff never showed for viewers already watching). Its edits arrive after this, in order. */
    watchRoom() { if (ctx.net.status !== 'in') { feed.reset(); tail.length = 0; } },
    reset() { /* a world is never reset by a round */ },
    interactables: () => (pick?.sign && !pick.far ? [{ kind: 'sign', id: `sign:${pick.cell.join(',')}`, x: pick.cell[0] + 0.5, y: pick.cell[1], z: pick.cell[2] + 0.5, reach: P.reach, action: 'interact' }] : []),
    /** QA: the tools and the room's state. */
    observe: () => ({
      tool: T.tool, slot: T.slot, color: T.color, hotbar: hotbar.map(h => h.id), pick: pick ? { cell: pick.cell, normal: pick.normal, place: pick.place, block: pick.entry?.id ?? null, far: pick.far, sign: !!pick.sign } : null,
      saves: saves(), pending: pending.size, log: log.length, savedThrough: log.savedThrough, feed: feed.applied, synced, fuses: fuses.size, room: roomCode, host: !!ctx.host, ui: ui?.observe() ?? null, stats: { ...stats },
    }),
    /** QA and fixtures: make an edit as this copy's player would (x, y, z, block id or 0, {tint, text, face}). */
    edit(x, y, z, block, { tint = 0, text, face } = {}) {
      const n = block ? V.table.byId.get(block)?.n ?? 0 : 0;
      return edit(x, y, z, n ? n | (tint << 8) : 0, text !== undefined ? [tidyText(text), face ?? 5] : []);
    },
    dispose() { ui?.dispose(); outline.removeFromParent(); ghost.removeFromParent(); debris.removeFromParent(); for (const i of [...fuses.keys()]) stopFuse(i); },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// The part's manifest (tools/catalog.mjs MANIFEST lists the fields): what `create` composes and refuses by, what the
// catalog tells a pitch, the handlers and traps of the rules.js stub, and verify check 15's sign of life. The tools
// read it in Node; nothing in play does.
// ---------------------------------------------------------------------------------------------------------------------
export const manifest = {
  id, examples, params,
  describe: 'Place, break and paint blocks in a shared voxel world; signs and boom blocks; saved on the play host',
  // setup() throws without ctx.world.voxel
  needs: { parts: [], world: [{ id: 'voxel', why: 'it edits the voxel grid (config/world.json template "voxel")' }] },
  uses: ['shove'],
  owns: () => [
    { res: 'input.primary', why: 'a click uses the tool: places a block, paints, or opens a sign', free: 'the build tools are always on the click' },
    { res: 'input.secondary', why: 'a right click (a long press) breaks a block', free: 'the build tools are always on the right click' },
    { res: 'input.interact', shared: true, why: 'E changes the sign aimed at', free: 'set build params.signs to false' },
  ],
  state: { key: 'build', fields: { s: 'the room\'s last saved edit number', g: 'the world sequence the host has' } },
  events: [],
  sync: { owner: 'host', how: 'the host orders, checks and saves every edit; a copy shows its own edits at once and waits for the host\'s word' },
  note: [
    'A world game (round.mode "world", world.template "voxel"): the hotbar, placing, breaking, painting, signs and saving are all the kit\'s.',
    'rules.js has no round to run: use it for what this world adds, and make an edit as the player would with build.edit(x, y, z, block).',
    'Edits reach the shared world only in a room; the bare page alone is a practice copy.',
  ],
  stub: {
    as: 'build',
    worked: 'setup(ctx) { ctx.ui.toast(\'Build something together\'); }',
    traps: [
      'never write to the voxel grid from rules.js on a guest copy: every edit goes through the host (build.edit asks it)',
      'there are no rounds, scores, bots or results in a world: check(ctx) stays null',
    ],
  },
  signs: {
    // reported, never failed here: a world is judged by tools/verify-world.mjs, which builds and reloads
    reportOnly: true,
    sample: sh => (sh.build ? { build: [sh.build.s ?? 0, sh.build.g ?? 0] } : null),
    judge: v => {
      let lo = null, hi = null;
      for (const p of v.pages) for (const s of p.samples) { const b = s.sh?.build; if (!b) continue; const n = Math.max(b[0], b[1]); lo = lo === null ? n : Math.min(lo, n); hi = hi === null ? n : Math.max(hi, n); }
      v.add('the world is shared', hi === null ? 'note' : 'ok', 'shared.build (saved edit number, world sequence)', hi === null ? 'no world state on these pages (a world is judged by verify-world)' : hi > lo ? `edits went through (${lo} → ${hi})` : `the world is up at edit ${hi}; nobody built on these pages`);
    },
  },
};
