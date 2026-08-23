#!/usr/bin/env bash
# Familiar unified theme — boot-time generator (bash/jq side).
#
# Reads the CANONICAL default palette (services/gateway/src/theme/defaults.json) and
# overlays FAMILIAR_THEME_* env (the flattened [theme] TOML section; the generic
# familiar.toml loader is a SEPARATE agent — we only consume the env contract).
# Emits consumer-specific artifacts so no color literal is duplicated:
#
#   theme_pi_json          -> a pi theme JSON (themes/familiar.json)
#   theme_ansi_env         -> FAMILIAR_ANSI_0..15 exports (pane palette handoff)
#   theme_pane_borders     -> shell assignments for tmux pane border roles
#   theme_tmux             -> tmux copy-mode styling configuration
#
# Env contract (matches services/gateway/src/theme/resolve.ts exactly):
#   role  background   -> FAMILIAR_THEME_BACKGROUND
#   role  selectionBg  -> FAMILIAR_THEME_SELECTION_BG
#   ansi  brightBlack  -> FAMILIAR_THEME_ANSI_BRIGHT_BLACK
#
# Validation: any non-#hex value aborts with a clear message (exit 3).

set -euo pipefail

# jq is a hard dependency for palette resolution. Fail fast and clearly —
# without this guard a missing jq surfaces as unbound-variable noise deep in
# eval'd resolution instead of an actionable message.
command -v jq >/dev/null 2>&1 || {
  echo "familiar-theme: jq is required but not on PATH" >&2
  exit 4
}

_theme_defaults_path() {
  local here; here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  echo "$here/../services/gateway/src/theme/defaults.json"
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
    toolPendingBg: $surface, toolSuccessBg: "overlay", toolErrorBg: "overlay",
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

# --- consumer: tmux pane borders -------------------------------------------
# Shell-escaped assignments retained for legacy theme consumers. This keeps
# canonical defaults and FAMILIAR_THEME_* override resolution in one place.
theme_pane_borders() {
  local _resolved; _resolved="$(_theme_resolve_all)" || exit 3; eval "$_resolved"
  printf 'border=%q\nborder_muted=%q\n' "$R_border" "$R_borderMuted"
}

# --- consumer: tmux copy mode ----------------------------------------------
# Selection uses the ordinary text role on selectionBg. The compact position
# indicator is accent on background so it matches Familiar chrome without the
# stock tmux yellow. tmux 3.6 supports the two copy-mode-specific options.
theme_tmux() {
  local _resolved; _resolved="$(_theme_resolve_all)" || exit 3; eval "$_resolved"
  printf "set-option -g mode-style 'fg=%s,bg=%s'\n" "$R_text" "$R_selectionBg"
  printf "set-option -g copy-mode-mark-style 'fg=%s,bg=%s'\n" "$R_text" "$R_selectionBg"
  printf "set-option -g copy-mode-position-style 'fg=%s,bg=%s'\n" "$R_accent" "$R_background"
}

# --- consumer: ANSI env for new panes --------------------------------------
# Terminal consumers may inherit the palette through the environment. We export FAMILIAR_ANSI_0..15 so a
# A shell or TUI can use these values to emit OSC 4 sequences if desired.
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
    pi)      theme_pi_json ;;
    accent)  theme_sidebar_accent ;;
    ansi)    theme_ansi_env ;;
    pane-borders) theme_pane_borders ;;
    tmux) theme_tmux ;;
    *) echo "usage: familiar-theme.sh {pi|accent|ansi|pane-borders|tmux}" >&2; exit 2 ;;
  esac
fi
