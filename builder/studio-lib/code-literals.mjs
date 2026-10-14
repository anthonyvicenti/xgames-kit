// Asset manifest v1.4 code value slots (docs/asset-manifest.md "v1.4: values in code"): a value slot may live in a
// game's own code instead of a JSON file, `source: {file, code: {start, end, text, path, lang?}}`. These are the pure
// helpers every reader shares: decode a code file, read the literal at a slot's anchor, write a new value back in the
// literal's own style, splice several edits into one file, and keep the other anchors of that file in step.
// Used by lib/manifest.mjs (Studio's routes, drafts and saves), lib/play-serve.mjs (draft previews), the validator,
// check.mjs and scan-code.mjs (asset-manifest/). No imports on purpose, like lib/manifest-normalize.mjs: the
// worker container mounts studio-lib but not studio-lib/vendor.
// v1.5 (docs/asset-manifest.md "v1.5: colours kept as numbers, shader colours, pixel rows"): a colour the code keeps as 3 or 4 numbers
// (constraints.format "rgb01"/"rgb255": [.43,.61,.27], (1,.45,.15), [124,189,107]) or as a shader constructor (lang
// "glsl": vec3(.36,.63,.75)) reads as #rrggbb(aa) and is written back in the code's own notation, unchanged components
// keeping their exact text, so every caller sees and saves ordinary hex colours.
//
// Offsets are UTF-16 code units into the file decoded as UTF-8 with a leading byte-order mark kept (as U+FEFF): that is
// what JavaScript strings, acorn's node positions and Node's readFile(path, 'utf8') all count, so the scanner, the
// server and the browser agree without re-encoding. Byte offsets would shift on every non-ASCII character before them.

/** Code languages: `js` (a .js file or an inline <script>), `css` (a colour in a .css file, <style> or style=""),
 *  `html` (a text node in an .html file), `attr` (an HTML attribute value, quotes included) and (v1.5) `glsl` (a
 *  `vec3(…)`/`vec4(…)` colour constructor inside a GLSL or WGSL shader string in a JS file or inline script). */
export const CODE_LANGS = ['js', 'css', 'html', 'attr', 'glsl'];
const EXT_LANG = {js: 'js', mjs: 'js', cjs: 'js', css: 'css', html: 'html', htm: 'html'};
const extOf = path => (/\.([a-z0-9]+)$/i.exec(path ?? '')?.[1] ?? '').toLowerCase();
/** Files a code slot may point into. */
export const isCodeFile = path => Object.hasOwn(EXT_LANG, extOf(path));
const isHtmlFile = path => EXT_LANG[extOf(path)] === 'html';
/** The slot's `source.code`, or null for a JSON value slot or a file slot. */
export const codeOf = slot => (slot?.source?.code && typeof slot.source.code === 'object' && !Array.isArray(slot.source.code) ? slot.source.code : null);
export const isCodeSlot = slot => !!codeOf(slot);
/** A code slot's language: its `lang`, else from the file's extension (.css: css, .html: html, else js). */
export const codeLang = slot => codeOf(slot)?.lang ?? EXT_LANG[extOf(slot?.source?.file)] ?? 'js';
/** v1.4 colour format constraint: the literal is a number (three.js 0xRRGGBB, or decimal in minified code). Studio shows it as #rrggbb. */
export const COLOR_INT = '0xrrggbb';
/** v1.5 colour format constraints for colours the code keeps as 3 or 4 numbers: `rgb01` (0–1 floats: `[.43,.61,.27]`,
 *  the argument list `(1,.45,.15)` of a call, or `vec3(.36,.63,.75)` in a shader) and `rgb255` (0–255 whole numbers:
 *  `[124,189,107]`). Studio sees and saves `#rrggbb` (`#rrggbbaa` with a fourth number); the code keeps its notation. */
export const COLOR_TRIPLE_FORMATS = ['rgb01', 'rgb255'];
/** Every colour format a code slot may declare. */
export const COLOR_FORMATS = [COLOR_INT, ...COLOR_TRIPLE_FORMATS];
// Same pattern as lib/manifest.mjs COLOR and builder/asset-manifest/validate.mjs.
const COLOR = /^(?:#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})|rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(?:,\s*(?:0|1|0?\.\d+)\s*)?\))$/i;

/** A code file's text (see the offsets note above). Throws on bytes that aren't UTF-8. */
export const decodeCode = bytes => new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes);
export const encodeCode = text => new TextEncoder().encode(text);

