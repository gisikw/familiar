#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: ./familiar.sh <command> [arguments]

Commands:
  --config PATH   Use an external private-instance familiar.toml.
  init PATH       Scaffold a private familiar instance.
  server          Run the complete Familiar service stack.
  connect         Ensure Presence and open the native viewer (first run builds it).
  client          Run the Electron desktop client.
  pi              Run the resident pi agent with continuity.
  llama           Run the local LLM backend.
  stt             Run the local speech-to-text backend.
  tts             Run the local text-to-speech backend.
  kill            Stop the private Presence runtime.
  ssh HOST [...]  Open SSH with Familiar image-drop transport.
  drop-serve PATH Run the image-drop socket server (transport helper).
  drop-fetch PATH Fetch a file from a connected client.
  worklist-add    Add an item to the durable worklist.
  inbox-enqueue   Compatibility alias for worklist-add.
  config-check    Validate familiar.toml.
  test [--all]    Run e2e tests, or every suite with --all.
  help            Print this usage.
EOF
}

# Help must be available even when optional configuration is invalid, and a
# bare invocation must never recurse into a dev shell or start services.
if [ "${1:-}" = "--config" ]; then
  [ $# -ge 2 ] || { echo 'familiar: --config requires a path' >&2; exit 2; }
  export FAMILIAR_CONFIG_PATH="$2"
  shift 2
fi
case ${1:-} in
  ""|-h|--help|help) usage; exit 0 ;;
esac

