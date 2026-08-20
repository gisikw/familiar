#!/usr/bin/env bash
set -euo pipefail

SELF="$(realpath "$0" 2>/dev/null || { cd "$(dirname "$0")" && printf '%s/%s' "$(pwd -P)" "$(basename "$0")"; })"
REPO="$(dirname "$SELF")"
STATE_DIR="$REPO/state"
HERDR_STATE_DIR="$STATE_DIR/herdr"
HERDR_COLD_START=0

# Local configuration must load before defaults and before dev-shell recursion:
# file values beat defaults, while the ambient variables captured by the loader
# beat file values. The exported provenance marker keeps that ordering stable
# when nix develop or /refamiliarize re-enters this script.
# shellcheck source=scripts/familiar-config.sh
. "$REPO/scripts/familiar-config.sh"
familiar_config_load "$REPO"

export HERDR_SESSION="${HERDR_SESSION:-familiar}"
export HERDR_CONFIG_PATH="${HERDR_CONFIG_PATH:-$HERDR_STATE_DIR/config.toml}"

# Defaults (lowest precedence)
export FAMILIAR_IDENTITY_PATH="${FAMILIAR_IDENTITY_PATH:-$REPO/identity}"
export FAMILIAR_AGE_KEY="${FAMILIAR_AGE_KEY:-$STATE_DIR/age.key}"
export FAMILIAR_HANDOFF_PATH="${FAMILIAR_HANDOFF_PATH:-$STATE_DIR/handoffs}"
export FAMILIAR_INBOX_DIR="${FAMILIAR_INBOX_DIR:-$STATE_DIR/inbox}"
export FAMILIAR_RELOAD_REQUEST_PATH="${FAMILIAR_RELOAD_REQUEST_PATH:-$HERDR_STATE_DIR/reload-request}"
export FAMILIAR_RELOAD_COMPLETE_PATH="${FAMILIAR_RELOAD_COMPLETE_PATH:-$HERDR_STATE_DIR/reload-complete}"
export FAMILIAR_LOG_PATH="${FAMILIAR_LOG_PATH:-$STATE_DIR/log.jsonl}"
export FAMILIAR_SUBSCRIBER_PORT="${FAMILIAR_SUBSCRIBER_PORT:-1692}"
# Session storage. Overriding this is the deliberate escape hatch for a wedged
# session: point it at a clean-room dir to bail out without touching the main
# continuity line. Not a first-class verb on purpose — forking continuity
# should have friction.
export PI_CODING_AGENT_DIR="${PI_CODING_AGENT_DIR:-$STATE_DIR/pi}"

MODEL_DIR="${FAMILIAR_MODEL_DIR:-$REPO/models}"

ensure_devshell() {
  local shell=$1; shift
  if [ "${FAMILIAR_SHELL:-}" != "$shell" ]; then
    exec nix develop ".#$shell" -c "$SELF" "$@"; 
  fi
}

setup_llama() {
  if [ -z "${LLAMA_BASE_URL:-}" ]; then
    export LLAMA_BASE_URL="http://localhost:9931"
    export NEED_LLAMA=1;
  fi
}

run_llama() {
  ensure_devshell llama "$@"
  if [ ! -f "$MODEL_DIR/$FAMILIAR_MODEL_FILE" ]; then
    mkdir -p "$MODEL_DIR"
    curl -fL --retry 5 -C - -o "$MODEL_DIR/$FAMILIAR_MODEL_FILE.part" "$FAMILIAR_MODEL_URL" \
      && mv "$MODEL_DIR/$FAMILIAR_MODEL_FILE.part" "$MODEL_DIR/$FAMILIAR_MODEL_FILE"
  fi
  while true; do
    llama-server \
      --models-dir $MODEL_DIR \
      --jinja \
      --host 127.0.0.1 \
      --port 9931 \
      -ngl 999 \
      -c 32768 || true;
    sleep 1;
  done
}

setup_stt() {
  if [ -z "${FAMILIAR_STT_URL:-}" ]; then
    export FAMILIAR_STT_URL="http://localhost:9932"
    export NEED_STT=1;
  fi
}

run_stt() {
  ensure_devshell stt "$@"
  if [ ! -f "$MODEL_DIR/$FAMILIAR_STT_MODEL_FILE" ]; then
    mkdir -p "$MODEL_DIR"
    curl -fL --retry 5 -C - -o "$MODEL_DIR/$FAMILIAR_STT_MODEL_FILE.part" "$FAMILIAR_STT_MODEL_URL" \
      && mv "$MODEL_DIR/$FAMILIAR_STT_MODEL_FILE.part" "$MODEL_DIR/$FAMILIAR_STT_MODEL_FILE"
  fi
  while true; do
    STT_MODEL="$MODEL_DIR/$FAMILIAR_STT_MODEL_FILE" PORT=9932 \
      bun "$REPO/scripts/stt-server.ts" || true;
    sleep 1;
  done
}

setup_tts() {
  if [ -z "${FAMILIAR_TTS_URL:-}" ]; then
    export FAMILIAR_TTS_URL="http://localhost:9933"
    export NEED_TTS=1;
  fi
}

