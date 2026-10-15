// A registry for tests and the dry run: the shape of the real one (builder/loop/registry.mjs lists the calls), filled
// with a small, made-up catalog. Nothing in the loop knows these ids; the tests prove the loop reads them as data.
const runtimes = [
  { id: 'three', rank: 1, status: { exists: true, tested: true, open: true }, defaultKind: 'silly', limits: 'WebGL2: desktop, phones and inside a post on X',
    profiles: [
      { id: 'standard-3d', dimension: '3d', cameras: ['third', 'first', 'top', 'follow', 'orbit'], devices: ['desktop', 'phone', 'x-post'], graphics: ['standard'], capabilities: ['characters', 'physics-bodies', 'voxel-world', 'projectiles'] },
      { id: 'scenic-3d', dimension: '3d', cameras: ['follow', 'third'], devices: ['desktop', 'phone'], graphics: ['standard', 'stylised-scenic'], capabilities: ['characters', 'terrain', 'melee', 'projectiles'] },
      { id: 'flat-2d', dimension: '2d', cameras: ['top', 'side'], devices: ['desktop', 'phone', 'x-post'], graphics: ['standard'], capabilities: ['tilemap', 'sprites'] },
    ] },
  { id: 'forge', rank: 2, status: { exists: true, tested: true, open: true }, defaultKind: 'dark', limits: 'phones first, WebGPU or WebGL2; co-op for 2 to 4',
    profiles: [{ id: null, dimension: '3d', cameras: ['first', 'close'], devices: ['phone', 'desktop'], graphics: ['standard'], capabilities: ['characters', 'melee', 'first-person-weight', 'projectiles'] }] },
  { id: 'vista', rank: 3, status: { exists: true, tested: true, open: true }, defaultKind: 'calm', limits: 'WebGPU on a desktop only',
    profiles: [{ id: null, dimension: '3d', cameras: ['third', 'follow', 'orbit'], devices: ['desktop'], graphics: ['standard', 'photoreal'], capabilities: ['photoreal-water', 'boats', 'characters'] }] },
  { id: 'godot', rank: 4, status: { exists: true, tested: false, open: false }, defaultKind: 'pixel', limits: 'WebGL2 compatibility rendering',
    profiles: [{ id: '2d', dimension: '2d', cameras: ['top', 'side'], devices: ['desktop', 'phone'], graphics: ['standard'], capabilities: ['tilemap', 'sprites'] }] },
];
const loops = [
  { id: 'round', acts: 'together-timed', describe: 'everyone plays at once in one timed round', status: { open: true } },
  { id: 'run', acts: 'levels-in-order', describe: 'a run through levels in order, ending at the last or a boss', status: { open: true } },
  { id: 'world', acts: 'shared-place-stays', describe: 'one shared place that stays, no rounds', status: { open: true } },
  { id: 'turns', acts: 'one-at-a-time', describe: 'one player acts at a time, in order, with a clock per turn', status: { open: true }, runtimes: ['three'] },
  { id: 'endless', acts: 'until-you-fall', describe: 'play until you fall; the score climbs', status: { open: true } },
  { id: 'saved', acts: 'progress-kept', describe: 'progress kept from one session to the next', status: { open: false }, near: ['world'] },
];
const kinds = [
  { id: 'silly', describe: 'toon low-poly, pastel, flopping bodies', proven: ['three/standard-3d'], packs: ['beans', 'kenney-mini'] },
  { id: 'blocky', describe: 'flat-shaded blocks and block avatars', proven: ['three/standard-3d'], packs: ['blocks'] },
  { id: 'lofi', describe: 'low polygons, dithering, cheap on purpose', proven: ['forge'], packs: [] },
  { id: 'scenic', describe: 'painterly stylised 3D, living grass, fog, a day cycle', proven: ['three/scenic-3d'], packs: ['folio-nature'] },
  { id: 'dark', describe: 'grim fantasy: moonlit ruins, embers, ash', proven: ['forge'], packs: ['forge-ruins'] },
  { id: 'calm', describe: 'photoreal light, sea and sky', proven: ['vista'], packs: [] },
  { id: 'pixel', describe: '2D pixel art, 16 texels a metre', proven: ['three/flat-2d'], packs: ['kenney-pixel'] },
  { id: 'drawn', describe: '2D hand-drawn, 128 texels a metre', proven: ['three/flat-2d'], packs: [] },
];
const mechanics = [
  { id: 'tag', describe: 'roles that pass on contact', runtimes: ['three'], capabilities: ['characters'] },
  { id: 'shove', describe: 'push other players', runtimes: ['three', 'forge'], capabilities: ['physics-bodies'] },
  { id: 'waves', describe: 'enemies in waves', runtimes: ['three', 'forge'], capabilities: ['characters'] },
  { id: 'melee', describe: 'swing and hit', runtimes: ['three', 'forge'], capabilities: ['melee'] },
  { id: 'boss', describe: 'one big enemy at the end', runtimes: ['three', 'forge'], capabilities: ['characters'] },
  { id: 'race', describe: 'first to the line', runtimes: ['three'], capabilities: [] },
  { id: 'build', describe: 'place and break blocks', runtimes: ['three'], capabilities: ['voxel-world'] },
];
const capabilities = ['characters', 'physics-bodies', 'voxel-world', 'projectiles', 'terrain', 'melee', 'tilemap', 'sprites', 'first-person-weight', 'photoreal-water', 'boats', 'grappling-hook']
  .map(id => ({ id, describe: id.replaceAll('-', ' ') }));
