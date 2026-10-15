// gf-three verify for a world (CONTRACT §9; worlds/PLAN.md §5): tools/verify.mjs hands a game whose
// config/game.json says round.mode "world" to verifyWorld. A world has no rounds, bots, scores or results, so the
// checks about those are replaced by a world's own; the rest run as they do for every game. The pass rule is
// REQUIRED_WORLD (tools/lib/verdict.mjs).
//
//   1  manifests (assets.json; multiplayer.json mode world)          2  kit copies unedited
//   3  boots to play and walks, no console errors                       4  slot coverage 100% (play and preview subjects)
//   5  the world gate (gf-multiplayer 1.5.0: two players in one world through the world card, each sees the other, an
//      edit on one shows on the other)                                  7  audio gate v4 (while building)
//   8  swap proof (the body, and a block texture seen in the world)     9  contact sheet and perf (counts when it ran)
//   11 the world lint (worlds-check.mjs lintWorld)                       13 the world controls (worlds-check.mjs)
//   14 looks honoured · 18 sounds play · 19 bodies hold their shape (as for every game)
//   20 the menu · 21 the HUD · 22 the wallet · 24 plays inside a post (as for every game)
//   25 playing with friends in a world (the world card: a name, Enter, no codes, no Start)
//   26 the world persists · 27 the host leaves and the world is kept · 28 the spawn square holds
//   29 sign words are filtered · 30 phones · 31 sharp on every screen
//   34 watch then play (gf-multiplayer 1.6.x, watch/PLAN.md: Go live, a viewer sees the streamer and their
//      blocks, can't send, joins in place; Stop ends it for viewers)
import { readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { REPO, GF3, KIT, launchForGame, importPart, relPosix } from './lib/paths.mjs';
import { libraryFile } from '../art/views.mjs';
import { checkKitCopies } from './lib/kit-check.mjs';
import { validateGame } from '../asset-manifest/validate.mjs';
import { readManifest, validateMultiplayer } from '../multiplayer/party/lib.mjs';
import { launchChrome, GPU_TROUBLE } from '../qa/browser.mjs';
import { installAudioTap, resetAudioTap, audioReport } from '../audio-gates/qa-gate-v4.mjs';
import { checkMenu, checkHud, checkWallet } from './lib/menu-check.mjs';
import { checkEmbed } from './lib/embed-check.mjs';
import { checkScreens } from './lib/screens-check.mjs';
import { checkWorldControls, checkWorldTouch, lintWorld, findBuildSpot, faces, actOn } from './lib/worlds-check.mjs';
import { checkWorldPersist, checkSpawnHolds, checkSignFilter } from './lib/worlds-net-check.mjs';
import { stampVerdict, runsHere, writeVerdict } from './lib/verdict.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms, what) { const t0 = Date.now(); for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`); await sleep(150); } }

export async function verifyWorld(dir, { rec, outDir, add, log, t0, lap, quick = false, only = null, release = false, statics }) {
  rec.mode = 'world';
  // a build's verify leaves out the kit's own checks (8, 31, 34: verdict.mjs RELEASE_ONLY); a release run makes them
  const want = n => (only === null ? runsHere(n, { release }) : [].concat(only).includes(n));
  const game = JSON.parse(await readFile(join(dir, 'config/game.json'), 'utf8'));
  const mpm = await readManifest(dir);

  // ---- static ----
  if (want(1)) {
    const v = await validateGame(dir);
    const mv = mpm.error ? { ok: false, problems: [`multiplayer.json is ${mpm.error}`] } : validateMultiplayer(mpm.manifest);
    const world = mpm.manifest?.mode === 'world';
    add(1, 'manifests', v.ok && mv.ok && world, [v.ok ? `assets.json valid (${v.stats?.slots ?? '?'} slots)` : `assets.json: ${v.errors.slice(0, 4).join('; ')}`, mv.ok ? `multiplayer.json valid, mode ${mpm.manifest?.mode}${world ? '' : ' (a world needs mode world)'}` : `multiplayer.json: ${mv.problems.join('; ')}`].join(' · '));
  }
  if (want(2)) { const kc = await checkKitCopies(dir); add(2, 'kit copies unedited', kc.ok, kc.ok ? 'gf/three (a kit release), gf/mp (a gf-multiplayer release), audio, gf/gf-assets.js and vendor/ match their sources' : kc.problems.slice(0, 6).join('; ')); rec.notes.push(...kc.notes); }
  if (want(11)) {
    const l = await lintWorld(dir, { kitDir: existsSync(join(dir, 'gf/three')) ? join(dir, 'gf/three') : KIT }).catch(e => ({ ok: false, errors: [e.message], notes: [] }));
    add(11, 'the world lint', l.ok, l.ok ? l.notes.join('; ') : l.errors.slice(0, 6).join('; '));
  }
  if (want(14)) await statics.looks();
  if (want(18)) await statics.check18();
  if (want(19)) await statics.check19();
  // 23, looks like its target (tools/lib/look-check.mjs): the world rendered live at the target's framings and a place
  // per setting the references show (a cave shot in a cave, the wide view from a rise); no target passes at once
  if (want(23)) { const t23 = Date.now(); await statics.look([]); lap?.('look', t23); }

  // ---- the world server (the play host's own protocol, here) and real Chrome ----
  const needsBrowser = [3, 4, 5, 7, 8, 13, 20, 21, 22, 24, 25, 26, 27, 28, 29, 30, 31, 34].some(want);
  if (needsBrowser) {
    const { startWorldServer } = await importPart(join(REPO, 'builder/world-server/serve.mjs'), 'the world server (worlds), which a persistent-world game is verified on');
    // the play origin's headers (connect-src 'self'), with this machine's stand-in host and post pages (checks 22, 24)
    // allowed to frame it as games.fun's /play page and X are in production
    const server = await startWorldServer({ dir, port: 0, memory: true, csp: true, frameAncestors: ['http://127.0.0.1:*', 'http://localhost:*'] });
    const launched = await launchForGame(launchChrome, dir, { args: (await import('./lib/friends-watch-check.mjs')).voiceArgs() });
    const browser = launched.browser;
    rec.chrome = browser.version(); rec.renderer = launched.gpu;
    const shot = async (page, name) => { const f = `${String(rec.shots.length + 1).padStart(2, '0')}-${name}.jpg`; rec.shots.push(f); await page.screenshot({ path: join(outDir, f), type: 'jpeg', quality: 75 }).catch(() => {}); return f; };
    const newPage = async (label, { overrides = null, audio = false } = {}) => {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
      const page = await ctx.newPage();
      const errors = [];
      page.on('pageerror', e => errors.push(`${label}: ${e.message}`));
      page.on('console', m => { if (m.type() === 'error' && !GPU_TROUBLE.test(m.text())) errors.push(`${label}: ${m.text().slice(0, 300)}`); });
      if (overrides) await page.addInitScript(o => { globalThis.__GF_ASSET_OVERRIDES = o; }, overrides);
      if (audio) await installAudioTap(page);
      return { ctx, page, errors };
    };
    const url = server.gameUrl;
    let t = Date.now();
    try {
      // ---- 3, 4, 7: one page that boots, walks, builds (sound) and is walked for coverage ----
      // a section that throws fails its own checks and the run goes on (one stuck page never hides the rest)
      const section = async (nums, fn) => { try { await fn(); } catch (e) { for (const [n, name] of nums) if (want(n) && !rec.checks.some(c => c.n === n)) add(n, name, false, `not reached: ${e.message}`); } };
      await section([[3, 'boots to play with no console errors'], [4, 'slot coverage 100%'], [7, 'audio gate v4']], async () => { if ([3, 4, 7].some(want)) {
        const S = await newPage('world', { audio: true });
        const p = S.page;
        await p.goto(`${url}?seed=7`, { waitUntil: 'load' });
        await until(() => p.evaluate(() => window.__game?.menu?.()?.view === 'home'), 90000, 'the home menu');
        await shot(p, 'menu');
        await p.click('#gf-play');
        await until(() => p.evaluate(() => window.__game.phase === 'playing'), 15000, 'play');
        await resetAudioTap(p);
        const start = await p.evaluate(() => window.__game.snapshot().players.find(x => x.local));
        await p.keyboard.down('KeyW'); await sleep(1400); await p.keyboard.up('KeyW'); await sleep(300);
        const end = await p.evaluate(() => window.__game.snapshot().players.find(x => x.local));
        const moved = Math.hypot(end.x - start.x, end.z - start.z);
        const spot = await findBuildSpot(p);
        if (spot) { const F = faces(spot); for (let i = 0; i < 3; i++) { await actOn(p, F.ground); await sleep(100); await actOn(p, F.top(), 'right'); await sleep(100); } }
        await shot(p, 'playing');
        const cov = [];
        for (let i = 0; i < 3; i++) { cov.push(await p.evaluate(() => window.__game.coverage())); await sleep(900); }
        const audio = await audioReport(p);
        if (want(3)) add(3, 'boots to play with no console errors', S.errors.length === 0 && moved > 0.5, `${S.errors.length ? `console errors: ${[...new Set(S.errors)].slice(0, 3).join(' | ')}` : 'no console errors'}; the player walked ${moved.toFixed(2)} m on real keys`);
        if (want(4)) {
          const assets = JSON.parse(await readFile(join(dir, 'assets.json'), 'utf8'));
          const subj = [];
          for (const q of (assets.showcase ?? []).map(x => x.query)) {
            const T = await newPage(`show ${q}`);
            await T.page.goto(url + q, { waitUntil: 'load' });
            await until(() => T.page.evaluate(() => window.__game?.ready === true), 60000, q).catch(() => {});
            await sleep(500);
            subj.push({ q, c: await T.page.evaluate(() => window.__game?.coverage?.() ?? null).catch(() => null), errors: T.errors });
            await T.ctx.close();
          }
          const all = [...cov, ...subj.map(x => x.c)];
          const untagged = all.flatMap(c => c?.untagged ?? [{ name: 'no coverage report' }]);
          add(4, 'slot coverage 100%', untagged.length === 0 && subj.every(x => !x.errors.length), `${cov.map(c => `${c.tagged}/${c.meshes}`).join(', ')} tagged in play; ${subj.map(x => `${x.q.replace('?gf-show=', '')} ${x.c ? `${x.c.tagged}/${x.c.meshes}` : 'no report'}`).join(', ')}${untagged.length ? `; untagged: ${untagged.slice(0, 4).map(u => u.path ?? u.name).join(', ')}` : ''}`);
        }
        if (want(7)) add(7, 'audio gate v4', !!(audio.ok && audio.heard), `${audio.heard ? 'heard' : 'nothing heard'}${audio.mix ? `, ${audio.mix.integratedLufs?.toFixed?.(1) ?? '?'} LUFS integrated, peak ${audio.mix.truePeakDb?.toFixed?.(1) ?? '?'} dBTP` : ''}; ${audio.problems.length ? audio.problems.join('; ') : 'within the targets'}`);
        await S.ctx.close();
        lap('world page', t); t = Date.now();
      } });
      // ---- 8. swap proof: the body (its preview subject) and a block texture, seen in the world ----
      await section([[8, 'swap proof']], async () => { if (want(8)) {
        const assets = JSON.parse(await readFile(join(dir, 'assets.json'), 'utf8'));
        const bodySlot = assets.slots.find(s => s.id === 'character.body.player');
        const cobble = assets.slots.find(s => s.id === 'world.voxel.texture.cobble') ?? assets.slots.find(s => s.id.startsWith('world.voxel.texture.'));
        const other = assets.slots.find(s => s.id.startsWith('world.voxel.texture.') && s.id !== cobble?.id && /brick|planks/.test(s.id));
        const view = async (overrides, q) => {
          const T = await newPage('swap', { overrides });
          await T.page.goto(`${url}${q}`, { waitUntil: 'load' });
          await until(() => T.page.evaluate(() => window.__game?.ready === true), 60000, 'boot').catch(() => {});
          if (!q.includes('gf-show')) { await T.page.click('#gf-play').catch(() => {}); await sleep(1500); } else await sleep(900);
          const img = await T.page.screenshot({ type: 'png' });
          const f = await shot(T.page, `swap-${q.includes('gf-show') ? 'body' : 'block'}-${overrides ? 'after' : 'before'}`);
          const errors = T.errors; await T.ctx.close(); return { img, f, errors };
        };
        const diff = (a, b) => { let n = 0; const len = Math.min(a.length, b.length); for (let i = 0; i < len; i += 97) if (a[i] !== b[i]) n++; return n / (len / 97); };
        const out = [];
        if (bodySlot) {
          const alt = ['ual-mannequin', 'quaternius-astronaut', 'bean-chunky', 'bean-classic'].map(n => libraryFile(n)).find(f => f && !sameFile(f, join(dir, bodySlot.source.file)));
          if (alt) {
            const data = `data:model/gltf-binary;base64,${(await readFile(alt)).toString('base64')}`;
            const [a, b] = [await view(null, '?gf-show=character.player'), await view({ files: { [bodySlot.source.file]: data } }, '?gf-show=character.player')];
            out.push({ slot: bodySlot.id, ok: diff(a.img, b.img) > 0.01 && !b.errors.length, d: diff(a.img, b.img) });
          } else out.push({ slot: bodySlot.id, ok: false, why: 'no other library body' });
        }
        if (cobble && other) {
          const data = `data:image/png;base64,${(await readFile(join(dir, other.source.file))).toString('base64')}`;
          const [a, b] = [await view(null, '?seed=7'), await view({ files: { [cobble.source.file]: data } }, '?seed=7')];
          out.push({ slot: cobble.id, ok: diff(a.img, b.img) > 0.01 && !b.errors.length, d: diff(a.img, b.img) });
        }
        rec.swaps = out;
        add(8, 'swap proof', out.length === 2 && out.every(s => s.ok), out.map(s => s.ok ? `${s.slot}: ${(s.d * 100).toFixed(1)}% of pixels changed` : `${s.slot}: ${s.why ?? `not seen (${(s.d * 100).toFixed(2)}%)`}`).join(' · '));
        lap('swaps', t); t = Date.now();
      } });
      if (want(13)) { const r = await checkWorldControls({ newPage, url, game, log, shot }); rec.controls = r.record; rec.notes.push(...r.warnings); add(13, 'the world controls', r.ok, r.detail); lap('controls', t); t = Date.now(); }
      if (want(20)) { const r = await checkMenu({ newPage, url, game, log, shot }); rec.menu = r.record; rec.notes.push(...r.warnings); add(20, 'the menu works', r.ok, r.detail); }
      if (want(21)) { const r = await checkHud({ newPage, url, game, log, shot }); rec.hud = r.record; rec.notes.push(...r.warnings); add(21, 'the HUD shows your state', r.ok, r.detail); }
      if (want(22)) { const r = await checkWallet({ newPage, url, log, shot, world: true }); rec.wallet = r.record; rec.notes.push(...r.warnings); add(22, 'the wallet in the menu', r.ok, r.detail); }
      if (want(24)) { const r = await checkEmbed({ newPage, url, game, log, shot }); rec.embed = r.record; rec.notes.push(...r.warnings); add(24, 'plays inside a post', r.ok, r.detail); }
      if (want(31)) { const r = await checkScreens({ browser, url, log }); rec.screens = r.record; rec.notes.push(...r.warnings); add(31, 'sharp on every screen', r.ok, r.detail); }
      lap('menu, HUD, wallet, post', t); t = Date.now();
      if (want(26)) { const r = await checkWorldPersist({ browser, server, log, shot }); rec.persist = r.record; add(26, 'the world persists', r.ok, r.detail); }
      if (want(28)) { const r = await checkSpawnHolds({ browser, server, log }); rec.spawn = r.record; add(28, 'the spawn square holds', r.ok, r.detail); }
      if (want(29)) { const r = await checkSignFilter({ browser, server, log }); rec.filter = r.record; add(29, 'sign words are filtered', r.ok, r.detail); }
      if (want(30)) { const r = await checkWorldTouch({ browser, url, log, shot }); rec.touch = r.record; add(30, 'phones', r.ok, r.detail); }
      lap('saves and phones', t); t = Date.now();
      if (want(34)) {
        const { checkWorldWatch } = await import('./lib/worlds-watch-check.mjs');
        const r = await checkWorldWatch({ browser, server, log, shot });
        // voice chat between the players and the host's Remove (gf-multiplayer 1.7.2), on a world server of its own whose
        // /watch/v1 names a stand-in Studio page (tools/lib/voice-chat-check.mjs)
        const { checkVoiceChat } = await import('./lib/voice-chat-check.mjs');
        const vcr = await checkVoiceChat({ dir, world: true, log: line => log(`  ${line}`),
          startServer: studio => startWorldServer({ dir, port: 0, memory: true, csp: true, frameAncestors: ['http://127.0.0.1:*', 'http://localhost:*'], studio }) });
        if (r.record?.steps) for (const x of vcr.steps) r.record.steps.push({ name: `voice chat: ${x.name}`, ok: x.ok, detail: x.detail });
        const vcBad = vcr.steps.filter(x => !x.ok);
        rec.watch = r.record; add(34, 'watch then play', r.ok && !vcBad.length, vcBad.length ? `${r.ok ? '' : r.detail + ' · '}voice chat: ${vcBad.map(x => `${x.name}: ${x.detail}`).slice(0, 2).join(' · ')}` : r.detail);
        lap('watch then play', t); t = Date.now();
      }
      // ---- 5, 25, 27: the room (gf-multiplayer 1.5.0 world mode) ----
      if ([5, 25, 27].some(want)) {
        const room = await import('./lib/worlds-room-check.mjs').catch(e => ({ error: e }));
        if (room.error) for (const [n, name] of [[5, 'the world gate'], [25, 'playing with friends in a world'], [27, 'the host leaves and the world is kept']]) { if (want(n)) add(n, name, false, `not built yet: ${room.error.message.split('\n')[0]}`); }
        else {
          const r = await room.checkWorldRoom({ browser, server, log, shot });
          rec.room = r.record;
          if (want(5)) add(5, 'the world gate', r.gate.ok, r.gate.detail);
          if (want(25)) add(25, 'playing with friends in a world', r.friends.ok, r.friends.detail);
          if (want(27)) add(27, 'the host leaves and the world is kept', r.handoff.ok, r.handoff.detail);
        }
        lap('the room', t); t = Date.now();
      }
    } finally {
      await browser.close().catch(() => {});
      await server.close().catch(() => {});
    }
  }
  if (want(9)) add(9, 'contact sheet and perf', null, quick ? '--quick' : 'not run for a world yet');
  const checks = rec.checks;
  // the verdict by gate (tools/lib/verdict.mjs stampVerdict: the pass rule, each measure's gate, rec.gates)
  stampVerdict(rec, { kind: 'world', release, list: only });
  rec.finished = new Date().toISOString(); rec.seconds = Math.round((Date.now() - t0) / 1000);
  rec.outDir = relPosix(dir, outDir);   // relative to the game, forward slashes
  await writeVerdict(outDir, rec);
  log(`${rec.pass ? 'PASS' : 'FAIL'} world verify: ${checks.filter(c => c.ok).length}/${checks.length} checks in ${rec.seconds} s → ${rec.outDir}`);
  return rec;
}

const sameFile = (a, b) => { try { return readFileSync(a).equals(readFileSync(b)); } catch { return false; } };
