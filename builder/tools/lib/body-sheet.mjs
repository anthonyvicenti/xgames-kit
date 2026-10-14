// The model judge's picture tier: one contact sheet per body (real GPU, the character bench), so a person or a vision
// model sees each part in each pose. Rows are poses: the model at rest (its bind pose), idle, walk, run, aim, interact,
// a wave, and the moment each part measured worst (body-judge.mjs). Columns are views: the whole body from the front
// and three-quarter, the face, each hand and the feet.
//
//   const { file, rows } = await renderSheet('<body.glb>', '<out.jpg>', { judged });   // judged: a judgeBody() result
//
// The bench plays the clips through the dev kit (runtimes/three/kit), with the body's own materials (no house look),
// on its own server on a free port.
import { readFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome } from '../../qa/browser.mjs';
import { GF3, importPart } from './paths.mjs';
import { sharp } from './char-deps.mjs';
import { PARTS, PART_LABEL } from './body-judge.mjs';
import { refFile } from '../../art/views.mjs';

const here = dirname(fileURLToPath(import.meta.url));
/** The body the clips were made on: the reference a pose is meant to look like. */
export const REFERENCE_BODY = refFile('quaternius-ual-bodies/ual-mannequin');
export const VIEWS = ['front', 'three-quarter', 'face', 'left hand', 'right hand', 'feet'];
const BASE_POSES = [['rest', null], ['idle', 0.4], ['walk', 0.25], ['run', 0.3], ['aim', 0.5], ['interact', 0.5], ['emote_wave', 0.45]];
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** The poses a sheet shows: the base set, then each part's worst moment (failing parts first) that is not already there. */
export function sheetPoses(judged, { max = 10 } = {}) {
  const rows = BASE_POSES.map(([clip, at]) => ({ clip, at, why: clip === 'rest' ? 'the model at rest (bind pose)' : '' }));
  if (judged) {
    const worst = PARTS.map(p => ({ p, w: judged.parts[p].worst })).filter(x => x.w?.clip).sort((a, b) => (a.w.ok === false ? 0 : 1) - (b.w.ok === false ? 0 : 1));
    for (const { p, w } of worst) {
      if (rows.length >= max) break;
      const same = rows.find(r => r.clip === w.clip && r.t === w.t);
      if (same) { same.why += `${same.why ? '; ' : ''}worst ${PART_LABEL[p]}`; continue; }
      rows.push({ clip: w.clip, t: w.t, why: `worst ${PART_LABEL[p]}${w.ok === false ? ' (fails)' : ''}: ${w.detail}` });
    }
  }
  return rows;
}

/** rows: the poses (sheetPoses), or derived from `judged`. A reference sheet passes the body sheet's rows again. */
/** labels: 'full' (each row's why, for people) or 'plain' (the pose only: a vision model must judge the pictures, not
 *  repeat the measuring tier's numbers back). */
