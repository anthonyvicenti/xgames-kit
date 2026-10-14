// spec.forge.cards[]: the reward cards, and spec.forge.deal: how a reward is dealt and shown (owner: forge-feel for
// what a card does and for the deal, research/gf-forge/core/forge-feel/src/cards.rs; the reward screen is the kit's,
// gf/forge/cards.js). Timings are the measured feel targets (research/rust-engine/feel-targets.md moments 2, 3 and 17).
// A card's colour is its rarity's unless it sets its own.
//
// What a card does (since wave 2 the core runs it; a card applies to the one player who takes it, and cards stack):
//   kind "upgrade"  changes one table value for that player: `stat` is the value's path in spec.forge, then
//                   (value + add) × mul. A second value (`stat2`, `add2`, `mul2`) makes a trade ("hits harder, reloads
//                   slower"). Paths: "player.<value>" (walk, jump, health, armor, evade.cooldown, evade.distance,
//                   stamina.max, stamina.regen, stamina.evadeCost, revive.time, …: any number of the player table) and
//                   "weapons.<id>.<value>" (damage, critMultiplier, fireInterval, magazine, reload, pellets, spread,
//                   range, knockback, kick.pitch, melee.reach, …), or "weapons.*.<value>" for every weapon in the table.
//   kind "weapon"   gives the weapon `weapon` (a weapons id) and draws it; a player who holds it is not dealt the card.
//   kind "heal"     gives back `add` hit points and `share` of full health, at once.
//   kind "perk"     (wave 7: builds) changes how the player fights: `perk` names what the core does (PERKS below) and
//                   `power` holds its numbers (the perk's own defaults fill what a row leaves out). A perk card may
//                   carry a trade too (`stat`, `stat2`: "hits harder, holds less health"). Perks run on the host for
//                   the player who holds them; copies of a kind stack (PERK_STACKING).
// `stack` is how many copies one player may hold (a card at its stack is not dealt to them again).
// `family` (wave 7) puts a card in one of spec.forge.families: holding a family's `at` cards (copies count) unlocks its
// set bonus once (a perk, usually stronger), and the deal leans toward families a player has started (deal.familyBias).
import { num, int, color, text, words, choice, ref, sound, obj, id } from './fields.js';

export const RARITIES = ['common', 'rare', 'epic'];
export const RARITY_COLORS = { common: '#e4d2b7', rare: '#5b8cff', epic: '#ffcf4a' };

/** A perk's numbers (`power`): each perk reads some of them (PERKS[id].show); 0 is "none" for the rest. */
export const PERK_VALUES = {
  radius: num(0, 0, 30, 'm', 'Radius', 'How far it reaches'),
  damage: num(0, 0, 10000, '', 'Damage', 'Damage dealt (the aura: a second)'),
  share: num(0, 0, 10, '', 'Share', 'A share: of a hit\'s damage (blast), of the damage added at no health (fury), of full health (lifesteal)'),
  heal: num(0, 0, 10000, 'hp', 'Health back', 'Hit points given back'),
  knockback: num(0, 0, 60, 'm/s', 'Knockback', 'How hard it throws enemies back'),
  cooldown: num(0, 0, 60, 's', 'Cooldown', 'Seconds before it comes again'),
  seconds: num(0, 0, 60, 's', 'Seconds', 'How long it lasts'),
  speed: num(0, 0, 5, '×', 'Speed', 'The share added to the walk'),
  rate: num(0, 0, 5, '×', 'Fire rate', 'The share added to the rate of fire'),
};

/**
 * The perks (kind "perk", and a family's set bonus; forge-feel perks.rs runs them, fixtures/feel/data/perks.json holds
 * the two to these defaults). `power`: its numbers when a row says nothing; `show`: the numbers it reads, as the
 * inspector names them ([label, unit]; unit '%' shows a share as a percentage); `sound`: its sound id, `preset` the
 * gf-audio preset assets.json gives it (fury has none: it is in every hit, never an event of its own).
 *   blast      a shot that lands explodes: `share` of its damage to every other enemy within `radius`
 *   burst      a kill bursts: `damage` to every enemy within `radius` of it (a burst's kills burst too)
 *   shockwave  hurt, the player throws out a ring: `damage` and `knockback` within `radius`, again after `cooldown`
 *   thorns     an enemy that strikes the player from within `radius` takes `damage`
 *   aura       enemies within `radius` burn: `damage` a second (in two ticks a second)
 *   fury       the player's hits do up to `share` more as their health drops (× the share of health missing)
 *   lifesteal  each kill gives back `heal` hit points and `share` of full health
 *   ambush     after an evade the next shot (within `seconds`) is a sure critical
 *   rush       after a kill, for `seconds`: `speed` more walk and `rate` more fire
 */
