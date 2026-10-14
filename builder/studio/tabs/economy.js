// Studio tab: the game's economy (the `economy` section of its gamesfun.json, builder/web3/economy/README.md). It replaces the
// Token and Shop tabs: a shop is part of the economy, and launching the game's token is one of its parts.
//   - the money flow, drawn: players → what they pay into → pools → who gets paid; every box opens its part
//   - the parts, one card each, every number editable where it is; "Add …" makes a part with sensible numbers
//   - beside the numbers, what the quick simulation makes of them, refreshed as the creator types
//   - the checker's notes next to the part each is about, each with its fix
//   - what putting it live costs, and "Put it live": one approval in the creator's wallet (flow kind "economy")
//   - what is live, the pools' balances and the latest receipts (GET /economy/status)
// The page never signs: the dev server prepares, the creator's wallet signs here, the server sends.
import { explorer, pictureUrl, short } from './web3/client.js';
import { approvalPanel, choosePicture, fill, h, keepFresh, note, requestBanner, styles, tabContext } from './web3/ui.js';
import { SECTIONS, addPart, amountText, fmt, isLivePart, nameOf, notesByPart, parseAmount, parseDuration, parseNumber, parseNumberList, parseWhole, parseWordList, partId, removePart, sectionOf, symbolOf } from './web3/economy-parts.js';
import { LEGEND, drawFlow, econStyles, edgeColour } from './web3/economy-view.js';
import { createDecide } from './web3/economy-decide.js';

const DEBOUNCE_MS = 450;
const RARITIES = ['Common', 'Uncommon', 'Rare', 'Epic', 'Legendary', 'Mythic'];

// ---------------------------------------------------------------- values at a path inside a part

