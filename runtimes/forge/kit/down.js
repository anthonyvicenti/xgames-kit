// gf-forge: down and revive on the screen (wave 2, track G), vendored into a game as gf/forge/down.js (never edited
// there). The Rust core decides who is down and how far a revive is (forge-feel revive.rs: with a friend standing, a
// player at zero health is down, not out; a friend within reach holding interact brings them back). This draws what
// a player needs to act on it, on the shared HUD's layer:
//
//   a marker over each downed friend   where they lie (held to the screen's edge when they are out of view), in their
//                                      colour, with a ring that fills as someone revives them
//   the prompt                         beside a downed friend: "Hold E to revive Ana" (the kit's prompt line), and the
//                                      ring in the middle of the screen while this player holds it
//   down yourself                      "You are down" with who is bringing you back and the same ring
//
// Every word is a slot (spec.forge.player.revive.text), colours are the players' own and the theme's variables with
// fallbacks. Track U's HUD may draw its own from the same facts (window.__game.forge.run()): `down.hide(true)` turns
// this one off.
//
//   const down = createDown(ctx);     // ctx.forge, ctx.ui, ctx.tables, ctx.players
//   down.update(list)                 // every frame: list = [{nid, name, color, local, at: {x, y, z}, height, down,
//                                     //                       revive (0..1), reviver (a core id, 0 nobody), alive}]
//   down.observe()                    // what is shown
import { project } from './players.js';

const CSS = `
#gf-ui .gf-forge-down{position:absolute;inset:0;pointer-events:none;font-family:var(--gf-forge-serif,Georgia,"Times New Roman",serif)}
#gf-ui .gf-forge-mark{position:absolute;left:0;top:0;display:flex;flex-direction:column;align-items:center;gap:2px;transform:translate(-50%,-100%);will-change:transform;text-shadow:0 1px 0 #000,0 0 6px #000}
#gf-ui .gf-forge-mark svg{width:46px;height:46px;overflow:visible;filter:drop-shadow(0 1px 2px #000c)}
#gf-ui .gf-forge-mark.edge svg{width:34px;height:34px}
#gf-ui .gf-forge-mark b{font-size:13px;letter-spacing:.14em;text-transform:uppercase;color:var(--c,#fff)}
#gf-ui .gf-forge-mark em{font-style:normal;font-size:12px;opacity:.9}
#gf-ui .gf-forge-ring circle{fill:none;stroke-width:5}
#gf-ui .gf-forge-ring .bg{stroke:#000a}
#gf-ui .gf-forge-ring .fg{stroke:var(--c,var(--gf-forge-accent,#d3a446));stroke-linecap:butt;transform:rotate(-90deg);transform-origin:50% 50%}
#gf-ui .gf-forge-ring .x{stroke:var(--c,#fff);stroke-width:4}
#gf-ui .gf-forge-self{position:absolute;left:50%;top:62%;transform:translate(-50%,0);display:none;flex-direction:column;align-items:center;gap:6px;text-align:center;color:var(--gf-forge-parchment,#e4d2b7);text-shadow:0 2px 0 #000,0 0 10px #000}
#gf-ui .gf-forge-self.on{display:flex}
#gf-ui .gf-forge-self h2{margin:0;font-size:clamp(22px,4.4vh,40px);letter-spacing:.06em;color:#ff8a70}
#gf-ui .gf-forge-self p{margin:0;font-size:clamp(13px,2.2vh,18px);font-style:italic;opacity:.9}
#gf-ui .gf-forge-self svg{width:64px;height:64px}
#gf-ui .gf-forge-doing{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);display:none;flex-direction:column;align-items:center;gap:8px;color:var(--gf-forge-parchment,#e4d2b7);text-shadow:0 2px 0 #000,0 0 8px #000;font-size:clamp(13px,2.1vh,17px)}
#gf-ui .gf-forge-doing.on{display:flex}
#gf-ui .gf-forge-doing svg{width:72px;height:72px}
`;
// a text is written only when it changes: writing the same words again would lay the HUD out every frame
const say = (e, t) => { if (e.textContent !== t) e.textContent = t; };
const SVG = 'http://www.w3.org/2000/svg';
const R = 19, LEN = 2 * Math.PI * R;
const fill = (s, vars) => String(s ?? '').replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));

function ring(cross = false) {
  const s = document.createElementNS(SVG, 'svg'); s.setAttribute('viewBox', '0 0 46 46'); s.classList.add('gf-forge-ring');
  const mk = cls => { const c = document.createElementNS(SVG, 'circle'); c.setAttribute('cx', 23); c.setAttribute('cy', 23); c.setAttribute('r', R); c.classList.add(cls); return c; };
  const bg = mk('bg'), fg = mk('fg'); fg.setAttribute('stroke-dasharray', `0 ${LEN}`);
  s.append(bg, fg);
  if (cross) for (const d of ['M23 13 V33', 'M13 23 H33']) { const p = document.createElementNS(SVG, 'path'); p.setAttribute('d', d); p.classList.add('x'); p.setAttribute('fill', 'none'); s.append(p); }
  return { svg: s, set: share => fg.setAttribute('stroke-dasharray', `${Math.max(0, Math.min(1, share)) * LEN} ${LEN}`) };
}

