// The terrain world's checks (worlds/terrain), the ones a layout world gets from the set-dressing lint (check 11) and the
// world check (check 17): read in Node from config/world.json, the ground generated as the game will generate it (the
// game's own gf/three copy, else the kit's), no browser.
//
//   terrainDressing(dir) → {errors, warnings, problems: [{severity, rule, message, fix}], stats}   check 11's rules:
//                          nothing floating (every piece of ground stands on the box's floor), spawns clear (open air
//                          over them, no other spawn within 3 m, the ground under them no steeper than a walk)
//   terrainWorld(dir)    → {ok, detail, report: {errors, warnings, stats}, notes}                   check 17's rules:
//                          land above the sea for every player, a sea round it, the ground's pictures present and
//                          seamless (their opposite edges meet), the box sealed
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { KIT, kitPath } from './paths.mjs';

/** How much sharper than its usual line a picture's sharpest straight line may be before it counts as a seam. */
export const SEAM = 5;

async function loadTerrain(dir) {
  const game = resolve(dir);
  const cfg = JSON.parse(await readFile(join(game, 'config/world.json'), 'utf8'));
  if (cfg.template !== 'terrain') throw new Error(`config/world.json template is "${cfg.template}", not "terrain"`);
  const own = join(game, 'gf/three/world/terrain/generate.mjs');
  const mod = await import(pathToFileURL(existsSync(own) ? own : kitPath(KIT, 'world/terrain/generate.mjs')).href);
  const gameCfg = JSON.parse(await readFile(join(game, 'config/game.json'), 'utf8').catch(() => '{}'));
  const gen = mod.generateTerrain(cfg.terrain ?? {});
  // the spawns as the world lays them (worlds/terrain/world.js): the config's own, else twice the count found, paired in sight
  const n = Number.isInteger(cfg.spawns) ? cfg.spawns : 8;
  const spawns = Array.isArray(cfg.spawns) ? cfg.spawns.map(s => ({ x: s[0], y: s[1], z: s[2] })) : mod.seatSpawns(gen.field, mod.spawnsOn(gen.field, n * 2, gen.params.seed), { count: n });
  return { game, cfg, gameCfg, gen, spawns, sea: cfg.sea?.level ?? 0, mod };
}

export async function terrainDressing(dir) {
  const { gen, spawns, mod } = await loadTerrain(dir);
  const f = gen.field, problems = [];
  const fl = mod.floatingOf(f);
  if (fl.samples > 0) problems.push({ severity: 'error', rule: 'floating', message: `${fl.samples} samples of ground float free of the land (one near ${fl.at.map(v => v.toFixed(1)).join(', ')})`, fix: 'lower terrain.land.overhang or terrain.land.tunnels in config/world.json, or change terrain.seed' });
  spawns.forEach((s, n) => {
    if (f.sample(s.x, s.y + 1, s.z) < 0.3 || f.sample(s.x, s.y + 2, s.z) < 0.3) problems.push({ severity: 'error', rule: 'spawn-clear', message: `spawn ${n} at ${s.x}, ${s.y}, ${s.z} has ground in the air over it`, fix: 'let the world choose the spawns (config/world.json spawns: a number) or move this one' });
    const nrm = f.normal(s.x, s.y - 0.05, s.z);
    if (nrm[1] < 0.75) problems.push({ severity: 'warning', rule: 'spawn-slope', message: `spawn ${n} stands on a slope (its ground faces ${Math.round(Math.acos(Math.max(-1, Math.min(1, nrm[1]))) * 180 / Math.PI)}° off up)`, fix: 'move it to flatter ground' });
    spawns.forEach((o, m) => { if (m > n && Math.hypot(o.x - s.x, o.z - s.z) < 3) problems.push({ severity: 'error', rule: 'spawn-clear', message: `spawns ${n} and ${m} are ${Math.hypot(o.x - s.x, o.z - s.z).toFixed(1)} m apart`, fix: 'spread them at least 3 m apart' }); });
  });
  const errors = problems.filter(p => p.severity === 'error').length;
  return { errors, warnings: problems.length - errors, problems, stats: { openFloor: 1, spawns: spawns.length, floating: fl.samples } };
}

/**
 * A picture's seam: how far the sharpest line where its copies meet (its wrap: last row to first, last column to first)
 * stands out from the picture's usual line: the mean step across that line over the median line's. A picture that
 * tiles is about 1 to 2 there; edges that do not meet are several times sharper. A mark inside the picture (a band left
 * by swapping halves to make it tile) is not seen here: that is the look judge's, on the drawn ground.
 * → {ratio, at: 'row 511' | 'column 0' ...} (at 512 px)
 */
