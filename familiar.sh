#!/usr/bin/env bash
set -euo pipefail

TMUX_SERVER=familiar
TMUX_SESSION=familiar
SELF="$(realpath "$0")"
REPO="$(dirname $SELF)"
STATE_DIR="$REPO/state"

if [ -f "$REPO/.env" ]; then
  set -a; . "$REPO/.env"; set +a
fi

MODEL_DIR="${FAMILIAR_MODEL_DIR:-$REPO/models}"
MODEL_FILE="gemma-4-E4B-it-Q4_K_M.gguf"
MODEL_URL="https://huggingface.co/unsloth/gemma-4-E4B-it-GGUF/resolve/main/$MODEL_FILE"

ensure_devshell() {
  local shell=$1; shift
  if [ "${FAMILIAR_SHELL:-}" != "$shell" ]; then
    exec nix develop ".#$shell" -c "$SELF" "$@"; 
  fi
}

setup_llama() {
  if [ -z "${LLAMA_BASE_URL:-}" ]; then
    export LLAMA_BASE_URL="http://localhost:9931"
    NEED_LLAMA=1;
  fi
}

spawn_llama() {
  if [ -n "${NEED_LLAMA:-}" ]; then
    tmux -L "$TMUX_SERVER" new-window -d -t "$TMUX_SESSION" -n llama ./familiar.sh llama
  fi
}

run_llama() {
  ensure_devshell llama "$@"
  if [ ! -f "$MODEL_DIR/$MODEL_FILE" ]; then
    mkdir -p "$MODEL_DIR"
    curl -fL --retry 5 -C - -o "$MODEL_DIR/$MODEL_FILE.part" "$MODEL_URL" \
      && mv "$MODEL_DIR/$MODEL_FILE.part" "$MODEL_DIR/$MODEL_FILE"
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
    export FAMILIAR_STT_URL="http://localhost:0"
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
}

setup_tts() {
  if [ -z "${FAMILIAR_TTS_URL:-}" ]; then
    export FAMILIAR_TTS_URL="http://localhost:0"
    NEED_TTS=1;
  fi
}

spawn_tts() {
  if [ -n "${NEED_TTS:-}" ]; then
    tmux -L "$TMUX_SERVER" new-window -d -t "$TMUX_SESSION" -n tts ./familiar.sh tts
  fi
}

run_tts() {
  ensure_devshell stt "$@"
}

run_pi() {
  ensure_devshell pi "$@"
  export PI_CODING_AGENT_DIR="$STATE_DIR/pi"
  export FAMILIAR_LOG_PATH="$STATE_DIR/log.jsonl"
  export FAMILIAR_SUBSCRIBER_PORT=1692
  mkdir -p "$PI_CODING_AGENT_DIR"
  while true; do
    jq -n --arg model "${MODEL_FILE%.*}" --arg ext "$REPO/extensions" '{
      lastChangelogVersion: "0.84.1",
      theme: "dark",
      defaultProvider: "llama.cpp",
      defaultModel: $model,
      compaction: { enabled: false },
      extensions: [ $ext ],
    }' > "$PI_CODING_AGENT_DIR/settings.json"
    jq -n --arg url "$LLAMA_BASE_URL" --arg model "${MODEL_FILE%.*}" '{
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
    command pi \
      --no-context-files \
      --no-skills \
      --skill "$REPO/skills/"
    sleep 1
  done
}

start() {
  ensure_devshell pi "$@"
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
  *)      start "$@" ;;
esac
