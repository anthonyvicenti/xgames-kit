// A browser for verify and play on Windows, macOS and Linux. Finding an installed Chrome, Chromium or Edge is the
// tools' own job now (kits' builder/qa/browser.mjs: CHROME_PATH, the usual places per system, then PATH); what this module adds
// is the last resort they do not have: Playwright's own Chromium, downloaded once on demand with a clear message.
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { findChrome } from '../qa/browser.mjs';

export { chromeCandidates, findChrome, onPath } from '../qa/browser.mjs';

/** Playwright's own Chromium for the pinned playwright-core: { path, installed } */
export async function playwrightChromium() {
  const { chromium } = await import('playwright-core');
  let p = null;
  try { p = chromium.executablePath(); } catch {}
  return { path: p, installed: !!p && existsSync(p) };
}

/**
 * Make sure there is a browser for verify and play, and point CHROME_PATH at it. Never throws for a missing browser
 * when it can install one; returns { path, kind, source } or throws with what to do.
 */
export async function ensureBrowser({ log = console.error, install = true, env = process.env } = {}) {
  const found = findChrome({ env });
  if (found) { env.CHROME_PATH = found.path; return found; }
  const pw = await playwrightChromium();
  if (pw.installed) { env.CHROME_PATH = pw.path; return { path: pw.path, kind: 'chromium', source: 'playwright' }; }
  if (!install) throw new Error('No Chrome or Edge found, and Playwright\'s Chromium is not installed. Install Google Chrome, or run: npx playwright-core install chromium');
  log('gamesfun: no Chrome or Edge found (set CHROME_PATH to use another). Downloading Playwright\'s Chromium once (about 170 MB) into its cache…');
  const cli = createRequire(import.meta.url).resolve('playwright-core/cli.js');
  const r = spawnSync(process.execPath, [cli, 'install', 'chromium'], { stdio: 'inherit', windowsHide: true });
  const after = await playwrightChromium();
  if (r.status !== 0 || !after.installed) {
    throw new Error(`Could not install Playwright's Chromium (exit ${r.status}). Install Google Chrome, or run: npx playwright-core install chromium${process.platform === 'linux' ? ' (on Linux it may also need: npx playwright-core install-deps chromium)' : ''}`);
  }
  env.CHROME_PATH = after.path;
  log(`gamesfun: using Playwright's Chromium at ${after.path}`);
  return { path: after.path, kind: 'chromium', source: 'playwright (installed now)' };
}