// ---- Reading a JavaScript literal ------------------------------------------------------------------
// A pure literal only: numbers (any radix, separators, a sign), strings, template literals without ${}, true/false and
// minified !0/!1, null, and arrays/objects of those (identifier, string or number keys; comments allowed). No
// identifiers, calls, spreads, holes, computed keys, methods or __proto__. Returns {value, style}; style records how it
// was written so formatJs can write a new value the same way.
const WS = new Set([' ', '\t', '\n', '\r', '\v', '\f', ' ', '﻿', ' ', ' ']);
const NUM = /^(?:0[xX][0-9a-fA-F](?:_?[0-9a-fA-F])*|0[oO][0-7](?:_?[0-7])*|0[bB][01](?:_?[01])*|(?:(?:[1-9](?:_?\d)*|0)?\.\d(?:_?\d)*|(?:[1-9](?:_?\d)*|0)\.?)(?:[eE][+-]?\d(?:_?\d)*)?)/;
const ID_START = /[A-Za-z_$\u0080-￿]/, ID_PART = /[\w$\u0080-￿]/;
const ESC = {n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0'};

export function parseJs(src) {
  let i = 0;
  const style = {quotes: {}, bareKeys: 0, quotedKeys: 0, minBool: false, colonSpace: 0, colonTight: 0, commaSpace: 0, commaTight: 0, hex: false, upper: false};
  const fail = m => { throw new SyntaxError(`${m} at ${i}`); };
  const ws = () => {
    for (;;) {
      if (WS.has(src[i])) i++;
      else if (src.startsWith('//', i)) { while (i < src.length && src[i] !== '\n') i++; }
      else if (src.startsWith('/*', i)) { const e = src.indexOf('*/', i + 2); if (e < 0) fail('unclosed comment'); i = e + 2; }
      else return;
    }
  };
  const escape = () => {
    const c = src[++i];
    if (c === undefined) fail('unfinished escape');
    i++;
    if (Object.hasOwn(ESC, c)) { if (c === '0' && /[0-9]/.test(src[i] ?? '')) fail('octal escape'); return ESC[c]; }
    if (c === 'x') { const h = src.slice(i, i + 2); if (!/^[0-9a-fA-F]{2}$/.test(h)) fail('bad \\x escape'); i += 2; return String.fromCharCode(parseInt(h, 16)); }
    if (c === 'u') {
      if (src[i] === '{') { const e = src.indexOf('}', i); const h = src.slice(i + 1, e); if (e < 0 || !/^[0-9a-fA-F]{1,6}$/.test(h) || parseInt(h, 16) > 0x10ffff) fail('bad \\u{} escape'); i = e + 1; return String.fromCodePoint(parseInt(h, 16)); }
      const h = src.slice(i, i + 4); if (!/^[0-9a-fA-F]{4}$/.test(h)) fail('bad \\u escape'); i += 4; return String.fromCharCode(parseInt(h, 16));
    }
    if (c === '\r') { if (src[i] === '\n') i++; return ''; }   // line continuation
    if (c === '\n' || c === ' ' || c === ' ') return '';
    if (/[1-9]/.test(c)) fail('octal escape');
    return c;   // \' \" \\ \` \$ and identity escapes
  };
  const string = () => {
    const q = src[i++]; let out = '';
    style.quotes[q] = (style.quotes[q] ?? 0) + 1;
    for (;;) {
      const c = src[i];
      if (c === undefined) fail('unclosed string');
      if (c === q) { i++; return out; }
      if (c === '\\') { out += escape(); continue; }
      if (q !== '`' && (c === '\n' || c === '\r')) fail('newline in string');
      if (q === '`' && c === '$' && src[i + 1] === '{') fail('template literal with an expression');
      out += c; i++;
    }
  };
  const number = () => {
    const m = NUM.exec(src.slice(i));
    if (!m || ID_PART.test(src[i + m[0].length] ?? '') || /^0\d/.test(m[0])) fail('not a number');
    i += m[0].length;
    const t = m[0].replace(/_/g, '');
    if (/^0[xX]/.test(t)) { style.hex = true; if (/[A-F]/.test(t.slice(2))) style.upper = true; }
    return Number(t);
  };
  const key = () => {
    const c = src[i];
    if (c === '"' || c === "'") { style.quotedKeys++; return string(); }
    if (/[0-9.]/.test(c)) return String(number());
    if (!ID_START.test(c ?? '')) fail('bad key');
    const s = i; while (ID_PART.test(src[i] ?? '')) i++;
    style.bareKeys++;
    return src.slice(s, i);
  };
  const sep = (after) => { const k = (after === ':' ? 'colon' : 'comma') + (WS.has(src[i]) ? 'Space' : 'Tight'); style[k]++; };
  const value = () => {
    ws();
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') return string();
    if (c === '[') {
      i++; const out = [];
      for (ws(); src[i] !== ']';) {
        if (src[i] === ',') fail('array hole');
        if (src.startsWith('...', i)) fail('spread');
        out.push(value()); ws();
        if (src[i] === ',') { i++; sep(','); ws(); } else if (src[i] !== ']') fail('expected , or ]');
      }
      i++; return out;
    }
    if (c === '{') {
      i++; const out = {};
      for (ws(); src[i] !== '}';) {
        if (src.startsWith('...', i) || src[i] === '[') fail('spread or computed key');
        const k = key(); ws();
        if (src[i] !== ':') fail('expected : (shorthand, getters and methods are not literals)');
        if (k === '__proto__') fail('__proto__ key');
        i++; sep(':');
        out[k] = value(); ws();
        if (src[i] === ',') { i++; sep(','); ws(); } else if (src[i] !== '}') fail('expected , or }');
      }
      i++; return out;
    }
    if (c === '!' && (src[i + 1] === '0' || src[i + 1] === '1') && !ID_PART.test(src[i + 2] ?? '') && src[i + 2] !== '.') { i += 2; style.minBool = true; return src[i - 1] === '0'; }
    if (c === '-' || c === '+') { i++; ws(); if (!/[0-9.]/.test(src[i] ?? '')) fail('sign without a number'); const n = number(); return c === '-' ? -n : n; }
    if (c !== undefined && /[0-9.]/.test(c)) return number();
    for (const [w, v] of [['true', true], ['false', false], ['null', null]]) if (src.startsWith(w, i) && !ID_PART.test(src[i + w.length] ?? '')) { i += w.length; return v; }
    return fail('not a literal');
  };
  const v = value(); ws();
  if (i !== src.length) fail('extra code after the literal');
  return {value: v, style};
}

// ---- Writing a JavaScript literal --------------------------------------------------------------------
const quoteOf = (text, style) => {
  const t = text.trimStart()[0];
  if (t === '"' || t === "'" || t === '`') return t;
  const q = style?.quotes ?? {};
  return (q["'"] ?? 0) > (q['"'] ?? 0) ? "'" : (q['"'] ?? 0) > 0 ? '"' : (q['`'] ?? 0) > 0 ? '`' : "'";
};
/** A JS string literal in quote `q`. In an HTML file the text can't end the inline <script>, so "</" and "<!--" are escaped. */
export function jsString(s, q = "'", html = false) {
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (ch === '\\') out += '\\\\';
    else if (ch === q) out += '\\' + q;
    else if (q === '`' && ch === '$') out += '$';
    else if (ch === '\n') out += q === '`' ? '\n' : '\\n';
    else if (ch === '\r') out += '\\r';
    else if (c < 0x20 && ch !== '\t') out += '\\x' + c.toString(16).padStart(2, '0');
    else out += ch;
  }
  if (q === '`') out = out.replace(/\$\{/g, '\\${');
  if (html) out = out.replace(/<\//g, '<\\/').replace(/<!--/g, '<\\!--');
  return q + out + q;
}
const fmtNumber = n => { if (!Number.isFinite(n)) throw new RangeError('not a finite number'); return Object.is(n, -0) ? '0' : String(n); };
const BARE_KEY = /^[A-Za-z_$][\w$]*$/;

/** A JSON-able value as a compact JS literal in the original's style (quotes, bare keys, spacing, !0/!1, one record per line when it was multi-line). */
export function formatJs(value, original, {html = false} = {}) {
  let style = null;
  try { style = parseJs(original).style; } catch { style = null; }
  const q = quoteOf(original, style) === '`' ? "'" : quoteOf(original, style);
  const bare = !style || style.bareKeys >= style.quotedKeys;
  const colon = style && style.colonTight > style.colonSpace ? ':' : ': ', comma = style && style.commaTight > style.commaSpace ? ',' : ', ';
  const one = (v) => {
    if (v === null) return 'null';
    if (typeof v === 'boolean') return style?.minBool ? (v ? '!0' : '!1') : String(v);
    if (typeof v === 'number') return fmtNumber(v);
    if (typeof v === 'string') return jsString(v, q, html);
    if (Array.isArray(v)) return '[' + v.map(one).join(comma) + ']';
    if (v && typeof v === 'object') return '{' + Object.entries(v).map(([k, x]) => (bare && BARE_KEY.test(k) ? k : jsString(k, q, html)) + colon + one(x)).join(comma) + '}';
    throw new TypeError('not a JSON value');
  };
  const multi = /\n/.test(original) && value && typeof value === 'object';
  const items = !multi ? null : Array.isArray(value) ? value.map(one) : Object.entries(value).map(([k, x]) => (bare && BARE_KEY.test(k) ? k : jsString(k, q, html)) + colon + one(x));
  if (!items?.length) return one(value);
  const indent = /\n([ \t]*)[^\s\]}]/.exec(original)?.[1] ?? '  ', close = /\n([ \t]*)[\]}]\s*$/.exec(original)?.[1] ?? '';
  const trailing = /,\s*(?:\/\/[^\n]*\s*|\/\*[\s\S]*?\*\/\s*)*[\]}]\s*$/.test(original);
  const [open, end] = Array.isArray(value) ? ['[', ']'] : ['{', '}'];
  return `${open}\n${indent}${items.join(`,\n${indent}`)}${trailing ? ',' : ''}\n${close}${end}`;
}

