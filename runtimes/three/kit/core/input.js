// gf-three core: the local player's input. Keyboard, mouse (pointer lock, with click-drag look where the page can't
// lock the pointer), and touch (a stick on the left half, look on the right half, buttons the UI draws).
//
//   const input = createInput(canvas);
//   input.update();                       // once per frame, before anything reads it
//   input.move      {x, y}                x right, y forward, length <= 1
//   input.look      {dx, dy}              pixels of look this frame (mouse or touch)
//   input.actions   {primary, secondary, interact, jump}: each {down, pressed, released} (pressed/released: this frame only)
//   input.sprint    true while Shift is held
//   input.enabled   false: everything reads as idle (a card over the game); the world keeps running
//   input.lookScale, input.invertY        the player's mouse sensitivity (1: the camera's own) and inverted look, from
//                                          the menu's settings (CONTRACT §6g)
//   input.press(action, down)             for on-screen buttons (touch)
//   input.stickState()                    the touch stick while held, for the UI to draw
//   input.pointer   {x, y, inside}       the mouse cursor in normalised device coordinates (-1..1, y up), always tracked
//   input.cursorMode                      true: the mouse stays free and aims where it points (the 'follow' camera,
//                                          CONTRACT §8); a click is the action at once and never takes the pointer lock
//   input.wheel                           wheel steps this frame (+ toward the player: zoom in), for the 'follow' and
//                                          'orbit' cameras
//   input.cursorMode = 'drag'             the 'orbit' camera (CONTRACT §9, worlds): the mouse stays free; a drag turns the
//                                          camera and a click (released within DRAG_PX of where it went down) is the action,
//                                          at the cursor. On touch, a short tap that does not move is the primary action
//                                          where it landed (input.pointer moves there), a long press is the secondary; a
//                                          moving touch is the stick (left half) or look (right half)
//   input.cursorMode = 'look'             the 'first' camera in a world (CONTRACT §9): the pointer lock where the page
//                                          allows it (any click only takes the mouse; then the mouse looks and a click is the
//                                          action at the crosshair, held for as long as the button is); where the frame
//                                          refuses it (a post on X), the 'drag' way, or following in full screen (below); on
//                                          touch, the 'drag' way's taps.
//                                          A refused re-lock (Esc, then a quick click) never stops the next click trying
//   input.aimFree                         true while the cursor or a finger aims (cursorMode true or 'drag', or 'look' with
//                                          the lock refused or on touch); false while the middle of the screen does
//   input.keyPressed(code)                a key went down this frame (KeyboardEvent.code: 'Digit1', 'KeyX'), for keys the
//                                          four actions don't cover (a hotbar); input.keyDown(code) while it is held;
//   input.keysPressed()                   this frame's key edges in the order they went down (P then 3 in one frame:
//                                          paint, then colour 3; play-test 2026-10-09)
//   input.unmap(codes)                    take keys off the four actions (a game that gives F or Q its own meaning)
// Keys typed into a text field (a sign's words) never move the player or fire an action.
//   input.lockRefused                     true once the page refused the pointer lock before any lock worked: a frame
//                                          sandboxed without allow-pointer-lock (a post on X, 2026-10-08). Looking is then
//                                          click-drag in the card, and the HUD's full-screen button keeps the cursor on the
//                                          game (CONTRACT §6d C5)
//   input.following                       true while the lock is refused, the page is full screen and the camera looks
//                                          with the mouse (cursorMode false, or 'look': a world in first person, which then
//                                          aims at the crosshair as under the lock): the camera follows the mouse with no button
//                                          held, keeps turning while the cursor rests at an edge of the screen (EDGE), and the
//                                          cursor is hidden over the game; a click is the action at once. The creator in a
//                                          post on X, 2026-10-12: "The mouse doesnt want to follow at all" (it took a held drag)
//
// Keys: WASD or arrows move, Space jumps, mouse button / F / J is primary, right button / Q is secondary, E / K is
// interact, Shift sprints. Escape always gives the mouse back (the browser does it; we never re-take it on our own).
// A blur clears held keys so nothing sticks; it never pauses anything (CONTRACT §3: a live round never pauses).

