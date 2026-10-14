// gf-three assets, the part with no three.js (CONTRACT §2.1, §8 forge): slots, config files, value slots, player
// looks and loadouts. Reads go through gf/gf-assets.js, so Studio's overrides (__GF_ASSET_OVERRIDES), packed mode
// (__GF_FILES) and __GF_ASSETS_SEEN all work unchanged.
//
// kit/assets/assets.js adds the three.js loaders (model, texture, tag, coverage, stats) to this same object, so a
// party or scenic game sees one `assets`; a forge game (CONTRACT §8: no three.js) imports this file alone and loads
// its models and textures as bytes through gf/forge/host.js.
import * as gf from '../../gf-assets.js';
import { getPointer } from '../../gf-assets.js';
import { validateLoadout, loadoutKey, playerLookSlots, isEmpty } from './loadout.js';
import { slotValueProblems, setAt } from './items.js';

export const S = { manifest: null, slots: new Map(), files: new Map(), configs: new Map(), renderer: null, gltf: new Map(), tex: new Map(), ext: new Map(), extTex: new Map(), loader: null, ktx2: null, ready: false };
// loadouts (CONTRACT §6e): the player-look slots, and per player {loadout, key, advertised, dropped, rejected}
export const L = { looks: new Map(), of: new Map(), fns: [] };
const pid = p => (p !== null && typeof p === 'object' ? p.id : p);
const notify = id => { for (const fn of L.fns.slice()) { try { fn(id); } catch (e) { console.error(e); } } };
export const isUrl = f => /^https?:\/\//i.test(f);

export function slotOf(id) {
  const s = S.slots.get(id);
  if (!s) throw new Error(`gf-three assets: no slot "${id}" in assets.json`);
  return s;
}

