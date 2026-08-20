# Familiar (client v0)

The simplest possible daily-driver terminal app: a single, near-chromeless
window wrapping a **real Ghostty-grade terminal** via
[**restty**](https://github.com/wiedymi/restty) (libghostty-vt compiled to WASM,
rendered to the DOM with WebGPU and a WebGL2 fallback), backed by a login shell
through `node-pty`.

It also **captures files dropped onto the window** — instead of pasting the
local file path into the terminal (the usual annoyance), it swallows the drop,
saves a copy into `~/.familiar/drops/`, and shows a brief toast.

## Run it (macOS)

Requirements: a recent Node LTS (18+), Xcode Command Line Tools (for building
the `node-pty` native module — `xcode-select --install` if you haven't).

```bash
cd client
npm install     # builds node-pty, downloads Electron, vendors the restty bundle
npm start
```

That's it. A window opens with your `$SHELL` (login shell) running. `git pull &&
npm install && npm start` to update.

> First launch notes for macOS:
> - The titlebar is **hiddenInset** (traffic-light buttons float over a light
>   frame; the terminal itself is dark). Content is padded clear of the buttons.
> - restty prefers **WebGPU** and falls back to **WebGL2** automatically. On
>   Apple Silicon you'll get WebGPU/Metal — the renderer feel Kevin liked in the
>   demo.
> - `npm install` compiles `node-pty` against Electron's ABI via
>   `@electron/rebuild` (runs automatically). If you ever hot-swap the Electron
>   version, re-run `npx electron-rebuild -f -w node-pty`.
> - No packaging/signing is set up — this runs from source only.

## What it does

- **Terminal:** `node-pty` spawns `$SHELL -l` with `TERM=xterm-256color`,
  `COLORTERM=truecolor`. Full keyboard passthrough, bracketed paste, mouse
  reporting, and scrollback are handled by libghostty-vt inside restty — the
  same VT core as Ghostty. Rows/cols resync to the pty on window resize.
- **Drag & drop:** dropping image(s)/file(s) onto the window is intercepted at
  the `window` capture phase; the default is prevented (**no path is pasted**),
  the bytes are written to `~/.familiar/drops/<name>` (with a short content-hash
  suffix on collisions and a `manifest.jsonl` log), and a toast confirms
  `captured <name>`. No upload, no injection — that's the whole v0 scope.

## Layout

```
client/
  package.json            electron app; main = src/main/main.js
  scripts/vendor-restty.js postinstall: copies restty's self-contained ESM
                          bundle into src/renderer/vendor/
  src/
    main/                 main process (Node)
      main.js             window, IPC wiring, drop + font handlers
      pty.js              node-pty spawn/resize/kill
      drops.js            ~/.familiar/drops persistence
    preload/preload.js    contextIsolation bridge (window.familiar.*)
    renderer/             renderer (no Node)
      index.html          CSP allows wasm-unsafe-eval; light frame
      style.css           light-mode chrome + toast + drop hint
      renderer.js         boots restty, custom IPC PtyTransport, drop capture
      fonts/              bundled JetBrains Mono (loaded as buffers; offline)
      vendor/             restty.esm.js (git-ignored; created on install)
    selftest/selftest.js  headless verification harness (electron . --selftest)
```

## How restty is consumed

restty is a **published npm package** (`restty`, MIT). It ships a fully
self-contained standalone browser ESM bundle (`dist/restty.esm.js`, ~4 MB) with
the **WASM embedded as base64** and `text-shaper` bundled in — no separate WASM
asset to serve, no bundler required. `scripts/vendor-restty.js` copies that one
file into `src/renderer/vendor/` on `postinstall`, and the renderer imports it
directly as an ES module. No Vite/esbuild needed.

restty normally talks to a WebSocket PTY server; it also exposes a
`ptyTransport` interface. We implement that interface over Electron IPC
(`preload -> main -> node-pty`) so there's no WebSocket server in the loop.

### Caveats
- restty is **early-release** ("some APIs may still change"). Pinned to
  `^0.2.6`.
- Its default font fallback chain fetches Nerd/Noto fonts from a CDN. That
  violates our CSP and won't work offline, so we **bundle JetBrains Mono** and
  hand restty the font bytes as in-memory buffers (via `window.familiar.readFont`
  over IPC — `fetch()` of `file://` fonts is also CSP-blocked). Emoji/CJK/Nerd
  glyphs beyond the bundled face won't render until more faces are bundled.
- CSP needs `script-src 'self' 'wasm-unsafe-eval'` for WASM instantiation.

## Verify (headless)

`electron . --selftest` runs a harness that boots the pty, checks `echo`,
resizes, exercises the drop persistence, loads the real renderer, and writes a
screenshot to `$TMPDIR/familiar-selftest/render.png`. Exit 0 = pass.
