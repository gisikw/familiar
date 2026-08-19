#!/usr/bin/env bash
set -euo pipefail

SELF="$(realpath "$0")"
REPO="$(dirname "$SELF")"
STATE_DIR="$REPO/state"
HERDR_STATE_DIR="$STATE_DIR/herdr"
HERDR_COLD_START=0
export HERDR_SESSION="${HERDR_SESSION:-familiar}"
export HERDR_CONFIG_PATH="${HERDR_CONFIG_PATH:-$HERDR_STATE_DIR/config.toml}"

# Defaults
export FAMILIAR_IDENTITY_PATH="${FAMILIAR_IDENTITY_PATH:-$REPO/identity}"
export FAMILIAR_AGE_KEY="${FAMILIAR_AGE_KEY:-$STATE_DIR/age.key}"
export FAMILIAR_HANDOFF_PATH="${FAMILIAR_HANDOFF_PATH:-$STATE_DIR/handoffs}"
export FAMILIAR_RELOAD_REQUEST_PATH="${FAMILIAR_RELOAD_REQUEST_PATH:-$HERDR_STATE_DIR/reload-request}"
export FAMILIAR_RELOAD_COMPLETE_PATH="${FAMILIAR_RELOAD_COMPLETE_PATH:-$HERDR_STATE_DIR/reload-complete}"
# Session storage. Overriding this is the deliberate escape hatch for a wedged
# session: point it at a clean-room dir to bail out without touching the main
# continuity line. Not a first-class verb on purpose — forking continuity
# should have friction.
export PI_CODING_AGENT_DIR="${PI_CODING_AGENT_DIR:-$STATE_DIR/pi}"

if [ -f "$REPO/.env" ]; then
  set -a; . "$REPO/.env"; set +a
fi

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
      -c 32768;
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
      bun "$REPO/scripts/stt-server.ts";
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
      --port 9933;
    sleep 1;
  done
}

run_pi() {
  ensure_devshell pi "$@"
  export FAMILIAR_LOG_PATH="$STATE_DIR/log.jsonl"
  export FAMILIAR_SUBSCRIBER_PORT=1692
  mkdir -p "$PI_CODING_AGENT_DIR"
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
      --arg ext "$REPO/extensions" '
      $prev + {
        lastChangelogVersion: "0.84.1",
        theme: "dark",
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
    command pi \
      --continue \
      --no-context-files \
      --no-skills \
      --skill "$REPO/skills/"
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
  cat > "$HERDR_CONFIG_PATH" <<EOF
onboarding = false

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

[ui.sidebar.pty]
command = "$REPO/scripts/herdr-sidebar.sh"
rows = 12
cwd = "$REPO"
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

  [ -n "${NEED_LLAMA:-}" ] && services+=(llama)
  [ -n "${NEED_STT:-}" ] && services+=(stt)
  [ -n "${NEED_TTS:-}" ] && services+=(tts)
  if [ "${#services[@]}" -gt 0 ]; then
    service_response=$(herdr tab create --workspace "$workspace" --cwd "$REPO" --label services --no-focus)
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

case ${1:-} in
  pi)     run_pi "$@" ;;
  llama)  run_llama "$@" ;;
  stt)    run_stt "$@" ;;
  tts)    run_tts "$@" ;;
  kill)   stop "$@" ;;
  age)    handle_age "$@" ;;
  *)      start "$@" ;;
esac
