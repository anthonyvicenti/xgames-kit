// Slot declarations of the STAND-IN look, world and character modules (kit/core/standins/), used until tracks L and
// C land their own. Pure (Node imports it). Each function mirrors what the real module would declare.
import { humanize } from '../slots.js';

const L = 'config/look.json', W = 'config/world.json', C = 'config/characters.json';
// the look values a creator reaches for first; every other number and colour is advanced
const LOOK_MAIN = { 'sky.top': 72, 'sky.horizon': 70, 'sun.color': 68, 'sun.intensity': 69, 'ambient.intensity': 66, 'fog.color': 64, exposure: 65 };

/** look: every number and colour in config/look.json → values becomes a look.* slot. */
export function lookSlots(cfg) {
  const out = [];
  const walk = (v, path) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) { for (const [k, x] of Object.entries(v)) walk(x, [...path, k]); return; }
    const key = path.join('.'), isColor = typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);
    if (!isColor && typeof v !== 'number') return;
    const rank = LOOK_MAIN[key];
    out.push({ id: `look.${path.map(p => p.toLowerCase()).join('.')}`, group: 'look', label: humanize(path.join(' ')), type: isColor ? 'color' : 'number', source: { file: L, pointer: `/values/${path.join('/')}` },
      ...(isColor ? {} : { constraints: lookRange(path.at(-1), v) }), tier: rank ? 'main' : 'advanced', facet: 'look', rank: rank ?? 12 });
  };
  walk(cfg.look?.values ?? {}, []);
  return out;
}
function lookRange(k, v) {
  if (/elevation/.test(k)) return { min: -10, max: 90, unit: '°' };
  if (/azimuth/.test(k)) return { min: -180, max: 360, unit: '°' };
  if (/near|far/.test(k)) return { min: 0, max: 600, unit: 'm' };
  if (/intensity|exposure/.test(k)) return { min: 0, max: Math.max(4, v * 3) };
  return { min: 0, max: Math.max(1, Math.abs(v) * 4) };
}

/** world: the ground's texture and colour, the layout, and one model slot per prop name. */
export function worldSlots(cfg) {
  const w = cfg.world ?? {}, T = w.template ?? 'backyard', out = [];
  if (w.ground?.texture) out.push({ id: `world.${T}.ground`, group: 'world', label: 'Ground texture', type: 'texture', source: { file: w.ground.texture }, constraints: { colorSpace: 'srgb', layout: '2d', maxBytes: 4194304 }, tier: 'main', facet: 'look', rank: 76, description: 'Tiled over the whole play area', ...(w.ground.license ? { license: w.ground.license } : {}), generate: { prompt: `seamless ground texture for a ${T}, top-down`, style: 'soft, colourful, stylised; tiles seamlessly' } });
  if (w.ground?.color) out.push({ id: `world.${T}.ground.color`, group: 'world', label: 'Ground tint', type: 'color', source: { file: W, pointer: '/ground/color' }, tier: 'main', facet: 'look', rank: 75, description: 'Multiplies the ground texture' });
  if (typeof w.ground?.repeat === 'number') out.push({ id: `world.${T}.ground.repeat`, group: 'world', label: 'Ground texture repeats', type: 'number', source: { file: W, pointer: '/ground/repeat' }, constraints: { min: 1, max: 64 }, tier: 'advanced', facet: 'look', rank: 14 });
  if (typeof w.half === 'number') out.push({ id: `world.${T}.size`, group: 'world', label: 'Play area half-width', type: 'number', source: { file: W, pointer: '/half' }, constraints: { min: 4, max: 60, unit: 'm' }, tier: 'advanced', facet: 'gameplay', rank: 24 });
  out.push({ id: `world.${T}.layout`, group: 'world', label: 'Prop layout', type: 'json', source: { file: W, pointer: '/props' }, tier: 'advanced', facet: 'gameplay', rank: 20, description: 'Where each prop stands: [{prop, at: [x, y, z], rot, scale}]' });
  out.push({ id: `world.${T}.spawns`, group: 'world', label: 'Spawn points', type: 'json', source: { file: W, pointer: '/spawns' }, tier: 'advanced', facet: 'gameplay', rank: 19 });
  out.push({ id: `world.${T}.zones`, group: 'world', label: 'Zones', type: 'json', source: { file: W, pointer: '/zones' }, tier: 'advanced', facet: 'gameplay', rank: 18 });
  // one model per prop name: the layout's and the game's (thrown, carried, collected)
  const props = new Map();
  for (const p of cfg.game?.props ?? []) props.set(p.name, p);
  for (const p of w.props ?? []) if (!props.has(p.prop)) props.set(p.prop, { name: p.prop });
  for (const [name, p] of props) {
    const rec = cfg.propFiles?.[name] ?? {};
    out.push({ id: `prop.${name}`, group: 'props', label: humanize(name), type: 'model', source: { file: rec.file ?? `assets/models/${name}.glb` }, constraints: { maxBytes: 8388608, scale: 1 },
      tier: 'main', facet: 'look', rank: 94, description: p.describe ? `${p.describe}${p.role ? ` (${p.role})` : ''}` : undefined,
      generate: { prompt: p.describe ?? name, style: 'stylised low-poly game prop, soft colours, clean silhouette' }, ...(rec.license ? { license: rec.license } : {}) });
  }
  return out;
}

/** character: a body model per role, the tint palette, the body height. */
export function characterSlots(cfg) {
  const c = cfg.characters ?? {}, out = [];
  for (const [role, r] of Object.entries(c.roles ?? {})) {
    out.push({ id: `character.body.${role}`, group: 'characters', label: role === 'player' ? 'Player character' : `${humanize(role)} character`, type: 'model',
      source: { file: r.body, pathRef: { file: C, pointer: `/roles/${role}/body` } },
      constraints: { rigged: true, rig: 'gf-humanoid-1', animations: ['idle', 'walk', 'run', 'jump', 'fall', 'knockdown'], maxBytes: 15728640, scale: 1 },
      tier: 'main', facet: 'look', rank: 98, description: r.describe ?? undefined, generate: { prompt: r.describe ?? 'a friendly party-game character', style: 'cute chunky stylised character, T-pose, game-ready' }, ...(r.license ? { license: r.license } : {}) });
    if (r.hat) out.push({ id: `character.hat.${role}`, group: 'characters', label: `${role === 'player' ? 'Player' : humanize(role)} hat`, type: 'model', optional: true, source: { file: r.hat, pathRef: { file: C, pointer: `/roles/${role}/hat` } }, constraints: { maxBytes: 2000000, scale: 1 }, tier: 'main', facet: 'look', rank: 84, description: 'Worn on the head; its origin sits on top of the head, +Z forward', generate: { prompt: r.hatDescribe ?? 'a hat', style: 'stylised low-poly game accessory, soft colours' } });
    if (typeof r.height === 'number') out.push({ id: `character.height.${role}`, group: 'characters', label: `${role === 'player' ? 'Player' : humanize(role)} height`, type: 'number', source: { file: C, pointer: `/roles/${role}/height` }, constraints: { min: 0.5, max: 3, unit: 'm' }, tier: 'advanced', facet: 'gameplay', rank: 21 });
    if (!Array.isArray(cfg.look?.palette?.players)) out.push({ id: `character.tint.${role}`, group: 'characters', label: 'Player colours (one per seat)', type: 'colors', source: { file: C, pointer: '/palette' }, constraints: { min: 1, max: 8 }, tier: 'main', facet: 'look', rank: 90, description: 'Each player\'s body tint, ring and nameplate dot' });
  }
  return out;
}
