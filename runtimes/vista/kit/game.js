// gf-vista's game bridge (research/super-scenic/THIN_E2E.md, interface I2): the core's own fishing game
// (core/src/game/Game.js: rod, bites, the fight, the cooler, the buyer and the shop, fuel, the boat) driven by the
// kit, with the game's tables and words and none of upstream's interface or names.
//
//   const game = await createVistaGame(vista, tables, { saveKey, words })
//     vista    from kit/host.js createVista({ ui: false, ... })
//     tables   from kit/tables fill(spec.vista)
//     saveKey  the browser save's key (the game's own, never upstream's)
//     words    player-visible words (slots); English defaults in WORDS below
//   game.state()  → { money, cooler: { kg, capacity, count }, rod: 'away' | 'ready' | 'casting' | 'waiting' | 'bite' | 'fight' | 'landing',
//                     fight: { tension 0..1, band: [lo, hi], distance } | null, near: 'buyer' | 'shop' | 'boat' | null,
//                     catches: [{ species, name, kg, cm, value }], log: { <species>: { count, bestKg } } }
//                   added: cooler.value, fight.stamina, power (cast wind-up 0..1), panel, mode, fuel { litres, tank },
//                     sonar, prompt { key, text } (what the player can do now, in the game's words), vendors (names)
//   game.on(name, fn) → off()   names: 'bite' 'hooked' 'catch' 'lost' 'sold' 'bought' 'board' 'leave'; fn(data)
//                   added: 'panel' { panel: 'buyer' | 'shop' | 'cooler' | null, vendor } (E at a vendor, I/Tab, Esc,
//                     walking away), 'toast' { key, text } (the game layer's messages, in the game's words)
//   game.sell() → { sold, money }       game.buy(id) → { ok, why?, money }   (id 'fuel' fills the boat's tank)
//   game.dispose()
//   added: game.openPanel(name), game.closePanel(), game.tables, game.words, game.signs ({ texts, readback() })
//   islands (wave 3 track H, kit/islands.js; createVistaGame(…, { islands: [recipe | {name, recipe}, …] }), 1 to 5):
//     game.hop(i) → Promise<{ ok, why?, ms? }>   game.island() (the index)   game.islands() ([{ index, name }])
//     game.canHop(i) → { ok, why }   game.setGate(fn(to, info) → true | 'why' | { ok, why })   (rules.js: "buy the keys")
//     events 'hop-start' { from, to, name }, 'hop-done' { from, to, name, ms }, 'hop-refused' { to, why }
//     state().islands { index, count, name, label, next { index, name, distance, text }, refused { to, why }, trip }
//     friends: options decides() (this copy owns the shared world), ask(to) (a joiner's request to the host), seat();
//     game.trip.shared() → { i, s } for the host's world message, game.follow(i, s) on a joiner's copy
//   items (createVistaGame(…, { items: { keys: { name, price } } })): one-off things the shop sells besides the gear
//     (shop() lists them, buy(id) buys one); game.owns(id) for a gate
//
// How (no core edits): the tables go into the core's own table objects in place (FISH, FISH_IDS, UPGRADES), as the
// private pilot did; the save goes through a storage wrapper that maps the core's key to `saveKey`; the core's Game
// gets a small HUD adapter as its `hud`, so it never builds upstream's HUD, minimap or first-play guide, and every toast,
// panel and catch reaches this bridge instead of upstream's DOM; the stall signs (a texture of upstream's names) are
// painted over from the tables on a canvas. The core's Game reads its input (keyboard, mouse) exactly as before.
import { FISH, FISH_IDS } from '../core/src/game/FishTable.js';
import { UPGRADES } from '../core/src/game/Gear.js';
import { loadStallAssets, ATLAS } from '../core/src/game/StallKit.js';
import { generateMipmaps } from '../core/src/engine/gpu/Mipmaps.js';
import { GPU } from '../core/src/engine/gpu/GPU.js';
import { WORLD } from '../core/src/world/WorldLayout.js';
import { harbour, toWorld } from '../core/src/world/Place.js';
import { toCoreSpecies, toCoreUpgrades, fill } from './tables/index.js';
import { createTrip, WORDS as TRIP_WORDS } from './islands.js';
import { SAVE_KEY as CORE_SAVE_KEY } from '../core/src/game/GameState.js';

