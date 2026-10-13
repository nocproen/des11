#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$ROOT"

PORT="${PORT:-3000}"
BIND_HOST="${BIND_HOST:-0.0.0.0}"
if ! [[ "$PORT" =~ ^[0-9]{1,5}$ ]]; then
  echo "Invalid PORT '$PORT'; expected an integer between 1 and 65535." >&2
  exit 64
fi
PORT_NUMBER=$((10#$PORT))
if (( PORT_NUMBER < 1 || PORT_NUMBER > 65535 )); then
  echo "Invalid PORT '$PORT'; expected an integer between 1 and 65535." >&2
  exit 64
fi
PORT="$PORT_NUMBER"

listeners="$(ss -H -ltnp "sport = :${PORT}" 2>/dev/null || true)"
if [[ -n "$listeners" ]]; then
  mapfile -t pids < <(printf '%s\n' "$listeners" | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u || true)
  if (( ${#pids[@]} == 0 )); then
    echo "Port ${PORT} is occupied, but its owner cannot be identified; refusing to stop it." >&2
    exit 1
  fi

  for pid in "${pids[@]}"; do
    [[ -d "/proc/${pid}" ]] || continue
    owner_root="$(readlink -f "/proc/${pid}/cwd" 2>/dev/null || true)"
    command_line="$(tr '\0' ' ' < "/proc/${pid}/cmdline" 2>/dev/null || true)"
    if [[ "$owner_root" != "$ROOT" || "$command_line" != *next* ]]; then
      echo "Port ${PORT} is occupied by unrelated PID ${pid}; refusing to kill it." >&2
      exit 1
    fi

    echo "Stopping stale Next.js process PID ${pid} on port ${PORT}."
    kill -TERM "$pid" 2>/dev/null || true
    for _ in {1..20}; do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.25
    done
    if kill -0 "$pid" 2>/dev/null; then
      echo "Process ${pid} did not exit gracefully; sending SIGKILL."
      kill -KILL "$pid" 2>/dev/null || true
    fi
  done
fi

for _ in {1..20}; do
  if ! ss -H -ltn "sport = :${PORT}" 2>/dev/null | grep -q .; then
    break
  fi
  sleep 0.25
done
if ss -H -ltn "sport = :${PORT}" 2>/dev/null | grep -q .; then
  echo "Port ${PORT} is still occupied; refusing to start a duplicate server." >&2
  exit 1
fi

echo "Starting Next.js on ${BIND_HOST}:${PORT}."
exec ./node_modules/.bin/next start --hostname "$BIND_HOST" --port "$PORT"
