# Shared start/stop for the p2843 halves. Sourced by drive-up.sh and
# drive-restart.sh so "restart the server" and "start the server" are the SAME
# code — a restart path that differs from the boot path is a rig that measures
# itself.
#
# The named-instance runtime derives the isolated agent home from its state
# root. Driver children receive that resolved home through the product, while
# this daemon keeps the real HOME so instanceStateDir() stays shared with the
# server.

p2843_agent_home() { echo "$PODIUM_RIG_STATE_ROOT/agent-home"; }

p2843_stop() { # name
  local name="$1" pidfile="$PODIUM_DRIVE_BASE/$1.pid" pid
  [ -f "$pidfile" ] || return 0
  pid="$(cat "$pidfile")"
  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    for _ in $(seq 1 40); do kill -0 "$pid" 2>/dev/null || break; sleep 0.25; done
    kill -9 "$pid" 2>/dev/null || true
    echo "stopped $name ($pid)"
  fi
  rm -f "$pidfile"
}

p2843_start() { # name
  local name="$1" script log
  log="$PODIUM_DRIVE_BASE/logs/$name.log"
  mkdir -p "$PODIUM_DRIVE_BASE/logs"
  case "$name" in
    server) script=scripts/server.ts ;;
    daemon) script=scripts/daemon.ts ;;
    *) echo "unknown half: $name" >&2; return 1 ;;
  esac
  # Appended, never truncated: a restart's evidence is the two boots either side
  # of it, and a fresh file would throw away the half that came before.
  (
    cd "$PODIUM_DRIVE_REPO"
    nohup bun --conditions=@podium/source "$script" >>"$log" 2>&1 &
    echo "$!" > "$PODIUM_DRIVE_BASE/$name.pid"
  )
  echo "started $name pid=$(cat "$PODIUM_DRIVE_BASE/$name.pid")"
}

p2843_wait_server() {
  for _ in $(seq 1 120); do
    curl -fsS "http://$PODIUM_HOST:$PODIUM_PORT/health" >/dev/null 2>&1 && return 0
    sleep 1
  done
  echo "server never served /health — see $PODIUM_DRIVE_BASE/logs/server.log" >&2
  return 1
}

# The daemon has no health endpoint, so wait on the line it prints ITSELF when
# its websocket to the server is up.
#
# COUNTED FROM THE RESTART MARKER, not merely present. The first version of this
# grepped the whole log for a phrase the server does not actually log, found
# nothing, and spun out its full 120 iterations on every restart — a silent
# two-minute stall that looked like a hung daemon and was a typo in the pattern.
# Anchoring on the marker also kills the opposite failure: the PREVIOUS boot's
# line is in the same file and would satisfy a whole-file grep instantly, so a
# daemon that never came back would read as up.
p2843_wait_daemon() {
  local log="$PODIUM_DRIVE_BASE/logs/daemon.log" marker
  marker="$(grep -c '^=== restarting daemon' "$log" 2>/dev/null || true)"
  for _ in $(seq 1 120); do
    # Lines after the LAST restart marker (or the whole file on a first boot).
    if awk -v m="$marker" '
         /^=== restarting daemon/ { seen++; next }
         seen >= m { print }
       ' "$log" 2>/dev/null | grep -q "podium daemon up: connected to"; then
      return 0
    fi
    sleep 1
  done
  echo "daemon never reported its connection — see $log" >&2
  return 1
}
