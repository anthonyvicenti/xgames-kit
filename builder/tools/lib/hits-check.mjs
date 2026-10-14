// verify check 16: hits read. A player who shoots an enemy sees each hit land, and an enemy takes more than one hit.
//
// Creator, live Studio "Hang Up On Them" (2026-10-07), on a game that passed verify 13/13 and the play-tester: "The
// zombies are instant killed to I couldn't even tell what was happened. There was no healthbar or anything." The spec
// had pistol damage 1 against 2 HP zombies; the kit showed nothing for a hit that did not kill, so when the play-tester
// said "my pistol never visibly kills anything" the repair round raised the damage to 2 and every shot killed. Since then
// the kit's waves mechanic shows every hit (a health bar over the enemy, a flash, a flinch, a push back) and a death
// that reads (a fall, then a sink), and this check holds a game to it.
//
// One solo page with no bots on the kit's staged moment `?gf-demo=waves.hit` (kit/mechanics/waves: no waves; one enemy
// at a time standing 6 m in front of the player, with the game's own wave-1 hit points; a new one after each kill),
// with the game's own weapon, rules and config. The scripted player turns the camera with the mouse until the enemy's
// body is under the crosshair and fires with real clicks (a stream: held), until KILLS kills or SECONDS. Measured:
//   hits per kill   the kit's kill log (window.__game.controls() → mechanics[waves].stats.kills): the frames in which
//                   each enemy the player killed took damage. The median must be at least MIN_HITS, unless the game's
//                   locked spec (spec.json, the sha gf-three.json records) sets waves `oneHitKills`: the same flag in
//                   config/game.json alone (a build or repair agent's edit) fails.
//   a hit that did not kill, from the player's own screen: frames before and after it, cropped to the enemy (its feet
//                   to the bar above its head): at least CHANGE_MIN of those pixels changed beyond the noise between
//                   the before frames (the flash, the flinch, the push back, the bar); and the health bar (the kit's UI,
//                   read from the page) is shown over that enemy, at least BAR_MIN_W × BAR_MIN_H px, near its head,
//                   showing the hit points left, and its fill is drawn in its colour on the screenshot.
// The detail says the hits per kill and what changed on a hit, because the build agent repairs from it.
// With the melee mechanic (gf-scenic wave 1, track M): the scripted player walks up to the staged enemy with real keys
// (camera-relative, calibrated), aims at it (the follow camera: the mouse cursor on it; third person: the crosshair) and
// swings with real clicks until KILLS kills; the same hits-per-kill rule and the same reading of a hit. With the follow
// camera a projectile game aims by moving the cursor onto the enemy.
// No waves mechanic, or neither projectile nor melee: nothing to hit, passes (n/a). About 10–25 s on the solo browser.
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { median } from '../../../components/waves/logic.js';
import { normalizeWeapons } from '../../../components/melee/logic.js';
import { prepareStepped, stepUrl, clockFor, wallClock, mouseTaken } from './stepped.mjs';
import { turnBy } from './lock.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const r2 = v => Math.round(v * 100) / 100;
export const HIT_LIMITS = { KILLS: 3, MIN_HITS: 2, SECONDS: 28, BAR_MIN_W: 24, BAR_MIN_H: 4, BAR_NEAR: 60, CHANGE_MIN: 0.03, BAR_FILL_MIN: 0.35, PIXEL_T: 60, AIM_PX: 7 };
const RIG = { third: { fov: 60, sensitivity: 0.0026 }, first: { fov: 72, sensitivity: 0.0024 }, top: { fov: 50, sensitivity: 0 } };

/** In the page: the observation, the local player and the waves mechanic's stats. */
const OBS = () => {
  const g = window.__game; if (!g) return null;
  const s = g.snapshot(), me = s.players.find(p => p.local);
  let c = null; try { c = g.controls?.() ?? null; } catch {}
  const w = c?.mechanics?.find(m => m.id === 'waves')?.stats ?? null;
  return { phase: s.phase, me, now: s.time?.now ?? 0, w, aim: c?.aim ?? null, view: { w: innerWidth, h: innerHeight }, locked: document.pointerLockElement != null };
};
/** In the page: the kit's health bar for enemy `id`, as drawn. */
const BAR = id => {
  const e = document.querySelector(`#gf-ui .gf-hbar[data-key="waves:${id}"]`); if (!e) return null;
  const r = e.getBoundingClientRect(), cs = getComputedStyle(e), fill = e.lastChild, root = document.getElementById('gf-ui');
  return { x: r.x, y: r.y, w: r.width, h: r.height, frac: Number(e.dataset.frac), fillW: fill?.getBoundingClientRect().width ?? 0,
    shown: cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) > 0.5 && (!root || getComputedStyle(root).display !== 'none'), color: fill ? getComputedStyle(fill).backgroundColor : null };
};