// ---- Colours -----------------------------------------------------------------------------------------
/** #rgb/#rrggbb (no alpha) as an integer, or null. */
export function colorToInt(c) {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c ?? '');
  if (!m) return null;
  const h = m[1].length === 3 ? [...m[1]].map(x => x + x).join('') : m[1];
  return parseInt(h, 16);
}
export const intToColor = n => (Number.isInteger(n) && n >= 0 && n <= 0xffffff ? '#' + n.toString(16).padStart(6, '0') : null);
/** A CSS colour (#rgb, #rgba, #rrggbb, #rrggbbaa, rgb(), rgba()) as [r, g, b, a] bytes, or null. */
export function colorBytes(c) {
  const s = String(c ?? '').trim();
  let m = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(s);
  if (m) {
    const h = m[1].length <= 4 ? [...m[1]].map(x => x + x).join('') : m[1];
    const b = h.match(/../g).map(p => parseInt(p, 16));
    return b.length === 3 ? [...b, 255] : b;
  }
  m = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*(0|1|0?\.\d+|1\.0*)\s*)?\)$/i.exec(s);
  if (!m) return null;
  const rgb = m.slice(1, 4).map(Number);
  if (rgb.some(v => v > 255)) return null;
  return [...rgb, m[4] === undefined ? 255 : Math.round(Number(m[4]) * 255)];
}
const hex2 = n => n.toString(16).padStart(2, '0');

