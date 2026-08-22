#!/usr/bin/env bash
# Familiar viewer sidebar. Render the mark with kitty graphics when possible,
# then remain resident so tmux always has a stable chrome pane.
set -u

HERE=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
REPO=${FAMILIAR_REPO:-$(CDPATH='' cd -- "$HERE/../.." && pwd -P)}
MARK=${FAMILIAR_SIDEBAR_MARK:-$REPO/assets/familiar-mark.svg}
MARK_PNG=${FAMILIAR_SIDEBAR_MARK_PNG:-$REPO/assets/familiar-mark.png}
ACCENT=${FAMILIAR_SIDEBAR_ACCENT:-#5ad4e6}
TMP=''
MODE=text
TREE_ROW=13
TREE_ROWS=22
TREE_WIDTH=26

fetch_agent_jobs() {
  if [ -n "${FAMILIAR_AGENTS_JOBS_FIXTURE:-}" ]; then
    [ -r "$FAMILIAR_AGENTS_JOBS_FIXTURE" ] || return 1
    cat -- "$FAMILIAR_AGENTS_JOBS_FIXTURE"
    return
  fi
  local endpoint=${FAMILIAR_AGENTS_ENDPOINT:-http://127.0.0.1:7337}
  curl -sf --max-time 2 "${endpoint%/}/v1/jobs"
}

# Emit fixed-width display lines. Keeping data selection in jq makes malformed
# or unreachable registry responses indistinguishable from an empty registry.
format_agent_tree() {
  local records workspace label state next connector color available padding text
  local -a jobs=()
  records=$(jq -r '
    def terminal: . == "done" or . == "error" or . == "failed" or
      . == "cancelled" or . == "timeout";
    def clean: tostring | gsub("[[:space:]]+"; " ") | gsub("^ +| +$"; "");
    def workspace: ((.cwd // "") | split("/") | map(select(length > 0)) |
      (last // "unknown") | clean);
    def joblabel: ((.prompt // "") | clean) as $p |
      if ($p | length) > 0 then $p[0:16]
      else ((.id // "job") | split("-") | last | .[-8:]) end;
    if type != "array" then empty else
      ([.[] | select((.state | terminal) | not)] | sort_by(.updated_at // "") | reverse) +
      ([.[] | select(.state | terminal)] | sort_by(.updated_at // "") | reverse) |
      .[0:10] | map({workspace: workspace, label: joblabel, state: (.state // "unknown")}) |
      group_by(.workspace)[] | .[] | [.workspace, .label, .state] | @tsv
    end
  ' 2>/dev/null) || return 0
  [ -n "$records" ] || return 0

  padding=$(printf '%*s' $((TREE_WIDTH - 6)) '')
  printf '\033[2magents%s\033[0m\n' "$padding"
  mapfile -t jobs <<< "$records"
  local i count=${#jobs[@]}
  for ((i=0; i<count; i++)); do
    IFS=$'\t' read -r workspace label state <<< "${jobs[i]}"
    if [ "$i" -eq 0 ] || [ "$workspace" != "${jobs[i-1]%%$'\t'*}" ]; then
      text=$workspace
      if [ "${#text}" -gt "$TREE_WIDTH" ]; then text=${text:0:$((TREE_WIDTH - 1))}…; fi
      printf '%s%*s\n' "$text" $((TREE_WIDTH - ${#text})) ''
    fi
    if [ "$i" -eq $((count - 1)) ]; then
      connector='└─'
    else
      next=${jobs[i+1]%%$'\t'*}
      if [ "$next" = "$workspace" ]; then connector='├─'; else connector='└─'; fi
    fi
    case "$state" in
      running) color='\033[38;2;70;200;120m' ;;
      done) color='\033[38;2;90;212;230m' ;;
      error|failed|timeout) color='\033[38;2;235;90;90m' ;;
      cancelled) color='\033[2m' ;;
      *) color='\033[38;2;230;190;70m' ;;
    esac
    available=$((TREE_WIDTH - 6 - ${#state}))
    [ "$available" -gt 0 ] || available=1
    if [ "${#label}" -gt "$available" ]; then label=${label:0:$((available - 1))}…; fi
    text="$connector  $label $state"
    padding=$(printf '%*s' $((TREE_WIDTH - ${#text} - 1)) '')
    printf '%s %b●\033[0m %s %s\n' "$connector" "$color" "$label" "$state$padding"
  done
}

render_agent_tree() {
  local i line row=$TREE_ROW
  for ((i=0; i<TREE_ROWS; i++)); do
    printf '\033[%d;1H%*s' $((row + i)) "$TREE_WIDTH" ''
  done
  i=0
  while IFS= read -r line && [ "$i" -lt "$TREE_ROWS" ]; do
    printf '\033[%d;1H%s' $((row + i)) "$line"
    i=$((i + 1))
  done < <(fetch_agent_jobs 2>/dev/null | format_agent_tree)
}

if [ "${FAMILIAR_SIDEBAR_FORMAT_ONLY:-}" = 1 ]; then
  fetch_agent_jobs 2>/dev/null | format_agent_tree
  exit 0
fi

cleanup() {
  printf '\033[?25h'
  [ -z "$TMP" ] || rm -rf -- "$TMP"
}
trap cleanup EXIT
trap 'exit 0' INT TERM
printf '\033[?25l'

prepare_mark() {
  command -v base64 >/dev/null 2>&1 || return 1
  TMP=$(mktemp -d "${TMPDIR:-/tmp}/familiar-sidebar.XXXXXX") || return 1
  if command -v rsvg-convert >/dev/null 2>&1 && [ -r "$MARK" ]; then
    sed "s/currentColor/$ACCENT/g" "$MARK" > "$TMP/mark.svg" \
      && rsvg-convert -w 256 -h 256 "$TMP/mark.svg" -o "$TMP/mark.png" >/dev/null 2>&1 \
      && [ -s "$TMP/mark.png" ] && return 0
  fi
  # Pre-rendered accent PNG: keeps the mark visible where librsvg is absent
  # (e.g. the presence child launched straight from the supervisor).
  [ -r "$MARK_PNG" ] || return 1
  cp "$MARK_PNG" "$TMP/mark.png" && [ -s "$TMP/mark.png" ]
}

send_mark() {
  local data total offset=0 chunk first=1 more row col placeholder
  local -a diacritics=(
    $'\u0305' $'\u030d' $'\u030e' $'\u0310'
    $'\u0312' $'\u033d' $'\u033e' $'\u033f'
    $'\u0346' $'\u034a' $'\u034b' $'\u034c'
    $'\u0350' $'\u0351' $'\u0352' $'\u0357'
  )
  placeholder=$'\U0010eeee'
  data=$(base64 -w0 "$TMP/mark.png" 2>/dev/null || base64 "$TMP/mark.png" | tr -d '\n')
  [ -n "$data" ] || return 1
  total=${#data}
  printf '\033[2J\033[H'
  # APC passthrough reaches the outer terminal, but deliberately creates only
  # a virtual placement. Its cursor position is irrelevant. The visible image
  # is anchored by ordinary grid cells below, which tmux positions and replays.
  # Stable image id + delete-before-transmit keeps repaints bounded.
  printf '\033Ptmux;\033\033_Ga=d,d=i,i=1,q=2\033\033\\\033\\'
  while [ "$offset" -lt "$total" ]; do
    chunk=${data:$offset:4096}
    offset=$((offset + 4096))
    if [ "$offset" -lt "$total" ]; then more=1; else more=0; fi
    # tmux does not forward a raw kitty APC. Wrap each command in tmux's DCS
    # passthrough envelope and double ESC bytes in the enclosed APC.
    if [ "$first" -eq 1 ]; then
      printf '\033Ptmux;\033\033_Gf=100,a=T,U=1,c=16,r=8,i=1,p=1,q=2,m=%d;%s\033\033\\\033\\' "$more" "$chunk"
      first=0
    else
      printf '\033Ptmux;\033\033_Gm=%d;%s\033\033\\\033\\' "$more" "$chunk"
    fi
  done
  # U+10EEEE plus canonical row/column diacritics are normal terminal text.
  # Truecolor foreground 0x000001 selects image id 1; explicit coordinates
  # remain correct under horizontal scrolling and nested tmux redraws.
  printf '\033[38;2;0;0;1m'
  for ((row=0; row<8; row++)); do
    printf '\033[%d;7H' $((row + 2))
    for ((col=0; col<16; col++)); do
      printf '%s%s%s' "$placeholder" "${diacritics[row]}" "${diacritics[col]}"
    done
  done
  printf '\033[0m\033[11;7H\033[1;38;2;90;212;230mF A M I L I A R\033[0m'
}

send_text() {
  printf '\033[2J\033[H\n\n  \033[1;38;2;90;212;230m      familiar\033[0m'
}

if prepare_mark; then MODE=kitty; fi
render() {
  if [ "$MODE" = kitty ]; then send_mark || { MODE=text; send_text; }
  else send_text
  fi
  render_agent_tree
}
trap render WINCH
render

# Periodic repaint makes kitty images visible to clients which attach after the
# original APC transmission and refreshes the registry. WINCH remains immediate.
while :; do
  sleep 10 & wait $! || true
  render
done
