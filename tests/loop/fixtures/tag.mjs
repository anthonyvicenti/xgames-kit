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
});