// ---- Colours kept as 3 or 4 numbers (v1.5: constraints.format rgb01/rgb255, and shader vec3/vec4) ----------------
const NUM_TOKEN = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?f?$/;
/**
 * A colour written as numbers: a JS array `[.43,.61,.27]`, a call's whole argument list `(1,.45,.15)`, the arguments after
 * a call's first (round 2: `gl.uniform4f(loc, 1, .97, .79, .72)` → `1, .97, .79, .72`, no brackets), or (lang glsl) a
 * shader constructor `vec3(.36,.63,.75)`, `vec4f(…)`, `vec3<f32>(…)`, or the one-number splat `vec3(1.0)`. Returns
 * {open, close, size, parts: [{lead, token, trail, value}], trailingComma} or null.
 */
export function parseColorNumbers(text, lang = 'js') {
  const t = String(text ?? '');
  let open, inner, size;
  if (lang === 'glsl') {
    const m = /^(vec([34])(?:f|<f32>)?\s*\()([\s\S]*)\)$/.exec(t);
    if (!m) return null;
    [open, size, inner] = [m[1], Number(m[2]), m[3]];
  } else if ((t[0] === '[' && t.at(-1) === ']') || (t[0] === '(' && t.at(-1) === ')')) [open, inner] = [t[0], t.slice(1, -1)];
  else if (/^[\d.][^[\]()]*,[^[\]()]*[\d.f]$/.test(t)) [open, inner] = ['', t];
  else return null;
  const pieces = inner.split(',');
  let trailingComma = false;
  if (pieces.length > 1 && !pieces.at(-1).trim() && open === '[') { pieces.pop(); trailingComma = true; }
  const parts = [];
  for (const p of pieces) {
    const m = /^(\s*)(\S+?)(\s*)$/.exec(p);
    if (!m || !NUM_TOKEN.test(m[2])) return null;
    parts.push({lead: m[1], token: m[2], trail: m[3], value: Number(m[2].replace(/f$/, ''))});
  }
  size ??= parts.length;
  if (lang === 'glsl' ? !(parts.length === 1 || parts.length === size) : !(parts.length === 3 || parts.length === 4)) return null;
  return {open, close: open === '[' ? ']' : open === '' ? '' : ')', size, parts, trailingComma};
}
const byteOf = (v, format) => (format === 'rgb255' ? v : Math.round(v * 255));
/** The `#rrggbb` (`#rrggbbaa` with four numbers) that numbers in `format` hold, or {reason} when they aren't such a colour. */
function readColorNumbers(text, lang, format) {
  if (!COLOR_TRIPLE_FORMATS.includes(format)) return {ok: false, reason: lang === 'glsl' ? 'a shader colour needs constraints.format "rgb01"' : 'a colour kept as numbers needs constraints.format "rgb01" or "rgb255"'};
  if (lang === 'glsl' && format !== 'rgb01') return {ok: false, reason: 'shader colours are 0–1 numbers (constraints.format "rgb01")'};
  const c = parseColorNumbers(text, lang);
  if (!c) return {ok: false, reason: lang === 'glsl' ? 'not a vec3(…) or vec4(…) of plain numbers' : 'not 3 or 4 plain numbers in [ ] or ( )'};
  const values = c.parts.length === 1 ? Array(c.size).fill(c.parts[0].value) : c.parts.map(p => p.value);
  if (format === 'rgb01' && values.some(v => !(v >= 0 && v <= 1))) return {ok: false, reason: 'rgb01 numbers must be between 0 and 1'};
  if (format === 'rgb255' && (values.some(v => !Number.isInteger(v) || v < 0 || v > 255) || c.parts.some(p => /[.eEf]/.test(p.token)))) return {ok: false, reason: 'rgb255 numbers must be whole numbers from 0 to 255'};
  const bytes = values.map(v => byteOf(v, format));
  return {ok: true, value: '#' + bytes.slice(0, 3).map(hex2).join('') + (bytes.length === 4 ? hex2(bytes[3]) : '')};
}
/** A 0–1 number for `byte`, in the style of the numbers around it: the shortest decimal that reads back as the same byte. */
function unitToken(byte, style) {
  const v = byte / 255;
  let s;
  if (Number.isInteger(v)) s = style.glsl || style.dotZero ? (style.trailingDot ? `${v}.` : `${v}.0`) : String(v);
  else {
    for (let d = 1; d <= 7; d++) { s = v.toFixed(d).replace(/0+$/, ''); if (Math.round(Number(s) * 255) === byte) break; }
    if (style.bare) s = s.replace(/^0\./, '.');
  }
  return s + (style.suffix ? 'f' : '');
}
/** `value` (a CSS colour) written over numbers `text` in their own notation: unchanged components keep their exact text. */
function formatColorNumbers(value, text, lang, format) {
  const c = parseColorNumbers(text, lang), b = colorBytes(value);
  if (!c) throw new TypeError('the literal is not a colour kept as numbers');
  if (!b) throw new TypeError('not a colour');
  const want = c.size === 4 ? b : b.slice(0, 3);
  if (c.size === 3 && b[3] !== 255) throw new TypeError('this colour has no transparency (the code keeps three numbers)');
  const tokens = c.parts.map(p => p.token);
  const style = {glsl: lang === 'glsl', bare: tokens.some(x => /^\./.test(x)), trailingDot: tokens.some(x => /^\d+\.(?:f)?$/.test(x)),
    dotZero: tokens.some(x => /^\d+\.0+f?$/.test(x)), suffix: tokens.length && tokens.every(x => /f$/.test(x))};
  const tok = (byte, i) => {
    const orig = c.parts.length === 1 ? c.parts[0] : c.parts[i];
    if (orig && byteOf(orig.value, format) === byte) return orig.token;
    return format === 'rgb255' ? String(byte) : unitToken(byte, style);
  };
  const body = c.parts.length === 1 && want.every(x => x === want[0])
    ? c.parts[0].lead + tok(want[0], 0) + c.parts[0].trail
    : c.parts.length === 1
      ? want.map((x, i) => tok(x, i)).join(', ')
      : want.map((x, i) => (c.parts[i].lead ?? '') + tok(x, i) + (c.parts[i].trail ?? '')).join(',');
  return c.open + body + (c.trailingComma ? ',' : '') + c.close;
}
/** True when a colour slot can't take transparency: a `0xrrggbb` number, or three numbers (rgb01/rgb255) with no fourth. */
export function opaqueColor(slot, value) {
  const f = slot?.constraints?.format;
  if (f === COLOR_INT) return true;
  return COLOR_TRIPLE_FORMATS.includes(f) && typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
}

