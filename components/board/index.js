// mechanic: board (open builder M4-F). A grid on the floor of the world. Players take turns placing or moving pieces
// by rules the game gives (legal, winner); the host owns the board, every copy draws it, a move that is not legal or
// not yours is refused with a reason, bots play through the same path, and the world's props are cleared off the area.
// README.md has ownership, the API and what is not done.
//
//   const board = ctx.mechanics.get('board');
//   board.rules({
//     legal: (move, s) => s.empty(...move.to) || 'That cell is taken',          // true, or the reason in words
//     winner: s => { const l = s.last && s.line(...s.last, 4); return l ? { seat: s.owner(...s.last), cells: l } : s.full() ? { draw: true } : null; },
//   });
import * as THREE from 'three';
import { createState, moveProblem, playMove, pickMove, candidates, resultOf, geometry, cleanMove, MAX_SEATS, hintStyle } from './logic.js';
import { areaOf } from '../../core/util.js';

export const id = 'board';
export const examples = ['a giant four in a row on the floor', 'take turns placing pieces on a grid', 'move your pieces across a board and capture', 'a tic-tac-toe or reversi table with friends'];

const D = {
  cols: 7, rows: 6, cell: 1.5, at: 'centre', input: 'place', presence: 'walk', action: 'interact', piece: 'disc', pieceSize: 0.76, cellShape: 'square', checker: true,
  turnSeconds: 30, botThink: 1.1, endDelay: 2.2, score: 'win', endsRound: true, clear: 2.4, seats: true, edgeReach: 1.8, hints: true, rowZero: 'back', seatSides: '',
  boardColor: '#2f4a7a', cellColor: '#e9edf5', cellColorB: '#c9d3e6', hintColor: '#58d68d', refuseColor: '#ff5a5a', winColor: '#ffd23f',
  soundPlace: 'board-place', soundRefuse: 'board-refuse', soundWin: 'board-win', soundSelect: 'board-select',
  textYourTurn: 'Your turn', textTheirTurn: '{name}\'s turn', textNotYourTurn: 'Not your turn', textDraw: 'Draw',
};
const kebab = s => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
const num = (description, minimum, maximum) => ({ type: 'number', description, minimum, maximum });
const str = (description, def) => ({ type: 'string', default: def, description });
export const params = {
  type: 'object', additionalProperties: true,
  properties: {
    cols: { type: 'integer', minimum: 2, maximum: 12, default: D.cols, description: 'Cells across' },
    rows: { type: 'integer', minimum: 2, maximum: 12, default: D.rows, description: 'Cells deep (row 0 is at the end rowZero names)' },
    rowZero: { type: 'string', enum: ['back', 'front'], default: D.rowZero, description: 'Which end of the board row 0 is, where dropped pieces gather. back: the -z end (in a 3D game the far side from the first seat; seen from above, the top of the screen). front: the +z end (seen from above, the bottom of the screen, as a four-in-a-row board stands)' },
    seatSides: { type: 'string', pattern: '^[snew]{0,4}$', default: D.seatSides, description: 'The sides of the board the seats stand on, in seat order (letters s, n, e, w; s is +z, the bottom of the screen from above); several seats on one side spread along it. Empty: s and n for two, then e and w' },
    cell: { ...num('Cell size in metres (it shrinks so the board and its seats fit the play area)', 0.6, 4), default: D.cell },
    at: { default: D.at, description: 'Where the middle of the board is: "centre", a world zone name, or [x, z]' },
    input: { type: 'string', enum: ['place', 'drop', 'move'], default: D.input, description: 'What acting on a cell means. place: put a piece on that cell. drop: put a piece in that column, it slides to the free cell nearest row 0. move: pick one of your pieces, then where it goes' },
    presence: { type: 'string', enum: ['walk', 'cursor'], default: D.presence, description: 'How a player is at the board. walk: your body walks beside and on it and the cell under your feet is yours to act on. cursor: your body stands at your side of the board and you move a mark in your colour (mouse, keys, stick); friends see the mark move' },
    action: { type: 'string', enum: ['interact', 'primary'], default: D.action, description: 'The input that acts on your cell (walk); with a cursor both the click and interact act' },
    piece: { type: 'string', enum: ['disc', 'pawn', 'ball', 'block'], default: D.piece, description: 'The shape of a piece, drawn by the kit in its owner\'s colour (kind 1 and up are drawn taller)' },
    pieceSize: { ...num('A piece\'s width as a share of the cell', 0.3, 0.98), default: D.pieceSize },
    cellShape: { type: 'string', enum: ['square', 'round'], default: D.cellShape, description: 'Square tiles, or round holes on the slab' },
    checker: { type: 'boolean', default: D.checker, description: 'Alternate the two cell colours' },
    turnSeconds: { ...num('Seconds a turn may take before the host plays a move for that player (0: no limit). The simple default until the session flow owns turns', 0, 300), default: D.turnSeconds },
    botThink: { ...num('Seconds a bot waits before it moves', 0.1, 10), default: D.botThink },
    endDelay: { ...num('Seconds the finished board stays up before the results', 0, 10), default: D.endDelay },
    score: { type: 'string', enum: ['win', 'pieces', 'none'], default: D.score, description: 'win: the winner gets 1. pieces: your score is your pieces on the board, as it changes. none: the rules score' },
    endsRound: { type: 'boolean', default: D.endsRound, description: 'A won or drawn board ends the round' },
    clear: { ...num('World props within this many metres of the board are taken away (walls, doors and ceilings stay); 0 keeps them', 0, 8), default: D.clear },
    seats: { type: 'boolean', default: D.seats, description: 'At round start each player stands at their own side of the board, facing it' },
    edgeReach: { ...num('Walking: how far off the board\'s edge you can stand and still act on the nearest edge cell (m)', 0, 4), default: D.edgeReach },
    hints: { type: 'boolean', default: D.hints, description: 'Show the mover which cells are legal' },
    boardColor: str('The slab under the cells', D.boardColor), cellColor: str('Cell colour', D.cellColor), cellColorB: str('The other cell colour (checker)', D.cellColorB),
    hintColor: str('Legal cells', D.hintColor), refuseColor: str('A refused move flashes this', D.refuseColor), winColor: str('The winning cells', D.winColor),
    soundPlace: str('Sound id when a piece lands', D.soundPlace), soundRefuse: str('Sound id when a move is refused', D.soundRefuse), soundWin: str('Sound id when the board is won', D.soundWin), soundSelect: str('Sound id when a piece is picked', D.soundSelect),
    textYourTurn: str('Goal line on your turn', D.textYourTurn), textTheirTurn: str('Goal line on another player\'s turn ({name})', D.textTheirTurn), textNotYourTurn: str('Refusal when it is not your turn', D.textNotYourTurn), textDraw: str('Goal line on a draw', D.textDraw),
  },
};
/** The sounds this mechanic plays (id → [label, gf-audio preset, bus]); create lists them in assets.json. */
export const sounds = {
  'board-place': ['A piece lands on the board', { layers: [{ preset: 'hit-soft' }, { preset: 'land', gainDb: -3 }] }, 'sfx'],
  'board-select': ['A piece is picked up', 'click', 'sfx'],
  'board-refuse': ['That move is not allowed', 'error', 'ui'],
  'board-win': ['The board is won', 'level-up', 'sfx'],
};
const vs = (name, label, type, extra = {}) => ({ id: `mechanic.board.${kebab(name)}`, label, group: 'mechanics', type, source: { pointer: `{base}/${name}` }, tier: 'advanced', facet: type === 'color' ? 'look' : type === 'text' ? 'text' : 'gameplay', ...extra });
export const slots = [
  vs('boardColor', 'Board colour', 'color', { tier: 'main', rank: 62 }),
  vs('cellColor', 'Cell colour', 'color', { tier: 'main', rank: 60 }),
  vs('cellColorB', 'Second cell colour', 'color', { tier: 'main', rank: 58 }),
  vs('turnSeconds', 'Seconds per turn (0 off)', 'number', { tier: 'main', rank: 56, constraints: { min: 0, max: 300, unit: 's' } }),
  vs('pieceSize', 'Piece size', 'number', { rank: 40, constraints: { min: 0.3, max: 0.98 } }),
  vs('hintColor', 'Legal move colour', 'color', { rank: 30 }),
  vs('winColor', 'Winning cells colour', 'color', { rank: 28 }),
  vs('refuseColor', 'Refused move colour', 'color', { rank: 20 }),
  vs('botThink', 'Bot thinking time', 'number', { constraints: { min: 0.1, max: 10, unit: 's' } }),
  vs('endDelay', 'Pause before results', 'number', { constraints: { min: 0, max: 10, unit: 's' } }),
  vs('textYourTurn', 'Your turn text', 'text', { constraints: { maxLength: 40 } }),
  vs('textTheirTurn', 'Their turn text', 'text', { constraints: { maxLength: 40 } }),
  vs('textNotYourTurn', 'Not your turn text', 'text', { constraints: { maxLength: 40 } }),
  vs('textDraw', 'Draw text', 'text', { constraints: { maxLength: 40 } }),
];

