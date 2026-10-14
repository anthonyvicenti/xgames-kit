// mechanic: paint (track K2). Paints the ground and its zones per player or team from hit points, gives coverage per
// owner, can be repainted. An owner grid (a few hundred cells), not a render target: cheap on the low tier.
// README.md has ownership and API.
//
//   const paint = ctx.mechanics.get('paint');
//   paint.splat(ctx.me, { x: 3, z: 1 });            // host: paint there for that player's colour
//   paint.coverage();                                // every copy: [{owner, label, color, cells, share}]
import * as THREE from 'three';
import { createGrid, rasterize, leaderOf } from './logic.js';
import { areaOf } from '../../core/util.js';

export const id = 'paint';
export const examples = ['paint the arena with your colour', 'territory score from sprayed ground', 'ink trail while running'];

const D = { by: 'player', cell: 1, maxCells: 400, radius: 1.3, repaint: true, opacity: 0.85, height: 0.03, fromProjectile: true, streamRadius: 0.8, walkRadius: 0, walkInterval: 0.2, zones: [] };
const kebab = s => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
const num = (description, minimum, maximum) => ({ type: 'number', description, minimum, maximum });
export const params = {
  type: 'object', additionalProperties: true,
  properties: {
    by: { type: 'string', enum: ['player', 'team'], default: D.by, description: 'Who owns paint: each player, or each team (the teams mechanic)' },
    cell: { ...num('Preferred cell size in metres (cells grow so that there are at most maxCells)', 0.25, 6), default: D.cell },
    maxCells: { type: 'integer', minimum: 16, maximum: 900, default: D.maxCells, description: 'Most cells in the grid (the whole grid travels in about 2 bytes a cell at worst)' },
    radius: { ...num('Radius of a splat from a thrown shot (m)', 0.2, 8), default: D.radius },
    repaint: { type: 'boolean', default: D.repaint, description: 'A later splat takes cells from the previous owner' },
    opacity: { ...num('Paint opacity', 0.1, 1), default: D.opacity },
    height: { ...num('Height above the ground the paint is drawn at (m)', 0.005, 0.2), default: D.height },
    fromProjectile: { type: 'boolean', default: D.fromProjectile, description: 'Paint where the projectile mechanic\'s shots and streams touch the world' },
    streamRadius: { ...num('Radius of a splat from a stream tick (m)', 0.2, 6), default: D.streamRadius },
    walkRadius: { ...num('Paint under walking players with this radius (0: off, the ink-trail mode)', 0, 5), default: D.walkRadius },
    walkInterval: { ...num('Seconds between trail splats', 0.05, 2), default: D.walkInterval },
    zones: { type: 'array', items: { type: 'string' }, default: D.zones, description: 'World zone names to report coverage for (zoneOwner)' },
  },
};
const vs = (name, label, type, extra = {}) => ({ id: `mechanic.paint.${kebab(name)}`, label, group: 'mechanics', type, source: { pointer: `{base}/${name}` }, tier: 'advanced', facet: type === 'color' ? 'look' : 'gameplay', ...extra });
export const slots = [
  vs('radius', 'Splat size', 'number', { tier: 'main', rank: 48, constraints: { min: 0.2, max: 8, unit: 'm' } }),
  vs('opacity', 'Paint opacity', 'number', { rank: 36, constraints: { min: 0.1, max: 1 } }),
  vs('repaint', 'Paint can be taken over', 'boolean', { rank: 30 }),
  vs('streamRadius', 'Stream splat size', 'number', { constraints: { min: 0.2, max: 6, unit: 'm' } }),
  vs('walkRadius', 'Trail width (0 off)', 'number', { constraints: { min: 0, max: 5, unit: 'm' } }),
  vs('cell', 'Cell size', 'number', { constraints: { min: 0.25, max: 6, unit: 'm' } }),
  vs('height', 'Paint height', 'number', { constraints: { min: 0.005, max: 0.2, unit: 'm' } }),
];

const hex = c => { const n = new THREE.Color(c); return [Math.round(n.r * 255), Math.round(n.g * 255), Math.round(n.b * 255)]; };   // sRGB bytes

