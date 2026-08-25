#!/usr/bin/env bash
# Tests for scripts/familiar-theme.sh (the boot-time bash/jq generator).
# Asserts generated pi theme JSON, ANSI palette, default
# parity with the canonical defaults.json, env overrides, and clear failure on
# bad colors. Requires: jq. Run: bash test/familiar-theme.test.sh
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
GEN="$REPO/scripts/familiar-theme.sh"
DEFAULTS="$REPO/services/gateway/src/theme/defaults.json"

pass=0; fail=0
ok()  { echo "PASS: $1"; pass=$((pass+1)); }
bad() { echo "FAIL: $1"; fail=$((fail+1)); }

# 1. accent default is gruvbox aqua (legible Familiar mark).
got="$(bash "$GEN" accent)"
[ "$got" = "#8ec07c" ] && ok "accent default #8ec07c" || bad "accent default (got $got)"


# 2. pi JSON: valid JSON, name=familiar, all 51 required color tokens present.
pi="$(bash "$GEN" pi)"
echo "$pi" | jq -e . >/dev/null 2>&1 && ok "pi JSON is valid" || bad "pi JSON invalid"
[ "$(echo "$pi" | jq -r .name)" = "familiar" ] && ok "pi name=familiar" || bad "pi name"
# The pi schema's required color-token list (from installed theme-schema.json).
required="accent border borderAccent borderMuted success error warning muted dim text thinkingText selectedBg userMessageBg userMessageText customMessageBg customMessageText customMessageLabel toolPendingBg toolSuccessBg toolErrorBg toolTitle toolOutput mdHeading mdLink mdLinkUrl mdCode mdCodeBlock mdCodeBlockBorder mdQuote mdQuoteBorder mdHr mdListBullet toolDiffAdded toolDiffRemoved toolDiffContext syntaxComment syntaxKeyword syntaxFunction syntaxVariable syntaxString syntaxNumber syntaxType syntaxOperator syntaxPunctuation thinkingOff thinkingMinimal thinkingLow thinkingMedium thinkingHigh thinkingXhigh bashMode"
missing=""
for tok in $required; do
  echo "$pi" | jq -e --arg t "$tok" '.colors[$t] != null' >/dev/null 2>&1 || missing="$missing $tok"
done
[ -z "$missing" ] && ok "pi has all 51 required tokens" || bad "pi missing tokens:$missing"
# pi accent var must resolve to the theme accent.
[ "$(echo "$pi" | jq -r .vars.accent)" = "#8ec07c" ] && ok "pi accent var" || bad "pi accent var"

# 3. ANSI env: 16 exports, index 0 == ansi.black default, all hex.
ansi="$(bash "$GEN" ansi)"
n="$(echo "$ansi" | grep -c '^export FAMILIAR_ANSI_')"
[ "$n" -eq 16 ] && ok "ansi env has 16 entries" || bad "ansi env count ($n)"
a0="$(echo "$ansi" | sed -n 's/^export FAMILIAR_ANSI_0=//p')"
def0="$(jq -r '.ansi.black' "$DEFAULTS")"
[ "$a0" = "$def0" ] && ok "ansi[0] == defaults.ansi.black" || bad "ansi[0] ($a0 vs $def0)"

# 4. default parity with defaults.roles.accent.
def_accent="$(jq -r '.roles.accent' "$DEFAULTS")"
[ "$got" = "$def_accent" ] && ok "accent parity with defaults.json" || bad "accent parity"

# 5. env override propagates + #rgb expands.
ov="$(FAMILIAR_THEME_ACCENT='#abc' bash "$GEN" accent)"
[ "$ov" = "#aabbcc" ] && ok "override + #rgb expansion" || bad "override (got $ov)"
ovh="$(FAMILIAR_THEME_ANSI_RED='#00ff00' bash "$GEN" ansi | sed -n 's/^export FAMILIAR_ANSI_1=//p')"
[ "$ovh" = "#00ff00" ] && ok "ansi override propagates" || bad "ansi override (got $ovh)"

# 6. pane border consumer resolves defaults and role overrides.
borders="$(bash "$GEN" pane-borders)"
eval "$borders"
[ "$border" = "$(jq -r '.roles.border' "$DEFAULTS")" ] \
  && [ "$border_muted" = "$(jq -r '.roles.borderMuted' "$DEFAULTS")" ] \
  && ok "pane borders match role defaults" || bad "pane border defaults"
borders="$(FAMILIAR_THEME_BORDER='#abc' FAMILIAR_THEME_BORDER_MUTED='#123456' bash "$GEN" pane-borders)"
eval "$borders"
[ "$border" = "#aabbcc" ] && [ "$border_muted" = "#123456" ] \
  && ok "pane border overrides propagate" || bad "pane border overrides"

# 7. tmux copy-mode styles use semantic palette roles and honor overrides.
tmux_style="$(FAMILIAR_THEME_ACCENT='#abc' bash "$GEN" tmux)"
case "$tmux_style" in
  *"mode-style 'fg=#ebdbb2,bg=#504945'"*"copy-mode-position-style 'fg=#aabbcc,bg=#282828'"*)
    ok "tmux copy-mode roles and overrides" ;;
  *) bad "tmux copy-mode roles (got $tmux_style)" ;;
esac

# 8. bad color fails clearly with exit 3 and a useful message.
FAMILIAR_THEME_ACCENT='notacolor' bash "$GEN" pi >/dev/null 2>&1
[ "$?" -eq 3 ] && ok "bad color exits 3" || bad "bad color exit code"
msg="$({ FAMILIAR_THEME_ACCENT='notacolor' bash "$GEN" pi >/dev/null; } 2>&1)"
case "$msg" in *"invalid color"*) ok "bad color message" ;; *) bad "bad color message" ;; esac

echo "----"
echo "theme-gen: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