const unsub = (arr, fn) => () => { const i = arr.indexOf(fn); if (i >= 0) arr.splice(i, 1); };
const KEEP_TAGS = ['wall', 'door', 'doorway', 'ceiling', 'building', 'skyline', 'cloud', 'ground', 'fence'];

export function create(ctx, params = {}) {
  const P = { ...D, ...params };
  const V = k => { const sid = `mechanic.board.${kebab(k)}`; try { return ctx.assets?.has(sid) ? ctx.assets.value(sid, P[k]) : P[k]; } catch { return P[k]; } };
  const cols = Math.max(2, Math.min(12, P.cols | 0)), rows = Math.max(2, Math.min(12, P.rows | 0));
  const cursorMode = P.presence === 'cursor';
  const L = { move: [], refuse: [], end: [], turn: [] };
  const say = (list, e) => { for (const fn of list.slice()) try { fn(e); } catch (er) { console.error(er); } };
  let R = {};                       // the game's rules: { legal, apply, winner, next, start, bot }
  let G = null;                     // geometry, once the world is known
  let S = null;                     // shared: { g, t, n, l, x, o, b, w, d, k }
  let view = null, cleared = 0;
  let local = null, localKey = '';  // this copy's state object, rebuilt when the wire changes
  let lastPhase = null, endAt = -1, refusals = 0, lastRefusal = null;
  const plans = new Map();          // host: bot id → { wait, move, t, steered }
  const cursors = new Map();        // player id → { c, r, sel: [c, r] | null } (cursor presence; a walker's is its feet)
  let mine = { c: Math.floor(cols / 2), r: Math.floor(rows / 2) }, sel = null, hintKey = '', hintCells = new Set();
  let sentCur = '', sendAcc = 0, stepAcc = 0, lastPtr = '', flash = null, vp = { x: 0, y: 0 };

  // ---------- geometry and the view ----------
  function layout() {
    const A = areaOf(ctx.world);
    let x = A.cx, z = A.cz;
    if (Array.isArray(P.at)) { x = P.at[0]; z = P.at[P.at.length - 1]; }
    else { const zn = ctx.world.zone?.(P.at === 'centre' ? 'centre' : P.at); const a = zn?.at; if (a) { x = a.x ?? a[0]; z = a.z ?? a[2]; } }
    // the board, its seats and a walking strip fit the play area
    const room = P.presence === 'walk' ? 3.2 : 2.4;
    const cell = Math.max(0.6, Math.min(P.cell, (A.hx * 2 - room * 2) / cols, (A.hz * 2 - room * 2) / rows));
    G = geometry({ cols, rows, cell, x, z, rowZero: P.rowZero, seatSides: P.seatSides });
  }
  const mat = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0, ...extra });
  const tag = (o, k) => { try { ctx.assets?.tag?.(o, `mechanic.board.${kebab(k)}`); } catch { /* a bench without assets */ } return o; };
  function build() {
    const root = new THREE.Group(); root.name = 'gf-board'; root.position.set(G.x, 0, G.z);
    const c = G.cell, rim = c * 0.18;
    const slab = tag(new THREE.Mesh(new THREE.BoxGeometry(G.w + rim * 2, 0.06, G.d + rim * 2), mat(V('boardColor'))), 'boardColor');
    slab.position.y = 0.03; slab.receiveShadow = true; root.add(slab);
    const cellGeo = (P.cellShape === 'round' ? new THREE.CircleGeometry(c * 0.43, 28) : new THREE.PlaneGeometry(c * 0.94, c * 0.94)).rotateX(-Math.PI / 2);
    const cells = tag(new THREE.InstancedMesh(cellGeo, mat('#ffffff', { roughness: 0.85, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }), cols * rows), 'cellColor');
    const m4 = new THREE.Matrix4();
    for (let i = 0; i < cols * rows; i++) { const p = G.centre(i % cols, Math.floor(i / cols)); m4.makeTranslation(p.x - G.x, 0.064, p.z - G.z); cells.setMatrixAt(i, m4); cells.setColorAt(i, new THREE.Color('#fff')); }
    cells.receiveShadow = true; cells.frustumCulled = false; root.add(cells);
    // a legal cell on a round board is shown by a ring (logic.js hintStyle): one ring per cell, hidden (scale 0) until it is legal
    let rings = null;
    if (hintStyle(P.cellShape).ring) {
      rings = tag(new THREE.InstancedMesh(new THREE.RingGeometry(c * 0.34, c * 0.43, 32).rotateX(-Math.PI / 2), mat(V('hintColor'), { roughness: 0.6, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }), cols * rows), 'hintColor');
      const z0 = new THREE.Matrix4().makeScale(0, 0, 0);
      for (let i = 0; i < cols * rows; i++) rings.setMatrixAt(i, z0);
      rings.frustumCulled = false; root.add(rings);
    }
    // the rim takes the mover's colour: whose turn it is reads from the board itself, on every screen
    const rimMat = mat('#ffffff', { emissive: new THREE.Color('#000000'), emissiveIntensity: 0.55 });
    const rimMesh = tag(new THREE.Group(), 'boardColor');
    for (const [w, d, px, pz] of [[G.w + rim * 4, rim, 0, -(G.d / 2 + rim * 1.5)], [G.w + rim * 4, rim, 0, G.d / 2 + rim * 1.5], [rim, G.d + rim * 2, -(G.w / 2 + rim * 1.5), 0], [rim, G.d + rim * 2, G.w / 2 + rim * 1.5, 0]]) {
      const b = new THREE.Mesh(new THREE.BoxGeometry(w, 0.1, d), rimMat); b.position.set(px, 0.05, pz); b.castShadow = true; b.receiveShadow = true; rimMesh.add(b);
    }
    tag(rimMesh, 'boardColor'); root.add(rimMesh);
    ctx.scene.add(root);
    view = { root, slab, cells, rings, rimMat, pieces: new Array(cols * rows).fill(null), shown: '', anims: new Map(), marks: new Map(), mats: new Map(), geos: new Map(), color: new THREE.Color(), cellKey: '' };
  }
  function pieceGeo(kind) {
    const k = `${P.piece}:${kind > 0 ? 1 : 0}`; if (view.geos.has(k)) return view.geos.get(k);
    const r = G.cell * V('pieceSize') / 2, tall = kind > 0 ? 1.7 : 1;
    let g;
    if (P.piece === 'ball') g = new THREE.SphereGeometry(r * (kind > 0 ? 1 : 0.85), 24, 16).translate(0, r * 0.85, 0);
    else if (P.piece === 'block') g = new THREE.BoxGeometry(r * 1.5, r * 0.9 * tall, r * 1.5).translate(0, r * 0.45 * tall, 0);
    else if (P.piece === 'pawn') g = new THREE.LatheGeometry([[0, 0], [0.62, 0], [0.66, 0.1], [0.34, 0.22], [0.22, 0.7 * tall], [0.34, 0.86 * tall], [0.36, 1.02 * tall], [0.24, 1.2 * tall], [0, 1.26 * tall]].map(([x, y]) => new THREE.Vector2(x * r, y * r * 1.5)), 24);
    else g = new THREE.CylinderGeometry(r, r, 0.22 * tall, 30).translate(0, 0.11 * tall, 0);
    view.geos.set(k, g); return g;
  }
  const seatPlayer = seat => ctx.players.get(S?.o?.[seat]) ?? null;
  const seatOf = p => (p && S?.o ? S.o.indexOf(p.id) : -1);
  const seatColor = seat => seatPlayer(seat)?.color ?? ['#ff5a5a', '#4d8dff', '#ffd23f', '#58d68d'][seat % 4];
  function pieceMat(seat) { const col = seatColor(seat), k = `${seat}:${col}`; if (!view.mats.has(k)) view.mats.set(k, mat(col, { roughness: 0.35 })); return view.mats.get(k); }

  // ---------- "clear this area": the world's props that stand on the board or its seats are taken away ----------
  function clearArea() {
    const m = V('clear'); if (!(m > 0)) return;
    const props = ctx.world?.props, catalog = new Map((ctx.world?.catalog?.props ?? []).map(p => [p.id, p]));
    if (!(props instanceof Map)) return;
    const gone = new Set(), zero = new THREE.Matrix4().makeScale(0, 0, 0), key = (x, z) => `${Math.round(x * 20)}:${Math.round(z * 20)}`;
    for (const [pid, list] of props) {
      if ((catalog.get(pid)?.tags ?? []).some(t => KEEP_TAGS.includes(t))) continue;
      for (const it of list) {
        const at = it.at ?? [], x = at.x ?? at[0], z = at.z ?? at[2];
        if (!Number.isFinite(x) || !Number.isFinite(z) || !G.contains(x, z, m)) continue;
        for (const mesh of it.meshes ?? []) { mesh.setMatrixAt(it.instance, zero); mesh.instanceMatrix.needsUpdate = true; }
        gone.add(pid); cleared++;
      }
    }
    // their colliders too (the world's own fixed body): a prop collider whose middle is in the area
    const W = ctx.physics?.createRigidBody ? ctx.physics : ctx.physics?.world, shapes = ctx.world.shapes ?? [];
    if (!W || !gone.size) return;
    const dead = new Set(shapes.filter(s => gone.has(s.prop) && G.contains(s.position[0], s.position[2], m + 0.6)).map(s => key(s.position[0], s.position[2])));
    for (const c of (ctx.world.colliders ?? []).slice()) {
      let t = null; try { t = c.translation?.(); } catch { t = null; }
      if (t && dead.has(key(t.x, t.z)) && ((c.collisionGroups() >>> 16) & 0x4)) { try { W.removeCollider(c, true); } catch { /* already gone */ } }
    }
  }

  // ---------- the state every copy reads ----------
  const wireKey = () => (S ? `${S.g}|${S.t}|${S.n}|${(S.o ?? []).length}|${JSON.stringify(S.x ?? null)}` : '');
  function state() {
    const k = wireKey();
    if (!local || k !== localKey) { localKey = k; local = createState({ cols, rows, seats: Math.max(1, (S?.o ?? []).length) }, S ? { g: S.g, t: S.t, n: S.n, l: S.l, x: S.x } : null); hintKey = ''; }
    return local;
  }
  const over = () => !!S?.w;
  const playing = () => ctx.round?.phase === 'playing';
  const mover = () => (S?.o?.length ? seatPlayer(S.t) : null);

  // ---------- host: the one path every move takes ----------
  function begin() {
    const seats = ctx.players.list().slice().sort((a, b) => (a.seat ?? 0) - (b.seat ?? 0)).slice(0, MAX_SEATS);
    const s = createState({ cols, rows, seats: seats.length });
    s.turn = ((ctx.round?.number ?? 1) - 1) % Math.max(1, seats.length);      // a replay starts with the next seat
    try { R.start?.(s); } catch (e) { console.error(e); }
    Object.assign(S, s.toWire(), { o: seats.map(p => p.id), b: seats.map(p => (p.isBot ? '1' : '0')).join(''), w: null, d: V('turnSeconds') > 0 ? V('turnSeconds') : 0, k: 0 });
    endAt = -1; plans.clear(); refusals = 0;
    if (P.score !== 'none') for (const p of seats) p.score = P.score === 'pieces' ? s.count(seatOf(p)) : 0;
  }
  function refuse(p, why, cell) {
    refusals++; if (ctx.host && S) S.k = refusals;
    lastRefusal = { by: p?.id ?? null, why, at: ctx.time?.now ?? 0 };
    say(L.refuse, { player: p, why, cell });
    if (!p || p.isBot) return;
    if (p.local) showRefusal(why, cell); else ctx.net.send('board:no', { why: String(why).slice(0, 80), i: cell ? cell[1] * cols + cell[0] : -1 }, p.id);
  }
  function showRefusal(why, cell) {
    ctx.ui?.toast?.(why); ctx.audio?.play(V('soundRefuse'), { optional: true });
    lastRefusal = { by: ctx.me?.id ?? null, why, at: ctx.time?.now ?? 0 };
    if (cell) flash = { i: cell[1] * cols + cell[0], until: (ctx.time?.now ?? 0) + 0.6 };
  }
  /** Host: the turn goes to the next seat with no move played (nobody could, or nothing legal was found). */
  function pass() { S.t = (S.t + 1) % S.o.length; localKey = ''; plans.clear(); if (V('turnSeconds') > 0) S.d = Math.round(((ctx.time?.round ?? 0) + V('turnSeconds')) * 10) / 10; say(L.turn, { seat: S.t, player: seatPlayer(S.t), state: state() }); }
  /** Host: check and play. → null when played, else the reason. */
  function hostPlay(p, move, { auto = false } = {}) {
    if (!ctx.host || !S) return 'Only the host plays moves';
    const m = cleanMove(move), s = state();
    const why = !playing() ? 'The round is not running' : moveProblem(s, R, seatOf(p), m, { over: over() });
    if (why) { refuse(p, why === 'Not your turn' ? V('textNotYourTurn') : why, m?.to ?? null); return why; }
    const seat = s.turn, { result } = playMove(s, R, m, P.input);
    Object.assign(S, s.toWire()); localKey = '';
    if (V('turnSeconds') > 0) S.d = Math.round(((ctx.time?.round ?? 0) + V('turnSeconds')) * 10) / 10;
    if (P.score === 'pieces') S.o.forEach((pid, k) => { const q = ctx.players.get(pid); if (q) q.score = s.count(k); });
    plans.clear();
    say(L.move, { player: p, seat, move: m, state: s, auto });
    if (result) {
      S.w = { s: result.seats, c: result.cells.map(([c, r]) => r * cols + c), r: result.reason, d: result.draw ? 1 : 0 };
      if (P.score === 'win') for (const k of result.seats) { const q = seatPlayer(k); if (q) q.score += 1; }
      endAt = (ctx.time?.round ?? 0) + V('endDelay');
      say(L.end, { seats: result.seats, winners: result.seats.map(k => S.o[k]), cells: result.cells, reason: result.reason, draw: result.draw, state: s });
    } else say(L.turn, { seat: s.turn, player: seatPlayer(s.turn), state: s });
    return null;
  }
  /** Any copy, for a player it owns: propose a move. The local copy says why not at once; the host decides. */
  function propose(p, move) {
    if (!S || !p || !(p.owned || ctx.host)) return 'Not your player';
    const m = cleanMove(move);
    const why = !playing() ? 'The round is not running' : moveProblem(state(), R, seatOf(p), m, { over: over() });
    if (ctx.host) return hostPlay(p, m);
    if (why) { showRefusal(why === 'Not your turn' ? V('textNotYourTurn') : why, m?.to ?? null); return why; }
    ctx.net.send('board:move', { p: p.id, m }, 'host');
    return null;
  }
  /** What acting on a cell means for this game's input: a move, a selection, or a reason. */
  function actOn(p, cell) {
    if (!cell) { showRefusal(cursorMode ? 'Point at a cell' : 'Stand on the board', null); return; }
    const s = state(), seat = seatOf(p);
    if (over()) return;
    if (seat !== s.turn) { if (ctx.host) refuse(p, V('textNotYourTurn'), cell); else showRefusal(V('textNotYourTurn'), cell); return; }
    if (P.input === 'drop') { const r = s.dropRow(cell[0]); if (r < 0) { showRefusal('That column is full', cell); return; } propose(p, { type: 'place', to: [cell[0], r] }); return; }
    if (P.input === 'place') { propose(p, { type: 'place', to: cell }); return; }
    const own = s.owner(...cell) === seat;
    if (!sel) { if (own) { sel = cell; ctx.audio?.play(V('soundSelect'), { optional: true }); } else showRefusal('Pick one of your own pieces', cell); return; }
    if (sel[0] === cell[0] && sel[1] === cell[1]) { sel = null; return; }
    const move = { type: 'move', from: sel, to: cell };
    if (own && moveProblem(s, R, seat, move) !== null) { sel = cell; ctx.audio?.play(V('soundSelect'), { optional: true }); return; }
    if (propose(p, move) === null) sel = null;
  }

  // ---------- bots: the same legal, apply and winner, through hostPlay ----------
  function botMove(seat) { const s = state(); let m = null; try { m = R.bot?.(s, seat, ctx.rng) ?? null; } catch (e) { console.error(e); } return (m && moveProblem(s, R, seat, m) === null ? cleanMove(m) : null) ?? pickMove(s, R, seat, P.input, ctx.rng); }
  function botCell(p, m) {
    if (P.input !== 'drop') return m.to;
    // a dropped piece is let go at the column's end nearest the bot
    const a = G.centre(m.to[0], 0), b = G.centre(m.to[0], rows - 1);
    return Math.hypot(p.position.x - a.x, p.position.z - a.z) < Math.hypot(p.position.x - b.x, p.position.z - b.z) ? [m.to[0], 0] : [m.to[0], rows - 1];
  }
  function steer(p, dt, walked) {
    if (!ctx.host || !S || !p?.isBot) return;
    const seat = seatOf(p);
    if (!playing() || over() || seat < 0 || seat !== S.t) { if (walked) p.bot?.stop?.(); plans.delete(p.id); return; }
    let plan = plans.get(p.id);
    if (!plan) { plan = { wait: V('botThink') + ctx.rng() * 0.6, move: null, t: 0 }; plans.set(p.id, plan); }
    if (walked) plan.walked = ctx.time.now;
    plan.wait -= dt;
    if (plan.wait > 0) { if (walked) p.bot?.stop?.(); return; }
    plan.move ??= botMove(seat);
    if (!plan.move) { pass(); return; }
    const cell = botCell(p, plan.move), at = G.centre(...cell);
    plan.t += dt;
    if (cursorMode) {
      // the bot's mark steps toward the cell, one cell at a time
      const cur = cursors.get(p.id) ?? { c: Math.floor(cols / 2), r: Math.floor(rows / 2), sel: null };
      if ((plan.step = (plan.step ?? 0) + dt) >= 0.14 && (cur.c !== cell[0] || cur.r !== cell[1])) { plan.step = 0; cur.c += Math.sign(cell[0] - cur.c); cur.r += Math.sign(cell[1] - cur.r); cursors.set(p.id, cur); ctx.net.send('board:cur', { p: p.id, i: cur.r * cols + cur.c, s: -1 }, 'all'); }
      if ((cur.c === cell[0] && cur.r === cell[1] && plan.step >= 0.14) || plan.t > 6) hostPlay(p, plan.move);
      return;
    }
    const d = Math.hypot(p.position.x - at.x, p.position.z - at.z);
    // a bot whose body nobody steers (the rules have no bot hook) plays from where it stands
    const steered = walked || (plan.walked && ctx.time.now - plan.walked < 0.5);
    if (steered && d > G.cell * 0.42 && plan.t < 9) { p.bot?.seek?.({ x: at.x, y: 0, z: at.z }, { stop: G.cell * 0.2 }); return; }
    if (walked) p.bot?.stop?.();
    hostPlay(p, plan.move);
  }

  // ---------- this copy's player: which cell, and the press ----------
  const ray = new THREE.Raycaster(), plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -0.07), hit = new THREE.Vector3();
  function cellUnder(ndc) {
    ray.setFromCamera(ndc, ctx.camera);
    if (!ray.ray.intersectPlane(plane, hit)) return null;
    return G.cellAt(hit.x, hit.z, G.cell * 0.5);
  }
  function localInput(dt, me) {
    const inp = ctx.input, acts = me.actions ?? {};
    if (!cursorMode) {
      const c = G.cellAt(me.position.x, me.position.z, V('edgeReach'));
      mine = c ? { c: c[0], r: c[1], on: true } : { ...mine, on: false };
      if (acts[P.action]?.pressed) actOn(me, c);
      return;
    }
    // a cursor: the pointer (free), the middle of the screen (the mouse is taken and the camera turns), or the keys and stick
    if (me.controller) me.controller.enabled = false;
    const fixed = ['top', 'follow'].includes(ctx.config?.camera ?? 'third'), rig = me.controller?.rig;
    // a fixed camera (top, follow) looks at the board, square on from this player's side, not at the body beside it
    if (fixed && rig?.state?.pivot) {
      rig.yaw = G.seat(seatOf(me), S.o.length).yaw;
      ctx.camera.position.x += G.x - rig.state.pivot.x; ctx.camera.position.z += G.z - rig.state.pivot.z; ctx.camera.updateMatrixWorld();
    }
    if (inp) {
      const locked = !!inp.locked;
      let ndc = null;
      if (!locked && inp.pointer?.inside) ndc = { x: inp.pointer.x, y: inp.pointer.y };
      else if (locked && !fixed) ndc = { x: 0, y: 0 };
      else if (locked) { vp.x = Math.max(-1, Math.min(1, vp.x + (inp.look?.dx ?? 0) * 2 / innerWidth)); vp.y = Math.max(-1, Math.min(1, vp.y - (inp.look?.dy ?? 0) * 2 / innerHeight)); ndc = vp; }
      const k = ndc ? `${ndc.x.toFixed(3)},${ndc.y.toFixed(3)},${locked ? `${ctx.camera.rotation.x.toFixed(3)},${ctx.camera.rotation.y.toFixed(3)}` : ''}` : '';
      if (ndc && k !== lastPtr) { lastPtr = k; const c = cellUnder(ndc); if (c) mine = { c: c[0], r: c[1], on: true }; }
      // keys and the stick step the mark: "up" is away from the camera
      const mx = inp.move?.x ?? 0, my = inp.move?.y ?? 0, mag = Math.max(Math.abs(mx), Math.abs(my));
      stepAcc = mag > 0.5 ? stepAcc + dt : 0.2;
      if (mag > 0.5 && stepAcc >= 0.2) {
        stepAcc = 0;
        const f = new THREE.Vector3(); ctx.camera.getWorldDirection(f);
        const fwd = Math.abs(f.x) > Math.abs(f.z) * 1.15 ? [Math.sign(f.x), 0] : [0, Math.sign(f.z) || -1], right = [-fwd[1], fwd[0]];
        // a step in the world, one cell long, then the cell there (the geometry knows which end row 0 is)
        const wx = Math.abs(mx) > Math.abs(my) ? right[0] * Math.sign(mx) : fwd[0] * Math.sign(my), wz = Math.abs(mx) > Math.abs(my) ? right[1] * Math.sign(mx) : fwd[1] * Math.sign(my);
        const at = G.centre(mine.c, mine.r), to = G.cellAt(at.x + wx * G.cell, at.z + wz * G.cell, G.cell);
        if (to) mine = { c: to[0], r: to[1], on: true };
      }
    }
    if (acts.primary?.pressed || acts.interact?.pressed) actOn(me, [mine.c, mine.r]);
    // friends see the mark: an edge when it changes cell, at most 10 a second
    sendAcc += dt;
    const key = `${mine.c},${mine.r},${sel ? sel.join('.') : ''}`;
    if (key !== sentCur && sendAcc >= 0.1) { sentCur = key; sendAcc = 0; ctx.net.send('board:cur', { p: me.id, i: mine.r * cols + mine.c, s: sel ? sel[1] * cols + sel[0] : -1 }, 'all'); }
  }
  const cursorOf = p => {
    if (p.local) return mine.on === false ? null : { c: mine.c, r: mine.r, sel };
    if (cursorMode) return cursors.get(p.id) ?? null;
    const c = G.cellAt(p.position.x, p.position.z, V('edgeReach')); return c ? { c: c[0], r: c[1], sel: null } : null;
  };

  // ---------- every copy: draw from the shared state ----------
  function nameSprite(text, color) {
    const cv = document.createElement('canvas'); cv.width = 256; cv.height = 64;
    const g = cv.getContext('2d'); g.font = '700 34px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.lineWidth = 7; g.strokeStyle = '#10131ecc'; g.strokeText(text, 128, 34, 240); g.fillStyle = color; g.fillText(text, 128, 34, 240);
    const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true })); sp.scale.set(G.cell * 1.5, G.cell * 0.375, 1); sp.renderOrder = 5;
    return sp;
  }
  function markFor(p) {
    let m = view.marks.get(p.id);
    if (m && m.color === p.color && m.name === p.name) return m;
    if (m) m.group.removeFromParent();
    const group = new THREE.Group(), material = mat(p.color, { emissive: new THREE.Color(p.color), emissiveIntensity: 0.6, roughness: 0.4 });
    const ring = new THREE.Mesh(new THREE.TorusGeometry(G.cell * 0.4, G.cell * 0.045, 10, 36).rotateX(Math.PI / 2), material); ring.position.y = 0.1; group.add(ring);
    let pointer = null, label = null;
    if (cursorMode) {
      pointer = new THREE.Mesh(new THREE.ConeGeometry(G.cell * 0.16, G.cell * 0.42, 16).rotateX(Math.PI), material); pointer.castShadow = true; group.add(pointer);
      label = nameSprite(p.name ?? '', p.color); group.add(label);
    }
    tag(group, 'pieceSize'); view.root.add(group);
    m = { group, ring, pointer, label, color: p.color, name: p.name, x: null, z: null };
    view.marks.set(p.id, m); return m;
  }
  function draw(dt) {
    const s = state(), now = ctx.time?.now ?? 0, g = S.g ?? '', cur = mover(), me = ctx.me, myTurn = !!cur && cur === me && playing() && !over();
    // pieces: appear (drop), slide (a move), leave (taken)
    if (g !== view.shown) {
      const from = S.l?.[0] ?? -1, to = S.l?.[1] ?? -1;
      let landed = false;
      for (let i = 0; i < cols * rows; i++) {
        const was = view.shown[i] ?? '.', is = g[i] ?? '.';
        if (was === is) continue;
        const p = s.at(i % cols, Math.floor(i / cols));
        if (!p) { const m = view.pieces[i]; if (m) { if (i === from || !view.shown) m.visible = false; else view.anims.set(i, { kind: 'out', t: 0 }); } continue; }
        let m = view.pieces[i];
        if (!m) { m = new THREE.Mesh(pieceGeo(p.kind), pieceMat(p.seat)); m.castShadow = true; m.receiveShadow = true; tag(m, 'pieceSize'); view.root.add(m); view.pieces[i] = m; }
        m.geometry = pieceGeo(p.kind); m.material = pieceMat(p.seat); m.visible = true; m.scale.setScalar(1);
        if (!view.shown || was !== '.' && i !== to) view.anims.delete(i);                                    // the first look, or a piece that changed hands where it lies
        else if (i === to && from >= 0) view.anims.set(i, { kind: 'slide', t: 0, from });
        else view.anims.set(i, { kind: P.input === 'drop' ? 'lane' : 'drop', t: 0 });
        landed = true;
      }
      if (landed && view.shown) ctx.audio?.play(V('soundPlace'), { optional: true, at: to >= 0 ? { x: G.centre(to % cols, Math.floor(to / cols)).x, y: 0, z: G.centre(to % cols, Math.floor(to / cols)).z } : undefined });
      view.shown = g;
    }
    const win = S.w ? new Set(S.w.c ?? []) : null;
    if (!!S.w !== view.won) { view.won = !!S.w; if (S.w) ctx.audio?.play(V('soundWin'), { optional: true }); }
    for (let i = 0; i < view.pieces.length; i++) {
      const m = view.pieces[i]; if (!m || !m.visible) continue;
      const c = i % cols, r = Math.floor(i / cols), at = G.centre(c, r), a = view.anims.get(i);
      let x = at.x - G.x, z = at.z - G.z, y = 0.07, sc = 1;
      if (a) {
        a.t = Math.min(1, a.t + dt / (a.kind === 'out' ? 0.25 : 0.45)); const e = 1 - (1 - a.t) * (1 - a.t);
        if (a.kind === 'drop') y += (1 - e) * 2.2;
        else if (a.kind === 'lane') { z = (-G.d / 2 - G.cell) * (1 - e) + z * e; y += Math.sin(e * Math.PI) * 0.25; }
        else if (a.kind === 'slide') { const f = G.centre(a.from % cols, Math.floor(a.from / cols)); x = (f.x - G.x) * (1 - e) + x * e; z = (f.z - G.z) * (1 - e) + z * e; y += Math.sin(e * Math.PI) * 0.5; }
        else if (a.kind === 'out') { sc = 1 - e; if (a.t >= 1) m.visible = false; }
        if (a.t >= 1) view.anims.delete(i);
      }
      if (win?.has(i)) sc *= 1 + 0.1 * Math.sin(now * 8);
      m.position.set(x, y, z); m.scale.setScalar(Math.max(0.001, sc));
    }
    // cells: the two colours, the last move, the legal cells for the mover on this screen, the win, a refusal's flash
    if (V('hints') && myTurn) {
      const hk = `${localKey}|${sel ? sel.join('.') : ''}`;
      if (hk !== hintKey) {
        hintKey = hk; hintCells = new Set();
        const seat = s.turn;
        if (P.input === 'move') { if (sel) for (let i = 0; i < cols * rows; i++) if (moveProblem(s, R, seat, { type: 'move', from: sel, to: [i % cols, Math.floor(i / cols)] }) === null) hintCells.add(i); }
        else for (const m of candidates(s, R, seat, P.input)) hintCells.add(m.to[1] * cols + m.to[0]);
      }
    } else if (hintCells.size) { hintCells = new Set(); hintKey = ''; }
    const fl = flash && flash.until > now ? flash.i : -1;
    const ck = `${g}|${[...hintCells].join(',')}|${fl}|${S.w ? 1 : 0}|${sel ? sel.join('.') : ''}|${V('cellColor')}${V('cellColorB')}${Math.floor(now * 4) % 2 && S.w ? 'p' : ''}`;
    if (ck !== view.cellKey) {
      view.cellKey = ck;
      const A = new THREE.Color(V('cellColor')), B = new THREE.Color(V('cellColorB')), H = new THREE.Color(V('hintColor')), X = new THREE.Color(V('refuseColor')), W = new THREE.Color(V('winColor'));
      const last = S.l?.[1] ?? -1, hs = hintStyle(P.cellShape), m4 = new THREE.Matrix4();
      for (let i = 0; i < cols * rows; i++) {
        const c = i % cols, r = Math.floor(i / cols), col = view.color.copy(V('checker') && (c + r) % 2 ? B : A);
        if (i === last) col.lerp(W, 0.3);
        if (hintCells.has(i)) col.lerp(H, hs.tint);
        if (view.rings) { if (hintCells.has(i) && !win?.has(i)) { const p = G.centre(c, r); m4.makeTranslation(p.x - G.x, 0.068, p.z - G.z); } else m4.makeScale(0, 0, 0); view.rings.setMatrixAt(i, m4); }
        if (sel && sel[1] * cols + sel[0] === i) col.lerp(W, 0.7);
        if (win?.has(i)) col.lerp(W, 0.85);
        if (i === fl) col.copy(X);
        view.cells.setColorAt(i, col);
      }
      view.cells.instanceColor.needsUpdate = true;
      if (view.rings) { view.rings.instanceMatrix.needsUpdate = true; view.rings.material.color.set(V('hintColor')); }
    }
    view.slab.material.color.set(V('boardColor'));
    view.rimMat.color.set(V('boardColor')); view.rimMat.emissive.set(cur && playing() && !over() ? cur.color : '#000000');
    // every player's mark: the cell they are on (their feet, or their cursor), bright on their turn
    const seen = new Set();
    for (const p of ctx.players.list()) {
      const cu = seatOf(p) >= 0 && playing() ? cursorOf(p) : null;
      if (!cu) continue;
      seen.add(p.id);
      const m = markFor(p), at = G.centre(cu.c, cu.r), tx = at.x - G.x, tz = at.z - G.z, k = Math.min(1, dt * 14);
      m.x = m.x === null ? tx : m.x + (tx - m.x) * k; m.z = m.z === null ? tz : m.z + (tz - m.z) * k;
      m.group.position.set(m.x, 0, m.z); m.group.visible = true;
      const turn = p === cur && !over();
      m.ring.scale.setScalar(turn ? 1 + 0.06 * Math.sin(now * 6) : 0.8); m.ring.material.emissiveIntensity = turn ? 0.9 : 0.25;
      if (m.pointer) { m.pointer.position.y = G.cell * 1.15 + Math.sin(now * 4 + (p.seat ?? 0)) * 0.08; m.label.position.y = G.cell * 1.75; }
    }
    for (const [pid, m] of view.marks) if (!seen.has(pid)) m.group.visible = false;
    // whose turn: the goal line and the prompt
    if (ctx.ui) {
      let goal = null, prompt = null;
      if (playing() && S.o?.length) {
        if (S.w) goal = S.w.d ? V('textDraw') : `${(S.w.s ?? []).map(k => seatPlayer(k)?.name ?? 'Someone').join(' & ')} wins`;
        else if (cur) {
          const left = S.d > 0 ? Math.max(0, Math.ceil(S.d - (ctx.time?.round ?? 0))) : null;
          goal = (cur === me ? V('textYourTurn') : V('textTheirTurn').replace('{name}', cur.name ?? 'Someone')) + (left !== null && left <= 10 ? ` (${left})` : '');
          if (cur === me) { const key = cursorMode ? 'Click or E' : P.action === 'interact' ? 'E' : 'Click'; prompt = P.input === 'move' ? (sel ? `${key}: move there` : `${key}: pick a piece`) : P.input === 'drop' ? `${key}: drop in this column` : `${key}: place here`; if (!cursorMode && mine.on === false) prompt = 'Walk onto the board'; }
        }
      }
      if (goal !== view.goal) { view.goal = goal; ctx.ui.goal?.(goal); }
      if (prompt !== view.prompt) { view.prompt = prompt; ctx.ui.prompt?.(prompt, 'board'); }
    }
  }

  const api = {
    id, params: P,
    /** The game's rules: { legal(move, state) → true | reason, winner(state) → null | { seat, cells } | { draw: true }, and optionally apply(move, state), next(state, move) → seat, start(state), bot(state, seat, rng) → move }. */
    rules(r = {}) { R = { ...R, ...r }; localKey = ''; return api; },
    /** The board as the rules see it (every copy; read only off the host). */
    get state() { return S ? state() : null; },
    get geometry() { return G; },
    /** Whose turn: the player, their seat, and the seconds left when turns are timed. */
    turn() { const p = mover(); return S && p ? { seat: S.t, player: p, mine: p === ctx.me, left: S.d > 0 ? Math.max(0, S.d - (ctx.time?.round ?? 0)) : null } : null; },
    /** Host: hand the turn to a seat (a session flow that owns turn order calls this, or gives rules({ next })). */
    setTurn(seat) { if (ctx.host && S && Number.isInteger(seat) && seat >= 0 && seat < (S.o?.length ?? 0) && !over()) { S.t = seat; localKey = ''; plans.clear(); if (V('turnSeconds') > 0) S.d = (ctx.time?.round ?? 0) + V('turnSeconds'); } },
    /** The result once the board is won or drawn: { winners: [player ids], seats, cells, reason, draw }, else null. */
    result() { return S?.w ? { seats: S.w.s ?? [], winners: (S.w.s ?? []).map(k => S.o[k]), cells: (S.w.c ?? []).map(i => [i % cols, Math.floor(i / cols)]), reason: S.w.r, draw: !!S.w.d } : null; },
    seatOf, seatPlayer,
    /** Propose a move for a player this copy owns ({ type: 'place', to: [c, r] } or { type: 'move', from, to }). → null when it went, else the reason. */
    play: propose,
    /** Would this move be refused now? → null, or the reason (every copy). */
    problem(p, move) { return S ? moveProblem(state(), R, seatOf(p), move, { over: over() }) : 'No board yet'; },
    /** Every legal move a seat has now. */
    moves(seat = S?.t ?? 0) { return S ? candidates(state(), R, seat, P.input) : []; },
    /** The cell under a world position ([c, r] or null), and a cell's middle in the world. */
    cellAt: (x, z) => G?.cellAt(x, z, 0) ?? null,
    centre: (c, r) => { const p = G.centre(c, r); return { x: p.x, y: 0.07, z: p.z }; },
    /** The cell a player is on: their feet (walk) or their mark (cursor). */
    cursor(p = ctx.me) { const c = p && G ? cursorOf(p) : null; return c ? [c.c, c.r] : null; },
    /** rules.bot(ctx, p, dt) calls this so a bot walks to its cell before it plays; without it a bot still plays, from where it stands. */
    bot(p, dt) { steer(p, dt, true); },
    /** Host: { player, seat, move, state, auto } after a move; { player, why, cell } when one is refused; { winners, seats, cells, reason, draw } when the board is decided; { seat, player } when the turn passes. → unsubscribe */
    onMove(fn) { L.move.push(fn); return unsub(L.move, fn); },
    onRefuse(fn) { L.refuse.push(fn); return unsub(L.refuse, fn); },
    onEnd(fn) { L.end.push(fn); return unsub(L.end, fn); },
    onTurn(fn) { L.turn.push(fn); return unsub(L.turn, fn); },
    get interacts() { return !cursorMode && P.action === 'interact'; },
    /** What the local player can act on now (QA, verify check 13): their legal cells, on their turn. */
    interactables() {
      if (cursorMode || !S || !G || !playing() || over() || mover() !== ctx.me || P.input === 'move') return [];
      const reach = Math.max(0.5, (G.cell / 2 - 0.25) / 0.6);
      return candidates(state(), R, S.t, P.input).slice(0, 24).map(m => { const cell = P.input === 'drop' ? [m.to[0], rows - 1] : m.to, at = G.centre(...cell); return { kind: 'board', id: `board:${S.n}:${cell[1] * cols + cell[0]}`, x: at.x, y: 0, z: at.z, reach, touch: 0, action: P.action, turn: true, verb: P.input === 'drop' ? 'dropped a piece in the column' : 'placed a piece' }; });
    },
    /**
     * What the local player can point at and click now (QA, verify check 13 and the test player that takes its turn):
     * with a cursor, on their turn, the cells a legal move starts on (input "move": the pieces that can move, then,
     * once one is picked, where it may go). → [{ kind, id, x, y (CSS pixels on this screen), cell, action, turn, step, of }]
     */
    points() {
      if (!cursorMode || !S || !G || !playing() || over() || mover() !== ctx.me) return [];
      const moves = candidates(state(), R, S.t, P.input), px = api.screen(), seen = new Set(), out = [];
      const two = P.input === 'move', picked = two && sel && moves.some(m => m.from[0] === sel[0] && m.from[1] === sel[1]);
      for (const m of moves) {
        if (picked && !(m.from[0] === sel[0] && m.from[1] === sel[1])) continue;
        const cell = two && !picked ? m.from : P.input === 'drop' ? [m.to[0], rows - 1] : m.to, i = cell[1] * cols + cell[0];
        if (seen.has(i) || !px[i]) continue; seen.add(i);
        out.push({ kind: 'board', id: `board:${S.n}:${two ? (picked ? 'to' : 'pick') : 'at'}:${i}`, x: px[i][0], y: px[i][1], cell, action: 'primary', turn: true, step: two && !picked ? 1 : two ? 2 : 1, of: two ? 2 : 1,
          verb: two && !picked ? 'picked a piece' : two ? 'moved the piece' : P.input === 'drop' ? 'dropped a piece in the column' : 'placed a piece' });
      }
      return out.slice(0, 24);
    },
    /** Where a player IS, when this part holds their body (a cursor: the mark over the cells), for the kit's observation and the two-player gate; null → the body. */
    presence(p) {
      if (!cursorMode || !S || !G || !playing() || !p) return null;
      const c = p.local ? (mine.on === false ? null : mine) : cursors.get(p.id) ?? null;
      if (!c) return null;
      const at = G.centre(c.c, c.r); return { x: at.x, y: 0.1, z: at.z };
    },
    get stats() { return { moves: S?.n ?? 0, refused: refusals, cleared }; },
    /** QA: where each cell's middle is on this screen, in CSS pixels ([x, y] per cell from row 0), so a test or a play-tester can point at one. */
    screen() { if (!G) return []; const v = new THREE.Vector3(), out = []; for (let i = 0; i < cols * rows; i++) { const p = G.centre(i % cols, Math.floor(i / cols)); v.set(p.x, 0.07, p.z).project(ctx.camera); out.push([Math.round((v.x + 1) / 2 * innerWidth), Math.round((1 - v.y) / 2 * innerHeight)]); } return out; },
    observe: () => ({ cols, rows, cell: G?.cell ?? null, at: G ? [G.x, G.z] : null, input: P.input, presence: P.presence, turn: S?.t ?? null, mover: mover()?.id ?? null, moves: S?.n ?? 0, grid: S?.g ?? null, result: api.result(), refused: refusals, lastRefusal, cleared, cursor: api.cursor(), sel, screen: api.screen(), cursors: ctx.players?.list().map(p => ({ id: p.id, cell: G && S ? api.cursor(p) : null })) ?? [] }),
    setup() {
      layout(); build();
      try { clearArea(); } catch (e) { console.error(e); }
      S = ctx.shared.register('board', { g: '', t: 0, n: 0, l: [-1, -1], x: {}, o: [], b: '', w: null, d: 0, k: 0 });
    },
    reset() { lastPhase = null; endAt = -1; plans.clear(); cursors.clear(); sel = null; local = null; localKey = ''; if (view) { view.shown = ''; view.anims.clear(); for (const m of view.pieces) if (m) m.visible = false; view.won = false; } },
    update(dt) {
      if (!S || !view) return;
      const ph = ctx.round?.phase;
      if (ph !== lastPhase) {
        const was = lastPhase; lastPhase = ph;
        if (ph === 'playing') {
          if (ctx.host) begin();
          sel = null; mine = { c: Math.floor(cols / 2), r: Math.floor(rows / 2), on: cursorMode }; sentCur = ''; cursors.clear();
          // each player this copy owns stands at their side of the board (a walker starts beside it; a cursor's body stays there)
          if (P.seats) { const order = ctx.players.list().slice().sort((a, b) => (a.seat ?? 0) - (b.seat ?? 0)); order.forEach((p, k) => { if (p.owned && k < MAX_SEATS) { const st = G.seat(k, Math.min(MAX_SEATS, order.length)); try { p.teleport?.({ x: st.x, y: 0, z: st.z }, st.yaw); } catch (e) { console.error(e); } } }); }
        } else if (was === 'playing') { ctx.ui?.prompt?.(null, 'board'); view.prompt = null; }
      }
      const me = ctx.me;
      if (ph === 'playing' && me && seatOf(me) >= 0) localInput(dt, me);
      if (cursorMode && ph === 'playing') for (const p of ctx.players.owned()) if (p.controller && p !== me) p.controller.enabled = false;
      if (ctx.host && ph === 'playing' && S.o?.length) {
        if (S.w) { if (P.endsRound && endAt >= 0 && ctx.time.round >= endAt) { endAt = -1; ctx.round.end(S.w.r || 'won', (S.w.s ?? []).map(k => S.o[k])); } }
        else {
          const cur = mover();
          // a bot the rules do not steer still plays; a turn that runs out is played for its player
          if (cur?.isBot) { const plan = plans.get(cur.id); if (!plan || !(plan.walked && ctx.time.now - plan.walked < 0.5)) steer(cur, dt, false); }
          if (S.d > 0 && ctx.time.round >= S.d) {
            const m = cur ? botMove(S.t) : null;
            if (!(m && cur) || hostPlay(cur, m, { auto: true }) !== null) pass();
          }
        }
      }
      draw(dt);
    },
    /** `board:move` (a player's copy → the host), `board:no` (the host → that player), `board:cur` (a mark moved → everyone). */
    event(name, d, from) {
      if (!S || !d) return;
      if (name === 'no') { showRefusal(String(d.why ?? 'Refused').slice(0, 80), Number.isInteger(d.i) && d.i >= 0 ? [d.i % cols, Math.floor(d.i / cols)] : null); sel = null; return; }
      if (name === 'cur') {
        const p = ctx.players.get(d.p); if (!p || p.local || !Number.isInteger(d.i) || d.i < 0 || d.i >= cols * rows) return;
        if (ctx.net.active && from !== undefined && from !== p.id && !p.isBot) return;
        cursors.set(p.id, { c: d.i % cols, r: Math.floor(d.i / cols), sel: Number.isInteger(d.s) && d.s >= 0 ? [d.s % cols, Math.floor(d.s / cols)] : null });
        return;
      }
      if (name !== 'move' || !ctx.host) return;
      const p = ctx.players.get(d.p);
      // a move is its sender's: nobody plays for another player
      if (!p || p.isBot || (ctx.net.active && from !== undefined && from !== p.id)) return;
      hostPlay(p, d.m);
    },
    dispose() { view?.root.removeFromParent(); ctx.ui?.prompt?.(null, 'board'); },
  };
  return api;
}

