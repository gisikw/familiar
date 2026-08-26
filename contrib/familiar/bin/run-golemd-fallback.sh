#!/usr/bin/env bash
set -euo pipefail
if [[ -z "${GOLEM_REPO_PATH:-}" ]]; then
  echo "golemd fallback disabled (set plugins.golem.env.GOLEM_REPO_PATH to enable)" >&2
  exec sleep infinity
fi
if [[ -z "${GOLEM_CONFIG:-}" ]]; then
  echo "golemd fallback requires GOLEM_CONFIG" >&2
  exit 2
fi
args=(--config "$GOLEM_CONFIG")
[[ -n "${GOLEM_STATE:-}" ]] && args+=(--state "$GOLEM_STATE")
[[ -n "${GOLEM_LISTEN:-}" ]] && args+=(--listen "$GOLEM_LISTEN")
exec nix run "${GOLEM_REPO_PATH}#golemd" -- "${args[@]}"
