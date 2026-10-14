// verify check 31: sharp on every screen (CONTRACT §6i; the creator, 2026-10-09: "Different screen sizes make the game
// look bad. I just tested a smaller screen size and the game looks very fuzzy ... How can we fix this for all our
// games"). The game is opened on a phone, a tablet, a laptop and a sharp (2×) laptop, and one page is then zoomed to
// 150%, switched to a phone in the browser's device mode and back, the way a player or the creator does. Each time
// the game's biggest canvas must draw the screen's real pixels (its CSS size × devicePixelRatio), lowered only as far
// as the kit's pixel budget for that screen allows (kit/core/resolution.js: high 8.3 MP, low 3.2 MP on touch screens).
// It measures the canvas itself, so it judges any game, on any runtime. Before the fix a phone drew 33% of its
// pixels (the low tier's fixed pixelRatio of 1) and a zoom after loading kept the old ratio (67% at 150%).
//
//   checkScreens({ browser, url, log }) → { ok, detail, record, warnings }
import { pixelRatioFor, PIXEL_BUDGET } from '../../../runtimes/three/kit/core/resolution.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
export const SCREENS = [
  { id: 'phone', label: 'a phone (390×844 at 3×)', viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
  { id: 'tablet', label: 'a tablet (820×1180 at 2×)', viewport: { width: 820, height: 1180 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  { id: 'laptop', label: 'a laptop (1366×768 at 1×)', viewport: { width: 1366, height: 768 }, deviceScaleFactor: 1 },
  { id: 'retina', label: 'a sharp laptop (1440×900 at 2×)', viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 },
];
// on the laptop page, after it loaded: what a zoom, the browser's device mode and going back do
export const CHANGES = [
  { id: 'zoom', label: 'the browser zoomed to 150%', metrics: { width: 911, height: 512, deviceScaleFactor: 1.5, mobile: false } },
  { id: 'device', label: 'the browser\'s device mode: a phone', metrics: { width: 390, height: 844, deviceScaleFactor: 3, mobile: true } },
  { id: 'back', label: 'back to the laptop', metrics: { width: 1366, height: 768, deviceScaleFactor: 1, mobile: false } },
];
const SLACK = 0.98;          // rounding of the buffer to whole pixels

/** The biggest canvas on the page or in its frames: CSS size, drawing buffer, devicePixelRatio; and the kit's own report. */
async function measure(p) {
  const all = [];
  for (const f of p.frames()) {
    const c = await f.evaluate(() => [...document.querySelectorAll('canvas')].map(c => { const b = c.getBoundingClientRect(); return { w: c.width, h: c.height, cw: b.width, ch: b.height, dpr: devicePixelRatio, report: window.__game?.screen?.() ?? null }; })).catch(() => []);
    all.push(...c);
  }
  return all.filter(c => c.cw > 0 && c.ch > 0).sort((a, b) => b.cw * b.ch - a.cw * a.ch)[0] ?? null;
}

/** What a screen must get: the share of its real pixels (linear) the kit's budget allows, touch screens on the low one. */
export function needFor({ cssW, cssH, dpr, touch }) {
  const budget = touch ? PIXEL_BUDGET.low : PIXEL_BUDGET.high;
  const ratio = pixelRatioFor({ dpr, width: cssW, height: cssH, budget });
  return { ratio, share: Math.min(1, ratio / dpr), budget };
}

function judge(label, c, touch) {
  if (!c) return { label, ok: false, why: 'no canvas on the page' };
  const need = needFor({ cssW: c.cw, cssH: c.ch, dpr: c.dpr, touch });
  const share = c.w / (c.cw * c.dpr);
  const ok = share >= need.share * SLACK;
  const pct = v => `${Math.round(v * 100)}%`;
  return { label, ok, share: Math.round(share * 1000) / 1000, need: Math.round(need.share * 1000) / 1000, css: [Math.round(c.cw), Math.round(c.ch)], buffer: [c.w, c.h], dpr: c.dpr, report: c.report,
    why: `draws ${pct(share)} of the screen's real pixels (${c.w}×${c.h} of ${Math.round(c.cw * c.dpr)}×${Math.round(c.ch * c.dpr)})${ok ? '' : `; needs ${pct(need.share)}`}` };
}

export async function checkScreens({ browser, url, log = () => {} }) {
  const results = [], warnings = [];
  const page = async (o) => {
    const ctx = await browser.newContext({ viewport: o.viewport, deviceScaleFactor: o.deviceScaleFactor, isMobile: !!o.isMobile, hasTouch: !!o.hasTouch });
    const p = await ctx.newPage();
    await p.goto(`${url}${url.includes('?') ? '&' : '?'}seed=7`, { waitUntil: 'load' });
    for (const t0 = Date.now(); !(await p.evaluate(() => window.__game?.ready === true).catch(() => false));) { if (Date.now() - t0 > 120000) throw new Error('the game did not boot in 120 s'); await sleep(300); }
    await sleep(800);
    return { ctx, p };
  };
  try {
    for (const s of SCREENS) {
      const { ctx, p } = await page(s);
      try { const r = judge(s.label, await measure(p), !!s.hasTouch); results.push({ id: s.id, ...r }); log(`  ${r.ok ? 'ok  ' : 'FAIL'} ${s.label}: ${r.why}`); }
      finally { await ctx.close().catch(() => {}); }
    }
    // one page through a zoom, the browser's device mode and back: the drawing follows the screen without a reload
    const laptop = SCREENS.find(s => s.id === 'laptop');
    const { ctx, p } = await page(laptop);
    try {
      const cdp = await ctx.newCDPSession(p);
      for (const ch of CHANGES) {
        await cdp.send('Emulation.setDeviceMetricsOverride', ch.metrics);
        await sleep(1200);
        const r = judge(`${ch.label}, after loading`, await measure(p), !!ch.metrics.mobile);
        results.push({ id: ch.id, ...r }); log(`  ${r.ok ? 'ok  ' : 'FAIL'} ${r.label}: ${r.why}`);
      }
    } finally { await ctx.close().catch(() => {}); }
  } catch (e) { results.push({ id: 'run', label: 'the screens run', ok: false, why: e.message.split('\n')[0] }); }
  const fail = results.filter(r => !r.ok);
  const ok = results.length === SCREENS.length + CHANGES.length && !fail.length;
  const short = r => `${r.id} ${r.share !== undefined ? `${Math.round(r.share * 100)}%` : '?'}`;
  const detail = ok ? `the screen's real pixels on every screen: ${results.map(short).join(', ')} (zoomed, device mode and back without a reload)`
    : `${fail.map(r => `${r.label}: ${r.why}`).join('; ')}. The kit draws the screen's real pixels within its budget and follows zoom and resizes (kit/core/resolution.js); a game on an older kit gets it from node builder/tools/create.mjs <game>/spec.json <game>`;
  return { ok, detail, record: { results }, warnings };
}
