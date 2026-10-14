// gf-vista: the WebGPU probe and the kit's screen for a browser without it (research/super-scenic/PLAN.md §1.3: WebGPU
// only, never a blank canvas). Its own module with no import, so a page can probe and show the screen before it loads
// the core (whose modules may name WebGPU's globals as they load, which a browser without WebGPU does not have): the
// game's boot (gf/three/core/boot-vista.js) imports this first and the core only once the probe says yes. host.js
// re-exports all of it, so its callers are unchanged.

export class NoWebGPU extends Error { constructor(m, kind = 'missing') { super(m); this.name = 'NoWebGPU'; this.kind = kind; } }

/**
 * The adapter limits the core's pipelines really use, above WebGPU's defaults (16 and 4). Measured 2026-10-12 by booting
 * the core under capped limits (research/super-scenic/evidence/gpu-limits-2026-10-12/): with 24 sampled textures a
 * fragment stage needs 31, with 4 storage textures a compute stage needs 5. An adapter below these builds no pipelines
 * (the Intel Arrow Lake iGPU on Linux reports exactly the defaults), so it gets the kit's screen, not a blank canvas.
 */
export const MIN_LIMITS = { maxSampledTexturesPerShaderStage: 31, maxStorageTexturesPerShaderStage: 5 };

/** A hardware WebGPU adapter the core can run on, or the reason there is none. → {ok, why?, kind?, info?} */
export async function probeWebGPU() {
  if (!globalThis.navigator?.gpu) return { ok: false, kind: 'missing', why: 'this browser has no WebGPU (navigator.gpu is missing)' };
  const a = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }).catch(e => null);
  if (!a) return { ok: false, kind: 'adapter', why: 'no WebGPU adapter (the GPU or its driver is not supported, or WebGPU is turned off)' };
  const info = a.info ?? {};
  const about = { vendor: info.vendor, architecture: info.architecture, description: info.description };
  if (info.isFallbackAdapter) return { ok: false, kind: 'software', why: 'only a software WebGPU adapter, far too slow for this game', info: about };
  const short = Object.entries(MIN_LIMITS).filter(([k, v]) => !(a.limits[k] >= v)).map(([k, v]) => `${k} ${a.limits[k]} < ${v}`);
  if (short.length) return { ok: false, kind: 'limits', why: `this graphics chip's WebGPU limits are below what the game needs (${short.join(', ')})`, info: about };
  return { ok: true, info: about };
}

/** The kit's screen for a browser without WebGPU: the game's link to open elsewhere, never a blank canvas. */
export function noWebGPUScreen(why, { title = document.title, link = location.href, kind = 'missing' } = {}) {
  const el = document.createElement('div');
  el.id = 'gf-vista-nowebgpu';
  el.setAttribute('role', 'alert');
  el.style.cssText = 'position:fixed;inset:0;display:grid;place-items:center;background:#0b1620;color:#e8f2f8;font:16px/1.5 system-ui,sans-serif;z-index:1000;padding:24px;text-align:center';
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  el.innerHTML = `<div style="max-width:520px"><h1 style="font-size:24px;margin:0 0 12px">${esc(title)} needs ${kind === 'limits' || kind === 'software' ? 'a stronger graphics chip' : 'WebGPU'}</h1>
    <p style="margin:0 0 16px;opacity:.85">Open this game in a browser with WebGPU on a computer with a graphics card: a recent Chrome or Edge, or Safari 26 on a Mac.</p>
    <p style="margin:0 0 20px"><a href="${esc(link)}" style="color:#7fd3ff;word-break:break-all">${esc(link)}</a></p>
    <button type="button" style="font:inherit;padding:8px 16px;border-radius:8px;border:1px solid #7fd3ff;background:none;color:#7fd3ff;cursor:pointer">Copy link</button>
    <p style="margin:16px 0 0;font-size:13px;opacity:.6">${esc(why)}</p></div>`;
  el.querySelector('button').onclick = () => navigator.clipboard?.writeText(link);
  document.body.append(el);
  return el;
}