export const PERKS = {
  blast: { label: 'Shots explode', power: { radius: 2.5, share: 0.35 }, show: { radius: ['Blast radius', 'm'], share: ['Splash, of the hit', '%'] }, sound: 'perk-blast', preset: 'explosion-small' },
  burst: { label: 'Kills burst', power: { radius: 3, damage: 18 }, show: { radius: ['Burst radius', 'm'], damage: ['Burst damage', ''] }, sound: 'perk-burst', preset: 'explosion-small' },
  shockwave: { label: 'A shockwave when hurt', power: { radius: 4, damage: 20, knockback: 9, cooldown: 4 }, show: { radius: ['Shockwave radius', 'm'], damage: ['Shockwave damage', ''], knockback: ['Throws back', 'm/s'], cooldown: ['Ready again after', 's'] }, sound: 'perk-shockwave', preset: 'explosion-big' },
  thorns: { label: 'Thorns', power: { radius: 2.8, damage: 12 }, show: { damage: ['Back to each striker', ''], radius: ['Strikers within', 'm'] }, sound: 'perk-thorns', preset: 'hit-crunch' },
  aura: { label: 'A burning aura', power: { radius: 3.5, damage: 8 }, show: { radius: ['Aura radius', 'm'], damage: ['Burn a second', ''] }, sound: 'perk-aura', preset: 'hit-soft' },
  fury: { label: 'Damage grows as health drops', power: { share: 0.8 }, show: { share: ['More damage at no health', '%'] }, sound: '', preset: null },
  lifesteal: { label: 'Health back on a kill', power: { heal: 4, share: 0.02 }, show: { heal: ['Health a kill', 'hp'], share: ['And of full health', '%'] }, sound: 'perk-lifesteal', preset: 'heal' },
  ambush: { label: 'A sure critical after an evade', power: { seconds: 2.5 }, show: { seconds: ['Ready for', 's'] }, sound: 'perk-ambush', preset: 'arrow-whoosh' },
  rush: { label: 'Faster after a kill', power: { seconds: 3, speed: 0.25, rate: 0.3 }, show: { seconds: ['For', 's'], speed: ['Faster walk', '%'], rate: ['Faster fire', '%'] }, sound: 'perk-rush', preset: 'powerup' },
};
export const PERK_IDS = Object.keys(PERKS);
/** How copies of one perk add up (two blast cards, or a blast card and a blast set bonus): the largest radius, the
 *  shortest cooldown (of those that have one), every other number summed (perks.rs `Perk::stack`). */
export const PERK_STACKING = { radius: 'largest', cooldown: 'shortest', other: 'sum' };
/** A perk row's `power` and `sound` as filled: the perk's own defaults (only the numbers it reads). */
export const perkBase = perk => (PERKS[perk] ? { power: { ...PERKS[perk].power }, sound: PERKS[perk].sound } : null);
/** Every perk sound id → its gf-audio preset (index.js soundsOf), and the set bonus's. */
export const PERK_SOUNDS = { ...Object.fromEntries(PERK_IDS.filter(k => PERKS[k].sound).map(k => [PERKS[k].sound, PERKS[k].preset])), 'set-bonus': 'level-up' };