export async function seamOf(file) {
  const { sharp } = await import('./char-deps.mjs');
  const { data, info } = await sharp(file).removeAlpha().resize(512, 512, { fit: 'fill' }).raw().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height, px = (x, y) => (((y + H) % H) * W + ((x + W) % W)) * 3;
  const diff = (a, b) => Math.abs(data[a] - data[b]) + Math.abs(data[a + 1] - data[b + 1]) + Math.abs(data[a + 2] - data[b + 2]);
  const lines = [];
  for (let y = 0; y < H; y++) { let t = 0; for (let x = 0; x < W; x++) t += diff(px(x, y), px(x, y + 1)); lines.push({ v: t / W, at: `row ${y}` }); }
  for (let x = 0; x < W; x++) { let t = 0; for (let y = 0; y < H; y++) t += diff(px(x, y), px(x + 1, y)); lines.push({ v: t / H, at: `column ${x}` }); }
  const sorted = lines.map(l => l.v).sort((a, b) => a - b), median = sorted[Math.floor(sorted.length / 2)] || 1;
  // the wrap: the last line to the first (where copies of the picture meet), give or take a line
  const near = (k, n) => [n - 1, n - 2, 0].includes(k);
  const top = lines.filter(l => { const [kind, k] = l.at.split(' '); return near(Number(k), kind === 'row' ? H : W); }).reduce((a, l) => (l.v > a.v ? l : a));
  return { ratio: Math.round(top.v / median * 100) / 100, at: top.at };
}

export async function terrainWorld(dir) {
  const { game, cfg, gameCfg, gen, spawns, sea } = await loadTerrain(dir);
  const f = gen.field, problems = [], notes = [];
  const players = gameCfg.players?.max ?? 4;
  if (spawns.length < Math.min(players, 8)) problems.push({ severity: 'error', rule: 'spawns', message: `${spawns.length} standing places for ${players} players`, fix: 'more land (terrain.islands.count or radius, land.height), or fewer players' });
  for (const s of spawns) if (!(s.y > sea + 0.5)) problems.push({ severity: 'error', rule: 'spawns', message: `a spawn at ${s.x}, ${s.z} is not above the sea (${s.y})`, fix: 'let the world choose the spawns' });
  let land = 0, cols = 0;
  const b = f.bounds;
  for (let x = b.min[0] + 1; x < b.max[0]; x += 2) for (let z = b.min[2] + 1; z < b.max[2]; z += 2) { cols++; const y = f.heightAt(x, z); if (y != null && y > sea) land++; }
  const share = land / Math.max(1, cols);
  if (share < 0.08) problems.push({ severity: 'error', rule: 'land', message: `only ${Math.round(share * 100)}% of the box is land above the sea`, fix: 'raise terrain.land.height or add islands' });
  if (share > 0.97) problems.push({ severity: 'warning', rule: 'sea', message: 'the land fills the whole box: no sea round it', fix: 'fewer or smaller islands' });
  const edge = [[b.min[0] + 0.3, 0], [b.max[0] - 0.3, 0], [0, b.min[2] + 0.3], [0, b.max[2] - 0.3]].filter(([x, z]) => (f.heightAt(x, z) ?? -1) > sea).length;
  if (edge) problems.push({ severity: 'error', rule: 'sealed', message: `the land reaches the box's edge in ${edge} places (the ground would end in a wall)`, fix: 'smaller islands or a smaller cliffs.depth' });
  for (const layer of ['top', 'soil', 'cliff']) {
    const file = cfg.materials?.[layer]?.file;
    if (!file) { if (layer !== 'cliff') notes.push(`the ${layer} is drawn in its colour (no picture)`); continue; }
    const at = join(game, file);
    if (!existsSync(at)) { problems.push({ severity: 'error', rule: 'pictures', message: `the ${layer} picture ${file} is missing`, fix: 'node builder/tools/create.mjs <game>/spec.json <game> copies it from the library' }); continue; }
    try {
      const s = await seamOf(at);
      if (s.ratio > SEAM) problems.push({ severity: 'error', rule: 'seamless', message: `the ${layer} picture ${file} shows a seam where it repeats (${s.at} is ${s.ratio}× sharper than its usual line)`, fix: 'use a seamless picture (the kit\'s xk-terrain pack, or make it tile)' });
      else notes.push(`${layer} picture: sharpest line ${s.ratio}× its usual (${s.at})`);
    } catch (e) { notes.push(`the ${layer} picture could not be read for its seam: ${e.message}`); }
  }
  const errors = problems.filter(p => p.severity === 'error');
  const P = gen.params;
  const stats = { size: P.size, cell: P.cell, shape: P.shape, land: Math.round(share * 100) / 100, spawns: spawns.length, islands: gen.info.islands.length, genSeconds: Math.round(gen.info.seconds * 100) / 100 };
  const detail = errors.length
    ? `${errors.length} errors: ${errors.map(p => `${p.rule}: ${p.message} → ${p.fix}`).join(' | ')}`
    : `complete: smooth terrain (${P.shape}${P.shape === 'islands' ? `, ${stats.islands} islands` : ''}) ${P.size[0]} × ${P.size[2]} m, ${Math.round(share * 100)}% land above the sea, ${spawns.length} spawns; ${problems.length} notes`;
  return { ok: errors.length === 0, detail, report: { errors: errors.length, warnings: problems.length - errors.length, stats, problems }, notes: [...notes, ...problems.filter(p => p.severity !== 'error').map(p => `${p.rule}: ${p.message}`)] };
}

/** Is this game's world the terrain world? */
export async function isTerrain(dir) {
  try { return JSON.parse(await readFile(join(resolve(dir), 'config/world.json'), 'utf8')).template === 'terrain'; } catch { return false; }
}
