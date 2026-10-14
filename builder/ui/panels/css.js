// gf-three panels: the one stylesheet (colours are the game's own --gf-panel, --gf-accent, --gf-text: ui.* slots).
// Phone width first: nothing here is narrower than a 44 px tap, every card scrolls inside the screen, and the
// notch and the home bar are kept clear (env safe-area insets).
export const CSS = `
.gfp{position:absolute;inset:0;display:flex;pointer-events:none;z-index:7;color:var(--gf-text,#fff);font:600 14px/1.3 system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-tap-highlight-color:transparent}
.gfp button{font:inherit;color:inherit;cursor:pointer;touch-action:manipulation}
.gfp.modal{pointer-events:auto;align-items:center;justify-content:center;background:#0008;padding:max(12px,env(safe-area-inset-top)) max(12px,env(safe-area-inset-right)) max(12px,env(safe-area-inset-bottom)) max(12px,env(safe-area-inset-left))}
.gfp.modal.clear{background:transparent;pointer-events:none}
.gfp.bottom{align-items:flex-end;justify-content:center;padding-bottom:86px}
.gfp.dock{align-items:flex-end;justify-content:center;padding:0 max(10px,env(safe-area-inset-right)) max(10px,env(safe-area-inset-bottom)) max(10px,env(safe-area-inset-left))}
.gfp.mounted{position:static;inset:auto;display:block;z-index:auto;min-width:0}
.gfp-card{pointer-events:auto;position:relative;-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);box-sizing:border-box;background:var(--gf-panel,#1c2133f2);border-radius:18px;padding:16px 18px;box-shadow:0 12px 40px #0006;width:min(560px,100%);max-height:100%;overflow:auto;overscroll-behavior:contain;display:flex;flex-direction:column;gap:10px}
.gfp-card.bare{-webkit-backdrop-filter:none;backdrop-filter:none;background:transparent;box-shadow:none;padding:0;width:auto;overflow:visible;align-items:center;gap:8px}
.gfp-head{display:flex;align-items:center;justify-content:space-between;gap:10px}
.gfp-title{margin:0;font-size:18px;font-weight:800}
.gfp-card.bare .gfp-title{font-size:16px;text-shadow:0 2px 0 #0008;letter-spacing:.02em}
.gfp-x{flex:none;width:44px;height:44px;margin:-8px -10px -8px 0;border:0;border-radius:50%;background:transparent;font-size:20px;opacity:.8}
.gfp-chip{flex:none;padding:3px 10px;border-radius:999px;background:#ffffff1f;font-size:13px;font-variant-numeric:tabular-nums}
.gfp-btn{min-height:44px;padding:8px 20px;border:0;border-radius:999px;background:var(--gf-accent,#ff7a59);color:#fff;font-size:16px;font-weight:700}
.gfp-btn.ghost{background:#ffffff26}
.gfp-btn:disabled{opacity:.4;cursor:default}
.gfp-foot{display:flex;justify-content:flex-end;gap:8px;align-items:center;flex-wrap:wrap}
.gfp img.gfp-img{display:block;object-fit:contain;border-radius:8px}
.gfp-empty{opacity:.7;text-align:center;padding:14px 0}
#gf-ui.gf-yield .gfp:not(.modal):not(.mounted){visibility:hidden}
/* choice */
.gfp-options{display:flex;gap:10px;flex-wrap:wrap;justify-content:center}
.gfp-option{pointer-events:auto;cursor:pointer;box-sizing:border-box;min-height:92px;padding:10px 12px;border-radius:14px;border:2px solid #ffffff40;background:var(--gf-panel,#1c2133e6);color:#fff;text-align:left;box-shadow:0 6px 18px #0006;display:flex;flex-direction:column;gap:4px;transition:transform .12s,border-color .12s;font-size:13px}
.gfp-option:hover{transform:translateY(-3px);border-color:var(--gf-accent,#ffd23f)}
.gfp-option b{font-size:11px;opacity:.7}
.gfp-option strong{font-size:15px;font-weight:800}
.gfp-option.picked{border-color:var(--gf-accent,#ffd23f);background:#2d3550}
.gfp-option .gfp-img{width:40px;height:40px}
.gfp-option .gfp-tag{align-self:flex-start;font-size:10px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;padding:1px 7px;border-radius:999px;background:#ffffff26}
.gfp.bottom .gfp-option{width:164px}
.gfp.center .gfp-option{flex:1 1 150px;max-width:230px}
/* shop and inventory rows */
.gfp-rows{display:flex;flex-direction:column;gap:8px}
.gfp-row{display:grid;grid-template-columns:auto 1fr auto;gap:10px;align-items:center;padding:8px;border-radius:12px;background:#ffffff14}
.gfp-row.noimg{grid-template-columns:1fr auto}
.gfp-row .gfp-img{width:48px;height:48px}
.gfp-row .gfp-name{font-weight:800;font-size:15px}
.gfp-row .gfp-sub{font-size:12px;opacity:.75;font-weight:500}
.gfp-row .gfp-why{font-size:12px;color:#ffb4a8;font-weight:600}
.gfp-row .gfp-btn{padding:8px 14px;font-size:14px;white-space:nowrap}
/* inventory: bar and grid */
.gfp-wrap{position:relative;min-width:0;pointer-events:none}
.gfp-bar{display:flex;gap:5px;padding:6px;border-radius:14px;background:var(--gf-panel,#1c2133cc);box-shadow:0 6px 20px #0004;pointer-events:auto;overflow-x:auto;scrollbar-width:none}
.gfp-bar::-webkit-scrollbar{display:none}
.gfp-more{position:absolute;top:0;bottom:0;width:26px;display:none;align-items:center;justify-content:center;border:0;padding:0;font-weight:700;font-size:18px;line-height:1;pointer-events:auto;z-index:1}
.gfp-more.l{left:0;border-radius:14px 0 0 14px;background:linear-gradient(to right,var(--gf-panel,#1c2133) 40%,transparent)}
.gfp-more.r{right:0;border-radius:0 14px 14px 0;background:linear-gradient(to left,var(--gf-panel,#1c2133) 40%,transparent)}
.gfp-wrap.more-l .gfp-more.l,.gfp-wrap.more-r .gfp-more.r{display:flex}
.gfp-slot{position:relative;flex:none;width:46px;height:46px;border-radius:10px;border:2px solid #ffffff22;background:#ffffff14;padding:0;display:grid;place-items:center;transition:transform .12s,border-color .12s}
.gfp-slot canvas,.gfp-slot .gfp-img{width:38px;height:38px}
.gfp-slot>span{font-size:12px;font-weight:800}
.gfp-slot b{position:absolute;left:4px;top:1px;font-size:10px;opacity:.75}
.gfp-slot em{position:absolute;right:3px;bottom:1px;font-style:normal;font-size:11px;font-weight:800;text-shadow:0 1px 2px #000}
.gfp-slot.on{border-color:var(--gf-accent,#ff7a59);transform:translateY(-4px);background:#ffffff26}
.gfp-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(64px,1fr));gap:8px}
.gfp-grid .gfp-slot{width:auto;height:auto;aspect-ratio:1;min-height:56px}
.gfp-grid .gfp-slot.on{transform:none}
.gfp-grid .gfp-empty{grid-column:1/-1}
.gfp-detail{min-height:44px;padding:8px 10px;border-radius:12px;background:#ffffff14}
.gfp-detail .gfp-name{font-weight:800;font-size:15px}
.gfp-detail .gfp-sub{font-size:12px;opacity:.8;font-weight:500}
/* dialogue */
.gfp-say{display:grid;grid-template-columns:auto 1fr;gap:12px;align-items:start;cursor:pointer;width:min(720px,100%)}
.gfp-say.noimg{grid-template-columns:1fr}
.gfp-say .gfp-img{width:84px;height:84px;border-radius:12px;background:#ffffff14}
.gfp-who{display:inline-block;padding:2px 10px;border-radius:999px;background:var(--gf-accent,#ff7a59);color:#fff;font-size:13px;font-weight:800;margin-bottom:4px}
.gfp-line{font-size:17px;font-weight:600;min-height:3.9em;white-space:pre-wrap}
.gfp-next{opacity:.7;font-size:12px}
.gfp-choices{display:flex;flex-direction:column;gap:8px;margin-top:6px}
.gfp-choices .gfp-btn{text-align:left;border-radius:14px;background:#ffffff26}
/* input */
.gfp-field{width:100%;box-sizing:border-box;font:600 18px/1.3 system-ui,sans-serif;border-radius:10px;border:0;padding:10px;background:#f4e6c8;color:#2b1d12;resize:none}
.gfp-count{font-size:12px;opacity:.75;margin-right:auto;font-weight:500}
@media (max-width:640px){
  .gfp.bottom{padding-bottom:120px}
  .gfp.bottom .gfp-option{width:104px;min-height:80px;font-size:12px;padding:8px}
  .gfp.center .gfp-option{flex:1 1 100%;max-width:none;min-height:64px}
  .gfp-card{padding:14px;border-radius:16px}
  .gfp-slot{width:38px;height:38px}
  .gfp-slot canvas,.gfp-slot .gfp-img{width:30px;height:30px}
  .gfp-bar{padding:4px;gap:4px}
  .gfp-say{gap:8px}.gfp-say .gfp-img{width:56px;height:56px}
  .gfp-line{font-size:16px}
}
@media (max-height:480px){.gfp.modal{align-items:flex-start}.gfp-card{padding:10px 14px;gap:6px}.gfp-line{min-height:2.6em}}
`;
