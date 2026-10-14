// games.fun multiplayer kit: bot for the generic race room. The party shell never seats a bot (a bot can't play the
// real game, and a made-up score beside real ones would mislead), so this exists for two callers only: the host
// worker, which imports a bot module for every room, and the platform's room probe, whose bot-vs-bot matches need a
// player that starts a round and reports a result. Adapted from templates/live-race/bot.js.
export default {
  act(mem, inbox, you, api) {
    for (const m of inbox) {
      if (m.k === 'standings') { mem.phase = m.phase; mem.host = m.hostId; mem.round = m.round; }
      if (m.k === 'go') { mem.racing = m.round; mem.p = 0; mem.pace = 0.02 + api.random() * 0.05; mem.sent = null; }
    }
    if (mem.phase === 'lobby' && mem.host === you && mem.started !== mem.round) { mem.started = mem.round; return { k: 'start' }; }
    if (mem.phase !== 'racing' || mem.racing !== mem.round || mem.sent === 'finish') return null;
    mem.p = Math.min(1, mem.p + mem.pace);
    if (mem.p >= 1) { mem.sent = 'finish'; return { k: 'finish', value: 3000 + api.randomInt(5000), won: true }; }
    return { k: 'progress', p: Math.round(mem.p * 1000) / 1000 };
  },
  secrets() { return []; },   // nothing is hidden in a race
};
