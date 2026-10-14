// The look judge's sheet layout: a header (the kind, its feel, its reference games), six tiles two across (the world,
// a body up close, the body set, the props, the HUD over the world, and a card of the preset's other answers).
// kind-sheet.mjs calls window.compose({ kind, tiles, record }) and screenshots the whole page.
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const ORDER = ['world', 'hero', 'bodies', 'props', 'hud'];

function card(kind, record) {
  const rt = kind.sheet.runtime, look = kind.look[rt] ?? Object.values(kind.look)[0] ?? {};
  const pal = look.values?.palette?.players ?? look.values?.post?.lofi?.palette?.slice(0, 12) ?? null;
  const hudSw = kind.hud?.theme ? [] : [kind.hud?.accent, kind.hud?.panel?.slice(0, 7), kind.hud?.text].filter(Boolean);
  const word = s => (s?.tested ? 'tested' : s?.exists ? 'exists' : 'to prove') + (s?.open ? ', open' : '');
  const runtimes = Object.entries(kind.runtimes ?? {}).map(([k, v]) => `<span class="tag">${esc(k)}${v.profile ? ' ' + esc(v.profile) : ''}: <span class="state ${v.state?.tested ? 'proven' : v.state?.exists ? 'exists' : 'to-prove'}">${esc(word(v.state))}</span></span>`).join('');
  const sounds = Object.entries(kind.audio?.sounds ?? {}).slice(0, 6).map(([k, v]) => `${esc(k)}: ${esc(v.preset)}${v.pitch && v.pitch !== 1 ? ` ×${v.pitch}` : ''}`).join(' · ');
  const bodies = kind.bodies?.[rt];
  return `<div class="card">
    <div><h3>Look on ${esc(rt)}${look.profile ? ' ' + esc(look.profile) : ''}</h3><p><b>${esc(look.preset ?? '')}</b>${look.time ? ` · ${esc(look.time)}` : ''}${look.style ? ` · ${esc(look.style)}` : ''}${look.values?.post?.lofi ? ' · lofi pass' : ''}</p>
      ${look.alternates?.length ? `<p style="color:var(--dim);font-size:13px">also ${look.alternates.map(a => esc(a.preset + (a.time ? ' ' + a.time : ''))).join(', ')}</p>` : ''}</div>
    <div><h3>Camera</h3><p>${esc(kind.camera?.default)}</p></div>
    <div><h3>World family</h3><p>${esc(kind.world?.family)}</p></div>
    <div><h3>Body set</h3><p>${esc(kind.bodies?.set)}${Array.isArray(bodies) ? ` (${bodies.length})` : ''}${kind.bodies?.physics ? ` · ${esc(kind.bodies.physics)}` : ''}</p></div>
    ${pal ? `<div class="wide"><h3>Palette</h3><span class="sw">${pal.map(c => `<i style="background:${esc(c)}" title="${esc(c)}"></i>`).join('')}</span></div>` : ''}
    <div class="wide"><h3>Audio character (gf-audio)</h3><p>${esc(kind.audio?.character)}</p><p style="color:var(--dim);font-size:13px;margin-top:3px">${sounds}${kind.audio?.ambient ? ` · ambient: ${esc(kind.audio.ambient.preset)}` : ''}</p></div>
    <div><h3>HUD</h3><p>${kind.hud?.theme ? `theme <b>${esc(kind.hud.theme)}</b>` : `${esc(kind.hud?.font ?? 'system')} · corners ${esc(kind.hud?.radius ?? '-')}`} <span class="sw" style="vertical-align:middle">${hudSw.map(c => `<i style="background:${esc(c)};width:18px;height:18px"></i>`).join('')}</span></p></div>
    <div><h3>Mechanics it suggests</h3><p>${(kind.mechanics?.suggested ?? []).map(m => `<span class="tag">${esc(m)}</span>`).join('')}</p></div>
    <div class="wide"><h3>Packs</h3><p>${(kind.packs ?? []).map(p => `<span class="tag">${esc(p)}</span>`).join('')}</p></div>
    <div class="wide"><h3>Runtimes</h3><p>${runtimes}</p></div>
  </div>`;
}

window.compose = async ({ kind, tiles, record }) => {
  const tw = record.size?.[0] ?? 1280, th = record.size?.[1] ?? 720;
  document.documentElement.style.setProperty('--tw', `${tw}px`); document.documentElement.style.setProperty('--th', `${th}px`);
  const px = kind.look?.three?.style === 'pixel' || !!kind.look?.three?.values?.post?.lofi;
  const list = ORDER.map(n => tiles.find(t => t.name === n)).filter(Boolean).concat(tiles.filter(t => !ORDER.includes(t.name)));
  const figs = list.map(t => `<figure><img class="${px ? 'px' : ''}" src="${esc(t.src)}" alt="${esc(t.label)}"><figcaption><b>${esc(t.label)}</b><span>${esc(t.note ?? '')}</span></figcaption></figure>`).join('');
  document.getElementById('m').innerHTML = `
    <header>
      <h1>${esc(record.game ? record.game.title : kind.label)}<small>${record.game ? `game · kind ${esc(kind.id)} · ${esc(record.game.drawn)}` : `kind · ${esc(kind.id)}`}</small></h1>
      <div class="meta">${esc([kind.sheet.runtime, kind.sheet.profile].filter(Boolean).join(' '))} · ${esc((record.made ?? '').slice(0, 10))}<br>${esc(record.chrome ? 'Chrome ' + record.chrome : '')}</div>
      <p class="feel">${esc(kind.feel)}</p>
      <div class="refs"><b>Should evoke:</b> ${kind.references.map(esc).join(' · ')}</div>
    </header>
    <section class="grid">${figs}${card(kind, record)}</section>`;
  await Promise.all([...document.images].map(i => i.decode().catch(() => {})));
  window.__composed = true;
};