/** Does the game's locked spec ask for one-hit kills? (spec.json, unchanged since create: gf-three.json's sha) */
export async function oneHitAsked(dir) {
  const f = join(dir, 'spec.json');
  if (!existsSync(f)) return { asked: false, why: 'no spec.json in the game' };
  const bytes = await readFile(f);
  const rec = JSON.parse(await readFile(join(dir, 'gf-three.json'), 'utf8').catch(() => '{}'));
  const sha = createHash('sha256').update(bytes).digest('hex');
  if (rec.spec?.sha256 && rec.spec.sha256 !== sha) return { asked: false, why: 'spec.json changed since create (its sha differs from gf-three.json)' };
  let spec = null; try { spec = JSON.parse(bytes.toString('utf8')); } catch { return { asked: false, why: 'spec.json is not JSON' }; }
  const w = (spec.mechanics ?? []).find(m => m.id === 'waves');
  return { asked: w?.params?.oneHitKills === true, why: w?.params?.oneHitKills === true ? 'the spec sets waves oneHitKills' : 'the spec does not set waves oneHitKills' };
}

/**
 * How many hits a basic enemy takes, as the game's locked spec says (gate F, measure 39; the creator's "≥ 2" became a
 * spec default, 2026-10-12): waves `hitsPerKill` in spec.json (unchanged since create: gf-three.json's sha), else 1
 * when it sets `oneHitKills`, else HIT_LIMITS.MIN_HITS. A spec edited after create counts as saying nothing. And what
 * config/game.json says (a build or repair agent's edit): `config` below `want` fails the measure.
 * → {want, config, locked, why}
 */
export async function hitsAsked(dir, wavesParams = {}) {
  const per = p => (Number.isInteger(p?.hitsPerKill) && p.hitsPerKill >= 1 ? p.hitsPerKill : p?.oneHitKills === true ? 1 : null);
  const config = per(wavesParams) ?? HIT_LIMITS.MIN_HITS;
  const f = join(dir, 'spec.json');
  const out = (want, locked, why) => ({ want, config, locked, why });
  if (!existsSync(f)) return out(HIT_LIMITS.MIN_HITS, false, `no spec.json in the game: the default, ${HIT_LIMITS.MIN_HITS}`);
  const bytes = await readFile(f);
  const rec = JSON.parse(await readFile(join(dir, 'gf-three.json'), 'utf8').catch(() => '{}'));
  if (rec.spec?.sha256 && rec.spec.sha256 !== createHash('sha256').update(bytes).digest('hex')) return out(HIT_LIMITS.MIN_HITS, false, `spec.json changed since create (its sha differs from gf-three.json): the default, ${HIT_LIMITS.MIN_HITS}`);
  let spec = null; try { spec = JSON.parse(bytes.toString('utf8')); } catch { return out(HIT_LIMITS.MIN_HITS, false, 'spec.json is not JSON'); }
  const w = (spec.mechanics ?? []).find(m => m.id === 'waves')?.params ?? {};
  const s = per(w);
  return out(s ?? HIT_LIMITS.MIN_HITS, true, s === null ? `the spec does not set waves hitsPerKill: the default, ${HIT_LIMITS.MIN_HITS}` : Number.isInteger(w.hitsPerKill) ? `the spec sets waves hitsPerKill ${s}` : 'the spec sets waves oneHitKills');
}

/**
 * The two measures from the hits page (pure: tests/k2-waves.test.mjs holds them). m as judgeHits takes it, plus `asked`
 * (hitsAsked). → {read: {ok, detail}: gate C, measure 16, a hit shows on the player's screen; count: {ok, detail}:
 * gate F, measure 39, the hits per kill the spec asks for}
 */
