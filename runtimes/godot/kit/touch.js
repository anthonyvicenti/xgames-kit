// runtime godot: the phone layout. The shared UI (gf/three/ui) draws the touch layer and the HUD for every runtime;
// on a touch screen a Godot game also needs:
//
//   the move stick, always in sight: a resting ring at the lower left in the kit's stick look (a faint dark edge so it
//                 reads on a pale ground too) (the shared stick only
//                 shows while a finger holds it, so a new player saw buttons and nothing to move with). A finger
//                 anywhere on the left half still moves, as on every runtime; the resting ring steps aside while it does.
//   only the actions the game has: the shared layer makes Jump, Action and Use for every game; a Godot game presses
//                 jump and act (GF's pad, addons/gf/gf.gd), so it keeps Jump when config/game.json → controls.jump names
//                 one and Action / Use when controls.primary / controls.interact do. A walker seen from above with no
//                 actions shows the stick alone.
//   a HUD that fits 390x844 and 844x390: the player card becomes a slim pill in the top row beside the clock (or under
//                 it when the row is full), never a wide panel over the game or on the stick's corner; the goal line
//                 sits in the space the scoreboard leaves, so the two never overlap.
//
// Nothing here hides a kit element (the guard would rightly undo it): it moves and sizes them, on touch only. The
// desktop layout is the shared one, unchanged.

const CSS = `
#gf-ui.gf-godot-touch .gf-me{left:8px;top:8px;bottom:auto;min-width:0;max-width:min(46vw,220px);padding:6px 12px;gap:4px;border-radius:999px}
#gf-ui.gf-godot-touch .gf-me.gf-godot-box{border-radius:14px}
#gf-ui.gf-godot-touch .gf-me-name{font-size:14px;min-width:0}
#gf-ui.gf-godot-touch .gf-me > .gf-lines:empty,#gf-ui.gf-godot-touch .gf-me > .gf-meters:empty{display:none}
#gf-ui.gf-godot-touch .gf-me-name span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#gf-ui.gf-godot-touch .gf-goal{transform:none;font-size:12px}
#gf-ui.gf-godot-touch .gf-scores{min-width:0}
#gf-ui .gf-touch .gf-stick.gf-godot-rest{display:block;left:auto;top:auto;margin:0;opacity:.7;pointer-events:none;box-shadow:0 0 0 1px #0002,inset 0 0 0 1px #0002}
#gf-ui .gf-touch .gf-stick.gf-godot-rest u{box-shadow:0 0 0 1px #0002}
#gf-ui .gf-touch .gf-stick.gf-godot-rest.held{visibility:hidden}
`;

/** Which of the shared layer's touch buttons a Godot game keeps: the actions its controls name (GF's pad: jump, act). */
export function touchActions(controls = {}) {
  const has = k => typeof controls[k] === 'string' ? controls[k].trim() !== '' : !!controls[k];
  return ['jump', 'primary', 'interact'].filter(has);
}

/** Where each kept button sits, by how many there are: Jump nearest the thumb, the others stacked above it. */
export function buttonSpots(actions) {
  const spots = { 1: [['right:22px;bottom:22px']], 2: [['right:22px;bottom:22px'], ['right:30px;bottom:100px']], 3: [['right:22px;bottom:22px'], ['right:100px;bottom:40px'], ['right:30px;bottom:104px']] }[actions.length] ?? [];
  return Object.fromEntries(actions.map((a, i) => [a, spots[i][0]]));
}

const rect = el => {
  if (!el?.isConnected) return null;
  const cs = getComputedStyle(el);
  if (cs.display === 'none') return null;
  const r = el.getBoundingClientRect();
  return r.width > 1 && r.height > 1 ? r : null;
};

/**
 * Sets up the phone layout on the shared UI. → {update(dt), observe()}: update each page frame (cheap: it lays the
 * HUD out four times a second and on a resize); observe() is the layout as drawn, for the phone measure.
 */