const vocabulary = {
  devices: ['desktop', 'phone', 'x-post'], graphics: ['standard', 'stylised-scenic', 'photoreal'], cameras: ['first', 'third', 'top', 'side', 'follow', 'orbit', 'close'],
  dimensions: ['2d', '3d'], together: ['versus', 'coop', 'teams', 'turns', 'own-board', 'solo'], bodies: ['character', 'board', 'vehicle', 'cursor', 'cards', 'boat'], defaultDevices: ['desktop', 'phone'],
};
const gates = s => Object.fromEntries(['A', 'B', 'C', 'D', 'E', 'F'].map(g => [g, { measures: [`${g}1`], skips: s[g] ?? [] }]));
const manifests = {
  runtime: {
    'three/standard-3d': { id: 'three/standard-3d', describe: 'three.js, the standard 3D profile', note: ['MARK-RUNTIME-THREE: rules.js runs on every copy; the host owns shared state.'], traps: ['never call requestPointerLock yourself'], gates: gates({}) },
    'three/scenic-3d': { id: 'three/scenic-3d', describe: 'three.js, scenic', note: ['MARK-RUNTIME-SCENIC'], gates: gates({}) },
    'three/flat-2d': { id: 'three/flat-2d', describe: 'three.js on a plane', note: ['MARK-RUNTIME-FLAT'], gates: gates({}) },
    forge: { id: 'forge', describe: 'the Rust core, close camera', note: ['MARK-RUNTIME-FORGE: tables drive the waves; rules.js reads them.'], gates: gates({ C: ['38 every event answered (no event log yet)'] }) },
    vista: { id: 'vista', describe: 'the WebGPU sea core', note: ['MARK-RUNTIME-VISTA'], gates: gates({ C: ['10', '38'], D: ['12'] }) },
  },
  loop: Object.fromEntries(loops.map(l => [l.id, { id: l.id, describe: l.describe, note: [`MARK-LOOP-${l.id.toUpperCase()}`], promise: l.id === 'run' ? 'A run goes through its levels in order and ends at the boss, won or lost, and plays again.' : undefined }])),
  mechanic: Object.fromEntries(mechanics.map(m => [m.id, { id: m.id, describe: m.describe, note: [`MARK-MECH-${m.id.toUpperCase()}: ${m.describe}.`], traps: [`a trap of ${m.id}`], events: [{ name: `on${m.id[0].toUpperCase()}${m.id.slice(1)}`, on: 'host', args: '{ who }', when: `a ${m.id} happens` }], sync: { owner: 'host', how: `the host decides every ${m.id}` } }])),
  kind: Object.fromEntries(kinds.map(k => [k.id, { id: k.id, describe: k.describe, note: [`MARK-KIND-${k.id.toUpperCase()}`], packs: k.packs }])),
  pack: { beans: { id: 'beans' }, 'kenney-mini': { id: 'kenney-mini' }, blocks: { id: 'blocks' }, 'folio-nature': { id: 'folio-nature' }, 'forge-ruins': { id: 'forge-ruins' }, 'kenney-pixel': { id: 'kenney-pixel' } },
};

