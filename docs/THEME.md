# Familiar unified theme

One `[theme]` section in `familiar.toml` drives configurable colors across the
browser terminal, pi, and Electron shell. The generic configuration loader
flattens nested TOML keys into `FAMILIAR_THEME_*` environment variables.

## Single source of truth

`services/gateway/src/theme/defaults.json` contains the canonical semantic
roles and ANSI palette. `services/gateway/src/theme/resolve.ts` generates the
browser CSS and restty theme, while `scripts/familiar-theme.sh` generates pi's
theme JSON and optional ANSI environment exports. The Electron offline page is
a hand-synced static mirror because it is displayed when the server cannot
serve runtime theme assets.

Examples: `selection_bg` becomes `FAMILIAR_THEME_SELECTION_BG`, and
`[theme.ansi].bright_black` becomes `FAMILIAR_THEME_ANSI_BRIGHT_BLACK`. Colors
accept `#rgb`, `#rrggbb`, or `#rrggbbaa`; invalid values fail startup.

## Consumers

| Role | Browser | pi | Electron offline shell |
|---|---|---|---|
| background/surfaces | CSS + restty | message/tool/export backgrounds | static mirror |
| text/muted/accent | CSS + restty | text, labels, borders | static mirror |
| success/warning/error | ANSI and CSS | semantic states and diffs | — |
| selection/cursor | restty + CSS | selected background; cursor derives from accent | — |
| ANSI 0–15 | restty palette | eight hues mapped to vars | — |

`familiar.sh pi` regenerates pi's theme on every restart. The server generates
`/theme.css` and `/theme.json` from the same environment at startup. Pi also
hot-reloads its active custom theme file.

## Tests

- `services/gateway/src/theme/resolve.test.ts` covers browser resolution,
  snapshots, ANSI order, overrides, validation, and defaults.
- `test/familiar-theme.test.sh` covers pi JSON, ANSI exports, overrides,
  validation, and parity with `defaults.json`.
