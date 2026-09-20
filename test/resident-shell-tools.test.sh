#!/usr/bin/env bash
# Declarative resident/development CLI inventory. Language runtimes are
# intentionally not part of this focused set.
set -euo pipefail

for tool in herdr imp jq rg fd; do
  command -v "$tool" >/dev/null || {
    echo "missing resident shell tool: $tool" >&2
    exit 1
  }
done

herdr --version | grep -Eq '(^|[^0-9])0\.9\.1([^0-9]|$)'
imp --help | grep -q '^Usage: imp '
jq --version >/dev/null
rg --version >/dev/null
fd --version >/dev/null

echo "resident shell tools ok: herdr 0.9.1, imp, jq, rg, fd"