export const VERSION = '0.1.0-thin';
export const EVENTS = ['bite', 'hooked', 'catch', 'lost', 'sold', 'bought', 'board', 'leave', 'panel', 'toast', 'hop-start', 'hop-done', 'hop-refused'];

/** Every word the bridge shows or paints, by key (a game's config overrides any of them). */
export const WORDS = {
  currency: '$',
  rodOut: 'Rod out: hold the left mouse button to cast',
  rodAway: 'Rod away',
  onSand: 'Landed on the sand',
  missed: 'It took the bait and swam off',
  notYet: 'Not yet: wait until the float goes under',
  fishOn: 'Fish on!',
  snapped: 'Snap! The line broke',
  escaped: 'It threw the hook',
  lostIt: 'Lost it',
  noFuel: 'Out of fuel: buy fuel at the shop',
  noRoom: 'No room in the cooler: let it go',
  sold: 'Sold {count} fish for {money}',
  nothingToSell: 'Nothing to sell yet',
  bought: 'Bought: {name}',
  refuelled: 'Filled up: {litres} L',
  owned: 'You have that already',
  tooDear: 'Not enough money',
  boardTitle: 'TODAY WE BUY',
  shopLine: 'BAIT · TACKLE · FUEL',
  perKg: '/kg',
  // prompts (state().prompt)
  takeRod: 'Take out the rod',
  cast: 'Hold to wind up, release to cast',
  release: 'Release to cast',
  rodWaiting: 'Waiting for a bite (right-click reels in)',   // not `waiting`: the shared kit's own word ("Waiting for everyone…") would win in game.text
  nibble: 'Something is nibbling: wait for it to pull under',
  strike: 'Strike now!',
  reel: 'Hold to reel, let go when the line turns red',
  ease: 'Too much tension: let go!',
  reelingIn: 'Reeling in',
  talk: 'Talk to {name}',
  closePanel: 'Leave',   // not `leave`: the shared kit's own word
  board: 'Board the boat',
  helm: 'Take the helm',
  leaveHelm: 'Leave the helm (V: camera)',
  ashore: 'Step ashore',
  overboard: 'Jump overboard',
  ladder: 'Climb the ladder',
  item: 'Item',
  ...TRIP_WORDS,
};

// The player's own prompts (core/src/player/Player.js), by what they say, to the keys above (unlisted: not shown).
const PLAYER_PROMPTS = [[/^Board boat/, 'board'], [/^Take the helm/, 'helm'], [/^Leave helm/, 'leaveHelm'], [/^Step ashore/, 'ashore'], [/^Jump overboard/, 'overboard'], [/^Climb ladder/, 'ladder']];

// The core's toasts (Game.js), by what they say, to the keys above. A toast not listed here is dropped, so no
// sentence of upstream's reaches the page by accident.
const TOASTS = [
  [/^Rod out/, 'rodOut'], [/^Rod away/, 'rodAway'], [/^Landed on the sand/, 'onSand'], [/^It took the bait/, 'missed'],
  [/^Not yet/, 'notYet'], [/^Fish on/, 'fishOn'], [/^Snap!/, 'snapped'], [/^It threw the hook/, 'escaped'],
  [/^Lost it/, 'lostIt'], [/^Out of fuel/, 'noFuel'], [/no room in the/, 'noRoom'],
];
const fmt = (s, o = {}) => String(s).replace(/\{(\w+)\}/g, (m, k) => (k in o ? o[k] : m));