// ---------------------------------------------------------------------------------------------------------------------
// The part's manifest (tools/catalog.mjs MANIFEST lists the fields): what `create` composes and refuses by, what the
// catalog tells a pitch, the handlers and traps of the rules.js stub, and verify check 15's sign of life. The tools
// read it in Node; nothing in play does.
// ---------------------------------------------------------------------------------------------------------------------
export const manifest = {
  id, examples, params,
  describe: 'A grid on the floor: take turns placing or moving pieces by the game\'s own legal and winner rules; refusals with a reason; bots',
  // a board has no player body of its own: the pitch asks how each player is shown (presence: walk | cursor) unless the creator said
  asks: [{ about: 'body', why: 'on a board each player is a character walking beside it (presence walk) or a mark that moves over the cells (presence cursor)' }],
  needs: { parts: [], world: [] },
  uses: [],
  owns: p => [
    ...(p.presence === 'cursor'
      ? [{ res: 'player.control', why: 'with a cursor the player\'s body stands at the board and the keys move their mark (params.presence)', free: 'set board params.presence to "walk"' },
        { res: 'input.primary', shared: true, why: 'a click acts on the cell under the mark', free: 'set board params.presence to "walk"' },
        { res: 'input.interact', shared: true, why: 'interact acts on the cell under the mark', free: 'set board params.presence to "walk"' }]
      : [{ res: `input.${p.action}`, shared: true, why: `${p.action} acts on the cell under the player's feet (params.action)`, free: 'set board params.action to the other input' }]),
    ...(p.endsRound ? [{ res: 'round.end', why: 'a won or drawn board ends the round (params.endsRound)', free: 'set board params.endsRound to false and end the round in rules.check' }] : []),
  ],
  state: { key: 'board', fields: {
    g: 'the grid, one letter a cell from row 0 ("." empty; read it with board.state.at(c, r), never by hand)', t: 'the seat whose turn it is', n: 'moves played', l: '[from, to] cell indexes of the last move (-1: none)',
    o: 'player ids in seat order', b: 'a 1 per seat that is a bot', w: 'null, or the result { s: winning seats, c: cells, r: reason, d: 1 for a draw }', d: 'the round second the turn runs out (0: untimed)', k: 'moves refused so far', x: 'the game\'s own data (state.data)' } },
  events: [
    { name: 'onMove', on: 'host', args: '{ player, seat, move, state, auto }', when: 'a legal move was played (auto: the turn ran out and the host played it)' },
    { name: 'onRefuse', on: 'host', args: '{ player, why, cell }', when: 'a move was refused: not legal, or not that player\'s turn' },
    { name: 'onEnd', on: 'host', args: '{ winners, seats, cells, reason, draw }', when: 'the board was won or drawn (the round ends after endDelay)' },
    { name: 'onTurn', on: 'host', args: '{ seat, player, state }', when: 'the turn passed to a seat' },
  ],
  sync: { owner: 'host', how: 'the host owns the grid, the turn and the result; a copy sends its move and is told why when it is refused; a cursor mark is its own player\'s' },
  note: [
    'Give the rules once, in setup: board.rules({ legal(move, s) → true or the reason in words, winner(s) → null | { seat, cells } | { draw: true } }). The board does turns, refusals, pieces, the win line, bots and the end of the round.',
    'A move is { type: "place", to: [c, r] } or { type: "move", from, to }. s has at, empty, owner, set, line, flank, reach, dropRow, count, full, last, turn, data. apply(move, s) for captures, start(s) for the opening (README.md).',
    'input "place" | "drop" (a column, it slides) | "move". presence "walk" (bodies on the board) or "cursor" (bodies stand at the table, each player moves a mark): ask the creator which when the prompt does not say.',
  ],
  stub: {
    as: 'board',
    worked: 'board.rules({ legal: (m, s) => s.empty(...m.to) || \'That cell is taken\', winner: s => { const l = s.last && s.line(...s.last, 3); return l ? { seat: s.owner(...s.last), cells: l } : s.full() ? { draw: true } : null; } });',
    traps: [
      'legal and winner run on every copy and in the bot\'s look ahead: read only the state they are handed, change nothing in them',
      'bots already play (and the turn timer plays for an idle player): add bot(ctx, p, dt) { board.bot(p, dt); } to the hooks only so a bot walks to its cell first',
      'the board ends the round and scores the winner (params.score, endsRound): leave check() returning null, or it ends twice',
    ],
  },
  signs: {
    // n: moves, t: whose turn, w: decided, bot: is the mover a bot, k: refusals
    sample: sh => (sh.board ? { board: [sh.board.n ?? 0, sh.board.t ?? 0, sh.board.w ? 1 : 0, (sh.board.b ?? '')[sh.board.t ?? 0] === '1' ? 1 : 0, sh.board.k ?? 0, (sh.board.o ?? []).length] } : null),
    judge: v => {
      // per round on a page: did a move land, did the turn pass, how long one bot sat on its turn, and how many bot
      // turns went by with no move at all
      let moves = 0, passed = false, seated = 0, botStall = 0, botPasses = 0, humanWait = 0, decided = false;
      for (const p of v.pages) {
        let last = null, botSince = null;
        for (const s of p.samples) {
          const b = s.sh?.board; if (!Array.isArray(b) || s.ph !== 'playing') { botSince = null; last = null; continue; }
          seated = Math.max(seated, b[5]); moves = Math.max(moves, b[0]);
          if (last && b[1] !== last[1]) { passed = true; if (last[3] && b[0] === last[0] && !b[2]) botPasses++; }
          if (b[2]) decided = true;
          const t = s.t ?? s.w ?? 0;
          if (b[3] && !b[2]) { if (!botSince || b[0] !== botSince.n || b[1] !== botSince.seat) botSince = { t, n: b[0], seat: b[1] }; botStall = Math.max(botStall, t - botSince.t); }
          else { botSince = null; if (!b[2]) humanWait += 0.25; }
          last = b;
        }
      }
      const think = (v.game.mechanics ?? []).find(m => m.id === 'board')?.params ?? {};
      const limit = (think.botThink ?? 1.1) + 12;
      if (!seated) { v.add('players are seated', 'dead', 'shared.board.o', `no round seated anyone at the board (${v.names})`, 'the board seats the round\'s players when play starts: is the round reaching "playing"?'); return; }
      if (botStall > limit) v.add('a bot plays its turn', 'dead', 'shared.board.t, n, b', `a bot held the turn for ${Math.round(botStall)} s without a move`, 'does legal or winner throw? open the game with ?bots=1 and read the console');
      else if (!moves && botPasses >= 2) v.add('a move is played', 'dead', 'shared.board.t, n, b', `the turn went past a bot ${botPasses} times and no move ever landed: the rules leave nobody a legal move`, 'legal(move, s) must return true for a move that is allowed (and the reason only when it is not); try board.moves(0) in the console');
      else if (moves > 0) v.add('a move is played', 'ok', 'shared.board.n, t', `${moves} move${moves === 1 ? '' : 's'} landed${passed ? ' and the turn passed' : ''}${decided ? '; a board was decided' : ''}`);
      // it was the person's turn the whole time and nobody pressed anything: that is not the board being dead, and
      // this check cannot tell (verify's walker does not play a board). Said, not failed.
      else v.add('a move is played', 'note', 'shared.board.n, t', `no move in the window: it was a person's turn for ${Math.round(humanWait)} s and the walker does not play a board (the turn timer plays for them after turnSeconds)`);
    },
  },
};
