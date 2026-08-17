#!/usr/bin/env bash
set -euo pipefail

TMUX_SERVER=familiar
TMUX_SESSION=familiar
SELF="$(realpath "$0")"
REPO="$(dirname $SELF)"
STATE_DIR="$REPO/state"

# Defaults
export FAMILIAR_IDENTITY_PATH="${FAMILIAR_IDENTITY_PATH:-$REPO/identity}"
export FAMILIAR_AGE_KEY="${FAMILIAR_AGE_KEY:-$STATE_DIR/age.key}"
export FAMILIAR_HANDOFF_PATH="${FAMILIAR_HANDOFF_PATH:-$STATE_DIR/handoffs}"
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

spawn_llama() {
  if [ -n "${NEED_LLAMA:-}" ]; then
    tmux -L "$TMUX_SERVER" new-window -d -t "$TMUX_SESSION" -n llama ./familiar.sh llama
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
    NEED_STT=1;
  fi
}

spawn_stt() {
  if [ -n "${NEED_STT:-}" ]; then
    tmux -L "$TMUX_SERVER" new-window -d -t "$TMUX_SESSION" -n stt ./familiar.sh stt
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
    NEED_TTS=1;
  fi
}

spawn_tts() {
  if [ -n "${NEED_TTS:-}" ]; then
    tmux -L "$TMUX_SERVER" new-window -d -t "$TMUX_SESSION" -n tts ./familiar.sh tts
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
    echo "Waiting for llama-server at $LLAMA_BASE_URL..."
    until curl -fsS "$LLAMA_BASE_URL/health" >/dev/null 2>&1; do sleep 1; done
    clear
  fi
  while true; do
    # Merge, don't clobber: pi persists /model + thinking-level choices into
    # settings.json; keep them across crash respawns. FAMILIAR_DEFAULT_MODEL
    # (+ FAMILIAR_DEFAULT_PROVIDER, default llama.cpp) only seeds when no
    # persisted choice exists. Pi itself falls back to the first available
    # model if the saved default can't be resolved (findInitialModel).
    prev=$(jq -ce . "$PI_CODING_AGENT_DIR/settings.json" 2>/dev/null || echo '{}')
    jq -n --argjson prev "$prev" \
      --arg provider "${FAMILIAR_DEFAULT_PROVIDER:-llama.cpp}" \
      --arg model "${FAMILIAR_DEFAULT_MODEL:-${FAMILIAR_MODEL_FILE%.*}}" \
      --arg ext "$REPO/extensions" '
      $prev + {
        lastChangelogVersion: "0.84.1",
        theme: "dark",
        compaction: { enabled: false },
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

start() {
  ensure_devshell pi "$@"
  tmux -L "$TMUX_SERVER" has-session && exec tmux -L "$TMUX_SERVER" attach-session -t "$TMUX_SESSION"
  setup_llama; setup_stt; setup_tts
  tmux -L "$TMUX_SERVER" new-session -d -s "$TMUX_SESSION" -n pi ./familiar.sh pi
  tmux -L "$TMUX_SERVER" set-option -g remain-on-exit on
  tmux -L "$TMUX_SERVER" set -g extended-keys on
  tmux -L "$TMUX_SERVER" set -g extended-keys-format csi-u
  tmux -L "$TMUX_SERVER" bind-key Q kill-server
  spawn_llama; spawn_stt; spawn_tts
  exec tmux -L "$TMUX_SERVER" attach-session -t "$TMUX_SESSION"
}

case ${1:-} in
  pi)     run_pi "$@" ;;
  llama)  run_llama "$@" ;;
  stt)    run_stt "$@" ;;
  tts)    run_tts "$@" ;;
  kill)   tmux -L "$TMUX_SERVER" kill-server 2>/dev/null; exit 0 ;;
  age)    handle_age "$@" ;;
  *)      start "$@" ;;
esac
