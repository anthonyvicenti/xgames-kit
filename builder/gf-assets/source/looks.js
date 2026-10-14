/* games.fun looks: one small canvas per thing a player sees, so a creator can replace it. NOT part of the original game.
 *
 * WHEN TO USE: a 2D canvas game draws its hero, enemies, pieces or items with paths every frame, so Studio has no picture
 * of them (research/asset-manifest/code-art-2026-10-02/ART_2D_RECIPE.md is the whole recipe; read it first).
 *
 * HOW: copy this file into the game as gf/looks.js (byte for byte) and load it before the game's own code:
 *   a module game:   import '../gf/looks.js';   then   const { look, probe, draw, flash } = globalThis.GfLooks;
 *   a classic page:  <script src="gf/looks.js"></script> before the game's script.
 * Then, once, at start (after the config and colours are loaded, before the first frame):
 *   const hero = {}, enemies = {};                                    // the object's name becomes the Studio group
 *   hero.hero = look([-60, -140, 120, 150], g => paintHero(g, 0));     // ONE LOOK PER LINE: the line is the look's identity
 *   enemies.slime = look([-20, -20, 40, 36], g => paintSlime(g, 0));
 *   probe({ hero, enemies });                                         // marks the looks a creator replaced
 * and where the game draws the thing:
 *   if (hero.hero.replaced) draw(g, hero.hero, x, y, scale); else paintHero(g, t);    // untouched looks keep their code
 *
 * look(box, paint, scale = 4): box is [left, top, width, height] in the game's own units around the point the thing is
 *   drawn at; paint(g) draws it with the game's own code at that point (0, 0); scale is canvas pixels per unit.
 *   It paints on a scratch canvas that is on the page and copies the result in one step, so the capture
 *   (capture-code-art.mjs) sees one picture per look, and both canvases are software ones (willReadFrequently), so a
 *   few dozen more canvases don't change how Chrome draws the game's own.
 * probe(looks): reads every look once. gf/code-art.js writes a creator's picture into a look at its first read, and the
 *   look's `replaced` says so. Takes a look, a list, or an object of them (nested as you like). Returns how many.
 * draw(g, L, x, y, s): the look where the code would draw it (its point at x, y; s scales it).
 * flash(L): the look's shape in white, for a hit flash; flash(L, '#ff0000') in another colour.
 *
 * NORMAL PLAY: with nothing replaced, `replaced` is false on every look and the game draws exactly as before; the looks
 * are painted once and never drawn. Still run play-compare.mjs.
 * gf/looks.js is games.fun kit code: list it in assets.json `ignore`, as the recipe says.
 */
(function (G) {
  'use strict';
  if (G.GfLooks) return;
  var scratch = null, made = [];

  function look(box, paint, scale) {
    scale = scale || 4;
    var d = G.document, c = d.createElement('canvas');
    var w = c.width = Math.max(1, Math.round(box[2] * scale)), h = c.height = Math.max(1, Math.round(box[3] * scale));
    if (!scratch) { scratch = d.createElement('canvas'); scratch.hidden = true; (d.body || d.documentElement).appendChild(scratch); }
    scratch.width = w + 1; scratch.height = h + 1;   // +1: never the size of a look, so the shim's copy check skips it
    var s = scratch.getContext('2d', { willReadFrequently: true });
    s.setTransform(scale, 0, 0, scale, -box[0] * scale, -box[1] * scale);
    paint(s);
    c.getContext('2d', { willReadFrequently: true }).putImageData(s.getImageData(0, 0, w, h), 0, 0);
    var L = { c: c, box: box, scale: scale, replaced: false, tints: null };
    made.push(L);
    return L;
  }

  function isLook(v) { return !!v && typeof v === 'object' && !!v.c && Array.isArray(v.box); }
  function each(v, f, depth) {
    if (!v || typeof v !== 'object' || (depth || 0) > 4) return;
    if (isLook(v)) { f(v); return; }
    for (var k in v) each(v[k], f, (depth || 0) + 1);
  }

  function probe(looks) {
    var stats = G.__GF_CODE_ART && G.__GF_CODE_ART.stats, pc = G.document.createElement('canvas'), n = 0;
    pc.width = pc.height = 1;
    var p = pc.getContext('2d', { willReadFrequently: true });
    function written() { var t = 0, a = stats && stats.applied; for (var k in a) t += a[k]; return t; }
    each(looks === undefined ? made : looks, function (L) {
      var before = written();
      p.drawImage(L.c, 0, 0, 1, 1);
      L.replaced = written() > before;
      if (L.replaced) { n++; L.tints = null; }
    });
    if (scratch) { scratch.remove(); scratch = null; }
    return n;
  }

  function draw(g, L, x, y, s) {
    x = x || 0; y = y || 0; s = s === undefined ? 1 : s;
    var q = g.imageSmoothingQuality, b = L.box;
    g.imageSmoothingQuality = 'high';
    g.drawImage(L.c, x + b[0] * s, y + b[1] * s, b[2] * s, b[3] * s);
    g.imageSmoothingQuality = q;
  }

  function flash(L, colour) {
    colour = colour || '#ffffff';
    var t = L.tints || (L.tints = {});
    if (!t[colour]) {
      var c = G.document.createElement('canvas'); c.width = L.c.width; c.height = L.c.height;
      var x = c.getContext('2d', { willReadFrequently: true });
      x.drawImage(L.c, 0, 0); x.globalCompositeOperation = 'source-atop'; x.fillStyle = colour; x.fillRect(0, 0, c.width, c.height);
      t[colour] = { c: c, box: L.box, scale: L.scale, replaced: true, tints: null };
    }
    return t[colour];
  }

  G.GfLooks = { version: '1.0.0', look: look, probe: probe, draw: draw, flash: flash, made: made };
})(typeof globalThis !== 'undefined' ? globalThis : window);
