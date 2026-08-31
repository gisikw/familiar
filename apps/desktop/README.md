# Familiar (client)

A **dumb client**: a thin, near-chromeless Electron window that **loads the
terminal page served by the familiar server** (default
`http://localhost:1692`). The served page owns *everything* that makes
the terminal work — the [restty](https://github.com/wiedymi/restty)
(libghostty-vt → WASM) renderer, the `/pty` WebSocket bridge, mouse/emoji
handling, its own fonts, and drag-and-drop file **upload**. This app contributes
only native chrome.

Previously the client spawned a **local** shell via `node-pty` and rendered
restty itself. That's gone: there is no local pty, no vendored restty, no
bundled fonts, no drops-to-disk. The server got good enough that the browser
terminal feels equivalent, so the Electron app collapsed to a shell around it.

## What Electron still does

- **Window chrome:** one frameless/edgeless window. A slim
  `-webkit-app-region: drag` strip (provided by the served page and by our
  offline page) keeps it movable. macOS traffic lights float over a hidden
  titlebar; `Cmd-Q` / `Cmd-W`, copy/paste, and zoom live in a minimal menu.
- **Zoom chords:** `Cmd/Ctrl` `+` / `-` / `0` map to `webContents` zoom
  (`setZoomLevel`). They're intercepted in the main process *before* reaching
  the page, so a remote TUI can't eat them.
- **Persistent auth session:** the window uses a persistent session partition
  (`persist:familiar`), so authentication cookies are stored on disk and
  survive restarts. See **Auth** below.
- **Persistent window bounds:** position/size are saved to `config.json` and
  restored on next launch.
- **Offline courtesy:** if the server can't be reached (offline, down, TLS/DNS
  error) the window swaps in a local `offline.html` with a **Retry** button; the
  main process also auto-retries with exponential backoff (1s → 30s). A
  successful load resets the backoff.

## Run it

From the repo root:

```bash
./familiar.sh client
```

This enters the `client` Nix devShell (pins Node — see `devShells.client` in
`flake.nix`), runs `npm install` when stale, then `npm start`. A window opens and
loads the configured server. `git pull && ./familiar.sh client` to update.

By hand (any recent Node 18+):

```bash
cd client
npm install     # just fetches electron
npm start
```

## Config

The **only** thing the client needs to know is the server's base URL; every
endpoint (the terminal page at `/`, the `/pty` WebSocket, `/upload`) is derived
from that origin by the served page — no paths are hard-coded here.

Resolution order (first hit wins):

1. `FAMILIAR_BASE_URL` environment variable (development/terminal launches)
2. `"baseUrl"` in `<userData>/config.json`
3. Default: `http://localhost:1692`

Packaged apps launched from Finder, Spotlight, or the Dock do not inherit a
terminal environment. Use **Familiar → Configure Server URL…** in the menu at
any time (including when the server is offline), then choose **Save and
connect**. This writes the URL to the persistent config file and reloads the
window, so no terminal is needed on first run.

`config.json` (in Electron's `userData` dir — e.g. `~/Library/Application
Support/familiar-client/config.json` on macOS) also stores window `bounds`.
Example:

```json
{
  "baseUrl": "http://localhost:1692",
  "bounds": { "x": 100, "y": 100, "width": 1024, "height": 680 }
}
```

Point it at a local server for development:

```bash
FAMILIAR_BASE_URL=http://localhost:1692 npm start
```

## Installing the unsigned DMG

Releases contain an unsigned macOS DMG. Drag **Familiar** to `/Applications`.
The first time macOS blocks an app downloaded from GitHub, open **System
Settings → Privacy & Security**, find the message that Familiar was blocked,
and click **Open Anyway** (confirm **Open**). This one-time Gatekeeper approval
removes the quarantine block for this app; signing and notarization are
intentionally deferred.

## Auth

The gateway has no built-in authentication. A remote deployment should put it
behind an authenticating reverse proxy; see the gateway README.

Because the window is a **real browser context**, browser-based auth "just
works": when the server returns a login redirect, the window follows it, the
user completes login inline, and the resulting cookie is written to the
**persistent partition** on disk. Subsequent launches reuse that cookie until
it expires. The `/pty` WebSocket and `/upload` POST both originate from the same
page/session, so they carry the cookie automatically — no cookie-copying and no
separate auth window.

### Limitations

- If the auth cookie **expires** while the app is open, the next navigation (or a
  `/pty` reconnect) may redirect to the login page; once login completes, you're
  back. A dropped WebSocket during an expired session surfaces via the served
  page's own reconnect UI.
- The persistent cookie lives under Electron's `userData`; deleting it (or using
  a different `userData`) forces a fresh login.
- `window.open`/`target=_blank` from the page is denied (single-window shell);
  auth redirects are top-level navigations, so this doesn't affect login.

## Layout

```
apps/desktop/
  package.json            electron app; main = src/main/main.js
  src/
    main/
      main.js             window, zoom chords, session partition, offline retry
      config.js           base-URL resolution + config.json (bounds) persistence
      offline.html        local retry page shown when the server is unreachable
    preload/preload.js    tiny bridge: offline page -> app:retry / app:baseUrl
    selftest/selftest.js  headless verification harness (electron . --selftest)
```

There is deliberately no `renderer/` tree anymore — the UI is the remote page.

## Verify (headless)

```bash
npm run selftest      # electron . --selftest
```

The harness checks:

1. **config** — `normalizeBaseUrl` cases and `resolveBaseUrl` precedence
   (env > `config.json` > default); window-bounds round-trip through the JSON.
2. **offline page** — loads `offline.html` in a window, confirms it renders the
   base URL and that the preload bridge's `retry()` reaches the `app:retry` IPC;
   writes `$TMPDIR/familiar-selftest/offline.png`.
3. **live smoke (opt-in)** — with `FAMILIAR_SELFTEST_LIVE=1` and a reachable
   `FAMILIAR_BASE_URL`, actually loads the server page in a partitioned window
   and screenshots it. Skipped by default (needs a display + a running server).

> The config checks run as pure Node and need no display. The window checks need
> Electron to open a window (a display or xvfb). On a headless CI box without a
> GPU/display, run the config assertions directly:
> `node -e "require('./src/main/config') ..."`.
