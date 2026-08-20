#!/usr/bin/env bash
# Familiar unified theme — boot-time generator (bash/jq side).
#
# Reads the CANONICAL default palette (server/src/theme/defaults.json) and
# overlays FAMILIAR_THEME_* env (the flattened [theme] TOML section; the generic
# familiar.toml loader is a SEPARATE agent — we only consume the env contract).
# Emits consumer-specific artifacts so no color literal is duplicated:
#
#   theme_herdr_fragment   -> a [theme]/[theme.custom] TOML block for config.toml
#   theme_pi_json          -> a pi theme JSON (themes/familiar.json)
#   theme_sidebar_accent   -> the sidebar mark accent hex (for herdr-sidebar.sh)
#   theme_ansi_env         -> FAMILIAR_ANSI_0..15 exports (pane palette handoff)
#
# Env contract (matches server/src/theme/resolve.ts exactly):
#   role  background   -> FAMILIAR_THEME_BACKGROUND
#   role  selectionBg  -> FAMILIAR_THEME_SELECTION_BG
#   ansi  brightBlack  -> FAMILIAR_THEME_ANSI_BRIGHT_BLACK
#
# Validation: any non-#hex value aborts with a clear message (exit 3).

set -euo pipefail

_theme_defaults_path() {
  local here; here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  echo "$here/../server/src/theme/defaults.json"
}

# camelCase -> SNAKE_UPPER (background->BACKGROUND, selectionBg->SELECTION_BG).
_theme_snake() {
  printf '%s' "$1" | sed -E 's/([a-z0-9])([A-Z])/\1_\2/g' | tr '[:lower:]' '[:upper:]'
}

_theme_is_hex() {
  case "$1" in
    \#[0-9a-fA-F][0-9a-fA-F][0-9a-fA-F]) return 0 ;;
    \#[0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F]) return 0 ;;
    \#[0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F]) return 0 ;;
    *) return 1 ;;
  esac
}

# Resolve one role/ansi color: env override or default, validated. Expands #rgb.
# Usage: _theme_get <group:role|ansi> <name> <default>
_theme_get() {
  local group="$1" name="$2" def="$3" snake val prefix
  snake="$(_theme_snake "$name")"
  if [ "$group" = ansi ]; then prefix="FAMILIAR_THEME_ANSI_"; else prefix="FAMILIAR_THEME_"; fi
  val="$(eval "printf '%s' \"\${${prefix}${snake}:-}\"")"
  [ -z "$val" ] && val="$def"
  if ! _theme_is_hex "$val"; then
    echo "familiar theme error: $group.$name has invalid color '$val' (expected #rgb/#rrggbb/#rrggbbaa)" >&2
    return 3
  fi
  # Expand shorthand #rgb -> #rrggbb for downstream literal consumers.
  if [ "${#val}" -eq 4 ]; then
    val="#${val:1:1}${val:1:1}${val:2:1}${val:2:1}${val:3:1}${val:3:1}"
  fi
  printf '%s' "$val" | tr '[:upper:]' '[:lower:]'
}

# Emit `R_NAME=hex` / `A_NAME=hex` lines for every role + ansi into the caller's
# scope (via eval). Aborts the WHOLE process with exit 3 on any bad color: the
# nested-subshell return is checked explicitly so a failure can't be silently
# swallowed by command substitution.
_theme_resolve_all() {
  local defaults; defaults="$(_theme_defaults_path)"
  local k def got
  for k in $(jq -r '.roles | keys_unsorted[]' "$defaults"); do
    def="$(jq -r --arg k "$k" '.roles[$k]' "$defaults")"
    if ! got="$(_theme_get role "$k" "$def")"; then exit 3; fi
    printf 'R_%s=%q\n' "$k" "$got"
  done
  for k in $(jq -r '.ansi | keys_unsorted[]' "$defaults"); do
    def="$(jq -r --arg k "$k" '.ansi[$k]' "$defaults")"
    if ! got="$(_theme_get ansi "$k" "$def")"; then exit 3; fi
    printf 'A_%s=%q\n' "$k" "$got"
  done
}

# --- consumer: herdr [theme] TOML fragment ---------------------------------
# Maps Familiar semantic roles onto herdr's theme.custom token set (the exact
# keys herdr 0.8.x accepts; see `strings herdr | grep theme.custom`). Only the
# intersection is emitted — herdr has no ANSI-16 knob, so pane palette is
# handled via TERM/env, not here.
theme_herdr_fragment() {
  local _resolved; _resolved="$(_theme_resolve_all)" || exit 3; eval "$_resolved"
  cat <<EOF
[theme]
# Familiar unified theme (generated — edit [theme] in familiar.toml, not here).
name = "catppuccin"

[theme.custom]
accent = "$R_accent"
panel_bg = "$R_background"
sidebar_bg = "$R_surface"
active_row_bg = "$R_selectionBg"
selection_bg = "$R_selectionBg"
surface0 = "$R_overlay"
surface1 = "$R_borderMuted"
surface_dim = "$R_surfaceDim"
text = "$R_text"
subtext0 = "$R_muted"
green = "$A_green"
yellow = "$A_yellow"
red = "$A_red"
blue = "$A_blue"
teal = "$R_accent"
peach = "$A_yellow"
mauve = "$A_magenta"
EOF
}