export function fakeRegistry({ open = {} } = {}) {
  const rts = runtimes.map(r => (r.id in open ? { ...r, status: { ...r.status, open: open[r.id] } } : r));
  return {
    runtimes: async () => structuredClone(rts),
    loops: async () => structuredClone(loops),
    kinds: async () => structuredClone(kinds),
    mechanics: async () => structuredClone(mechanics),
    capabilities: async () => structuredClone(capabilities),
    vocabulary: async () => structuredClone(vocabulary),
    manifest: async (type, id) => structuredClone(manifests[type]?.[id] ?? null),
    async compat(limits) {
      const out = {};
      for (const r of rts.filter(x => x.status.open)) for (const p of r.profiles) {
        const misses = [];
        const devs = [limits.devices ?? []].flat().filter(d => !p.devices.includes(d));
        if (devs.length) misses.push({ limit: 'devices', need: limits.devices, has: p.devices });
        if (limits.graphics && !p.graphics.includes(limits.graphics)) misses.push({ limit: 'graphics', need: limits.graphics, has: p.graphics });
        if (limits.camera && !p.cameras.includes(limits.camera)) misses.push({ limit: 'camera', need: limits.camera, has: p.cameras });
        if (limits.dimension && p.dimension !== limits.dimension) misses.push({ limit: 'dimension', need: limits.dimension, has: p.dimension });
        out[p.id ? `${r.id}/${p.id}` : r.id] = { runtime: r.id, profile: p.id, open: true, fits: !misses.length, misses, lacks: (limits.needs ?? []).filter(c => !p.capabilities.includes(c)) };
      }
      return { ok: Object.values(out).some(x => x.fits), problems: [], findings: [], runtimes: out };
    },
  };
}

/** A ledger that passes: a first-person co-op wave fight on phones (the prompt is in PROMPT). */
export const PROMPT = 'A co-op zombie defence on my phone where me and my friends hold the gate in first person with real weight, waves of zombies, a boss at the end, and a grappling hook to get onto the walls. Grim and dark, like moonlit ruins.';
export function goodLedger() {
  return {
    rows: [
      { id: 'hold', about: 'action', what: 'Players hold a gate against attackers', words: 'hold the gate', home: 'exists', by: 'mechanic:waves', core: true },
      { id: 'waves', about: 'thing', what: 'Zombies come in waves', words: 'waves of zombies', home: 'exists', by: 'mechanic:waves', core: true },
      { id: 'boss', about: 'thing', what: 'A boss comes at the end', words: 'a boss at the end', home: 'exists', by: 'mechanic:boss', core: true },
      { id: 'hook', about: 'action', what: 'A grappling hook pulls a player onto the walls', words: 'a grappling hook to get onto the walls', home: 'build', how: 'a module in src/hook.js that casts a ray and pulls the body', where: 'module', needs: ['grappling-hook'], core: true },
      { id: 'acts', about: 'acts', what: 'A run of waves ending at a boss', words: 'a boss at the end', acts: 'levels-in-order', home: 'exists' },
      { id: 'view', about: 'perspective', what: 'First person, with weight', words: 'in first person with real weight', camera: 'first', dimension: '3d', home: 'exists', needs: ['first-person-weight'] },
      { id: 'friends', about: 'players', what: 'Friends play together against the zombies', words: 'me and my friends', together: 'coop', home: 'exists' },
      { id: 'body', about: 'body', what: 'Each player is a character', words: null, body: 'character', home: 'exists' },
      { id: 'phone', about: 'devices', what: 'It plays on a phone', words: 'on my phone', devices: ['phone'], home: 'exists' },
      { id: 'feel', about: 'feel', what: 'Grim and dark, moonlit ruins', words: 'Grim and dark, like moonlit ruins', kind: 'dark', home: 'exists' },
    ],
    asks: [],
  };
}