export async function createVistaGame(vista, tables, { saveKey = 'gf-vista', words = {}, islands = null, items = null, decides = () => true, ask = null, seat = () => 0, gate = null, arrive = 'aboard' } = {}) {
  const app = vista?.app, g = app?.game;
  if (!g) throw new Error('createVistaGame: the vista has no game (boot it with kit/host.js createVista)');
  if (!tables?.species) tables = fill(tables ?? {});
  const W = { ...WORDS, ...words };
  const money = n => `${W.currency}${Math.round(n)}`;
  const listeners = new Map();
  const emit = (name, data = {}) => { for (const fn of listeners.get(name) ?? []) { try { fn(data); } catch (e) { console.error(`vista game: a '${name}' listener failed`, e); } } };
  const toast = (key, o) => emit('toast', { key, text: fmt(W[key] ?? key, o) });

  // ---- 1. the tables into the core's own objects, in place (every importer holds the same object)
  const species = Object.fromEntries(Object.entries(tables.species).map(([id, s]) => [id, toCoreSpecies(s)]));
  const display = g.display, slotByLook = { ...display.slot };   // CatchDisplay built one hanging fish per look
  for (const k of Object.keys(FISH)) delete FISH[k];
  Object.assign(FISH, species);
  FISH_IDS.length = 0;
  FISH_IDS.push(...Object.keys(species));
  for (const [id, s] of Object.entries(species)) display.slot[id] = slotByLook[s.model];
  const tracks = toCoreUpgrades(tables.gear);
  for (const k of Object.keys(UPGRADES)) delete UPGRADES[k];
  Object.assign(UPGRADES, tracks);
  const gearLevel = {};   // gear id → { track, index }
  for (const [track, t] of Object.entries(tracks)) t.levels.forEach((lv, i) => { if (lv.id) gearLevel[lv.id] = { track, index: i }; });

  // ---- 2. the save: the game's own key; a fresh state from the tables, then the game's save over it
  const st = g.state, CORE_KEY = CORE_SAVE_KEY;   // the core's key (GameState.js), mapped away, never written
  const store = (() => { try { return globalThis.localStorage ?? null; } catch { return null; } })();
  st.storage = store ? {
    getItem: k => store.getItem(k === CORE_KEY ? saveKey : k),
    setItem: (k, v) => store.setItem(k === CORE_KEY ? saveKey : k, v),
    removeItem: k => store.removeItem(k === CORE_KEY ? saveKey : k),
  } : null;
  st.money = Number(tables.economy.startMoney) || 0;
  st.inventory = [];
  st.log = {};
  st.upgrades = Object.fromEntries(Object.keys(UPGRADES).map(k => [k, 0]));
  st.fuel = null;
  st._nextId = 1;
  st.lastCatch = null;
  st.load();
  for (const k of Object.keys(UPGRADES)) st.upgrades[k] = Math.max(0, Math.min(UPGRADES[k].levels.length - 1, st.upgrades[k] | 0));
  for (const k of Object.keys(st.upgrades)) if (!UPGRADES[k]) delete st.upgrades[k];
  g.applyGear();
  st.emit();

  // ---- 3. the vendors: the tables' names and greetings
  const vendorOf = { buyer: g.stand.vendor, shop: g.chandlery.vendor };
  for (const [role, v] of Object.entries(vendorOf)) {
    const t = tables.vendors[role];
    v.name = t.name;
    v.greeting = t.greeting ?? '';
    v.idle = t.idle ?? '';
    v.group.name = 'Vendor:' + role;
  }
  const roleOf = v => (v === vendorOf.buyer ? 'buyer' : v === vendorOf.shop ? 'shop' : null);

  // ---- 4. the HUD adapter: the core's Game talks to it as it would to upstream's HUD
  let panel = null, power = 0, sonar = null, fuelRead = null;
  const hud = {
    standOpen: false, invOpen: false, catchOpen: false, vendor: null, portrait: null,
    toast(text) {
      const hit = TOASTS.find(([re]) => re.test(String(text)));
      if (hit) toast(hit[1]);
      if (hit?.[1] === 'missed') emit('lost', { why: 'missed' });
    },
    openStand(v) { api.openPanel(roleOf(v)); },
    closeStand() { if (panel === 'buyer' || panel === 'shop') api.closePanel(); },
    toggleInventory(force) { const on = force ?? panel !== 'cooler'; if (on) api.openPanel('cooler'); else if (panel === 'cooler') api.closePanel(); },
    showCatch() {}, hideCatch() {},
    update(o) { power = o.power ?? 0; sonar = o.sonar ?? null; fuelRead = o.fuel ?? null; },
  };
  g.hud = hud;              // set before the Game's first update: it never builds upstream's HUD, minimap or guide
  g.minimap = null;
  g.guide = null;

  // ---- 5. what happens, as events
  const addFish = st.addFish.bind(st);
  st.addFish = (id, kg, hour) => {
    const entry = addFish(id, kg, hour);
    const c = st.lastCatch;
    emit('catch', { species: id, name: FISH[id]?.name ?? id, kg: c.kg, cm: c.cm, value: c.value, kept: c.kept, record: c.record, newSpecies: c.newSpecies });
    if (!c.kept) toast('noRoom');
    return entry;
  };
  const updateFight = g.updateFight.bind(g);
  g.updateFight = (dt, reeling) => {
    const f = g.fight;
    updateFight(dt, reeling);
    if (f && !g.fight && f.state !== 'caught') emit('lost', { why: f.state, species: f.species });
    // the landed fish hangs on the line in the world for a moment (the core's own display); our HUD shows the card
    if (g.landing?.card) delete g.landing.card;
  };
  const cancelLine = g.cancelLine.bind(g);
  g.cancelLine = silent => { const f = g.fight; cancelLine(silent); if (f) emit('lost', { why: 'line-in', species: f.species }); };

  // ---- 5b. the islands (kit/islands.js): the trip runs inside the core's frame, after the game's own update
  const trip = islands ? createTrip(app, islands, { words: W, decides, ask, seat, gate, arrive, emit: (name, data) => {
    if (name === 'hop-start') api.closePanel();
    emit(name, data);
  } }) : null;

  // ---- 5c. one-off items the shop sells besides the gear (the boat keys a gate asks for); kept beside the save
  const ITEMS = items ?? {}, itemKey = `${saveKey}:items`;
  const owned = new Set((() => { try { return JSON.parse(store?.getItem(itemKey) ?? '[]'); } catch { return []; } })().filter(id => id in ITEMS));
  const saveItems = () => { try { store?.setItem(itemKey, JSON.stringify([...owned])); } catch {} };

  let prev = { bite: null, fight: false, mode: app.player.mode };
  const update = g.update.bind(g);
  g.update = dt => {
    update(dt);
    trip?.update(dt);
    const phase = g.bite?.phase ?? null;
    if (phase === 'take' && prev.bite !== 'take') emit('bite', {});
    const fighting = !!g.fight;
    if (fighting && !prev.fight) emit('hooked', { species: g.fight.species });
    const mode = app.player.mode, aboard = m => m === 'boat' || m === 'deck';
    if (aboard(mode) && !aboard(prev.mode)) emit('board', { mode });
    if (!aboard(mode) && aboard(prev.mode)) emit('leave', { mode });
    prev = { bite: phase, fight: fighting, mode };
  };

  // ---- 6. the stall signs: painted from the tables over upstream's texture
  const signs = await paintSigns(tables, W).catch(e => { console.error('vista game: the stall signs could not be painted', e); return { texts: [], readback: async () => null, error: String(e.message ?? e) }; });

  // ---- 7. where players begin
  placeStart(app, tables.start);

  const rodState = () => {
    const r = g.rod.state;
    if (r === 'stowed') return 'away';
    if (r === 'idle') return 'ready';
    if (r === 'windup' || r === 'flying') return 'casting';
    if (r === 'floating') return g.bite?.phase === 'take' ? 'bite' : 'waiting';
    if (r === 'retrieving') return 'waiting';
    if (r === 'fighting') return 'fight';
    if (r === 'landing') return 'landing';
    return 'away';
  };
  const nearOf = () => {
    const p = app.player;
    if (p.mode !== 'walk') return null;
    for (const [role, v] of Object.entries(vendorOf)) if (v.inRange(p.position)) return role;
    return p.nearBoat?.() ? 'boat' : null;
  };
  const promptOf = (rod, near) => {
    const p = app.player;
    if (near === 'buyer' || near === 'shop') return panel ? { key: 'E', text: W.closePanel } : { key: 'E', text: fmt(W.talk, { name: tables.vendors[near].name }) };
    const own = p.prompt && PLAYER_PROMPTS.find(([re]) => re.test(p.prompt.text));
    if (own) return { key: p.prompt.key, text: W[own[1]] };
    if (near === 'boat' && !g.rod.lineInWater) return { key: 'E', text: W.board };
    if (rod === 'away') return g.canFish ? { key: 'R', text: W.takeRod } : null;
    if (rod === 'ready') return { key: 'LMB', text: W.cast };
    if (rod === 'casting') return g.rod.state === 'windup' ? { key: 'LMB', text: W.release } : null;
    if (rod === 'bite') return { key: 'LMB', text: W.strike };
    if (rod === 'waiting') return g.rod.state === 'retrieving' ? { key: 'RMB', text: W.reelingIn } : g.bite?.phase === 'nibble' ? { key: '…', text: W.nibble } : { key: 'RMB', text: W.rodWaiting };
    if (rod === 'fight') return g.fight && g.fight.tension > g.fight.band[1] ? { key: 'LMB', text: W.ease } : { key: 'LMB', text: W.reel };
    return null;
  };

  const api = {
    VERSION, tables, words: W, signs,
    state() {
      const f = g.fight, rod = rodState(), near = nearOf();
      return {
        money: st.money,
        cooler: { kg: Math.round(st.holdKg * 100) / 100, capacity: st.stats.holdKg, count: st.inventory.length, value: st.holdValue },
        rod,
        fight: f ? { tension: f.tension, band: [...f.band], distance: f.distance, stamina: f.stamina } : null,
        near,
        catches: st.inventory.map(c => ({ id: c.id, species: c.species, name: FISH[c.species]?.name ?? c.species, kg: c.kg, cm: c.cm, value: c.value })),
        log: structuredClone(st.log),
        power, panel, mode: app.player.mode, sonar,
        fuel: { litres: st.fuelL, tank: st.stats.fuelL, reading: fuelRead },
        prompt: promptOf(rod, near),
        vendors: { buyer: tables.vendors.buyer.name, shop: tables.vendors.shop.name },
        islands: trip ? trip.state() : null,
        items: [...owned],
      };
    },
    on(name, fn) { const l = listeners.get(name) ?? new Set(); l.add(fn); listeners.set(name, l); return () => l.delete(fn); },
    /** Sell everything in the cooler at the buyer's prices. */
    sell() {
      const r = st.sell();
      if (r.count) {
        app.audio?.coin?.();
        toast('sold', { count: r.count, money: money(r.total) });
        emit('sold', { sold: r.count, total: r.total, money: st.money });
      } else toast('nothingToSell');
      return { sold: r.count, money: st.money, total: r.total };
    },
    /** Buy a gear piece by id (the tables' gear), or 'fuel' to fill the boat's tank as far as the money goes. */
    buy(id) {
      if (id === 'fuel') {
        const price = Number(tables.economy.fuelPrice) || 0, missing = st.stats.fuelL - st.fuelL;
        if (missing < 0.5) return { ok: false, why: 'full', money: st.money };
        const litres = price > 0 ? Math.min(missing, Math.floor(st.money / price)) : missing;
        if (litres <= 0) { toast('tooDear'); return { ok: false, why: 'money', money: st.money }; }
        st.money -= Math.ceil(litres * price);
        st.fuel = st.fuelL + litres >= st.stats.fuelL - 1e-3 ? null : st.fuelL + litres;
        g._fuelOut = false;
        st.save(); st.emit();
        app.audio?.coin?.();
        toast('refuelled', { litres: Math.round(litres) });
        emit('bought', { id, name: 'fuel', litres, money: st.money });
        return { ok: true, money: st.money, litres };
      }
      if (ITEMS[id]) {
        const it = ITEMS[id], price = Number(it.price) || 0;
        if (owned.has(id)) { toast('owned'); return { ok: false, why: 'owned', money: st.money }; }
        if (price > st.money) { toast('tooDear'); return { ok: false, why: 'money', money: st.money }; }
        st.money -= price;
        owned.add(id); saveItems();
        st.save(); st.emit();
        app.audio?.coin?.();
        toast('bought', { name: it.name });
        emit('bought', { id, name: it.name, kind: 'item', price, money: st.money });
        return { ok: true, money: st.money };
      }
      const at = gearLevel[id], item = tables.gear[id];
      if (!at || !item) return { ok: false, why: 'unknown', money: st.money };
      if ((st.upgrades[at.track] | 0) >= at.index) { toast('owned'); return { ok: false, why: 'owned', money: st.money }; }
      if (item.price > st.money) { toast('tooDear'); return { ok: false, why: 'money', money: st.money }; }
      st.money -= item.price;
      st.upgrades[at.track] = at.index;
      if (at.track === 'fuel') st.fuel = null;   // a new tank comes full
      st.save(); st.emit();
      app.audio?.coin?.();
      toast('bought', { name: item.name });
      emit('bought', { id, name: item.name, kind: item.kind, price: item.price, money: st.money });
      return { ok: true, money: st.money };
    },
    /** The shop's list: every gear piece with its price, whether it's owned and whether it's affordable now. */
    shop() {
      const own = Object.entries(ITEMS).map(([id, it]) => ({ id, name: it.name, kind: 'item', price: Number(it.price) || 0, owned: owned.has(id), affordable: (Number(it.price) || 0) <= st.money }));
      return own.concat(Object.entries(tables.gear).filter(([, it]) => it.price > 0).map(([id, it]) => {
        const at = gearLevel[id];
        return { id, name: it.name, kind: it.kind, price: it.price, owned: (st.upgrades[at.track] | 0) >= at.index, affordable: it.price <= st.money };
      }));
    },
    /** Whether this copy's player has bought the one-off item `id` (createVistaGame's `items`). */
    owns: id => owned.has(id),
    // ---- the islands
    trip,
    /** Sail to island i (the trip gate and the game's gate must pass; force: the game's gate only). */
    hop: (i, o) => (trip ? trip.hop(i, o) : Promise.resolve({ ok: false, why: 'one island' })),
    island: () => (trip ? trip.index : 0),
    islands: () => (trip ? trip.islands.map((it, index) => ({ index, name: it.name })) : []),
    canHop: i => (trip ? trip.canHop(i) : { ok: false, why: 'one island' }),
    setGate: fn => trip?.setGate(fn),
    follow: (i, s) => trip?.follow(i, s) ?? false,
    openPanel(name) {
      if (!['buyer', 'shop', 'cooler'].includes(name)) return;
      panel = name;
      hud.standOpen = name === 'buyer' || name === 'shop';
      hud.invOpen = name === 'cooler';
      hud.vendor = hud.standOpen ? vendorOf[name] : null;
      for (const v of Object.values(vendorOf)) v.talking = v === hud.vendor;
      if (document.pointerLockElement) document.exitPointerLock?.();   // the mouse is for the panel now
      emit('panel', { panel: name, vendor: hud.standOpen ? { role: name, name: tables.vendors[name].name, greeting: tables.vendors[name].greeting } : null });
    },
    closePanel() {
      if (!panel) return;
      panel = null;
      hud.standOpen = hud.invOpen = false;
      hud.vendor = null;
      for (const v of Object.values(vendorOf)) v.talking = false;
      emit('panel', { panel: null, vendor: null });
    },
    dispose() {
      trip?.dispose();
      listeners.clear();
      g.update = update; g.updateFight = updateFight; g.cancelLine = cancelLine; st.addFish = addFish;
      if (g.hud === hud) g.hud = null;
    },
  };
  return api;
}