# --- consumer: pi theme JSON -----------------------------------------------
# Builds a full pi theme (all 51 required tokens) from Familiar roles + ANSI.
# Written to $PI_CODING_AGENT_DIR/themes/familiar.json; settings.json selects
# "familiar". pi hot-reloads a custom theme file edit; cold restart regenerates.
theme_pi_json() {
  local _resolved; _resolved="$(_theme_resolve_all)" || exit 3; eval "$_resolved"
  jq -n \
    --arg accent "$R_accent" --arg text "$R_text" --arg muted "$R_muted" \
    --arg bg "$R_background" --arg surface "$R_surface" --arg surfaceDim "$R_surfaceDim" \
    --arg overlay "$R_overlay" --arg border "$R_border" --arg borderMuted "$R_borderMuted" \
    --arg sel "$R_selectionBg" \
    --arg success "$R_success" --arg warning "$R_warning" --arg error "$R_error" \
    --arg red "$A_red" --arg green "$A_green" --arg yellow "$A_yellow" \
    --arg blue "$A_blue" --arg magenta "$A_magenta" --arg cyan "$A_cyan" \
    --arg white "$A_white" --arg brightBlack "$A_brightBlack" \
'{
  "$schema": "https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/src/modes/interactive/theme/theme-schema.json",
  name: "familiar",
  vars: {
    accent: $accent, text: $text, muted: $muted, dim: $brightBlack,
    bg: $bg, surface: $surface, overlay: $overlay, sel: $sel,
    red: $red, green: $green, yellow: $yellow, blue: $blue,
    magenta: $magenta, cyan: $cyan
  },
  colors: {
    accent: "accent", border: "blue", borderAccent: "accent", borderMuted: "overlay",
    success: $success, error: $error, warning: $warning,
    muted: "muted", dim: "dim", text: "text", thinkingText: "muted",
    selectedBg: "sel", scrollbarThumb: "overlay",
    userMessageBg: "surface", userMessageText: "text",
    customMessageBg: "overlay", customMessageText: "text", customMessageLabel: "magenta",
    toolPendingBg: $surface, toolSuccessBg: "#283228", toolErrorBg: "#3c2828",
    toolTitle: "text", toolOutput: "muted",
    mdHeading: "yellow", mdLink: "blue", mdLinkUrl: "dim", mdCode: "accent",
    mdCodeBlock: "green", mdCodeBlockBorder: "muted", mdQuote: "muted",
    mdQuoteBorder: "muted", mdHr: "muted", mdListBullet: "accent",
    toolDiffAdded: "green", toolDiffRemoved: "red", toolDiffContext: "muted",
    syntaxComment: "muted", syntaxKeyword: "blue", syntaxFunction: "yellow",
    syntaxVariable: "cyan", syntaxString: "green", syntaxNumber: "magenta",
    syntaxType: "accent", syntaxOperator: "text", syntaxPunctuation: "text",
    thinkingOff: "dim", thinkingMinimal: "muted", thinkingLow: "blue",
    thinkingMedium: "cyan", thinkingHigh: "magenta", thinkingXhigh: "accent",
    thinkingMax: "accent", bashMode: "green"
  },
  export: { pageBg: $bg, cardBg: $surface, infoBg: $overlay }
}'
}

# --- consumer: sidebar mark accent -----------------------------------------
theme_sidebar_accent() {
  local _resolved; _resolved="$(_theme_resolve_all)" || exit 3; eval "$_resolved"
  printf '%s' "$R_accent"
}

# --- consumer: ANSI env for new panes --------------------------------------
# herdr/restty have no per-pane ANSI-16 config key, so newly opened panes inherit
# the palette via env the shell/TUI can honor. We export FAMILIAR_ANSI_0..15 so a
# pane's rc can emit OSC 4 sequences if desired. This is the honest limit: it is
# env handoff, not a herdr-native palette setting (none exists in 0.8.x).
theme_ansi_env() {
  local _resolved; _resolved="$(_theme_resolve_all)" || exit 3; eval "$_resolved"
  local order=(black red green yellow blue magenta cyan white \
               brightBlack brightRed brightGreen brightYellow \
               brightBlue brightMagenta brightCyan brightWhite)
  local i=0 name val
  for name in "${order[@]}"; do
    val="$(eval "printf '%s' \"\$A_$name\"")"
    printf 'export FAMILIAR_ANSI_%d=%s\n' "$i" "$val"
    i=$((i + 1))
  done
}

# Standalone dispatch so tests / familiar.sh can call one action.
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  case "${1:-}" in
    herdr)   theme_herdr_fragment ;;
    pi)      theme_pi_json ;;
    accent)  theme_sidebar_accent ;;
    ansi)    theme_ansi_env ;;
    *) echo "usage: familiar-theme.sh {herdr|pi|accent|ansi}" >&2; exit 2 ;;
  esac
fi
