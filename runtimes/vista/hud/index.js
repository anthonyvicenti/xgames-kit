// gf-vista's HUD parts (research/super-scenic/THIN_E2E.md, interface I3): our own DOM for the core's fishing game,
// fed by the game bridge (kit/game.js), styled with the shared theme's CSS variables (--gf-panel, --gf-text,
// --gf-accent; research/gf-three/kit/ui/ui.js) so it sits with the shared menu and HUD.
//
//   const hud = createVistaHud(layer, game, { words })
//     layer   a DOM element the shared HUD gives the engine (kit/ui: inside the game frame, above the canvas)
//     game    from kit/game.js
//     words   player-visible words from the game's config (every word a slot); English defaults in WORDS
//   hud.update(dt)   once a frame       hud.open(panel) / hud.close()   panel: 'cooler' | 'buyer' | 'shop'
//   hud.dispose()
// Draws: money, cooler fill, the rod's state and the bite cue, the cast's power, the fight's tension bar with its safe
// band, the catch card (species, weight, length, value), the sell panel (buyer), the shop panel (gear with prices,
// owned / affordable, fuel), the cooler panel, toasts and the prompt (what the keys do now).
// Islands (wave 3 track H, kit/islands.js): the island's name, "Island 2 of 3", the island ahead with its distance, and
// the reason a trip is refused ("Buy the boat keys at the tackle shop") while the boat is out at sea heading for it.
// Keyboard and mouse: E at a vendor opens its panel (the core's key), Esc or E closes, the panels' buttons take clicks,
// and in a panel Enter does the first thing (sell all; buy the selected row), Up/Down choose a row. The bridge
// releases the pointer lock while a panel is open.
export const VERSION = '0.1.0-thin';

export const WORDS = {
  currency: '$',
  money: 'Money',
  cooler: 'Cooler',
  kg: 'kg',
  cm: 'cm',
  m: 'm',
  sellAll: 'Sell all',
  total: 'Total',
  empty: 'Your cooler is empty.',
  nothingHere: 'Nothing to sell? Try the end of the pier.',
  buy: 'Buy',
  owned: 'Owned',
  fuel: 'Fuel',
  fillUp: 'Fill up',
  full: 'Full',
  perLitre: '/ L',
  close: 'Close',
  caught: 'Caught',
  weight: 'Weight',
  length: 'Length',
  value: 'Value',
  newSpecies: 'New species!',
  record: 'New record!',
  released: 'No room: let go',
  tension: 'Tension',
  power: 'Cast',
  strike: 'Strike!',
  bite: 'Bite!',
  log: 'Caught so far',
  keyLMB: 'Left mouse',
  keyRMB: 'Right mouse',
  kinds: { line: 'Line', reel: 'Reel', rod: 'Rod', hold: 'Cooler', tank: 'Fuel tank', engine: 'Engine', finder: 'Electronics', lights: 'Lights', item: 'Item' },
};

