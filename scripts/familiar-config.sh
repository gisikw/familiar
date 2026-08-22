#!/usr/bin/env bash
# Source this before defaults and before entering a Nix dev shell. Nix itself is
# the parser runtime, so no package from the dev shell is needed and recursion
# cannot bootstrap-loop. Values are length-framed and assigned without eval.

familiar_config_name_is_explicit() {
  case ":${_FAMILIAR_CONFIG_EXPLICIT_ENV:-}:" in
    *":$1:"*) return 0 ;;
    *) return 1 ;;
  esac
}

familiar_config_capture_explicit() {
  local name names=""
  # On the first entry, shell variables matching these names came from the
  # process environment. Preserve that set through nix-develop recursion;
  # values loaded from TOML may then be refreshed on every entry.
  while IFS= read -r name; do
    name=${name#declare -x }
    name=${name%%=*}
    case "$name" in
      FAMILIAR_*|PI_TELEMETRY|PI_OFFLINE|PI_SKIP_VERSION_CHECK|PI_CODING_AGENT_DIR|ANTHROPIC_BASE_URL|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|OPENAI_BASE_URL|OPENAI_API_KEY|LLAMA_BASE_URL)
        names="${names:+$names:}$name" ;;
    esac
  done < <(export -p)
  export _FAMILIAR_CONFIG_EXPLICIT_ENV="$names"
}

familiar_config_mark_loaded() {
  case ":${_FAMILIAR_CONFIG_LOADED_ENV:-}:" in
    *":$1:"*) ;;
    *) _FAMILIAR_CONFIG_LOADED_ENV="${_FAMILIAR_CONFIG_LOADED_ENV:+$_FAMILIAR_CONFIG_LOADED_ENV:}$1" ;;
  esac
  export _FAMILIAR_CONFIG_LOADED_ENV
}

familiar_config_clear_loaded() {
  local name old=${_FAMILIAR_CONFIG_LOADED_ENV:-}
  _FAMILIAR_CONFIG_LOADED_ENV=
  export _FAMILIAR_CONFIG_LOADED_ENV
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    # The first-entry provenance set is immutable across exec/devshell recursion.
    # Thus only values actually exported by an earlier loader pass are removed.
    familiar_config_name_is_explicit "$name" || unset "$name"
  done < <(printf '%s\n' "$old" | tr ':' '\n')
}

familiar_config_alias() {
  local target=$1 source=$2 value
  familiar_config_name_is_explicit "$target" && return 0
  if [[ -v $source ]]; then
    value=${!source}
    printf -v "$target" '%s' "$value"
    export "$target"
    familiar_config_mark_loaded "$target"
  fi
}

familiar_config_load() {
  local repo=$1
  local config=${FAMILIAR_CONFIG_PATH:-$repo/familiar.toml}
  local stream errors name length value mode

  if [[ ! -v _FAMILIAR_CONFIG_EXPLICIT_ENV ]]; then
    familiar_config_capture_explicit
  fi
  if [ ! -f "$config" ]; then
    familiar_config_clear_loaded
    return 0
  fi

  mode=$(stat -c '%a' "$config" 2>/dev/null || stat -f '%Lp' "$config" 2>/dev/null || true)
  if [ "$mode" != 600 ]; then
    printf 'familiar: %s must have mode 0600 (run: chmod 600 %q)\n' "$config" "$config" >&2
    return 1
  fi
  command -v nix >/dev/null 2>&1 || {
    echo 'familiar: loading familiar.toml requires Nix' >&2
    return 1
  }

  stream=$(mktemp "${TMPDIR:-/tmp}/familiar-config.XXXXXX") || return 1
  errors=$(mktemp "${TMPDIR:-/tmp}/familiar-config-errors.XXXXXX") || { rm -f "$stream"; return 1; }
  if ! FAMILIAR_CONFIG_PATH="$config" nix eval --impure --raw --file \
      "$repo/scripts/familiar-config.nix" >"$stream" 2>"$errors"; then
    if grep -q 'top-level key must live under a canonical table' "$errors"; then
      echo 'familiar: every key must live under a canonical table (e.g. [pi], [anthropic]); flat top-level keys are no longer supported. See familiar.toml.example.' >&2
    else
      echo 'familiar: could not parse familiar.toml (contents suppressed)' >&2
    fi
    rm -f "$stream" "$errors"
    return 1
  fi
  rm -f "$errors"

  # Parsing is transactional: retain the previous environment on failure, but
  # after success clear every non-ambient export from the prior pass before
  # applying this snapshot. This makes same-session key removal deterministic.
  familiar_config_clear_loaded
  while IFS= read -r name <&3 && IFS= read -r length <&3; do
    if [[ ! $name =~ ^FAMILIAR_[A-Z0-9_]+$ || ! $length =~ ^[0-9]+$ ]]; then
      rm -f "$stream"; echo 'familiar: invalid config parser output' >&2; return 1
    fi
    value=""
    if [ "$length" -gt 0 ]; then
      IFS= LC_ALL=C read -r -N "$length" value <&3 || {
        rm -f "$stream"; echo 'familiar: truncated config parser output' >&2; return 1;
      }
    fi
    if ! familiar_config_name_is_explicit "$name"; then
      printf -v "$name" '%s' "$value"
      export "$name"
      familiar_config_mark_loaded "$name"
    fi
  done 3<"$stream"
  rm -f "$stream"

  # Third-party processes retain their established variable names. Local TOML
  # remains generic: e.g. anthropic_api_key -> FAMILIAR_ANTHROPIC_API_KEY.
  familiar_config_alias PI_TELEMETRY FAMILIAR_PI_TELEMETRY
  familiar_config_alias PI_OFFLINE FAMILIAR_PI_OFFLINE
  familiar_config_alias PI_SKIP_VERSION_CHECK FAMILIAR_PI_SKIP_VERSION_CHECK
  familiar_config_alias PI_CODING_AGENT_DIR FAMILIAR_PI_CODING_AGENT_DIR
  familiar_config_alias ANTHROPIC_BASE_URL FAMILIAR_ANTHROPIC_BASE_URL
  familiar_config_alias ANTHROPIC_API_KEY FAMILIAR_ANTHROPIC_API_KEY
  familiar_config_alias ANTHROPIC_AUTH_TOKEN FAMILIAR_ANTHROPIC_AUTH_TOKEN
  familiar_config_alias OPENAI_BASE_URL FAMILIAR_OPENAI_BASE_URL
  familiar_config_alias OPENAI_API_KEY FAMILIAR_OPENAI_API_KEY
  familiar_config_alias LLAMA_BASE_URL FAMILIAR_LLAMA_BASE_URL
}
