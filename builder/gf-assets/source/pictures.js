/* games.fun pictures: picture files a creator can replace, for a game built from page elements. NOT part of the original game.
 *
 * WHEN TO USE: the game builds what a player looks at (portraits, scenes, cards, icons, dice) as inline SVG, emoji or
 * CSS, so Studio has no picture of them (research/asset-manifest/code-art-2026-10-02/ART_2D_RECIPE.md, "DOM games").
 * Each such thing is saved once as a file (the bake), listed in assets.json as an ordinary image slot, and listed with
 * the bake's sha256 in art/pictures.json (bake-pictures.mjs writes both). While a file is still the bake, the game
 * keeps building the element in code, so normal play does not change; once a creator replaces the file, the game shows
 * the file in an <img> in the same box.
 *
 * HOW: copy this file into the game as gf/pictures.js (byte for byte) and load it before the game's own code:
 *   a module game:   import './gf/pictures.js';        a classic page:  <script src="gf/pictures.js"></script>
 * Once, at start, with the game's gf-assets module (every file read goes through it):
 *   const pictures = await globalThis.GfPictures.load(gf);            // reads art/pictures.json and each file once
 * and where the game builds the element:
 *   el.innerHTML = pictures.html('portrait.Tobin') ?? portraitSVG('Tobin', …);     // null while the file is the bake
 *   const url = pictures.url('scene.cellar');  if (url) box.style.backgroundImage = `url("${url}")`; else …
 *
 * pictures.url(key):   the replaced file's URL (through gf.url, so Studio's preview and a packed game work), or null.
 * pictures.html(key, {cls, fit, alt}): '<img class="gf-picture" …>' filling its box (fit: "contain" | "cover"), or null.
 * pictures.replaced:   the keys whose file is no longer the bake.   pictures.keys: every key in the table.
 * A key that is not in the table, or whose file can't be read, is "not replaced": the game draws it in code.
 *
 * NORMAL PLAY: nothing on the page changes while every file is the bake. Still run play-compare.mjs.
 * gf/pictures.js is games.fun kit code: list it in assets.json `ignore`, as the recipe says.
 */
(function (G) {
  'use strict';
  if (G.GfPictures) return;

  // SHA-256 of bytes, as hex. Written out here because crypto.subtle is missing outside secure contexts (a packed game
  // in a sandboxed frame), and the answer must be the same everywhere.
  var K = [];
  (function () { var n = 2, i = 0; while (i < 64) { var p = true; for (var d = 2; d * d <= n; d++) if (n % d === 0) { p = false; break; } if (p) K[i++] = (Math.pow(n, 1 / 3) * 4294967296) | 0; n++; } })();
  function sha256(bytes) {
    var h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    var len = bytes.length, total = ((len + 9 + 63) >> 6) << 6, m = new Uint8Array(total), w = new Int32Array(64);
    m.set(bytes); m[len] = 0x80;
    var bits = len * 8, view = new DataView(m.buffer);
    view.setUint32(total - 8, Math.floor(bits / 4294967296)); view.setUint32(total - 4, bits >>> 0);
    for (var o = 0; o < total; o += 64) {
      for (var i = 0; i < 16; i++) w[i] = view.getInt32(o + i * 4);
      for (i = 16; i < 64; i++) {
        var a = w[i - 15], b = w[i - 2];
        w[i] = (w[i - 16] + ((a >>> 7 | a << 25) ^ (a >>> 18 | a << 14) ^ (a >>> 3)) + w[i - 7] + ((b >>> 17 | b << 15) ^ (b >>> 19 | b << 13) ^ (b >>> 10))) | 0;
      }
      var A = h[0], B = h[1], C = h[2], D = h[3], E = h[4], F = h[5], H = h[6], I = h[7];
      for (i = 0; i < 64; i++) {
        var t1 = (I + ((E >>> 6 | E << 26) ^ (E >>> 11 | E << 21) ^ (E >>> 25 | E << 7)) + ((E & F) ^ (~E & H)) + K[i] + w[i]) | 0;
        var t2 = (((A >>> 2 | A << 30) ^ (A >>> 13 | A << 19) ^ (A >>> 22 | A << 10)) + ((A & B) ^ (A & C) ^ (B & C))) | 0;
        I = H; H = F; F = E; E = (D + t1) | 0; D = C; C = B; B = A; A = (t1 + t2) | 0;
      }
      h[0] = (h[0] + A) | 0; h[1] = (h[1] + B) | 0; h[2] = (h[2] + C) | 0; h[3] = (h[3] + D) | 0; h[4] = (h[4] + E) | 0; h[5] = (h[5] + F) | 0; h[6] = (h[6] + H) | 0; h[7] = (h[7] + I) | 0;
    }
    var out = '';
    for (var j = 0; j < 8; j++) out += ('00000000' + (h[j] >>> 0).toString(16)).slice(-8);
    return out;
  }

  function escAttr(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  function load(gf, tablePath) {
    tablePath = tablePath || 'art/pictures.json';
    return gf.json(tablePath).then(function (table) {
      var entries = (table && table.pictures) || {}, keys = Object.keys(entries), urls = {};
      return Promise.all(keys.map(function (key) {
        var e = entries[key];
        if (!e || typeof e.file !== 'string') return null;
        return gf.bytes(e.file).then(function (buf) {
          if (sha256(new Uint8Array(buf)) !== e.own) urls[key] = gf.url(e.file);
        }, function (err) { if (G.console) G.console.warn('gf-pictures: ' + e.file + ' could not be read (' + (err && err.message) + '); the game draws ' + key + ' itself'); });
      })).then(function () { return api(keys, urls); });
    }, function () { return api([], {}); });   // no table: every picture is the game's own
  }
  function api(keys, urls) {
    return {
      keys: keys, replaced: Object.keys(urls),
      url: function (key) { return Object.prototype.hasOwnProperty.call(urls, key) ? urls[key] : null; },
      html: function (key, o) {
        if (!Object.prototype.hasOwnProperty.call(urls, key)) return null;
        o = o || {};
        return '<img class="' + escAttr(o.cls || 'gf-picture') + '" src="' + escAttr(urls[key]) + '" alt="' + escAttr(o.alt || '') + '" draggable="false" style="display:block;width:100%;height:100%;object-fit:' + (o.fit === 'cover' ? 'cover' : 'contain') + '">';
      },
    };
  }

  G.GfPictures = { version: '1.0.0', load: load, sha256: sha256 };
})(typeof globalThis !== 'undefined' ? globalThis : window);