export function judgeHitsSplit(m, L = HIT_LIMITS) {
  if (!m.applies) return { read: { ok: true, detail: m.why }, count: { ok: true, detail: m.why } };
  const asked = m.asked ?? { want: m.oneHit?.config && m.oneHit.asked ? 1 : L.MIN_HITS, config: m.oneHit?.config ? 1 : L.MIN_HITS, locked: !!m.oneHit?.asked, why: m.oneHit?.why ?? '' };
  const want = asked.want;
  const per = m.kills ?? [], med = median(per);
  const perText = per.length ? `${per.join('/')} hit${per.every(n => n === 1) ? '' : 's'} per kill (median ${med})` : 'no kill';
  const unit = m.melee ? 'swing' : 'shot';
  const head = `${m.kills?.length ?? 0} kill${m.kills?.length === 1 ? '' : 's'} by the player in ${m.seconds} s, ${perText}; ${m.hits} hit${m.hits === 1 ? '' : 's'} from ${m.shots} ${unit}${m.shots === 1 ? '' : 's'}`;
  // ---- 39: the hits per kill the spec asks for ----
  const cf = [];
  if (asked.config < want) cf.push(`config/game.json asks for ${asked.config === 1 ? 'one-hit kills (waves oneHitKills or hitsPerKill 1)' : `${asked.config} hits per kill (waves hitsPerKill)`}, but the locked spec asks for ${want} (${asked.why}): set it back`);
  if (per.length && med !== null && med < want) {
    cf.push(`${med === 1 ? '1 hit per kill' : `${med} hits per kill`} (${per.length} kills: ${per.join('/')}), and the spec asks for at least ${want} (${asked.why})${med === 1 ? ': every hit kills, so a player never sees a hit land (the creator: "The zombies are instant killed to I couldn\'t even tell what was happened. There was no healthbar or anything")' : ''}. ` +
      `Keep the weapon's damage below the enemies' hit points so a basic enemy takes ${want}–${Math.max(4, want + 2)} hits (config/game.json → mechanics: projectile damage, or streamDamage for a stream, against waves hp). The kit shows every hit that does not kill (a health bar, a flash, a flinch); never make kills one-shot to make hits visible. Only the spec sets fewer (waves hitsPerKill, or oneHitKills)`);
  }
  const count = cf.length ? { ok: false, detail: `${cf.join('; ')}. Measured: ${head}` }
    : { ok: true, detail: `${head}; the spec asks for at least ${want} hit${want === 1 ? '' : 's'} per kill (${asked.why})${!per.length ? ' (no kill to count: measure 16 says what was seen)' : ''}` };
  // ---- 16: a hit shows on the player's own screen ----
  const rf = [];
  if (!m.enemies) rf.push(`no enemy stood in front of the player in ${m.seconds} s (?gf-demo=waves.hit)`);
  else if (!m.hits) rf.push(m.melee ? `${m.shots} swings at an enemy in reach and none hit it (is waves hittable on; does melee's action match the primary control; does the swing follow the aim?)` : `${m.shots} shots at an enemy under the crosshair and none hit it (is the projectile mechanic's hittable on, and do the rules fire on primary?)`);
  const allKill = per.length > 0 && per.every(n => n === 1);
  const h = m.hit, b = h?.bar;
  if (m.hits && !allKill) {
    if (!h) rf.push('no hit that left the enemy standing was seen on the player\'s screen');
    else {
      const why = [];
      if (!(h.change >= L.CHANGE_MIN)) why.push(`only ${r2(h.change * 100)}% of the enemy's pixels changed (needs ${L.CHANGE_MIN * 100}%; noise ${r2(h.noise * 100)}%)`);
      if (!b) why.push('no health bar over it');
      else {
        if (!b.shown) why.push('its health bar is hidden');
        if (b.w < L.BAR_MIN_W || b.h < L.BAR_MIN_H) why.push(`its health bar is ${r2(b.w)}x${r2(b.h)} px (needs ${L.BAR_MIN_W}x${L.BAR_MIN_H})`);
        if (b.off > L.BAR_NEAR) why.push(`its health bar is ${Math.round(b.off)} px from its head`);
        if (Math.abs((b.frac ?? 1) - h.want) > 0.06) why.push(`its health bar shows ${Math.round((b.frac ?? 0) * 100)}%, it has ${Math.round(h.want * 100)}% left`);
        if (b.fill !== null && b.fill < L.BAR_FILL_MIN) why.push(`the bar's fill is not on the screenshot (${r2(b.fill * 100)}% of its pixels in its colour)`);
      }
      if (why.length) rf.push(`a hit that did not kill did not read: ${why.join('; ')}`);
    }
  }
  if (m.hits && allKill && !m.death) rf.push('every hit killed and no kill was seen go down on the player\'s screen');
  const seen = h ? `a hit that did not kill showed ${b ? `a health bar at ${Math.round((b.frac ?? 0) * 100)}% (${Math.round(b.w)}x${Math.round(b.h)} px over the enemy)` : 'no bar'} and changed ${r2(h.change * 100)}% of the enemy's pixels (noise ${r2(h.noise * 100)}%${h.clip ? `; ${h.clip === 'hit' ? 'the hit clip' : 'a squash'} and a flash` : ''})` : allKill ? 'every hit killed (measure 39 holds the hits per kill to the spec)' : 'no hit left an enemy standing';
  const read = rf.length ? { ok: false, detail: `${rf.join('; ')}. Measured: ${head}; ${seen}` } : { ok: true, detail: `${head}; ${seen}${m.death ? `; ${m.death}` : ''}` };
  return { read, count };
}

