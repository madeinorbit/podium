#!/usr/bin/env bash

# Apple's ticket service can drop a connection after accepting notarization. Retry the
# service call without rebuilding the app; an exhausted retry still fails the release.
retry_apple_service() {
  local attempt=1 delay=15 status
  while true; do
    if "$@"; then
      return 0
    else
      status=$?
    fi
    if [ "$attempt" -eq 5 ]; then
      printf 'Apple service call failed after 5 attempts (exit %s).\n' "$status" >&2
      return "$status"
    fi
    printf 'Apple service call failed (attempt %s/5, exit %s); retrying in %ss.\n' \
      "$attempt" "$status" "$delay" >&2
    sleep "$delay"
    attempt=$((attempt + 1))
    delay=$((delay * 2))
  done
}