/** Put the player at the tables' start: the pier head, the beach by the buyer (the core's own start), or aboard. */
export function placeStart(app, start = 'pier') {
  const p = app.player;
  if (app.freeCam) app.setFreeCam?.(false);
  if (start === 'boat') { p.mode = 'walk'; p.boardBoat(); return; }
  const at = start === 'beach' ? { x: WORLD.start.position.x, z: WORLD.start.position.z, yaw: WORLD.start.yaw }
    : (([x, z]) => ({ x, z, yaw: Math.PI + harbour().heading }))(toWorld(WORLD.pier.x, WORLD.pier.zEnd - WORLD.pier.headDepth / 2));   // the pier head, facing the sea (in the place's harbour frame)
  p.mode = 'walk';
  p.velocity.set(0, 0, 0);
  p.position.set(at.x, Math.max(app.terrainData.heightAt(at.x, at.z), app.colliders.groundHeightAt(at.x, at.z, 50)), at.z);
  p.yaw = at.yaw;
  p.pitch = -0.05;
  p.grounded = false;
}

// ---- the signs ------------------------------------------------------------------------------------------------
// The stall kit's sign atlas (core/public/models/props/signs.png, 2048 x 1024: the buyer's sign, the shop's sign and
// line, the price board, the scale's dial) carries upstream's names. It is painted again here from the tables, in the
// same regions (StallKit ATLAS), letters on transparent ground as the original, and written into the same texture.
const FONT = '"Trebuchet MS","Segoe UI","DejaVu Sans",system-ui,sans-serif';
export function drawSigns(tables, words = WORDS) {
  const W = 2048, H = 1024;
  const cv = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(W, H) : Object.assign(document.createElement('canvas'), { width: W, height: H });
  const c = cv.getContext('2d', { willReadFrequently: true });
  const texts = [];
  const rect = r => ({ x: r[0] * W, y: r[1] * H, w: (r[2] - r[0]) * W, h: (r[3] - r[1]) * H });
  const fit = (text, weight, size, maxW) => { let s = size; do { c.font = `${weight} ${s}px ${FONT}`; if (c.measureText(text).width <= maxW) break; s -= 4; } while (s > 20); return s; };
  const write = (text, x, y, { weight = 900, size = 150, maxW = 1800, color = '#f1ead6', align = 'center' } = {}) => {
    if (!text) return;
    fit(text, weight, size, maxW);
    c.fillStyle = color; c.textAlign = align; c.textBaseline = 'middle';
    c.fillText(text, x, y);
    texts.push(text);
  };
  const fish = (x, y, s, flip) => {   // a little painted fish either side of the buyer's sign
    c.save(); c.translate(x, y); c.scale(flip ? -s : s, s); c.fillStyle = '#e3a73c';
    c.beginPath(); c.ellipse(0, 0, 46, 22, 0, 0, Math.PI * 2); c.fill();
    c.beginPath(); c.moveTo(40, 0); c.lineTo(74, -26); c.lineTo(74, 26); c.closePath(); c.fill();
    c.restore();
  };
  // the buyer's sign
  const b = rect(ATLAS.joe);
  write(tables.vendors.buyer.sign ?? tables.vendors.buyer.name.toUpperCase(), b.x + b.w / 2, b.y + b.h * 0.5, { size: 150, maxW: b.w - 400 });
  fish(b.x + 150, b.y + b.h * 0.5, 1, false); fish(b.x + b.w - 150, b.y + b.h * 0.5, 1, true);
  // the shop's sign and its line
  const m = rect(ATLAS.marta);
  write(tables.vendors.shop.sign ?? tables.vendors.shop.name.toUpperCase(), m.x + m.w / 2, m.y + m.h * 0.36, { size: 130, maxW: m.w - 120 });
  write(words.shopLine, m.x + m.w / 2, m.y + m.h * 0.8, { size: 72, maxW: m.w - 300, color: '#e3a73c' });
  // the price board: the best-paying fish, in chalk
  const pr = rect(ATLAS.prices);
  write(words.boardTitle, pr.x + 60, pr.y + 70, { size: 80, weight: 700, maxW: pr.w - 120, color: '#eceae2', align: 'left' });
  const best = Object.values(tables.species).sort((a, b2) => b2.value - a.value).slice(0, 5);
  best.forEach((s, i) => write(`${s.name} ... ${words.currency}${s.value}${words.perKg}`, pr.x + 70, pr.y + 160 + i * 68, { size: 52, weight: 600, maxW: pr.w - 120, color: '#eceae2', align: 'left' }));
  // the scale's dial (enamel face, ticks, kg)
  const d = rect(ATLAS.dial), cx = d.x + d.w / 2, cy = d.y + d.h / 2, R = Math.min(d.w, d.h) * 0.44;
  c.fillStyle = '#e9e4d6'; c.beginPath(); c.arc(cx, cy, R, 0, Math.PI * 2); c.fill();
  c.strokeStyle = '#1d1d1d'; c.fillStyle = '#1d1d1d'; c.textAlign = 'center'; c.textBaseline = 'middle';
  for (let i = 0; i <= 50; i++) {   // 0..25 kg round the face, 0 at the bottom
    const a = Math.PI / 2 + 0.35 + (i / 50) * (Math.PI * 2 - 0.7), long = i % 10 === 0;
    c.lineWidth = long ? 7 : 4;
    c.beginPath(); c.moveTo(cx + Math.cos(a) * R * 0.9, cy + Math.sin(a) * R * 0.9); c.lineTo(cx + Math.cos(a) * R * (long ? 0.74 : 0.8), cy + Math.sin(a) * R * (long ? 0.74 : 0.8)); c.stroke();
    if (long) { c.font = `600 40px ${FONT}`; c.fillText(String(i / 2), cx + Math.cos(a) * R * 0.6, cy + Math.sin(a) * R * 0.6); }
  }
  c.font = `600 32px ${FONT}`; c.fillText('kg', cx, cy + R * 0.3);
  const img = c.getImageData(0, 0, W, H);
  return { canvas: cv, data: new Uint8Array(img.data.buffer, img.data.byteOffset, img.data.byteLength), width: W, height: H, texts };
}