/** A colour string written like `original` (#rgb stays short when it can, hex keeps its case; rgb() is written as given). */
export function formatColorLike(value, original) {
  if (!/^#/.test(value) || !/^#/.test(original)) return value;
  let v = value.toLowerCase();
  // Short stays short when the new colour can be: only a long value (#rrggbb, #rrggbbaa) is shortened. A value that is
  // already short is written as it is (round 3, bug 16: "#fff" was cut to "#f", so the scanner dropped every #fff and #000).
  if ((original.length === 4 || original.length === 5) && (v.length === 7 || v.length === 9)) { const pairs = v.slice(1).match(/../g); if (pairs.every(p => p[0] === p[1])) v = '#' + pairs.map(p => p[0]).join(''); }
  return /[A-F]/.test(original) ? v.toUpperCase() : v;
}

// ---- HTML text and attributes ------------------------------------------------------------------------
const ENTITIES = {amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', trade: '™', hellip: '…', mdash: '—', ndash: '–',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»', middot: '·', bull: '•', times: '×', divide: '÷', deg: '°', plusmn: '±', micro: 'µ',
  euro: '€', pound: '£', yen: '¥', cent: '¢', sect: '§', para: '¶', larr: '←', rarr: '→', uarr: '↑', darr: '↓', harr: '↔', hearts: '♥', spades: '♠',
  clubs: '♣', diams: '♦', frac12: '½', frac14: '¼', frac34: '¾', sup2: '²', sup3: '³', iexcl: '¡', iquest: '¿', zwj: '‍', zwnj: '‌', thinsp: ' ',
  ensp: ' ', emsp: ' ', shy: '­', check: '✓', star: '☆', starf: '★'};
/** HTML character references decoded; an unknown named one throws (so the scanner leaves such text alone). */
export function decodeEntities(s) {
  return s.replace(/&(#[0-9]+|#[xX][0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]*);?/g, (all, ref) => {
    if (ref[0] === '#') { const n = /^#[xX]/.test(ref) ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10); if (!(n > 0 && n <= 0x10ffff)) throw new SyntaxError(`bad character reference ${all}`); return String.fromCodePoint(n); }
    if (Object.hasOwn(ENTITIES, ref) && all.endsWith(';')) return ENTITIES[ref];
    if (!all.endsWith(';')) return all;   // a bare "&word" without ";" is text
    throw new SyntaxError(`unknown character reference ${all}`);
  });
}
const htmlText = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/ /g, '&nbsp;');
function htmlAttr(s, original) {
  const q = original[0] === '"' || original[0] === "'" ? original[0] : null;
  const esc = s.replace(/&/g, '&amp;').replace(/ /g, '&nbsp;');
  if (q === "'") return `'${esc.replace(/'/g, '&#39;')}'`;
  if (q === null && /^[^\s"'=<>`]+$/.test(esc)) return esc;
  return `"${esc.replace(/"/g, '&quot;')}"`;
}

// ---- One slot's literal --------------------------------------------------------------------------------
const VALUE_KIND = {number: 'number', integer: 'number', boolean: 'boolean', text: 'string', enum: 'string'};
/**
 * The value a code slot's literal holds, read as the slot's type: {ok: true, value} or {ok: false, reason}.
 * `slot` needs type, source.file and source.code ({text, lang?}); pass `text` to read another literal the same way.
 */
export function readCodeValue(slot, text = codeOf(slot)?.text) {
  const lang = codeLang(slot), type = slot?.type;
  if (typeof text !== 'string' || !text) return {ok: false, reason: 'no literal text'};
  try {
    if (lang === 'css') return type === 'color' && COLOR.test(text) ? {ok: true, value: text} : {ok: false, reason: 'a CSS slot holds one colour'};
    const format = slot?.constraints?.format;
    if (lang === 'glsl') return type === 'color' ? readColorNumbers(text, lang, format) : {ok: false, reason: 'a shader slot holds one colour'};
    if (lang === 'js' && type === 'color' && COLOR_TRIPLE_FORMATS.includes(format)) return readColorNumbers(text, lang, format);
    if (lang === 'html' || lang === 'attr') {
      if (type !== 'text' && type !== 'enum') return {ok: false, reason: 'HTML text and attributes are text slots'};
      const raw = lang === 'attr' && (text[0] === '"' || text[0] === "'") ? (text.at(-1) === text[0] && text.length > 1 ? text.slice(1, -1) : null) : text;
      if (raw === null) return {ok: false, reason: 'unbalanced attribute quotes'};
      return {ok: true, value: decodeEntities(raw)};
    }
    const {value} = parseJs(text);
    if (type === 'color') {
      if (typeof value === 'string') return COLOR.test(value) ? {ok: true, value} : {ok: false, reason: 'not a colour'};
      if (Array.isArray(value)) return {ok: false, reason: 'a colour kept as numbers needs constraints.format "rgb01" or "rgb255"'};
      const c = typeof value === 'number' && !/^\s*[-+]/.test(text) ? intToColor(value) : null;
      return c ? {ok: true, value: c} : {ok: false, reason: 'not a colour'};
    }
    if (type === 'colors') {
      const list = Array.isArray(value) ? value : value && typeof value === 'object' ? Object.values(value) : null;
      return list?.length && list.every(c => typeof c === 'string' && COLOR.test(c)) ? {ok: true, value} : {ok: false, reason: 'not a list of colour strings'};
    }
    if (type === 'json') return {ok: true, value};
    const want = VALUE_KIND[type];
    if (!want) return {ok: false, reason: `${type} is not a value type`};
    if (typeof value !== want) return {ok: false, reason: `the literal is a ${value === null ? 'null' : Array.isArray(value) ? 'list' : typeof value}, not a ${want}`};
    if (type === 'integer' && !Number.isInteger(value)) return {ok: false, reason: 'not a whole number'};
    return {ok: true, value};
  } catch (e) { return {ok: false, reason: String(e?.message ?? e)}; }
}

/**
 * The source text that writes `value` into a code slot, in its literal's own style: the quotes and escaping of a
 * string, the radix and case of a number (a 0x colour stays 0x), !0/!1 in minified code, a CSS colour as written,
 * HTML text and attribute values escaped. `json` is re-serialised compactly (comments inside it are not kept).
 * `around` = {before, after}: the characters next to the literal in the file, so a sign or a word never fuses with
 * them (`a-5` set to -3 becomes `a-(-3)`, `return!0` set to true becomes `return true`). Throws on a value it can't write.
 */
export function formatCodeValue(slot, value, {around = {}, text = codeOf(slot)?.text} = {}) {
  const lang = codeLang(slot), type = slot?.type, html = isHtmlFile(slot?.source?.file);
  if (lang === 'css') { if (typeof value !== 'string' || !COLOR.test(value)) throw new TypeError('not a colour'); return formatColorLike(value, text); }
  if (lang === 'html') { if (typeof value !== 'string') throw new TypeError('not text'); return htmlText(value); }
  if (lang === 'attr') { if (typeof value !== 'string') throw new TypeError('not text'); return htmlAttr(value, text); }
  const format = slot?.constraints?.format;
  let out;
  if (lang === 'glsl' || (type === 'color' && COLOR_TRIPLE_FORMATS.includes(format))) {
    if (type !== 'color') throw new TypeError('a shader slot holds one colour');
    if (typeof value !== 'string' || !COLOR.test(value)) throw new TypeError('not a colour');
    const r = readColorNumbers(text.trim(), lang, format);
    if (!r.ok) throw new TypeError(r.reason);
    out = formatColorNumbers(value, text.trim(), lang, format);
  } else if (type === 'color') {
    if (typeof value !== 'string' || !COLOR.test(value)) throw new TypeError('not a colour');
    const t = text.trim();
    if (/^[\d.]/.test(t)) {   // a number: 0xRRGGBB (three.js) or decimal (minified)
      const n = colorToInt(value);
      if (n === null) throw new TypeError('a number colour takes #rrggbb (no transparency)');
      const h = n.toString(16).padStart(6, '0');
      out = /^0[xX]/.test(t) ? '0x' + (/[A-F]/.test(t.slice(2)) ? h.toUpperCase() : h) : String(n);
    } else out = jsString(formatColorLike(value, parseJs(t).value), quoteOf(t), html);
  } else if (type === 'number' || type === 'integer') {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError('not a number');
    const t = text.trim();
    out = /^0[xX]/.test(t) && Number.isInteger(value) && value >= 0 ? '0x' + (/[A-F]/.test(t) ? value.toString(16).toUpperCase() : value.toString(16)) : fmtNumber(value);
  } else if (type === 'boolean') {
    if (typeof value !== 'boolean') throw new TypeError('not on or off');
    out = /^!\s*[01]$/.test(text.trim()) ? (value ? '!0' : '!1') : String(value);
  } else if (type === 'text' || type === 'enum') {
    if (typeof value !== 'string') throw new TypeError('not text');
    const q = quoteOf(text);
    out = jsString(value, q, html);
  } else if (type === 'json' || type === 'colors') out = formatJs(value, text, {html});
  else throw new TypeError(`${type} is not a value type`);
  // Keep the literal from fusing with its neighbours.
  const {before = '', after = ''} = around;
  if (/^[-+]/.test(out) && /[-+]/.test(before)) out = `(${out})`;
  if (/^[\w$]/.test(out) && /[\w$]/.test(before)) out = ' ' + out;
  if (/[\w$]$/.test(out) && /[\w$]/.test(after)) out += ' ';
  if (/^\d+$/.test(out) && after === '.') out = `(${out})`;   // 5..toString() set to 7 is (7).toString()
  return out;
}

// ---- Anchors -------------------------------------------------------------------------------------------
/** What's wrong with a `source.code` object's shape, or null. */
export function codeShapeProblem(code) {
  if (!code || typeof code !== 'object' || Array.isArray(code)) return 'source.code must be {start, end, text, path}';
  if (!Number.isInteger(code.start) || !Number.isInteger(code.end) || code.start < 0 || code.end <= code.start) return 'source.code start and end must be whole offsets with start < end';
  if (typeof code.text !== 'string' || code.text.length !== code.end - code.start) return 'source.code.text must be the literal source, end - start characters long';
  if (typeof code.path !== 'string' || !code.path.trim() || code.path.length > 200) return 'source.code.path must be a readable anchor (at most 200 characters)';
  if (code.lang !== undefined && !CODE_LANGS.includes(code.lang)) return `source.code.lang must be one of ${CODE_LANGS.join(', ')}`;
  return null;
}
// Literals worth finding again by their text alone when the code around them moved: text and tables are distinctive;
// a number, colour or boolean is not (a 0.5 elsewhere in the file is a different setting).
const RELOCATABLE = new Set(['text', 'json', 'colors', 'enum']);
/**
 * Where a code slot's literal is in `fileText` now: {start, end, text, before, after, moved}. At its offsets when the text
 * there still matches; else, for text and table slots whose literal (8+ characters) occurs exactly once, there (moved: true).
 * Null when it can't be found (stale: re-anchor with asset-manifest/scan-code.mjs --write).
 */
export function locateCode(fileText, slot) {
  const code = codeOf(slot);
  if (!code || typeof fileText !== 'string' || codeShapeProblem(code)) return null;
  const at = (start, moved) => ({start, end: start + code.text.length, text: code.text, before: fileText[start - 1] ?? '', after: fileText[start + code.text.length] ?? '', moved});
  if (fileText.slice(code.start, code.end) === code.text) return at(code.start, false);
  if (!RELOCATABLE.has(slot.type) || code.text.length < 8) return null;
  const first = fileText.indexOf(code.text);
  return first >= 0 && fileText.indexOf(code.text, first + 1) < 0 ? at(first, true) : null;
}
export const STALE = 'The game’s code changed since this value was described, so Studio can’t find it any more.';

/** True when two [start, end) ranges share a character. */
export const rangesOverlap = (a, b) => a.start < b.end && b.start < a.end;

// ---- A file path the game keeps as a string in its code (round 2: `source.pathRef: {file, literal: true}`) -----------
// asset-manifest/unpack-data-urls.mjs moves an image a page inlined as a data: URL to art/<name>.<ext> and leaves
// the path in the string literal the URL was in. Like a JSON `pathRef`, this lets Studio save a replacement in another
// format: the file goes beside the old one with the new extension, and every string literal in `pathRef.file` that is
// exactly the old path (or `./` + it) is rewritten to the new one as an ordinary code edit (spliced the same way as a value).
/** True for a pathRef that says the game reads the slot's path from string literals in a code file. */
export const isLiteralPathRef = ref => !!ref && typeof ref === 'object' && !Array.isArray(ref) && ref.literal === true && typeof ref.file === 'string';
/** Every string literal in `text` whose content is exactly `path` (or `./path`): a JS string ('…', "…", `…`), an HTML
 *  attribute value, or a CSS url(…). [{start, end, text}] over the content, quotes excluded, in file order. */
export function pathLiterals(text, path) {
  const out = [];
  if (typeof text !== 'string' || typeof path !== 'string' || !path || /["'`\\\n]/.test(path)) return out;
  for (const p of [path, `./${path}`]) {
    for (let i = text.indexOf(p); i >= 0; i = text.indexOf(p, i + 1)) {
      const before = text[i - 1], after = text[i + p.length];
      const quoted = (before === '"' || before === "'" || before === '`') && after === before && text[i - 2] !== '\\';
      const url = /url\(\s*$/.test(text.slice(Math.max(0, i - 8), i)) && /^\s*\)/.test(text.slice(i + p.length, i + p.length + 8));
      if (quoted || url) out.push({start: i, end: i + p.length, text: p});
    }
  }
  return out.sort((a, b) => a.start - b.start);
}
/** The code edits that point every literal holding `from` at `to` instead (a `./` stays): [{start, end, text, replacement}]. */
export const pathRefEdits = (text, from, to) => pathLiterals(text, from).map(l => ({...l, replacement: l.text.startsWith('./') && !from.startsWith('./') ? `./${to}` : to}));

/**
 * `text` with `edits` ([{start, end, replacement, text?}]) applied from the end. An edit whose `text` no longer matches
 * the file is stale, and overlapping edits (or two at one place) are refused: both throw, and nothing is applied.
 */
export function spliceCode(text, edits) {
  const list = [...edits].sort((a, b) => a.start - b.start || a.end - b.end);
  for (const [i, e] of list.entries()) {
    if (!Number.isInteger(e.start) || !Number.isInteger(e.end) || e.start < 0 || e.end < e.start || e.end > text.length) throw Object.assign(new RangeError(`edit ${e.start}-${e.end} is outside the file`), {code: 'range'});
    if (typeof e.text === 'string' && text.slice(e.start, e.end) !== e.text) throw Object.assign(new Error(`the code at ${e.start}-${e.end} is no longer ${JSON.stringify(e.text.slice(0, 40))}`), {code: 'stale'});
    if (typeof e.replacement !== 'string') throw new TypeError('edit without a replacement');
    if (i && (list[i - 1].end > e.start || (list[i - 1].start === e.start))) throw Object.assign(new Error(`edits at ${list[i - 1].start}-${list[i - 1].end} and ${e.start}-${e.end} overlap`), {code: 'overlap'});
  }
  let out = text;
  for (const e of list.reverse()) out = out.slice(0, e.start) + e.replacement + out.slice(e.end);
  return out;
}

/**
 * The anchors of one file's code slots after `edits` were spliced into it (`newText`). `anchors`: [{id, start, end,
 * text}] where each slot is now (locateCode). An edited slot gets its replacement's range; a slot after an edit shifts;
 * a slot that contains an edit (a table around a number) grows or shrinks and re-reads its text; a slot inside an edit
 * is found again inside the replacement when its text occurs there once. Returns {id: {start, end, text}}; throws when
 * a slot partly overlaps an edit or can't be found again.
 */
export function shiftAnchors(anchors, edits, newText) {
  const list = [...edits].sort((a, b) => a.start - b.start);
  const out = {};
  // Map an old offset to the new text: every edit wholly before it shifts it by its change in length.
  const map = pos => { let d = 0; for (const e of list) if (e.end <= pos) d += e.replacement.length - (e.end - e.start); return pos + d; };
  for (const a of anchors) {
    const same = list.find(e => e.start === a.start && e.end === a.end);
    if (same) { const s = map(a.start); out[a.id] = {start: s, end: s + same.replacement.length}; }
    else {
      const inside = list.find(e => e.start <= a.start && a.end <= e.end);
      const partial = list.find(e => rangesOverlap(e, a) && !(e.start <= a.start && a.end <= e.end) && !(a.start <= e.start && e.end <= a.end));
      if (partial) throw Object.assign(new Error(`a change at ${partial.start}-${partial.end} cuts through ${a.id}`), {code: 'overlap', id: a.id});
      if (inside) {
        const s = map(inside.start), i = inside.replacement.indexOf(a.text);
        if (i < 0 || inside.replacement.indexOf(a.text, i + 1) >= 0) throw Object.assign(new Error(`${a.id} sits inside a changed literal and can't be found again`), {code: 'lost', id: a.id});
        out[a.id] = {start: s + i, end: s + i + a.text.length};
      } else {
        // Before, after, or around edits: the start moves with edits before it, the end with edits before the end.
        let ds = 0, de = 0;
        for (const e of list) { const d = e.replacement.length - (e.end - e.start); if (e.end <= a.start) ds += d; if (e.end <= a.end) de += d; }
        out[a.id] = {start: a.start + ds, end: a.end + de};
      }
    }
    out[a.id].text = newText.slice(out[a.id].start, out[a.id].end);
  }
  return out;
}
