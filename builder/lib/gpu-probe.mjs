// Run as its own process by `doctor`: open the browser headless, ask WebGL which renderer it got, print one JSON line.
// A child process so a browser that hangs can be stopped as a tree by the caller.
import { launchChrome } from '../qa/browser.mjs';

const out = v => process.stdout.write(JSON.stringify(v) + '\n');
try {
  const { loadChromium } = await import('../qa/browser.mjs');
  const chromium = await loadChromium();
  const browser = await launchChrome({ chromium });
  try {
    const page = await browser.newPage();
    const info = await page.evaluate(() => {
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl2') || c.getContext('webgl');
      if (!gl) return { webgl: false };
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      return { webgl: true, renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER), webgpu: !!navigator.gpu };
    });
    out({ ok: true, ...info });
  } finally { await browser.close().catch(() => {}); }
} catch (e) {
  out({ ok: false, error: String(e.message ?? e).split('\n')[0] });
}
