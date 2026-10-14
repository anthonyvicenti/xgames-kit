// gf-scenic look slots (CONTRACT §2.2, §8): every number, colour and switch in config/look.json is a value slot pointing
// into it, so Studio can retune any of them. No three.js here: create and the slot tools read this in Node.
// Groups: look (the base values), look-times (the other times of day), look-quality (the two quality tiers).
import { presets, TIMES } from './presets.js';

const FILE = 'config/look.json';
const HEX = /^#[0-9a-f]{6}([0-9a-f]{2})?$/i;
const kebab = s => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();

// path → [label, main?, rank]
const LABELS = {
  'time': ['Time of day', true, 60],
  'renderer.exposure': ['Overall brightness', true, 40],
  'light.color': ['Sunlight colour', true, 58],
  'light.intensity': ['Sun brightness', true, 57],
  'light.elevation': ['Sun height (degrees)', true, 50],
  'light.azimuth': ['Sun direction (degrees)', false, 20],
  'light.coreShadowLow': ['How far the shade wraps round forms', false, 10],
  'light.coreShadowHigh': ['Where the shade ends', false, 10],
  'shadow.color': ['Shade colour', true, 56],
  'shadow.strength': ['Shade strength', false, 20],
  'bounce.strength': ['Light bounced up from the ground', false, 15],
  'bounce.distance': ['Bounce reach (metres)', false, 10],
  'fog.colorA': ['Haze and sky colour, middle', true, 55],
  'fog.colorB': ['Haze and void colour, edges', true, 54],
  'fog.near': ['Haze starts (metres from the camera)', false, 25],
  'fog.far': ['Haze is full (metres)', true, 45],
  'fog.radialStart': ['Sky gradient start', false, 8],
  'fog.radialEnd': ['Sky gradient end', false, 8],
  'fog.voidTop': ['Void fade starts (height)', false, 8],
  'fog.voidBottom': ['Void fade is full (height)', false, 8],
  'sky.top': ['Sky tint overhead', false, 20],
  'sky.strength': ['Sky tint strength', false, 10],
  'sky.stars': ['Stars', true, 44],
  'sky.starColor': ['Star colour', false, 10],
  'sky.starSize': ['Star size', false, 8],
  'lamps.color': ['Lantern light colour', true, 48],
  'lamps.intensity': ['Lantern light strength', true, 47],
  'lamps.radius': ['Lantern light reach (metres)', false, 20],
  'glow.lantern': ['Lantern glow', false, 30],
  'glow.crystal': ['Crystal glow', true, 46],
  'glow.rune': ['Rune glow', false, 30],
  'glow.intensity': ['Glow strength', false, 30],
  'rim.color': ['Character rim light', false, 20],
  'rim.strength': ['Character rim strength', false, 15],
  'character.shadeLift': ['Characters: lighter shade', false, 25],
  'character.shadeStrength': ['Characters: shade strength', false, 20],
  'character.brightness': ['Characters: brightness', true, 37],
  'wind.strength': ['Wind', true, 43],
  'wind.angle': ['Wind direction (degrees)', false, 10],
  'wind.speed': ['Wind speed', false, 10],
  'weather.rain': ['Rain', true, 42],
  'weather.snow': ['Snow', true, 41],
  'weather.lightning': ['Lightning', true, 41],
  'cycle.on': ['Day cycle', true, 40],
  'cycle.seconds': ['Day cycle length (seconds)', false, 20],
  'post.bloom.strength': ['Glow (bloom)', true, 42],
  'post.bloom.radius': ['Glow spread', false, 15],
  'post.bloom.threshold': ['Glow threshold', false, 15],
  'post.bloom.smoothWidth': ['Glow softness', false, 8],
  'post.dof.start': ['Blur starts (from the screen middle)', false, 12],
  'post.dof.end': ['Blur is full', false, 12],
  'post.dof.amount': ['Edge blur (depth of field)', false, 20],
  'post.dof.repeats': ['Blur samples', false, 5],
  'palette.accent': ['Accent colour', true, 39],
  'palette.glow': ['Glow colour', false, 20],
  'palette.players': ['Player colours', true, 38],
};
const auto = p => p.split('.').map(kebab).join(' · ').replace(/-/g, ' ').replace(/^./, c => c.toUpperCase());

function walk(obj, path, out) {
  for (const [k, v] of Object.entries(obj)) {
    if (!path.length && ['id', 'label', 'describe', 'preset'].includes(k)) continue;
    const p = [...path, k];
    if (Array.isArray(v)) { if (v.length && v.every(x => typeof x === 'string' && HEX.test(x))) out.push({ p, type: 'colors' }); continue; }
    if (v && typeof v === 'object') { walk(v, p, out); continue; }
    if (typeof v === 'number') out.push({ p, type: 'number' });
    else if (typeof v === 'boolean') out.push({ p, type: 'boolean' });
    else if (typeof v === 'string' && HEX.test(v)) out.push({ p, type: 'color' });
    else if (typeof v === 'string') out.push({ p, type: 'enum' });
  }
}

const RANGES = [
  [/bloom\.radius$/, 0, 1], [/shadowRadius$/, 0, 8],
  [/elevation$/, -10, 90], [/azimuth$|angle$/, -360, 360], [/intensity$|strength$|exposure$/, 0, 6], [/stars$|rain$|snow$|lightning$/, 0, 1],
  [/coreShadow/, -1, 1], [/shadeLift$|shadeStrength$/, 0, 1], [/brightness$/, 0, 3], [/voidTop$|voidBottom$/, -200, 50], [/radial/, 0, 2], [/amount$/, 0, 0.02], [/repeats$/, 1, 60],
  [/near$|far$/, 0, 600], [/radius$|distance$/, 0, 60], [/seconds$/, 10, 3600], [/threshold$|smoothWidth$|start$|end$/, 0, 2],
  [/shadowMapSize$/, 256, 4096], [/bloomMips$/, 1, 5], [/grassDensity$/, 0, 1], [/pixelRatio$/, 0.5, 2], [/speed$/, 0, 2], [/size$/i, 0, 4],
];

/** Slots for a config/look.json object (or a preset). */
export function slotsFor(look) {
  const items = [];
  walk({ time: look.time ?? 'dusk', ...look }, [], items);
  return items.map(({ p, type }) => {
    const dotted = p.join('.');
    const group = p[0] === 'times' ? 'look-times' : p[0] === 'quality' ? 'look-quality' : 'look';
    const [label, main, rank] = LABELS[dotted] ?? [auto(dotted), false, 5];
    const slot = { id: 'look.' + p.map(kebab).join('.'), label, group, type, facet: 'look', tier: main ? 'main' : 'advanced', rank, source: { file: FILE, pointer: '/' + p.join('/') } };
    if (type === 'enum') slot.constraints = { options: (dotted === 'time' ? TIMES : [String(look[p[0]] ?? '')]).map(o => ({ value: o, label: o })) };
    if (type === 'number') { const r = RANGES.find(([re]) => new RegExp(re.source, 'i').test(dotted)); slot.constraints = r ? { min: r[1], max: r[2] } : { min: 0 }; }
    if (p[0] === 'times') slot.description = `Used when the time of day is ${p[1]} (or the day cycle passes it)`;
    if (p[0] === 'quality') slot.description = `The ${p[1]} quality tier`;
    return slot;
  });
}

export const slots = slotsFor({ preset: 'dusk-isle', ...presets['dusk-isle'] });
