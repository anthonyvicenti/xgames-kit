// gf-forge's build line (wave 7, track B: builds), vendored into a game as gf/forge/builds.js (never edited there). The
// creator, 2026-10-12: "We should incorporate fun builds people can go. Tank AOE damage build, high damage low health
// build, ect" — they chose "Families + set bonuses". The core (forge-feel perks.rs) holds what a player's cards add up
// to; this shows it, small, in the player's own card of the HUD:
//
//   the line    one chip a family the player holds a card of: its colour, a pip a card toward its set bonus ("◆◆◇")
//               and its plain label (Tank, Blast, Glass Cannon, Swift); a family whose set is complete is filled in
//               its colour with a star. Nothing at all until the first family card, so a game without families, or a
//               run before its first reward, shows nothing more than before. Two marks for perks that wait or run: a
//               sure critical waiting after an evade, and the rush after a kill.
//   the banner  a set bonus completed: the bonus's name, and "Tank set bonus · what it does" under it (the deal's
//               words, slots: deal.text.bonus, bonusSub); held back while this player is still choosing a card, so it
//               is seen. A friend's completed set is a toast ("Mara: Iron Bell").
//
// The creator said the HUD on the right takes up too much of a phone's screen: the line sits in the player's card (the
// vitals' corner, clear of the thumbs and of the aim), wraps within it, and its chips are 11 px tall on a phone.
//
//   const b = createBuilds(ctx, {host, read, word, nidOf, nameOf});   // gf/forge/cards.js makes it
//   b.update()      every frame (reads the core's run a few times a second)
//   b.observe()     {shown, chips: [{id, label, n, at, done}], perks, rush, primed, rect, banners}
import { PERKS } from './tables/cards.js';

const CSS = `
#gf-ui .gf-fb{display:none;flex-wrap:wrap;gap:4px 8px;align-items:center;max-width:280px;pointer-events:none;font:700 10px/1 var(--gf-forge-serif,Georgia,serif);letter-spacing:.12em;text-transform:uppercase;text-shadow:0 1px 0 #000,0 0 4px #000c}
#gf-ui .gf-fb.on{display:flex}
#gf-ui .gf-fb b{display:inline-flex;align-items:center;gap:4px;padding:2px 5px 2px 4px;border-radius:2px;color:var(--f);background:color-mix(in srgb,var(--g-ink,#0c0907) 55%,transparent);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--f) 45%,transparent);white-space:nowrap}
#gf-ui .gf-fb b i{display:inline-flex;gap:2px}
#gf-ui .gf-fb b i u{display:block;width:5px;height:5px;transform:rotate(45deg);box-shadow:inset 0 0 0 1px var(--f)}
#gf-ui .gf-fb b i u.on{background:var(--f)}
#gf-ui .gf-fb b.done{background:var(--f);color:#14100b;box-shadow:0 0 8px color-mix(in srgb,var(--f) 60%,transparent)}
#gf-ui .gf-fb b.done::before{content:"★";font-size:10px;letter-spacing:0}
#gf-ui .gf-fb b.done i{display:none}
#gf-ui .gf-fb em{font-style:normal;padding:2px 5px;border-radius:2px;color:#14100b;background:var(--c)}
#gf-ui .gf-fb em:empty{display:none}
#gf-ui .gf-fb b.new{animation:gf-fb-pop .5s ease-out}
@keyframes gf-fb-pop{0%{transform:scale(1.35)}100%{transform:scale(1)}}
#gf-ui.gf-fh-touch .gf-fb{max-width:200px;font-size:9px;gap:3px 6px}
#gf-ui.gf-fh-touch .gf-fb b{padding:1px 4px 1px 3px}
@media (orientation:portrait){#gf-ui.gf-fh-touch.gf-fb-on .gf-fh-friends{top:calc(max(9px,env(safe-area-inset-top)) + 152px)}}
`;

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const fill = (s, v) => String(s ?? '').replace(/\{(\w+)\}/g, (m, k) => (k in v && v[k] != null ? String(v[k]) : ''));

