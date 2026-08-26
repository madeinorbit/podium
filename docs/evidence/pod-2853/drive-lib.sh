# Shared start/stop for the p2853 halves. Sourced by drive-up.sh and drive.ts's
# restart helper so "restart" and "start" are the SAME code.
#
# The named-instance runtime derives the agent home from the state root. Driver
# children receive that resolved home through the product; this daemon stays
# under real HOME so its instanceStateDir() matches the server's.

# Honours PODIUM_AGENT_HOME so the seeding below lands in the home the agent
# actually gets. docs/multi-instance.md documents that override, and it is the
# ONE way to change the `HOME` rung of abduco's socket-directory chain: the
# abduco child's HOME is ctx.homeDir (POD-2247), the AGENT home — not the
# daemon's own, which reaches nothing the durable spawn resolves.
p2853_agent_home() { echo "${PODIUM_AGENT_HOME:-$P2853_STATE_ROOT/agent-home}"; }

p2853_stop() { # name
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

p2853_start() { # name
  local name="$1" script log
  log="$PODIUM_DRIVE_BASE/logs/$name.log"
  mkdir -p "$PODIUM_DRIVE_BASE/logs"
  case "$name" in
    server) script=scripts/server.ts ;;
    daemon) script=scripts/daemon.ts ;;
    *) echo "unknown half: $name" >&2; return 1 ;;
  esac
  # Appended, never truncated: an arm's evidence is the boot that produced it.
  (
    cd "$PODIUM_DRIVE_REPO"
    # THE DAEMON'S OWN HOME, which is not the same thing as the agent's and is
    # NOT what abduco reads: driver children get ctx.homeDir explicitly since
    # POD-2247, so the abduco child's HOME is the AGENT home. This one only
    # decides where daemon-side writes land, and a hermetic home with no seeded
    # credential reads as logged-out.
    nohup bun --conditions=@podium/source "$script" >>"$log" 2>&1 &
    echo "$!" > "$PODIUM_DRIVE_BASE/$name.pid"
  )
  echo "started $name pid=$(cat "$PODIUM_DRIVE_BASE/$name.pid") from $PODIUM_DRIVE_REPO"
}

p2853_wait_server() {
  for _ in $(seq 1 120); do
    curl -fsS "http://$PODIUM_HOST:$PODIUM_PORT/health" >/dev/null 2>&1 && return 0
    sleep 1
  done
  echo "server never served /health — see $PODIUM_DRIVE_BASE/logs/server.log" >&2
  return 1
}

# The daemon has no health endpoint, so wait on the line it prints ITSELF when
# its websocket to the server is up. Counted from the restart marker, never a
# whole-file grep: the PREVIOUS boot's line is in the same appended file and
# would let a daemon that never came back read as up.
p2853_wait_daemon() {
  local log="$PODIUM_DRIVE_BASE/logs/daemon.log" marker
  # `grep -c` PRINTS 0 AND EXITS 1 when it matches nothing, so the inherited
  # `|| echo 0` appended a SECOND zero and awk got m="0\n0" — a string, not a
  # number, so `seen >= m` compared "" against "0 0" and was false forever. The
  # gate then spun its full 120 iterations on every boot and reported a daemon
  # that was already up as one that never connected. `|| true` keeps grep's own
  # 0 and drops only its exit status.
  marker="$(grep -c '^=== restarting daemon' "$log" 2>/dev/null || true)"
  marker="${marker:-0}"
  for _ in $(seq 1 120); do
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