export async function renderSheet(file, out, { judged = null, rows: given_rows = null, tile = 220, browser: given = null, title = '', labels = 'full' } = {}) {
  mkdirSync(dirname(out), { recursive: true });
  // its own bench server on a free port: this checkout's dev kit, whatever else is running
  const { serve } = await importPart(join(GF3, 'character-bench/serve.mjs'), 'the character bench (runtimes/three/character-bench), which draws a body\'s pose sheet');
  const server = await serve(0), port = server.address().port;
  const browser = given ?? await launchChrome({ gpu: 'webgl' });
  const b64 = readFileSync(file).toString('base64');
  const rows = given_rows ?? sheetPoses(judged);
  const tiles = [];
  const LABEL = 150;
  try {
    for (const [r, row] of rows.entries()) {
      const page = await browser.newPage({ viewport: { width: 480, height: 480 } });
      await page.addInitScript(d => { window.__GF_ASSET_OVERRIDES = { files: { 'assets/models/body-player.glb': d }, patches: [] }; }, `data:model/gltf-binary;base64,${b64}`);
      await page.goto(`http://127.0.0.1:${port}/character-bench/?notint`);
      await page.waitForFunction(() => window.__bench?.ready || window.__bench?.errors?.length, null, { timeout: 90000 });
      const at = await page.evaluate(async ({ clip, at, t }) => {
        const B = window.__bench; document.getElementById('ui').style.display = 'none'; B.freeze(true); B.hidePlates();
        const c = B.chars[0];
        if (clip === 'rest') {
          const rig = await import('/kit/character/rig.js');
          c.stop('upper'); c.stop('base'); rig.poseToBind(c.model, rig.findRig(c.model)); c.model.updateMatrixWorld(true);
        } else {
          c.play(clip, { loop: true, fade: 0, hold: true });
          B.advance((t ?? (c.meta?.[clip]?.duration ?? 1) * at) + 1e-3);
        }
        const V = B.ctx.THREE.Vector3, p = n => c.bones.get(n).getWorldPosition(new V()).toArray();
        return { h: c.height, head: p('Head'), L: p('LeftHand'), R: p('RightHand'), fl: p('LeftFoot'), fr: p('RightFoot'), hips: p('Hips') };
      }, row);
      const h = at.h, mid = (a, b) => a.map((v, i) => (v + b[i]) / 2);
      const views = [
        { yaw: 0, pitch: 0.12, dist: 0.5 + 1.7 * h, target: [at.hips[0], h * 0.5, at.hips[2]] },
        { yaw: 0.8, pitch: 0.12, dist: 0.5 + 1.7 * h, target: [at.hips[0], h * 0.5, at.hips[2]] },
        { yaw: 0.15, pitch: 0.05, dist: 0.35 * h, target: [at.head[0], at.head[1] + 0.06 * h, at.head[2]] },
        { yaw: 1.2, pitch: 0.35, dist: 0.28 * h, target: at.L },
        { yaw: -1.2, pitch: 0.35, dist: 0.28 * h, target: at.R },
        // the feet: below the ankles and a little ahead of them, where the shoes are
        { yaw: 0.5, pitch: 0.4, dist: 0.55 * h, target: [mid(at.fl, at.fr)[0], Math.max(0.03, 0.4 * Math.min(at.fl[1], at.fr[1])), mid(at.fl, at.fr)[2] + 0.04 * h] },
      ];
      for (const [ci, v] of views.entries()) {
        await page.evaluate(o => window.__bench.setOrbit(o), v);
        await page.waitForTimeout(100);
        tiles.push({ input: await sharp(await page.screenshot()).resize(tile, tile).toBuffer(), left: LABEL + ci * tile, top: 28 + r * tile });
      }
      await page.close();
    }
  } finally {
    if (!given) await browser.close();
    server.close();
  }
  const W = LABEL + VIEWS.length * tile, H = 28 + rows.length * tile;
  const head = (title ? `<text x="8" y="19" font-size="13" font-weight="bold" font-family="sans-serif" fill="#a33">${esc(title)}</text>` : '') +
    VIEWS.map((v, i) => `<text x="${LABEL + i * tile + tile / 2}" y="19" font-size="15" text-anchor="middle" font-family="sans-serif" fill="#222">${esc(v)}</text>`).join('');
  const side = rows.map((row, r) => {
    const words = `${row.clip}${row.clip === 'rest' ? '' : ` @ ${row.t ?? `${Math.round(row.at * 100)}%`}${row.t != null ? ' s' : ''}`}`;
    const why = labels === 'plain' ? (row.clip === 'rest' ? ['its own design'] : []) : (row.why || '').slice(0, 120).match(/.{1,22}(\s|$)/g) ?? [];
    return `<text x="8" y="${28 + r * tile + 22}" font-size="15" font-weight="bold" font-family="sans-serif" fill="#111">${esc(words)}</text>` +
      why.slice(0, 7).map((l, i) => `<text x="8" y="${28 + r * tile + 44 + i * 16}" font-size="12" font-family="sans-serif" fill="#444">${esc(l.trim())}</text>`).join('');
  }).join('');
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${head}${side}</svg>`);
  await sharp({ create: { width: W, height: H, channels: 3, background: '#ffffff' } }).composite([...tiles, { input: svg, left: 0, top: 0 }]).jpeg({ quality: 82 }).toFile(out);
  return { file: out, rows, views: VIEWS };
}

/** The look's sheet: the character's tiles with the mannequin's same tile beside each hand and the whole body, one
 *  image, so a vision model compares each pair directly (two separate sheets let it pass a claw as "the design" and
 *  fail a fist as "a claw"). charSheet and refSheet are renderSheet() outputs with the same rows and tile size. */
export const PAIRED = [['front', 0, false], ['front', 0, true], ['face', 2, false], ['left hand', 3, false], ['left hand', 3, true], ['right hand', 4, false], ['right hand', 4, true], ['feet', 5, false]];
export async function pairSheet(charSheet, refSheet, out, rows, { tile = 220 } = {}) {
  const LABEL = 150, TOP = 28, W = LABEL + PAIRED.length * tile, H = TOP + 18 + rows.length * tile;
  const crop = (f, r, c) => sharp(f).extract({ left: LABEL + c * tile, top: TOP + r * tile, width: tile, height: tile }).toBuffer();
  const tiles = [];
  for (const [r] of rows.entries()) for (const [i, [, c, ref]] of PAIRED.entries()) tiles.push({ input: await crop(ref ? refSheet : charSheet, r, c), left: LABEL + i * tile, top: TOP + 18 + r * tile });
  const head = PAIRED.map(([v, , ref], i) => `<text x="${LABEL + i * tile + tile / 2}" y="${ref ? 19 : 19}" font-size="15" text-anchor="middle" font-family="sans-serif" font-weight="${ref ? 'normal' : 'bold'}" fill="${ref ? '#b33' : '#222'}">${esc(ref ? `${v}: MANNEQUIN` : `${v}: character`)}</text>`).join('') +
    PAIRED.map(([, , ref], i) => (ref ? `<rect x="${LABEL + i * tile}" y="${TOP + 14}" width="${tile}" height="4" fill="#b33"/>` : '')).join('');
  const side = rows.map((row, r) => `<text x="8" y="${TOP + 18 + r * tile + 22}" font-size="15" font-weight="bold" font-family="sans-serif" fill="#111">${esc(row.clip === 'rest' ? 'rest' : `${row.clip} @ ${row.t ?? `${Math.round(row.at * 100)}%`}${row.t != null ? ' s' : ''}`)}</text>` +
    (row.clip === 'rest' ? `<text x="8" y="${TOP + 18 + r * tile + 42}" font-size="12" font-family="sans-serif" fill="#444">the character's design</text>` : '')).join('');
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${head}${side}</svg>`);
  await sharp({ create: { width: W, height: H, channels: 3, background: '#ffffff' } }).composite([...tiles, { input: svg, left: 0, top: 0 }]).jpeg({ quality: 84 }).toFile(out);
  return out;
}
