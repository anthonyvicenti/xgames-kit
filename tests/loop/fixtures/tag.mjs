// A small real idea for tests that run the real registry and create: tag in a backyard, on three/standard-3d.
export const PROMPT = 'a game of tag in a backyard for me and my friends, seen from behind your character';
export const TAG_LEDGER = { rows: [
  { id: 'acts', about: 'acts', what: 'Everyone plays at once in one timed round', words: 'a game of tag', acts: 'together-timed', home: 'exists', core: true },
  { id: 'view', about: 'perspective', what: 'Third person, from behind', words: 'seen from behind your character', camera: 'third', dimension: '3d', home: 'exists', core: true },
  { id: 'friends', about: 'players', what: 'Friends play against each other', words: 'me and my friends', together: 'versus', home: 'exists', core: true },
  { id: 'body', about: 'body', what: 'Each player is a character', words: 'your character', body: 'character', home: 'exists', core: true },
  { id: 'tag', about: 'action', what: 'Tag another player to make them it', words: 'tag', home: 'exists', by: 'mechanic:tag', core: true },
  { id: 'yard', about: 'thing', what: 'It happens in a backyard', words: 'in a backyard', home: 'build', how: 'config: the backyard world with a fence, a bench and a sandpit as cover', where: 'rules', core: false },
], asks: [] };
export const tagSpec = (title = 'Yard Tag') => ({
  specVersion: 2, title, hook: 'Tag your friends around the backyard; whoever is it when the clock runs out loses.', prompt: PROMPT,
  runtime: 'three', profile: 'standard-3d', loop: 'round', kind: 'silly',
  players: { min: 1, max: 4, bots: true }, multiplayer: { mode: 'live', together: 'versus' }, devices: { targets: ['desktop', 'phone'] },
  camera: 'third', controls: { primary: 'tag the player in front of you' }, round: { seconds: 90, winBy: 'Not being it when the clock runs out.' },
  world: { template: 'backyard', size: 'small' }, mechanics: [{ id: 'tag', as: 'tag a friend to pass it on' }],
  rules: { summary: 'One player is it. Touch another to pass it on. Whoever is it at the end loses.', scoring: 'seconds not it' },
  characters: [{ role: 'player', describe: 'a jelly bean in your colour', body: { from: 'kind' } }],
  build: [{ what: 'a backyard with cover to run around', how: 'config: props in config/world.json as cover', where: 'rules', row: 'yard' }],
  content: { rating: 'E' },
  play: { target: TAG_PLAY },
});


/** The tag game's play target (gf-play-target/1, builder/play/design.mjs), as a designer round answers it. */
export const TAG_PLAY_ANSWER = {
  genre: { name: 'playground tag', traits: ['the chase: being it is a short panic, not a sentence', 'near misses round cover'] },
  verbs: [{ id: 'run', does: 'run round the yard', input: 'move' }, { id: 'tag', does: 'touch the player in front of you to pass it on', input: 'primary' }],
  beats: { moment: 'run at or away from whoever is it', stretch: 'it passes hands after a chase round the cover', round: '90 s of chases; whoever is it at the end loses' },
  objective: { goal: 'not be it when the clock runs out', win: 'the fewest seconds as it', reach: { how: 'every player starts in the yard; the it player is always within a short run', within: 3, risks: ['a player stuck behind the fence'] }, things: [] },
  touchpoints: [{ how: 'a tag passes it on', kind: 'hit', often: 'every 10 to 20 s' }],
  risk: [{ risk: 'cut across the open lawn', reward: 'get away faster' }],
  pacing: { firstAction: 3, eventsPerMinute: 4, roundSeconds: 90, idleMax: 20, comeback: 0.4 },
  events: [{ name: 'tagged', what: 'it passes to another player', meaningful: true }, { name: 'near-miss', what: 'a tag swing that misses', meaningful: false }],
  feel: { impact: 'mid', weight: 'light', chaos: 0.4, comedy: 'the panic of the one who is it', juice: ['a bonk and a squash on a tag'] },
  avoid: [{ failure: 'idle', guard: 'a small yard: the chase always comes back round' }, { failure: 'unreachable', guard: 'no ledge or water in the yard' }, { failure: 'runaway-leader', guard: 'no tag-backs for 2 s, then anyone can be caught' }],
  makes: [{ says: 'Being it is a short panic you can pass on', see: 'the it marker jumps to another player after a touch' }, { says: 'Cover makes near misses', see: 'a chaser swings and misses round the bench' }, { says: 'The clock makes the last seconds tense', see: 'the timer turns red and the it player dives at the nearest friend' }],
  mechanics: [{ id: 'tag', as: 'tag a friend to pass it on', why: 'the whole game' }],
  bots: 'bots chase the nearest player when they are it and run from it otherwise',
};
export const TAG_PLAY = { schema: 'gf-play-target/1', from: 'words', confidence: 0.6, ...TAG_PLAY_ANSWER, sources: { words: true, refs: 0, at: '2026-10-14T00:00:00.000Z' } };