/**
 * The verdict from the measurements (pure: tests/k2-waves.test.mjs holds it). m: {applies, why, enemies, shots, hits,
 * kills: [hits per kill], oneHit: {config, asked, why}, hit: {change, noise, bar: {...}, frac, want} | null, death}.
 * Both measures in one (judgeHitsSplit has them apart). → {ok, detail}
 */
export function judgeHits(m, L = HIT_LIMITS) {
  if (!m.applies) return { ok: true, detail: m.why };
  const fails = [];
  const per = m.kills ?? [], med = median(per);
  const perText = per.length ? `${per.join('/')} hit${per.every(n => n === 1) ? '' : 's'} per kill (median ${med})` : 'no kill';
  if (m.oneHit?.config && !m.oneHit.asked) fails.push(`config/game.json sets waves oneHitKills, but the locked spec does not ask for one-hit kills (${m.oneHit.why}): set it back to false`);
  const oneHitOk = !!(m.oneHit?.config && m.oneHit.asked);
  if (!m.enemies) fails.push(`no enemy stood in front of the player in ${m.seconds} s (?gf-demo=waves.hit)`);
  else if (!m.hits) fails.push(m.melee ? `${m.shots} swings at an enemy in reach and none hit it (is waves hittable on; does melee's action match the primary control; does the swing follow the aim?)` : `${m.shots} shots at an enemy under the crosshair and none hit it (is the projectile mechanic's hittable on, and do the rules fire on primary?)`);
  if (per.length && med !== null && med < L.MIN_HITS && !oneHitOk) {
    fails.push(`${med === 1 ? '1 hit per kill' : `${med} hits per kill`} (${per.length} kills: ${per.join('/')}): every hit kills, so a player never sees a hit land (the creator: "The zombies are instant killed to I couldn't even tell what was happened. There was no healthbar or anything"). ` +
      `Keep the weapon's damage below the enemies' hit points so a basic enemy takes 2–4 hits (config/game.json → mechanics: projectile damage, or streamDamage for a stream, against waves hp). The kit shows every hit that does not kill (a health bar, a flash, a flinch); never make kills one-shot to make hits visible. Only a spec that asks for one-hit kills sets waves oneHitKills`);
  }
  if (!oneHitOk && m.hits && (med ?? Infinity) >= L.MIN_HITS) {
    const h = m.hit;
    if (!h) fails.push('no hit that left the enemy standing was seen on the player\'s screen');
    else {
      const why = [];
      if (!(h.change >= L.CHANGE_MIN)) why.push(`only ${r2(h.change * 100)}% of the enemy's pixels changed (needs ${L.CHANGE_MIN * 100}%; noise ${r2(h.noise * 100)}%)`);
      const b = h.bar;
      if (!b) why.push('no health bar over it');
      else {
        if (!b.shown) why.push('its health bar is hidden');
        if (b.w < L.BAR_MIN_W || b.h < L.BAR_MIN_H) why.push(`its health bar is ${r2(b.w)}x${r2(b.h)} px (needs ${L.BAR_MIN_W}x${L.BAR_MIN_H})`);
        if (b.off > L.BAR_NEAR) why.push(`its health bar is ${Math.round(b.off)} px from its head`);
        if (Math.abs((b.frac ?? 1) - h.want) > 0.06) why.push(`its health bar shows ${Math.round((b.frac ?? 0) * 100)}%, it has ${Math.round(h.want * 100)}% left`);
        if (b.fill !== null && b.fill < L.BAR_FILL_MIN) why.push(`the bar's fill is not on the screenshot (${r2(b.fill * 100)}% of its pixels in its colour)`);
      }
      if (why.length) fails.push(`a hit that did not kill did not read: ${why.join('; ')}`);
    }
  }
  const ok = fails.length === 0;
  const h = m.hit, b = h?.bar;
  const seen = h ? `a hit that did not kill showed ${b ? `a health bar at ${Math.round((b.frac ?? 0) * 100)}% (${Math.round(b.w)}x${Math.round(b.h)} px over the enemy)` : 'no bar'} and changed ${r2(h.change * 100)}% of the enemy's pixels (noise ${r2(h.noise * 100)}%${h.clip ? `; ${h.clip === 'hit' ? 'the hit clip' : 'a squash'} and a flash` : ''})` : 'no hit left an enemy standing';
  const unit = m.melee ? 'swing' : 'shot';
  const head = `${m.kills?.length ?? 0} kill${m.kills?.length === 1 ? '' : 's'} by the player in ${m.seconds} s, ${perText}${oneHitOk ? ' (one-hit kills, as the spec asks: waves oneHitKills)' : ''}; ${m.hits} hit${m.hits === 1 ? '' : 's'} from ${m.shots} ${unit}${m.shots === 1 ? '' : 's'}`;
  return { ok, detail: ok ? `${head}; ${seen}${m.death ? `; ${m.death}` : ''}` : `${fails.join('; ')}. Measured: ${head}; ${seen}` };
}

