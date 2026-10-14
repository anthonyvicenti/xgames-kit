// gf-three panels (open builder M4-D): choice cards, a shop, an inventory (a hotbar or a grid), a dialogue and a text
// input, as one module. DOM over the canvas, UI only: words are the caller's (their slots), pictures are slot ids
// (never URLs), colours are the game's --gf-* variables. A panel holds no game logic: it shows, and returns a choice.
//
//   const h = ctx.ui.panels.choice({ title, cards: [{id, name, text, image?, tag?}], onPick(res) })
//   const h = ctx.ui.panels.shop({ items: [{id, name, text, price, image?, disabled?, reason?, stock?}], currency: {label, amount}, onChoose({id, index}) })
//   const h = ctx.ui.panels.inventory({ mode: 'bar' | 'grid', items: [{id, name, text, count, image?, node?}], selected, onSelect({id, index}), onAction({action, id, index}), actions: [{id, label}] })
//   const h = ctx.ui.panels.dialogue({ speaker, portrait?, lines: 'text' | [...], choices?: [{id, text}] })
//   const h = ctx.ui.panels.input({ title, value, lines, maxLength, required, placeholder })
//
// Every call returns a handle { id, kind, open, remote, refused, done, close(result?), update(patch), select(i), el }.
// `h.done` is a promise that settles when the panel closes: choice → {id, index} | null; shop → null (it reports each
// buy through onChoose); inventory → null; dialogue → {choice, index, lines, skipped} ; input → the string | null.
// Common options: id (one panel per id: opening it again replaces it), for (a player id: only that player's copy
// shows it, any other copy gets a handle with remote: true), modal, dismissable, words, domId, onClose.
//
// Pause: a panel never pauses the round (a live round never pauses: CONTRACT §6g). A modal panel only takes the local
// player's input (ui.cover) and the mouse; the clock, the bots and the mechanics go on behind it, alone or with friends.
// Multiplayer: a panel is local. It opens on the copy that calls it (or only on the `for` player's copy) and returns
// its answer there; sending the answer to the host or to other players is the caller's message, as loot's pick is.
import { WORDS, problems, digitIndex, fill, clampText, enterAddsRow, linesOf, dialogueStep } from './logic.js';
import { CSS } from './css.js';

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const stop = e => { e.stopPropagation(); };
const stopAll = e => { e.preventDefault(); e.stopPropagation(); };

