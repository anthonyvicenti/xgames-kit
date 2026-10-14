// The editors' undo and redo (map, layout, skins, items share it). Pure: a list of whole states, no DOM.
// A state is any value the editor can draw from (a map, a list of props, a set of colours). push() drops the redo
// side, as every editor the person has used does. Saving does not clear it: undo after a save stages the old state
// again, and the next save writes it.

export function createHistory(initial, { limit = 200 } = {}) {
  let past = [], present = initial, future = [];
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  return {
    get current() { return present; },
    get canUndo() { return past.length > 0; },
    get canRedo() { return future.length > 0; },
    /** A new state after an edit. An edit that changes nothing is not a step. → true when it was a step */
    push(next) {
      if (same(next, present)) return false;
      past.push(present); if (past.length > limit) past.shift();
      present = next; future = [];
      return true;
    },
    undo() { if (!past.length) return present; future.push(present); present = past.pop(); return present; },
    redo() { if (!future.length) return present; past.push(present); present = future.pop(); return present; },
    /** Start again from a state the files now hold (after a save, or a change the session made). */
    reset(state) { past = []; future = []; present = state; },
  };
}