export function create(ctx, params = {}) {
  const P = { ...D, ...params };
  const V = k => { const sid = `mechanic.paint.${kebab(k)}`; try { return ctx.assets?.has(sid) ? ctx.assets.value(sid, P[k]) : P[k]; } catch { return P[k]; } };
  const A = areaOf(ctx.world);
  const grid = createGrid({ minX: A.minX, maxX: A.maxX, minZ: A.minZ, maxZ: A.maxZ }, P.cell, P.maxCells);
  const color = new THREE.Color();
  const tex = new THREE.DataTexture(new Uint8Array(grid.w * 4 * grid.h * 4 * 4), grid.w * 4, grid.h * 4, THREE.RGBAFormat);
  tex.colorSpace = THREE.SRGBColorSpace; tex.magFilter = THREE.LinearFilter; tex.minFilter = THREE.LinearFilter; tex.needsUpdate = true;
  // Lit like the ground it lies on: the look's 'decal' house material (the ground's light, bands, shadow floor and colour
  // treatment, without its noise detail), else a standard lit material. It receives shadows, so paint darkens under a
  // player and at night instead of glowing on top of the scene (it was an unlit MeshBasicMaterial).
  const lookMat = ctx.modules?.look?.material;
  let mat = null;
  try { mat = typeof lookMat === 'function' ? lookMat('decal', { map: tex, transparent: true }) : null; } catch { mat = null; }
  mat ??= new THREE.MeshStandardMaterial({ map: tex, transparent: true, roughness: 0.9, metalness: 0 });
  Object.assign(mat, { depthWrite: false, side: THREE.FrontSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  // facing up (lit from above), with the texture laid out as before: rotateX(-90°) maps the plane's +y to -z, so v flips
  const geo = new THREE.PlaneGeometry(A.maxX - A.minX, A.maxZ - A.minZ).rotateX(-Math.PI / 2);
  const uv = geo.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - uv.getY(i));
  const plane = new THREE.Mesh(geo, mat);
  plane.position.set(A.cx, V('height'), A.cz); plane.renderOrder = 2; plane.name = 'gf-paint'; plane.frustumCulled = false;
  plane.receiveShadow = true; plane.castShadow = false;
  ctx.assets.tag(plane, 'mechanic.paint.opacity'); ctx.scene.add(plane);
  let S = null, dirty = true, lastSent = '', sendAcc = 0, lastStr = null, linked = false, walkAcc = 0;
  const colorCache = new Map();

  const teams = () => { const t = ctx.mechanics?.get('teams'); return t && !t.standin ? t : null; };
  const ownerIdx = p => { if (!p) return -1; if (V('by') === 'team') return teams()?.teamOf(p) ?? -1; return p.seat ?? -1; };
  const idxColor = k => {
    const key = `${V('by')}:${k}`; let c = colorCache.get(key);
    const live = V('by') === 'team' ? teams()?.colorOf?.(k) : ctx.players.list().find(p => p.seat === k)?.color;
    if (!c || (live && c.src !== live)) { c = { src: live, rgb: live ? hex(live) : [200, 200, 200] }; colorCache.set(key, c); }
    return c.rgb;
  };
  const label = k => (V('by') === 'team' ? teams()?.nameOf?.(k) ?? `Team ${k + 1}` : ctx.players.list().find(p => p.seat === k)?.name ?? `Player ${k + 1}`);
  function redraw() {
    const r = rasterize(grid.owners, grid.w, grid.h, idxColor, { alpha: V('opacity') });
    tex.image.data.set(r.data); tex.needsUpdate = true;
  }

  const api = {
    id, params: P, grid,
    /** Host: paint at point {x, z} for this player (or team index when paint is by team). opts {radius}. → cells that changed hands */
    splat(owner, point, opts = {}) {
      if (!ctx.host || !S) return 0;
      const k = typeof owner === 'number' ? owner : ownerIdx(owner);
      if (k < 0 || k > 25) return 0;
      const n = grid.splat(point.x, point.z, opts.radius ?? V('radius'), k, { repaint: V('repaint') });
      if (n) dirty = true;
      return n;
    },
    /** Every copy: standings by cells held, biggest first: [{owner (player id or "t0"), index, label, color, cells, share}]. share is of all cells. */
    coverage() {
      const total = grid.owners.length, counts = grid.counts();
      return Object.entries(counts).map(([k, cells]) => ({ index: Number(k), owner: V('by') === 'team' ? `t${k}` : ctx.players.list().find(p => p.seat === Number(k))?.id ?? `s${k}`, label: label(Number(k)), color: `#${color.setRGB(...idxColor(Number(k)).map(v => v / 255), THREE.SRGBColorSpace).getHexString()}`, cells, share: cells / total })).sort((a, b) => b.cells - a.cells);
    },
    /** Share (0..1) of all cells held by this player (or team index). */
    coverageOf(owner) { const k = typeof owner === 'number' ? owner : ownerIdx(owner); return (grid.counts()[k] ?? 0) / grid.owners.length; },
    /** Share of all cells that are painted at all. */
    painted: () => grid.painted() / grid.owners.length,
    /** Who holds most of a world zone: {index, share (of the zone's cells), cells} or null. */
    zoneOwner(name) {
      const z = ctx.world.zone?.(name); if (!z) return null;
      const mask = n => { const c = grid.centre(n); return z.contains({ x: c.x, y: z.at?.y ?? 0, z: c.z }); };
      let total = 0; for (let n = 0; n < grid.owners.length; n++) if (mask(n)) total++;
      const l = leaderOf(grid.counts(mask), total);
      return l ? { index: l.owner, share: l.share, cells: l.cells } : null;
    },
    /** Host: wipe the paint (or fill it with one owner). */
    clear() { if (ctx.host) { grid.clear(); dirty = true; } },
    fill(owner) { if (ctx.host) { grid.fill(typeof owner === 'number' ? owner : ownerIdx(owner)); dirty = true; } },
    reset() { grid.clear(); dirty = true; lastSent = ''; lastStr = null; },
    update(dt) {
      if (!S) { if (!(ctx.shared && ctx.players && ctx.me)) return; S = ctx.shared.register('paint', { g: '' }); }
      if (ctx.host) {
        if (!linked) { linked = true; const prj = ctx.mechanics.get('projectile'); if (V('fromProjectile') && prj && !prj.standin) prj.onSurface(h => { if (h.shooter) api.splat(h.shooter, h.point, { radius: h.kind === 'stream' ? V('streamRadius') : V('radius') }); }); }
        if (V('walkRadius') > 0 && ctx.round?.phase === 'playing' && (walkAcc += dt) >= V('walkInterval')) {
          walkAcc = 0;
          for (const p of ctx.players.list()) if (p.alive !== false && p.position.y < 1.2) api.splat(p, p.position, { radius: V('walkRadius') });
        }
        if (dirty && (sendAcc += dt) >= 0.1) { sendAcc = 0; dirty = false; const s = grid.encode(); if (s !== lastSent) { lastSent = s; S.g = s; } redraw(); }
      } else {
        const s = S.g;
        if (typeof s === 'string' && s !== lastStr) { lastStr = s; if (grid.decode(s)) redraw(); }
      }
      plane.position.y = V('height');
    },
    dispose() { plane.removeFromParent(); tex.dispose(); mat.dispose(); },
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
  describe: 'Surface coverage per player or team; territory score',
  rank: 20,
  needs: { parts: [], world: [] },
  uses: ['projectile', 'teams'],
  owns: () => [],
  // what a territory score follows: each player's share (of their seat, or their team's); verify gate D counts a change
  // of it as a counted event (kit/core/events.js samples it)
  counters: (api, ctx) => ctx.players.list().map(p => [p.id, api.coverageOf(p)]),
  state: { key: 'paint', fields: { g: 'the owner grid as a run-length string (decode with paint.coverage(), never by hand)' } },
  events: [],
  sync: { owner: 'host', how: 'the host owns the grid; every copy decodes the string and redraws the decal' },
  note: [
    'With the projectile mechanic, paint lands under every shot and stream by itself (fromProjectile); otherwise the host calls paint.splat(player, { x, z }).',
    'paint.coverage() gives each owner\'s share on every copy: score from it in results() or check(), not per frame.',
    'by "team" paints in team colours: for a game with the teams mechanic.',
  ],
  stub: {
    as: 'paint',
    worked: 'results(ctx) { return paint.coverage().map(c => ({ id: c.owner, name: c.label, value: Math.round(c.share * 100) })); }',
    traps: ['paint.splat, clear and fill change the grid on the host only: keep them under if (ctx.host)'],
  },
  signs: {
    sample: sh => { if (!sh.paint) return null; const g = sh.paint.g ?? ''; let h = 0; for (let i = 0; i < g.length; i++) h = (h * 31 + g.charCodeAt(i)) | 0; return { paint: `${h}:${g.length}` }; },
    judge: v => {
      const ok = v.others.paintChanged;
      v.add('paint changes', ok ? 'ok' : 'dead', 'shared.paint.g', ok ? 'yes' : `no cell was painted on any page (${v.names})`, ok ? '' : 'check paint.fromProjectile and that shots land on the ground (or rules call paint.splat)');
    },
  },
};
