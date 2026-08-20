# Font / glyph rendering: emoji + Nerd Font fallback

## Symptom
On Kevin's Mac some glyphs did not render — notably emoji like 🪶 (U+1FAB6
FEATHER). Nerd Font symbols (prompt/statusline icons) rendered fine.

## Render path (diagnosed)
restty (libghostty-vt WASM) renders text through a **canvas / WebGL(GPU) glyph
atlas**, NOT the DOM. There is therefore **no CSS `font-family` chain** doing
per-glyph fallback. Instead restty does its own per-glyph fallback by walking
the `terminal.fonts` array we pass it:

- For each shaped cluster it calls `pickFontIndexForText`
  (`src/runtime/create-runtime/font-runtime/text.ts`).
- Emoji codepoints (U+1F300–U+1FAFF etc. — 0x1FAB6 is in range) are classified
  `presentation === "emoji"` (`codepoint-utils.ts`), then it looks for the first
  entry classified as a **color emoji font** via `isColorEmojiFont`
  (`src/fonts/manager/classification.ts`), whose label matches
  `/apple color emoji|noto color emoji|openmoji|segoe ui emoji|twemoji/`.
- Color emoji are rasterized by `color-glyph-atlas.ts` through a **canvas 2D CSS
  stack**: `"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",...`. For an
  OpenMoji-labelled entry it strips the OpenMoji family and uses ONLY that
  platform stack — so the actual pixels come from the OS color emoji font.

## Root cause
Commit 2dafd3a made the renderer pass its OWN `terminal.fonts` = **only 4
buffers** (ProggyClean + 3 JetBrains faces). Passing `terminal.fonts`
**replaces** restty's built-in `DEFAULT_FONT_INPUTS` chain
(`src/runtime/fonts/font-sources.ts`), which had included Nerd symbols, Apple/
Noto symbols, **Apple Color Emoji / Noto Color Emoji / OpenMoji**, and CJK.
With no color-emoji entry in the array, emoji fell back to index 0 (ProggyClean),
which has no emoji glyphs → blank/tofu. The flake.nix `nerd-fonts.proggy-clean-tt`
addition is irrelevant: it only populates the dev nix store, not the packaged
app, and macOS doesn't run under the devshell fontconfig anyway.

## Nerd Font symbols were fine — and stay bundled
The bundled `ProggyCleanNerdFontMono-Regular.ttf` is the **full** Nerd patch:
29,721 cmap entries incl. powerline (E0Bx), Material Design (F00xx), Font Awesome
(F0xx), Seti/custom (E5FA–E6B7), weather, octicons, pomicons. So Task 3 needs no
font swap — coverage does NOT differ from the full nix package for our purposes.

## Fix
Bundle `OpenMoji-black-glyf.ttf` (~1.5 MB black/monochrome glyf font, from
hfg-gmuend/openmoji) as an **emoji cmap provider** and add it as the last entry
in the renderer's `fonts` array with `name: "OpenMoji"` (the name is what makes
restty classify it as color emoji). Emoji then route to restty's canvas color
path and are drawn by the platform color emoji font:
- macOS  → Apple Color Emoji
- Linux  → Noto Color Emoji (if installed)

We deliberately do NOT bundle a huge color-emoji file; the platform font renders.

Files changed:
- `src/renderer/renderer.js` — load OpenMoji, add `{ data, name: "OpenMoji" }`.
- `src/renderer/fonts/OpenMoji-black-glyf.ttf` — new bundled cmap font.
- `src/selftest/selftest.js` — assert the new asset exists.

## What Kevin must verify on the Mac
1. `printf '\U0001FAB6\n'` (🪶 FEATHER) renders as a color emoji, not tofu.
2. A few more: 🚀 (U+1F680), 😀 (U+1F600), ✨ (U+2728).
3. Nerd Font prompt/statusline icons still render (regression check).
4. If an emoji shows as a monochrome OpenMoji outline instead of color, the OS
   color emoji font isn't being picked by the canvas stack — but on macOS
   "Apple Color Emoji" is always present, so this should not happen.

## Headless verification done here
- `node --check` passes on renderer.js, preload.js, selftest.js.
- Confirmed OpenMoji cmap contains U+1FAB6 / U+1F600 / U+1F680 / U+2728 (fontTools).
- Confirmed bundled ProggyClean carries full Nerd symbol ranges (fontTools).
- Full selftest and actual glyph rendering need a display + `npm install`
  (restty bundle is vendored by postinstall; node_modules absent in this
  sandbox) — NOT run here.
