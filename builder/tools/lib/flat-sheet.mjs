// Check 9's contact sheet for a flat (2D) game: its part says the shots are straight on (manifest.reads(plane).shots:
// an orthographic frame per subject through gf/three/flat/look.js frameSubject), so the sheet is the slot preview
// (?gf-show=<subject>, which calls frameSubject) of every subject the game lists in assets.json → showcase, at the
// sizes capture.mjs uses, plus the game in play, with its frame times measured as capture.mjs reports them (reported,
// not judged). A turntable's four perspective cameras (kit/look/shots.js) would see a picture edge-on.
//
//   const r = await flatSheet({ dir, outDir, flat, launch });   // { ok, detail, record }
// Files are named as capture.mjs names its own (raw/<preset>--<world>--day--<shot>--<w>x<h>.jpg): the world frame is
// "wide" and the player's "hero", so check 23 finds them where it looks for the 3D sheet's wide and hero shots.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const SIZES = [[1920, 1080], [390, 844]];
const shotName = q => (q === 'world' ? 'wide' : /^character\./.test(q) ? (q === 'character.player' ? 'hero' : `hero-${q.slice(10)}`) : q.replace(/[^a-z0-9-]+/gi, '-'));

export async function flatSheet({ dir, outDir, flat, startParty, launch, log = () => {} }) {
  const sheet = join(outDir, 'sheet'), raw = join(sheet, 'raw');
  await mkdir(raw, { recursive: true });
  const assets = JSON.parse(await readFile(join(dir, 'assets.json'), 'utf8'));
  const subjects = (assets.showcase ?? []).map(s => /gf-show=([^&]+)/.exec(s.query ?? '')?.[1]).filter(Boolean).filter(s => s !== 'look');
  const record = { tool: 'builder/tools/lib/flat-sheet.mjs', plane: flat.plane, shots: flat.reads.shots, files: [], perf: null, problems: [] };
  const srv = await startParty({ dir, port: 0 });
  const { browser } = await launch();
  try {
    for (const [w, h] of SIZES) for (const q of subjects) {
      const ctx = await browser.newContext({ viewport: { width: w, height: h } }), page = await ctx.newPage(), errors = [];
      page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
      try {
        await page.goto(`${srv.url}?gf-show=${q}`, { waitUntil: 'load' });
        await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 60000 });
        await page.waitForTimeout(900);
        const file = join('raw', `game--game--day--${shotName(q)}--${w}x${h}.jpg`);
        await page.screenshot({ path: join(sheet, file), type: 'jpeg', quality: 88 });
        const cov = await page.evaluate(() => window.__game.coverage?.() ?? null);
        record.files.push({ subject: q, size: `${w}x${h}`, file, tagged: cov?.tagged, meshes: cov?.meshes });
        if (cov && cov.untagged?.length) record.problems.push(`${q} at ${w}x${h}: untagged ${cov.untagged.slice(0, 3).map(u => u.path ?? u.name).join(', ')}`);
      } catch (e) { record.problems.push(`${q} at ${w}x${h}: ${e.message.split('\n')[0]}`); }
      if (errors.length) record.problems.push(`${q} at ${w}x${h}: console errors ${errors.slice(0, 2).join(' | ')}`);
      await ctx.close();
    }
    // the game in play: a frame and its frame times (reported as capture.mjs reports perf, not judged)
    const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } }), page = await ctx.newPage();
    try {
      await page.goto(`${srv.url}?bots=3&seed=7&gf-autoplay=1&gf-ui=0`, { waitUntil: 'load' });
      await page.waitForFunction(() => window.__game?.phase === 'playing', null, { timeout: 60000 });
      await page.waitForTimeout(2500);
      const file = join('raw', 'game--game--day--action--1920x1080.jpg');
      await page.screenshot({ path: join(sheet, file), type: 'jpeg', quality: 88 }); record.files.push({ subject: 'play', size: '1920x1080', file });
      record.perf = await page.evaluate(() => new Promise(done => { const gaps = []; let last = null; const t0 = performance.now(); const tick = now => { if (last !== null) gaps.push(now - last); last = now; if (now - t0 < 3000) requestAnimationFrame(tick); else { const s = [...gaps].sort((a, b) => a - b), mean = gaps.reduce((a, b) => a + b, 0) / Math.max(1, gaps.length); done({ fps: +(1000 / mean).toFixed(1), frames: gaps.length, p95: +(s[Math.floor(s.length * 0.95)] ?? 0).toFixed(2) }); } }; requestAnimationFrame(tick); }));
    } catch (e) { record.problems.push(`play: ${e.message.split('\n')[0]}`); }
    await ctx.close();
  } finally { await browser.close().catch(() => {}); await srv.close().catch(() => {}); }
  await writeFile(join(sheet, 'record.json'), JSON.stringify(record, null, 1) + '\n');
  const ok = record.problems.length === 0 && record.files.length === subjects.length * SIZES.length + 1;
  log(`flat sheet: ${record.files.length} frames, ${record.problems.length} problems`);
  return { ok, record, detail: ok ? `a straight-on sheet (the flat part's shots): ${subjects.length} subjects (${subjects.join(', ')}) at ${SIZES.map(s => s.join('x')).join(' and ')}, and play; ${record.perf ? `${record.perf.fps} fps, p95 ${record.perf.p95} ms (reported)` : 'no frame times'}` : record.problems.slice(0, 4).join('; ') || `${record.files.length} of ${subjects.length * SIZES.length + 1} frames` };
}
