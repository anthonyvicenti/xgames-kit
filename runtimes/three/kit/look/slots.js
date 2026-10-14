// look.* slots (CONTRACT §2.2): every number, colour and switch in config/look.json is a value slot pointing into it.
// slotsFor(lookJson) lists them; `slots` is the list for the reference preset (all presets share one shape, which
// tests/l-look.test.mjs checks). About 30 are main tier; the rest are "advanced".
import { presets } from './presets.js';

const FILE = 'config/look.json';
const kebab = (s) => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
const HEX = /^#[0-9a-f]{6}([0-9a-f]{2})?$/i;

// path (dotted, as in the JSON) -> [label, main?]
const LABELS = {
  'time': ['Time of day', true],
  'renderer.exposure': ['Overall brightness', true],
  'renderer.toneMapping': ['Tone mapping', false],
  'palette.players': ['Player colours', true],
  'palette.accent': ['Accent colour', true],
  'palette.ui': ['Interface ink colour', false],
  'sun.color': ['Sunlight colour', true],
  'sun.intensity': ['Sun brightness', true],
  'sun.elevation': ['Sun height (degrees)', true],
  'sun.azimuth': ['Sun direction (degrees)', false],
  'sun.shadowStrength': ['Shadow darkness', true],
  'sun.shadowSoftness': ['Shadow softness', true],
  'ambient.sky': ['Fill light from the sky', true],
  'ambient.ground': ['Bounce light from the ground', true],
  'ambient.intensity': ['Fill light strength', true],
  'ambient.envIntensity': ['Reflections strength', false],
  'sky.top': ['Sky colour, overhead', true],
  'sky.horizon': ['Sky colour, horizon', true],
  'sky.bottom': ['Sky colour, below the horizon', false],
  'sky.glow': ['Sun glow colour', true],
  'fog.color': ['Haze colour', true],
  'fog.far': ['Haze distance (metres)', true],
  'materials.character.rim': ['Character rim light', true],
  'materials.character.subsurface': ['Character jelly glow', true],
  'materials.character.subsurfaceColor': ['Character jelly glow colour', true],
  'materials.character.clearcoat': ['Character gloss', true],
  'materials.prop.saturation': ['Prop colourfulness', true],
  'materials.prop.lift': ['Prop pastel amount', true],
  'materials.water.shallow': ['Water colour, shallow', true],
  'materials.water.deep': ['Water colour, deep', true],
  'materials.liquid.core': ['Liquid stream highlight', false],
  'post.outline.strength': ['Outline strength', true],
  'post.outline.color': ['Outline colour', true],
  'post.bloom.intensity': ['Glow (bloom)', true],
  'post.ao.intensity': ['Contact shadows', true],
  'post.grade.saturation': ['Colour saturation', true],
  'post.grade.contrast': ['Contrast', true],
  'post.grade.temperature': ['Warmth', true],
  'post.grade.vignette': ['Vignette', false],
};
const WORDS = { ao: 'ambient occlusion', env: 'environment', sss: 'subsurface', fxaa: 'FXAA', smaa: 'SMAA' };
function autoLabel(path) {
  return path.split('.').map(kebab).map(s => s.split('-').map(w => WORDS[w] ?? w).join(' ')).join(' · ')
    .replace(/^./, c => c.toUpperCase());
}

function walk(obj, path, out) {
  for (const [k, v] of Object.entries(obj)) {
    if (['id', 'label', 'describe', 'preset'].includes(k) && !path.length) continue;
    const p = [...path, k];
    if (Array.isArray(v)) { if (v.every(x => typeof x === 'string' && HEX.test(x))) out.push({ p, type: 'colors', v }); continue; }
    if (v && typeof v === 'object') { walk(v, p, out); continue; }
    if (typeof v === 'number') out.push({ p, type: 'number', v });
    else if (typeof v === 'boolean') out.push({ p, type: 'boolean', v });
    else if (typeof v === 'string' && HEX.test(v)) out.push({ p, type: 'color', v });
    else if (typeof v === 'string') out.push({ p, type: 'enum', v });
  }
}

const ENUMS = {
  'renderer.toneMapping': ['AgX', 'ACES', 'Neutral'],
  'time': ['day', 'golden', 'night'],
  'aoQuality': ['Performance', 'Low', 'Medium', 'High', 'Ultra'],
};

// The look's one picture: a seamless soft noise the ground, water and liquid materials use for patches, ripples and
// streaks (library/textures/noise-soft.png, baked by lookdev/tools/bake-textures.mjs). Optional: without it the
// materials are flat.
export const NOISE_SLOT = {
  id: 'look.textures.noise', label: 'Ground, water and stream pattern', group: 'look', type: 'image', facet: 'look', tier: 'advanced',
  source: { file: 'assets/textures/ground-noise.png' }, optional: true,
  constraints: { width: 256, height: 256, tile: true, alpha: false, formats: ['png', 'webp', 'jpg'] },
  description: 'Seamless soft noise: red = large patches, green = medium detail, blue = fine grain. Drives the ground colour patches, water ripples and stream streaks.',
  generate: { prompt: 'seamless soft greyscale noise in the red, green and blue channels at three scales', style: 'tileable, soft, no hard edges' },
};

/** Slots for a config/look.json object (or a preset). */
export function slotsFor(look) {
  const items = [];
  walk({ time: look.time ?? 'day', ...look }, [], items);
  return items.map(({ p, type }) => {
    const dotted = p.join('.');
    const [label, main] = LABELS[dotted] ?? [autoLabel(dotted), false];
    const quality = p[0] === 'quality';
    const slot = {
      id: 'look.' + p.map(kebab).join('.'),
      label: p[0] === 'times' ? `${label.replace(/^Times · /, '')}` : label,
      group: quality ? 'look-quality' : p[0] === 'times' ? 'look-times' : 'look',
      type, facet: 'look', tier: main ? 'main' : 'advanced',
      source: { file: FILE, pointer: '/' + p.join('/') },
    };
    if (type === 'enum') {
      const opts = ENUMS[dotted] ?? ENUMS[dotted.replace(/^times\.[^.]+\./, '')] ?? ENUMS[p[p.length - 1]] ?? [];   // a time's own block too (times.day.renderer.toneMapping)
      slot.constraints = { options: opts.map(o => ({ value: o, label: o })) };
    }
    // warmth (post.grade.temperature) runs both ways: below 0 is cooler (the presets' night looks are -0.12 to -0.05)
    if (type === 'number') slot.constraints = { min: /elevation|azimuth/.test(dotted) ? -180 : /(^|\.)temperature$/.test(dotted) ? -1 : 0 };
    if (quality) slot.description = 'Quality tier setting (high = desktop, low = phones and slow machines).';
    if (p[0] === 'times') slot.description = `Used at the "${p[1]}" time of day, over the base value.`;
    return slot;
  }).concat([{ ...NOISE_SLOT }]);
}

export const slots = slotsFor({ preset: 'jelly-pastel', time: 'day', ...presets['jelly-pastel'] });
