// spec.forge.elites (owner: forge-ai, wave 7 track E: elite enemies). The creator, 2026-10-12, chose "Elite zombies"
// after builds and coins: from the second lap on, some of the risen carry a modifier you can read at a glance, and
// elites drop more coins. With `on`, an ordinary arrival (never the boss unless `boss`) may rise as an elite once the
// run reaches lap `lap` (0: the first time through) or wave `wave` (as players count it; 0: by lap alone), whichever
// comes first: `chance` of them that first lap, `grow` more each lap after, at most `chanceMost`, and at most
// `perWave` a wave. The host decides (the run's seeded dice); every copy draws the same, from the snapshot.
//
// Each modifier has its own numbers, a name and a line for the banner the first time one rises in a run (the rule event
// `elite` {entity, a: modifier 1 burning · 2 armoured · 3 splitting · 4 fast, b: enemy row, c: 1 the first of its
// modifier this run}), and the colour of the rim of light on its body (with `glow` its strength and `tint` its body's
// colour). forge-ai reads every field (core/forge-ai/src/elite.rs); its Rust defaults equal these (a cargo test holds
// them to kit/tables/defaults.json, which `node research/gf-forge/tools/tables.mjs --write` writes).
//
// burning    its blows (and a caster's orbs) set a player alight: `dps` for `seconds`, a tick each `tick`, a new blow
//            starts the seconds again; it may leave a patch of fire where it falls that sets alight whoever stands in it
// armoured   takes `damage` × of every hit, and is knocked about `knock` × as much (staggers, downs, flinches)
// splitting  when it falls, `count` smaller ones of `into` (its own kind when empty) crawl out, each with `health` × its
//            most health, drawn at `scale` ×; they never split again
// fast       moves `speed` × as fast and attacks `attack` × as fast (shorter tells, cooldowns and recoveries)
import { num, int, bool, color, words, sound, ref, obj, list } from './fields.js';

export const MODIFIERS = ['burning', 'armoured', 'splitting', 'fast'];

/** What every modifier has: on, how often, its words for the banner, and how it reads at a glance. */
const look = (glowColor, glow, tint, name, line) => ({
  on: bool(true, 'On', 'Elites may rise with this modifier'),
  weight: num(1, 0, 10, '×', 'How often', 'Its share among the modifiers that are on'),
  name: words(name, 'Name', 'What the banner calls an elite with it', 32),
  line: words(line, 'Line', 'The banner\'s second line the first time one rises in a run', 80),
  color: color(glowColor, 'Glow colour', 'The rim of light on its body: how it reads at a glance', 'main'),
  glow: num(glow, 0, 8, '×', 'Glow', 'How bright the rim burns (0: none)'),
  tint: color(tint, 'Body tint', 'Its body\'s colour multiplier (#ffffff: its own colours)'),
});

export const fields = {
  on: bool(false, 'Elites', 'Some of the risen carry a modifier you can read at a glance, and drop more coins'),
  lap: int(1, 0, 99, '', 'From lap', 'Elites rise from this lap on (0: the first time through; 1: the second)'),
  wave: int(0, 0, 9999, '', 'From wave', 'Or from this wave on, as players count it (0: by lap alone), whichever comes first'),
  chance: num(0.12, 0, 1, '', 'Chance', 'The share of ordinary arrivals that rise as elites, the first lap they can'),
  grow: num(0.04, 0, 1, '', 'More each lap', 'Added to the chance each lap after that'),
  chanceMost: num(0.4, 0, 1, '', 'Most chance', 'The chance never goes past this'),
  perWave: int(4, 0, 200, '', 'Most a wave', 'Elites in one wave, at most'),
  health: num(1.5, 1, 20, '×', 'Tougher', 'An elite\'s health, times this'),
  coins: num(3, 1, 20, '×', 'Coins', 'An elite\'s kill throws its coins times this'),
  boss: bool(false, 'The boss too', 'The boss may rise as an elite (never, unless this is on)'),
  kinds: list({ type: ref('enemies', 'type', 'An enemy id from spec.forge.enemies') }, 'kind', { min: 0, max: 16 }),
  burning: obj({
    ...look('#ff6a1a', 2.6, '#ffffff', 'Burning', 'Its blows set you alight'),
    dps: num(5, 0, 200, 'hp/s', 'Burn', 'Damage a second while a player burns'),
    seconds: num(3, 0.5, 20, 's', 'Burns for', 'How long a blow sets a player alight; another blow starts it again'),
    tick: num(0.5, 0.1, 2, 's', 'Tick', 'Seconds between two bites of the burn'),
    patch: obj({
      seconds: num(3, 0, 20, 's', 'lasts', 'How long the fire it leaves where it falls burns (0: none)'),
      radius: num(1.4, 0.3, 6, 'm', 'radius', 'How wide that fire is'),
      dps: num(6, 0, 200, 'hp/s', 'burn', 'Damage a second to whoever stands in it (they burn on for a second after)'),
    }, 'Fire where it falls'),
    sounds: obj({
      ignite: sound('elite-ignite', 'arrow-whoosh', 'A player is set alight'),
      burn: sound('elite-burn', 'hit-soft', 'A burn bites'),
    }),
  }, 'Burning'),
  armoured: obj({
    ...look('#8fb4dc', 1.4, '#5a5e66', 'Armoured', 'Iron-hard: it takes half of every hit'),
    damage: num(0.5, 0.05, 1, '×', 'Damage taken', 'The share of every hit it takes'),
    knock: num(0.35, 0, 1, '×', 'Knocked about', 'How much hits stagger, down and flinch it, against an ordinary one'),
  }, 'Armoured'),
  splitting: obj({
    ...look('#a4ff4f', 2.2, '#ffffff', 'Splitting', 'Fell it and two smaller ones crawl out'),
    into: ref('enemies', 'Splits into', 'The kind that crawls out (empty: its own kind)'),
    count: int(2, 1, 6, '', 'How many', 'How many crawl out'),
    health: num(0.35, 0.05, 1, '×', 'Their health', 'Each one\'s health, as a share of the elite\'s most'),
    scale: num(0.7, 0.3, 1, '×', 'Their size', 'Each one\'s size against its kind\'s own'),
    sounds: obj({ split: sound('elite-split', 'splash', 'A splitting elite bursts') }),
  }, 'Splitting'),
  fast: obj({
    ...look('#c9a4ff', 2.2, '#ffffff', 'Fast', 'Quicker on its feet and in its blows'),
    speed: num(1.45, 1, 3, '×', 'Speed', 'How much faster it moves'),
    attack: num(1.35, 1, 3, '×', 'Attack speed', 'How much faster it attacks: shorter tells, cooldowns and recoveries'),
  }, 'Fast'),
};

export const owner = 'forge-ai (wave 7, track E)';