export function createPanels(ctx, ui) {
  if (typeof document === 'undefined') return nullPanels();
  if (!document.getElementById('gf-panels-css')) { const s = el('style'); s.id = 'gf-panels-css'; s.textContent = CSS; document.head.append(s); }
  const live = new Map();        // id → panel
  const stats = { opened: 0, closed: 0, refused: 0, last: null };
  const known = id => { try { return !!ctx.assets?.has?.(id); } catch { return false; } };
  const urlOf = id => { try { return id && known(id) ? ctx.assets.url(id) : null; } catch { return null; } };
  const host = () => ui?.root ?? document.body;

  function dead(kind, id, why, extra = {}) {
    const h = { id, kind, open: false, remote: why === 'remote', refused: why === 'refused', done: Promise.resolve(null), close() {}, update() {}, select() {}, el: null, ...extra };
    return h;
  }

  /** Build the shared frame. cfg: {modal, place: 'center' | 'bottom' | 'dock' | 'mounted', bare, clear, title, dismissable, into} */
  function begin(kind, o, cfg) {
    const id = String(o.id ?? kind);
    const bad = problems(kind, o, ctx.assets ? known : null);
    if (bad.length) { stats.refused++; console.error(`gf-three panel refused [${kind}]: ${bad.join('; ')}`); return { dead: dead(kind, id, 'refused', { problems: bad }) }; }
    if (o.for !== undefined && o.for !== null && ctx.me && String(o.for) !== String(ctx.me.id)) return { dead: dead(kind, id, 'remote') };
    live.get(id)?.close(null, 'replaced');
    const W = { ...WORDS[kind], ...(o.words ?? {}) };
    const root = el('div', `gfp gfp-${kind} ${cfg.modal ? 'modal' : ''} ${cfg.clear ? 'clear' : ''} ${cfg.place} on`);
    if (o.domId) root.id = o.domId; root.dataset.panel = kind; root.dataset.panelId = id;
    const card = el('div', `gfp-card${cfg.bare ? ' bare' : ''}`);
    if (cfg.modal) { card.setAttribute('role', 'dialog'); card.setAttribute('aria-modal', 'true'); }
    for (const t of ['mousedown', 'pointerdown', 'click']) card.addEventListener(t, stop);
    root.append(card);
    let resolve; const done = new Promise(r => { resolve = r; });
    let settled = false;
    const P = {
      id, kind, root, card, W, o, modal: !!cfg.modal, relock: false, keyFn: null, closed: false, done, extra: {},
      settle(v) { if (settled) return; settled = true; resolve(v); },
      close(result = null, why = 'closed') {
        if (P.closed) return; P.closed = true;
        P.onDispose?.();
        if (P.keyFn) removeEventListener('keydown', P.keyFn, true);
        root.remove(); if (live.get(id) === P) live.delete(id);
        if (P.modal) ui?.cover?.(`panel:${id}`, false);
        try { if (P.field) P.field.blur(); } catch {}
        if (P.modal) ctx.renderer?.domElement?.focus?.();
        if (P.relock) { try { const r = ctx.renderer?.domElement?.requestPointerLock?.(); r?.catch?.(() => {}); } catch {} }
        stats.closed++; stats.last = { id, kind, why, result: result === null ? null : JSON.parse(JSON.stringify(result ?? null, (k, v) => (v instanceof Node ? undefined : v))) };
        P.settle(result); o.onClose?.(result, why);
      },
    };
    if (cfg.modal) {
      P.relock = !!document.pointerLockElement;
      if (P.relock) { try { document.exitPointerLock(); } catch {} }
      ui?.cover?.(`panel:${id}`, true);
    }
    // the title row (the cross closes a dismissable panel)
    if (cfg.title !== false) {
      const head = el('div', 'gfp-head'); P.head = head;
      head.append(el('h3', 'gfp-title', cfg.title ?? W.title));
      if (cfg.dismissable) { const x = el('button', 'gfp-x', '✕'); x.type = 'button'; x.setAttribute('aria-label', W.close ?? 'Close'); x.addEventListener('click', () => P.close(null, 'dismissed')); head.append(x); P.x = x; }
      card.append(head);
    }
    if (cfg.modal && cfg.dismissable) root.addEventListener('pointerdown', e => { if (e.target === root) { stopAll(e); P.close(null, 'dismissed'); } });
    // keys: the kind's handler runs first; a handled key never reaches the game (or the pause menu)
    P.keys = fn => {
      P.keyFn = e => {
        if (P.closed) return;
        if (e.key === 'Escape' && cfg.dismissable) { e.preventDefault(); e.stopImmediatePropagation(); if (!e.repeat) P.close(null, 'dismissed'); return; }
        if (e.key === 'Escape' && P.modal) { e.preventDefault(); e.stopImmediatePropagation(); return; }      // a panel that must be answered still keeps Esc from opening the pause menu behind it
        if (e.repeat) { if (P.modal) e.stopImmediatePropagation(); return; }
        if (fn(e) && P.modal) { e.preventDefault(); e.stopImmediatePropagation(); }
      };
      addEventListener('keydown', P.keyFn, true);
    };
    (cfg.into ?? host()).append(root);
    live.set(id, P); stats.opened++;
    return { P };
  }

  const handle = (P, extra) => Object.defineProperties({
    id: P.id, kind: P.kind, remote: false, refused: false, el: P.root, done: P.done,
    close: (result = null) => P.close(result, 'closed'),
    update() {}, select() {},
  }, { open: { get: () => !P.closed, enumerable: true }, ...Object.getOwnPropertyDescriptors(extra) });

  // ---------------------------------------------------------------------------------------------------- choice
  function choice(o = {}) {
    const bottom = (o.placement ?? 'center') === 'bottom', modal = o.modal ?? !bottom;
    const r = begin('choice', o, { modal, place: bottom ? 'bottom' : 'center', bare: bottom && !modal, dismissable: o.dismissable ?? false, title: o.title === null ? false : (o.title ?? undefined) });
    if (r.dead) return r.dead;
    const { P } = r, cards = o.cards;
    const body = el('div', 'gfp-options');
    cards.forEach((c, i) => {
      const b = el('button', `gfp-option ${o.optionClass ?? ''}`); b.type = 'button'; b.dataset.i = String(i); b.dataset.id = String(c.id);
      for (const [k, v] of Object.entries(c.attrs ?? {})) b.dataset[k] = String(v);
      if (o.keys !== false) b.append(el('b', null, String(i + 1)));
      const src = urlOf(c.image); if (src) { const im = el('img', 'gfp-img'); im.src = src; im.alt = ''; b.append(im); }
      if (c.node) b.append(c.node);
      if (c.name) b.append(el('strong', null, c.name));
      if (c.text) b.append(el('span', null, c.text));
      if (c.tag) b.append(el('span', 'gfp-tag', c.tag));
      b.addEventListener('click', e => { stopAll(e); pick(i); });
      body.append(b);
    });
    P.card.append(body);
    let picked = false;
    function pick(i) {
      if (P.closed || picked || !(i >= 0 && i < cards.length)) return;
      picked = true; body.children[i]?.classList.add('picked');
      const res = { id: cards[i].id, index: i };
      P.settle(res); o.onPick?.(res);
      if ((o.settle ?? 250) > 0) setTimeout(() => P.close(res, 'picked'), o.settle ?? 250); else P.close(res, 'picked');
    }
    if (o.keys !== false) P.keys(e => { const i = digitIndex(e.key, cards.length); if (i === null) return false; pick(i); return true; });
    return handle(P, { pick, get picked() { return picked; } });
  }

  // ------------------------------------------------------------------------------------------------------ shop
  function shop(o = {}) {
    const r = begin('shop', o, { modal: o.modal ?? true, place: 'center', dismissable: o.dismissable ?? true });
    if (r.dead) return r.dead;
    const { P } = r; let items = o.items, currency = o.currency ?? null;
    const chip = el('span', 'gfp-chip'); P.head.insertBefore(chip, P.x ?? null);
    const rows = el('div', 'gfp-rows'); P.card.append(rows);
    const draw = () => {
      chip.style.display = currency ? '' : 'none';
      if (currency) chip.textContent = fill(P.W.balance, { label: currency.label ?? '', amount: currency.amount ?? 0 }).trim();
      const keep = P.card.scrollTop;
      rows.replaceChildren(...(items.length ? items.map((it, i) => {
        const src = urlOf(it.image);
        const row = el('div', `gfp-row${src ? '' : ' noimg'}`); row.dataset.i = String(i); row.dataset.id = String(it.id);
        if (src) { const im = el('img', 'gfp-img'); im.src = src; im.alt = ''; row.append(im); }
        const mid = el('div'); mid.append(el('div', 'gfp-name', it.name ?? String(it.id)));
        if (it.text) mid.append(el('div', 'gfp-sub', it.text));
        if (it.stock !== undefined && it.stock !== null) mid.append(el('div', 'gfp-sub', String(it.stock)));
        if (it.reason) mid.append(el('div', 'gfp-why', it.reason));
        const b = el('button', 'gfp-btn', `${it.buy ?? P.W.buy}${it.price !== undefined ? ` · ${it.price}${currency?.symbol ? ` ${currency.symbol}` : ''}` : ''}`);
        b.type = 'button'; b.disabled = !!it.disabled;
        b.addEventListener('click', e => { stopAll(e); if (!b.disabled && !P.closed) o.onChoose?.({ id: it.id, index: i }); });
        row.append(mid, b); return row;
      }) : [el('div', 'gfp-empty', P.W.empty)]));
      P.card.scrollTop = keep;
    };
    draw();
    if (!P.x) { const f = el('div', 'gfp-foot'), c = el('button', 'gfp-btn ghost', P.W.close); c.type = 'button'; c.addEventListener('click', () => P.close(null, 'dismissed')); f.append(c); P.card.append(f); }
    P.keys(() => false);
    return handle(P, { update(p = {}) { if (P.closed) return; if (p.items) { const bad = problems('shop', { items: p.items }, known); if (bad.length) { console.error(`gf-three panel refused [shop]: ${bad.join('; ')}`); return; } items = p.items; } if ('currency' in p) currency = p.currency; draw(); } });
  }

  // ------------------------------------------------------------------------------------------------- inventory
  function inventory(o = {}) {
    const grid = o.mode === 'grid', modal = o.modal ?? grid;
    const into = o.into ?? null;
    const r = begin('inventory', o, { modal, place: into ? 'mounted' : grid ? 'center' : 'dock', bare: !grid, dismissable: o.dismissable ?? grid, title: grid ? (o.title ?? undefined) : false, into });
    if (r.dead) return r.dead;
    const { P } = r; let items = o.items, sel = Number.isInteger(o.selected) ? o.selected : -1;
    const slotCls = o.slotClass ?? '';
    const mk = (it, i) => {
      const b = el('button', `gfp-slot ${slotCls}`); b.type = 'button'; b.dataset.i = String(i); b.dataset.id = String(it.id); b.title = it.name ?? '';
      const src = urlOf(it.image);
      if (it.node) b.append(it.node); else if (src) { const im = el('img', 'gfp-img'); im.src = src; im.alt = it.name ?? ''; b.append(im); } else b.append(el('span', null, it.icon ?? String(it.name ?? it.id).slice(0, 2)));
      if (o.keys !== false && i < 10 && !grid) b.append(el('b', null, String((i + 1) % 10)));
      if (it.count !== undefined && it.count !== null && it.count !== 1) b.append(el('em', null, String(it.count)));
      b.addEventListener('pointerdown', e => { if (!grid) stopAll(e); else e.stopPropagation(); });
      b.addEventListener('click', e => { stopAll(e); select(i, true); });
      return b;
    };
    let strip, wrap, detail, actions, cue = () => {};
    if (grid) {
      strip = el('div', 'gfp-grid'); detail = el('div', 'gfp-detail'); actions = el('div', 'gfp-foot');
      P.card.append(strip, detail, actions);
    } else {
      // the card is only the frame: the bar scrolls sideways, with an arrow at an end that has more
      P.card.className = 'gfp-wrap'; P.card.style.cssText = 'pointer-events:none;background:none;box-shadow:none;padding:0;overflow:visible;width:auto;max-width:100%;min-width:0';
      strip = el('div', 'gfp-bar'); if (o.barId) strip.id = o.barId; if (o.maxWidth) strip.style.maxWidth = o.maxWidth;
      const mL = el('button', 'gfp-more l', '‹'), mR = el('button', 'gfp-more r', '›'); mL.type = mR.type = 'button'; mL.setAttribute('aria-label', P.W.more ?? 'More'); mR.setAttribute('aria-label', P.W.more ?? 'More');
      P.card.append(strip, mL, mR); wrap = P.card;
      cue = () => { const max = strip.scrollWidth - strip.clientWidth; wrap.classList.toggle('more-l', strip.scrollLeft > 4); wrap.classList.toggle('more-r', max > 4 && strip.scrollLeft < max - 4); };
      strip.addEventListener('scroll', cue, { passive: true }); addEventListener('resize', cue);
      let ro = null; if (typeof ResizeObserver === 'function') { ro = new ResizeObserver(cue); ro.observe(strip); }
      P.onDispose = () => { removeEventListener('resize', cue); ro?.disconnect(); };
      for (const [b, d] of [[mL, -1], [mR, 1]]) { b.addEventListener('pointerdown', stopAll); b.addEventListener('click', e => { stopAll(e); strip.scrollBy({ left: d * strip.clientWidth * 0.8, behavior: 'smooth' }); }); }
    }
    const reveal = i => {
      const b = strip.children[i]; if (!b || grid) return;
      const l = b.offsetLeft - strip.offsetLeft, pad = 30;
      if (l - pad < strip.scrollLeft) strip.scrollLeft = Math.max(0, l - pad);
      else if (l + b.offsetWidth + pad > strip.scrollLeft + strip.clientWidth) strip.scrollLeft = l + b.offsetWidth + pad - strip.clientWidth;
      cue();
    };
    const paint = () => {
      for (const b of strip.children) b.classList.toggle('on', Number(b.dataset.i) === sel);
      if (!grid) return;
      const it = items[sel];
      detail.hidden = !it; detail.replaceChildren(...(it ? [el('div', 'gfp-name', it.name ?? String(it.id))] : []));
      if (it?.text) detail.append(el('div', 'gfp-sub', it.text));
      actions.replaceChildren(...(it ? (o.actions ?? []).map(a => { const b = el('button', `gfp-btn${a.ghost ? ' ghost' : ''}`, a.label ?? P.W[a.id] ?? a.id); b.type = 'button'; b.dataset.action = a.id; b.addEventListener('click', e => { stopAll(e); o.onAction?.({ action: a.id, id: it.id, index: sel }); }); return b; }) : []));
    };
    const draw = () => { if (!grid) P.root.style.display = items.length ? '' : 'none'; strip.replaceChildren(...items.map(mk)); if (grid && !items.length) strip.append(el('div', 'gfp-empty', P.W.empty)); paint(); cue(); };
    function select(i, fromUser = false) {
      if (P.closed || !(i >= 0 && i < items.length)) return;
      sel = i; paint(); reveal(i);
      if (fromUser) o.onSelect?.({ id: items[i].id, index: i });
    }
    draw(); if (sel >= 0) reveal(sel);
    if (!modal && o.keys !== 'labels' && o.keys !== false) P.keys(e => { const i = digitIndex(e.key, Math.min(items.length, 10)); if (i === null) return false; select(i, true); return false; });
    else if (modal) P.keys(() => false);
    return handle(P, {
      get selected() { return sel; }, select: i => select(i),
      update(p = {}) { if (P.closed) return; if (p.items) { const bad = problems('inventory', { items: p.items }, known); if (bad.length) { console.error(`gf-three panel refused [inventory]: ${bad.join('; ')}`); return; } items = p.items; } if (Number.isInteger(p.selected)) sel = p.selected; draw(); if (!grid) { if (p.scroll !== undefined) strip.scrollLeft = p.scroll; reveal(sel); } },
    });
  }

  // -------------------------------------------------------------------------------------------------- dialogue
  function dialogue(o = {}) {
    const r = begin('dialogue', o, { modal: o.modal ?? true, clear: true, place: 'dock', title: false, dismissable: false });
    if (r.dead) return r.dead;
    const { P } = r, lines = linesOf(o.lines), choices = Array.isArray(o.choices) && o.choices.length ? o.choices : null;
    const src = urlOf(o.portrait);
    const box = el('div', `gfp-say${src ? '' : ' noimg'}`); P.card.append(box);
    if (src) { const im = el('img', 'gfp-img'); im.src = src; im.alt = o.speaker ?? ''; box.append(im); }
    const col = el('div'), who = o.speaker ? el('div', 'gfp-who', o.speaker) : null, text = el('div', 'gfp-line'), next = el('div', 'gfp-next'), pick = el('div', 'gfp-choices');
    if (who) col.append(who); col.append(text, pick, next); box.append(col);
    let i = 0, shown = 0, timer = null, finished = false;
    const typing = () => shown < lines[i].length;
    const speed = Math.max(5, o.cps ?? 45);
    const render = () => {
      text.textContent = lines[i].slice(0, shown);
      const last = i === lines.length - 1;
      next.textContent = typing() ? '' : last ? (choices ? '' : `▶ ${P.W.done}`) : `▶ ${P.W.next}`;
      pick.replaceChildren(...(!typing() && last && choices ? choices.map((c, k) => { const b = el('button', 'gfp-btn', `${k + 1}  ${c.text}`); b.type = 'button'; b.dataset.i = String(k); b.dataset.id = String(c.id); b.addEventListener('click', e => { stopAll(e); choose(k); }); return b; }) : []));
    };
    const startLine = () => {
      clearInterval(timer); shown = o.instant ? lines[i].length : 0; render();
      if (!typing()) return;
      timer = setInterval(() => { shown = Math.min(lines[i].length, shown + Math.max(1, Math.round(speed / 20))); render(); if (!typing()) clearInterval(timer); }, 50);
    };
    const end = (res) => { if (finished) return; finished = true; clearInterval(timer); P.close(res, 'ended'); };
    function choose(k) { if (!choices || !(k >= 0 && k < choices.length) || typing() || i !== lines.length - 1) return; end({ choice: choices[k].id, index: k, lines: lines.length, skipped: false }); }
    function advance() {
      const s = dialogueStep({ i, n: lines.length, typing: typing(), choices: !!choices });
      if (s.act === 'finish-line') { clearInterval(timer); shown = lines[i].length; render(); o.onLine?.(i); }
      else if (s.act === 'next') { i = s.i; startLine(); }
      else if (s.act === 'end') end({ choice: null, index: null, lines: lines.length, skipped: false });
    }
    function skip() { if (choices) { i = lines.length - 1; clearInterval(timer); shown = lines[i].length; render(); } else end({ choice: null, index: null, lines: lines.length, skipped: true }); }
    box.addEventListener('click', e => { if (e.target.closest?.('.gfp-btn')) return; advance(); });
    P.keys(e => {
      if (e.key === ' ' || e.key === 'Enter' || e.key === 'e' || e.key === 'E') { advance(); return true; }
      if (e.key === 'Escape') { skip(); return true; }
      const k = digitIndex(e.key, choices?.length ?? 0); if (k !== null) { choose(k); return true; }
      return false;
    });
    P.onDispose = () => clearInterval(timer);
    startLine();
    return handle(P, { advance, skip, get line() { return i; } });
  }

  // ------------------------------------------------------------------------------------------------------ input
  function input(o = {}) {
    const rows = o.lines ?? 1, max = o.maxLength ?? 80;
    const r = begin('input', o, { modal: true, place: 'center', dismissable: o.dismissable ?? true, title: o.title === null ? false : (o.title ?? undefined) });
    if (r.dead) return r.dead;
    const { P } = r, ids = o.ids ?? {};
    const f = rows > 1 ? el('textarea', 'gfp-field') : el('input', 'gfp-field');
    if (rows > 1) f.rows = rows; else f.type = 'text';
    f.maxLength = max; f.spellcheck = false; f.autocomplete = 'off'; f.placeholder = P.W.placeholder ?? ''; f.enterKeyHint = rows > 1 ? 'enter' : 'done';
    if (ids.field) f.id = ids.field;
    f.value = clampText(o.value ?? '', { lines: rows, maxLength: max }); P.field = f;
    const count = el('small', 'gfp-count'), ok = el('button', 'gfp-btn', P.W.ok), no = el('button', 'gfp-btn ghost', P.W.cancel);
    ok.type = no.type = 'button'; if (ids.ok) ok.id = ids.ok; if (ids.cancel) no.id = ids.cancel;
    const hint = ctx.input?.touch || !(rows > 1) ? '' : ` · ${P.W.hint}`;
    const sync = () => { const v = clampText(f.value, { lines: rows, maxLength: max }); if (v !== f.value) f.value = v; count.textContent = `${f.value.length}/${max}${hint}`; ok.disabled = !!o.required && !f.value.trim(); };
    f.addEventListener('input', sync);
    const submit = () => { if (ok.disabled) return; P.close(f.value, 'submitted'); };
    // a plain Enter adds a row while there is one, and does nothing on the last row, so the panel never closes under
    // someone still typing; Ctrl+Enter or the button confirms; Escape cancels (play-test 2026-10-09, the sign editor)
    f.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Escape') { e.preventDefault(); if (o.dismissable ?? true) P.close(null, 'dismissed'); }
      else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey || rows <= 1)) { e.preventDefault(); submit(); }
      else if (e.key === 'Enter' && !enterAddsRow(f.value, rows)) e.preventDefault();
    });
    f.addEventListener('keyup', stop);
    ok.addEventListener('click', e => { stopAll(e); submit(); }); no.addEventListener('click', e => { stopAll(e); P.close(null, 'dismissed'); });
    const foot = el('div', 'gfp-foot'); foot.append(count, no, ok);
    P.card.append(f, foot); sync();
    P.keys(() => false);
    setTimeout(() => { try { f.focus(); f.select(); } catch {} }, 30);
    return handle(P, { get value() { return f.value; }, update(p = {}) { if (P.closed) return; if ('value' in p) { f.value = clampText(p.value, { lines: rows, maxLength: max }); sync(); } } });
  }

  return {
    choice, shop, inventory, dialogue, input,
    /** Close one panel by id (every panel when omitted). */
    close(id = null) { for (const [k, p] of [...live]) if (id === null || k === String(id)) p.close(null, 'closed'); },
    get(id) { return live.get(String(id)) ? true : false; },
    /** What is open, for QA and verify: window.__game.panels(). */
    observe() {
      const r = e => { const b = e.getBoundingClientRect(); return [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)]; };
      return { open: [...live.values()].map(p => ({ id: p.id, kind: p.kind, modal: p.modal, rect: r(p.card), count: p.root.querySelectorAll('[data-i]').length, title: p.root.querySelector('.gfp-title')?.textContent ?? null, words: p.root.textContent.slice(0, 160) })), covered: [...live.values()].some(p => p.modal), ...stats };
    },
  };
}

function nullPanels() {
  const d = (kind) => () => ({ id: kind, kind, open: false, remote: false, refused: true, done: Promise.resolve(null), close() {}, update() {}, select() {}, el: null });
  return { choice: d('choice'), shop: d('shop'), inventory: d('inventory'), dialogue: d('dialogue'), input: d('input'), close() {}, get: () => false, observe: () => ({ open: [], covered: false, opened: 0, closed: 0, refused: 0, last: null }) };
}
