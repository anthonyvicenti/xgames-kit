// gf-three vfx: slot declarations (CONTRACT §2.2). Pure data. A preset a game uses (config/game.json → vfx.<name>) is up
// to four slots: its colour and its sprite in the main tier (what a creator changes), its end colour, and one json slot
// with the rest of the numbers, in the advanced tier. A game that lists no preset has no vfx slots.
import { humanize } from '../core/slots.js';

export function slotsFor(cfg) {
  const out = [], V = cfg.game?.vfx ?? {};
  for (const [name, p] of Object.entries(V)) {
    const L = humanize(name), at = k => ({ file: 'config/game.json', pointer: `/vfx/${name}/${k}` });
    out.push({ id: `vfx.${name}.color`, label: `${L}: colour`, group: 'look', type: 'color', source: at('color'), tier: 'main', facet: 'look', rank: 58 });
    out.push({ id: `vfx.${name}.color-end`, label: `${L}: colour at the end`, group: 'look', type: 'color', source: at('colorEnd'), tier: 'advanced', facet: 'look', rank: 20 });
    out.push({ id: `vfx.${name}.shape`, label: `${L}: size, speed, count and fade`, group: 'look', type: 'json', source: at('shape'), tier: 'advanced', facet: 'look', rank: 18, description: 'count, rate (a second, for a continuous emitter), emitter (point | sphere | disc | ring | box | line), radius, speed, life, size, gravity (negative rises), drag, spread, outward, stretch, spin, fade, shrink, grow, hueJitter, intensity, blending (additive | normal)' });
    if (p.texture) out.push({ id: `vfx.${name}.texture`, label: `${L}: sprite`, group: 'look', type: 'image', source: { file: p.texture }, tier: 'main', facet: 'look', rank: 56, constraints: { colorSpace: 'srgb', formats: ['png', 'webp'] }, description: 'One white-on-transparent picture drawn on every particle (tinted by the colours)', generate: { prompt: `a single white ${L.toLowerCase()} sprite, soft glow, transparent background, centred`, style: 'game particle sprite, white on transparent' } });
  }
  // the game's effect style (config/game.json → fx: styles.js): which presets a blast, a hit and a trail draw, the number style
  if (cfg.game?.fx) out.push({ id: 'vfx.style', label: 'Effect style: blasts, hits, trails and damage numbers', group: 'look', type: 'json', source: { file: 'config/game.json', pointer: '/fx' }, tier: 'advanced', facet: 'look', rank: 22, description: 'style (cartoon | fiery | pixel | soft), blast and hit (lists of vfx preset names), trail (a preset or null), numbers (comic | float | none), scale. Set from the look target; a mechanic calls vfx.blast / hit / trail / damage and this decides how they look.' });
  return out;
}