export const assets = {
  /** Load assets.json and every JSON file a value slot points into (config/*.json), so value() and config() are synchronous. */
  /** One more config file after init (the prop catalog, only for a world that has props). */
  async addConfig(name) { const f = `config/${name}.json`; if (!S.files.has(f)) S.files.set(f, await gf.json(f)); S.configs.set(name, S.files.get(f)); return S.configs.get(name); },
  /** optional: config names that may be missing (asked with a HEAD request first): config() gives {} */
  async init({ renderer = null, configs = ['game', 'look', 'world', 'characters'], optional = [] } = {}) {
    S.renderer = renderer;
    S.manifest = await gf.manifest();
    for (const s of S.manifest.slots ?? []) S.slots.set(s.id, s);
    L.looks = playerLookSlots(S.manifest.slots ?? []);
    const files = new Set(configs.map(n => `config/${n}.json`));
    for (const s of S.slots.values()) if (s.source?.pointer !== undefined && /\.json$/i.test(s.source.file)) files.add(s.source.file);
    const maybe = new Set(optional.map(n => `config/${n}.json`));
    await Promise.all([...files].map(async f => {
      if (maybe.has(f) && !(await gf.exists(f))) { S.files.set(f, {}); return; }
      S.files.set(f, await gf.json(f));
    }));
    for (const n of configs) S.configs.set(n, S.files.get(`config/${n}.json`));
    S.ready = true;
    return this;
  },
  setRenderer(r) { S.renderer = r; },
  get manifest() { return S.manifest; },
  /** The slot's definition from assets.json (throws on an unknown id). */
  slot: slotOf,
  has: id => S.slots.has(id),
  /** Every slot id, optionally those starting with a prefix. */
  ids: (prefix = '') => [...S.slots.keys()].filter(k => k.startsWith(prefix)),
  /** The file a slot reads (its source.file). */
  file: id => slotOf(id).source.file,
  /** A URL for a slot's file (Image, Audio): Studio's replaced file when there is one; opts.player: their own file. */
  url: (id, opts) => { const own = opts?.player != null ? assets.ownFile(id, opts.player) : null; return own && isUrl(own) ? own : gf.url(own ?? slotOf(id).source.file); },

  /** A whole config file (config/<name>.json) with Studio's patches applied. */
  config(name) {
    const c = S.configs.get(name) ?? S.files.get(`config/${name}.json`);
    if (c === undefined) throw new Error(`gf-three assets: config/${name}.json was not loaded`);
    return c;
  },
  /** A value slot's current value (overrides applied). opts.player: that player's value, their loadout's for a
   *  player-look slot, else the game's; a `colors` slot (one per seat) gives the player's own entry (by p.seat). */
  value(id, fallback, opts) {
    const s = S.slots.get(id);
    if (!s) { if (fallback !== undefined) return fallback; throw new Error(`gf-three assets: no slot "${id}"`); }
    if (s.source?.pointer === undefined) throw new Error(`gf-three assets: "${id}" is a file slot; use model() or texture()`);
    const player = opts?.player ?? null;
    if (player !== null) { const own = assets.own(id, player); if (own !== undefined) return own; }
    const doc = S.files.get(s.source.file);
    if (doc === undefined) throw new Error(`gf-three assets: ${s.source.file} was not loaded`);
    const v = getPointer(doc, s.source.pointer);
    if (player !== null && s.type === 'colors' && Array.isArray(v) && v.length && typeof player === 'object') return v[(Number(player.seat) || 0) % v.length] ?? fallback;
    return v === undefined ? fallback : v;
  },

  // ---- player looks and loadouts (CONTRACT §6e) ----
  /** The slot ids that resolve per player (`scope: "player"`). */
  playerLooks: () => [...L.looks.keys()],
  isPlayerLook: id => L.looks.has(id),
  /** Set (or clear, with null) a player's loadout. It is checked against the player-look slots; what doesn't fit is
   *  dropped, never fatal. opts.key: the key the owner advertised, when it came over the net.
   *  → { key, loadout, dropped, changed } */
  setLoadout(player, raw, { key = null } = {}) {
    const id = pid(player), prev = L.of.get(id) ?? null;
    const { loadout, dropped } = raw == null ? { loadout: { values: {}, files: {} }, dropped: [] } : validateLoadout(raw, L.looks);
    const k = loadoutKey(loadout), changed = (prev?.key ?? '') !== k;
    L.of.set(id, { loadout, key: k, advertised: key ?? k, dropped, rejected: changed || !prev ? new Map() : prev.rejected });
    if (changed) notify(id);
    return { key: k, loadout, dropped, changed };
  },
  /** A player's record { loadout, key, advertised, dropped, rejected } or null. */
  loadout: player => L.of.get(pid(player)) ?? null,
  /** Forget a player's loadout (they left). */
  clearLoadout(player) { const id = pid(player), had = L.of.get(id); L.of.delete(id); if (had?.key) notify(id); },
  /** The player's own value for a player-look slot (undefined when the game's applies). */
  own(id, player) { if (!L.looks.has(id)) return undefined; const r = L.of.get(pid(player)); return r && !isEmpty(r.loadout) ? r.loadout.values[id] : undefined; },
  /** The player's own file (a URL or a game path) for a player-look file slot, unless it already failed for them. */
  ownFile(id, player) { if (!L.looks.has(id)) return null; const r = L.of.get(pid(player)); const f = r?.loadout.files[id]; return f && !r.rejected.has(id) ? f : null; },
  /** The file this player draws for a slot: their own, else the slot's. */
  fileFor: (id, player = null) => (player !== null ? assets.ownFile(id, player) : null) ?? slotOf(id).source.file,
  /** A player's own file failed: it is dropped for them and the game's file is used. */
  reject(player, id, why) {
    const r = L.of.get(pid(player)); if (!r || r.rejected.has(id)) return;
    r.rejected.set(id, String(why).slice(0, 200));
    console.warn(`gf-three loadout: ${pid(player)}'s ${id} was dropped (${why}); the game's own is used`);
    notify(pid(player));
  },
  /** fn(playerId) whenever a player's loadout changes (or one of its files is dropped). → unsubscribe */
  onLoadout(fn) { L.fns.push(fn); return () => { const i = L.fns.indexOf(fn); if (i >= 0) L.fns.splice(i, 1); }; },

  // ---- a value slot changed while the game runs (dev only: kit/core/live-slots.js; open builder wave 10) ----
  /** Problems with a value for a value slot, in words (empty: it fits the slot's type and range). */
  valueProblems(id, value) { const s = S.slots.get(id); return s ? slotValueProblems(s, value) : [`there is no slot "${id}"`]; },
  /** Put a new value in a value slot in memory (the file on disk is the page's to write). Refused, in words, when it
   *  does not fit the slot. Everything that reads the slot through value() sees it at once; a part that read it once at
   *  the start hears it through onValue. → { ok, problems, before } */
  setValue(id, value) {
    const s = S.slots.get(id);
    if (!s) return { ok: false, problems: [`there is no slot "${id}"`] };
    if (s.source?.pointer === undefined) return { ok: false, problems: [`${id} is a file slot: it changes with a new file and a reload`] };
    const problems = slotValueProblems(s, value);
    if (problems.length) return { ok: false, problems };
    const doc = S.files.get(s.source.file);
    if (doc === undefined) return { ok: false, problems: [`${s.source.file} was not loaded`] };
    const before = getPointer(doc, s.source.pointer);
    try { setAt(doc, s.source.pointer, value); } catch (e) { return { ok: false, problems: [`${id}: ${e.message}`] }; }
    for (const fn of V.fns.slice()) { try { fn(id, value, before); } catch (e) { console.error(e); } }
    return { ok: true, problems: [], before };
  },
  /** fn(slotId, value, before) after setValue. → unsubscribe */
  onValue(fn) { V.fns.push(fn); return () => { const i = V.fns.indexOf(fn); if (i >= 0) V.fns.splice(i, 1); }; },
};
const V = { fns: [] };
export default assets;
