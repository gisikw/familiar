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

From the repo root:

```bash
./familiar.sh client
```

That's it. This enters the `client` Nix devShell (which pins the Node version —
see `devShells.client` in `flake.nix`, the single source of truth), runs
`npm install` only when it's stale (node_modules missing or `package-lock.json`
newer), then `npm start`. A window opens with your `$SHELL` (login shell)
running. `git pull && ./familiar.sh client` to update.

**No Xcode / Python toolchain needed** — `node-pty` 1.1.0 ships prebuilt N-API
binaries (N-API is ABI-stable across Node and Electron, so nothing is compiled
and no `electron-rebuild` step is required).

If you'd rather run it by hand (any recent Node 18+ works):

```bash
cd client
npm install     # fetches deps, vendors restty, fixes node-pty spawn-helper perms
npm start
```

> First launch notes for macOS:
> - The titlebar is **hiddenInset** (traffic-light buttons float over a light
>   frame; the terminal itself is dark). Content is padded clear of the buttons.
> - restty prefers **WebGPU** and falls back to **WebGL2** automatically. On
>   Apple Silicon you'll get WebGPU/Metal — the renderer feel Kevin liked in the
>   demo.
> - No packaging/signing is set up — this runs from source only.

### If the terminal doesn't start (`posix_spawnp failed`)

node-pty's macOS `spawn-helper` binary ships in the npm tarball **without its
executable bit** (mode 0644); posix_spawnp then fails. `npm install` fixes this
automatically (postinstall) and the app re-fixes it at startup. If you still hit
it (a copy dropped the bit, or Gatekeeper quarantined it):

```bash
npm run fix-pty        # chmod +x every node-pty spawn-helper, strip quarantine
# or manually:
chmod +x node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper
xattr -d com.apple.quarantine node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper 2>/dev/null || true
```

If the shell still fails, the window shows a **readable diagnostic** in place of
the black screen (resolved shell + whether it exists, cwd, spawn-helper paths
with their stat mode, and electron/node/ABI versions) — screenshot that and
report it. For raw data you can also run:

```bash
ls -la node_modules/node-pty/build/Release/ 2>/dev/null; \
ls -la node_modules/node-pty/prebuilds/darwin-arm64/; \
file node_modules/node-pty/prebuilds/darwin-arm64/*.node \
     node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper
```

## What it does

- **Terminal:** `node-pty` spawns `$SHELL -l` with `TERM=xterm-256color`,
  `COLORTERM=truecolor`. The child env is **sanitized**: `NIX_*` vars are
  dropped and any `/nix/store/*` entries are pruned from `PATH` (with the
  standard system dirs ensured) so a shell installed via `nix-shell` doesn't
  inherit build-only paths that won't resolve. The shell and cwd are both
  validated to exist before spawn (falling back `$SHELL` → /bin/zsh → /bin/bash
  → /bin/sh, and homedir → $HOME → /tmp → /). Full keyboard passthrough,
  bracketed paste, mouse reporting, and scrollback are handled by libghostty-vt
  inside restty — the same VT core as Ghostty. Rows/cols resync on window resize.
- **Drag & drop:** dropping image(s)/file(s) onto the window is intercepted at
  the `window` capture phase; the default is prevented (**no path is pasted**),
  the bytes are written to `~/.familiar/drops/<name>` (with a short content-hash
  suffix on collisions and a `manifest.jsonl` log), and a toast confirms
  `captured <name>`. No upload, no injection — that's the whole v0 scope.

## Layout

```
client/
  package.json            electron app; main = src/main/main.js
  scripts/
    postinstall.js        vendor restty + fix spawn-helper perms
    vendor-restty.js      copy restty's self-contained ESM bundle into renderer
    ensure-spawn-helper.js chmod +x node-pty spawn-helper (also `npm run fix-pty`)
  src/
    main/                 main process (Node)
      main.js             window, IPC wiring, drop + font handlers, fatal report
      pty.js              node-pty spawn/resize/kill; shell/cwd/env hardening
      drops.js            ~/.familiar/drops persistence
    preload/preload.js    contextIsolation bridge (window.familiar.*)
    renderer/             renderer (no Node)
      index.html          CSP allows wasm-unsafe-eval; light frame
      style.css           light-mode chrome + toast + drop hint + fatal panel
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
