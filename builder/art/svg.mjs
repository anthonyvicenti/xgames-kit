// SVG written by a session (or given by a person) → a PNG, through the browser the kit already uses for verify.
// The SVG is treated as untrusted data: it is refused when it could run script, load anything from outside itself or
// depend on a font this machine may not have, and it is drawn with scripting off and the network cut.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { decodePng } from './png.mjs';

const BROWSER = pathToFileURL(path.resolve(import.meta.dirname, '../../qa/browser.mjs')).href;

/** What is wrong with an SVG, as plain sentences ([] when it is fine). `box` is the [width, height] asked for. */
export function svgProblems(svg, { box = null } = {}) {
  const out = [];
  if (typeof svg !== 'string' || !/<svg[\s/>]/i.test(svg)) return ['not an SVG: it must be one <svg …>…</svg> document'];
  if (svg.length > 400_000) out.push(`the SVG is ${svg.length} characters; keep it under 400000`);
  const refuse = [
    [/<script[\s/>]/i, 'no <script>'], [/\son[a-z]+\s*=/i, 'no event attributes (onload, onclick, …)'], [/<foreignObject[\s/>]/i, 'no <foreignObject>'],
    [/<image[\s/>]/i, 'no <image>: draw with shapes, not embedded pictures'], [/<(text|tspan|textPath)[\s/>]/i, 'no <text>: fonts differ between machines; draw letters as paths or leave them out'],
    [/<(iframe|object|embed|audio|video|animate|animateTransform|animateMotion|set)[\s/>]/i, 'no animation or embedded content: one still picture'],
    [/@import|@font-face/i, 'no @import or @font-face'], [/<!ENTITY|<!DOCTYPE/i, 'no DOCTYPE or entities'], [/javascript:/i, 'no javascript: links'],
  ];
  for (const [re, why] of refuse) if (re.test(svg)) out.push(why);
  for (const m of svg.matchAll(/(?:xlink:href|href|src)\s*=\s*["']([^"']*)["']/gi)) if (!m[1].startsWith('#')) { out.push(`a link to ${JSON.stringify(m[1].slice(0, 40))}: only links to parts of this SVG (#id) are allowed`); break; }
  for (const m of svg.matchAll(/url\(\s*["']?([^"')]*)/gi)) if (!m[1].startsWith('#')) { out.push(`url(${m[1].slice(0, 40)}): only url(#id) is allowed`); break; }
  const vb = /<svg[^>]*\sviewBox\s*=\s*["']\s*([-\d.e]+)[\s,]+([-\d.e]+)[\s,]+([-\d.e]+)[\s,]+([-\d.e]+)\s*["']/i.exec(svg);
  if (!vb) out.push('the <svg> element needs a viewBox');
  else if (box) {
    const [, x, y, w, h] = vb.map(Number);
    if (x !== 0 || y !== 0 || w !== box[0] || h !== box[1]) out.push(`viewBox is "${vb.slice(1).join(' ')}"; the request asked for "0 0 ${box[0]} ${box[1]}"`);
  }
  return out;
}

/**
 * Draw checked SVGs to RGBA pictures at exactly width x height, see-through where nothing is drawn. One browser for
 * the whole list. jobs: [{ svg, width, height }] → [{ width, height, data }]
 */
export async function rasteriseSvgs(jobs, { launch = null } = {}) {
  let browser;
  if (launch) browser = await launch();
  else {
    const { launchChrome, loadChromium } = await import(BROWSER);
    browser = await launchChrome({ chromium: await loadChromium() });
  }
  try {
    const context = await browser.newContext({ javaScriptEnabled: false, offline: true, deviceScaleFactor: 1, viewport: { width: 64, height: 64 } });
    await context.route('**/*', route => route.abort());
    const page = await context.newPage();
    const out = [];
    for (const { svg, width, height } of jobs) {
      await page.setViewportSize({ width, height });
      // the size asked for wins over whatever width and height the SVG itself carries
      const sized = svg.replace(/<svg([^>]*)>/i, (m, attrs) => `<svg${attrs.replace(/\s(width|height|style|preserveAspectRatio)\s*=\s*(["'])[^"']*\2/gi, '')} width="${width}" height="${height}" preserveAspectRatio="none" style="display:block">`);
      await page.setContent(`<!doctype html><html><head><style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}</style></head><body>${sized}</body></html>`, { waitUntil: 'load' });
      const png = await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width, height }, type: 'png' });
      out.push(decodePng(png));
    }
    await context.close();
    return out;
  } finally { await browser.close().catch(() => {}); }
}

export const rasteriseSvg = async (svg, width, height, options) => (await rasteriseSvgs([{ svg, width, height }], options))[0];
