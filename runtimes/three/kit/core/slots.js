// gf-three core: slot declarations for the round, the seats, the rules' own numbers and the mechanics' params
// (CONTRACT §2.2). Pure data: no three.js, no DOM, so tools/slots.mjs imports it in Node.
//
// A provider exports `slotsFor(cfg)` → gf-assets/1 slot objects. cfg = { game, look, world, characters, files }
// (the parsed config/*.json and the files under assets/). `rank` (higher stays main longest) is used only to keep the
// main tier within about 40 and is dropped from assets.json.

export const humanize = k => String(k).replace(/[-_.]+/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/\s+/g, ' ').trim().replace(/^./, c => c.toUpperCase()).replace(/ ([A-Z])(?=[a-z])/g, (m, c) => ' ' + c.toLowerCase());
export const slug = k => String(k).replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'x';
const esc = k => String(k).replace(/~/g, '~0').replace(/\//g, '~1');

/** A value slot for one number, boolean or string in a JSON file. */
export function valueSlot({ id, label, group, file, pointer, value, tier = 'main', facet = 'gameplay', description, rank = 50, constraints = null }) {
  const type = typeof value === 'boolean' ? 'boolean' : typeof value === 'number' ? (Number.isInteger(value) ? 'integer' : 'number') : /^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(String(value)) ? 'color' : Array.isArray(value) || (value && typeof value === 'object') ? 'json' : 'text';
  const s = { id, label, group, type, source: { file, pointer }, tier, facet: type === 'color' ? 'look' : facet, rank };
  if (description) s.description = description;
  if (constraints) s.constraints = constraints;
  else if (type === 'number' || type === 'integer') s.constraints = numberRange(value);
  else if (type === 'text') s.constraints = { maxLength: 200 };
  return s;
}
function numberRange(v) {
  if (v === 0) return { min: 0, max: 10 };
  const a = Math.abs(v);
  return { min: v < 0 ? -a * 4 : 0, max: Math.max(1, a * 4) };
}

export function slotsFor(cfg) {
  const g = cfg.game ?? {}, out = [];
  const G = 'config/game.json';
  // a world (CONTRACT §9) has no rounds: no length to tune; nor has a flow with no round clock (turns, endless) unless capped
  if (g.round?.mode !== 'world' && !(g.round?.flow && g.round?.seconds == null)) out.push({ id: 'round.seconds', group: 'rules', label: 'Round length', type: 'integer', source: { file: G, pointer: '/round/seconds' }, constraints: { min: 30, max: 900, unit: 's' }, tier: 'main', facet: 'gameplay', rank: 88, description: 'How long a round lasts, in seconds' });
  out.push({ id: 'round.countdown', group: 'rules', label: 'Countdown before a round', type: 'integer', source: { file: G, pointer: '/round/countdown' }, constraints: { min: 0, max: 10, unit: 's' }, tier: 'advanced', facet: 'gameplay', rank: 20 });
  out.push({ id: 'players.max', group: 'rules', label: 'Players in a round', type: 'integer', source: { file: G, pointer: '/players/max' }, constraints: { min: 1, max: 8 }, tier: 'main', facet: 'gameplay', rank: 80, description: 'Seats in a round; bots fill the empty ones' });
  out.push({ id: 'players.bots', group: 'rules', label: 'Fill empty seats with bots', type: 'boolean', source: { file: G, pointer: '/players/bots' }, tier: 'advanced', facet: 'gameplay', rank: 30 });
  out.push({ id: 'players.bot-names', group: 'text', label: 'Bot names', type: 'json', source: { file: G, pointer: '/players/botNames' }, tier: 'advanced', facet: 'text', rank: 10 });
  for (const [k, v] of Object.entries(g.rules?.params ?? {})) {
    out.push(valueSlot({ id: `rules.${slug(k)}`, label: humanize(k), group: 'rules', file: G, pointer: `/rules/params/${esc(k)}`, value: v, rank: 86, description: g.rules?.scoring ? `Scoring: ${g.rules.scoring}` : undefined }));
  }
  // the flow's own numbers and words (kit/loops/<id> → params; config/game.json → round.params): each a round.* slot
  for (const [k, v] of Object.entries(g.round?.params ?? {})) {
    out.push(valueSlot({ id: `round.${slug(k)}`, label: humanize(k), group: 'rules', file: G, pointer: `/round/params/${esc(k)}`, value: v, rank: 84 }));
  }
  // fair play (kit/core/fair.js, CONTRACT §6c): kit-owned, on by default; create writes config/game.json → fair
  if (g.fair && typeof g.fair === 'object') {
    const f = (k, id, label, type, extra) => { if (k in g.fair) out.push({ id: `fair.${id}`, group: 'mechanics', label, type, source: { file: G, pointer: `/fair/${k}` }, facet: type === 'color' ? 'look' : 'gameplay', ...extra }); };
    f('downSeconds', 'down-seconds', 'Seconds down after a knock', 'number', { tier: 'main', rank: 78, constraints: { min: 0.6, max: 8, unit: 's' }, description: 'From a knock to walking again, the tumble and the get-up included. Nobody can hit a player who is down' });
    f('protectSeconds', 'protect-seconds', 'Protection after getting up', 'number', { tier: 'main', rank: 74, constraints: { min: 0, max: 10, unit: 's' }, description: 'Seconds a player who just got up (or respawned) can\'t be hit; their body shimmers' });
    f('botSkill', 'bot-skill', 'Bot skill', 'number', { tier: 'main', rank: 72, constraints: { min: 0, max: 1 }, description: '0 easy, 1 sharp: how fast bots react and how well they aim (0.35 is friendly)' });
    f('startGrace', 'start-grace', 'No hits at the start of a round', 'number', { tier: 'advanced', rank: 32, constraints: { min: 0, max: 30, unit: 's' }, description: 'Seconds after Go when no hit counts and bots hold fire' });
    f('botsPerTarget', 'bots-per-target', 'Bots that may fight one player at once', 'integer', { tier: 'advanced', rank: 28, constraints: { min: 0, max: 8 }, description: '0: no limit' });
    f('protectColor', 'protect-color', 'Protection shimmer colour', 'color', { tier: 'advanced', rank: 36, description: 'The glow on a protected player\'s body' });
    f('respawnFar', 'respawn-far', 'Respawn far from the others', 'boolean', { tier: 'advanced', rank: 26 });
    f('on', 'on', 'Fair play (knocked players get up fast and are protected)', 'boolean', { tier: 'advanced', rank: 34, description: 'Off only when the creator asks for it' });
  }
  // a mechanic's params: declared here until its module (track K2) lands and declares its own
  for (const [i, m] of (g.mechanics ?? []).entries()) {
    if (cfg.mechanicSlots?.has?.(m.id)) continue;
    for (const [k, v] of Object.entries(m.params ?? {})) {
      const isNum = typeof v === 'number';
      out.push(valueSlot({ id: `mechanic.${m.id}.${slug(k)}`, label: `${humanize(m.as || m.id)}: ${humanize(k).toLowerCase()}`, group: 'mechanics', file: G, pointer: `/mechanics/${i}/params/${esc(k)}`, value: v, tier: isNum ? 'main' : 'advanced', rank: isNum ? 60 : 15 }));
    }
  }
  // gameplay props (thrown, carried, collected): their size in metres; the model itself is a prop.* slot (world)
  for (const [i, p] of (g.props ?? []).entries()) {
    if (typeof p.size === 'number') out.push(valueSlot({ id: `prop.${p.name}.size`, label: `${humanize(p.name)} size`, group: 'props', file: G, pointer: `/props/${i}/size`, value: p.size, tier: 'advanced', facet: 'gameplay', rank: 25, constraints: { min: 0.05, max: 5, unit: 'm' } }));
    if (Number.isInteger(p.count)) out.push(valueSlot({ id: `prop.${p.name}.count`, label: `How many ${p.name}s`, group: 'props', file: G, pointer: `/props/${i}/count`, value: p.count, tier: 'main', rank: 62, constraints: { min: 1, max: 60 } }));
  }
  return out;
}
