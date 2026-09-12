#!/usr/bin/env bash
set -eu
if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' '{"permissionDecision":"deny","permissionDecisionReason":"TokenReducer requires Node.js 20+. Restore Node, then use the bulk-reader skill or agent."}'
  exit 0
fi
script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
exec node "$script_dir/read-gate.mjs"