// the money, cooler and fuel stand under the menu button and clear of the friends page's LIVE badge (gf/mp party.css
// .live-badge: top 58 px, about 30 px tall), which sits over the top left of the game while a room is streamed
const CSS = `
.gfv-hud{position:absolute;inset:0;pointer-events:none;font:600 15px/1.3 system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--gf-text,#fff);user-select:none;-webkit-user-select:none;z-index:6}
.gfv-hud *{box-sizing:border-box}
.gfv-pill{background:var(--gf-panel,#1c2133cc);border-radius:999px;padding:6px 14px;box-shadow:0 2px 12px #0004}
.gfv-stats{position:absolute;top:max(98px,calc(env(safe-area-inset-top) + 88px));left:max(12px,env(safe-area-inset-left));display:flex;flex-direction:column;gap:6px;align-items:flex-start}
.gfv-money{font-size:20px;font-variant-numeric:tabular-nums}
.gfv-cool{min-width:180px;border-radius:12px;padding:6px 12px 8px}
.gfv-cool b{display:flex;justify-content:space-between;gap:12px;font-size:13px;opacity:.9;font-variant-numeric:tabular-nums}
.gfv-bar{position:relative;height:8px;border-radius:4px;background:#ffffff26;overflow:hidden;margin-top:5px}
.gfv-bar u{position:absolute;left:0;top:0;bottom:0;background:var(--gf-accent,#ff7a59);border-radius:4px}
.gfv-cool.full u{background:#e5484d}
.gfv-fuel{font-size:13px}
.gfv-prompt{position:absolute;left:50%;bottom:max(104px,calc(env(safe-area-inset-bottom) + 94px));transform:translateX(-50%);display:none;align-items:center;gap:10px;white-space:nowrap;max-width:92vw;overflow:hidden;text-overflow:ellipsis}
.gfv-prompt kbd{font:700 12px/1 system-ui,sans-serif;background:var(--gf-text,#fff);color:#111;border-radius:6px;padding:4px 7px}
.gfv-bite{position:absolute;left:50%;top:38%;transform:translate(-50%,-50%) scale(.8);opacity:0;transition:opacity .12s,transform .12s;font:900 clamp(40px,7vw,76px)/1 system-ui,sans-serif;color:var(--gf-accent,#ff7a59);text-shadow:0 3px 0 #0008,0 0 24px #000a;text-align:center}
.gfv-bite small{display:block;font-size:.32em;color:var(--gf-text,#fff);margin-top:6px}
.gfv-bite.on{opacity:1;transform:translate(-50%,-50%) scale(1);animation:gfv-pulse .5s ease-in-out infinite alternate}
@keyframes gfv-pulse{to{transform:translate(-50%,-50%) scale(1.08)}}
.gfv-meter{position:absolute;left:50%;bottom:max(150px,calc(env(safe-area-inset-bottom) + 140px));transform:translateX(-50%);width:min(440px,80vw);border-radius:14px;padding:8px 14px 10px;display:none}
.gfv-meter b{display:flex;justify-content:space-between;font-size:13px;opacity:.9;font-variant-numeric:tabular-nums}
.gfv-meter .gfv-bar{height:14px;border-radius:7px;margin-top:6px;overflow:visible}
.gfv-meter .gfv-band{position:absolute;top:0;bottom:0;background:#3ecf8e66;border-left:2px solid #3ecf8e;border-right:2px solid #3ecf8e}
.gfv-meter .gfv-mark{position:absolute;top:-4px;bottom:-4px;width:4px;margin-left:-2px;border-radius:2px;background:var(--gf-text,#fff);box-shadow:0 0 6px #000}
.gfv-meter.hot .gfv-mark{background:#e5484d}
.gfv-meter.hot{box-shadow:0 0 0 2px #e5484d,0 2px 12px #0004}
.gfv-meter.power u{background:var(--gf-accent,#ff7a59)}
.gfv-toasts{position:absolute;top:max(64px,calc(env(safe-area-inset-top) + 54px));left:50%;transform:translateX(-50%);display:flex;flex-direction:column;gap:6px;align-items:center}
.gfv-toast{transition:opacity .4s;white-space:nowrap}
.gfv-card{position:absolute;right:max(16px,env(safe-area-inset-right));top:50%;transform:translateY(-50%);width:min(300px,80vw);background:var(--gf-panel,#1c2133ee);border-radius:16px;padding:16px 18px;box-shadow:0 10px 40px #0006;pointer-events:auto;opacity:0;transition:opacity .25s;display:none}
.gfv-card.on{opacity:1}
.gfv-card small{display:block;font-size:12px;letter-spacing:.12em;text-transform:uppercase;opacity:.7}
.gfv-card h2{margin:4px 0 10px;font-size:24px;line-height:1.1}
.gfv-card .gfv-tags span{display:inline-block;background:var(--gf-accent,#ff7a59);border-radius:999px;padding:2px 9px;font-size:12px;margin:0 6px 8px 0}
.gfv-card dl{display:grid;grid-template-columns:auto 1fr;gap:4px 14px;margin:0;font-variant-numeric:tabular-nums}
.gfv-card dt{opacity:.75}.gfv-card dd{margin:0;text-align:right;font-weight:800}
.gfv-panel{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:min(460px,92vw);max-height:min(560px,84vh);display:none;flex-direction:column;background:var(--gf-panel,#1c2133f2);border-radius:18px;padding:18px 20px 16px;box-shadow:0 10px 40px #0007;pointer-events:auto}
.gfv-panel.on{display:flex}
.gfv-panel h2{margin:0;font-size:22px}
.gfv-panel p{margin:4px 0 12px;opacity:.8;font-weight:500}
.gfv-rows{overflow:auto;display:flex;flex-direction:column;gap:4px;margin:0 -6px;padding:0 6px}
.gfv-row{display:grid;grid-template-columns:1fr auto auto;gap:10px;align-items:center;padding:6px 8px;border-radius:10px;font-variant-numeric:tabular-nums}
.gfv-row.sel{background:#ffffff1a}
.gfv-row small{display:block;font-size:12px;opacity:.65;font-weight:500}
.gfv-row .dim{opacity:.55}
.gfv-panel button{font:inherit;font-size:15px;border:0;border-radius:999px;padding:7px 16px;background:var(--gf-accent,#ff7a59);color:#fff;cursor:pointer}
.gfv-panel button:disabled{opacity:.4;cursor:default}
.gfv-panel button.ghost{background:transparent;box-shadow:inset 0 0 0 1px #ffffff55}
.gfv-panel button:focus-visible{outline:2px solid var(--gf-text,#fff);outline-offset:2px}
.gfv-foot{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-top:12px}
.gfv-foot b{font-variant-numeric:tabular-nums}
.gfv-isle{position:absolute;top:max(64px,calc(env(safe-area-inset-top) + 54px));right:max(12px,env(safe-area-inset-right));display:none;flex-direction:column;align-items:flex-end;gap:6px;max-width:min(360px,46vw)}
.gfv-isle .gfv-pill{border-radius:14px;padding:7px 14px;text-align:right}
.gfv-isle b{display:block;font-size:17px}
.gfv-isle small{display:block;font-size:12px;opacity:.75;font-weight:500;letter-spacing:.04em}
.gfv-isle .gfv-next{font-size:13px;font-weight:600}
.gfv-isle .gfv-why{font-size:13px;background:var(--gf-accent,#ff7a59);color:#fff;display:none}
`;

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function createVistaHud(layer, game, { words = {} } = {}) {
  const W = { ...WORDS, ...(game?.words ?? {}), ...words, kinds: { ...WORDS.kinds, ...(words.kinds ?? {}) } };
  const cash = n => `${W.currency}${Math.round(n).toLocaleString('en-US')}`;
  if (!document.getElementById('gfv-hud-css')) {
    const st = document.createElement('style');
    st.id = 'gfv-hud-css';
    st.textContent = CSS;
    document.head.append(st);
  }
  const root = document.createElement('div');
  root.className = 'gfv-hud';
  root.id = 'gfv-hud';
  root.innerHTML = `
    <div class="gfv-stats"><div class="gfv-pill gfv-money" id="gfv-money" title="${esc(W.money)}"></div>
      <div class="gfv-pill gfv-cool" id="gfv-cooler"><b><span>${esc(W.cooler)}</span><span id="gfv-cooler-kg"></span></b><div class="gfv-bar"><u></u></div></div>
      <div class="gfv-pill gfv-fuel" id="gfv-fuel" hidden></div></div>
    <div class="gfv-toasts" id="gfv-toasts" aria-live="polite"></div>
    <div class="gfv-isle" id="gfv-isle"><div class="gfv-pill"><b id="gfv-isle-name"></b><small id="gfv-isle-of"></small></div>
      <div class="gfv-pill gfv-next" id="gfv-isle-next"></div><div class="gfv-pill gfv-why" id="gfv-isle-why" role="status"></div></div>
    <div class="gfv-bite" id="gfv-bite" role="status"><span>${esc(W.bite)}</span><small>${esc(W.strike)}</small></div>
    <div class="gfv-pill gfv-meter" id="gfv-meter"><b><span id="gfv-meter-label"></span><span id="gfv-meter-value"></span></b><div class="gfv-bar"><div class="gfv-band"></div><u></u><i class="gfv-mark"></i></div></div>
    <div class="gfv-pill gfv-prompt" id="gfv-prompt"><kbd></kbd><span></span></div>
    <div class="gfv-card" id="gfv-catch" role="status"></div>
    <div class="gfv-panel" id="gfv-panel" role="dialog" aria-modal="false"></div>`;
  layer.append(root);
  const $ = id => root.querySelector('#' + id);
  const el = { money: $('gfv-money'), cooler: $('gfv-cooler'), coolerKg: $('gfv-cooler-kg'), fuel: $('gfv-fuel'), toasts: $('gfv-toasts'), bite: $('gfv-bite'), meter: $('gfv-meter'), meterLabel: $('gfv-meter-label'), meterValue: $('gfv-meter-value'), prompt: $('gfv-prompt'), card: $('gfv-catch'), panel: $('gfv-panel'),
    isle: $('gfv-isle'), isleName: $('gfv-isle-name'), isleOf: $('gfv-isle-of'), isleNext: $('gfv-isle-next'), isleWhy: $('gfv-isle-why') };
  const band = el.meter.querySelector('.gfv-band'), mark = el.meter.querySelector('.gfv-mark'), fillU = el.meter.querySelector('u');

  // ---- toasts
  function toast(text, ms = 2600) {
    const t = document.createElement('div');
    t.className = 'gfv-pill gfv-toast';
    t.textContent = text;
    el.toasts.append(t);
    while (el.toasts.children.length > 3) el.toasts.firstChild.remove();
    setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 450); }, ms);
  }

  // ---- the catch card
  let cardT = 0;
  function showCatch(c) {
    const tags = [c.newSpecies && W.newSpecies, c.record && W.record, !c.kept && W.released].filter(Boolean);
    el.card.innerHTML = `<small>${esc(W.caught)}</small><h2>${esc(c.name)}</h2>${tags.length ? `<div class="gfv-tags">${tags.map(t => `<span>${esc(t)}</span>`).join('')}</div>` : ''}
      <dl><dt>${esc(W.weight)}</dt><dd>${c.kg.toFixed(2)} ${esc(W.kg)}</dd><dt>${esc(W.length)}</dt><dd>${c.cm} ${esc(W.cm)}</dd><dt>${esc(W.value)}</dt><dd>${cash(c.value)}</dd></dl>`;
    el.card.dataset.species = c.species;
    el.card.style.display = 'block';
    requestAnimationFrame(() => el.card.classList.add('on'));
    cardT = 6;
  }
  function hideCatch() { el.card.classList.remove('on'); el.card.style.display = 'none'; cardT = 0; }
  el.card.addEventListener('click', hideCatch);

  // ---- panels
  let panel = null, vendor = null, sel = 0;
  const rowsOf = () => [...el.panel.querySelectorAll('.gfv-row[data-id]')];
  function render() {
    if (!panel) { el.panel.classList.remove('on'); el.panel.innerHTML = ''; return; }
    const s = game.state();
    let body = '', foot = '';
    if (panel === 'buyer') {
      const total = s.catches.reduce((a, c) => a + c.value, 0);
      body = s.catches.length ? s.catches.map(c => `<div class="gfv-row"><span>${esc(c.name)}<small>${c.kg.toFixed(2)} ${esc(W.kg)} · ${c.cm} ${esc(W.cm)}</small></span><span></span><b>${cash(c.value)}</b></div>`).join('') : `<p>${esc(W.nothingHere)}</p>`;
      foot = `<b>${esc(W.total)}: ${cash(total)}</b><span><button class="ghost" data-act="close">${esc(W.close)}</button> <button data-act="sell" ${s.catches.length ? '' : 'disabled'}>${esc(W.sellAll)}</button></span>`;
    } else if (panel === 'shop') {
      const items = game.shop?.() ?? [];
      const fuelMissing = s.fuel.tank - s.fuel.litres, price = Number(game.tables?.economy?.fuelPrice) || 0;
      const fuelRow = `<div class="gfv-row" data-id="fuel"><span>${esc(W.fuel)}<small>${Math.round(s.fuel.litres)} / ${s.fuel.tank} L · ${W.currency}${price.toFixed(2)} ${esc(W.perLitre)}</small></span><span></span>${fuelMissing > 0.5 ? `<button data-buy="fuel" ${s.money >= price ? '' : 'disabled'}>${esc(W.fillUp)} ${cash(Math.ceil(fuelMissing * price))}</button>` : `<span class="dim">${esc(W.full)}</span>`}</div>`;
      body = items.map(it => `<div class="gfv-row" data-id="${esc(it.id)}"><span>${esc(it.name)}<small>${esc(W.kinds[it.kind] ?? it.kind)}</small></span><b class="${it.owned ? 'dim' : ''}">${cash(it.price)}</b>${it.owned ? `<span class="dim">${esc(W.owned)}</span>` : `<button data-buy="${esc(it.id)}" ${it.affordable ? '' : 'disabled'}>${esc(W.buy)}</button>`}</div>`).join('') + fuelRow;
      foot = `<b>${esc(W.money)}: ${cash(s.money)}</b><button class="ghost" data-act="close">${esc(W.close)}</button>`;
    } else {
      body = s.catches.length ? s.catches.map(c => `<div class="gfv-row"><span>${esc(c.name)}<small>${c.kg.toFixed(2)} ${esc(W.kg)} · ${c.cm} ${esc(W.cm)}</small></span><span></span><b>${cash(c.value)}</b></div>`).join('') : `<p>${esc(W.empty)}</p>`;
      const log = Object.entries(s.log).map(([id, l]) => `${esc(game.tables?.species?.[id]?.name ?? id)}: ${l.count}`).join(' · ');
      if (log) body += `<p><small>${esc(W.log)}: ${log}</small></p>`;
      foot = `<b>${s.cooler.kg.toFixed(1)} / ${s.cooler.capacity} ${esc(W.kg)}</b><button class="ghost" data-act="close">${esc(W.close)}</button>`;
    }
    const title = panel === 'cooler' ? W.cooler : vendor?.name ?? '';
    const greet = panel === 'cooler' ? '' : vendor?.greeting ?? '';
    el.panel.innerHTML = `<h2>${esc(title)}</h2>${greet ? `<p>${esc(greet)}</p>` : ''}<div class="gfv-rows">${body}</div><div class="gfv-foot">${foot}</div>`;
    el.panel.dataset.panel = panel;
    el.panel.classList.add('on');
    const rows = rowsOf();
    sel = Math.max(0, Math.min(sel, rows.length - 1));
    rows.forEach((r, i) => r.classList.toggle('sel', i === sel));
  }
  el.panel.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b || b.disabled) return;
    if (b.dataset.act === 'close') api.close();
    else if (b.dataset.act === 'sell') { game.sell(); render(); }
    else if (b.dataset.buy) { game.buy(b.dataset.buy); render(); }
  });
  const onKey = e => {
    if (!panel) return;
    if (e.code === 'Enter' || e.code === 'NumpadEnter') {
      if (e.target?.closest?.('#gfv-panel button')) return;   // a focused button takes Enter itself (its click)
      e.preventDefault();
      if (panel === 'buyer') { game.sell(); render(); }
      else if (panel === 'shop') { const r = rowsOf()[sel]; const b = r?.querySelector('button[data-buy]'); if (b && !b.disabled) { game.buy(b.dataset.buy); render(); } }
      else api.close();
    } else if (e.code === 'ArrowDown' || e.code === 'ArrowUp') {
      const n = rowsOf().length;
      if (n) { sel = (sel + (e.code === 'ArrowDown' ? 1 : n - 1)) % n; rowsOf().forEach((r, i) => r.classList.toggle('sel', i === sel)); }
    }
  };
  addEventListener('keydown', onKey);

  const offs = [
    game.on('panel', p => { panel = p.panel; vendor = p.vendor; sel = 0; render(); }),
    game.on('toast', t => toast(t.text)),
    game.on('catch', c => showCatch(c)),
    game.on('sold', () => { if (panel) render(); }),
    game.on('bought', () => { if (panel) render(); }),
  ];

  // ---- per frame
  let last = {};
  const set = (k, v, fn) => { if (last[k] !== v) { last[k] = v; fn(v); } };
  const api = {
    root, words: W,
    update(dt = 0) {
      const s = game.state();
      set('money', cash(s.money), v => { el.money.textContent = v; });
      const pct = s.cooler.capacity ? Math.min(1, s.cooler.kg / s.cooler.capacity) : 0;
      set('cooler', `${s.cooler.kg.toFixed(1)} / ${s.cooler.capacity} ${W.kg}`, v => { el.coolerKg.textContent = v; el.cooler.querySelector('u').style.width = `${pct * 100}%`; el.cooler.classList.toggle('full', pct > 0.95); });
      const aboard = s.mode === 'boat' || s.mode === 'deck';
      set('fuel', aboard ? `${W.fuel}: ${Math.round(s.fuel.litres)} / ${s.fuel.tank} L` : '', v => { el.fuel.hidden = !v; el.fuel.textContent = v; });
      set('bite', s.rod === 'bite', v => el.bite.classList.toggle('on', v));
      // the fight's tension (the safe band in green), or the cast's power while winding up
      const f = s.fight;
      if (f) {
        set('meter', 'fight', () => { el.meter.style.display = 'block'; el.meter.classList.remove('power'); band.style.display = ''; fillU.style.width = '0'; el.meterLabel.textContent = W.tension; });
        const span = 1.2;   // the bar runs to 1.2: past 1 the line is over its breaking strain
        band.style.left = `${(f.band[0] / span) * 100}%`; band.style.width = `${((f.band[1] - f.band[0]) / span) * 100}%`;
        mark.style.display = ''; mark.style.left = `${Math.min(1, f.tension / span) * 100}%`;
        el.meter.classList.toggle('hot', f.tension > f.band[1]);
        el.meterValue.textContent = `${f.distance.toFixed(1)} ${W.m}`;
      } else if (s.rod === 'casting' && s.power > 0) {
        set('meter', 'power', () => { el.meter.style.display = 'block'; el.meter.classList.add('power'); el.meter.classList.remove('hot'); band.style.display = 'none'; mark.style.display = 'none'; el.meterLabel.textContent = W.power; el.meterValue.textContent = ''; });
        fillU.style.width = `${Math.min(1, s.power) * 100}%`;
      } else set('meter', 'off', () => { el.meter.style.display = 'none'; el.meter.classList.remove('hot'); });
      const p = s.prompt;
      const keyName = k => (k === 'LMB' ? W.keyLMB : k === 'RMB' ? W.keyRMB : k);
      set('prompt', p && !panel ? `${p.key}|${p.text}` : '', v => {
        el.prompt.style.display = v ? 'flex' : 'none';
        if (p) { el.prompt.querySelector('kbd').textContent = keyName(p.key); el.prompt.querySelector('span').textContent = p.text; }
      });
      // the islands: where you are, what lies ahead, and why the trip doesn't start yet
      const I = s.islands;
      set('isle', I && I.count > 1 ? `${I.name}|${I.label}` : '', v => { el.isle.style.display = v ? 'flex' : 'none'; if (I) { el.isleName.textContent = I.name; el.isleOf.textContent = I.label; } });
      set('isleNext', I?.next && !I.trip ? I.next.text : '', v => { el.isleNext.style.display = v ? '' : 'none'; el.isleNext.textContent = v; });
      set('isleWhy', I?.refused && !I.trip ? I.refused.why : '', v => { el.isleWhy.style.display = v ? 'block' : 'none'; el.isleWhy.textContent = v; });
      if (cardT > 0 && (cardT -= dt) <= 0) hideCatch();
      if (panel === 'shop' || panel === 'buyer') set('panelMoney', s.money, () => render());
    },
    open(name) { game.openPanel?.(name); },
    close() { game.closePanel?.(); },
    dispose() { offs.forEach(f => f()); removeEventListener('keydown', onKey); root.remove(); },
  };
  return api;
}