const getAt = (obj, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
function setAt(obj, path, value) {
  const keys = path.split('.');
  const chain = [obj];
  for (const k of keys.slice(0, -1)) {
    const at = chain.at(-1);
    if (at[k] == null || typeof at[k] !== 'object') at[k] = {};
    chain.push(at[k]);
  }
  const last = keys.at(-1);
  if (value === undefined) delete chain.at(-1)[last];
  else chain.at(-1)[last] = value;
  // an emptied group ({} rise, fall, life) goes away, so the spec stays the shape the schema takes
  for (let i = keys.length - 1; i > 0; i -= 1) if (value === undefined && Object.keys(chain[i]).length === 0) delete chain[i - 1][keys[i - 1]];
}
const PARSE = { text: (v) => (v === '' ? undefined : v), words: (v) => (v.trim() === '' ? undefined : v), amount: parseAmount, percent: parseNumber, number: parseNumber, whole: parseWhole, duration: parseDuration, time: (v) => (v.trim() === '' ? undefined : v.trim()), numbers: (v) => (v.trim() ? parseNumberList(v) : undefined), names: (v) => (v.trim() ? parseWordList(v) : undefined) };
const SHOW = { numbers: (v) => (Array.isArray(v) ? v.join(', ') : v ?? ''), names: (v) => (Array.isArray(v) ? v.join(', ') : v ?? '') };

// ---------------------------------------------------------------- the fields of each kind of part

const tokenOptions = (spec, blank) => [...(blank ? [{ value: '', label: blank }] : []), ...(spec.tokens ?? []).map((t) => ({ value: t.key, label: symbolOf(spec, t.key) }))];
const poolOptions = (spec, blank) => [...(blank ? [{ value: '', label: blank }] : []), ...(spec.pools ?? []).map((p) => ({ value: p.key, label: `pool “${p.key}”` }))];
const itemOptions = (spec) => (spec.items ?? []).map((i) => ({ value: i.key, label: nameOf(i) }));
const opts = (list) => () => list.map(([value, label]) => ({ value, label }));

const PRICE_MOVES = [
  { p: 'rise.step', label: 'Price rises by this after each sale', type: 'amount' },
  { p: 'rise.growthPercent', label: '…and by this % of itself', type: 'percent' },
  { p: 'fall.step', label: 'Price falls by', type: 'amount' },
  { p: 'fall.every', label: '…every (e.g. 1h)', type: 'duration' },
  { p: 'fall.floor', label: '…never below', type: 'amount' },
];
/** main: always shown; more: under "More"; lists: the row editors (split, outcomes, in, out). */
const FIELDS = {
  pools: {
    main: [
      { p: 'currency', label: 'Holds', type: 'select', options: (s) => tokenOptions(s) },
      { p: 'seed', label: 'You put in at the start', type: 'amount', unit: (s, part) => symbolOf(s, part.currency) },
      { p: 'about', label: 'What it is for (players may see this)', type: 'words', wide: true },
    ],
  },
  items: {
    main: [
      { p: 'name', label: 'Name', type: 'text', max: 32 },
      { p: 'price', label: 'Price (0: only boxes and recipes give it)', type: 'amount', unit: (s) => symbolOf(s) },
      { p: 'supply', label: 'How many can exist (0: no limit)', type: 'whole' },
      { p: 'rarity', label: 'Rarity', type: 'select', options: () => RARITIES.map((r) => ({ value: r, label: r })) },
    ],
    more: [
      { p: 'description', label: 'Describe it (players see this)', type: 'words', wide: true },
      { p: 'kind', label: 'Kept', type: 'select', options: opts([['collectible', 'in the player’s wallet'], ['normal', 'by the game (the chain records the sale)']]) },
      { p: 'value', label: 'What one is worth to a player (for the numbers only)', type: 'amount', unit: (s) => symbolOf(s) },
      { p: 'soulbound', label: 'Can’t be traded', type: 'bool' },
      { p: 'burnable', label: 'The game may burn it later', type: 'bool' },
      { p: 'active', label: 'On sale', type: 'bool', default: true },
      ...PRICE_MOVES,
      { p: 'life.readyAfter', label: 'Usable after (e.g. 1d)', type: 'duration' },
      { p: 'life.lasts', label: 'Lasts (e.g. 30d)', type: 'duration' },
      { p: 'life.uses', label: 'Uses', type: 'whole' },
      { p: 'life.cooldown', label: 'Cooldown between uses', type: 'duration' },
    ],
    lists: ['split'],
  },
  boxes: {
    main: [
      { p: 'name', label: 'Name', type: 'text', max: 40 },
      { p: 'price', label: 'Price of a roll', type: 'amount', unit: (s, part) => symbolOf(s, part.currency) },
      { p: 'currency', label: 'Paid in', type: 'select', options: (s) => tokenOptions(s, `${symbolOf(s)} (the game’s)`) },
    ],
    more: [{ p: 'stockOdds', label: 'An item gets rarer as its supply runs out', type: 'bool' }, { p: 'active', label: 'On sale', type: 'bool', default: true }, ...PRICE_MOVES],
    lists: ['outcomes', 'split'],
  },
  payments: {
    main: [
      { p: 'name', label: 'Name', type: 'text', max: 40 },
      { p: 'amount', label: 'Amount', type: 'amount', unit: (s, part) => symbolOf(s, part.currency) },
      { p: 'currency', label: 'Paid in', type: 'select', options: (s) => tokenOptions(s, `${symbolOf(s)} (the game’s)`) },
    ],
    lists: ['split'],
  },
  recipes: {
    main: [{ p: 'name', label: 'Name', type: 'text', max: 40 }],
    more: [{ p: 'active', label: 'Open', type: 'bool', default: true }],
    lists: ['in', 'out'],
  },
  lotteries: {
    main: [
      { p: 'name', label: 'Name', type: 'text', max: 40 },
      { p: 'price', label: 'A ticket costs', type: 'amount', unit: (s, part) => symbolOf(s, part.ticketCurrency ?? (s.pools ?? []).find((p) => p.key === part.pot)?.currency) },
      { p: 'places', label: 'Places (% of the pot each)', type: 'numbers', placeholder: '50, 30, 20' },
      { p: 'every', label: 'Draw every', type: 'duration', placeholder: '7d' },
      { p: 'pot', label: 'Its pot', type: 'select', options: (s) => poolOptions(s) },
    ],
    more: [
      { p: 'cutPercent', label: 'Your cut of ticket money (%)', type: 'percent' },
      { p: 'firstDraw', label: 'First draw (publish+7d, or a date)', type: 'time' },
      { p: 'ticketCurrency', label: 'Tickets paid in (burned)', type: 'select', options: (s) => tokenOptions(s, 'the pot’s money') },
    ],
  },
  stakes: {
    main: [
      { p: 'name', label: 'Name', type: 'text', max: 40 },
      { p: 'stakes', label: 'Players lock', type: 'select', options: (s) => tokenOptions(s) },
      { p: 'rewards', label: 'They share the pool', type: 'select', options: (s) => poolOptions(s) },
      { p: 'lock', label: 'Locked for at least', type: 'duration', placeholder: '1d' },
    ],
  },
  contests: {
    main: [
      { p: 'name', label: 'Name', type: 'text', max: 40 },
      { p: 'sides', label: 'Sides', type: 'whole' },
      { p: 'sideNames', label: 'Their names', type: 'names', placeholder: 'Red, Blue' },
      { p: 'currency', label: 'Backed in', type: 'select', options: (s) => tokenOptions(s, `${symbolOf(s)} (the game’s)`) },
    ],
    more: [
      { p: 'entriesClose', label: 'Entries close after', type: 'duration' },
      { p: 'resultDue', label: 'Result due within', type: 'duration' },
      { p: 'every', label: 'One opens every (for the numbers)', type: 'duration' },
      { p: 'decidedBy', label: 'Who says which side won', type: 'words', wide: true },
    ],
    lists: ['split'],
  },
  holds: {
    main: [
      { p: 'name', label: 'Name', type: 'text', max: 40 },
      { p: 'item', label: 'Players hand in', type: 'select', options: (s) => itemOptions(s) },
      { p: 'for', label: 'For (the player chooses; e.g. 1d)', type: 'duration' },
    ],
    more: [{ p: 'decidedBy', label: 'Who says where it goes', type: 'words', wide: true }],
  },
  schedules: {
    main: [
      { p: 'name', label: 'Name', type: 'text', max: 40 },
      { p: 'does', label: 'Does', type: 'select', options: opts([['issue', 'Mint a game token into a pool'], ['burn', 'Burn a share of a pool'], ['move', 'Move a share between pools']]) },
      { p: 'currency', label: 'Mints', type: 'select', options: (s) => tokenOptions(s), when: (x) => x.does === 'issue' },
      { p: 'amount', label: 'This much each time', type: 'amount', when: (x) => x.does === 'issue', unit: (s, part) => symbolOf(s, part.currency) },
      { p: 'pool', label: 'Pool', type: 'select', options: (s) => poolOptions(s), when: (x) => x.does !== 'move' },
      { p: 'from', label: 'From pool', type: 'select', options: (s) => poolOptions(s), when: (x) => x.does === 'move' },
      { p: 'to', label: 'To pool', type: 'select', options: (s) => poolOptions(s), when: (x) => x.does === 'move' },
      { p: 'percent', label: 'Share of the pool (%)', type: 'percent', when: (x) => x.does !== 'issue' },
      { p: 'every', label: 'Every', type: 'duration', placeholder: '1d' },
    ],
    more: [
      { p: 'start', label: 'Starts (publish, publish+1d, or a date)', type: 'time' },
      { p: 'maxRuns', label: 'Stops after this many runs (0: never)', type: 'whole' },
      { p: 'halveEvery', label: 'Halves every this many runs', type: 'whole', when: (x) => x.does === 'issue' },
      { p: 'active', label: 'Running', type: 'bool', default: true },
    ],
  },
  decisions: {
    main: [
      { p: 'when', label: 'When', type: 'words', wide: true },
      { p: 'does', label: 'The game', type: 'select', options: opts([['payout', 'pays out of a pool'], ['burn', 'burns from a pool'], ['issue', 'mints a game token'], ['make', 'gives a collectible'], ['unmake', 'takes a collectible back'], ['set', 'writes on a collectible'], ['award', 'awards a place'], ['decide', 'names a contest’s winner'], ['roll', 'rolls a box for a player'], ['open_contest', 'opens a contest']]) },
      { p: 'pool', label: 'Pool', type: 'select', options: (s) => poolOptions(s, '—') },
      { p: 'amount', label: 'Amount', type: 'amount' },
      { p: 'percent', label: '…or a share of the pool (%)', type: 'percent' },
    ],
    more: [
      { p: 'perDay', label: 'About how often a day (for the numbers)', type: 'number' },
      { p: 'item', label: 'Item', type: 'select', options: (s) => [{ value: '', label: '—' }, ...itemOptions(s)] },
      { p: 'to', label: 'To whom (in words)', type: 'words', wide: true },
      { p: 'signedBy', label: 'Signed by', type: 'select', options: opts([['page', 'you, from this page'], ['keeper', 'the keeper on your machine'], ['server', 'the game’s server']]) },
    ],
  },
};

/** What a link to this tab asks for: #economy?flow=economy (economy_publish's link), or
 * #economy?decide=<key>&to=&amount=&percent=&side=&asset=&attempt=&id=&open= (a decision: economy_decide's and
 * `gamesfun economy decide`'s link; the card checks it and offers "Sign in my wallet"). */
export function linkAsks(hash) {
  const m = /^#economy(?:\?(.*))?$/.exec(String(hash ?? ''));
  if (!m) return null;
  const q = new URLSearchParams(m[1] ?? '');
  if (q.get('flow') === 'economy') return { kind: 'publish' };
  if (q.get('decide')) return { kind: 'decide', key: q.get('decide'), values: Object.fromEntries(['to', 'amount', 'percent', 'side', 'asset', 'attempt', 'id', 'open'].filter((k) => q.get(k)).map((k) => [k, q.get(k)])) };
  return null;
}

const STATE_WORDS = { live: 'Live', changed: 'Changed since it went live', draft: 'Not live yet' };

export default {
  id: 'economy',
  label: 'Economy',
  order: 40,
  mount(el, ctx) {
    styles();
    econStyles();
    const t = tabContext(ctx);
    const root = h('div', { class: 'gfw3 econ', 'data-testid': 'tab-economy' });
    el.replaceChildren(root);
    let state = null; // /state: network, pictures, requests, the launched token
    let econ = null; // GET /economy without the spec: source, notes, token
    let spec = null; // the economy being edited
    let analysis = { check: null, sim: null, cost: null };
    let status = null;
    let statusError = '';
    let flow = null;
    let message = null;
    let loadError = '';
    let dirty = false;
    let saving = false;
    let saveError = '';
    let edits = 0;
    let timer = null;
    let analysing = 0;
    let selected = null;
    let confirmRemove = null;
    const open = new Set(); // parts whose "More" is open
    const launch = {}; // token key → { picture, description, initialBuy, pair, solUsd, startCap, graduationCap }
    const lookups = {}; // token key → { info, error, looking }
    let flowBox = null;
    let lastWidth = 0;
    let asked = linkAsks(location.hash); // what the link that opened the page asks for; never started by itself
    const onHash = () => ((asked = linkAsks(location.hash)), render());
    window.addEventListener('hashchange', onHash);
    const forget = () => {
      asked = null;
      if (location.hash.startsWith('#economy?')) history.replaceState(null, '', `${location.pathname}${location.search}#economy`);
      render();
    };

    // ------------------------------------------------------------ loading, checking, saving

    async function refresh() {
      try {
        const [s, e] = await Promise.all([t.api('/state'), t.api('/economy')]);
        state = s;
        if (!dirty) {
          spec = e.economy;
          econ = e;
        }
        loadError = '';
      } catch (error) {
        loadError = error.message;
        render();
        return;
      }
      loadStatus();
      await Promise.all([analyse(), decide.load()]);
      if (econ?.filled && econ.source === 'economy') await save(); // a token just launched: its mint goes in the spec
      render();
    }

    async function loadStatus() {
      try {
        status = await t.api('/economy/status');
        statusError = '';
      } catch (error) {
        status = null;
        statusError = error.message;
      }
      if (!flow) render();
    }

    async function analyse() {
      const mine = ++analysing;
      const body = { economy: spec };
      const safe = (p) => p.catch((error) => ({ ok: false, error: error.message }));
      const [check, sim, cost] = await Promise.all([safe(t.api('/economy/check', body)), safe(t.api('/economy/simulate', body)), safe(t.api('/economy/cost', body))]);
      if (mine === analysing) analysis = { check, sim, cost };
    }
    const schemaOk = () => analysis.check && !(analysis.check.refusals ?? []).some((r) => r.code === 'E-SCHEMA' || r.code === 'E-SECRET');

    async function save() {
      const at = edits;
      saving = true;
      try {
        const r = await t.api('/economy', { economy: spec });
        saveError = '';
        econ = { ...econ, source: 'economy', filled: false };
        if (edits === at) {
          spec = r.economy;
          dirty = false;
        }
      } catch (error) {
        saveError = error.message;
      } finally {
        saving = false;
      }
    }

    /** The creator changed something: show it now if the page must change shape, check and save after a pause. */
    function edited(reshape = false) {
      edits += 1;
      dirty = true;
      if (reshape) render();
      clearTimeout(timer);
      timer = setTimeout(async () => {
        await analyse();
        if (schemaOk()) await save();
        render();
      }, DEBOUNCE_MS);
    }

    // ------------------------------------------------------------ putting it live

    const refusals = () => analysis.check?.refusals ?? [];
    const liveMap = () => {
      const map = new Map();
      for (const p of status?.parts ?? []) {
        const s = SECTIONS.find((x) => x.section === p.part || x.kind === p.part);
        if (s && p.key) map.set(partId(s.section, p.key), p.onChain ? (p.differs ? 'changed' : 'live') : 'draft');
      }
      return map;
    };
    const ON_CHAIN = ['pools', 'items', 'boxes', 'recipes', 'schedules', 'lotteries', 'stakes'];
    function nothingToPublish() {
      if (!status?.live || !(status.parts ?? []).length) return false;
      const map = liveMap();
      if ([...map.values()].some((v) => v !== 'live')) return false;
      return ON_CHAIN.every((section) => (spec[section] ?? []).every((p) => map.get(partId(section, p.key)) === 'live'));
    }
    function whyNot() {
      if (!analysis.check) return 'Checking…';
      const n = refusals().length;
      if (n) return `Fix the ${n} note${n === 1 ? '' : 's'} marked ✗ first.`;
      if (saving || (dirty && timer)) return 'Saving your changes…';
      if (nothingToPublish()) return 'Everything is live.';
      return '';
    }

    async function start(body) {
      try {
        if (!t.wallet.address()) await t.wallet.connect();
        flow = await t.api('/flow/start', { ...body, wallet: t.wallet.address() });
        message = null;
      } catch (error) {
        message = { kind: 'error', text: error.message };
      }
      render();
    }
    // ------------------------------------------------------------ decisions (builder/studio/tabs/web3/economy-decide.js)

    const decide = createDecide({ t, render: () => render(), start: (body) => start(body), state: () => state, live: () => Boolean(status?.live || spec?.live?.game) });
    function openDecision(key, values) {
      asked = { kind: 'decide', key, values };
      render();
      root.querySelector('[data-testid="econ-decision"]')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    async function goLive() {
      if (dirty) {
        clearTimeout(timer);
        timer = null;
        await analyse();
        if (refusals().length) return render();
        await save();
        if (saveError) return render();
      }
      await start({ kind: 'economy' });
    }

    // ------------------------------------------------------------ small pieces

    function pick(part) {
      const id = partId(part.section, part.key);
      selected = id;
      open.add(id);
      render();
      const card = root.querySelector(`[data-part-card="${CSS.escape(id)}"]`);
      if (card) {
        card.scrollIntoView({ block: 'start', behavior: 'smooth' });
        card.classList.add('flash');
        setTimeout(() => card.classList.remove('flash'), 1400);
      }
    }

    function noteView(n) {
      return h('div', { class: `econ-note ${n.level}`, 'data-testid': n.level === 'refusal' ? 'econ-refusal' : 'econ-warning', role: n.level === 'refusal' ? 'alert' : null },
        h('div', {}, h('strong', {}, n.level === 'refusal' ? '✗ ' : '! '), n.message, ' ', h('span', { class: 'code' }, n.code)),
        n.fix ? h('div', { class: 'fix' }, n.level === 'refusal' ? 'Fix: ' : '', n.fix) : null);
    }

    /** One input for a field `f` of `part` (in `section`), named by data-path so focus survives a redraw. */
    function field(section, part, f, notes, locked) {
      const id = partId(section, part.key);
      const path = `${id}|${f.p}`;
      const value = getAt(part, f.p);
      const bad = notes.some((n) => n.level === 'refusal' && (n.field === f.p || n.field.startsWith(`${f.p}.`) || n.field.startsWith(`${f.p}[`)));
      const unit = typeof f.unit === 'function' ? f.unit(spec, part) : null;
      const label = `${f.label}${unit ? ` (${unit})` : ''}`;
      if (f.type === 'bool')
        return h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: value ?? f.default ?? false, disabled: locked, 'data-path': path, onchange: (e) => (setAt(part, f.p, e.target.checked === (f.default ?? false) ? undefined : e.target.checked), edited(true)) }), f.label);
      if (f.type === 'select') {
        const options = f.options(spec, part);
        const current = value ?? '';
        const known = options.some((o) => o.value === current);
        return h('label', { class: `field${f.wide ? ' wide' : ''}` }, label,
          h('select', { disabled: locked, 'data-path': path, class: bad ? 'bad' : '', onchange: (e) => (setAt(part, f.p, e.target.value === '' ? undefined : e.target.value), edited(true)) },
            known ? null : h('option', { value: current, selected: true }, current === '' ? '—' : `${current} (not found)`),
            options.map((o) => h('option', { value: o.value, selected: o.value === current }, o.label))));
      }
      const parse = PARSE[f.type] ?? PARSE.text;
      const shown = SHOW[f.type] ? SHOW[f.type](value) : value ?? '';
      const numeric = ['amount', 'percent', 'number', 'whole'].includes(f.type);
      const input = h(f.type === 'words' && f.wide ? 'textarea' : 'input', {
        value: String(shown),
        rows: 2,
        disabled: locked,
        maxLength: f.max,
        placeholder: f.placeholder ?? '',
        inputMode: numeric ? 'decimal' : null,
        spellcheck: f.type === 'words',
        class: bad ? 'bad' : '',
        'data-path': path,
        'aria-invalid': bad ? 'true' : null,
        oninput: (e) => (setAt(part, f.p, parse(e.target.value)), edited()),
      });
      return h('label', { class: `field${f.wide ? ' wide' : ''}` }, label, input);
    }

    /** Where each share of a payment goes, and what is left for the treasury. */
    function splitRows(section, part, locked) {
      const id = partId(section, part.key);
      const rows = part.split ?? [];
      const used = rows.reduce((n, s) => n + (Number(s.percent) || 0), 0);
      const destinations = [...(spec.pools ?? []).map((p) => ({ value: `pool:${p.key}`, label: `pool “${p.key}”` })), { value: 'burn', label: 'burn it' }, { value: 'account:', label: 'a partner’s token account…' }, { value: 'holder:', label: 'whoever holds a collectible…' }];
      const change = (fn, reshape = true) => (fn(), part.split?.length === 0 && delete part.split, edited(reshape));
      return h('div', { class: 'econ-rows', 'data-testid': 'econ-split' },
        h('div', { class: 'econ-rows-head' }, h('span', {}, 'Where each payment goes'), h('button', { class: 'link', disabled: locked || rows.length >= 4, onclick: () => change(() => (part.split = [...rows, { to: (spec.pools ?? [])[0] ? `pool:${spec.pools[0].key}` : 'burn', percent: Math.max(0, Math.min(10, 100 - used)) }])) }, '+ Add a share')),
        rows.map((s, i) => {
          const kind = String(s.to).startsWith('account:') ? 'account:' : String(s.to).startsWith('holder:') ? 'holder:' : s.to;
          return h('div', { class: 'econ-row' },
            h('select', { 'aria-label': 'Goes to', disabled: locked, 'data-path': `${id}|split.${i}.to`, onchange: (e) => change(() => (s.to = e.target.value)) },
              destinations.some((d) => d.value === kind) ? null : h('option', { value: s.to, selected: true }, `${s.to} (not found)`),
              destinations.map((d) => h('option', { value: d.value, selected: d.value === kind }, d.label))),
            kind === 'account:' || kind === 'holder:' ? h('input', { placeholder: kind === 'account:' ? 'token account address' : 'collectible address', value: String(s.to).slice(kind.length), spellcheck: false, disabled: locked, 'data-path': `${id}|split.${i}.addr`, oninput: (e) => change(() => (s.to = `${kind}${e.target.value.trim()}`), false) }) : null,
            h('input', { class: 'num', 'aria-label': 'Percent', inputMode: 'decimal', value: String(s.percent ?? ''), disabled: locked, 'data-path': `${id}|split.${i}.percent`, oninput: (e) => change(() => (s.percent = parseNumber(e.target.value)), false) }),
            h('span', { class: 'unit' }, '%'),
            h('button', { class: 'x', title: 'Remove this share', 'aria-label': 'Remove this share', disabled: locked, onclick: () => change(() => part.split.splice(i, 1)) }, '×'));
        }),
        h('span', { class: 'dim' }, used >= 100 ? 'All of it goes to these.' : `The rest (${fmt(100 - used)}%) goes to your treasury.`));
    }

    /** A box's outcomes: what a roll can land on, with its chance. */
    function outcomeRows(part, locked) {
      const id = partId('boxes', part.key);
      const rows = part.outcomes ?? [];
      const byWeight = rows.some((o) => o.weight !== undefined);
      const total = rows.reduce((n, o) => n + (Number(byWeight ? o.weight : o.chance) || 0), 0);
      const change = (fn, reshape = true) => (fn(), edited(reshape));
      const GIVES = [['item', 'an item'], ['pay', 'a prize'], ['share', 'a share of a pool'], ['burn', 'burn it'], ['nothing', 'nothing']];
      return h('div', { class: 'econ-rows', 'data-testid': 'econ-outcomes' },
        h('div', { class: 'econ-rows-head' }, h('span', {}, `What a roll lands on (${byWeight ? 'weights' : 'chances in %'})`),
          h('button', { class: 'link', disabled: locked || rows.length >= 8, onclick: () => change(() => (part.outcomes = [...rows, byWeight ? { gives: 'nothing', weight: 1 } : { gives: 'nothing', chance: Math.max(1, 100 - total) }])) }, '+ Add an outcome')),
        rows.map((o, i) => {
          const set = (k, v) => (v === undefined ? delete o[k] : (o[k] = v));
          return h('div', { class: 'econ-row' },
            h('input', { class: 'num', 'aria-label': byWeight ? 'Weight' : 'Chance in percent', inputMode: 'decimal', value: String((byWeight ? o.weight : o.chance) ?? ''), disabled: locked, 'data-path': `${id}|outcomes.${i}.odds`, oninput: (e) => change(() => set(byWeight ? 'weight' : 'chance', byWeight ? parseWhole(e.target.value) : parseNumber(e.target.value)), false) }),
            h('span', { class: 'unit' }, byWeight ? `of ${total}` : '%'),
            h('select', { 'aria-label': 'Gives', disabled: locked, 'data-path': `${id}|outcomes.${i}.gives`, onchange: (e) => change(() => {
              for (const k of ['item', 'pool', 'amount', 'percent']) delete o[k];
              o.gives = e.target.value;
              if (o.gives === 'item') o.item = spec.items?.[0]?.key;
              if (o.gives === 'pay' || o.gives === 'share') o.pool = spec.pools?.[0]?.key;
              if (o.gives === 'pay') o.amount = part.price;
              if (o.gives === 'share') o.percent = 10;
            }) }, GIVES.map(([v, l]) => h('option', { value: v, selected: o.gives === v }, l))),
            o.gives === 'item' ? h('select', { 'aria-label': 'Item', disabled: locked, 'data-path': `${id}|outcomes.${i}.item`, onchange: (e) => change(() => (o.item = e.target.value)) }, itemOptions(spec).some((x) => x.value === o.item) ? null : h('option', { selected: true, value: o.item ?? '' }, o.item ? `${o.item} (not found)` : 'add an item first'), itemOptions(spec).map((x) => h('option', { value: x.value, selected: x.value === o.item }, x.label))) : null,
            o.gives === 'pay' || o.gives === 'share' ? h('select', { 'aria-label': 'From pool', disabled: locked, 'data-path': `${id}|outcomes.${i}.pool`, onchange: (e) => change(() => (o.pool = e.target.value)) }, poolOptions(spec).some((x) => x.value === o.pool) ? null : h('option', { selected: true, value: o.pool ?? '' }, o.pool ? `${o.pool} (not found)` : 'add a pool first'), poolOptions(spec).map((x) => h('option', { value: x.value, selected: x.value === o.pool }, `from “${x.value}”`))) : null,
            o.gives === 'pay' ? h('input', { class: 'num', 'aria-label': 'Prize amount', inputMode: 'decimal', value: String(o.amount ?? ''), disabled: locked, 'data-path': `${id}|outcomes.${i}.amount`, oninput: (e) => change(() => set('amount', parseAmount(e.target.value)), false) }) : null,
            o.gives === 'pay' ? h('span', { class: 'unit' }, symbolOf(spec, (spec.pools ?? []).find((p) => p.key === o.pool)?.currency)) : null,
            o.gives === 'share' ? h('input', { class: 'num', 'aria-label': 'Share of the pool in percent', inputMode: 'decimal', value: String(o.percent ?? ''), disabled: locked, 'data-path': `${id}|outcomes.${i}.percent`, oninput: (e) => change(() => set('percent', parseNumber(e.target.value)), false) }) : null,
            o.gives === 'share' ? h('span', { class: 'unit' }, '% of it') : null,
            h('button', { class: 'x', title: 'Remove this outcome', 'aria-label': 'Remove this outcome', disabled: locked || rows.length <= 1, onclick: () => change(() => part.outcomes.splice(i, 1)) }, '×'));
        }),
        byWeight ? null : h('span', { class: Math.abs(total - 100) > 0.001 ? 'dim econ-bad-sum' : 'dim' }, `Chances add up to ${fmt(total)}%${Math.abs(total - 100) > 0.001 ? ': they must make 100%.' : '.'}`));
    }

    /** A recipe's lines: what goes in, what comes out. */
    function recipeRows(part, side, locked) {
      const id = partId('recipes', part.key);
      const rows = part[side] ?? [];
      const change = (fn, reshape = true) => (fn(), edited(reshape));
      const KINDS = side === 'in' ? [['burn', 'burn collectibles'], ['use', 'use one (kept)'], ['renew', 'renew one (kept, uses reset)'], ['pay', 'pay']] : [['item', 'a new collectible'], ['tokens', 'tokens'], ['share', 'a share of a pool']];
      const fresh = side === 'in' ? { takes: 'pay', amount: 0.01, to: (spec.pools ?? [])[0] ? `pool:${spec.pools[0].key}` : 'burn' } : { gives: 'item', item: spec.items?.[0]?.key };
      const sel = (label, value, options, onchange, p) => h('select', { 'aria-label': label, disabled: locked, 'data-path': `${id}|${side}.${p}`, onchange }, options.some((x) => x.value === (value ?? '')) ? null : h('option', { selected: true, value: value ?? '' }, value ? `${value} (not found)` : '—'), options.map((x) => h('option', { value: x.value, selected: x.value === value }, x.label)));
      const num = (label, value, onInput, p) => h('input', { class: 'num', 'aria-label': label, placeholder: label, inputMode: 'decimal', value: String(value ?? ''), disabled: locked, 'data-path': `${id}|${side}.${p}`, oninput: onInput });
      return h('div', { class: 'econ-rows', 'data-testid': `econ-recipe-${side}` },
        h('div', { class: 'econ-rows-head' }, h('span', {}, side === 'in' ? 'The player puts in' : 'and gets'), h('button', { class: 'link', disabled: locked || rows.length >= 8, onclick: () => change(() => (part[side] = [...rows, { ...fresh }])) }, '+ Add a line')),
        rows.map((l, i) => {
          const kindKey = side === 'in' ? 'takes' : 'gives';
          const set = (k, v) => (v === undefined || v === '' ? delete l[k] : (l[k] = v));
          const cells = [sel('Kind', l[kindKey], KINDS.map(([v, lab]) => ({ value: v, label: lab })), (e) => change(() => {
            for (const k of Object.keys(l)) delete l[k];
            l[kindKey] = e.target.value;
            if (['burn', 'use', 'renew', 'item'].includes(l[kindKey])) l.item = spec.items?.[0]?.key;
            if (l.takes === 'burn') l.count = 1;
            if (l.takes === 'pay') Object.assign(l, { amount: 0.01, to: (spec.pools ?? [])[0] ? `pool:${spec.pools[0].key}` : 'burn' });
            if (l.gives === 'tokens') Object.assign(l, { amount: 1, currency: spec.currency, from: (spec.pools ?? [])[0] ? `pool:${spec.pools[0].key}` : 'mint' });
            if (l.gives === 'share') Object.assign(l, { pool: spec.pools?.[0]?.key, percent: 10 });
          }), `${i}.kind`)];
          if (l.item !== undefined || ['burn', 'use', 'renew', 'item'].includes(l[kindKey])) cells.push(sel('Item', l.item, itemOptions(spec), (e) => change(() => (l.item = e.target.value)), `${i}.item`));
          if (l.takes === 'burn') cells.push(num('How many', l.count, (e) => change(() => set('count', parseWhole(e.target.value)), false), `${i}.count`));
          if (l.takes === 'pay' || l.gives === 'tokens') {
            cells.push(num('Amount', l.amount, (e) => change(() => set('amount', parseAmount(e.target.value)), false), `${i}.amount`));
            cells.push(sel('Currency', l.currency ?? '', tokenOptions(spec, `${symbolOf(spec)} (the game’s)`), (e) => change(() => set('currency', e.target.value)), `${i}.currency`));
          }
          if (l.takes === 'pay') cells.push(sel('Goes to', l.to, [...(spec.pools ?? []).map((p) => ({ value: `pool:${p.key}`, label: `into pool “${p.key}”` })), { value: 'burn', label: 'burned' }], (e) => change(() => (l.to = e.target.value)), `${i}.to`));
          if (l.gives === 'tokens') cells.push(sel('From', l.from, [{ value: 'mint', label: 'newly minted' }, ...(spec.pools ?? []).map((p) => ({ value: `pool:${p.key}`, label: `paid from pool “${p.key}”` }))], (e) => change(() => (l.from = e.target.value)), `${i}.from`));
          if (l.gives === 'share') {
            cells.push(sel('Pool', l.pool, poolOptions(spec), (e) => change(() => (l.pool = e.target.value)), `${i}.pool`));
            cells.push(num('% of it', l.percent, (e) => change(() => set('percent', parseNumber(e.target.value)), false), `${i}.percent`));
          }
          cells.push(h('button', { class: 'x', title: 'Remove this line', 'aria-label': 'Remove this line', disabled: locked, onclick: () => change(() => part[side].splice(i, 1)) }, '×'));
          return h('div', { class: 'econ-row' }, cells);
        }));
    }

    // ------------------------------------------------------------ what the numbers come to

    function simOf(section, key) {
      const sim = analysis.sim;
      return sim?.ok ? (sim[section] ?? []).find((x) => x.key === key) : null;
    }
    const lastsWords = (p) => ({ holds: 'holds steady', grows: 'grows', shrinks: 'shrinks slowly', settles: `settles${p.lastsDays ? ` in about ${fmt(p.lastsDays)} days` : ''}`, 'runs dry': `runs dry in about ${fmt(p.lastsDays)} days` })[p.lasts] ?? p.lasts;

    function facts(section, part) {
      const s = simOf(section, part.key);
      const lines = [];
      const sym = (k) => symbolOf(spec, k);
      if (section === 'pools') {
        const bal = (status?.pools ?? []).find((x) => (x.key !== undefined && x.key === part.key) || (Number.isInteger(part.index) && x.index === part.index));
        if (bal) lines.push(h('span', {}, 'Holds now: ', h('b', {}, `${amountText(bal.amount ?? bal.balance)} ${sym(part.currency)}`)));
        if (s) lines.push(h('span', {}, h('b', {}, `${fmt(s.inPerDay)} in, ${fmt(s.outPerDay)} out`), ` a day · it ${lastsWords(s)}`), s.swingPerDay ? h('span', { class: 'dim' }, `Luck moves it about ±${fmt(s.swingPerDay)} ${sym(part.currency)} a day.`) : null);
      } else if (section === 'boxes' && s) {
        lines.push(h('span', {}, 'A roll gives back ', h('b', {}, `${fmt(s.expectedBack)} ${sym(s.token)}`), ` on average (${fmt(s.returnPercent)}% of its price)`),
          h('span', {}, 'The house keeps ', h('b', {}, `${fmt(s.houseEdgePercent)}%`), ` · players also pay games.fun’s ${fmt(s.playerFee)} SOL fee${s.oracleFee ? ` and the oracle’s ${fmt(s.oracleFee)} SOL` : ''} a roll${s.realCost?.totalSol !== undefined ? ` (${fmt(s.realCost.totalSol)} SOL a roll in all)` : ''}`));
        if (s.unpriced?.length) lines.push(h('span', { class: 'dim' }, `Items with no price or value aren’t counted: ${s.unpriced.join(', ')}.`));
      } else if (section === 'lotteries' && s) {
        const perWeek = s.roundDays ? (s.potBeforeDraw * 7) / s.roundDays : s.potBeforeDraw;
        lines.push(h('span', {}, 'The pot reaches about ', h('b', {}, `${fmt(s.potBeforeDraw)} ${sym(s.potToken)}`), ` a draw (${fmt(perWeek)} a week), from ${fmt(s.ticketsPerRound)} tickets`),
          h('span', {}, 'Prizes ', h('b', {}, s.prizes.map(fmt).join(' / ')), ` · a ticket is worth ${fmt(s.expectedPerTicket)} on average (${fmt(s.returnPercent)}%)`));
      } else if (section === 'stakes' && s) {
        lines.push(h('span', {}, h('b', {}, `${fmt(s.rewardsPerDay)} ${sym(s.rewardsToken)}`), ' a day to everyone staked'), h('span', {}, `${fmt(s.perThousandStakedPerDay)} a day for each 1,000 ${sym(s.stakes)} staked (with ${fmt(s.staked)} staked)`));
      } else if (section === 'items' && s) {
        lines.push(h('span', {}, `Sells about ${fmt(s.salesPerDay)} a day${s.soldOutInDays ? ` · sold out in about ${fmt(s.soldOutInDays)} days` : ''}`));
      } else if (section === 'payments' && s) {
        lines.push(h('span', {}, `About ${fmt(s.perDay)} a day: `, h('b', {}, `${fmt(s.perDay * Number(part.amount || 0))} ${sym(s.token)}`), ' a day'));
      } else if (section === 'recipes' && s) {
        lines.push(h('span', {}, `About ${fmt(s.craftsPerDay)} a day · takes ${s.takes.join(', ') || 'nothing'} · gives ${s.gives.join(', ') || 'nothing'}`));
      } else if ((section === 'schedules' || section === 'contests') && s?.says) {
        lines.push(h('span', {}, s.says));
      }
      return lines.length ? h('div', { class: 'econ-facts', 'data-testid': 'econ-facts' }, lines) : null;
    }

    /** "About [100] a day (for the numbers)": the scenario line for this part. */
    function dayInput(section, part) {
      const day = sectionOf(section)?.day;
      if (!day) return null;
      const k = `${day}:${part.key}`;
      const id = partId(section, part.key);
      const value = spec.scenario?.perDay?.[k];
      const fallback = analysis.sim?.ok ? analysis.sim.scenario?.defaultPerDay ?? 100 : 100;
      return h('label', { class: 'econ-day' }, 'The numbers assume about',
        h('input', { inputMode: 'decimal', value: value === undefined ? '' : String(value), placeholder: String(fallback), 'data-path': `${id}|perDay`, oninput: (e) => {
          const v = parseNumber(e.target.value);
          spec.scenario ??= {};
          spec.scenario.perDay ??= {};
          if (v === undefined) delete spec.scenario.perDay[k];
          else spec.scenario.perDay[k] = v;
          if (!Object.keys(spec.scenario.perDay).length) delete spec.scenario.perDay;
          if (!Object.keys(spec.scenario).length) delete spec.scenario;
          edited();
        } }),
        section === 'stakes' ? 'new stakes a day' : 'a day');
    }

    // ------------------------------------------------------------ the cards

    function head(section, part, title, liveState) {
      const id = partId(section, part.key);
      const sect = sectionOf(section);
      const removing = confirmRemove === id;
      return h('div', { class: 'econ-part-head' },
        h('span', { class: 'econ-kind' }, sect.one),
        h('strong', {}, title),
        h('span', { class: 'econ-key', title: 'Its key: other parts name it by this' }, part.key),
        h('span', { class: `econ-state ${liveState}` }, STATE_WORDS[liveState]),
        removing
          ? h('span', { class: 'w3-row' }, h('button', { 'data-testid': 'econ-remove-yes', onclick: () => ((confirmRemove = null), removePart(spec, section, part.key), open.delete(id), edited(true)) }, isLivePart(section, part) ? 'Remove (switched off when you put it live)' : 'Yes, remove it'), h('button', { onclick: () => ((confirmRemove = null), render()) }, 'Keep it'))
          : h('button', { class: 'link', 'data-testid': 'econ-remove', onclick: () => ((confirmRemove = id), render()) }, 'Remove'));
    }

    function partCard(section, part, byPart, live) {
      const id = partId(section, part.key);
      const notes = byPart.get(id) ?? [];
      const fieldsOf = FIELDS[section];
      const liveState = live.get(id) ?? (isLivePart(section, part) ? 'live' : 'draft');
      const locked = section === 'stakes' && isLivePart(section, part); // a stake can't change once open
      const shown = (list) => (list ?? []).filter((f) => !f.when || f.when(part));
      const title = section === 'pools' ? `Pool “${part.key}”` : section === 'decisions' ? part.when || 'A rule' : nameOf(part);
      const more = shown(fieldsOf.more);
      const lists = fieldsOf.lists ?? [];
      return h('div', { class: 'card econ-part', 'data-part-card': id, 'data-testid': `econ-part-${section}` },
        head(section, part, title, liveState),
        locked ? h('p', { class: 'note' }, 'This stake is open: the program does not let it change. Make a new one to change its terms.') : null,
        section === 'items' ? itemPicture(part) : null,
        h('div', { class: 'econ-fields' }, shown(fieldsOf.main).map((f) => field(section, part, f, notes, locked))),
        lists.includes('outcomes') ? outcomeRows(part, locked) : null,
        lists.includes('in') ? recipeRows(part, 'in', locked) : null,
        lists.includes('out') ? recipeRows(part, 'out', locked) : null,
        lists.includes('split') && section !== 'items' ? splitRows(section, part, locked) : null,
        facts(section, part),
        dayInput(section, part),
        notes.map(noteView),
        more.length || (lists.includes('split') && section === 'items')
          ? h('details', { open: open.has(id), ontoggle: (e) => (e.target.open ? open.add(id) : open.delete(id)) }, h('summary', {}, 'More'),
              h('div', { class: 'econ-fields', style: 'margin-top:8px' }, more.map((f) => field(section, part, f, notes, locked))),
              section === 'items' ? splitRows(section, part, locked) : null)
          : null);
    }

    function itemPicture(part) {
      const src = part.picture ? pictureUrl(part.picture) : part.image;
      return h('div', { class: 'w3-row' },
        h('button', { class: 'pic slot', title: 'Pick a picture from the game', 'data-testid': 'econ-item-picture', onclick: async () => {
          const p = await choosePicture(state, 'Item picture');
          if (p) (part.picture = p), edited(true);
        } }, src ? h('img', { class: 'pic', src, alt: '', referrerpolicy: 'no-referrer' }) : 'Pick a picture'),
        h('p', { class: 'dim grow' }, 'Its picture, from the game’s own files. Players see it in their wallet.'));
    }

    // the token: SOL, the game's token launched here on a curve of its own, one the creator already has (launched
    // anywhere), or points
    function tokenCard(tok, byPart, live) {
      const id = partId('tokens', tok.key);
      const notes = byPart.get(id) ?? [];
      const sym = symbolOf(spec, tok.key);
      const title = tok.source === 'sol' ? 'SOL' : `${tok.name ?? sym} · $${sym}`;
      const liveState = live.get(id) ?? (tok.mint || tok.source === 'sol' ? 'live' : 'draft');
      const isCurrency = (spec.currency ?? spec.tokens?.[0]?.key) === tok.key;
      const body = [];
      if (tok.source === 'sol') body.push(h('p', { class: 'dim' }, 'Players pay in SOL (wrapped for the program). Nothing to set up.'));
      else if (tok.source === 'curve' && tok.mint) body.push(launchedToken(tok));
      else if (tok.source === 'curve') body.push(launchForm(tok, notes));
      else if (tok.source === 'existing') body.push(existingToken(tok, notes));
      else body.push(h('p', { class: 'dim' }, 'A token the game mints itself: points, tickets, shards. It is made when the economy goes live.'), h('div', { class: 'econ-fields' }, [{ p: 'name', label: 'Name', type: 'text', max: 32 }, { p: 'symbol', label: 'Ticker', type: 'text', max: 10 }, { p: 'decimals', label: 'Decimals (0: whole points)', type: 'whole' }].map((f) => field('tokens', tok, f, notes, Boolean(spec.live)))));
      return h('div', { class: 'card econ-part', 'data-part-card': id, 'data-testid': 'econ-part-tokens' },
        head('tokens', tok, title, liveState),
        h('label', { class: 'check' }, h('input', { type: 'radio', name: 'econ-currency', checked: isCurrency, disabled: Boolean(spec.live), 'data-testid': 'econ-currency', onchange: () => ((spec.currency = tok.key), edited(true)) }),
          isCurrency ? 'The game’s currency: items are priced in it and your treasury holds it' : 'Make it the game’s currency', spec.live ? ' (fixed once live)' : ''),
        body,
        notes.map(noteView));
    }

    function launchedToken(tok) {
      const live = state?.chain?.token && state.config?.token?.mint === tok.mint ? state.chain.token : null;
      const cfg = state?.config?.token?.mint === tok.mint ? state.config.token : null;
      return h('div', { 'data-testid': 'token-card' },
        h('div', { class: 'econ-token' },
          tok.image || cfg?.image ? h('img', { class: 'pic slot', src: tok.image ?? cfg.image, alt: '', referrerpolicy: 'no-referrer' }) : null,
          h('div', { class: 'grow' },
            h('p', { class: 'dim' }, tok.venue === 'games.fun' ? `Launched with games.fun on a Meteora curve${cfg?.quoteSymbol ? `, paired with ${cfg.quoteSymbol}` : ''}. Its name, ticker and picture are permanent.` : 'A token on a curve.'),
            h('p', { class: 'mono' }, 'Mint ', h('a', { href: explorer(state, 'address', tok.mint), target: '_blank', rel: 'noreferrer' }, tok.mint)),
            cfg?.pool ? h('p', { class: 'mono dim' }, `Pool ${cfg.pool}`) : null,
            live ? h('p', { class: 'dim' }, live.exists ? 'Found on chain.' : 'Not found on chain yet (it can take a few seconds).') : null,
            live?.pool ? h('p', { class: 'dim' }, `Curve: ${live.pool.quoteReserve ? 'trading' : 'open'}${live.pool.isMigrated ? ', graduated' : ''}.`) : null)));
    }

    /** The Token tab's launch, as a part: a picture, a name and a ticker; the rest is optional. Its own approval. */
    function launchForm(tok, notes) {
      const L = state?.network?.launch ?? {};
      const pairs = L.pairs ?? [{ symbol: 'SOL', mint: 'So11111111111111111111111111111111111111112', native: true }];
      const f = (launch[tok.key] ??= { picture: null, description: '', initialBuy: '', pair: tok.pair ?? L.defaultPair ?? 'SOL', solUsd: '', startCap: '', graduationCap: '' });
      const quick = pairs.find((p) => p.symbol === f.pair || p.symbol.split('-')[0] === f.pair);
      const q = quick?.symbol ?? 'the pair';
      const priced = quick && L.pairPrices?.[quick.mint] != null;
      const split = L.split ?? { creatorTradingFeePercentage: 95, partnerLockedLp: 5 };
      const symbol = tok.symbol ?? '';
      const input = () => ({ name: tok.name, symbol, picture: f.picture, description: f.description, initialBuy: f.initialBuy, pair: f.pair,
        ...(f.solUsd ? { solUsd: f.solUsd } : {}), ...(f.startCap ? { startCap: f.startCap } : {}), ...(f.graduationCap ? { graduationCap: f.graduationCap } : {}) });
      const capsMissing = !priced && !(f.startCap && f.graduationCap);
      return h('div', { class: 'econ-rows', 'data-testid': 'launch-form' },
        h('p', { class: 'dim' }, `Launch it on a Meteora bonding curve of its own: players buy it with ${q}. You keep ${split.creatorTradingFeePercentage}% of its trading fees and games.fun gets ${split.partnerLockedLp}%. A picture, a name and a ticker are all it needs. It is its own approval, before the economy goes live. A token you launched somewhere else works just as well: “Use a token I already have”.`),
        h('div', { class: 'w3-row' },
          h('button', { class: 'pic slot', title: 'Pick a picture', 'data-testid': 'token-picture', onclick: async () => {
            const p = await choosePicture(state, 'Token picture');
            if (p) (f.picture = p), render();
          } }, f.picture ? h('img', { class: 'pic', src: pictureUrl(f.picture), alt: '' }) : 'Pick a picture'),
          h('div', { class: 'grow econ-fields' },
            field('tokens', tok, { p: 'name', label: 'Name', type: 'text', max: 32 }, notes, false),
            h('label', { class: 'field' }, 'Ticker', h('input', { value: symbol, maxLength: 10, 'data-testid': 'token-symbol', 'data-path': `${partId('tokens', tok.key)}|symbol`, oninput: (e) => {
              const clean = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
              if (clean !== e.target.value) e.target.value = clean;
              tok.symbol = clean || undefined;
              edited();
            } })),
            h('label', { class: 'field' }, 'Paired with', h('select', { 'data-testid': 'token-pair', onchange: (e) => {
              f.pair = e.target.value === 'mint' ? '' : e.target.value;
              if (e.target.value !== 'mint') tok.pair = f.pair, edited();
              render();
            } },
              ...pairs.map((p) => h('option', { value: p.symbol, selected: Boolean(quick) && quick.symbol === p.symbol }, p.symbol)),
              h('option', { value: 'mint', selected: !quick }, 'Another token (mint address)'))),
            quick ? null : h('label', { class: 'field' }, 'Pair’s mint address', h('input', { value: f.pair, placeholder: 'Mint address', 'data-testid': 'token-pair-mint', oninput: (e) => {
              f.pair = e.target.value.trim();
              tok.pair = f.pair || undefined;
              edited();
            } })))),
        h('details', {}, h('summary', {}, 'Initial buy, curve size and description (optional)'),
          h('label', { class: 'field' }, `Buy at launch, in ${q} (in the same transaction as the pool, so nobody buys first)`, h('input', { value: f.initialBuy, inputMode: 'decimal', placeholder: 'None', 'data-testid': 'token-initial-buy', oninput: (e) => (f.initialBuy = e.target.value.replace(/[^0-9.]/g, '')) })),
          quick?.native ? h('label', { class: 'field' }, `SOL’s price in dollars, for sizing the curve (default $${L.pairPrices?.[quick.mint] ?? 100}, a devnet reference, not a market price)`, h('input', { value: f.solUsd, inputMode: 'decimal', placeholder: String(L.pairPrices?.[quick.mint] ?? 100), oninput: (e) => (f.solUsd = e.target.value.replace(/[^0-9.]/g, '')) })) : null,
          h('p', { class: 'dim' }, priced ? 'The curve starts near a $5,000 market cap and graduates near $75,000. Set both caps below to size it yourself.' : `This pair has no price: set the curve’s start and graduation market caps, in whole ${q} tokens.`),
          h('div', { class: 'w3-row' },
            h('label', { class: 'field' }, `Start market cap (${q})`, h('input', { value: f.startCap, inputMode: 'decimal', placeholder: priced ? 'From the dollar curve' : 'Required', 'data-testid': 'token-start-cap', oninput: (e) => (f.startCap = e.target.value.replace(/[^0-9.]/g, ''), render()) })),
            h('label', { class: 'field' }, `Graduation market cap (${q})`, h('input', { value: f.graduationCap, inputMode: 'decimal', placeholder: priced ? 'From the dollar curve' : 'Required', 'data-testid': 'token-graduation-cap', oninput: (e) => (f.graduationCap = e.target.value.replace(/[^0-9.]/g, ''), render()) }))),
          h('label', { class: 'field' }, 'Description', h('textarea', { rows: 3, maxLength: 1000, value: f.description, oninput: (e) => (f.description = e.target.value) }))),
        h('div', { class: 'w3-row' },
          h('button', { class: 'primary', 'data-testid': 'token-launch-go', disabled: !f.picture || !(tok.name ?? '').trim() || symbol.length < 2 || !f.pair || capsMissing,
            onclick: () => start({ kind: 'launch', input: input() }) },
            `Launch $${symbol || 'TOKEN'}${Number(f.initialBuy) > 0 ? ` and buy ${f.initialBuy} ${q}` : ''}`),
          !f.picture ? h('span', { class: 'dim' }, 'Add a picture first.') : capsMissing ? h('span', { class: 'dim' }, 'Set both market caps first.') : null,
          h('button', { class: 'link', onclick: () => ((tok.source = 'existing'), delete tok.venue, delete tok.pair, edited(true)) }, 'Use a token I already have instead')),
        h('p', { class: 'dim' }, 'Your wallet becomes the token’s creator and signs; no keys leave it.'));
    }

    function existingToken(tok, notes) {
      const l = (lookups[tok.key] ??= { info: null, error: '', looking: false });
      const look = async (text) => {
        const mint = text.trim();
        Object.assign(l, { info: null, error: '', looking: Boolean(mint) });
        render();
        if (!mint) return;
        try {
          const info = await t.api('/mint', { mint });
          Object.assign(l, { info, looking: false });
          Object.assign(tok, { mint: info.mint ?? mint, decimals: info.decimals, program: info.program === 'token-2022' ? 'token-2022' : 'spl-token' });
          if (info.symbol) tok.symbol = String(info.symbol).slice(0, 10);
          if (info.name) tok.name = String(info.name).slice(0, 32);
          edited(true);
        } catch (error) {
          Object.assign(l, { error: error.message, looking: false });
          render();
        }
      };
      return h('div', { class: 'econ-rows', 'data-testid': 'link-form' },
        h('p', { class: 'dim' }, 'Any Solana token works, classic or Token-2022 (pump.fun’s too). Paste its mint address.'),
        h('label', { class: 'field' }, 'Token address', h('input', { value: tok.mint ?? '', spellcheck: false, placeholder: 'The mint address of any token, launched anywhere', 'data-testid': 'link-mint', 'data-path': `${partId('tokens', tok.key)}|mint`, disabled: Boolean(spec.live && tok.mint), onchange: (e) => look(e.target.value) })),
        l.looking ? h('p', { class: 'dim' }, 'Looking it up…') : null,
        l.error ? h('p', { class: 'note error' }, l.error) : null,
        tok.mint && tok.decimals !== undefined ? h('p', { class: 'note', 'data-testid': 'mint-card' }, h('strong', {}, tok.name ?? 'Unnamed token'), ` ${tok.symbol ? `$${tok.symbol}` : ''} · ${tok.decimals} decimals${tok.program === 'token-2022' ? ' · Token-2022' : ''}`) : null);
    }

    function collectionCard() {
      const c = spec.collection;
      const f = (p, label, type, extra = {}) => h('label', { class: `field${type === 'words' ? ' wide' : ''}` }, label,
        h(type === 'words' ? 'textarea' : 'input', { rows: 2, value: String(c[p] ?? ''), inputMode: type === 'percent' ? 'decimal' : null, 'data-path': `collection|${p}`, oninput: (e) => {
          const v = (PARSE[type] ?? PARSE.text)(e.target.value);
          if (v === undefined && p !== 'name') delete c[p];
          else c[p] = v ?? '';
          edited();
        }, ...extra }));
      return h('div', { class: 'card econ-part', 'data-testid': 'econ-collection' },
        h('div', { class: 'econ-part-head' }, h('span', { class: 'econ-kind' }, 'collection'), h('strong', {}, c.name || 'Collectibles')),
        h('p', { class: 'dim' }, 'The collection the items are minted into (Metaplex Core). Your wallet controls it, not games.fun.'),
        h('div', { class: 'econ-fields' }, f('name', 'Name', 'text', { maxLength: 32 }), f('royaltyPercent', 'Royalty on resales (%)', 'percent'), f('description', 'Describe it', 'words')));
    }

    function settingsCard() {
      const authority = spec.keys?.authority ?? 'owner';
      const other = authority !== 'owner';
      const needed = ['contests', 'holds', 'decisions'].some((s) => (spec[s] ?? []).length);
      return h('div', { class: 'card econ-part', 'data-testid': 'econ-settings' },
        h('div', { class: 'econ-part-head' }, h('span', { class: 'econ-kind' }, 'settings'), h('strong', {}, 'The whole economy')),
        h('div', { class: 'econ-fields' },
          h('label', { class: 'field' }, 'Its name', h('input', { value: spec.name ?? '', maxLength: 80, 'data-path': 'settings|name', oninput: (e) => ((spec.name = e.target.value || undefined), edited()) })),
          h('label', { class: 'field' }, 'The numbers look ahead', h('input', { inputMode: 'decimal', value: String(spec.scenario?.days ?? ''), placeholder: '30', 'data-path': 'settings|days', oninput: (e) => {
            const v = parseNumber(e.target.value);
            spec.scenario ??= {};
            if (v === undefined) delete spec.scenario.days;
            else spec.scenario.days = v;
            if (!Object.keys(spec.scenario).length) delete spec.scenario;
            edited();
          } })),
          needed || other
            ? h('label', { class: 'field wide' }, 'Who signs what only the game knows (who won, who cleared the level)',
                h('select', { 'data-path': 'settings|authority', onchange: (e) => ((spec.keys = e.target.value === 'owner' ? undefined : { authority: '' }), e.target.value === 'owner' && delete spec.keys, edited(true)) },
                  h('option', { value: 'owner', selected: !other }, 'You, from this page (your wallet)'), h('option', { value: 'other', selected: other }, 'Another wallet (a server or the keeper on your machine)')))
            : null,
          other ? h('label', { class: 'field wide' }, 'That wallet’s public address (never a private key)', h('input', { value: authority, spellcheck: false, 'data-path': 'settings|authority-address', oninput: (e) => ((spec.keys = { authority: e.target.value.trim() }), edited()) })) : null));
    }

    function addMenu() {
      const title = state?.game?.title ?? spec.name ?? '';
      const add = (kind, variant) => () => {
        const { section, key } = addPart(spec, kind, { title, variant });
        const id = partId(section, key);
        open.add(id);
        edited(true);
        pick({ section, key });
      };
      const hasCurve = (spec.tokens ?? []).some((x) => x.source === 'curve');
      return h('div', { class: 'card', 'data-testid': 'econ-add' },
        h('h3', {}, 'Add a part'),
        h('div', { class: 'econ-add' },
          SECTIONS.filter((s) => s.section !== 'tokens').map((s) => h('button', { 'data-testid': `econ-add-${s.kind}`, onclick: add(s.kind) }, `+ ${s.add[0].toUpperCase()}${s.add.slice(1)}`)),
          hasCurve ? null : h('button', { 'data-testid': 'econ-add-token-curve', onclick: add('token', 'curve') }, '+ Launch a token for this game'),
          h('button', { 'data-testid': 'econ-add-token-existing', onclick: add('token', 'existing') }, '+ A token I already have'),
          h('button', { 'data-testid': 'econ-add-token-game', onclick: add('token', 'game') }, '+ Points the game mints')),
        h('p', { class: 'dim' }, 'Each starts with numbers that work. Change them in its card.'));
    }

    // ------------------------------------------------------------ the page

    function flowCard() {
      flowBox = h('div', { 'data-testid': 'econ-flow-box' });
      const card = h('div', { class: 'card' },
        h('h3', {}, 'Where the money goes'),
        h('p', { class: 'dim', style: 'margin:0 0 8px' }, 'Players pay into the parts, the parts fill the pools, and the pools pay out. Click a box to change it.'),
        flowBox,
        h('div', { class: 'econ-legend' }, LEGEND.map(([kind, words]) => h('span', {}, h('i', { style: `background:${edgeColour(kind)}` }), words))));
      return card;
    }
    function drawFlowNow() {
      if (!flowBox || !spec) return;
      const width = flowBox.clientWidth || root.clientWidth - 30 || 520;
      lastWidth = width;
      flowBox.replaceChildren(drawFlow(spec, width, { onPick: pick, live: liveMap(), selected }));
    }

    /**
     * Where the wallet stands, when it is not connected yet: the header's "Connect wallet" connects it (the studio's one
     * wallet button), and "Put it live" asks the wallet to connect first anyway. Nothing when a wallet is connected.
     */
    function walletNote() {
      if (t.wallet.address()) return null;
      const none = typeof ctx?.wallet?.list === 'function' && !ctx.wallet.list().length;
      return h('p', { class: 'dim', 'data-testid': 'econ-wallet-note' }, none
        ? 'No Solana wallet in this browser yet. Install one (Phantom, Solflare, Backpack…) and reload, then connect it with Connect wallet at the top of the studio to put it live.'
        : 'Connect a wallet to put it live: Connect wallet, at the top of the studio. Or press Put it live, and your wallet asks first.');
    }

    function goCard() {
      const c = analysis.cost;
      const why = whyNot();
      const firstRefusal = refusals()[0];
      const setup = c?.ok ? c.setup : null;
      const seeds = setup ? Object.entries(setup.seeds ?? {}).map(([k, v]) => `${fmt(v)} ${k}`) : [];
      return h('div', { class: 'card econ-live', 'data-testid': 'econ-go' },
        h('div', { class: 'econ-go' },
          h('div', { class: 'why' },
            h('div', { class: 'dim' }, 'Putting it live costs about'),
            h('div', { class: 'econ-cost', 'data-testid': 'econ-cost' }, setup ? `${fmt(setup.totalSol)} SOL` : '–'),
            setup
              ? h('div', { class: 'dim', 'data-testid': 'econ-cost-line' }, [`rent ${fmt(setup.rentSol)} SOL (${setup.accounts.length} accounts)`, seeds.length ? `seeds ${seeds.join(' + ')}` : null, `fees ${fmt(setup.programFeesSol + setup.networkFeesSol)} SOL`, `${setup.transactions} transaction${setup.transactions === 1 ? '' : 's'}, ${setup.approvals} approval${setup.approvals === 1 ? '' : 's'}`].filter(Boolean).join(' · '))
              : h('div', { class: 'dim' }, c?.error ?? (refusals().length ? 'The cost comes once the notes marked ✗ are fixed.' : 'Working it out…'))),
          h('div', { class: 'w3-row', style: 'align-items:center' },
            h('button', { class: 'primary', 'data-testid': 'econ-go-live', disabled: Boolean(why), title: why || 'One approval in your wallet', onclick: goLive }, status?.live ? 'Put the changes live' : 'Put it live'))),
        why ? h('p', { class: refusals().length ? 'note error' : 'dim', 'data-testid': 'econ-go-why', role: 'status' }, why, ' ', firstRefusal ? h('button', { class: 'linkish', onclick: showRefusal }, 'Show me') : null) : h('p', { class: 'dim' }, 'One approval in your wallet sets up everything below on devnet. Your wallet owns it, not games.fun.'),
        walletNote(),
        setup?.notes?.length || setup?.accounts?.length
          ? h('details', {}, h('summary', {}, 'What the cost is made of'),
              h('ul', { class: 'econ-receipts' }, (setup.accounts ?? []).map((a) => h('li', {}, `${a.approx ? 'about ' : ''}${fmt(a.sol)} SOL: ${a.what}`)), (setup.notes ?? []).map((n) => h('li', { class: 'dim' }, n))),
              (c.actions ?? []).length ? h('p', { class: 'dim' }, 'While it runs, each player action also costs the player games.fun’s fee (', fmt(c.actions[0].feeSol), ' SOL) and a network fee.') : null,
              (c.actions ?? []).some((a) => a.oracleSol) ? h('p', { class: 'dim', 'data-testid': 'econ-cost-oracle' }, 'Anything left to chance (opening a box, drawing a lottery, a roll) also pays MagicBlock’s oracle ', fmt(c.fees?.oracleSol ?? c.actions.find((a) => a.oracleSol).oracleSol), ' SOL for the random number, from whoever asks: the player for a box.') : null)
          : null);
    }

    /** Opens the first part with a refusal (or the whole-economy notes). */
    function showRefusal() {
      const { byPart } = notesByPart(spec, analysis.check);
      for (const [id, notes] of byPart) {
        if (!notes.some((n) => n.level === 'refusal')) continue;
        const at = id.indexOf(':');
        return pick({ section: id.slice(0, at), key: id.slice(at + 1) });
      }
      root.querySelector('[data-testid="econ-general"]')?.scrollIntoView({ behavior: 'smooth' });
    }

    /** The link's ask: "Put it live" offered at once (it starts only on the click), or a decision to check and sign. */
    function askedCard() {
      if (!asked) return null;
      if (asked.kind === 'publish') {
        const why = whyNot();
        return h('div', { class: 'card econ-live', 'data-testid': 'econ-asked' },
          h('strong', {}, 'Your agent asked to put the economy live'),
          h('p', { class: 'dim' }, 'Look it over below first. Nothing happens until you press the button and approve in your wallet.'),
          why ? h('p', { class: refusals().length ? 'note error' : 'dim' }, why) : null,
          walletNote(),
          h('div', { class: 'w3-row' },
            h('button', { class: 'primary', 'data-testid': 'econ-asked-go', disabled: Boolean(why), onclick: () => ((asked = null), goLive()) }, status?.live ? 'Put the changes live' : 'Put it live'),
            h('button', { onclick: forget }, 'Not now')));
      }
      return decide.askedCard(asked, forget);
    }

    function summaryCard() {
      const sim = analysis.sim;
      if (!sim?.ok) return h('div', { class: 'card dim', 'data-testid': 'econ-summary' }, sim?.error ?? 'The numbers come once the economy checks out.');
      const d = sim.perDay ?? {};
      const money = (obj) => Object.entries(obj ?? {}).map(([k, v]) => `${fmt(v)} ${k.toUpperCase() === 'SOL' ? 'SOL' : symbolOf(spec, k)}`).join(' + ') || 'nothing';
      return h('div', { class: 'card', 'data-testid': 'econ-summary' },
        h('h3', {}, 'A day, on these numbers'),
        h('p', { class: 'dim', style: 'margin:0 0 8px' }, 'From the quick simulation: what players do a day is the "a day" number on each card.'),
        h('div', { class: 'econ-sum' },
          h('div', {}, h('b', {}, money(d.players?.pay)), h('span', {}, 'players pay in')),
          h('div', {}, h('b', {}, money(d.players?.getBack)), h('span', {}, 'players win back, on average')),
          h('div', {}, h('b', {}, money(d.creator?.treasury)), h('span', {}, 'to your treasury')),
          h('div', {}, h('b', {}, money(d.burned)), h('span', {}, 'burned')),
          h('div', {}, h('b', {}, `${fmt(d.platform?.totalSol ?? 0)} SOL`), h('span', {}, 'games.fun’s fees, paid by players'))),
        (sim.notes ?? []).map((n) => h('p', { class: 'econ-note warning' }, n)));
    }

    function liveCard() {
      const receipts = status?.receipts ?? [];
      if (!status?.live && !spec.live) return null;
      return h('div', { class: 'card econ-live', 'data-testid': 'econ-status' },
        h('h3', {}, 'Live on devnet'),
        statusError && !status ? h('p', { class: 'note error' }, `Could not read what is live: ${statusError}`) : null,
        status?.game || spec.live?.game ? h('p', { class: 'mono' }, 'Game ', h('a', { href: explorer(state, 'address', status?.game ?? spec.live.game), target: '_blank', rel: 'noreferrer' }, short(status?.game ?? spec.live.game))) : null,
        status ? h('p', { class: 'dim' }, (() => {
          const m = [...liveMap().values()];
          const changed = m.filter((x) => x === 'changed').length;
          const draft = m.filter((x) => x === 'draft').length;
          return `${m.filter((x) => x === 'live').length} part${m.length === 1 ? '' : 's'} live${changed ? `, ${changed} changed since` : ''}${draft ? `, ${draft} not live yet` : ''}.`;
        })()) : null,
        receipts.length
          ? h('div', {}, h('strong', {}, 'Latest receipts'),
              h('ul', { class: 'econ-receipts', 'data-testid': 'econ-receipts' }, receipts.slice(0, 12).map((r) => {
                const sig = r.signature ?? r.tx;
                const href = r.url ?? (sig ? explorer(state, 'tx', sig) : null);
                const when = r.at ? new Date(typeof r.at === 'number' && r.at < 1e12 ? r.at * 1000 : r.at).toLocaleString() : '';
                return h('li', {}, r.says ?? r.what ?? r.kind ?? 'Transaction', when ? h('span', { class: 'dim' }, ` · ${when}`) : null, href ? [' · ', h('a', { href, target: '_blank', rel: 'noreferrer' }, sig ? short(sig) : 'explorer')] : null);
              })))
          : h('p', { class: 'dim' }, 'No receipts yet.'));
    }

    function render() {
      if (loadError && !spec) {
        fill(root, note('error', `Could not load the game’s economy: ${loadError}`), h('button', { onclick: refresh }, 'Try again'));
        return;
      }
      if (!spec || !state) return fill(root, h('p', { class: 'dim' }, 'Loading the economy…'));
      // keep the caret where the creator is typing
      const active = document.activeElement;
      const focus = root.contains(active) && active.dataset?.path ? { path: active.dataset.path, start: active.selectionStart, end: active.selectionEnd } : null;
      // the tab's title and the wallet button are the studio's (the rail's "Economy", the header's Connect wallet)
      if (flow) {
        fill(root, message ? note(message.kind, message.text) : null,
          approvalPanel(t, flow, {
            onDone: (view) => {
              const kind = view?.kind ?? flow?.kind;
              message = { kind: 'ok', text: decide.doneText(kind) ?? (kind === 'launch' ? 'Your token is live.' : 'Your economy is live on devnet.') };
              if (kind === 'decide') forget();
              flow = null;
              refresh();
            },
            onClose: () => ((flow = null), refresh()),
          }));
        return;
      }
      const { byPart, general } = notesByPart(spec, analysis.check);
      const live = liveMap();
      const groups = [];
      for (const s of SECTIONS) {
        const list = spec[s.section] ?? [];
        if (!list.length) continue;
        groups.push(h('div', { class: 'econ-group', 'data-testid': `econ-group-${s.section}` }, h('h3', {}, s.many), list.map((p) => (s.section === 'tokens' ? tokenCard(p, byPart, live) : partCard(s.section, p, byPart, live)))));
        if (s.section === 'items' && spec.collection) groups.push(collectionCard());
      }
      const requests = ['economy', 'publish', 'launch'].flatMap((kind) => requestBanner(t, state, kind, { onReview: (r) => start({ requestId: r.id }), onDone: refresh }));
      fill(root,
        h('p', { class: 'dim', style: 'margin:0', 'data-testid': 'econ-intro' }, `Everything ${state.game?.title ?? 'the game'} sells, pays and burns, in one place. Change any number and the rest follows. Nothing is live until you approve it in your wallet. On devnet: test money only.`),
        message ? note(message.kind, message.text) : null,
        state.chainError ? note('error', state.chainError) : null,
        saveError ? h('div', { class: 'note error', role: 'alert', 'data-testid': 'econ-save-error' }, saveError) : null,
        econ?.source === 'shop'
          ? h('div', { class: 'note', 'data-testid': 'econ-migrated' }, h('strong', {}, 'Your shop, as an economy. '), (econ.notes ?? []).join(' '), ' It is saved as one the first time you change something, or ', h('button', { class: 'linkish', onclick: async () => (await save(), render()) }, 'save it now'), '.')
          : null,
        requests,
        askedCard(),
        goCard(),
        flowCard(),
        general.length ? h('div', { class: 'card econ-rows', 'data-testid': 'econ-general' }, h('h3', {}, 'About the whole economy'), general.map(noteView)) : null,
        summaryCard(),
        groups.length ? groups : h('div', { class: 'card' }, h('p', {}, 'No parts yet. Add one below: a box players pay to roll, a lottery, a stake, an item for sale…')),
        addMenu(),
        settingsCard(),
        decide.sectionCard(openDecision),
        liveCard(),
        h('p', { class: 'dim' }, `RPC: ${state.rpc?.shown ?? ''}${state.rpc?.custom ? ' (yours)' : ' (public; set your own with gamesfun web3 settings --rpc)'} · saved in gamesfun.json${dirty || saving ? ' · saving…' : ''}`),
      );
      drawFlowNow();
      if (focus) {
        const again = root.querySelector(`[data-path="${CSS.escape(focus.path)}"]`);
        if (again) {
          again.focus({ preventScroll: true });
          try {
            if (focus.start != null) again.setSelectionRange(focus.start, focus.end);
          } catch {}
        }
      }
    }

    const resize = new ResizeObserver(() => {
      if (flowBox && Math.abs((flowBox.clientWidth || 0) - lastWidth) > 16) drawFlowNow();
    });
    resize.observe(root);
    refresh();
    const typing = () => root.contains(document.activeElement) && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
    const stop = keepFresh(ctx, el, t, { busy: () => Boolean(flow) || dirty || saving || typing(), refresh, render });
    return () => {
      stop();
      resize.disconnect();
      window.removeEventListener('hashchange', onHash);
      clearTimeout(timer);
      el.replaceChildren();
    };
  },
};
