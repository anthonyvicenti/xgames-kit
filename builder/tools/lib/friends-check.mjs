// Verify check 25, "playing with friends" (CONTRACT §5, §6h): the friends page the way a new player meets it, through
// the kit's own page (gf/mp/index.html), two Chrome contexts over real WebRTC, real clicks and keys.
//
// Creator, 2026-10-08 (research/foundations/evidence/multiplayer-lobby-feedback-2026-10-08.json): "Multiplayer still
// feels a little weird. The waiting lobby is pretty poorly done from a UI perspective. New users can't name before
// joining a room or change name in a room before the game. Final scores seem to always be the same regardless. We
// really shouldn't have bots in multiplayer modes"
//
// What it proves, in order:
//   name first      the Host / Join screen offers a name field that is never blank; the host types one, the joiner
//                   keeps what it was given (never "Player")
//   one room view   the waiting room is the party page's own card (the code shown once: the host-join kit's corner pill
//                   is off), and alone the host cannot start: friends play friends
//   rename          the joiner clicks its name in the waiting room, types a new one, presses Enter: the host's waiting
//                   room shows it, and so does the game (the scoreboard and nameplates read the same name)
//   colours         each player's dot in the waiting room is the colour the game draws that player in
//   no bots         the round has the two humans and nobody else, on both copies
//   own scores      both play (keys held, primary held) through a short round (Studio's own override of round.seconds)
//                   that ends on the game's clock, as the creator's did (if it has not ended in time, the host ends it as a
//                   player would); the party's results card is the one result screen (the game draws no card of its own)
//                   and shows each player the score the game counted for them, not one number for all
//   fits a phone    (gf-multiplayer 1.7.3; the creator, 2026-10-12: "Looks like some of the buttons run off the screen")
//                   two more pages with a touch screen at 390×844, 844×390 and 640×360: the Host / Join screen, the
//                   waiting room alone, the invited friend's Host / Join, the waiting room with that friend (both), the
//                   stream panel after Go live; nothing past the screen or cut off, nothing under 44 px, the main action
//                   in view (friendsOnPhones below, tools/lib/phone-fit.mjs)
//
//   const r = await checkFriends({ dir, outDir, shots, log, seconds });   → { ok, detail, record, warnings }
import { mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startParty } from '../../multiplayer/party/lib.mjs';
import { endRound, snap, sleep, until } from '../../multiplayer/party/gate-lib.mjs';
import { launchChrome, GPU_TROUBLE } from '../../qa/browser.mjs';
import { launchForGame } from './paths.mjs';
import { PHONE_SIZES, PHONE_CONTEXT, fitScreen } from './phone-fit.mjs';
import { compareVersions } from '../../multiplayer/party/manifest.mjs';

const lower = c => String(c ?? '').trim().toLowerCase();

/**
 * Check 25's phone leg (the creator, 2026-10-12, on the forge zombie game v8 on a phone: "Review mobile, especially
 * around the pre-game lobby. Looks like some of the buttons run off the screen"; research/rust-engine/evidence/
 * creator-zombie-town-v8-mobile-lobby-2026-10-12.json). Two touch pages, real taps, at PHONE_SIZES (upright, held
 * sideways, and held sideways with the browser's bars): the Host / Join screen, the waiting room as host alone, the
 * invited joiner's Host / Join screen, the waiting room with the friend in it (the host's and the joiner's), and the
 * stream panel after Go live from the waiting room (then the stream stops). On each, every button, link and field (in
 * the shadow DOM too) is on the screen or in a box that scrolls, none is cut off, none is under 44 px, the screen's
 * main action (Host, Join, Start, Turn on mic and the panel's ×) is whole on the screen without scrolling, and stays
 * there with everything else scrolled to its end (tools/lib/phone-fit.mjs).
 * → { ok, detail, record, warnings }
 */
/** The gf-multiplayer version a game carries (gf/mp/kit.json), or null. */
export async function mpKitVersion(dir) { try { return JSON.parse(await readFile(join(dir, 'gf/mp/kit.json'), 'utf8')).version ?? null; } catch { return null; } }