SELF="$(realpath "$0" 2>/dev/null || { cd "$(dirname "$0")" && printf '%s/%s' "$(pwd -P)" "$(basename "$0")"; })"
REPO="$(dirname "$SELF")"
if [ -n "${FAMILIAR_CONFIG_PATH:-}" ] && [[ "$FAMILIAR_CONFIG_PATH" != /* ]]; then
  FAMILIAR_CONFIG_PATH="$(cd "$(dirname "$FAMILIAR_CONFIG_PATH")" && pwd -P)/$(basename "$FAMILIAR_CONFIG_PATH")"
  export FAMILIAR_CONFIG_PATH
fi
CONFIG_DIR="$REPO"
[ -n "${FAMILIAR_CONFIG_PATH:-}" ] && CONFIG_DIR="$(dirname "$FAMILIAR_CONFIG_PATH")"
STATE_DIR="$REPO/state"
[ "$CONFIG_DIR" = "$REPO" ] || STATE_DIR="$CONFIG_DIR/state"
resolve_config_path() { case "$1" in /*) printf '%s' "$1";; *) printf '%s/%s' "$CONFIG_DIR" "$1";; esac; }

# Local configuration must load before defaults and before dev-shell recursion:
# file values beat defaults, while the ambient variables captured by the loader
# beat file values. The exported provenance marker keeps that ordering stable
# when nix develop re-enters this script.
# shellcheck source=scripts/familiar-config.sh
. "$REPO/scripts/familiar-config.sh"
CONFIG_LOAD_FAILED=0
if ! familiar_config_load "$REPO"; then
  CONFIG_LOAD_FAILED=1
  case "${1:-}" in
    kill|worklist-add|inbox-enqueue|config-check)
      echo "familiar: continuing '${1:-}' without optional familiar.toml; fix it and run: $SELF config-check" >&2
      ;;
    *)
      echo "familiar: startup refused; fix optional familiar.toml or move it aside, then retry" >&2
      exit 1
      ;;
  esac
fi

# Defaults (lowest precedence)
if [ -n "${FAMILIAR_IDENTITY_PATH:-}" ]; then export FAMILIAR_IDENTITY_PATH="$(resolve_config_path "$FAMILIAR_IDENTITY_PATH")"; fi
export FAMILIAR_HANDOFF_PATH="${FAMILIAR_HANDOFF_PATH:-$STATE_DIR/handoffs}"
export FAMILIAR_HANDOFF_PATH="$(resolve_config_path "$FAMILIAR_HANDOFF_PATH")"
if [ -n "${FAMILIAR_HANDOFF_PROMPT_PATH:-}" ]; then export FAMILIAR_HANDOFF_PROMPT_PATH="$(resolve_config_path "$FAMILIAR_HANDOFF_PROMPT_PATH")"; fi
# Worklist durable queue. FAMILIAR_WORKLIST_DIR is canonical; FAMILIAR_INBOX_DIR
# is a bounded compatibility alias (one release) so a mid-flight external writer
# does not silently drop items.
export FAMILIAR_WORKLIST_DIR="${FAMILIAR_WORKLIST_DIR:-${FAMILIAR_INBOX_DIR:-$STATE_DIR/worklist}}"
export FAMILIAR_WORKLIST_DIR="$(resolve_config_path "$FAMILIAR_WORKLIST_DIR")"
if [ -n "${FAMILIAR_INBOX_DIR:-}" ]; then export FAMILIAR_INBOX_DIR="$(resolve_config_path "$FAMILIAR_INBOX_DIR")"; fi
export FAMILIAR_LOG_PATH="${FAMILIAR_LOG_PATH:-$STATE_DIR/log.jsonl}"
export FAMILIAR_LOG_PATH="$(resolve_config_path "$FAMILIAR_LOG_PATH")"
export FAMILIAR_SUBSCRIBER_PORT="${FAMILIAR_SUBSCRIBER_PORT:-1692}"
export FAMILIAR_PRESENCE_STATE_DIR="${FAMILIAR_PRESENCE_STATE_DIR:-$STATE_DIR/presence}"
export FAMILIAR_PRESENCE_STATE_DIR="$(resolve_config_path "$FAMILIAR_PRESENCE_STATE_DIR")"
export FAMILIAR_PRESENCE_SOCKET="${FAMILIAR_PRESENCE_SOCKET:-$FAMILIAR_PRESENCE_STATE_DIR/tmux.sock}"
export FAMILIAR_PRESENCE_SOCKET="$(resolve_config_path "$FAMILIAR_PRESENCE_SOCKET")"
export FAMILIAR_PRESENCE_CTL="${FAMILIAR_PRESENCE_CTL:-$REPO/services/presence/presence.sh}"
# Session storage. Overriding this is the deliberate escape hatch for a wedged
# session: point it at a clean-room dir to bail out without touching the main
# continuity line. Not a first-class verb on purpose — forking continuity
# should have friction.
export PI_CODING_AGENT_DIR="${PI_CODING_AGENT_DIR:-$STATE_DIR/pi}"
export PI_CODING_AGENT_DIR="$(resolve_config_path "$PI_CODING_AGENT_DIR")"
for _familiar_path_var in FAMILIAR_TTS_VOICES_SOURCE FAMILIAR_ARTIFACT_DIR FAMILIAR_SUBAGENT_DIR FAMILIAR_SUBAGENT_SESSION_DIR; do
  if [ -n "${!_familiar_path_var:-}" ]; then
    printf -v "$_familiar_path_var" '%s' "$(resolve_config_path "${!_familiar_path_var}")"
    export "$_familiar_path_var"
  fi
done

export FAMILIAR_MODEL_DIR="${FAMILIAR_MODEL_DIR:-$REPO/models}"
export FAMILIAR_MODEL_DIR="$(resolve_config_path "$FAMILIAR_MODEL_DIR")"
MODEL_DIR="$FAMILIAR_MODEL_DIR"

prepare_tmux_theme() {
  local theme_dir="$STATE_DIR/theme"
  install -d -m 700 "$theme_dir"
  export FAMILIAR_TMUX_THEME_CONFIG="$theme_dir/tmux.conf"
  bash "$REPO/scripts/familiar-theme.sh" tmux > "$FAMILIAR_TMUX_THEME_CONFIG"
  chmod 600 "$FAMILIAR_TMUX_THEME_CONFIG"
}

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
  # Custom voices are ordinary <name>.pt files under the private instance's
  # voices tree, staged to state/voices/kokoro, then baked into a local copy
  # of the Kokoro gguf.
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
  local voices_src="${FAMILIAR_TTS_VOICES_SOURCE:-${FAMILIAR_IDENTITY_PATH:+$FAMILIAR_IDENTITY_PATH/voices/kokoro}}"
  [ -n "$voices_src" ] && voices_src="$(resolve_config_path "$voices_src")"
  local voices_dir="$STATE_DIR/voices/kokoro"
  local packs=() rebake="" f name pt
  if [ -d "$voices_src" ]; then
    for f in "$voices_src"/*.pt; do
      [ -e "$f" ] || continue
      name="$(basename "$f")"; name="${name%.pt}"
      pt="$voices_dir/$name.pt"
      mkdir -p "$voices_dir"
      if [ ! -f "$pt" ] || [ "$f" -nt "$pt" ]; then
        cp "$f" "$pt"
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

prepare_plugin() {
  [ -z "${FAMILIAR_PLUGIN_ROOT:-}" ] || return 0
  local path=${FAMILIAR_PLUGINS_GOLEM_PATH:-} git=${FAMILIAR_PLUGINS_GOLEM_GIT:-} rev=${FAMILIAR_PLUGINS_GOLEM_REV:-}
  if [ -z "$path$git$rev" ]; then return 0; fi
  if [ -n "$path" ] && { [ -n "$git" ] || [ -n "$rev" ]; }; then echo 'familiar: plugins.golem path and git/rev are mutually exclusive' >&2; return 1; fi
  if [ -n "$git" ] && [[ ! $rev =~ ^[0-9a-fA-F]{40}$ ]]; then echo 'familiar: plugins.golem git requires an exact 40-character rev' >&2; return 1; fi
  if [ -n "$rev" ] && [ -z "$git" ]; then echo 'familiar: plugins.golem rev requires git' >&2; return 1; fi
  if [ -n "$path" ]; then
    case "$path" in /*) ;; *) path="$(resolve_config_path "$path")" ;; esac
    [ -d "$path" ] || { echo "familiar: plugin path is not a directory: $path" >&2; return 1; }
  else
    path="$STATE_DIR/plugins/golem/src"
    install -d -m 700 "$(dirname "$path")"
    [ ! -L "$path" ] || { echo 'familiar: refusing symlinked Git plugin cache' >&2; return 1; }
    if [ ! -d "$path/.git" ]; then git init -q "$path"; fi
    if [ "$(git -C "$path" remote get-url origin 2>/dev/null || true)" != "$git" ]; then
      git -C "$path" remote remove origin 2>/dev/null || true
      git -C "$path" remote add origin -- "$git" || { echo 'familiar: could not configure plugin origin' >&2; return 1; }
    fi
    [ "$(git -C "$path" remote get-url origin)" = "$git" ] || { echo 'familiar: plugin origin mismatch' >&2; return 1; }
    git -C "$path" fetch -q --force --no-tags origin "$rev" || { echo 'familiar: could not fetch exact plugins.golem rev' >&2; return 1; }
    git -C "$path" checkout -q --detach FETCH_HEAD || return 1
    git -C "$path" reset -q --hard "$rev" || return 1
    git -C "$path" clean -q -ffdqx || return 1
    local link target root_real
    root_real=$(realpath -e "$path") || return 1
    while IFS= read -r -d '' link; do
      target=$(realpath -e "$link") || { echo 'familiar: broken plugin symlink' >&2; return 1; }
      case "$target" in "$root_real"/*) ;; *) echo 'familiar: plugin symlink escapes cache root' >&2; return 1 ;; esac
    done < <(find "$path" -type l -print0)
    local actual; actual=$(git -C "$path" rev-parse --verify HEAD)
    [ "${actual,,}" = "${rev,,}" ] || { echo "familiar: plugin SHA mismatch (wanted $rev, got $actual)" >&2; return 1; }
  fi
  [ -f "$path/contrib/familiar/plugin.toml" ] && [ "$(realpath -e "$path/contrib/familiar/plugin.toml" 2>/dev/null)" = "$(realpath -e "$path")/contrib/familiar/plugin.toml" ] || { echo 'familiar: plugin lacks a safe contrib/familiar/plugin.toml' >&2; return 1; }
  export FAMILIAR_PLUGIN_ROOT="$path" FAMILIAR_PLUGIN_ID=golem
  local api
  api=$(FAMILIAR_PLUGIN_MANIFEST="$path/contrib/familiar/plugin.toml" nix eval --impure --raw --expr 'toString (builtins.fromTOML (builtins.readFile (builtins.getEnv "FAMILIAR_PLUGIN_MANIFEST"))).familiar_api') || return 1
  [ "$api" = 1 ] || { echo "familiar: plugin requires familiar_api = 1 (got $api)" >&2; return 1; }
  local name value entry prefix=FAMILIAR_PLUGINS_GOLEM_ENV_
  while IFS= read -r entry; do
    name=${entry%%=*}; value=${entry#*=}
    case "$name" in "$prefix"*) export "FAMILIAR_PLUGIN_ENV_${name#$prefix}=$value" ;; esac
  done < <(env)
  local server_listen=${FAMILIAR_SERVER_LISTEN:-127.0.0.1:9940}
  # The viewer consumes only the generic host-owned aggregate render endpoint.
  # No plugin-specific path leaks into the viewer contract.
  export FAMILIAR_RENDER_URL="http://127.0.0.1:${server_listen##*:}/v1/render"
}

plugin_extensions_json() {
  if [ -z "${FAMILIAR_PLUGIN_ROOT:-}" ]; then printf '[]'; return; fi
  FAMILIAR_PLUGIN_MANIFEST="$FAMILIAR_PLUGIN_ROOT/contrib/familiar/plugin.toml" FAMILIAR_PLUGIN_ROOT="$FAMILIAR_PLUGIN_ROOT" nix eval --impure --json --expr '
    let m=builtins.fromTOML (builtins.readFile (builtins.getEnv "FAMILIAR_PLUGIN_MANIFEST")); root=builtins.getEnv "FAMILIAR_PLUGIN_ROOT";
    in map (x: builtins.replaceStrings ["\${plugin_root}"] [root] x) (m.pi.extensions or [])'
}

run_pi() {
  prepare_plugin
  ensure_devshell pi "$@"
  mkdir -p "$PI_CODING_AGENT_DIR"
  # A remote/dynamic provider (for example Tiamat) need not configure the
  # optional local llama.cpp backend. Keep both expansions safe under `set -u`
  # and omit the synthetic llama.cpp cache entry when either value is absent.
  local llama_url="${LLAMA_BASE_URL:-}"
  local llama_model_file="${FAMILIAR_MODEL_FILE:-}"
  local llama_model="${llama_model_file%.*}"
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
    # handoff/index.ts triggers at 90% of the active model's real window. Pi's fixed
    # reserve is the emergency floor for small-window models and overflows.
    plugin_exts=$(plugin_extensions_json)
    jq -n --argjson prev "$prev" --argjson pluginExts "$plugin_exts" \
      --arg provider "${FAMILIAR_DEFAULT_PROVIDER:-llama.cpp}" \
      --arg model "${FAMILIAR_DEFAULT_MODEL:-$llama_model}" \
      --arg dir "$PI_CODING_AGENT_DIR" \
      --arg ext "$REPO/integrations/pi/extensions" '
      $prev + {
        lastChangelogVersion: "0.84.1",
        theme: "familiar",
        themes: [ ($dir + "/themes") ],
        compaction: { enabled: true, reserveTokens: 4096 },
        # Keep the live extension set explicit.
        extensions: (([
          "handoff", "identity", "subscriber", "telemetry",
          "tiamat", "timegap", "web", "worklist", "zip"
        ] | map($ext + "/" + .)) + $pluginExts | unique)
      }
      | .defaultProvider //= $provider
      | .defaultModel //= $model
    ' > "$PI_CODING_AGENT_DIR/settings.json"
    jq -n --arg url "$llama_url" --arg model "$llama_model" '
      if ($url | length) == 0 or ($model | length) == 0 then {}
      else {
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
      } end
    ' > "$PI_CODING_AGENT_DIR/models-store.json"
    # --continue resumes the most recent session (falls through to a fresh one
    # when none exists — verified in SessionManager.continueRecent). Bounces
    # and crash respawns keep continuity; /clear stays the only way to end a
    # session, and it writes a handoff first.
    #
    # `|| true` is load-bearing under `set -e`: a bare command as the loop body
    # aborts the whole function on any non-zero exit, leaving a dead pane with
    # no supervisor instead of respawning pi.
    command pi \
      --continue \
      --no-context-files \
      --no-skills \
      --skill "$REPO/skills/" || true
    sleep 1
  done
}

# --- image drop transport ----------------------------------------------------
#
# Dragging a file onto a terminal types its *path* into the tty. Over ssh that
# path names a file on the machine holding the mouse, not the one running the
# agent, so the bytes never cross. These verbs carry them: `ssh` opens a session
# with a reverse socket wired back to a small file server, `drop-serve`
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
#
# The exchange runs in the background deliberately. Bash defers a TERM trap
# while it waits for a foreground pipeline, so an idle listener used to make
# the parent immortal: the trap could not run until nc exited, but nc would not
# exit until another client connected. Keep both pipeline PIDs so cleanup kills
# only our children and reaps them before releasing inherited output FDs.
DROP_SERVE_NC_PID=""
DROP_SERVE_HANDLER_PID=""
DROP_SERVE_HANDLER_PID_FILE=""
DROP_SERVE_SOCK=""
DROP_SERVE_FIFO=""

drop_serve_stop_exchange() {
  local pid
  if [ -n "$DROP_SERVE_HANDLER_PID_FILE" ] && [ -r "$DROP_SERVE_HANDLER_PID_FILE" ]; then
    IFS= read -r pid < "$DROP_SERVE_HANDLER_PID_FILE" || pid=""
    case $pid in ''|*[!0-9]*) ;; *) DROP_SERVE_HANDLER_PID=$pid ;; esac
  fi
  [ -z "$DROP_SERVE_NC_PID" ] || kill "$DROP_SERVE_NC_PID" 2>/dev/null || true
  [ -z "$DROP_SERVE_HANDLER_PID" ] || kill "$DROP_SERVE_HANDLER_PID" 2>/dev/null || true
  [ -z "$DROP_SERVE_NC_PID" ] || wait "$DROP_SERVE_NC_PID" 2>/dev/null || true
  [ -z "$DROP_SERVE_HANDLER_PID" ] || wait "$DROP_SERVE_HANDLER_PID" 2>/dev/null || true
  DROP_SERVE_NC_PID=""
  DROP_SERVE_HANDLER_PID=""
  [ -z "$DROP_SERVE_HANDLER_PID_FILE" ] || rm -f "$DROP_SERVE_HANDLER_PID_FILE"
}

drop_serve_cleanup() {
  trap - EXIT INT TERM
  drop_serve_stop_exchange
  rm -f "$DROP_SERVE_SOCK" "$DROP_SERVE_FIFO" "$DROP_SERVE_HANDLER_PID_FILE"
}

drop_serve_signal() {
  local status=$1
  trap - INT TERM
  exit "$status"
}

drop_serve() {
  local sock=${2:-} fifo nc_flags fails=0 status
  if [ -z "$sock" ]; then
    echo "Usage: familiar.sh drop-serve <socket-path>" >&2
    return 1
  fi
  command -v nc >/dev/null 2>&1 || { echo "drop-serve requires nc" >&2; return 1; }
  command -v base64 >/dev/null 2>&1 || { echo "drop-serve requires base64" >&2; return 1; }

  nc_flags=$(drop_server_nc_flags)
  mkdir -p "$(dirname "$sock")"
  fifo="$sock.fifo"
  DROP_SERVE_SOCK=$sock
  DROP_SERVE_FIFO=$fifo
  DROP_SERVE_HANDLER_PID_FILE="$fifo.handler-pid"
  rm -f "$sock" "$fifo" "$DROP_SERVE_HANDLER_PID_FILE"
  mkfifo "$fifo" || return 1
  trap drop_serve_cleanup EXIT
  trap 'drop_serve_signal 130' INT
  trap 'drop_serve_signal 143' TERM

  while :; do
    rm -f "$sock" "$DROP_SERVE_HANDLER_PID_FILE"
    # $$ retains the top-level PID in a subshell, and BASHPID needs Bash 4.
    # Asking a tiny child for its PPID identifies this pipeline subshell on the
    # stock macOS Bash 3.2 too. Publish it before opening the fifo so the parent
    # can terminate both sides even when no client has ever connected.
    {
      handler_pid=$(exec sh -c 'printf %s "$PPID"')
      printf '%s\n' "$handler_pid" > "$DROP_SERVE_HANDLER_PID_FILE"
      drop_handle < "$fifo"
    } | nc $nc_flags "$sock" > "$fifo" &
    DROP_SERVE_NC_PID=$!
    status=0
    wait "$DROP_SERVE_NC_PID" || status=$?
    drop_serve_stop_exchange
    if [ "$status" -eq 0 ]; then
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
ssh_connect() {
  shift 2>/dev/null || true
  local target=${1:-} client_id local_sock remote_dir daemon status waited
  if [ -z "$target" ]; then
    echo "Usage: ./familiar.sh ssh <[user@]host> [command...]" >&2
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
  # EXIT owns cleanup; signal traps exit explicitly so an interrupted ssh cannot
  # resume the function and leave the server (and its inherited output FDs)
  # behind. Waiting also prevents a zombie in long-running caller shells.
  trap 'kill "$daemon" 2>/dev/null || true; wait "$daemon" 2>/dev/null || true; rm -f "$local_sock" "$local_sock.fifo" "$local_sock.fifo.handler-pid"' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM

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

# The Electron terminal app under apps/desktop/. Runs in the `client` devShell so the
# Node version lives only in flake.nix. npm install runs only when node_modules
# is missing or package-lock.json is newer than it (cheap staleness check), so a
# normal launch skips it. bash 3.2 compatible: no associative arrays, and the
# staleness test is a plain `-nt`.
viewer_connect() {
  # Plugin preparation exports the generic FAMILIAR_RENDER_URL so an external
  # `connect` gets host chrome without any manual plugin-specific URL.
  prepare_plugin
  ensure_devshell connect "$@"
  local executable="${FAMILIAR_VIEWER_BIN:-}"
  if [ -z "$executable" ] && command -v nix >/dev/null 2>&1; then
    local output
    if output=$(cd "$REPO" && nix build .#familiar-viewer --print-out-paths --no-link); then
      executable="${output##*$'\n'}/bin/familiar-viewer"
    fi
  fi
  if [ -z "$executable" ]; then
    executable=$(command -v familiar-viewer 2>/dev/null || true)
  fi
  if [ -z "$executable" ]; then
    echo "familiar: could not build or find familiar-viewer on PATH" >&2
    return 1
  fi
  export FAMILIAR_VIEWER_BIN="$executable"
  exec "$FAMILIAR_PRESENCE_CTL" viewer
}

client() {
  ensure_devshell client "$@"
  local dir="$REPO/apps/desktop"
  cd "$dir" || { echo "no client dir at $dir" >&2; return 1; }
  if [ ! -d node_modules ] || [ package-lock.json -nt node_modules ]; then
    npm install || return 1
  fi
  npm start
}

provision_server_model() {
  local label=$1 file=$2 url=$3
  if [ -z "$file" ] || [ -z "$url" ]; then
    echo "familiar: local $label requires a model file and URL" >&2
    return 1
  fi
  [ -f "$MODEL_DIR/$file" ] && return 0
  mkdir -p "$MODEL_DIR"
  echo "familiar: provisioning $label model" >&2
  curl -fL --retry 5 -C - -o "$MODEL_DIR/$file.part" "$url" \
    && mv "$MODEL_DIR/$file.part" "$MODEL_DIR/$file"
}

server_local_url() {
  case "$1" in
    "http://localhost:$2"|"http://localhost:$2/"|"http://127.0.0.1:$2"|"http://127.0.0.1:$2/"|"http://[::1]:$2"|"http://[::1]:$2/") return 0 ;;
    *) return 1 ;;
  esac
}

server() {
  shift || true
  prepare_plugin
  local canonical="$REPO/services/server/familiar-server.toml.example"
  local config="${FAMILIAR_SERVER_CONFIG:-$canonical}"
  if [ "$config" = "$canonical" ] && [ "$(uname -s)" != Linux ]; then
    echo "familiar: the canonical five-child server deployment is Linux-only (set FAMILIAR_SERVER_CONFIG for a platform-specific deployment)" >&2
    return 2
  fi

  # The pi shell supplies pinned model defaults and download tooling. Re-entry
  # retains familiar.toml/ambient overrides loaded above.
  ensure_devshell pi server "$@"
  prepare_tmux_theme
  export FAMILIAR_MODEL_DIR="$MODEL_DIR"

  # User-facing endpoint settings describe backends. Children always consume
  # the stable local proxies, so bridge configured endpoints into proxy-specific
  # upstream variables before replacing the public URLs.
  if [ -z "${FAMILIAR_LLM_UPSTREAM:-}" ] && [ -n "${LLAMA_BASE_URL:-}" ] && ! server_local_url "$LLAMA_BASE_URL" 9931; then
    export FAMILIAR_LLM_UPSTREAM="$LLAMA_BASE_URL"
  fi
  if [ -z "${STT_UPSTREAM_URL:-}" ] && [ -n "${FAMILIAR_STT_URL:-}" ] && ! server_local_url "$FAMILIAR_STT_URL" 9932; then
    export STT_UPSTREAM_URL="$FAMILIAR_STT_URL"
  fi
  if [ -z "${FAMILIAR_TTS_UPSTREAM:-}" ] && [ -n "${FAMILIAR_TTS_URL:-}" ] && ! server_local_url "$FAMILIAR_TTS_URL" 9933; then
    export FAMILIAR_TTS_UPSTREAM="$FAMILIAR_TTS_URL"
  fi

  if [ -z "${FAMILIAR_LLM_UPSTREAM:-}" ]; then
    provision_server_model llm "${FAMILIAR_MODEL_FILE:-}" "${FAMILIAR_MODEL_URL:-}"
  fi
  if [ -z "${STT_UPSTREAM_URL:-}" ]; then
    provision_server_model stt "${FAMILIAR_STT_MODEL_FILE:-}" "${FAMILIAR_STT_MODEL_URL:-}"
    export STT_MODEL="$MODEL_DIR/$FAMILIAR_STT_MODEL_FILE"
  fi

  export LLAMA_BASE_URL="http://127.0.0.1:9931" NEED_LLAMA=1
  export FAMILIAR_STT_URL="http://127.0.0.1:9932"
  export FAMILIAR_TTS_URL="http://127.0.0.1:9933"
  exec nix run "$REPO#familiar-server" -- --config "$config" "$@"
}

stop() {
  ensure_devshell pi "$@"
  "$FAMILIAR_PRESENCE_CTL" stop || true
}

# Out-of-process enqueue (protocol path b): write an atomic envelope into the
# worklist drop-box. The worklist extension drains state/worklist/incoming/ on
# its timer and promotes each envelope into a queue item. This is a marker-file
# pattern: no daemon or socket, just a file the resident process picks up.
# Envelope schema is documented in integrations/pi/extensions/worklist/PROTOCOL.md.
#   familiar.sh worklist-add --summary "..." [--priority N] [--type notify|question|review]
#                            [--body TEXT | --body-file F] [--source S] [--deadline EPOCH_MS]
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
      *) echo "worklist-add: unknown arg $1" >&2; return 2 ;;
    esac
  done
  if [ -z "$summary" ]; then
    echo "worklist-add: --summary is required" >&2; return 2
  fi
  [ -z "$body" ] && body="$summary"
  local incoming="$FAMILIAR_WORKLIST_DIR/incoming"
  # Settlement/reminder bodies may be sensitive. Tighten existing owned paths
  # as well as creating new ones; do not rely on the caller's umask.
  install -d -m 700 "$FAMILIAR_WORKLIST_DIR" "$incoming"
  chmod 700 "$FAMILIAR_WORKLIST_DIR" "$incoming"
  local id file tmp
  id="cli-$(date +%Y%m%d-%H%M%S)-$RANDOM"
  file="$incoming/$id.json"
  # mktemp requires trailing Xs on BSD/macOS as well as GNU implementations.
  tmp="$(umask 077; mktemp "$incoming/.${id}.tmp.XXXXXX")" || return 1
  if ! (umask 077; jq -n \
    --argjson priority "$priority" \
    --arg type "$type" \
    --arg summary "$summary" \
    --arg body "$body" \
    --arg source "$source" \
    --arg deadline "$deadline" \
    '{priority: $priority, type: $type, summary: $summary, body: $body, source: $source}
     + (if $deadline == "" then {} else {suggested_deadline: ($deadline|tonumber)} end)' \
    > "$tmp"); then
    rm -f "$tmp"
    return 1
  fi
  chmod 600 "$tmp"
  mv -f "$tmp" "$file"   # atomic: the extension only ever sees a whole file
  chmod 600 "$file"
  echo "$id"
}

run_tests() {
  shift || true
  if [ $# -eq 0 ]; then
    exec nix develop "$REPO#e2e" -c "$REPO/test/e2e/run.sh"
  fi
  if [ "$1" != --all ] || [ $# -ne 1 ]; then
    echo 'usage: ./familiar.sh test [--all]' >&2
    return 2
  fi

  local failed=() name
  run_suite() {
    name=$1; shift
    printf '\n========== %s ==========' "$name"
    printf '\n'
    if "$@"; then
      printf '%s: PASS\n' "$name"
    else
      failed+=("$name")
      printf '%s: FAIL\n' "$name"
    fi
  }

  run_suite viewer nix shell nixpkgs#zig_0_15 -c cargo test \
    --manifest-path "$REPO/services/viewer/Cargo.toml" --all-targets
  run_suite gateway bash -c 'cd "$1" && exec nix shell nixpkgs#bun -c bun test' _ \
    "$REPO/services/gateway"
  run_suite presence bash "$REPO/services/presence/test.sh"
  run_suite e2e nix develop "$REPO#e2e" -c "$REPO/test/e2e/run.sh"

  printf '\n========== SUMMARY ==========\n'
  if [ "${#failed[@]}" -eq 0 ]; then
    echo 'All suites passed: viewer gateway presence e2e'
    return 0
  fi
  printf 'Failed suites:'
  printf ' %s' "${failed[@]}"
  printf '\n'
  return 1
}

init_instance() {
  local target=${2:-}
  [ -n "$target" ] || { echo 'Usage: ./familiar.sh init PATH' >&2; return 2; }
  target="$(mkdir -p "$target" && cd "$target" && pwd -P)"
  [ -e "$target/familiar.toml" ] && { echo "familiar: refusing to overwrite $target/familiar.toml" >&2; return 1; }
  for entry in "$target"/* "$target"/.[!.]*; do
    [ -e "$entry" ] || continue
    case "$(basename "$entry")" in .git) continue ;; identity|voices|state|skills|extensions|.gitignore) continue ;; *)
      echo "familiar: refusing non-empty conflict at $entry" >&2; return 1 ;;
    esac
  done
  install -d -m 700 "$target/identity" "$target/voices" "$target/state" "$target/skills" "$target/extensions"
  (umask 077; cp "$REPO/familiar.toml.example" "$target/familiar.toml")
  chmod 600 "$target/familiar.toml"
  if [ ! -e "$target/.gitignore" ]; then
    cat > "$target/.gitignore" <<'EOF'
# Private instance policy: version configuration, identity, voices, and substantive memory.
# High-volume runtime output and generated/private workspace data.
state/log.jsonl*
state/age.key
state/pi/
state/pi/auth.json
state/presence/
state/subagents/
state/herdr/
state/inbox/
state/voices/
state/theme/
state/uploads/
state/*.sock
state/*.pid
state/*.tmp
models/

# Runtime credentials and payloads in otherwise substantive artifacts.
state/artifacts/**/auth.json
state/artifacts/**/credentials.json
state/artifacts/**/token.json
state/artifacts/**/secret.json
state/artifacts/**/key.json
state/artifacts/**/token
state/artifacts/**/secret
state/artifacts/**/credential
state/artifacts/**/key
state/artifacts/**/config-token-evidence.md
state/artifacts/**/config-token-review.md
state/artifacts/**/integration-key-lines.txt
state/artifacts/**/repair-integration-key-lines.txt

# Nested artifact worktrees and their git metadata are generated runtime state.
state/artifacts/**/.git/
state/artifacts/**/.git-worktree/
state/artifacts/**/worktree/
state/artifacts/**/*-worktree/
state/artifacts/**/*-review-tree/
state/artifacts/**/alpha-review-tree/
state/artifacts/**/integration-main/
state/artifacts/**/repair-review-tree/
state/artifacts/**/review-tree/
EOF
  fi
  git -C "$target" init >/dev/null 2>&1 || true
  echo "familiar: initialized private instance at $target"
}

config_check() {
  if [ "${2:-}" = --plugin ]; then
    [ "$CONFIG_LOAD_FAILED" -eq 0 ] || return 1
    prepare_plugin
    printf '%s\n' "plugin_root=${FAMILIAR_PLUGIN_ROOT:-}" "render_url=${FAMILIAR_RENDER_URL:-}"
    return 0
  fi
  if [ "${2:-}" = --paths ]; then
    [ "$CONFIG_LOAD_FAILED" -eq 0 ] || { echo 'familiar: familiar.toml validation failed (contents suppressed)' >&2; return 1; }
    printf '%s\n' "config_dir=$CONFIG_DIR" "identity=$FAMILIAR_IDENTITY_PATH" "handoff=$FAMILIAR_HANDOFF_PATH" "handoff_prompt=${FAMILIAR_HANDOFF_PROMPT_PATH:-}" "worklist=$FAMILIAR_WORKLIST_DIR" "inbox=${FAMILIAR_INBOX_DIR:-}" "log=$FAMILIAR_LOG_PATH" "voices=${FAMILIAR_TTS_VOICES_SOURCE:-}" "model=$FAMILIAR_MODEL_DIR" "artifact=${FAMILIAR_ARTIFACT_DIR:-}" "subagent=${FAMILIAR_SUBAGENT_DIR:-}" "sessions=${FAMILIAR_SUBAGENT_SESSION_DIR:-}" "pi=$PI_CODING_AGENT_DIR" "presence=$FAMILIAR_PRESENCE_STATE_DIR"
    return 0
  fi
  if [ "$CONFIG_LOAD_FAILED" -ne 0 ]; then
    echo 'familiar: familiar.toml validation failed (contents suppressed)' >&2
    return 1
  fi
  echo 'familiar: familiar.toml configuration is valid'
}

case ${1:-} in
  init)        init_instance "$@" ;;
  config-check) config_check "$@" ;;
  test)       run_tests "$@" ;;
  pi)         run_pi "$@" ;;
  llama)      run_llama "$@" ;;
  stt)        run_stt "$@" ;;
  tts)        run_tts "$@" ;;
  kill)          stop "$@" ;;
  worklist-add)  inbox_enqueue "$@" ;;
  inbox-enqueue) inbox_enqueue "$@" ;;  # bounded compat alias (one release)
  server)     server "$@" ;;
  client)     client "$@" ;;
  connect)    viewer_connect "$@" ;;
  ssh)        ssh_connect "$@" ;;
  drop-serve) drop_serve "$@" ;;
  drop-fetch) drop_fetch "$@" ;;
  *)          usage >&2; exit 2 ;;
esac