export const fields = {
  id: id(),
  name: words('', 'Name', 'The card\'s title', 40),
  text: words('', 'Text', 'What it does, in a line (the inspector adds the exact numbers)', 160),
  rarity: choice('common', RARITIES, 'Rarity', 'common, rare or epic: its colour and how often it is dealt'),
  color: color('#e4d2b7', 'Colour', 'Its edge and glow (moment 17: the rarity\'s colour; a slot)'),
  kind: choice('upgrade', ['weapon', 'upgrade', 'heal', 'perk'], 'Kind', 'weapon (gives a weapon), upgrade (changes a value), heal, perk (changes how you fight)'),
  weapon: ref('weapons', 'Weapon', 'For kind weapon: a weapon id from spec.forge.weapons'),
  stat: text('', 'Value', 'For kind upgrade: the table value it changes, as a path ("player.walk", "weapons.sidearm.damage", "weapons.*.reload")', 80),
  add: num(0, -10000, 10000, '', 'Add', 'Added to the value (for a heal: hit points given back)'),
  mul: num(1, 0, 100, '×', 'Multiply', 'The value is multiplied by this (after the add)'),
  stat2: text('', 'Second value', 'A second table value the same card changes (a trade), as a path', 80),
  add2: num(0, -10000, 10000, '', 'Add (second)', 'Added to the second value'),
  mul2: num(1, 0, 100, '×', 'Multiply (second)', 'The second value is multiplied by this (after the add)'),
  share: num(0, 0, 1, '', 'Heal share', 'For kind heal: the share of full health given back (with `add` hit points)'),
  stack: int(3, 1, 9, '', 'Stack', 'How many of it one player may hold'),
  weight: num(1, 0, 100, '', 'Deal weight', 'How often it is dealt, against the others (times its rarity\'s weight)'),
  family: ref('families', 'Family', 'A families id: holding that family\'s `at` cards unlocks its set bonus'),
  perk: choice('none', ['none', ...PERK_IDS], 'Perk', 'For kind perk: what the core does (blast, burst, shockwave, thorns, aura, fury, lifesteal, ambush, rush)'),
  power: obj(PERK_VALUES, 'Perk numbers'),
  sound: sound('', 'hit-soft', 'The perk\'s sound'),
};

/**
 * spec.forge.families[] (wave 7: builds; the creator, 2026-10-12: "Families + set bonuses"): a family of cards with a
 * plain label a player reads (Tank, Blast, Glass Cannon, Swift), and its set bonus: a perk, unlocked once when a player
 * holds `at` of its cards (copies count). Rule event `set-bonus` {entity: the player, a: the family's row}.
 */
export const familyFields = {
  id: id(),
  name: words('', 'Name', 'The family\'s own name (on the reward screen\'s badge)', 40),
  label: words('', 'Label', 'The plain word for the build it makes: Tank, Blast, Glass Cannon, Swift', 24),
  color: color('#c9a26b', 'Colour', 'Its badge, pips and banner'),
  text: words('', 'Text', 'What the family is about, in a line', 160),
  at: int(3, 1, 9, '', 'Cards for the bonus', 'Holding this many of its cards (copies count) unlocks the set bonus, once a run'),
  sound: sound('set-bonus', 'level-up', 'The set bonus unlocked'),
  bonus: obj({
    name: words('', 'Bonus name', 'The set bonus\'s name', 40),
    text: words('', 'Bonus text', 'What the set bonus does, in a line', 160),
    perk: choice('none', ['none', ...PERK_IDS], 'Bonus perk', 'What the core does once the set is held (none: the bonus is only said)'),
    power: obj(PERK_VALUES, 'Bonus numbers'),
    sound: sound('', 'hit-soft', 'The bonus perk\'s sound'),
  }, 'Set bonus'),
};