export async function friendsOnPhones({ browser, partyUrl, shot = null, log = () => {}, kitVersion = null, dir = null }) {
  let own = null, ownSrv = null;
  const record = { sizes: PHONE_SIZES.map(s => s.join('x')), screens: [] }, warnings = [], bad = [];
  const ctxs = [];
  const phone = async () => { const ctx = await browser.newContext({ viewport: { width: PHONE_SIZES[0][0], height: PHONE_SIZES[0][1] }, ...PHONE_CONTEXT }); ctxs.push(ctx); return ctx.newPage(); };
  const screen = async (page, where, main) => {
    const r = await fitScreen(page, where, { main, shot });
    record.screens.push({ where, ok: r.ok, sizes: r.record });
    if (!r.ok) bad.push(r.summary);
    log(`${r.ok ? 'pass' : 'FAIL'} friends on a phone, ${where}: ${r.ok ? `fits ${record.sizes.join(', ')}` : r.lines.slice(0, 2).join(' | ')}`);
  };
  try {
    const H = await phone();
    await H.goto(`${partyUrl}?max=600`, { waitUntil: 'load' });
    await until(async () => (await snap(H))?.phase === 'home', 60000, 'the Host / Join screen on a phone');
    await sleep(600);
    await screen(H, 'the Host / Join screen', ['#gfp-host']);
    await H.locator('#gfp-host').tap();
    await until(async () => { const s = await snap(H); return s?.phase === 'room' && s.code ? s : null; }, 60000, 'the room on a phone');
    await sleep(1200);
    await screen(H, 'the waiting room alone', ['#mp-start']);
    const J = await phone();
    await J.goto(await H.inputValue('#mp-invite'), { waitUntil: 'load' });
    await until(async () => (await snap(J))?.phase === 'home', 60000, "the joiner's Host / Join screen on a phone");
    await sleep(600);
    await screen(J, "the invited friend's Host / Join screen", ['#gfp-join']);
    await J.locator('#gfp-join').tap();
    await until(async () => (await snap(H))?.racers.length === 2 && (await snap(J))?.phase === 'room', 120000, 'both phones in the room');
    await sleep(1200);
    await screen(H, 'the waiting room with a friend (host)', ['#mp-start']);
    await screen(J, 'the waiting room with a friend (joiner)', []);
    if (await H.locator('#mp-golive').count()) {
      await H.locator('#mp-golive').tap();
      const on = await until(async () => (await snap(H))?.live?.state === 'on', 20000, 'live').catch(() => false);
      await until(() => H.evaluate(() => !!document.querySelector('#mp-live-share:not([hidden]) #mp-live-mic')), 8000, 'the stream panel').catch(() => null);
      await sleep(500);
      if (on) await screen(H, 'the stream panel', ['#mp-live-mic', '#mp-live-close']);
      else warnings.push('friends on a phone: Go live did not go live, so the stream panel was not measured');
      await H.evaluate(() => document.getElementById('mp-live-stop')?.click()).catch(() => {});
    } else warnings.push('friends on a phone: the waiting room offers no Go live here (no stream relay), so the stream panel was not measured');
    // gf-multiplayer 1.7.4: on the game's own link (the play host's /p/<slug>/, no Studio page above) the waiting room says
    // where voice chat is: a line that opens Studio's page in this room. Here the play host is stood in for: a server of
    // its own serving the game under /p/the-game/ (a folder with a link to the game) whose /watch/v1 names a Studio
    // origin (this machine's names none). Its signaling, relay and host worker are the real ones.
    if (dir && kitVersion && compareVersions(kitVersion, '1.7.4') >= 0) {
      const STUDIO = 'https://studio.example', SLUG = 'the-game';
      own = await mkdtemp(join(tmpdir(), 'gf-own-link-'));
      await mkdir(join(own, 'p'), { recursive: true });
      await symlink(resolve(dir), join(own, 'p', SLUG), 'dir');
      ownSrv = await startParty({ dir: own, port: 0, studio: STUDIO });
      const ctx = await browser.newContext({ viewport: { width: PHONE_SIZES[0][0], height: PHONE_SIZES[0][1] }, ...PHONE_CONTEXT }); ctxs.push(ctx);
      const G = await ctx.newPage();
      await G.goto(`${ownSrv.url}p/${SLUG}/gf/mp/index.html?max=600`, { waitUntil: 'load' });
      await until(async () => (await snap(G))?.phase === 'home', 60000, "the game's own link's Host / Join screen");
      await G.locator('#gfp-host').tap();
      const g = await until(async () => { const s = await snap(G); return s?.phase === 'room' && s.code ? s : null; }, 60000, "the room on the game's own link");
      await sleep(1200);
      const line = await G.evaluate(() => { const a = document.getElementById('mp-voice-hint'); return a ? { text: a.textContent.trim(), href: a.href } : null; }).catch(() => null);
      const want = `${STUDIO}/play/${SLUG}?join=${encodeURIComponent(g.code)}`;
      record.voiceLine = { line, want };
      if (!line || line.href !== want || !/^Voice chat: play from /.test(line.text)) bad.push(`the game's own link: the waiting room's voice chat line is ${line ? `"${line.text}" → ${line.href}` : 'not there'} (wanted a link to ${want})`);
      else log(`pass friends on a phone, the voice chat line: "${line.text}" → ${line.href}`);
      await screen(G, "the waiting room on the game's own link (the voice chat line)", ['#mp-start', '#mp-voice-hint']);
    }
  } catch (e) { bad.push(`the phone run stopped: ${e.message}`); }
  finally {
    for (const c of ctxs) await c.close().catch(() => {});
    if (ownSrv) await ownSrv.close().catch(() => {});
    if (own) await rm(own, { recursive: true, force: true }).catch(() => {});
  }
  return { ok: bad.length === 0, record, warnings, detail: bad.length ? bad.join(' · ') : `${record.screens.length} screens fit ${record.sizes.join(', ')}` };
}

