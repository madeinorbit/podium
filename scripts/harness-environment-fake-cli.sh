#!/bin/sh
name=${0##*/}
case "${1:-}" in
  --version)
    printf '%s 1.0.0\n' "$name"
    ;;
  --help)
    if [ "$name" = agent ]; then
      printf 'Cursor Agent command line\n'
    else
      printf '%s help\n' "$name"
    fi
    ;;
  --podium-probe)
    printf '%s:%s\n' "$name" "$PATH"
    ;;
  *)
    printf '%s\n' "$name"
    ;;
esac