/** What a pitch v2 card says beside its id, title, v1 and spec (builder/spec/pitch.v2.schema.json). */
export const CARD_WORDS = { hook: 'Hold the gate with your friends.', howItPlays: 'Waves come at the gate; hold it together; the boss comes last.', players: '2 to 4, together', whyFunny: 'Friends hooking onto the walls at the worst moment.', conceptPrompt: 'A ruined gate at night, torches, a crowd of zombies.' };
/** A pitch in the v2 shape: every card with its words (an old `take` is dropped), research and policy. */
export const pitchV2 = p => ({ research: { bank: [], web: [], notes: '' }, policy: { ok: true }, ...p, cards: (p.cards ?? []).map(({ take, ...c }, i) => ({ ...CARD_WORDS, play: playOf(i), ...c })) });
/** A card's play sketch (pitch v2 cards[].play): each card of a pitch its own style of play. */
export const playOf = (i = 0) => ({ style: ['hold the line together', 'a scramble on the walls', 'a slow siege'][i % 3], verbs: ['shoot', 'climb'], beat: 'shoot at the nearest zombie, climb a wall', touch: 'cover a friend who is pulled down', chaos: 0.5 });

/** The gate game's play target (gf-play-target/1), for loops whose spec already carries its play. */
export const GATE_PLAY = {
  schema: 'gf-play-target/1', from: 'words', confidence: 0.6,
  genre: { name: 'co-op wave defence', traits: ['holding a line together', 'a boss that tests the team'] },
  verbs: [{ id: 'swing', does: 'swing at the nearest zombie', input: 'swing' }, { id: 'hook', does: 'pull yourself onto the walls', input: 'hook' }],
  beats: { moment: 'swing at what reaches the gate', stretch: 'a wave breaks on the gate', round: 'waves, then the boss' },
  objective: { goal: 'hold the gate', win: 'the boss falls', reach: { how: 'the gate is where everyone starts', within: 0, risks: [] }, things: [] },
  touchpoints: [{ how: 'cover a friend who is pulled down', kind: 'help', often: 'every wave' }],
  risk: [{ risk: 'leave the gate for the wall', reward: 'hit the boss from above' }],
  pacing: { firstAction: 5, eventsPerMinute: 20, roundSeconds: 300, idleMax: 15, comeback: 0 },
  events: [{ name: 'kill', what: 'a zombie falls', meaningful: true }, { name: 'boss-hit', what: 'the boss is hit', meaningful: true }],
  feel: { impact: 'high', weight: 'heavy', chaos: 0.5, juice: ['hitstop on a kill'] },
  avoid: [{ failure: 'idle', guard: 'the next wave starts as the last breaks' }, { failure: 'unreachable', guard: 'the boss comes to the gate' }],
  makes: [{ says: 'Every swing lands with weight', see: 'a zombie staggers back with a thud' }, { says: 'The wall is the place to be for the boss', see: 'a hooked player hits the boss from above' }, { says: 'A fallen friend is covered', see: 'a friend stands over a downed player while they get up' }],
  mechanics: [{ id: 'waves', why: 'the waves' }, { id: 'boss', why: 'the boss' }],
  bots: 'bots hold the gate and swing at the nearest zombie',
};