async function paintSigns(tables, words) {
  const assets = await loadStallAssets();
  const tex = assets.signs;
  const s = drawSigns(tables, words);
  if (tex.width !== s.width || tex.height !== s.height) throw new Error(`the sign texture is ${tex.width}x${tex.height}, not ${s.width}x${s.height}`);
  tex.upload(s.data);
  generateMipmaps(tex);
  GPU.submit?.();
  return {
    texts: s.texts,
    /** The texture's top level as the GPU holds it now (RGBA bytes), to prove what the stalls draw. */
    async readback() {
      const dev = GPU.device, bpr = s.width * 4;
      const buf = dev.createBuffer({ size: bpr * s.height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      const enc = dev.createCommandEncoder();
      enc.copyTextureToBuffer({ texture: tex.getGPU(), mipLevel: 0 }, { buffer: buf, bytesPerRow: bpr, rowsPerImage: s.height }, { width: s.width, height: s.height, depthOrArrayLayers: 1 });
      dev.queue.submit([enc.finish()]);
      await buf.mapAsync(GPUMapMode.READ);
      const out = new Uint8Array(buf.getMappedRange()).slice();
      buf.unmap(); buf.destroy();
      return { gpu: out, painted: s.data, width: s.width, height: s.height };
    },
  };
}
