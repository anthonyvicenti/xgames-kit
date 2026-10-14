// Path handling that must behave the same on Windows, macOS and Linux. Windows rules are checked here with path.win32,
// so a Linux or macOS run still proves them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { isInside, resolveInside, toPosix } from '../builder/lib/paths.mjs';
import { chromeCandidates, findChrome, onPath } from '../builder/lib/chrome.mjs';
import { openCommand } from '../builder/lib/open.mjs';

const W = path.win32, P = path.posix;
const WBASE = 'C:\\Users\\Ada Lovelace\\gamesfun-kit\\games\\demo';
const PBASE = '/home/ada/gamesfun-kit/games/demo';

test('resolveInside maps ordinary URL paths into the folder (posix and win32)', () => {
  assert.equal(resolveInside(PBASE, '/index.html', P), `${PBASE}/index.html`);
  assert.equal(resolveInside(PBASE, '/gf/three/core/boot.js', P), `${PBASE}/gf/three/core/boot.js`);
  assert.equal(resolveInside(PBASE, '/', P), PBASE);
  assert.equal(resolveInside(PBASE, '/assets/models/my%20ball.glb', P), `${PBASE}/assets/models/my ball.glb`);
  assert.equal(resolveInside(WBASE, '/gf/three/core/boot.js', W), `${WBASE}\\gf\\three\\core\\boot.js`);
  assert.equal(resolveInside(WBASE, '//vendor///three/build/three.module.js', W), `${WBASE}\\vendor\\three\\build\\three.module.js`);
});

const ATTACKS = [
  '/../package.json', '/a/../../x', '/%2e%2e/package.json', '/%2E%2E/%2E%2E/x', '/..%2fpackage.json', '/..%5cpackage.json',
  '/a%5c..%5c..%5cx', '/%5c%5cserver%5cshare', '/C:/Windows/win.ini', '/c:%5cwindows', '/file.txt::$DATA', '/a:b',
  '/con', '/CON.txt', '/nul', '/aux.json', '/com1', '/lpt9.log', '/index.html.', '/index.html%20', '/.env', '/.git/config',
  '/a/.hidden/b', '/%00', '/a%00.js', '/%', '/a/%zz', '/what%3F', '/a<b', '/a%7Cb',
];

test('resolveInside refuses traversal and Windows tricks on both platforms', () => {
  for (const a of ATTACKS) {
    assert.equal(resolveInside(PBASE, a, P), null, `posix: ${a}`);
    assert.equal(resolveInside(WBASE, a, W), null, `win32: ${a}`);
  }
});

test('isInside works with Windows paths, drive letters and UNC shares', () => {
  assert.equal(isInside('C:\\kit\\games', 'C:\\kit\\games\\demo\\rules.js', W), true);
  assert.equal(isInside('C:\\kit\\games', 'C:\\kit\\games', W), true);
  assert.equal(isInside('C:\\kit\\games', 'C:\\kit\\games-evil\\x', W), false);
  assert.equal(isInside('C:\\kit\\games', 'D:\\kit\\games\\x', W), false);
  assert.equal(isInside('C:\\kit\\games', '\\\\server\\share\\x', W), false);
  assert.equal(isInside('/kit/games', '/kit/games-evil/x', P), false);
});

test('toPosix always gives forward slashes', () => {
  assert.equal(toPosix('games\\demo\\rules.js'), 'games/demo/rules.js');
  assert.equal(toPosix('games/demo'), 'games/demo');
});

test('Chrome candidates per platform: Chrome, then Edge, in the usual install places', () => {
  const win = chromeCandidates({ platform: 'win32', env: { PROGRAMFILES: 'C:\\Program Files', 'PROGRAMFILES(X86)': 'C:\\Program Files (x86)', LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' }, home: 'C:\\Users\\a' });
  assert.equal(win[0].path, 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
  assert.ok(win.some(c => c.path === 'C:\\Users\\a\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe'));
  assert.ok(win.some(c => c.kind === 'edge' && c.path.endsWith('Microsoft\\Edge\\Application\\msedge.exe')));
  const mac = chromeCandidates({ platform: 'darwin', env: {}, home: '/Users/a' });
  assert.equal(mac[0].path, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  assert.ok(mac.some(c => c.path === '/Users/a/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'));
  assert.ok(mac.some(c => c.kind === 'edge'));
  const lin = chromeCandidates({ platform: 'linux', env: {}, home: '/home/a' });
  assert.equal(lin[0].path, '/usr/bin/google-chrome');
});

test('findChrome prefers CHROME_PATH, then installed browsers, then PATH', () => {
  const has = set => p => set.has(p);
  assert.equal(findChrome({ platform: 'linux', env: { CHROME_PATH: '/opt/c/chrome' }, home: '/h', exists: has(new Set(['/opt/c/chrome', '/usr/bin/google-chrome'])) }).source, 'CHROME_PATH');
  const edge = findChrome({ platform: 'win32', env: { 'PROGRAMFILES(X86)': 'C:\\PF86' }, home: 'C:\\Users\\a', exists: has(new Set(['C:\\PF86\\Microsoft\\Edge\\Application\\msedge.exe'])) });
  assert.equal(edge.kind, 'edge');
  const viaPath = findChrome({ platform: 'win32', env: { PATH: 'C:\\tools;C:\\bin', PATHEXT: '.COM;.EXE' }, home: 'C:\\Users\\a', exists: has(new Set(['C:\\bin\\chrome.exe'])) });
  assert.equal(viaPath?.path, 'C:\\bin\\chrome.exe');
  assert.equal(findChrome({ platform: 'darwin', env: {}, home: '/Users/a', exists: () => false }), null);
  assert.equal(onPath('chromium', { platform: 'linux', env: { PATH: '/a:/b' }, exists: p => p === '/b/chromium' }), '/b/chromium');
});

test('opening the studio: only loopback URLs, and no shell', () => {
  assert.deepEqual(openCommand('http://127.0.0.1:5180/studio/', { platform: 'win32', chrome: null }), { cmd: 'explorer.exe', args: ['http://127.0.0.1:5180/studio/'] });
  assert.deepEqual(openCommand('http://127.0.0.1:5180/studio/', { platform: 'darwin', chrome: null }).cmd, 'open');
  assert.deepEqual(openCommand('http://127.0.0.1:5180/studio/', { platform: 'linux', chrome: '/usr/bin/google-chrome' }).cmd, '/usr/bin/google-chrome');
  assert.throws(() => openCommand('https://evil.example/', { chrome: null }));
  assert.throws(() => openCommand('http://127.0.0.1:5180/" & calc', { chrome: null }));
});