run_tts() {
  ensure_devshell tts "$@"
  # Custom voices: committed under identity/voices/kokoro/ as <name>.pt.age
  # (encrypted) or plain <name>.pt, staged to state/voices/kokoro/<name>.pt
  # (decrypt or copy), then baked into a local copy of the Kokoro gguf.
  # tts-server only speaks voices embedded in the gguf (--voice selects,
  # never loads), so baking is what makes a pack selectable;
  # FAMILIAR_TTS_VOICE is runtime selection only.
  # NOTE: <name>'s first char routes espeak phonemization (a=en-US, b=en-GB,
  # e=es, ...; see KOKORO_LANG_TO_ESPEAK_ID in TTS.cpp) — name packs like
  # af_exo, not exo.
  if [ ! -f "$MODEL_DIR/$FAMILIAR_TTS_MODEL_FILE" ]; then
    mkdir -p "$MODEL_DIR"
    curl -fL --retry 5 -C - -o "$MODEL_DIR/$FAMILIAR_TTS_MODEL_FILE.part" "$FAMILIAR_TTS_MODEL_URL" \
      && mv "$MODEL_DIR/$FAMILIAR_TTS_MODEL_FILE.part" "$MODEL_DIR/$FAMILIAR_TTS_MODEL_FILE"
  fi
  local tts_model="$MODEL_DIR/$FAMILIAR_TTS_MODEL_FILE"
  local baked="$MODEL_DIR/baked-$FAMILIAR_TTS_MODEL_FILE"
  local voices_src="$REPO/identity/voices/kokoro"
  local voices_dir="$STATE_DIR/voices/kokoro"
  local packs=() rebake="" f name pt
  if [ -d "$voices_src" ]; then
    for f in "$voices_src"/*.pt "$voices_src"/*.pt.age; do
      [ -e "$f" ] || continue
      name="$(basename "$f")"; name="${name%.age}"; name="${name%.pt}"
      pt="$voices_dir/$name.pt"
      mkdir -p "$voices_dir"
      if [ ! -f "$pt" ] || [ "$f" -nt "$pt" ]; then
        case "$f" in
          *.age) age -i "$FAMILIAR_AGE_KEY" --decrypt -o "$pt" "$f" ;;
          *)     cp "$f" "$pt" ;;
        esac
      fi
      packs+=("$pt")
      if [ ! -f "$baked" ] || [ "$pt" -nt "$baked" ]; then rebake=1; fi
    done
  fi
  if [ "${#packs[@]}" -gt 0 ]; then
    if [ ! -f "$baked" ] \
      || [ -n "$rebake" ] \
      || [ "$tts_model" -nt "$baked" ] \
      || [ "$REPO/scripts/bake-kokoro-voices.py" -nt "$baked" ]; then
      python3 "$REPO/scripts/bake-kokoro-voices.py" \
        "$tts_model" "$baked.part" "${packs[@]}" \
        && mv "$baked.part" "$baked"
    fi
    tts_model="$baked"
  fi
  while true; do
    tts-server \
      --model-path "$tts_model" \
      ${FAMILIAR_TTS_VOICE:+--voice "$FAMILIAR_TTS_VOICE"} \
      --host 127.0.0.1 \
      --port 9933 || true;
    sleep 1;
  done
}

run_pi() {
  ensure_devshell pi "$@"
  mkdir -p "$PI_CODING_AGENT_DIR"
  # Unified theme: regenerate the pi theme JSON from the canonical palette +
  # FAMILIAR_THEME_* on every (re)start. Cold restart picks up [theme] changes
  # with no rebuild; pi hot-reloads the active custom theme file on edit too.
  mkdir -p "$PI_CODING_AGENT_DIR/themes"
  bash "$REPO/scripts/familiar-theme.sh" pi > "$PI_CODING_AGENT_DIR/themes/familiar.json"
  if [ -n "${NEED_LLAMA:-}" ]; then
    until curl -fsS --max-time 0.5 "$LLAMA_BASE_URL/health" >/dev/null 2>&1; do
      sleep 0.1
    done
  fi
  while true; do
    # Merge, don't clobber: pi persists /model + thinking-level choices into
    # settings.json; keep them across crash respawns. FAMILIAR_DEFAULT_MODEL
    # (+ FAMILIAR_DEFAULT_PROVIDER, default llama.cpp) only seeds when no
    # persisted choice exists. Pi itself falls back to the first available
    # model if the saved default can't be resolved (findInitialModel).
    prev=$(jq -ce . "$PI_CODING_AGENT_DIR/settings.json" 2>/dev/null || echo '{}')
    # handoff.ts triggers at 90% of the active model's real window. Pi's fixed
    # reserve is the emergency floor for small-window models and overflows.
    jq -n --argjson prev "$prev" \
      --arg provider "${FAMILIAR_DEFAULT_PROVIDER:-llama.cpp}" \
      --arg model "${FAMILIAR_DEFAULT_MODEL:-${FAMILIAR_MODEL_FILE%.*}}" \
      --arg dir "$PI_CODING_AGENT_DIR" \
      --arg ext "$REPO/extensions" '
      $prev + {
        lastChangelogVersion: "0.84.1",
        theme: "familiar",
        themes: [ ($dir + "/themes") ],
        compaction: { enabled: true, reserveTokens: 4096 },
        extensions: [ $ext ]
      }
      | .defaultProvider //= $provider
      | .defaultModel //= $model
    ' > "$PI_CODING_AGENT_DIR/settings.json"
    jq -n --arg url "$LLAMA_BASE_URL" --arg model "${FAMILIAR_MODEL_FILE%.*}" '{
      "llama.cpp": {
        "models": [
          {
            id: $model,
            name: $model,
            api: "openai-completions",
            provider: "llama.cpp",
            baseUrl: ($url  + "/v1"),
            reasoning: false,
            input: [ "text" ],
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0
            },
            contextWindow: 32768,
            maxTokens: 32768,
            compat: {
              supportsStore: false,
              supportsDeveloperRole: false,
              supportsReasoningEffort: false,
              supportsUsageInStreaming: true,
              supportsStrictMode: false,
              maxTokensField: "max_tokens"
            }
          }
        ],
        checkedAt: (now * 1000 | floor),
      }
    }' > "$PI_CODING_AGENT_DIR/models-store.json"
    # --continue resumes the most recent session (falls through to a fresh one
    # when none exists — verified in SessionManager.continueRecent). Bounces
    # and crash respawns keep continuity; /clear stays the only way to end a
    # session, and it writes a handoff first.
    #
    # `|| true` is load-bearing under `set -e`: a bare command as the loop body
    # aborts the whole function on any non-zero exit, so a crashed pi would
    # skip both the reload check below and the respawn — leaving a dead pane
    # with no supervisor, and stalling /refamiliarize unless shutdown happened
    # to exit 0.
    command pi \
      --continue \
      --no-context-files \
      --no-skills \
      --skill "$REPO/skills/" || true
    if [ -f "$FAMILIAR_RELOAD_REQUEST_PATH" ]; then
      herdr server stop >/dev/null 2>&1 || true
      return
    fi
    sleep 1
  done
}

handle_age() {
  target=${2:-}
  if [ -z "${target}" ]; then
    echo "Usage: ./familiar.sh age <target>"
    exit 1
  fi

  ensure_devshell pi "$@"

  if [ ! -f "$FAMILIAR_AGE_KEY" ]; then
    echo "Generating age key to $FAMILIAR_AGE_KEY"
    mkdir -p "$(dirname "$FAMILIAR_AGE_KEY")"
    age-keygen -o "$FAMILIAR_AGE_KEY" >/dev/null
  fi

  pubkey=$(age-keygen -y "$FAMILIAR_AGE_KEY")

  if test ! -t 0; then
    age -r "$pubkey" -o "$target"
  else
    tmp=$(mktemp); orig=$(mktemp)
    trap 'rm -f "$tmp" "$orig"' EXIT
    if [ -f "$target" ]; then
      age -i "$FAMILIAR_AGE_KEY" --decrypt -o "$tmp" "$target"
    fi
    cp "$tmp" "$orig"
    "${EDITOR:-vi}" "$tmp"
    cmp -s "$tmp" "$orig" || age -r "$pubkey" -o "$target" "$tmp"
  fi
}

write_herdr_config() {
  mkdir -p "$HERDR_STATE_DIR" "$(dirname "$HERDR_CONFIG_PATH")"
  # Unified theme: generate the [theme]/[theme.custom] block from the canonical
  # palette + FAMILIAR_THEME_* env (scripts/familiar-theme.sh). A bad color
  # aborts (set -e) before a broken config is written.
  local theme_block
  theme_block="$(bash "$REPO/scripts/familiar-theme.sh" herdr)"
  cat > "$HERDR_CONFIG_PATH" <<EOF
onboarding = false

$theme_block

[terminal]
default_shell = "$FAMILIAR_INTERACTIVE_SHELL"
new_cwd = "follow"

[update]
version_check = false
manifest_check = false

[[keys.command]]
key = "prefix+shift+q"
type = "shell"
command = "\$HERDR_BIN_PATH server stop"
description = "stop the Familiar Herdr server"

[ui]
sidebar_width = 30
sidebar_min_width = 24
sidebar_max_width = 36
prompt_new_workspace_name = false
# The Familiar workspace holds only the pi tab (services live in their own
# workspace), so this hides the tab row exactly when Kevin is looking at pi.
hide_tab_bar_when_single_tab = true
# Reclaim the scrollbar column — the thin line on the right edge of an
# otherwise unsplit pane.
pane_scrollbars = false
# No outside frame around the pane area either; splits keep their internal
# dividers via pane_borders (default true).
pane_outer_borders = false

[ui.sidebar.pty]
command = "$REPO/scripts/herdr-sidebar.sh"
rows = 12
cwd = "$REPO"

# The sidebar mark is transmitted via kitty graphics (scripts/herdr-sidebar.sh).
# Herdr's kitty-graphics rendering for attached clients is experimental and OFF
# by default — without this the APC transmit is swallowed and the sidebar shows
# only the wordmark text.
[experimental]
kitty_graphics = true
EOF
}

herdr_server_running() {
  herdr status server --json 2>/dev/null | jq -e '.running == true' >/dev/null
}

wait_for_herdr() {
  local tries=0
  until herdr_server_running; do
    tries=$((tries + 1))
    if [ "$tries" -ge 100 ]; then
      echo "Herdr server did not become ready; see $HERDR_STATE_DIR/server.stdout.log" >&2
      return 1
    fi
    sleep 0.1
  done
}

start_herdr_server() {
  if herdr_server_running; then return; fi
  HERDR_COLD_START=1
  nohup herdr server </dev/null >"$HERDR_STATE_DIR/server.stdout.log" 2>&1 &
  wait_for_herdr
}

run_in_herdr_pane() {
  local pane=$1 role=$2 command
  if [ "$role" = pi ]; then
    printf -v command 'printf "\\033[2J\\033[H"; %q %q' "$SELF" "$role"
  elif [ "$role" = server ]; then
    # The familiar server (web presence) is a plain Node service under ./server,
    # launched DIRECTLY here — there is deliberately no `familiar.sh server`
    # subcommand. Install deps on first run (node-pty native build + vendored
    # web assets via postinstall), then supervise with a restart loop, matching
    # llama/stt/tts. Its toolchain is the .#server devshell (nodejs_22 + a
    # C/py toolchain for node-pty).
    printf -v command \
      'cd %q && { [ -d node_modules ] || nix develop %q#server -c npm install; }; while true; do nix develop %q#server -c npm start || true; sleep 1; done' \
      "$REPO/server" "$REPO" "$REPO"
  else
    printf -v command '%q %q' "$SELF" "$role"
  fi
  herdr pane rename "$pane" "$role" >/dev/null
  herdr pane run "$pane" "$command" >/dev/null
}

split_herdr_pane() {
  local pane=$1 direction=$2
  herdr pane split "$pane" --direction "$direction" --cwd "$REPO" --no-focus \
    | jq -er '.result.pane.pane_id'
}

wait_for_pi_pane() {
  local pane=$1 response
  while true; do
    if response=$(herdr agent get "$pane" 2>/dev/null) \
      && jq -e '.result.agent.agent == "pi"' <<<"$response" >/dev/null; then
      return
    fi
    sleep 0.1
  done
}

launch_pi_with_splash() {
  local workspace=$1 pi_tab=$2 pi_pane=$3 response splash_tab splash_pane
  local ready_file handoff_file command

  response=$(herdr tab create --workspace "$workspace" --cwd "$REPO" --label loading --no-focus)
  splash_tab=$(jq -er '.result.tab.tab_id' <<<"$response")
  splash_pane=$(jq -er '.result.root_pane.pane_id' <<<"$response")
  ready_file="$HERDR_STATE_DIR/splash-ready-${splash_pane//:/-}"
  handoff_file="$HERDR_STATE_DIR/splash-handoff-${splash_pane//:/-}"
  rm -f "$ready_file" "$handoff_file"

  printf -v command '%q %q %q %q' \
    familiar-splash "$ready_file" "$handoff_file" "$pi_pane"
  herdr pane run "$splash_pane" "$command" >/dev/null
  run_in_herdr_pane "$pi_pane" pi
  herdr tab focus "$splash_tab" >/dev/null

  # Finish the cut beside the attaching Herdr client. Both tabs have full-size
  # PTYs, so focusing Pi before closing the splash causes no resize redraw.
  (
    wait_for_pi_pane "$pi_pane"
    : > "$ready_file"
    until [ -e "$handoff_file" ]; do sleep 0.05; done
    herdr tab focus "$pi_tab" >/dev/null
    herdr tab close "$splash_tab" >/dev/null
    rm -f "$ready_file" "$handoff_file"
  ) >/dev/null 2>&1 &
}

populate_familiar_workspace() {
  local workspace=$1 pi_tab=$2 pi_root=$3
  local service_response service_root pane direction role
  local -a services=()

  # The web-presence server always runs — it is not gated behind a NEED_ flag
  # like the optional local models. It is the first service so it takes the
  # services-tab root pane; llama/stt/tts split off it when enabled.
  services+=(server)
  [ -n "${NEED_LLAMA:-}" ] && services+=(llama)
  [ -n "${NEED_STT:-}" ] && services+=(stt)
  [ -n "${NEED_TTS:-}" ] && services+=(tts)
  # Services live in their OWN workspace (not a second tab in the Familiar
  # workspace): with ui.hide_tab_bar_when_single_tab, this leaves the Familiar
  # workspace single-tab so the tab row disappears while looking at pi.
  # Reuse/replace the previous services workspace across cold starts so they
  # do not accumulate in the sidebar.
  local services_id_file="$HERDR_STATE_DIR/services-workspace-id" old_services
  if [ "${#services[@]}" -gt 0 ]; then
    if [ -s "$services_id_file" ]; then
      old_services=$(<"$services_id_file")
      herdr workspace close "$old_services" >/dev/null 2>&1 || true
    fi
    service_response=$(herdr workspace create --cwd "$REPO" --label services --no-focus)
    jq -er '.result.workspace.workspace_id' <<<"$service_response" > "$services_id_file"
    service_root=$(jq -er '.result.root_pane.pane_id' <<<"$service_response")
    run_in_herdr_pane "$service_root" "${services[0]}"
    for role in "${services[@]:1}"; do
      direction=right
      [ "$role" = tts ] && direction=down
      pane=$(split_herdr_pane "$service_root" "$direction")
      run_in_herdr_pane "$pane" "$role"
    done
  fi

  launch_pi_with_splash "$workspace" "$pi_tab" "$pi_root"
}

ensure_familiar_workspace() {
  local id_file="$HERDR_STATE_DIR/workspace-id" workspace pi_root pi_tab response old_tab
  local -a old_tabs=()
  if [ -s "$id_file" ]; then
    workspace=$(<"$id_file")
    if herdr workspace get "$workspace" >/dev/null 2>&1; then
      if [ "$HERDR_COLD_START" != 1 ]; then return; fi

      # Snapshot restore deliberately revives layout, not arbitrary processes.
      # Keep the workspace itself (and therefore its sidebar ordering), but
      # replace its shell-only tabs with our declarative live layout. Create
      # replacements first so closing the old last tab cannot close the space.
      mapfile -t old_tabs < <(
        herdr tab list --workspace "$workspace" | jq -er '.result.tabs[].tab_id'
      )
      response=$(herdr tab create --workspace "$workspace" --cwd "$REPO" --label pi --no-focus)
      pi_root=$(jq -er '.result.root_pane.pane_id' <<<"$response")
      pi_tab=$(jq -er '.result.tab.tab_id' <<<"$response")
      populate_familiar_workspace "$workspace" "$pi_tab" "$pi_root"
      for old_tab in "${old_tabs[@]}"; do
        herdr tab close "$old_tab" >/dev/null
      done
      return
    fi
  fi

  response=$(herdr workspace create --cwd "$REPO" --label Familiar --focus)
  workspace=$(jq -er '.result.workspace.workspace_id' <<<"$response")
  pi_root=$(jq -er '.result.root_pane.pane_id' <<<"$response")
  pi_tab=$(jq -er '.result.tab.tab_id' <<<"$response")
  printf '%s\n' "$workspace" > "$id_file"
  herdr tab rename "$pi_tab" pi >/dev/null
  populate_familiar_workspace "$workspace" "$pi_tab" "$pi_root"
}

# --- image drop transport ----------------------------------------------------
#
# Dragging a file onto a terminal types its *path* into the tty. Over ssh that
# path names a file on the machine holding the mouse, not the one running the
# agent, so the bytes never cross. These verbs carry them: `connect` opens a
# session with a reverse socket wired back to a small file server, `drop-serve`
# is that server, and `drop-fetch` pulls a path across it.
#
# The client half runs on a stock machine — no nix, no jq, no bun. It needs only
# bash 3.2, nc, and base64, all present on a clean macOS install. That is why
# the protocol is line-oriented text, the payload is base64, and the response is
# framed by the server closing the connection: those are the primitives that
# survive having no package manager.
#
# One socket per client machine, named for that machine, so two laptops
# connected at once do not land on the same path. The remote side asks every
# socket which one actually has the file, rather than trying to work out which
# client is in front of the human — a question a long-lived server cannot answer,
# since panes inherit the environment of whoever started it, not whoever is
# looking at it.

DROP_MAX_BYTES="${FAMILIAR_DROP_MAX_BYTES:-33554432}"
DROP_DIR="${FAMILIAR_DROP_DIR:-${HOME:-/tmp}/.familiar/drop}"

# The reverse tunnel means a remote host can read files off the client. This
# list is the only thing between it and the rest of the disk, so it is narrow on
# purpose: scratch space (where screenshots land) and the three directories a
# person actually drags from. Not $HOME, and deliberately not ~/Documents.
drop_allow_roots() {
  if [ -n "${FAMILIAR_DROP_ALLOW:-}" ]; then
    printf '%s\n' "$FAMILIAR_DROP_ALLOW" | tr ':' '\n'
    return
  fi
  printf '%s\n' "${TMPDIR:-/tmp}" /tmp /var/folders \
    "${HOME:-/nonexistent}/Desktop" \
    "${HOME:-/nonexistent}/Downloads" \
    "${HOME:-/nonexistent}/Pictures"
}

drop_permitted() {
  local path=$1 root
  case $path in
    /*) ;;
    *) return 1 ;;
  esac
  case $path in
    *..*) return 1 ;;
  esac
  while IFS= read -r root; do
    [ -n "$root" ] || continue
    root=${root%/}
    case $path in
      "$root"/*) return 0 ;;
    esac
  done <<EOF
$(drop_allow_roots)
EOF
  return 1
}

# Extension mapping rather than file(1): one less thing that has to exist on the
# client, and deterministic for the formats that matter.
drop_mime() {
  case $(printf '%s' "${1##*.}" | tr 'A-Z' 'a-z') in
    png)       printf 'image/png' ;;
    jpg|jpeg)  printf 'image/jpeg' ;;
    gif)       printf 'image/gif' ;;
    webp)      printf 'image/webp' ;;
    bmp)       printf 'image/bmp' ;;
    heic)      printf 'image/heic' ;;
    svg)       printf 'image/svg+xml' ;;
    pdf)       printf 'application/pdf' ;;
    txt|md|log)printf 'text/plain' ;;
    *)         printf 'application/octet-stream' ;;
  esac
}

# Size, without trusting a stat dialect to fail cleanly. `stat -f` means
# *filesystem* status on GNU and *format* on BSD, so the BSD spelling succeeds
# on Linux and hands back a block of filesystem info instead of a number. Each
# result is therefore checked for digits rather than for exit status, and wc is
# the fallback that needs no dialect at all.
drop_size() {
  local n=""
  n=$(stat -c %s "$1" 2>/dev/null) || n=""
  case $n in ''|*[!0-9]*) n="" ;; esac
  if [ -z "$n" ]; then
    n=$(stat -f %z "$1" 2>/dev/null) || n=""
    case $n in ''|*[!0-9]*) n="" ;; esac
  fi
  if [ -z "$n" ]; then
    n=$(wc -c < "$1" 2>/dev/null | tr -d ' ')
    case $n in ''|*[!0-9]*) n=0 ;; esac
  fi
  printf '%s' "$n"
}

# One request line in, one response out. `OK <size> <mime>` then base64 for GET;
# `OK <host> <os>` for HELLO; `ERR <reason>` otherwise. Paths may contain
# spaces, so the argument is everything after the first word rather than a
# field split.
drop_handle() {
  local line verb arg size mime
  IFS= read -r line || return 0
  line=${line%$'\r'}
  verb=${line%% *}
  arg=${line#* }
  [ "$arg" = "$verb" ] && arg=""

  case $verb in
    HELLO)
      printf 'OK %s %s\n' "$(hostname -s 2>/dev/null || printf unknown)" "$(uname -s)"
      return 0
      ;;
    STAT|GET) ;;
    *)
      printf 'ERR unknown verb\n'
      return 0
      ;;
  esac

  if [ -z "$arg" ]; then printf 'ERR missing path\n'; return 0; fi
  if ! drop_permitted "$arg"; then printf 'ERR path not permitted\n'; return 0; fi
  if [ ! -f "$arg" ]; then printf 'ERR no such file\n'; return 0; fi
  if [ ! -r "$arg" ]; then printf 'ERR not readable\n'; return 0; fi

  size=$(drop_size "$arg")
  if [ "$size" -gt "$DROP_MAX_BYTES" ]; then
    printf 'ERR too large: %s bytes exceeds %s\n' "$size" "$DROP_MAX_BYTES"
    return 0
  fi
  mime=$(drop_mime "$arg")
  printf 'OK %s %s\n' "$size" "$mime"
  if [ "$verb" = GET ]; then
    base64 < "$arg"
  fi
  return 0
}

# nc dialects disagree about flags in ways that are not merely cosmetic: -N on
# OpenBSD's nc means "shutdown the socket after EOF on stdin", while Apple's nc
# uses -N for an adaptive write timeout that takes an argument. Passing the
# wrong one is not a warning, it is an immediate exit. So the flag is probed by
# running it, not by assuming it, and the client always bounds its own read.
drop_server_nc_flags() {
  local probe="${TMPDIR:-/tmp}/familiar-nc-probe.$$" pid flags="-lU"
  rm -f "$probe"
  nc -lNU "$probe" >/dev/null 2>&1 </dev/null &
  pid=$!
  sleep 0.4
  if kill -0 "$pid" 2>/dev/null && [ -S "$probe" ]; then flags="-lNU"; fi
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  rm -f "$probe"
  printf '%s' "$flags"
}

# The server. nc handles one connection then exits, so the loop rebinds each
# time; the fifo turns nc's stdout back into the handler's stdin, which is how
# you get a request/response exchange out of a tool that only does streams.
drop_serve() {
  local sock=${2:-} fifo nc_flags fails=0
  if [ -z "$sock" ]; then
    echo "Usage: familiar.sh drop-serve <socket-path>" >&2
    return 1
  fi
  command -v nc >/dev/null 2>&1 || { echo "drop-serve requires nc" >&2; return 1; }
  command -v base64 >/dev/null 2>&1 || { echo "drop-serve requires base64" >&2; return 1; }

  nc_flags=$(drop_server_nc_flags)
  mkdir -p "$(dirname "$sock")"
  fifo="$sock.fifo"
  rm -f "$sock" "$fifo"
  mkfifo "$fifo" || return 1
  trap 'rm -f "$sock" "$fifo"' EXIT INT TERM

  while :; do
    rm -f "$sock"
    # `|| true` is load-bearing under `set -e`: a bare command as the loop body
    # aborts the whole function on any non-zero exit, so one hung-up client
    # would take the server down with it and leave the tunnel pointing at
    # nothing. It must not, however, turn a listener that can never bind into a
    # hot spin, so an immediate failure is counted and eventually fatal.
    if drop_handle < "$fifo" | nc $nc_flags "$sock" > "$fifo"; then
      fails=0
    else
      fails=$((fails + 1))
      if [ "$fails" -ge 5 ]; then
        echo "drop-serve: nc failed $fails times in a row on $sock; giving up" >&2
        return 1
      fi
      sleep 1
    fi
  done
}

# A short exchange whose reply fits in a variable (HELLO, STAT). The socket is
# rebound between connections, so a miss is retried rather than believed.
#
# -w bounds the read: when the server can shutdown after EOF the reply ends
# promptly and the timeout never elapses, and when it cannot, this is what keeps
# a fetch from hanging forever. No -N on the client — it half-closes as soon as
# stdin ends, and a server that treats that as end-of-connection exits before
# writing the reply, which reads as a silent empty response with a zero status.
drop_ask() {
  local sock=$1 req=$2 out attempt=1
  while [ "$attempt" -le 3 ]; do
    out=$(printf '%s\n' "$req" | nc -w 2 -U "$sock" 2>/dev/null || true)
    if [ -n "$out" ]; then printf '%s' "$out"; return 0; fi
    attempt=$((attempt + 1))
    sleep 0.2
  done
  return 1
}

# Pull a client-side path across whichever connected client actually has it.
drop_fetch() {
  local path=${2:-} dest=${3:-} sock reply status found="" tmp size mime attempt
  if [ -z "$path" ]; then
    echo "Usage: familiar.sh drop-fetch <client-path> [destination]" >&2
    return 1
  fi

  for sock in "$DROP_DIR"/*.sock; do
    [ -S "$sock" ] || continue
    reply=$(drop_ask "$sock" "STAT $path") || continue
    case $reply in
      OK\ *) found=$sock; break ;;
    esac
  done

  if [ -z "$found" ]; then
    echo "no connected client has $path (looked in $DROP_DIR)" >&2
    return 1
  fi

  if [ -z "$dest" ]; then
    mkdir -p "$STATE_DIR/uploads"
    dest="$STATE_DIR/uploads/${path##*/}"
  fi

  tmp=$(mktemp "${TMPDIR:-/tmp}/familiar-drop.XXXXXX") || return 1
  # Same rebind window as drop_ask: the server drops the socket between
  # connections, so a first attempt can arrive during the gap.
  attempt=1
  while [ "$attempt" -le 3 ]; do
    printf 'GET %s\n' "$path" | nc -w 30 -U "$found" > "$tmp" 2>/dev/null || true
    [ -s "$tmp" ] && break
    attempt=$((attempt + 1))
    sleep 0.2
  done

  status=$(head -n 1 "$tmp")
  case $status in
    OK\ *) ;;
    *)
      rm -f "$tmp"
      echo "${status:-no response from $found}" >&2
      return 1
      ;;
  esac

  # -d is GNU, -D is BSD; the remote is usually Linux but this costs nothing.
  if ! tail -n +2 "$tmp" | { base64 -d 2>/dev/null || base64 -D 2>/dev/null; } > "$dest"; then
    rm -f "$tmp"
    echo "could not decode payload for $path" >&2
    return 1
  fi
  rm -f "$tmp"

  size=${status#OK }
  mime=${size#* }
  size=${size%% *}
  printf '%s\n' "$dest"
  echo "fetched $size bytes ($mime) from ${found##*/}" >&2
}

# Open an ssh session with the drop server wired back through it. The server
# lives and dies with this command: no stray daemon outlives the session that
# needed it.
connect() {
  shift 2>/dev/null || true
  local target=${1:-} client_id local_sock remote_dir daemon status waited
  if [ -z "$target" ]; then
    echo "Usage: ./familiar.sh connect <[user@]host> [command...]" >&2
    return 1
  fi
  shift

  command -v nc >/dev/null 2>&1 || { echo "connect requires nc" >&2; return 1; }

  client_id=$(hostname -s 2>/dev/null || hostname 2>/dev/null || printf client)
  client_id=$(printf '%s' "$client_id" | tr -cd '[:alnum:]._-')
  [ -n "$client_id" ] || client_id=client
  local_sock="${TMPDIR:-/tmp}/familiar-drop-$client_id.sock"

  # One round trip that both creates the directory and reports where it is:
  # the forward needs an absolute remote path, and only the remote knows $HOME.
  remote_dir=$(ssh "$target" 'd="${FAMILIAR_DROP_DIR:-$HOME/.familiar/drop}"; mkdir -p "$d" && chmod 700 "$d" && printf %s "$d"') || {
    echo "could not prepare the drop directory on $target" >&2
    return 1
  }

  "$SELF" drop-serve "$local_sock" &
  daemon=$!
  trap 'kill "$daemon" 2>/dev/null || true; rm -f "$local_sock" "$local_sock.fifo"' EXIT INT TERM

  waited=0
  while [ ! -S "$local_sock" ] && [ "$waited" -lt 25 ]; do
    sleep 0.2
    waited=$((waited + 1))
  done
  if [ ! -S "$local_sock" ]; then
    echo "drop server did not come up at $local_sock" >&2
    return 1
  fi

  # StreamLocalBindUnlink clears a socket left behind by a session that died
  # badly; ExitOnForwardFailure makes a forward that cannot be established loud
  # rather than silently dropping the feature for the whole session.
  status=0
  if [ $# -gt 0 ]; then
    ssh -o StreamLocalBindUnlink=yes -o ExitOnForwardFailure=yes \
      -R "$remote_dir/$client_id.sock:$local_sock" -t "$target" "$@" || status=$?
  else
    ssh -o StreamLocalBindUnlink=yes -o ExitOnForwardFailure=yes \
      -R "$remote_dir/$client_id.sock:$local_sock" -t "$target" || status=$?
  fi
  return "$status"
}

# The Electron terminal app under client/. Runs in the `client` devShell so the
# Node version lives only in flake.nix. npm install runs only when node_modules
# is missing or package-lock.json is newer than it (cheap staleness check), so a
# normal launch skips it. bash 3.2 compatible: no associative arrays, and the
# staleness test is a plain `-nt`.
client() {
  ensure_devshell client "$@"
  local dir="$REPO/client"
  cd "$dir" || { echo "no client dir at $dir" >&2; return 1; }
  if [ ! -d node_modules ] || [ package-lock.json -nt node_modules ]; then
    npm install || return 1
  fi
  npm start
}

start() {
  local client_status
  ensure_devshell pi "$@"
  if [ "${HERDR_ENV:-}" = 1 ]; then
    echo "Familiar is already running inside Herdr session $HERDR_SESSION" >&2
    return 1
  fi
  setup_llama; setup_stt; setup_tts
  write_herdr_config

  while true; do
    start_herdr_server
    ensure_familiar_workspace
    if herdr --session "$HERDR_SESSION"; then
      client_status=0
    else
      client_status=$?
    fi
    if [ ! -f "$FAMILIAR_RELOAD_REQUEST_PATH" ]; then
      return "$client_status"
    fi
    mv -f "$FAMILIAR_RELOAD_REQUEST_PATH" "$FAMILIAR_RELOAD_COMPLETE_PATH"
    # Re-enter through the updated script and flake, not this process's stale
    # function definitions or dev shell. The replacement server will restore
    # the workspace, resume Pi, and consume reload-complete.
    exec env -u FAMILIAR_SHELL -u FAMILIAR_INTERACTIVE_SHELL "$SELF"
  done
}

stop() {
  ensure_devshell pi "$@"
  herdr session stop "$HERDR_SESSION" --json 2>/dev/null || herdr server stop 2>/dev/null || true
}

# Out-of-process enqueue (protocol path b): write an atomic envelope into the
# inbox drop-box. The inbox extension drains state/inbox/incoming/ on its timer
# and promotes each envelope into a queue item. Mirrors the herdr marker-file
# pattern: no daemon, no socket, just a file the resident process picks up.
# Envelope schema is documented in extensions/inbox/PROTOCOL.md.
#   familiar.sh inbox-enqueue --summary "..." [--priority N] [--type notify|question|review]
#                             [--body TEXT | --body-file F] [--source S] [--deadline EPOCH_MS]
inbox_enqueue() {
  shift || true
  local priority=2 type=notify summary="" body="" source="cli" deadline=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --priority)   priority="$2"; shift 2 ;;
      --type)       type="$2"; shift 2 ;;
      --summary)    summary="$2"; shift 2 ;;
      --body)       body="$2"; shift 2 ;;
      --body-file)  body="$(cat "$2")"; shift 2 ;;
      --source)     source="$2"; shift 2 ;;
      --deadline)   deadline="$2"; shift 2 ;;
      *) echo "inbox-enqueue: unknown arg $1" >&2; return 2 ;;
    esac
  done
  if [ -z "$summary" ]; then
    echo "inbox-enqueue: --summary is required" >&2; return 2
  fi
  [ -z "$body" ] && body="$summary"
  local incoming="$FAMILIAR_INBOX_DIR/incoming"
  mkdir -p "$incoming"
  local id file tmp
  id="cli-$(date +%Y%m%d-%H%M%S)-$RANDOM"
  file="$incoming/$id.json"; tmp="$file.tmp"
  jq -n \
    --argjson priority "$priority" \
    --arg type "$type" \
    --arg summary "$summary" \
    --arg body "$body" \
    --arg source "$source" \
    --arg deadline "$deadline" \
    '{priority: $priority, type: $type, summary: $summary, body: $body, source: $source}
     + (if $deadline == "" then {} else {suggested_deadline: ($deadline|tonumber)} end)' \
    > "$tmp"
  mv -f "$tmp" "$file"   # atomic: the extension only ever sees a whole file
  echo "$id"
}

case ${1:-} in
  pi)         run_pi "$@" ;;
  llama)      run_llama "$@" ;;
  stt)        run_stt "$@" ;;
  tts)        run_tts "$@" ;;
  kill)          stop "$@" ;;
  inbox-enqueue) inbox_enqueue "$@" ;;
  client)     client "$@" ;;
  age)        handle_age "$@" ;;
  connect)    connect "$@" ;;
  drop-serve) drop_serve "$@" ;;
  drop-fetch) drop_fetch "$@" ;;
  *)          start "$@" ;;
esac
