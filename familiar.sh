#!/usr/bin/env bash
set -euo pipefail

TMUX_SERVER=familiar
TMUX_SESSION=familiar
SELF="$(realpath "$0")"
REPO="$(dirname $SELF)"

MODEL_DIR="${FAMILIAR_MODEL_DIR:-$REPO/models}"
MODEL_FILE="gemma-4-E4B-it-Q4_K_M.gguf"
MODEL_URL="https://huggingface.co/unsloth/gemma-4-E4B-it-GGUF/resolve/main/$MODEL_FILE"

ensure_devshell() {
  local shell=$1; shift
  if [ "${FAMILIAR_SHELL:-}" != "$shell" ]; then
    exec nix develop ".#$shell" -c "$SELF" "$@"; 
  fi
}

start() {
  ensure_devshell pi "$@"
  tmux -L "$TMUX_SERVER" new-session -d -s "$TMUX_SESSION" -n pi ./familiar.sh pi
  tmux -L "$TMUX_SERVER" set-option -g remain-on-exit on

  if [ -z "${LLAMA_BASE_URL:-}" ]; then
    tmux -L "$TMUX_SERVER" new-window -d -t "$TMUX_SESSION" -n llama ./familiar.sh llama
  fi

  if [ -z "${FAMILIAR_STT_URL:-}" ]; then
    tmux -L "$TMUX_SERVER" new-window -d -t "$TMUX_SESSION" -n stt ./familiar.sh stt
  fi

  exec tmux -L "$TMUX_SERVER" attach-session -t "$TMUX_SESSION"
}

run_pi() {
  ensure_devshell pi "$@"
  while true; do pi; sleep 1; done
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
      --port 8080 \
      -ngl 999 \
      -m "$MODEL_DIR/$MODEL_FILE" \
      -c 32768;
    sleep 1;
  done
}

run_stt() {
  ensure_devshell stt "$@"
  # while true; do parakeet-serve; sleep 1; done
}

case ${1:-} in
  pi)     run_pi "$@" ;;
  llama)  run_llama "$@" ;;
  stt)    run_stt "$@" ;;
  *)      start "$@" ;;
esac