/**
 * Pixel change in a box between the before frames and the after frames (PNG buffers), the pixels that changed between
 * the before frames left out as noise: {noise, change (the most of any after frame), frames, px}. Gate C's general
 * measure (tools/lib/events-check.mjs) reads any event's answer with it; check 16 an enemy's hit.
 */
export const regionChange = (browser, before, after, box, { mime = 'image/png' } = {}) => analyse(browser, before, after, box, null, mime);

/** Pixel change in a box (the enemy) between the before frames (noise) and the after frames; and the bar's fill colour. */
async function analyse(browser, before, after, box, bar, mime = 'image/png') {
  const page = await browser.newPage();
  try {
    return await page.evaluate(async ([B, A, box, bar, T, M]) => {
      const load = async s => { const im = new Image(); im.src = `data:${M};base64,` + s; await im.decode(); const c = new OffscreenCanvas(im.width, im.height); const g = c.getContext('2d'); g.drawImage(im, 0, 0); return { w: im.width, h: im.height, d: g.getImageData(0, 0, im.width, im.height).data }; };
      const bs = []; for (const s of B) bs.push(await load(s));
      const base = bs[bs.length - 1], W = base.w;
      const x0 = Math.max(0, Math.floor(box.x0)), x1 = Math.min(W, Math.ceil(box.x1)), y0 = Math.max(0, Math.floor(box.y0)), y1 = Math.min(base.h, Math.ceil(box.y1));
      const diff = (a, b, i) => Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
      const noise = new Uint8Array(W * base.h); let nN = 0, n = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const k = y * W + x; n++; for (const b of bs.slice(0, -1)) if (diff(b.d, base.d, k * 4) > T) { noise[k] = 1; nN++; break; } }
      const frames = []; let fill = null;
      for (const [i, s] of A.entries()) {
        const a = await load(s); let c = 0;
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const k = y * W + x; if (!noise[k] && diff(a.d, base.d, k * 4) > T) c++; }
        frames.push(c / Math.max(1, n));
        // the bar's fill, drawn: pixels of its left part (what is left) in the fill's colour
        if (i === A.length - 1 && bar && bar.rgb) {
          const fx0 = Math.max(0, Math.round(bar.x + 1)), fx1 = Math.min(W, Math.round(bar.x + Math.max(2, bar.fillW) - 1)), fy0 = Math.max(0, Math.round(bar.y + 2)), fy1 = Math.min(a.h, Math.round(bar.y + bar.h - 2));
          let m = 0, t = 0;
          for (let y = fy0; y < fy1; y++) for (let x = fx0; x < fx1; x++) { const k = (y * W + x) * 4; t++; if (Math.abs(a.d[k] - bar.rgb[0]) + Math.abs(a.d[k + 1] - bar.rgb[1]) + Math.abs(a.d[k + 2] - bar.rgb[2]) < 110) m++; }
          fill = t ? m / t : 0;
        }
      }
      return { noise: nN / Math.max(1, n), change: Math.max(0, ...frames), frames, fill, px: n };
    }, [before.map(b => b.toString('base64')), after.map(b => b.toString('base64')), box, bar, HIT_LIMITS.PIXEL_T, mime]);
  } finally { await page.close(); }
}

/**
 * Check 16. newPage(label, {overrides}) → {ctx, page, errors} (verify's own); browser: for the pixel analysis; url: the
 * served game; game: config/game.json; dir: the game folder (its spec.json); shot(page, name, buf?): evidence.
 * → {ok, detail, record, warnings}
 */
