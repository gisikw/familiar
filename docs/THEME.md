# Familiar unified theme

One `[theme]` section in `familiar.toml` drives every configurable color across
the four surfaces. Familiar's generic loader flattens nested TOML keys into
`FAMILIAR_THEME_*` env vars; the unified theme consumers use that contract.
Mapping, precedence, and restart operations are documented in `docs/CONFIG.md`.

## Single source of truth

`server/src/theme/defaults.json` holds the canonical
`familiar-monokai-pro-spectrum` palette: semantic **roles** + a 16-entry
**ANSI** palette. The primary reference is Kevin's locally installed Ghostty
`Monokai Pro Spectrum` theme; local `monokai-pro.nvim` Spectrum UI levels supply
only the extra surface depths Ghostty does not define. Two generators read that one
file and overlay `FAMILIAR_THEME_*`:

- `server/src/theme/resolve.ts` — runtime (Node): validates, builds the browser
  CSS (`/theme.css`) and the restty `GhosttyTheme` (`/theme.json`).
- `scripts/familiar-theme.sh` — boot (bash/jq): emits the herdr `[theme]` TOML
  fragment, the pi theme JSON, the sidebar accent, and `FAMILIAR_ANSI_0..15`.

No color literal is duplicated between consumers; the only static mirror is the
Electron **offline** page (shown when the server is unreachable, so it cannot
fetch `/theme.css`) — documented inline as hand-synced.

## Env contract (camelCase role → env key)

| Kind | Example role | Env var |
|------|--------------|---------|
| role | `background`   | `FAMILIAR_THEME_BACKGROUND` |
| role | `selectionBg`  | `FAMILIAR_THEME_SELECTION_BG` |
| ansi | `brightBlack`  | `FAMILIAR_THEME_ANSI_BRIGHT_BLACK` |
| name | (theme name)   | `FAMILIAR_THEME_NAME` |

Nested TOML `[theme.ansi].bright_black` already arrives as
`FAMILIAR_THEME_ANSI_BRIGHT_BLACK`, so bash and Node agree on a straight
camel→SNAKE mapping. Colors accept `#rgb`, `#rrggbb`, or `#rrggbbaa`; anything
else fails loudly (server exit 2, generator exit 3).

## Intersection matrix — theme roles × consumers

Legend: ✅ generated/driven · 🟡 partial/derived · ❌ no knob exists (honest gap).

| Role | Browser (restty/CSS) | herdr config | pi theme | Electron shell |
|------|----------------------|--------------|----------|----------------|
| background   | ✅ `--fm-background`, restty `colors.background` | ✅ `theme.custom.panel_bg` | ✅ `export.pageBg`, `toolPendingBg` | 🟡 offline `--bg` (static mirror) |
| surface      | ✅ `--fm-surface` (emoji picker) | ✅ `sidebar_bg` | ✅ `userMessageBg`, `export.cardBg` | 🟡 offline `--panel` |
| surfaceDim   | ✅ `--fm-surface-dim` | ✅ `surface_dim` | 🟡 via bg | ❌ |
| overlay      | ✅ `--fm-overlay` | ✅ `surface0` | ✅ `customMessageBg`, `scrollbarThumb` | 🟡 offline `--border` |
| text         | ✅ `--frame-fg`, restty `foreground` | ✅ `text` | ✅ `text` | 🟡 offline `--fg` |
| muted        | ✅ `--fm-muted` | ✅ `subtext0` | ✅ `muted`, `toolOutput` | 🟡 offline `--muted` |
| accent       | ✅ `--accent`, cursor, drop-hint | ✅ `accent`, `teal` | ✅ `accent`, `borderAccent` | 🟡 offline `--accent` + sidebar mark PNG |
| success      | 🟡 via ansi green | ✅ `green` | ✅ `success`, `toolDiffAdded` | ❌ |
| warning      | 🟡 via ansi yellow | ✅ `yellow`, `peach` | ✅ `warning`, `mdHeading` | ❌ |
| error        | 🟡 via ansi red | ✅ `red` | ✅ `error`, `toolDiffRemoved` | ❌ |
| border       | ✅ `--fm-border` | 🟡 `surface0/1` | ✅ `border` (=blue) | 🟡 offline `--border` |
| borderMuted  | ✅ `--fm-border-muted` | ✅ `surface1` | ✅ `borderMuted` | ❌ |
| selectionBg  | ✅ `--fm-selection-bg`, restty `selectionBackground` | ✅ `selection_bg`, `active_row_bg` | ✅ `selectedBg` | ❌ |
| cursor       | ✅ restty `colors.cursor` | ❌ *(no herdr cursor knob)* | 🟡 pi cursor = accent | ❌ |
| cursorText   | ✅ restty `colors.cursorText` | ❌ | ❌ | ❌ |
| ANSI 0–15    | ✅ restty `palette[0..15]` + `--fm-ansi-*` | ❌ *(no herdr ANSI-16 config; env handoff `FAMILIAR_ANSI_*` only)* | 🟡 8 hues mapped to vars | ❌ |

