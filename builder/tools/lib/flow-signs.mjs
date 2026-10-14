// A flow's own signs for the checks (open builder M4-C). How a game is played is a part (kit/loops/<id>/index.js), and
// what "something happens" means is that part's to say: in a timed round a score moves; in a turn-taking game a move
// is played and the turn goes round. A check that watched a walker in a timed round reads the flow's sign through
// here and keeps no table of flows. Nothing is loosened: a flow that gives no sign of its own is judged as a timed
// round is.
//
//   pulse     check 12: {what, min, of(snapshot) → number, fix}, read on the solo round's last snapshot
//             (snapshot.flow is what the flow's observe() publishes); null → the scores, as before
//   pressed   check 13, only when no mechanic exposes anything to walk to: (before, after) → did the press reach the
//             flow (a move played, or refused with a reason on screen); absent → any change of state, as before
//   sample,   check 15: recorded and judged with the mechanics' own (alive-check.mjs)
//   judge
//   short     the solo round a check plays is cut to 25 s through round.seconds; a flow with a clock of its own
//             says what else to cut so its play fits (a turn clock that lets the turn go round)
import { flowParts } from '../catalog.mjs';

/** The kit's flows with their manifests (tools/catalog.mjs flowParts). Read once, like the mechanics' parts. */
export const FLOWS = await flowParts();
/** The id of the flow a game's config names: the timed round when it names none; null for a world. */
export const flowIdOf = game => (game?.round?.mode === 'world' ? null : typeof game?.round?.flow === 'string' ? game.round.flow : 'round');
/** A game's flow part, or null (a world, or a flow this kit does not carry). */
export const flowOfGame = (game, flows = FLOWS) => { const id = flowIdOf(game); return id ? flows.find(f => f.id === id && f.manifest) ?? null : null; };
/** A game's flow's signs, or null. */
export const flowSigns = (game, flows = FLOWS) => flowOfGame(game, flows)?.manifest?.signs ?? null;
/** The override patches of a check's short round of `seconds`: round.seconds, then what the flow says to cut with it. */
export function shortRound(game, seconds, flows = FLOWS) {
  const base = [{ file: 'config/game.json', pointer: '/round/seconds', value: seconds }];
  let more = []; try { more = flowSigns(game, flows)?.short?.(seconds) ?? []; } catch { more = []; }
  return [...base, ...more.filter(p => p && typeof p.pointer === 'string')];
}
/** Check 12 by the flow's own sign: null when the flow has none (the caller reads the scores), else {ok, n, pulse}. */
export function flowPulse(game, snapshot, flows = FLOWS) {
  const pulse = flowSigns(game, flows)?.pulse ?? null;
  if (!pulse) return null;
  let n = 0; try { n = Number(pulse.of(snapshot)) || 0; } catch { n = 0; }
  return { ok: n >= pulse.min, n, pulse, flow: flowIdOf(game) };
}
