// A game open on the real graphics card for the look judge and the tuning loop: framed at a style target's cameras and
// the kit's sheet framings, restyled live, in stepped time (the world holds still between frames, so two renders of
// the same look are the same picture and a score moves only when the look does).
//
//   const g = await openGame(dir, { size: [1280, 720] });
//   const frames = await g.frames(framings, outDir);   // → [{ framing, file, info, bodies }]
//   await g.restyle({ fog: { far: 120 } });             // look values over the game's own (null: back to the game's)
//   const values = await g.values();
//   await g.close();
//
// The three runtime's standard-3d profile (window.__gfLook: view, restyle, values, bodies). Another runtime's game is
// judged from frames it rendered itself (judge.mjs { frames }), and says so.
import { mkdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { launchChrome } from '../qa/browser.mjs';
import { startParty } from '../multiplayer/party/lib.mjs';
import { kitEditsOverlay } from '../tools/lib/kit-check.mjs';
import { launchForGame } from '../tools/lib/paths.mjs';

/** The kit's sheet framings, beside a target's own cameras: the world wide, a character close, props and bodies at mid
 *  range (the action shot), the player's own view with the HUD. */
export const SHEET_FRAMINGS = [
  { name: 'wide', shot: 'wide' },
  { name: 'hero', shot: 'hero' },
  { name: 'props', shot: 'action' },
  { name: 'hud', shot: null, hud: true },
];

/** A target's cameras ({ name, pitch, distance, fov, yaw?, aim?, frame? }) and the sheet framings, as one list. The
 *  camera's place comes from pitch and distance alone (a target's `height` is what they make, not added to it). */
export function framingsOf(target, { sheet = true, settings = [] } = {}) {
  // gf-look-target/1: camera.framings (look-target's schema); a bare list is taken too. A framing's `where` (a setting:
  // a cave shot) asks the world for a place that shows it.
  const list = Array.isArray(target?.camera) ? target.camera : target?.camera?.framings ?? [];
  const cams = list.filter(c => c && typeof c === 'object' && typeof c.pitch === 'number')
    .map((c, i) => ({ name: c.name ?? `target-${i + 1}`, frame: c.frame ?? null, view: { pitch: c.pitch ?? c.angle ?? 20, distance: c.distance ?? 8, fov: c.fov ?? 50, yaw: c.yaw ?? 0, aim: c.aim ?? 0.5, ...(c.where ? { where: c.where } : {}) } }));
  // the settings the references show that a place in the world can show (a cave, the land in daylight), one framing
  // each unless a target camera already asks for it
  const placed = settings.filter(s => PLACED.includes(s) && !cams.some(c => c.view.where === s))
    .map(s => ({ name: `place-${s}`, frame: null, view: { where: s, pitch: 10, distance: 8, fov: 65 } }));
  return [...cams, ...placed, ...(sheet ? SHEET_FRAMINGS : [])];
}
/** The settings a world can be asked for a place that shows (settings.mjs SETTINGS; a close-up and a UI are the sheet's
 *  hero and HUD framings, the time of day is the look's). */
export const PLACED = ['day', 'cave'];

const runtimeOf = dir => { try { const s = JSON.parse(readFileSync(join(dir, 'spec.json'), 'utf8')); return { runtime: s.runtime ?? null, profile: s.profile ?? null }; } catch { return { runtime: null, profile: null }; } };

export async function openGame(dir, { size = [1280, 720], query = 'bots=3&seed=7&gf-autoplay=1&gf-ui=0&gf-step=1', settle = 4000, log = () => {} } = {}) {
  dir = resolve(dir);
  const place = runtimeOf(dir);
  if (!existsSync(join(dir, 'gf/three/look/capture-api.js')) || (place.runtime && place.runtime !== 'three') || (place.profile && place.profile !== 'standard-3d'))
    throw new Error(`the look judge renders three standard-3d games live (this one is ${place.runtime ?? '?'} ${place.profile ?? ''}); judge another runtime's own frames with judge.mjs --frames`);
  const overlay = (await kitEditsOverlay(dir)) ?? new Map();
  const srv = await startParty({ dir, port: 0, overlay });
  let browser, page;
  const errors = [];
  try {
    ({ browser } = await launchForGame(launchChrome, dir));
    page = await browser.newPage({ viewport: { width: size[0], height: size[1] }, deviceScaleFactor: 1 });
    page.on('pageerror', e => errors.push(String(e.message ?? e)));
    await page.goto(`${srv.url}?quality=high&${query}`, { waitUntil: 'load' });
    await page.waitForFunction(() => !!window.__gfLook && !!window.__game?.ready, null, { timeout: 90000 });
    const stepped = await page.evaluate(() => !!window.__game.stepped);
    // past the countdown, and a few seconds of play so the bots spread out
    if (stepped) {
      for (let i = 0; i < 40 && !(await page.evaluate(() => ['playing', 'show'].includes(window.__game.phase))); i++) await page.evaluate(() => window.__game.step(500, { draw: false }));
      await page.evaluate(ms => window.__game.step(ms), settle);
    } else await page.waitForFunction(() => ['playing', 'show'].includes(window.__game.phase), null, { timeout: 90000 });
    const info = await page.evaluate(() => window.__gfLook.info());
    if (/swiftshader|llvmpipe|software/i.test(info.gpu ?? '')) throw new Error(`rendering on a software GPU (${info.gpu}): a look is not judged from it`);
    log(`  look: ${dir} open on ${info.gpu}${stepped ? ', stepped time' : ''}`);
    const draw = () => page.evaluate(s => (s ? window.__game.step(17) : new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))), stepped);

    /** Each framing → a JPEG in outDir (name: <prefix><framing>.jpg). */
    async function frames(list, outDir, { prefix = '' } = {}) {
      await mkdir(outDir, { recursive: true });
      const out = [];
      let lastPlaced = false;
      for (const f of list) {
        const info = await page.evaluate(f => {
          const ui = document.getElementById('gf-ui');
          if (ui) ui.style.display = f.hud ? '' : 'none';
          return f.view ? window.__gfLook.view(f.view) : window.__gfLook.shot(f.shot ?? null);
        }, f);
        // a placed shot (a cave): the world's own light and fog ease to where the camera now is (the fog underground
        // follows the sky above the camera over a few dozen frames)
        // (and the shot after a placed one: the fog eases back to the sky above this camera)
        if (info?.placed || lastPlaced) await page.evaluate(s => (s ? window.__game.step(700, { draw: false }) : new Promise(r => setTimeout(r, 900))), stepped);
        lastPlaced = !!info?.placed;
        await draw(); await draw();
        const bodies = await page.evaluate(() => window.__gfLook.bodies?.() ?? []);
        const file = join(outDir, `${prefix}${f.name}.jpg`);
        await page.screenshot({ path: file, type: 'jpeg', quality: 90 });
        out.push({ framing: f.name, frame: f.frame ?? null, where: f.view?.where ?? null, placed: !!info?.placed, file, info, bodies });
      }
      await page.evaluate(() => { window.__gfLook.shot(null); const ui = document.getElementById('gf-ui'); if (ui) ui.style.display = 'none'; });
      return out;
    }
    const restyle = async values => { const v = await page.evaluate(v => window.__gfLook.restyle(v), values ?? null); await draw(); return v; };
    const values = () => page.evaluate(() => window.__gfLook.values());
    async function close() { await page?.close().catch(() => {}); await browser?.close().catch(() => {}); await srv.close().catch(() => {}); }
    return { frames, restyle, values, close, errors, info, stepped, page };
  } catch (e) {
    await page?.close().catch(() => {}); await browser?.close().catch(() => {}); await srv.close().catch(() => {});
    throw e;
  }
}
