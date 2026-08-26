#!/usr/bin/env bash
# Shared environment guard for evidence rigs.
#
# Call this after setting PODIUM_INSTANCE. It records direct path overrides that
# were inherited from the session, removes them before any product command runs,
# and exposes the product-derived root under a rig-only name. The product never
# reads either PODIUM_RIG_STATE_ROOT or PODIUM_RIG_INHERITED_PATH_OVERRIDES.

PODIUM_RIG_INHERITED_PATH_OVERRIDES=""
for _path_var in PODIUM_STATE_DIR PODIUM_AGENT_HOME ABDUCO_SOCKET_DIR TMUX_TMPDIR; do
  _path_value="${!_path_var-}"
  if [ -n "$_path_value" ]; then
    PODIUM_RIG_INHERITED_PATH_OVERRIDES="${PODIUM_RIG_INHERITED_PATH_OVERRIDES:+$PODIUM_RIG_INHERITED_PATH_OVERRIDES;}${_path_var}=${_path_value}"
  fi
done
export PODIUM_RIG_INHERITED_PATH_OVERRIDES
unset ABDUCO_SOCKET_DIR TMUX_TMPDIR PODIUM_STATE_DIR PODIUM_AGENT_HOME

if [ "${PODIUM_INSTANCE:-}" = default ]; then
  PODIUM_RIG_STATE_ROOT="$HOME/.podium"
else
  PODIUM_RIG_STATE_ROOT="${XDG_STATE_HOME:-$HOME/.local/state}/podium/${PODIUM_INSTANCE:?PODIUM_INSTANCE must be set}"
fi
export PODIUM_RIG_STATE_ROOT

unset _path_var _path_value