/** The deal (moments 2 and 17): the same 140 ms rhythm everywhere; the reward's time and each rarity's weight. */
export const deal = {
  tick: num(0.14, 0.02, 1, 's', 'Deal rhythm', 'Seconds between two cards dealt (moments 2, 17: about 140 ms)'),
  flip: num(0.2, 0.02, 1, 's', 'Flip time', 'Seconds a card takes to turn over (moment 17: 200-230 ms; moment 2\'s opening hand: 120-150 ms)'),
  flipEvery: num(0.215, 0.02, 1, 's', 'Flip stagger', 'Seconds between two flips starting (moment 17: about 215 ms; moment 2: about 175 ms)'),
  hoverLift: num(0.01, 0, 0.2, '', 'Hover lift', 'A card rises this share of the screen height under the pointer (moment 3: about 1%)'),
  pickLift: num(0.033, 0, 0.3, '', 'Pick lift', 'The chosen card rises this share (moment 3: about 3.3%)'),
  seconds: num(20, 3, 600, 's', 'Reward time', 'Seconds a reward stays open: when everyone has picked or passed, or at its end, the fight goes on (the undecided pass)'),
  linger: num(0.6, 0, 5, 's', 'After the last choice', 'Seconds the reward stays up after everyone chose (the chosen card\'s lift)'),
  common: num(60, 0, 1000, '', 'Common weight', 'How often a common card is dealt, against the other rarities'),
  rare: num(30, 0, 1000, '', 'Rare weight', 'How often a rare card is dealt'),
  epic: num(10, 0, 1000, '', 'Epic weight', 'How often an epic card is dealt'),
  familyBias: num(2, 0, 20, '×', 'Family lean', 'A card of a family the player already holds is dealt this many times as often (1: no lean), so a build takes shape over a run'),
  text: obj({
    title: words('Choose one', 'title', 'The reward\'s heading', 60),
    wave: words('Wave {wave} is cleared', 'wave line', 'Under the heading; {wave} is the wave\'s number', 80),
    take: words('Take {name}', 'take button', 'The button that takes the chosen card; {name} is the card\'s name', 60),
    pick: words('Choose a card', 'take button, nothing chosen', 'The same button before a card is chosen', 60),
    pass: words('Pass', 'pass button', 'Always allowed', 30),
    waiting: words('Waiting for {names}', 'waiting line', 'After this player chose, while friends still do; {names} are theirs', 80),
    choosing: words('choosing', 'state: choosing', 'Beside a player\'s name', 30),
    picked: words('chose', 'state: picked', 'Beside a player\'s name', 30),
    passed: words('passed', 'state: passed', 'Beside a player\'s name', 30),
    seconds: words('{n} s', 'countdown', 'The seconds left; {n} is the number', 20),
    now: words('now', 'inspector: now', 'Over the value before the card', 20),
    then: words('with it', 'inspector: with the card', 'Over the value after the card', 20),
    weapon: words('A new weapon in your hands', 'inspector: a weapon card', 'The inspector\'s line for a weapon card', 80),
    heal: words('Health', 'inspector: a heal', 'The inspector\'s label for a heal', 30),
    held: words('You can hold up to {max} of this card (you hold {n})', 'inspector: copies held', 'How many of the card this player holds; {n} and {max}', 80),
    common: words('Common', 'rarity: common', '', 20),
    rare: words('Rare', 'rarity: rare', '', 20),
    epic: words('Epic', 'rarity: epic', '', 20),
    keys: words('1 2 3 choose · Enter takes · Esc passes', 'key help', 'The line under the cards for a keyboard', 80),
    family: words('{label} {n}/{at}', 'family badge', 'A card\'s family on its face: {label} (Tank), {name} (the family\'s own name), {n} held and {at} for the bonus', 40),
    unlocks: words('Completes the {label} set: {bonus}', 'inspector: completes a set', 'The inspector\'s line for a card that unlocks a set bonus; {label}, {bonus}', 80),
    toward: words('{label} set: you hold {n} of {at} {label} cards, this one makes {next}', 'inspector: toward a set', 'The inspector\'s line for a family card (what the badge\'s n/at counts); {label}, {n}, {next}, {at}', 100),
    setBonus: words('Hold {at} {label} cards: {bonus}. {text}', 'inspector: the set bonus', 'Under the family line: what holding the set gives; {at}, {label}, {bonus} (its name), {text} (what it does)', 220),
    perk: words('Perk', 'inspector: a perk', 'Over a perk\'s numbers', 30),
    bonus: words('{bonus}', 'set bonus banner', 'The banner when this player completes a set; {bonus} (its name), {label}, {name}', 60),
    bonusSub: words('{label} set bonus · {text}', 'set bonus banner, second line', '{label}, {text} (what it does)', 120),
    friendBonus: words('{player}: {bonus}', 'a friend\'s set bonus', 'The line when a friend completes a set; {player}, {bonus}, {label}', 80),
  }, 'Reward screen words'),
  sounds: obj({
    tick: sound('card-deal', 'click', 'A card dealt (moments 2, 17: a 0.2 s tick each)'),
    flip: sound('card-flip', 'hover', 'A card turning over'),
    chime: sound('card-reveal', 'gem', 'The reveal chime as the first flip begins (moments 2, 17: one 1.44 s chime)'),
    pick: sound('card-pick', 'confirm', 'A card chosen (moment 3: a 0.36 s click)'),
    pass: sound('card-pass', 'cancel', 'The reward passed'),
  }),
};

export const owner = 'forge-feel (cards.rs: effects, the deal, the reward; perks.rs: perks, families and set bonuses) and the kit\'s reward screen (gf/forge/cards.js) and build line (gf/forge/builds.js)';