export function createTouchLayout({ ui, input, controls = {} }) {
  const style = document.createElement('style'); style.textContent = CSS; document.head.append(style);
  const layer = ui.touchLayer, root = ui.root;
  const keep = touchActions(controls), spots = buttonSpots(keep);
  for (const b of [...layer.querySelectorAll('button[data-action]')]) {
    const a = b.dataset.action;
    if (!keep.includes(a)) b.remove();
    else b.style.cssText = spots[a];
  }
  const rest = document.createElement('div'); rest.className = 'gf-stick gf-godot-rest'; rest.dataset.gfRest = 'stick';
  rest.append(document.createElement('u'));
  layer.prepend(rest);
  let next = 0, w = 0, h = 0, cardOn = null;

  function layout() {
    const card = root.querySelector('#gf-hud'), goal = root.querySelector('#gf-goal'), scores = root.querySelector('.gf-scores');
    const menuBtn = root.querySelector('#gf-menu-button'), top = root.querySelector('.gf-top');
    const W = innerWidth, gap = 8;
    // the stick's ring: lower left, a little in from the edges (the safe area on a phone with a notch)
    const R = 60, edge = 24;
    rest.style.left = `calc(${edge}px + env(safe-area-inset-left))`; rest.style.bottom = `calc(${edge}px + env(safe-area-inset-bottom))`;
    rest.style.width = rest.style.height = `${R * 2}px`;
    const m = rect(menuBtn), t = rect(top), s = rect(scores);
    const rowTop = Math.min(m?.top ?? 8, t?.top ?? 8);
    const rowBottom = Math.max(m?.bottom ?? 44, t?.bottom ?? 0);
    const rowLeft = Math.max(m?.right ?? 0, t?.right ?? 0) + gap;
    const rightLimit = s ? s.left - gap : W - gap;
    // the card: in the top row beside the clock when it fits as one slim line, else the row under it at the left
    let c = rect(card), cardRow2 = null;
    if (card && c) {
      const slim = c.height <= 40;
      card.classList.toggle('gf-godot-box', !slim);
      if (slim && rowLeft + c.width <= rightLimit) { card.style.left = `${rowLeft}px`; card.style.top = `${rowTop}px`; }
      else { card.style.left = `${gap}px`; card.style.top = `${rowBottom + gap}px`; cardRow2 = rect(card); }
    }
    // the goal line: under the top row, in the span the scoreboard and the card leave
    if (goal) {
      const gTop = rowBottom + 6, gh = 24;
      const left = cardRow2 && cardRow2.top < gTop + gh ? cardRow2.right + gap : gap;
      const right = s && s.bottom > gTop ? s.left - gap : W - gap;
      const span = Math.max(80, right - left);
      goal.style.top = `${gTop}px`; goal.style.maxWidth = `${span}px`;
      const gw = Math.min(span, rect(goal)?.width ?? span);
      goal.style.left = `${Math.round(left + (span - gw) / 2)}px`;
    }
  }

  return {
    update() {
      const on = !!input.touch;
      if (root.classList.contains('gf-godot-touch') !== on) {
        root.classList.toggle('gf-godot-touch', on);
        // the desktop layout is the shared one: give back what the phone layout moved
        if (!on) for (const el of root.querySelectorAll('#gf-hud, #gf-goal')) for (const p of ['left', 'top', 'max-width']) el.style.removeProperty(p);
      }
      if (!on) return;
      rest.classList.toggle('held', !!input.stickState?.());
      const now = performance.now(), shown = !!root.querySelector('#gf-hud.on');
      if (now >= next || innerWidth !== w || innerHeight !== h || shown !== cardOn) { next = now + 250; w = innerWidth; h = innerHeight; cardOn = shown; layout(); }
    },
    observe: () => ({ actions: keep, stick: !!rect(rest) || rest.classList.contains('held') }),
  };
}