export function createDown(ctx, { host = ctx.forge, root = ctx.ui?.root } = {}) {
  if (!host || !root) return null;
  if (!document.getElementById('gf-forge-down-css')) { const s = document.createElement('style'); s.id = 'gf-forge-down-css'; s.textContent = CSS; document.head.append(s); }
  const cfg = ctx.tables?.player?.revive ?? {}, W = cfg.text ?? {}, range = Number(cfg.range) || 2;
  const word = (k, d) => (typeof W[k] === 'string' && W[k] ? W[k] : d);
  const layer = document.createElement('div'); layer.className = 'gf-forge-down';
  const self = document.createElement('div'); self.className = 'gf-forge-self'; const selfRing = ring(true), selfH = document.createElement('h2'), selfP = document.createElement('p'); self.append(selfH, selfRing.svg, selfP);
  const doing = document.createElement('div'); doing.className = 'gf-forge-doing'; const doingRing = ring(true), doingP = document.createElement('span'); doing.append(doingRing.svg, doingP);
  layer.append(self, doing); root.append(layer);
  const marks = new Map();    // nid → {e, ring, name, label}
  let hidden = false, shown = { marks: [], self: null, prompt: null, doing: null }, prompted = false;
  // on a phone: the touch button's own name, as it shows under it (gf/forge/hud.js)
  const keyName = () => (ctx.input?.touch ? ctx.forgeHud?.touchLabel?.('use') ?? 'Use' : word('key', 'E'));

  // `watching` (wave 4, a stream's viewer: gf/forge/players.js): the list's local player is the one being watched, not
  // this copy's own. The same marks and rings, said of them by name, and no prompt (a viewer holds no key).
  function update(list, { watching = false } = {}) {
    if (hidden) return;
    const cam = host.drawnCamera(), w = innerWidth || 1, h = innerHeight || 1;
    const me = list.find(p => p.local) ?? null;
    const seen = new Set(); shown = { marks: [], self: null, prompt: null, doing: null };
    let near = null;
    for (const p of list) {
      if (p.local || !p.down) continue;
      seen.add(p.nid);
      let m = marks.get(p.nid);
      if (!m) { const e = document.createElement('div'); e.className = 'gf-forge-mark'; const r = ring(true), b = document.createElement('b'), em = document.createElement('em'); e.append(r.svg, b, em); layer.append(e); m = { e, ring: r, b, em }; marks.set(p.nid, m); }
      m.e.style.setProperty('--c', p.color);
      m.ring.set(p.revive); say(m.b, word('mark', 'down')); say(m.em, p.name);
      // over the body where it lies; held to the screen's edge when it is behind or beside the view
      const at = { x: p.at.x, y: p.at.y + 0.9, z: p.at.z };
      let v = project(cam, at, w / h), edge = false;
      if (!v) { const dx = at.x - cam.x, dz = at.z - cam.z, side = Math.cos(cam.yaw) * dx - Math.sin(cam.yaw) * dz; v = { x: side >= 0 ? 0.92 : -0.92, y: -0.2 }; edge = true; }
      else if (Math.abs(v.x) > 0.92 || Math.abs(v.y) > 0.86) { v = { x: Math.max(-0.92, Math.min(0.92, v.x)), y: Math.max(-0.8, Math.min(0.86, v.y)) }; edge = true; }
      const x = (v.x * 0.5 + 0.5) * w, y = (-v.y * 0.5 + 0.5) * h;
      m.e.classList.toggle('edge', edge);
      m.e.style.transform = `translate(${Math.round(x)}px,${Math.round(y)}px) translate(-50%,-100%)`;
      const d = me ? Math.hypot(p.at.x - me.at.x, p.at.z - me.at.z) : Infinity;
      shown.marks.push({ player: p.nid, name: p.name, revive: Math.round(p.revive * 1000) / 1000, reviver: p.reviver, x: Math.round(x), y: Math.round(y), edge, distance: Math.round(d * 100) / 100 });
      if (me?.alive && d <= range && (!near || d < near.d)) near = { p, d };
    }
    for (const [nid, m] of marks) if (!seen.has(nid)) { m.e.remove(); marks.delete(nid); }
    // this player beside a downed friend: the prompt, and the ring while they hold it
    const mine = me ? list.find(p => p.down && p.reviver === me.nid) : null;
    if (mine) { doing.classList.add('on'); doingRing.set(mine.revive); say(doingP, fill(word('doing', 'Reviving {name}'), { name: mine.name })); shown.doing = { player: mine.nid, name: mine.name, revive: mine.revive }; }
    else doing.classList.remove('on');
    const text = near && !mine && !watching ? fill(word('hold', 'Hold {key} to revive {name}'), { key: keyName(), name: near.p.name }) : null;
    if (text) { ctx.ui?.prompt?.(text, 'forge-revive'); prompted = true; shown.prompt = text; }
    else if (prompted) { ctx.ui?.prompt?.(null, 'forge-revive'); prompted = false; }
    // down yourself
    if (me?.down) {
      const by = me.reviver ? list.find(p => p.nid === me.reviver) : null;
      self.classList.add('on'); say(selfH, watching ? fill(word('downThem', '{name} is down'), { name: me.name }) : word('down', 'You are down')); selfRing.set(me.revive);
      say(selfP, watching ? (by ? fill(word('beingThem', '{name} is bringing them back'), { name: by.name }) : word('waitThem', 'A friend can bring them back'))
        : by ? fill(word('being', '{name} is bringing you back'), { name: by.name }) : word('wait', 'A friend can bring you back'));
      shown.self = { revive: me.revive, by: by?.name ?? null, text: selfP.textContent };
    } else self.classList.remove('on');
  }

  return {
    update,
    /** Track U's HUD draws these facts itself: turn this one off (or on again). */
    hide(on = true) { hidden = !!on; layer.style.display = hidden ? 'none' : ''; if (hidden && prompted) { ctx.ui?.prompt?.(null, 'forge-revive'); prompted = false; } },
    observe: () => JSON.parse(JSON.stringify({ hidden, ...shown })),
    dispose() { layer.remove(); },
  };
}