### Honest gaps (no invented knobs)
- **herdr has no per-pane ANSI-16 palette key** in 0.8.x. `theme.custom` covers UI
  chrome only. New panes inherit ANSI via `FAMILIAR_ANSI_0..15` env (a pane rc can
  emit OSC 4); this is env handoff, not a native setting.
- **herdr has no cursor color knob** — cursor is driven only where restty/pi own it.
- **Electron offline page** can't be runtime-themed (server is down by definition);
  its `<style>` is a hand-synced mirror of the defaults.
- **`theme.name = "catppuccin"`** stays herdr's base so its built-in dark tokens
  fill any custom token we don't override; our accent/surfaces sit on top.

## Cold-restart behavior

`familiar.sh` regenerates the herdr fragment (`write_herdr_config`) and pi theme
(`run_pi`) on every boot; the server rebuilds `/theme.css` + `/theme.json` at
startup from env. Changing `[theme]` in `familiar.toml` and cold-restarting
re-themes all surfaces with **no asset rebuild**. pi additionally hot-reloads the
active custom theme file on edit.

## `[theme]` example for familiar.toml

```toml
# Familiar unified theme. Omit any key to keep the Spectrum default.
# Colors: #rgb, #rrggbb, or #rrggbbaa. Invalid values fail the boot loudly.
[theme]
name = "familiar-monokai-pro-spectrum"

# Semantic roles.
background  = "#222222"
surface     = "#191919"
surface_dim = "#131313"
overlay     = "#363537"
text        = "#f7f1ff"
muted       = "#bab6c0"
accent      = "#5ad4e6"   # cyan keeps the Familiar mark distinct and legible
success     = "#7bd88f"
warning     = "#fce566"
error       = "#fc618d"
border       = "#363537"
border_muted = "#525053"
selection_bg = "#525053"
cursor       = "#bab6c0"
cursor_text  = "#222222"  # readable adaptation; Ghostty source uses pale text

# Terminal ANSI 16-color palette (drives restty panes + FAMILIAR_ANSI_* handoff).
[theme.ansi]
black   = "#222222"
red     = "#fc618d"
green   = "#7bd88f"
yellow  = "#fce566"
blue    = "#fd9353"
magenta = "#948ae3"
cyan    = "#5ad4e6"
white   = "#f7f1ff"
bright_black   = "#69676c"
bright_red     = "#fc618d"
bright_green   = "#7bd88f"
bright_yellow  = "#fce566"
bright_blue    = "#fd9353"
bright_magenta = "#948ae3"
bright_cyan    = "#5ad4e6"
bright_white   = "#f7f1ff"
```

## Tests

- `server/src/theme/resolve.test.ts` — resolver, CSS snapshot, restty theme,
  ANSI order, env overrides, `#rgb` expansion, validation, default parity.
  `node --experimental-transform-types --test src/theme/resolve.test.ts`
- `test/familiar-theme.test.sh` — herdr fragment, pi JSON (all 51 tokens),
  ANSI env, parity, overrides, failure exit codes. `bash test/familiar-theme.test.sh`
- Live: pi JSON validates against the installed pi `theme-schema.json`; the herdr
  fragment passes `herdr config check`; `/theme.css` + `/theme.json` verified live.