export async function checkFriends({ dir, outDir = null, shots = [], log = () => {}, seconds = 25, phones = true } = {}) {
  const mp = JSON.parse(await readFile(join(dir, 'multiplayer.json'), 'utf8'));
  const record = { steps: [], shots: [], scores: null, names: null, colors: null };
  const warnings = [];
  const step = (name, ok, detail) => { record.steps.push({ name, ok: !!ok, detail }); log(`${ok ? 'pass' : 'FAIL'} friends ${name}: ${detail}`); return !!ok; };
  if (mp.mode !== 'live') return { ok: false, detail: `multiplayer.json mode is ${mp.mode}, not live`, record, warnings };

  const srv = await startParty({ dir, port: 0 });
  const { browser, note } = await launchForGame(launchChrome, dir);
  if (note) warnings.push(`friends: ${note}`);
  const errors = [];
  const player = async who => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await ctx.newPage();
    // a short round, the way Studio overrides a value (the frame gets it too: init scripts run in every frame)
    await page.addInitScript(o => { globalThis.__GF_ASSET_OVERRIDES = o; }, { patches: [{ file: 'config/game.json', pointer: '/round/seconds', value: seconds }] });
    page.on('pageerror', e => errors.push(`${who}: ${e.message}`));
    page.on('console', m => { if (m.type() === 'error' && !GPU_TROUBLE.test(m.text())) errors.push(`${who}: ${m.text().slice(0, 240)}`); });
    return { who, ctx, page };
  };
  const shot = async (P, name) => {
    if (!outDir) return null;
    const f = `friends-${String(record.shots.length + 1).padStart(2, '0')}-${name}.jpg`;
    record.shots.push(f); shots.push(f);
    await P.page.screenshot({ path: join(outDir, f), type: 'jpeg', quality: 75 }).catch(() => {});
    return f;
  };
  const frameOf = P => P.page.frames().find(f => f.parentFrame() === P.page.mainFrame());
  const game = P => frameOf(P)?.evaluate(() => window.__game?.snapshot?.() ?? null).catch(() => null) ?? null;
  const looks = P => frameOf(P)?.evaluate(() => window.__game?.looks?.() ?? null).catch(() => null) ?? null;
  const pill = P => P.page.evaluate(() => !!document.getElementById('gf-p2p')?.shadowRoot?.querySelector('#gfp-pill')).catch(() => false);

  let ok = true;
  try {
    const H = await player('host'), J = await player('joiner');
    await H.page.goto(`${srv.partyUrl}?max=${Math.max(60, seconds + 60)}`, { waitUntil: 'load' });
    await until(async () => (await snap(H.page))?.phase === 'home', 30000, 'the Host / Join screen');
    await sleep(600);

    // ---- name first ----
    const hostField = await H.page.locator('#gfp-name').evaluate(e => ({ tag: e.tagName, value: (e.value ?? e.textContent ?? '').trim(), shown: e.checkVisibility?.() ?? true })).catch(() => null);
    ok = step('name-before-hosting', !!hostField?.shown && hostField.value.length > 0, hostField ? `the Host / Join screen opens with a ${hostField.tag === 'INPUT' ? 'name field' : 'name'} holding "${hostField.value}"` : 'no name field (#gfp-name) on the Host / Join screen') && ok;
    await shot(H, 'host-home');
    if (hostField?.tag === 'INPUT') { await H.page.click('#gfp-name', { clickCount: 3 }); await H.page.keyboard.type('Hosta'); }
    await H.page.click('#gfp-host');
    const hs = await until(async () => { const s = await snap(H.page); return s?.phase === 'room' && s.code && s.host ? s : null; }, 30000, 'the host to open a room');
    await sleep(900);

    // ---- one room view; alone the host cannot start ----
    const hostLobby = await snap(H.page);
    const startAlone = await H.page.locator('#mp-start').evaluate(b => ({ shown: b.checkVisibility?.() ?? true, disabled: b.disabled, text: b.textContent.trim() })).catch(() => null);
    const pillShown = await pill(H);
    const railShown = await H.page.evaluate(() => { const r = document.getElementById('rail'); return !!r && !r.hidden && r.getBoundingClientRect().width > 0; }).catch(() => false);
    ok = step('one-waiting-room', hostLobby?.card === 'lobby' && !pillShown && !railShown,
      `the waiting room is ${hostLobby?.card === 'lobby' ? "the party page's card" : `"${hostLobby?.card}"`}; the host-join kit's corner pill is ${pillShown ? 'ALSO showing the room' : 'off'}; the standings rail is ${railShown ? 'ALSO showing the players' : 'out of the way'}`) && ok;
    ok = step('friends-play-friends', !!startAlone && startAlone.disabled,
      startAlone ? `alone in the room the host's Start is ${startAlone.disabled ? `disabled ("${startAlone.text}")` : `ENABLED ("${startAlone.text}"): a friends round could start with nobody but bots`}` : 'no Start button (#mp-start) in the waiting room') && ok;
    await shot(H, 'host-waiting-alone');

    // ---- the joiner keeps the name it was given ----
    const invite = await H.page.inputValue('#mp-invite');
    await J.page.goto(invite, { waitUntil: 'load' });
    await until(async () => (await snap(J.page))?.phase === 'home', 30000, "the joiner's Host / Join screen");
    await sleep(600);
    const given = (await J.page.locator('#gfp-name').evaluate(e => (e.value ?? e.textContent ?? '').trim()).catch(() => '')) || '';
    await shot(J, 'joiner-home');
    await J.page.click('#gfp-join');
    await until(async () => (await snap(H.page))?.racers.length === 2 && (await snap(J.page))?.racers.length === 2 && (await snap(J.page))?.phase === 'room', 30000, 'both players in the room');
    await sleep(700);
    const j0 = await snap(J.page), jid = j0.you, hid = hs.you;
    const joinedAs = (await snap(H.page))?.names?.[jid] ?? '';
    ok = step('a-name-before-joining', !!given && !/^player( \d+)?$/i.test(joinedAs) && joinedAs.length > 0,
      `the invite opened with "${given || '(nothing)'}" in the name field; joining without typing, the host's room lists the joiner as "${joinedAs}"`) && ok;

    // ---- rename in the waiting room ----
    const NEW = 'Jo Renamed';
    let renamed = false;
    if (await J.page.isVisible('#mp-name').catch(() => false)) {
      await J.page.click('#mp-name', { clickCount: 3 });
      await J.page.keyboard.type(NEW); await J.page.keyboard.press('Enter');
      renamed = !!(await until(async () => (await snap(H.page))?.names?.[jid] === NEW, 10000, 'the new name on the host').catch(() => null));
    }
    ok = step('rename-in-the-room', renamed, renamed ? `the joiner changed "${joinedAs}" to "${NEW}" in the waiting room; the host's waiting room shows it` : `the joiner could not change its name in the waiting room (${await J.page.isVisible('#mp-name').catch(() => false) ? 'the host never saw the new name' : 'no name field (#mp-name) on its own row'})`) && ok;
    await shot(H, 'host-waiting-two');
    await shot(J, 'joiner-waiting');

    // ---- the round: two humans, nobody else ----
    const startNow = await H.page.locator('#mp-start').evaluate(b => !b.disabled).catch(() => false);
    if (startNow) await H.page.click('#mp-start'); else await H.page.click('#start').catch(() => {});
    await until(async () => (await game(H))?.net?.started && (await game(J))?.net?.started, 120000, 'both games to start');
    await sleep(1200);
    const [gh, gj] = [await game(H), await game(J)];
    const bots = [...(gh?.players ?? []), ...(gj?.players ?? [])].filter(p => p.bot);
    const humans = n => (n?.players ?? []).filter(p => !p.bot).length;
    ok = step('no-bots-with-friends', gh && gj && bots.length === 0 && humans(gh) === 2 && humans(gj) === 2,
      bots.length ? `the friends round has bots: ${[...new Set(bots.map(b => `${b.name} (${b.id})`))].join(', ')} beside ${humans(gh)} players` : `the round holds the ${humans(gh)} players and nobody else, on both copies`) && ok;
    const gameName = (gh?.players ?? []).find(p => p.id === jid)?.name, gameNameJ = (gj?.players ?? []).find(p => p.id === jid)?.name;
    ok = step('the-game-uses-the-room-names', renamed && gameName === NEW && gameNameJ === NEW, `the game calls the joiner "${gameName}" on the host's copy and "${gameNameJ}" on its own${renamed ? '' : ' (the rename never happened)'}`) && ok;
    // colours: the waiting room's dot for each player against the colour the game draws them in
    const party = await snap(H.page), lk = await looks(H);
    const dots = Object.fromEntries((party?.colors ?? []).map(c => [c.id, lower(c.color)]));
    const drawn = Object.fromEntries((lk?.players ?? []).filter(p => !p.bot).map(p => [p.id, lower(p.color)]));
    const mismatch = [hid, jid].filter(id => !dots[id] || !drawn[id] || dots[id] !== drawn[id]);
    record.colors = { party: dots, game: drawn };
    ok = step('one-colour-per-player', mismatch.length === 0, mismatch.length ? `the waiting room's colour and the game's differ for ${mismatch.map(id => `${id} (room ${dots[id] ?? '?'}, game ${drawn[id] ?? '?'})`).join(', ')}` : `each player's dot is the colour the game draws them in (${[hid, jid].map(id => `${id} ${drawn[id]}`).join(', ')})`) && ok;
    await shot(H, 'host-playing');

    // ---- play: both hold keys and the primary action, turning ----
    const drive = async (P, seed) => {
      const box = await P.page.locator('#game').boundingBox(); if (!box) return;
      const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
      await P.page.mouse.click(cx, cy).catch(() => {});
      const end = Date.now() + (seconds + 8) * 1000;
      for (let k = 0; Date.now() < end; k++) {
        const s = await snap(P.page); if (!s || s.room === 'results' || s.card) break;
        const key = ['KeyW', 'KeyA', 'KeyW', 'KeyD', 'KeyS'][(k + seed) % 5];
        await P.page.keyboard.down(key); await P.page.mouse.down().catch(() => {});
        await P.page.mouse.move(cx + ((k * 37 + seed * 11) % 200) - 100, cy, { steps: 4 }).catch(() => {});
        await sleep(seed ? 900 : 1300);
        await P.page.mouse.up().catch(() => {}); await P.page.keyboard.up(key);
      }
    };
    await Promise.all([drive(H, 0), drive(J, 3)]);

    // ---- the round ends on its clock (else the host ends it as a player would); one result screen, each one's own score ----
    const ended = await until(async () => (await snap(H.page))?.room === 'results' && (await snap(J.page))?.room === 'results', 15000, 'the round to end').then(() => 'on its clock').catch(() => null);
    if (!ended) { await endRound(H.page); await until(async () => (await snap(H.page))?.room === 'results' && (await snap(J.page))?.room === 'results', 30000, 'the results on both'); }
    record.ended = ended ?? 'by the host';
    await sleep(1500);
    const [ph, pj, gh2, gj2] = [await snap(H.page), await snap(J.page), await game(H), await game(J)];
    const truth = Object.fromEntries((gh2?.players ?? []).filter(p => !p.bot).map(p => [p.id, p.score]));
    const shown = r => (r.done && !r.dnf ? r.value : r.live);
    const card = P => Object.fromEntries((P?.racers ?? []).filter(r => !r.watching).map(r => [r.id, shown(r)]));
    const [ch, cj] = [card(ph), card(pj)];
    record.scores = { game: truth, hostCard: ch, joinerCard: cj, team: !!ph?.cfg?.team };
    const wrong = [hid, jid].filter(id => ch[id] !== truth[id] || cj[id] !== truth[id]);
    const same = Object.values(truth).length === 2 && truth[hid] !== truth[jid] && ch[hid] === ch[jid];
    ok = step('each-players-own-score', ph?.card === 'results' && pj?.card === 'results' && wrong.length === 0,
      `${ph?.cfg?.team ? 'a team round' : 'a versus round'}; the game counted ${[hid, jid].map(id => `${id} ${truth[id]}`).join(', ')}; the results card shows ${[hid, jid].map(id => `${id} ${ch[id]}`).join(', ')} on the host and ${[hid, jid].map(id => `${id} ${cj[id]}`).join(', ')} on the joiner${same ? ' (the same score for everyone, whatever each player did)' : wrong.length ? ` (wrong for ${wrong.join(', ')})` : ''}${truth[hid] === truth[jid] ? '; both scored the same this time, so this round could not tell one number for all from each their own' : ''}`) && ok;
    if (truth[hid] === truth[jid]) warnings.push(`friends: both players scored ${truth[hid]}, so the own-score step could not tell one number for all from each their own`);
    const ownCard = [gh2?.view, gj2?.view].filter(v => v === 'results');
    ok = step('one-result-screen', ownCard.length === 0, ownCard.length ? 'the game draws its own results card under the party page\'s (two result screens that can disagree)' : "the party page's results card is the only one") && ok;
    await shot(H, 'host-results');
    await shot(J, 'joiner-results');
  } catch (e) {
    ok = step('run', false, e.message);
  }
  // ---- on a phone (kit 1.7.3's layout; the creator: "Looks like some of the buttons run off the screen") ----
  if (phones) {
    try {
      const phoneShot = async (page, name) => shot({ page }, name);
      const p = await friendsOnPhones({ browser, partyUrl: srv.partyUrl, shot: outDir ? phoneShot : null, log, kitVersion: await mpKitVersion(dir), dir });
      record.phone = p.record; warnings.push(...p.warnings);
      ok = step('fits-a-phone', p.ok, p.detail) && ok;
    } catch (e) { ok = step('fits-a-phone', false, `the phone leg could not run: ${e.message}`) && ok; }
  }
  await browser.close().catch(() => {});
  await srv.close().catch(() => {});
  const kitErrors = errors.filter(e => /gf\/mp\/|party\.js|gf\.js|net\.js/.test(e));
  if (kitErrors.length) ok = step('no-kit-errors', false, kitErrors.slice(0, 3).join(' | ')) && ok;
  // a refusal at the call (kit/core/refusals.js) in a friends round: the misuse fails here, by its code
  const refused = [...new Set(errors.flatMap(e => [...e.matchAll(/gf-three refused \[([a-z-]+)\]/g)].map(m => m[1])))];
  if (refused.length) ok = step('no-kit-refusals', false, `the kit ${refused.map(c => `refused [${c}]`).join(', ')} (window.__game.snapshot().refusals lists each with its fix)`) && ok;
  if (errors.length > kitErrors.length) warnings.push(`friends: ${errors.length - kitErrors.length} console errors from the game: ${[...new Set(errors)].slice(0, 2).join(' | ')}`);
  const failed = record.steps.filter(s => !s.ok);
  return { ok: ok && failed.length === 0, record, warnings,
    detail: failed.length ? failed.map(s => `${s.name}: ${s.detail}`).join(' · ') : record.steps.map(s => s.name).join(', ') + (record.scores ? `; scores ${JSON.stringify(record.scores.game)}` : '') };
}
