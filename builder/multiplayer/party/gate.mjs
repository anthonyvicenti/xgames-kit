#!/usr/bin/env node
// The multiplayer gate: does this game really play with friends, as its multiplayer.json says?
//
//   node builder/multiplayer/party/gate.mjs <game-dir> [--out <evidence-root>] [--seconds 75] [--draft <multiplayer.json>]
//        [--dev-kit] [--no-record] [--port N] [--signal http|ws] [--legs lobby] [--json]
//   --legs lobby (a live game): stop once both players are in the room over WebRTC; no round is played
//
// Every game: multiplayer.json is valid. A solo game passes on a real reason. A game written as a room is checked for
// its files here and plays its own two-browser QA (multiplayer/p2p/qa.mjs is the pattern).
// A race game then plays for real: ONE Chrome, a separate context for the host and for a joiner, real WebRTC data
// channels over this machine's signaling, real mouse and keyboard input through the party shell:
//   solo untouched · host opens a room · the joiner joins by invite link · both get the same seed · the adapter reads
//   both games · the value moves while playing · an end is detected · both see the same results · play again deals
//   a new seed · a reload takes the same seat back · the host ends a round · the host leaving closes the room.
//
// Verdicts (record.verdict, and the exit code):
//   pass (0)           every check passed
//   end-unproven (3)   everything passed, but no run reached an end in the time given: the "ended" condition (or the
//                      game's end hook) was never seen firing. Raise --seconds, or give multiplayer.json
//                      check.steps (play-driver steps that finish a run).
//   fail (1)           anything else
//
// A game that random input can't score in may ship <trial>/mp-driver.mjs beside its game folder:
//   export async function play(page, { index, seed, deadline, frame, done }) { ... }
// `page` takes real input (page.mouse, page.keyboard) in the game's own coordinates and evaluates in the game's frame
// (page.evaluate(() => window.__game.snapshot())); `index` is 0 for the host and 1 for the joiner (play a little
// differently, as two people would); return when the run is over or `await done()` is true. It may read the game's
// observation; it must never change game state.
//
// --draft tries a manifest that is not in the game yet, with the kit served from its development sources: nothing is
// written into the game. Evidence goes to <evidence-root>/mp-gate-N/ (default: the trial's evidence/ beside the game
// folder); --no-record writes nothing.
//
// The kit copy may be ANY released gf-multiplayer version, byte for byte (legacy games stay on theirs); the record says
// which. Signaling: the kit on 127.0.0.1 uses the WebSocket at /signal by default; --signal http plays the whole gate
// over HTTP signaling (/signal/v1, the transport of Studio's play origin) and checks both players really used it
// (--signal ws forces the WebSocket). Both need a kit with HTTP signaling (1.3.0+).
import { isMain } from '../../tools/lib/main.mjs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LOCAL_WEBRTC_OFF, launchChrome, manifestGpu } from '../../qa/browser.mjs';
import { fuzz, reachPlay, runSteps } from '../../asset-manifest/play-driver.mjs';
import { KIT_DIR, KIT_VERSION, MANIFEST, WORLD_SINCE, checkKitReleased, compareVersions, kitFiles, kitHasSignal, readManifest, repo, sha256, startParty, validateMultiplayer } from './lib.mjs';

import { checkTransport, graphicsOf, inFrame, p2p, sleep, snap, until, webrtcProbe } from './gate-lib.mjs';
import { gateLive } from './gate-live.mjs';