export const ACTIONS = ['primary', 'secondary', 'interact', 'jump'];
const KEYMAP = {
  KeyW: 'fwd', ArrowUp: 'fwd', KeyS: 'back', ArrowDown: 'back', KeyA: 'left', ArrowLeft: 'left', KeyD: 'right', ArrowRight: 'right',
  Space: 'jump', KeyF: 'primary', KeyJ: 'primary', KeyQ: 'secondary', KeyE: 'interact', KeyK: 'interact', ShiftLeft: 'sprint', ShiftRight: 'sprint',
};
const STICK_RADIUS = 60;
const DRAG_PX = 6, TAP_PX = 12, TAP_MS = 380, LONG_MS = 450;
// following (input.following): the edge band (a share of the screen, at least EDGE_MIN pixels) where a resting cursor
// keeps turning the camera, up to EDGE_SPEED pixels of look a second at the very edge; one move's look is capped at
// MOVE_CAP pixels (a jump when the page goes full screen is not a turn)
const EDGE = 0.04, EDGE_MIN = 18, EDGE_SPEED = 900, MOVE_CAP = 160;
const typing = t => !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);

export function createInput(dom, { win = globalThis.window } = {}) {
  const held = new Set();                       // logical names held by keys
  const btn = { primary: 0, secondary: 0, interact: 0, jump: 0 };       // held by mouse / touch buttons (counts)
  const presses = { primary: 0, secondary: 0, interact: 0, jump: 0 };   // presses since the last update
  const releases = { primary: 0, secondary: 0, interact: 0, jump: 0 };
  const actions = Object.fromEntries(ACTIONS.map(a => [a, { down: false, pressed: false, released: false }]));
  // a phone or tablet shows its touch controls from the start (a coarse pointer with no hover), not after a first touch
  const coarse = (() => { try { return !!win.matchMedia?.('(hover: none) and (pointer: coarse)')?.matches; } catch { return false; } })();
  const state = { move: { x: 0, y: 0 }, look: { dx: 0, dy: 0 }, actions, sprint: false, enabled: true, locked: false, touch: coarse, lastInput: 0, lookScale: 1, invertY: false, pointer: { x: 0, y: 0, inside: false }, cursorMode: false, wheel: 0 };
  let lookX = 0, lookY = 0, dragging = false, lastX = 0, lastY = 0, lockFailed = false, wheel = 0, lockedOnce = false;
  const keymap = { ...KEYMAP };
  const keysDown = new Set(), keyEdges = new Set(), keyEdgesNext = new Set();
  let pending = null;             // 'drag' mode: a mouse button down, not yet a drag or a click {button, x, y, drag}
  const taps = new Map();         // 'drag' mode: touches that may be taps {x, y, t, moved, long}
  state.lockRefused = false;
  state.following = false;
  const cursor = { x: 0, y: 0, on: false };   // following: where the cursor rests, and whether it is over the game
  let lastUpdate = 0;
  const fullScreen = () => { try { return !!win.document.fullscreenElement; } catch { return false; } };
  function following() { return (state.cursorMode === false || state.cursorMode === 'look') && state.lockRefused && !state.touch && fullScreen() && win.document.pointerLockElement !== dom; }
  // 'drag' semantics: the orbit camera always; a first-person world where the frame refuses the lock
  const dragLike = () => state.cursorMode === 'drag' || (state.cursorMode === 'look' && state.lockRefused && !following());
  const tapsAct = () => state.cursorMode === 'drag' || state.cursorMode === 'look';
  Object.defineProperty(state, 'aimFree', { enumerable: true, get: () => state.cursorMode === true || dragLike() || (state.cursorMode === 'look' && state.touch) });
  // A refusal before any lock ever worked on this page is the frame saying no (Chrome's message names the sandbox).
  // After a lock has worked, a refusal is the browser's re-lock delay (Esc, then a quick click).
  const refused = err => {
    lockFailed = true;
    if (!lockedOnce || /sandbox/i.test(String(err?.message ?? ''))) state.lockRefused = true;
  };
  const stick = { id: null, ox: 0, oy: 0, x: 0, y: 0 }, lookTouch = { id: null, x: 0, y: 0 };

  const down = name => { if (ACTIONS.includes(name)) { if (!isHeld(name)) presses[name]++; } held.add(name); state.lastInput = performance.now(); };
  const up = name => { held.delete(name); if (ACTIONS.includes(name) && !isHeld(name)) releases[name]++; };
  const isHeld = name => held.has(name) || btn[name] > 0;

  const onKey = e => {
    if (typing(e.target)) return;
    if (e.type === 'keydown') { if (!e.repeat && !keysDown.has(e.code)) keyEdgesNext.add(e.code); keysDown.add(e.code); }
    else keysDown.delete(e.code);
    const name = keymap[e.code];
    if (!name) return;
    if (e.type === 'keydown') { if (!e.repeat) down(name); else held.add(name); if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault(); }
    else up(name);
  };
  const press = (action, isDown) => {
    if (!ACTIONS.includes(action)) return;
    if (isDown) { if (!isHeld(action)) presses[action]++; btn[action]++; state.lastInput = performance.now(); }
    else { btn[action] = Math.max(0, btn[action] - 1); if (!isHeld(action)) releases[action]++; }
  };
  const mouseAction = b => (b === 0 ? 'primary' : b === 2 ? 'secondary' : null);
  const onMouseDown = e => {
    if (e.target !== dom) return;
    const a = mouseAction(e.button);
    const locked = win.document.pointerLockElement === dom;
    trackPointer(e);
    // following (full screen, the lock refused): a click is the action at once, at the crosshair, held as long as the button is
    if (following()) { state.lastInput = performance.now(); dragging = false; if (a) press(a, true); return; }
    if (dragLike()) { state.lastInput = performance.now(); pending = { button: e.button, x: e.clientX, y: e.clientY, drag: false }; lastX = e.clientX; lastY = e.clientY; return; }
    if (state.cursorMode === true) { state.lastInput = performance.now(); if (a) press(a, true); return; }
    if (state.cursorMode === 'look' && !locked) {
      // any button only takes the mouse; a refusal before any lock worked turns this page to the 'drag' way
      state.lastInput = performance.now();
      if (dom.requestPointerLock) { try { const r = dom.requestPointerLock(); if (r?.catch) r.catch(refused); } catch (err) { refused(err); } }
      else state.lockRefused = true;
      return;
    }
    if (!locked && e.button === 0 && dom.requestPointerLock && !lockFailed) {
      // The click that takes the mouse only takes the mouse (a player expects it, and it keeps a menu click from firing).
      try { const r = dom.requestPointerLock(); if (r?.catch) r.catch(refused); } catch (err) { refused(err); }
      dragging = true; lastX = e.clientX; lastY = e.clientY;
      return;
    }
    dragging = true; lastX = e.clientX; lastY = e.clientY;
    if (a) press(a, true);
  };
  const onMouseUp = e => {
    if (pending && pending.button === e.button) {
      // a click: the action, at the cursor (pressed and released in the same frame)
      const a = mouseAction(e.button);
      if (!pending.drag && a) { trackPointer(e); presses[a]++; releases[a]++; }
      pending = null; return;
    }
    dragging = false; const a = mouseAction(e.button); if (a && btn[a] > 0) press(a, false);
  };
  const trackPointer = e => {
    const w = win.innerWidth || 1, h = win.innerHeight || 1;
    state.pointer.x = (e.clientX / w) * 2 - 1; state.pointer.y = -((e.clientY / h) * 2 - 1); state.pointer.inside = true;
  };
  const onMouseMove = e => {
    if (win.document.pointerLockElement !== dom) trackPointer(e);
    if (dragLike() || pending) {
      if (pending && !pending.drag && Math.hypot(e.clientX - pending.x, e.clientY - pending.y) > DRAG_PX) { pending.drag = true; lastX = e.clientX; lastY = e.clientY; }
      if (pending?.drag) { lookX += e.clientX - lastX; lookY += e.clientY - lastY; lastX = e.clientX; lastY = e.clientY; }
      return;
    }
    if (state.cursorMode === true) return;
    if (following()) {
      const cap = v => Math.max(-MOVE_CAP, Math.min(MOVE_CAP, v || 0));
      lookX += cap(e.movementX); lookY += cap(e.movementY);
      cursor.x = e.clientX; cursor.y = e.clientY; cursor.on = e.target === dom;
      return;
    }
    if (win.document.pointerLockElement === dom) { lookX += e.movementX || 0; lookY += e.movementY || 0; }
    else if (dragging) { lookX += e.clientX - lastX; lookY += e.clientY - lastY; lastX = e.clientX; lastY = e.clientY; }
  };
  const onContext = e => { if (e.target === dom) e.preventDefault(); };
  const onWheel = e => { if (e.target === dom && state.cursorMode) { wheel += Math.sign(-e.deltaY); e.preventDefault(); } };
  const pointerAt = (x, y) => { const w = win.innerWidth || 1, h = win.innerHeight || 1; state.pointer.x = (x / w) * 2 - 1; state.pointer.y = -((y / h) * 2 - 1); state.pointer.inside = true; };
  const onLeave = () => { state.pointer.inside = false; cursor.on = false; };
  const onLock = () => { state.locked = win.document.pointerLockElement === dom; if (state.locked) lockedOnce = true; };
  const onLockError = () => { if (!lockedOnce) refused(null); };
  const onBlur = () => { held.clear(); keysDown.clear(); for (const a of ACTIONS) btn[a] = 0; dragging = false; pending = null; taps.clear(); stick.id = null; lookTouch.id = null; };

  const onTouchStart = e => {
    state.touch = true;
    for (const t of e.changedTouches) {
      if (t.target !== dom) continue;
      if (tapsAct()) taps.set(t.identifier, { x: t.clientX, y: t.clientY, t: performance.now(), moved: false, long: false });
      if (t.clientX < win.innerWidth / 2 && stick.id === null) Object.assign(stick, { id: t.identifier, ox: t.clientX, oy: t.clientY, x: 0, y: 0 });
      else if (lookTouch.id === null) Object.assign(lookTouch, { id: t.identifier, x: t.clientX, y: t.clientY });
    }
    if (e.target === dom) e.preventDefault();
  };
  const onTouchMove = e => {
    for (const t of e.changedTouches) {
      const tap = taps.get(t.identifier);
      if (tap && !tap.moved && Math.hypot(t.clientX - tap.x, t.clientY - tap.y) > TAP_PX) tap.moved = true;
      if (t.identifier === stick.id) { stick.x = t.clientX - stick.ox; stick.y = t.clientY - stick.oy; }
      else if (t.identifier === lookTouch.id) { lookX += (t.clientX - lookTouch.x) * 1.4; lookY += (t.clientY - lookTouch.y) * 1.4; lookTouch.x = t.clientX; lookTouch.y = t.clientY; }
    }
  };
  const onTouchEnd = e => {
    for (const t of e.changedTouches) {
      const tap = taps.get(t.identifier);
      if (tap) {
        taps.delete(t.identifier);
        // a tap that did not move: the primary action where it landed (a long press already fired the secondary)
        if (!tap.moved && !tap.long && e.type === 'touchend' && performance.now() - tap.t <= TAP_MS) { pointerAt(t.clientX, t.clientY); presses.primary++; releases.primary++; }
      }
      if (t.identifier === stick.id) { stick.id = null; stick.x = stick.y = 0; }
      if (t.identifier === lookTouch.id) lookTouch.id = null;
    }
  };

  win.addEventListener('keydown', onKey); win.addEventListener('keyup', onKey);
  win.addEventListener('mousedown', onMouseDown); win.addEventListener('mouseup', onMouseUp); win.addEventListener('mousemove', onMouseMove);
  win.addEventListener('contextmenu', onContext); win.addEventListener('blur', onBlur);
  win.document.addEventListener('pointerlockchange', onLock); win.document.addEventListener('pointerlockerror', onLockError);
  dom.addEventListener('wheel', onWheel, { passive: false }); dom.addEventListener('mouseleave', onLeave);
  dom.addEventListener('touchstart', onTouchStart, { passive: false });
  win.addEventListener('touchmove', onTouchMove, { passive: true });
  win.addEventListener('touchend', onTouchEnd); win.addEventListener('touchcancel', onTouchEnd);

  function update() {
    const on = state.enabled;
    const now = performance.now(), dt = lastUpdate ? Math.min(0.1, (now - lastUpdate) / 1000) : 0; lastUpdate = now;
    const follow = following();
    if (follow !== state.following) { state.following = follow; dom.style.cursor = follow ? 'none' : ''; if (!follow) cursor.on = false; }
    if (follow && cursor.on && on) {
      // a cursor resting in the edge band keeps turning: the deeper, the faster (the screen's edge stops the move itself)
      const w = win.innerWidth || 1, h = win.innerHeight || 1, bx = Math.max(EDGE_MIN, w * EDGE), by = Math.max(EDGE_MIN, h * EDGE);
      const push = (p, size, band) => (p < band ? -(band - p) / band : p > size - 1 - band ? (p - (size - 1 - band)) / band : 0);
      lookX += push(cursor.x, w, bx) * EDGE_SPEED * dt; lookY += push(cursor.y, h, by) * EDGE_SPEED * dt;
    }
    // a long press that has not moved: the secondary action where the finger is
    for (const tap of taps.values()) if (!tap.moved && !tap.long && performance.now() - tap.t >= LONG_MS) { tap.long = true; pointerAt(tap.x, tap.y); presses.secondary++; releases.secondary++; }
    keyEdges.clear(); if (on) for (const k of keyEdgesNext) keyEdges.add(k); keyEdgesNext.clear();
    let x = (held.has('right') ? 1 : 0) - (held.has('left') ? 1 : 0), y = (held.has('fwd') ? 1 : 0) - (held.has('back') ? 1 : 0);
    if (stick.id !== null) { x += stick.x / STICK_RADIUS; y -= stick.y / STICK_RADIUS; }
    const l = Math.hypot(x, y); if (l > 1) { x /= l; y /= l; }
    state.move.x = on ? x : 0; state.move.y = on ? y : 0;
    const k = Number.isFinite(state.lookScale) ? state.lookScale : 1;
    state.look.dx = on ? lookX * k : 0; state.look.dy = on ? lookY * k * (state.invertY ? -1 : 1) : 0; lookX = lookY = 0;
    state.sprint = on && held.has('sprint');
    state.wheel = on ? wheel : 0; wheel = 0;
    for (const a of ACTIONS) {
      const s = actions[a];
      s.pressed = on && presses[a] > 0; s.released = on && releases[a] > 0;
      s.down = on && (isHeld(a) || s.pressed);
      presses[a] = 0; releases[a] = 0;
    }
  }

  function dispose() {
    win.removeEventListener('keydown', onKey); win.removeEventListener('keyup', onKey);
    win.removeEventListener('mousedown', onMouseDown); win.removeEventListener('mouseup', onMouseUp); win.removeEventListener('mousemove', onMouseMove);
    win.removeEventListener('contextmenu', onContext); win.removeEventListener('blur', onBlur);
    win.document.removeEventListener('pointerlockchange', onLock); win.document.removeEventListener('pointerlockerror', onLockError);
    dom.removeEventListener('wheel', onWheel); dom.removeEventListener('mouseleave', onLeave);
    dom.removeEventListener('touchstart', onTouchStart); win.removeEventListener('touchmove', onTouchMove);
    win.removeEventListener('touchend', onTouchEnd); win.removeEventListener('touchcancel', onTouchEnd);
  }

  /** The touch stick while a finger holds it (for the UI to draw): {ox, oy, x, y, r}, else null. */
  const stickState = () => (stick.id === null ? null : { ox: stick.ox, oy: stick.oy, x: stick.x, y: stick.y, r: STICK_RADIUS });
  /** A key went down this frame (KeyboardEvent.code). */
  const keyPressed = code => keyEdges.has(code);
  /** This frame's key edges, in the order they went down. */
  const keysPressed = () => [...keyEdges];
  /** A key is held (and the input is enabled). */
  const keyDown = code => state.enabled && keysDown.has(code);
  /** Take keys off the four actions: unmap(['KeyF', 'KeyQ']). */
  const unmap = codes => { for (const c of codes) delete keymap[c]; };
  return Object.assign(state, { update, press, dispose, stickState, keyPressed, keysPressed, keyDown, unmap });
}

/** An idle action set (bots and remote players start from it). */
export function idleActions() { return Object.fromEntries(ACTIONS.map(a => [a, { down: false, pressed: false, released: false }])); }
