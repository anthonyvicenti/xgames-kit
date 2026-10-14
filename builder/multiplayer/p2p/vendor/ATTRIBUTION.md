# Vendored code (signaling server only, Node side)

- `ws/`: **ws 8.21.3** by Einar Otto Stangvik, Arnout Kazemier, Luigi Pinca and contributors,
  https://github.com/websockets/ws at commit `c791e707eab3c13dd9a261d2479c3cc4a49a6fed` (tag `8.21.3`).
  License: MIT, see `ws/LICENSE`. Copied unmodified from `research/foundations/trials/draw-guess/net/vendor/ws/`
  (which copied the published npm package), so the repo keeps one pinned version of `ws`.
  Used only by `../signal-server.mjs`. Nothing from it ships to the browser.