export async function gate(gameDir, { out = null, seconds = 75, draft = null, devKit = false, record = true, port = 0, signal = null, legs = null, log = console.log } = {}) {
  const dir = resolve(gameDir);
  const checks = [], notes = [];
  const t0 = Date.now(), timeline = [];   // [check, seconds since the gate began]: where a slow run spent its time
  const check = (name, ok, detail = '', { soft = false } = {}) => { timeline.push([name, Math.round((Date.now() - t0) / 100) / 10]); checks.push({ name, ok: !!ok, ...(soft ? { soft: true } : {}), detail: String(detail ?? '').slice(0, 900) }); log(`${ok ? 'PASS' : soft ? 'SOFT' : 'FAIL'} ${name}${detail ? ` — ${String(detail).slice(0, 220)}` : ''}`); return !!ok; };
  if (signal !== null && signal !== 'http' && signal !== 'ws') throw new Error(`--signal must be http or ws (got ${JSON.stringify(signal)})`);
  // legs "lobby" (a live game): stop once both players are in the room over WebRTC. For a machine that cannot draw a
  // round (a CI runner with no graphics card); the record says so and verify never counts it as the whole gate.
  if (legs !== null && legs !== 'lobby') throw new Error(`--legs must be lobby (got ${JSON.stringify(legs)})`);
  const rec = { schemaVersion: 1, kind: 'mp-gate', game: relative(repo, dir), started: new Date().toISOString(), kit: { name: 'gf-multiplayer', version: KIT_VERSION, source: draft || devKit ? 'development sources (served over the game, nothing written)' : `${KIT_DIR}/ in the game` },
    signal: signal ?? 'default (the WebSocket on 127.0.0.1)', draft: !!draft, seconds, mode: null, verdict: 'fail', checks, timeline, notes, players: {}, shots: [] };
  const finish = async () => {
    const hard = checks.filter(c => !c.soft);
    // A soft check that failed: for a race, no run reached an end; for a live game, only one of the two players had the other on screen.
    rec.verdict = hard.every(c => c.ok) ? (checks.every(c => c.ok) ? 'pass' : rec.mode === 'live' ? 'unproven' : 'end-unproven') : 'fail';
    rec.passed = checks.filter(c => c.ok).length; rec.total = checks.length; rec.finished = new Date().toISOString();
    if (rec.outDir) await writeFile(join(rec.outDir, 'record.json'), JSON.stringify(rec, null, 2) + '\n');
    return rec;
  };

  // ---- A. the manifest ----
  let manifest, manifestText = null;
  if (draft) { manifestText = await readFile(resolve(draft), 'utf8'); manifest = JSON.parse(manifestText); }
  else {
    const r = await readManifest(dir);
    if (r.error) { check('manifest-present', false, `${MANIFEST} is ${r.error}`); return finish(); }
    manifest = r.manifest; manifestText = await readFile(r.path, 'utf8');
  }
  rec.manifestSha256 = sha256(Buffer.from(manifestText));
  const v = validateMultiplayer(manifest);
  rec.mode = manifest?.mode ?? null;
  for (const w of v.warnings) notes.push(`manifest warning: ${w}`);
  if (!check('manifest-valid', v.ok, v.ok ? `mode ${manifest.mode}` : v.problems.join('; '))) return finish();

  if (manifest.mode === 'solo') { check('solo-has-a-reason', true, manifest.reason); return finish(); }
  if (manifest.mode === 'room') {
    for (const k of ['module', 'bot']) check(`room-${k}-exists`, existsSync(join(dir, manifest.room[k])), manifest.room[k]);
    check('room-entry-exists', existsSync(join(dir, manifest.room.entry.split(/[?#]/)[0])), manifest.room.entry);
    notes.push('A room game plays its own two-browser QA (its qa.mjs); this gate checks the manifest and files only.');
    return finish();
  }

  // A world (kit 1.5.0) has no rounds to race or play through here: this gate checks its kit copy and entry, and the
  // two-browser checks are the world's own (gate-world.mjs for the fixture contract; gf-three verify for a gf-three world).
  if (manifest.mode === 'world') {
    if (!draft && !devKit) {
      const k = await checkKitReleased(dir);
      rec.kit.version = k.version;
      check('kit-identical', k.ok && compareVersions(k.version, WORLD_SINCE) >= 0, k.ok ? `${KIT_DIR}/ is kit ${k.version}${compareVersions(k.version, WORLD_SINCE) >= 0 ? '' : ` (a world needs ${WORLD_SINCE} or later)`}`
        : `not any released kit; against ${k.version}: ${[...k.missing.map(f => `missing ${f}`), ...k.changed.map(f => `changed ${f}`), ...k.extra.map(f => `extra ${f}`)].slice(0, 8).join('; ')}`);
    }
    check('entry-exists', existsSync(join(dir, (manifest.world.entry ?? 'index.html').split(/[?#]/)[0])), manifest.world.entry ?? 'index.html');
    notes.push('A world plays in gate-world.mjs (one room by key, handoffs, full, reload; HTTP and WebSocket) or gf-three verify; this gate checks its manifest, kit copy and entry only.');
    return finish();
  }
  const race = manifest.mode === 'live' ? manifest.live : manifest.race;
  if (!draft && !devKit) {
    const k = await checkKitReleased(dir);
    rec.kit.version = k.version;
    check('kit-identical', k.ok, k.ok ? `${KIT_DIR}/ is kit ${k.version}${k.latest ? '' : ` (a released version; the current kit is ${KIT_VERSION})`}`
      : `not any released kit; against ${k.version}: ${[...k.missing.map(f => `missing ${f}`), ...k.changed.map(f => `changed ${f}`), ...k.extra.map(f => `extra ${f}`)].slice(0, 8).join('; ')}`);
    if (!k.ok) return finish();
    if (signal && !check('signal-transport-supported', kitHasSignal(k.version), `kit ${k.version} ${kitHasSignal(k.version) ? 'knows' : 'predates'} ?signal=${signal} (HTTP signaling is kit 1.3.0+; re-adopt the game to use it)`)) return finish();
  }
  const entry = (race.entry ?? 'index.html').split(/[?#]/)[0];
  if (!check('entry-exists', existsSync(join(dir, entry)), entry)) return finish();

  if (record) {
    const root = resolve(out ?? join(dirname(dir), 'evidence'));
    await mkdir(root, { recursive: true });
    const taken = new Set(await readdir(root).catch(() => []));
    let n = 1; while (taken.has(`mp-gate-${n}`)) n++;
    rec.outDir = join(root, `mp-gate-${n}`); rec.run = `mp-gate-${n}`;
    await mkdir(rec.outDir);
  }
  // JPEG, not PNG: a gate run per game for a hundred games is a lot of pictures to keep in the repo.
  const shot = async (page, name) => { if (!rec.outDir) return; const f = `${String(rec.shots.length + 1).padStart(2, '0')}-${name}.jpg`; await page.screenshot({ path: join(rec.outDir, f), type: 'jpeg', quality: 72 }).catch(() => {}); rec.shots.push(f); };

  // ---- the server and the browser ----
  let overlay = null;
  if (draft || devKit) {
    overlay = new Map();
    for (const [rel, buf] of await kitFiles({ version: 'dev' })) overlay.set(`${KIT_DIR}/${rel}`, buf);
    if (draft) overlay.set(MANIFEST, Buffer.from(manifestText));
  }
  let assets = {};
  try { assets = JSON.parse(await readFile(join(dir, 'assets.json'), 'utf8')); } catch {}
  const isolated = assets?.runtime?.crossOriginIsolated === true;
  const srv = await startParty({ dir, port, overlay, isolated });
  // GF_VERIFY_SOFTWARE=1 (verify's software mode, a CI profile): Chrome's software renderer here too. Until 2026-10-11
  // the gate ignored it and asked for the graphics card, so a "software" run on a machine with a card proved nothing
  // about a machine without one (gamesfun-kit's first CI run: the lobby legs passed here and failed on every runner).
  const software = !!process.env.GF_VERIFY_SOFTWARE;
  // two players on one machine: real addresses in the WebRTC candidates (builder/qa/browser.mjs LOCAL_WEBRTC_OFF)
  const launch = (disableFeatures = LOCAL_WEBRTC_OFF) => launchChrome({ ...(software ? {} : { gpu: manifestGpu(assets) ?? 'webgl' }), disableFeatures });
  const browser = await launch();
  // after a join that failed: does WebRTC work on this machine at all, as the gate's Chrome runs and as Chrome ships?
  const diagnose = async () => {
    const out = { 'as the gate ran': await webrtcProbe(browser) };
    const plain = await launch([]).catch(() => null);
    if (plain) { out['with Chrome\'s own settings (addresses behind mDNS names)'] = await webrtcProbe(plain); await plain.close().catch(() => {}); }
    return out;
  };
  rec.chrome = browser.version(); rec.renderer = software ? 'software' : manifestGpu(assets) ?? 'webgl';
  rec.graphics = await graphicsOf(browser);
  const errors = [];
  async function player(label) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push({ who: label, kit: /\/gf\/mp\//.test(e.stack ?? ''), text: e.message.slice(0, 300) }));
    page.on('console', m => { if (m.type() === 'error') errors.push({ who: label, kit: /\/gf\/mp\//.test(m.location()?.url ?? ''), text: m.text().slice(0, 300) }); });
    return { ctx, page, label, trace: { live: [], maxProgress: 0 } };
  }

  try {
    // ---- B. the game on its own is untouched ----
    {
      const S = await player('solo');
      const before = srv.requests.length;
      await S.page.goto(srv.url + entry, { waitUntil: 'load' });
      await sleep(2500);
      // A live game imports gf/mp/net.js itself (it does nothing alone), and gf/mp/presence.js (pure: the shape and the
      // state a friend's presence keeps; it opens nothing); nothing else of the kit may load.
      const LIVE_IMPORTS = [`${KIT_DIR}/net.js`, `${KIT_DIR}/presence.js`];
      const kitReq = srv.requests.slice(before).filter(r => (r.startsWith(`${KIT_DIR}/`) && !(manifest.mode === 'live' && LIVE_IMPORTS.includes(r))) || r === MANIFEST);
      const st = srv.sig.stats();
      check('solo-untouched', kitReq.length === 0 && st.sockets === 0 && !st.httpRequests, kitReq.length || st.sockets || st.httpRequests ? `the game on its own asked for ${kitReq.join(', ') || (st.sockets ? 'a signaling socket' : 'HTTP signaling')}` : 'played alone, the game loads no kit file and opens no connection');
      await S.ctx.close();
    }
    const sq = signal ? `&signal=${signal}` : '';

    if (manifest.mode === 'live') {
      if (legs) rec.legs = legs;
      await gateLive({ manifest, live: manifest.live, assets, dir, srv, player, check, notes, shot, rec, errors, seconds, browser, signal, legs, diagnose });
      return finish();
    }

    // ---- C. host, invite, join ----
    const H = await player('host'), J = await player('joiner');
    const cap = Math.max(20, Math.min(600, manifest.check?.seconds ?? seconds));
    const gq = typeof manifest.check?.query === 'string' && manifest.check.query ? `&gq=${encodeURIComponent(manifest.check.query)}` : '';
    if (gq) notes.push(`the gate played the game with ?${manifest.check.query} (check.query: a shorter run, never used in real play)`);
    await H.page.goto(`${srv.partyUrl}?max=${cap}${gq}${sq}`, { waitUntil: 'load' });
    await until(async () => (await snap(H.page))?.phase === 'home' || (await snap(H.page))?.fatal, 20000, 'the lobby');
    const boot = await snap(H.page);
    if (!check('shell-boots', boot?.phase === 'home' && !boot.fatal, boot?.fatal || 'the Host / Join lobby is up')) throw new Error('shell did not boot');
    await H.page.fill('#gfp-name', 'Hosta');
    await H.page.click('#gfp-host');
    const hs = await until(async () => { const s = await snap(H.page); return s?.phase === 'room' && s.code && s.card === 'lobby' && s.host ? s : null; }, 20000, 'the host to open a room');
    check('host-opens-room', /^[A-Z2-9]{6}$/.test(hs.code), `room ${hs.code}`);
    await shot(H.page, 'host-lobby');
    const invite = await H.page.inputValue('#mp-invite');
    check('invite-link', invite.includes(`join=${hs.code}`) && invite.startsWith(srv.partyUrl), invite);
    await J.page.goto(invite, { waitUntil: 'load' });
    await until(async () => (await snap(J.page))?.phase === 'home', 20000, 'the joiner lobby');
    await J.page.fill('#gfp-name', 'Joan');
    await J.page.click('#gfp-join');
    await until(async () => { const a = await snap(H.page), b = await snap(J.page); return a?.racers.length === 2 && b?.racers.length === 2 && b.phase === 'room'; }, 30000, 'both players in the room');
    const [h0, j0] = [await snap(H.page), await snap(J.page)];
    check('joiner-joins-over-webrtc', j0.you && j0.you !== h0.you && !j0.host && (await p2p(J.page))?.connected === true, `host ${h0.you} "${h0.names[h0.you]}", joiner ${j0.you} "${j0.names[j0.you]}"`);
    await checkTransport({ H, J, srv, signal, check, rec });
    check('both-list-both-players', ['Hosta', 'Joan'].every(n => Object.values(h0.names).includes(n) && Object.values(j0.names).includes(n)), Object.values(j0.names).join(', '));
    check('host-config-reaches-room', j0.cfg?.metric === race.metric && j0.cfg?.direction === race.direction && j0.cfg?.maxSeconds === cap, JSON.stringify(j0.cfg));

    // ---- D. round 1 ----
    await H.page.click('#mp-start');
    await until(async () => (await snap(H.page))?.revealed && (await snap(J.page))?.revealed, 15000, 'the countdown to end');
    const [h1, j1] = [await snap(H.page), await snap(J.page)];
    const seedIn = s => { try { const u = new URL(s.frame); return { seed: race.seedParam ? u.searchParams.get(race.seedParam) : null, gf: u.searchParams.get('gf_seed'), round: u.searchParams.get('gf_round') }; } catch { return {}; } };
    const [hq, jq] = [seedIn(h1), seedIn(j1)];
    check('same-seed-both', h1.seed && h1.seed === j1.seed && hq.gf === h1.seed && jq.gf === j1.seed && (!race.seedParam || (hq.seed === h1.seed && jq.seed === j1.seed)), `seed ${h1.seed}${race.seedParam ? ` as ?${race.seedParam}=` : ' (the game takes no seed)'} in both frames, round ${hq.round}`);

    // Keys the scripted player never presses: the game's own list (assets.json check.play.avoidKeys) plus the
    // manifest's check.avoidKeys (a restart or pause key would keep a run from ever ending).
    const avoidKeys = [...new Set([...(assets?.check?.play?.avoidKeys ?? []), ...(manifest.check?.avoidKeys ?? [])])];
    const playManifest = { check: { steps: assets?.check?.steps, play: { ...(assets?.check?.play ?? {}), avoidKeys, query: undefined, sound: false } } };
    const endSteps = Array.isArray(manifest.check?.steps) ? manifest.check.steps : null;
    const driverPath = join(dirname(dir), 'mp-driver.mjs');
    const driver = existsSync(driverPath) ? await import(pathToFileURL(driverPath).href) : null;
    if (driver && typeof driver.play !== 'function') throw new Error('mp-driver.mjs must export async function play(page, ctx)');
    if (driver) notes.push('the scripted players were the trial\'s own mp-driver.mjs (real input, reading the game\'s observation), not random input');
    const deadline = Date.now() + cap * 1000 + 4000;
    async function drive(P, n) {
      const frame = P.page.frames().find(f => f.parentFrame() === P.page.mainFrame());
      const box = await P.page.locator('#game').boundingBox();
      const proxy = inFrame(P.page, frame, { width: Math.round(box.width), height: Math.round(box.height) });
      // The shell counts every change of the value it reads (adapter.moves); the samples here are for the record.
      const look = async () => { const s = await snap(P.page); if (s) { P.last = s; P.trace.moves = Math.max(P.trace.moves ?? 0, s.adapter.moves ?? 0); if (s.adapter.live !== null && !P.trace.live.includes(s.adapter.live) && P.trace.live.length < 400) P.trace.live.push(s.adapter.live); P.trace.maxProgress = Math.max(P.trace.maxProgress, s.adapter.progress ?? 0); } return s; };
      await until(async () => (await frame.evaluate(() => document.readyState === 'complete').catch(() => false)), 30000, 'the game to load').catch(() => {});
      const reach = await reachPlay(proxy, { dir, manifest: playManifest, seed: 7 + n, sound: false, budgetMs: 25000, log: () => {} }).catch(e => ({ reached: false, how: 'error', why: e.message }));
      P.trace.reach = { reached: reach.reached, how: reach.how, why: reach.why ?? null };
      await sleep(1200); await shot(P.page, `${P.label}-playing`);       // in play, before any steps that end the run
      if (driver) {
        // The trial's own driver (mp-driver.mjs beside the game folder): real input through `page`, reading the
        // game's observation, for a game random input can't score in (catching a fish, timing a tap).
        const r = await Promise.race([driver.play(proxy, { index: n, seed: 7 + n, deadline, frame, done: async () => { const s = await look(); return !s || s.adapter.done || s.room === 'results'; } }).then(() => ({ ok: true })).catch(e => ({ ok: false, error: String(e?.message ?? e).slice(0, 200) })),
          sleep(Math.max(1000, deadline - Date.now())).then(() => ({ ok: true, timedOut: true }))]);
        P.trace.driver = r;
      } else if (endSteps) {
        // check.steps, check.repeat times (default once), stopping as soon as the run has ended or time is up.
        const times = Number.isInteger(manifest.check.repeat) ? manifest.check.repeat : 1;
        let ran = 0, failed = 0;
        for (; ran < times && Date.now() < deadline; ran++) {
          const r = await runSteps(proxy, endSteps, { log: () => {} }).catch(e => ({ ok: false, failed: [{ error: e.message }] }));
          failed += (r.failed ?? []).length;
          if (times > 1 && ran % 5 === 4) { const s = await look(); if (!s || s.adapter.done || s.room === 'results') { ran++; break; } }
        }
        P.trace.endSteps = { ok: failed === 0, failed, repeats: ran };
      }
      for (let i = 0; Date.now() < deadline; i++) {
        const s = await look();
        if (!s || s.adapter.done || s.room === 'results') break;
        await fuzz(proxy, { seconds: 2, seed: 100 * (n + 1) + i, avoidKeys }).catch(() => {});
      }
      await look();
    }
    await Promise.all([drive(H, 0), drive(J, 1)]);
    for (const P of [H, J]) {
      const a = P.last?.adapter ?? {};
      rec.players[P.label] = { reach: P.trace.reach, endSteps: P.trace.endSteps ?? null, driver: P.trace.driver ?? null, adapter: a, valueChanges: P.trace.moves ?? 0, liveSample: P.trace.live.slice(0, 12), maxProgress: P.trace.maxProgress };
    }
    const ad = P => P.last?.adapter ?? {};
    check('adapter-reads-both-games', ad(H).ok && ad(J).ok && ad(H).armed && ad(J).armed && !ad(H).error && !ad(J).error, [H, J].map(P => `${P.label}: ok ${!!ad(P).ok}, armed ${!!ad(P).armed}${ad(P).error ? `, error ${ad(P).error}` : ''}, ${ad(P).polls} polls`).join(' · '));
    check('value-moves-while-playing', [H, J].some(P => (P.trace.moves ?? 0) >= 2), [H, J].map(P => `${P.label}: the value changed ${P.trace.moves ?? 0} times (seen: ${P.trace.live.slice(0, 5).join(', ')})`).join(' · '));
    const ended = [H, J].filter(P => ad(P).done && Number.isFinite(ad(P).value));
    check('end-detected', ended.length > 0, ended.length ? ended.map(P => `${P.label} ended with ${ad(P).value}${ad(P).won === null ? '' : ad(P).won ? ' (won)' : ' (lost)'}`).join(' · ') : `no run reached an end in ${cap} s of scripted play`, { soft: true });

    await until(async () => (await snap(H.page))?.room === 'results' && (await snap(J.page))?.room === 'results', cap * 1000 + 20000, 'the round to end');
    await until(async () => (await snap(H.page))?.results && (await snap(J.page))?.results, 5000, 'the results').catch(() => {});
    const [h2, j2] = [await snap(H.page), await snap(J.page)];
    const same = JSON.stringify(h2.results) === JSON.stringify(j2.results);
    check('both-see-the-same-results', same && h2.results?.ranking?.length === 2, same ? `ranking ${h2.results.ranking.map(id => h2.names[id]).join(' > ')}; ${h2.results.results.map(r => `${h2.names[r.id]} ${r.dnf ? 'did not finish' : r.value}`).join(', ')}` : 'host and joiner disagree');
    for (const P of ended) { const r = h2.results?.results?.find(x => x.id === P.last.you); check(`result-is-the-game's-${P.label}`, r && r.value === ad(P).value, `${P.label}: the room has ${r?.value}, the game ended with ${ad(P).value}`); }
    await shot(H.page, 'host-results'); await shot(J.page, 'joiner-results');
    rec.round1 = h2.results;

    // ---- E. play again ----
    check('scripted-play-stayed-in-round-1', h2.round === 1 && j2.round === 1, `the room is at round ${h2.round}`);
    // If the results card is not showing, the button is in the rail.
    await sleep(900);
    await H.page.click(await H.page.isVisible('#mp-again') ? '#mp-again' : '#start');
    await until(async () => { const a = await snap(H.page), b = await snap(J.page); return a?.round === 2 && b?.round === 2 && a.revealed && b.revealed; }, 20000, 'round 2');
    const [h3, j3] = [await snap(H.page), await snap(J.page)];
    check('play-again-deals-a-new-seed', h3.seed === j3.seed && h3.seed !== h1.seed && seedIn(h3).round === '2' && seedIn(j3).round === '2', `round 2 seed ${h3.seed} (round 1 was ${h1.seed})`);
    // Round 1's game is still in the frame, often still running, when round 2 is dealt: nothing of it may count.
    // (Kit 1.0.0 could read the old page for a moment and report its end as round 2's result.)
    const stale = [[H, h3], [J, j3]].filter(([, s]) => s.adapter.done || s.racers.find(r => r.id === s.you)?.done);
    check('round-2-starts-clean', stale.length === 0, stale.length ? stale.map(([P, s]) => `${P.label} already has a round-2 result (${s.adapter.value}) the moment the round starts: it came from round 1's page`).join(' · ') : 'nobody has a result when the round starts');

    // ---- F. a reload takes the same seat back ----
    await J.page.reload({ waitUntil: 'load' });
    // A game that ends by itself with nobody playing (a song that fails, a timer) can finish round 2 while the page
    // reloads: the joiner then comes back to that round's results, which is just as much "the same seat".
    const j4 = await until(async () => { const s = await snap(J.page); return s?.phase === 'room' && s.round === 2 && (s.revealed || s.room === 'results') ? s : null; }, 30000, 'the joiner to rejoin').catch(() => null);
    check('reload-rejoins-the-same-seat', j4 && j4.you === j0.you && (j4.room === 'results' || j4.seed === h3.seed),
      j4 ? (j4.seed === h3.seed ? `seat ${j4.you} again, back on seed ${j4.seed}` : `seat ${j4.you} again; round 2 had ended by itself while the page reloaded`) : 'the joiner did not get back in');

    // ---- G. the host ends the round ----
    const byItself = (await snap(H.page))?.room === 'results';
    if (!byItself) {
      await H.page.keyboard.press('Escape');    // as a player would, to get the mouse back from a game that holds it
      await H.page.click('#stop', { timeout: 4000 }).catch(() => {});   // the round may end by itself at this very moment
    }
    await until(async () => (await snap(H.page))?.room === 'results' && (await snap(J.page))?.room === 'results', 15000, 'End round')
      .then(() => check('host-ends-the-round', true, byItself ? 'round 2 had already ended by itself; both pages show its results' : 'both pages show round 2 results')).catch(e => check('host-ends-the-round', false, e.message));

    // ---- H. the host leaves ----
    await H.page.close();
    const gone = await until(async () => { const s = await p2p(J.page); return s && ['closed', 'lost'].includes(s.phase) ? s : null; }, 25000, 'the joiner to notice').catch(() => null);
    check('host-leaving-closes-the-room', !!gone, gone ? `the joiner sees: ${gone.reason}` : 'the joiner never noticed');
    await shot(J.page, 'joiner-after-host-left');

    const kitErrors = errors.filter(e => e.kit);
    check('no-kit-errors', kitErrors.length === 0, kitErrors.slice(0, 3).map(e => `${e.who}: ${e.text}`).join(' | '));
    const gameErrors = errors.filter(e => !e.kit);
    if (gameErrors.length) notes.push(`${gameErrors.length} console errors from the game itself under scripted input (not the kit): ${[...new Set(gameErrors.map(e => e.text))].slice(0, 3).join(' | ')}`);
    rec.signaling = srv.sig.stats();
  } catch (e) {
    check('run-completed', false, e.message);
  } finally {
    await browser.close().catch(() => {});
    await srv.close().catch(() => {});
  }
  return finish();
}

if (isMain(import.meta)) {
  const a = process.argv.slice(2);
  const flagsWithValue = ['--out', '--seconds', '--draft', '--port', '--signal', '--legs'];
  const opt = (k, d) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
  const dir = a.find((x, i) => !x.startsWith('--') && !flagsWithValue.includes(a[i - 1]));
  if (!dir) { console.error('usage: gate.mjs <game-dir> [--out <evidence-root>] [--seconds 75] [--draft <multiplayer.json>] [--dev-kit] [--no-record] [--port N] [--signal http|ws] [--legs lobby] [--json]'); process.exit(2); }
  const json = a.includes('--json');
  const rec = await gate(dir, { out: opt('--out', null), seconds: Number(opt('--seconds', 75)), draft: opt('--draft', null), devKit: a.includes('--dev-kit'), record: !a.includes('--no-record'), port: Number(opt('--port', 0)), signal: opt('--signal', null), legs: opt('--legs', null), log: json ? () => {} : console.log });
  if (json) console.log(JSON.stringify(rec, null, 2));
  else console.log(`\n${basename(dirname(resolve(dir)))}: ${rec.verdict.toUpperCase()} ${rec.passed}/${rec.total}${rec.outDir ? `  → ${relative(process.cwd(), rec.outDir)}` : ''}`);
  process.exit(rec.verdict === 'pass' ? 0 : rec.verdict === 'fail' ? 1 : 3);
}