export async function checkHits({ newPage, browser, url, game, dir, shot = async () => null, log = () => {}, stepped = true }) {
  const L = HIT_LIMITS, t0 = Date.now(), warnings = [];
  const mech = game.mechanics ?? [];
  const waves = mech.find(m => m.id === 'waves'), prj = mech.find(m => m.id === 'projectile'), melee = mech.find(m => m.id === 'melee');
  const m = { applies: !!(waves && (prj || melee)), why: !waves ? 'no enemies (no waves mechanic): nothing to hit' : 'enemies are not shot at or struck (no projectile or melee mechanic): nothing for the player to hit', seconds: 0, enemies: 0, shots: 0, hits: 0, kills: [], hit: null, death: null };
  if (!m.applies) { const j = judgeHits(m, L), s = judgeHitsSplit(m, L); return { ok: j.ok, detail: j.detail, read: s.read, count: s.count, warnings, record: { applies: false } }; }
  m.oneHit = { config: waves.params?.oneHitKills === true, ...(await oneHitAsked(dir)) };
  m.asked = await hitsAsked(dir, waves.params ?? {});
  // melee: when the game swings on primary (or has no projectile at all)
  const useMelee = !!melee && (!prj || (melee.params?.action ?? 'primary') === 'primary');
  m.melee = useMelee;
  const stream = !useMelee && (prj.params?.kind ?? 'discrete') === 'continuous';
  const WPN = useMelee ? (() => { const ws = normalizeWeapons(melee.params?.weapons); return ws.find(w => w.id === melee.params?.weapon) ?? ws[0]; })() : null;
  const reach = WPN ? WPN.combo[0].reach : 0;
  const cooldown = useMelee ? Math.max(0.3, WPN.combo[0].windup + WPN.combo[0].active + WPN.combo[0].recover * 0.5) : Math.max(0.12, Number(prj.params?.cooldown ?? 0.45));
  const mode = game.camera ?? 'third';
  const cam = { ...RIG[mode] ?? RIG.third, ...(game.controller?.camera?.[mode] ?? {}) };
  const T = await newPage('hits', { overrides: { patches: [{ file: 'config/game.json', pointer: '/round/seconds', value: 180 }] } });
  const p = T.page;
  const obs = () => p.evaluate(OBS);
  const png = () => p.screenshot({ type: 'png' });
  const vp = p.viewportSize() ?? { width: 1280, height: 720 }, cursor = { x: Math.round(vp.width / 2), y: Math.round(vp.height * 0.55) };
  // (under an emulated lock the cursor goes back to the middle before it would leave the screen: tools/lib/lock.mjs)
  const look = (dx, dy) => turnBy(p, cursor, dx, dy);
  const record = { url: `?seed=7&bots=0&gf-demo=waves.hit`, limits: L, camera: mode, stream, cooldown, melee: useMelee ? { weapon: WPN.id, reach } : null, shotsLog: [], measured: [] };
  let F = null, R = null;                                          // camera-relative W and D on the ground (melee walks)
  let me = null, clock = null;
  try {
    // stepped time when the game's kit offers it (tools/lib/stepped.mjs): every wait below is the game's time
    if (stepped) await prepareStepped(p);
    await p.goto(stepped ? stepUrl(`${url}?seed=7&bots=0&gf-demo=waves.hit`) : `${url}?seed=7&bots=0&gf-demo=waves.hit`, { waitUntil: 'load' });
    for (let t = Date.now(); (await p.evaluate(() => window.__game?.phase ?? null).catch(() => null)) !== 'lobby'; ) { if (Date.now() - t > 90000) throw new Error('no lobby in 90 s'); await sleep(200); }
    const play = await p.locator('#gf-play').boundingBox().catch(() => null);
    if (play) await p.mouse.click(play.x + play.width / 2, play.y + play.height / 2); else await p.keyboard.press('Enter');
    clock = await clockFor(p, { real: !stepped });
    record.clock = clock.stepped ? 'stepped' : 'wall';
    for (let t = clock.now(); (await p.evaluate(() => window.__game?.phase ?? null).catch(() => null)) !== 'playing'; ) { if (clock.now() - t > 20000) throw new Error('the round did not start'); await clock.wait(120); }
    await clock.wait(1400);                                         // the "Go!" banner
    await p.mouse.move(cursor.x, cursor.y); await p.mouse.click(cursor.x, cursor.y); await mouseTaken(p); await clock.wait(350);   // takes the mouse
    const tStart = clock.now();
    let aimTries = 0;
    while (clock.now() - tStart < L.SECONDS * 1000) {
      const o = await obs();
      if (!o || o.phase !== 'playing') { warnings.push(`hits: the round left play (${o?.phase ?? 'no observation'})`); break; }
      me = o.me;
      const W = o.view.w, H = o.view.h;
      const mine = (o.w?.kills ?? []).filter(k => k.from === me.id);
      if (mine.length >= L.KILLS) break;
      const e = (o.w?.enemies ?? []).filter(x => x.hp > 0 && x.body).sort((a, b) => Math.hypot(a.x - me.x, a.z - me.z) - Math.hypot(b.x - me.x, b.z - me.z))[0];
      if (!e) { await clock.wait(150); continue; }
      m.enemies = Math.max(m.enemies, 1);
      // aim: the follow camera aims with the cursor itself (CONTRACT §8): the mouse goes onto the enemy's body; else the
      // enemy's body under the crosshair (the mouse turns the camera; pointer lock reads the movement)
      const f = (H / 2) / Math.tan((cam.fov * Math.PI / 180) / 2), off = [e.body.x - W / 2, e.body.y - H / 2];
      // (orbit, CONTRACT §9: the cursor aims there too, and the camera turns only on a drag, so it is never turned here)
      if (mode === 'follow' || mode === 'orbit') { if (e.body.front) { cursor.x = e.body.x; cursor.y = e.body.y; await p.mouse.move(cursor.x, cursor.y); } }
      // (a swing covers an arc: it needs the enemy roughly ahead, not under the crosshair to the pixel)
      else if (mode !== 'top' && cam.sensitivity > 0 && (!e.body.front || Math.hypot(off[0], useMelee ? 0 : off[1]) > (useMelee ? 48 : L.AIM_PX)) && aimTries < 40) {
        aimTries++;
        const dx = e.body.front ? Math.atan(off[0] / f) / cam.sensitivity : 600, dy = e.body.front ? Math.atan(off[1] / f) / cam.sensitivity : 0;
        await look(dx * 0.9, dy * 0.9); await clock.wait(90);
        F = null;                                                  // the camera turned: W and D point elsewhere now
        continue;
      }
      aimTries = 0;
      // melee: walk up to it with real keys (camera-relative), into the first swing's reach
      if (useMelee) {
        const d = Math.hypot(e.x - me.x, e.z - me.z);
        if (d > reach * 0.78) {
          if (mode !== 'follow' && mode !== 'top' && mode !== 'orbit') { await p.keyboard.down('KeyW'); await clock.wait(Math.min(260, 60 + (d - reach * 0.7) * 90)); await p.keyboard.up('KeyW'); await clock.wait(60); continue; }
          if (!F) { const k = await calibrate(p, obs, clock); if (!k) { warnings.push('hits: the player did not move on W or D'); break; } F = k.F; R = k.R; continue; }
          await walkToward(p, F, R, e.x - me.x, e.z - me.z, Math.min(260, 60 + (d - reach * 0.7) * 90), clock); await clock.wait(60);
          continue;
        }
      }
      // a hit to measure from the player's own screen: frames before, the shot, frames after
      const measure = !m.hit;
      const before = measure ? [await png(), (await clock.wait(120), await png())] : [];
      const hp0 = e.hp, id = e.id;
      m.shots++;
      if (stream) await p.mouse.down();
      else { await p.mouse.down(); await clock.wait(70); await p.mouse.up(); }
      // a swing hits in its active frames, after its windup
      // wait for the hit: the enemy's hit points drop (it stands: a hit to measure) or it is gone (a kill)
      let after = null, outcome = 'miss', o2 = null;
      for (let t = clock.now(); clock.now() - t < (stream ? 1600 : useMelee ? 1100 : 900); ) {
        o2 = await obs();
        const now = (o2?.w?.enemies ?? []).find(x => x.id === id);
        if (now && now.hp < hp0 - 1e-6) { outcome = 'hit'; if (measure) after = [await png(), (await clock.pass(70), await png()), (await clock.wait(60), await clock.pass(70), await png())]; break; }
        if (!now) { outcome = (o2?.w?.kills ?? []).some(k => k.id === id) ? 'kill' : 'gone'; break; }
        await clock.wait(25);
      }
      if (stream) await p.mouse.up();
      record.shotsLog.push({ enemy: id, hp: hp0, outcome });
      if (outcome !== 'miss') m.hits++;
      if (outcome === 'hit' && after && !m.hit) {
        const now = (o2.w.enemies ?? []).find(x => x.id === id);
        const bar = await p.evaluate(BAR, id).catch(() => null);
        const head = now?.head ?? e.head, feet = now?.feet ?? e.feet;
        const hgt = Math.max(30, (feet?.y ?? H / 2) - (head?.y ?? H / 2));
        const cx = ((head?.x ?? W / 2) + (feet?.x ?? W / 2)) / 2;
        const box = { x0: cx - Math.max(40, hgt * 0.55), x1: cx + Math.max(40, hgt * 0.55), y0: (head?.y ?? 0) - 26, y1: (feet?.y ?? H) + 8 };
        const rgb = bar?.color ? (bar.color.match(/\d+(\.\d+)?/g) ?? []).slice(0, 3).map(Number) : null;
        const a = await analyse(browser, before, after, box, bar ? { ...bar, rgb } : null);
        const want = now ? now.hp / Math.max(1e-6, now.max) : 0;
        m.hit = { change: a.change, noise: a.noise, frames: a.frames.map(r2), want: r2(want), clip: o2.w.lastHit?.clip ?? null, box: Object.fromEntries(Object.entries(box).map(([k, v]) => [k, Math.round(v)])),
          bar: bar ? { shown: bar.shown, w: r2(bar.w), h: r2(bar.h), frac: bar.frac, off: head ? Math.hypot(bar.x + bar.w / 2 - head.x, bar.y + bar.h - head.y) : 0, fill: a.fill } : null };
        await shot(p, 'hits-hit', after[0]);
      }
      if (outcome === 'kill' && !m.death) {
        await clock.wait(450); const img = await png(); await shot(p, 'hits-death', img);
        const o3 = await obs();
        m.death = `a kill went down where it stood (${o3?.w?.dying ?? 0} body falling 0.45 s after; deathSeconds ${waves.params?.deathSeconds ?? 1.6})`;
      }
      await clock.wait(Math.max(0, cooldown * 1000 - 40));
    }
    const o = await obs();
    m.seconds = Math.round((clock.now() - tStart) / 1000);
    const mine = (o?.w?.kills ?? []).filter(k => k.from === (me?.id ?? o?.me?.id));
    m.kills = mine.map(k => k.hits);
    record.kills = mine; record.lastHit = o?.w?.lastHit ?? null;
    if (!o?.w) warnings.push('hits: the waves mechanic shows no stats (an older kit?): upgrade the game');
    if (o && !o.locked) warnings.push('hits: the page did not take the mouse (no pointer lock)');
  } catch (e) {
    warnings.push(`hits page stopped: ${e.message}`);
    m.seconds = Math.round((Date.now() - t0) / 1000);
  } finally {
    const errors = T.errors.slice();
    await T.ctx.close().catch(() => {});
    if (errors.length) warnings.push(`hits page console errors: ${[...new Set(errors)].slice(0, 2).join(' | ')}`);
  }
  const j = judgeHits(m, L), s = judgeHitsSplit(m, L);
  record.measured = { ...m };
  record.seconds = Math.round((Date.now() - t0) / 1000);
  log(`  hits: read ${s.read.ok ? 'ok' : 'FAIL'}, per kill ${s.count.ok ? 'ok' : 'FAIL'}: ${j.detail.slice(0, 200)}`);
  return { ok: s.read.ok && s.count.ok, detail: j.detail, read: s.read, count: s.count, warnings, record };
}