export function createBuilds(ctx, { host = ctx.forge, read, word = (k, d) => d, nidOf, nameOf = n => `Player ${n}` } = {}) {
  const ui = ctx.ui, root = ui?.root, T = ctx.tables ?? {};
  const families = Array.isArray(T.families) ? T.families : [];
  const hasPerks = (Array.isArray(T.cards) ? T.cards : []).some(c => c?.kind === 'perk');
  if (!root || !host || (!families.length && !hasPerks)) return null;
  if (!document.getElementById('gf-fb-css')) { const s = el('style'); s.id = 'gf-fb-css'; s.textContent = CSS; document.head.append(s); }
  const line = el('div', 'gf-fb'); line.dataset.widget = 'forge-build';
  const marks = { primed: el('em'), rush: el('em') };
  marks.primed.style.setProperty('--c', '#b9cbff'); marks.rush.style.setProperty('--c', '#ffd77a');
  // in the player's card, over the vitals (gf/forge/hud.js puts them there); else at the card's end
  const place = () => {
    if (line.isConnected) return true;
    const card = root.querySelector('#gf-hud'); if (!card) return false;
    const vitals = card.querySelector('.gf-fh-vitals');
    card.insertBefore(line, vitals ?? null);
    return true;
  };
  const S = { t: 0, key: '', chips: [], perks: [], rush: 0, primed: false, banners: [], queue: [], last: null };
  const chooser = () => { const r = document.getElementById('gf-forge-reward'); return !!r && r.classList.contains('on') && !r.classList.contains('waiting'); };

  const offRule = host.on?.('rule', e => {
    if (e.name !== 'set-bonus') return;
    const F = families[e.a | 0]; if (!F) return;
    const mine = (e.entity | 0) === nidOf?.();
    const vars = { bonus: F.bonus?.name || F.name || F.id, label: F.label || F.name || F.id, name: F.name || F.id, text: F.bonus?.text || F.text || '', player: nameOf(e.entity) };
    S.queue.push({ mine, vars, family: F.id, at: performance.now() });
  });

  function show(b) {
    if (b.mine) ui.banner?.(fill(word('bonus', '{bonus}'), b.vars), 2.8, { sub: fill(word('bonusSub', '{label} set bonus · {text}'), b.vars), tone: 'ember' });
    else ui.toast?.(fill(word('friendBonus', '{player}: {bonus}'), b.vars));
    S.banners.push({ family: b.family, mine: b.mine, text: b.mine ? fill(word('bonus', '{bonus}'), b.vars) : fill(word('friendBonus', '{player}: {bonus}'), b.vars), t: Math.round((ctx.time?.now ?? 0) * 1000) / 1000 });
    if (S.banners.length > 16) S.banners.shift();
  }

  function draw(me) {
    const counts = me?.build?.families ?? [], bonuses = me?.build?.bonuses ?? [];
    const chips = families.map((F, i) => ({ id: F.id, label: F.label || F.name || F.id, color: F.color || '#c9a26b', n: counts[i] | 0, at: Math.max(1, F.at | 0 || 3), done: bonuses.includes(i) })).filter(c => c.n > 0);
    const perks = Object.keys(me?.build?.perks ?? {});
    const rush = Number(me?.build?.rush) || 0, primed = !!me?.build?.primed;
    const key = JSON.stringify([chips.map(c => [c.id, c.n, c.done]), rush > 0, primed]);
    S.chips = chips; S.perks = perks; S.rush = rush; S.primed = primed;
    if (key === S.key) return;
    const before = new Map((S.lastChips ?? []).map(c => [c.id, c]));
    S.key = key; S.lastChips = chips;
    line.replaceChildren();
    for (const c of chips) {
      const b = el('b', c.done ? 'done' : ''); b.style.setProperty('--f', c.color); b.dataset.family = c.id;
      const pips = el('i'); for (let k = 0; k < c.at; k++) pips.append(el('u', k < c.n ? 'on' : ''));
      b.append(pips, el('span', null, c.label));
      const was = before.get(c.id); if (!was || was.n !== c.n || was.done !== c.done) b.classList.add('new');
      line.append(b);
    }
    marks.primed.textContent = primed ? (PERKS.ambush ? '✦' : '') : '';
    marks.rush.textContent = rush > 0 ? '»' : '';
    marks.primed.title = 'A sure critical waiting'; marks.rush.title = 'Rushing';
    line.append(marks.primed, marks.rush);
    const on = chips.length > 0 || primed || rush > 0;
    line.classList.toggle('on', on); root.classList.toggle('gf-fb-on', on);
  }

  return {
    update() {
      if (!place()) return;
      const now = performance.now();
      // a banner waits while this player still chooses a card (it would be under the reward screen)
      if (S.queue.length && !chooser()) for (const b of S.queue.splice(0)) show(b);
      if (now - S.t < 220) return;
      S.t = now;
      const run = read?.(); if (!run) return;
      S.last = run;
      draw(run.players?.find(p => p.id === nidOf?.()) ?? null);
    },
    observe() {
      const r = line.isConnected ? line.getBoundingClientRect() : null;
      return { shown: line.classList.contains('on'), chips: S.chips.map(c => ({ ...c })), perks: S.perks.slice(), rush: S.rush, primed: S.primed, rect: r ? [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] : null, banners: S.banners.slice(), waiting: S.queue.length };
    },
    dispose() { offRule?.(); line.remove(); root.classList.remove('gf-fb-on'); },
  };
}