// ---------------------------------------------------------------------------------------------------------------------
// Walking with real keys (shared with checks 13 and 15: controls-check.mjs, alive-check.mjs)
// ---------------------------------------------------------------------------------------------------------------------

/** Which way W and D move the local player on the ground now (the camera does not turn while measuring): {F, R} or null. */
export async function calibrate(p, obs, clock = wallClock()) {
  const at = async () => { const o = await obs(); return o?.me ?? null; };
  const step = async k => { const a = await at(); await p.keyboard.down(k); await clock.wait(200); await p.keyboard.up(k); await clock.wait(220); const b = await at(); if (!a || !b) return null; const dx = b.x - a.x, dz = b.z - a.z, l = Math.hypot(dx, dz); return l > 0.05 ? [dx / l, dz / l] : null; };
  const F = await step('KeyW'), R = await step('KeyD');
  return F && R ? { F, R } : null;
}
/** Hold the keys that move the player toward (dx, dz) for `ms`. */
export async function walkToward(p, F, R, dx, dz, ms = 160, clock = wallClock()) {
  const l = Math.hypot(dx, dz) || 1, ux = dx / l, uz = dz / l;
  const pf = ux * F[0] + uz * F[1], pr = ux * R[0] + uz * R[1], keys = [];
  if (pf > 0.38) keys.push('KeyW'); if (pf < -0.38) keys.push('KeyS'); if (pr > 0.38) keys.push('KeyD'); if (pr < -0.38) keys.push('KeyA');
  for (const k of keys) await p.keyboard.down(k);
  await clock.wait(ms);
  for (const k of keys) await p.keyboard.up(k);
  return keys;
}
