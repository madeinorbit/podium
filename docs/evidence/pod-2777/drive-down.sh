#!/usr/bin/env bash
# Stop the isolated `p2777` instance. Leaves state and logs in place so a drive's
# evidence survives the teardown that produced it.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=drive-env.sh
. "$HERE/drive-env.sh"

for name in daemon server; do
  pidfile="$PODIUM_DRIVE_BASE/$name.pid"
  [ -f "$pidfile" ] || continue
  pid="$(cat "$pidfile")"
  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    for _ in $(seq 1 40); do kill -0 "$pid" 2>/dev/null || break; sleep 0.25; done
    kill -9 "$pid" 2>/dev/null || true
    echo "stopped $name ($pid)"
  fi
  rm -f "$pidfile"
done

# HARNESS SERVERS WE ORPHANED, and this is not tidiness — it is the host.
#
# Every arm leaves its sessions alive, the daemon ADOPTS the survivors on its
# next boot, and each opencode server is worth about 400MB. POD-2773 measured
# four arms at 1.2GB of this box's 12, on an afternoon when the host was already
# unusable — and lost a real measurement to a session that went `reconnecting`
# under the load. This drive runs far more sessions than that one did, so the
# reaping matters more, not less.
#
# MATCHED ON OUR AGENT-HOME PATH, never on the binary name. Other sessions on
# this box run their own opencode, codex and grok servers out of $HOME and out
# of other instances' state roots, and a bare `pkill -f opencode` would take all
# of them down with it.
# MATCH ON THE ENVIRONMENT, NOT ON argv — and this correction cost 3.4GB.
#
# `pgrep -f <path>` searches the COMMAND LINE, and a harness server's command
# line does not contain the state root: opencode's is literally
# `opencode serve --port 39377 --hostname 127.0.0.1`. The path lives only in its
# ENVIRONMENT, as HOME. So the old reap matched almost nothing, six opencode
# servers from this rig's own runs accumulated to ~3.4GB on a 12GB box that has
# fallen over for memory before, and the teardown printed nothing and looked like
# it had worked. An evening was spent blaming host load this rig was creating.
#
# Reading /proc/<pid>/environ is also what makes this SAFE: other instances on
# this box run their own servers under their own agent homes, and matching the
# exact state root leaves theirs alone.
#
# `cat`, not a shell redirect: `< /proc/1/environ` fails in the SHELL, and under
# `set -e` that aborts the loop before it reaps anything — which is how the same
# leak went unnoticed a SECOND time, for a completely different reason, printing
# one permission error to say so.
# GUARD BEFORE THE GLOB. The match below is `case "$home:$inst"` against
# `*:"$PODIUM_INSTANCE"`. With PODIUM_INSTANCE empty that pattern degrades to
# `*:` — which matches EVERY process on the box, and this loop would kill them
# all. The old spelling matched on a path that was always non-empty because the
# rig exported it; the new one matches on a variable the rig no longer controls,
# so the empty case has to be refused explicitly rather than assumed away.
[ -n "${PODIUM_INSTANCE:-}" ] || {
  echo "refusing to reap: PODIUM_INSTANCE is empty — did you source drive-env.sh?" >&2
  exit 2
}
reaped=0
for pid in $(ls /proc 2>/dev/null | grep -E '^[0-9]+$'); do
  [ "$pid" = "$$" ] && continue
  [ "$pid" = "$PPID" ] && continue
  env_of="$(cat "/proc/$pid/environ" 2>/dev/null | tr '\0' '\n' || true)"
  home="$(printf '%s' "$env_of" | sed -n 's/^HOME=//p' | tail -1)"
  # PODIUM_INSTANCE, not PODIUM_STATE_DIR: the rig no longer exports a state
  # dir, so that variable is absent from every process it owns and matching on
  # it would reap nothing at all — a teardown that silently stops tearing down.
  inst="$(printf '%s' "$env_of" | sed -n 's/^PODIUM_INSTANCE=//p' | tail -1)"
  [ -n "$home" ] || [ -n "$inst" ] || continue
  case "$home:$inst" in
    "$P2777_STATE_ROOT/agent-home":*|*:"$PODIUM_INSTANCE")
      kill "$pid" 2>/dev/null && reaped=$((reaped + 1)) ;;
  esac
done
[ "$reaped" -gt 0 ] && echo "reaped $reaped process(es) belonging to $P2777_STATE_ROOT"

# SYSTEMD SCOPES, REAPED BY STATE ROOT — the shape that held ~2GB for five and a
# half hours after a FINISHED rig. A harness child sits in a
# `podium-<xx>-<uuid>.scope`; when the daemon dies the scope is reparented to
# systemd and survives every process-level teardown. Matched on the state root of
# the scope's OWN processes, never on the scope name: other instances run scopes
# with identical names and `systemctl --user stop 'podium-oc-*'` would take the
# operator's sessions down with mine.
for unit in $(systemctl --user list-units --type=scope --no-legend 2>/dev/null \
                | grep -oE 'podium-[a-z]+-[0-9a-f-]+\.scope' || true); do
  mine=no
  for pid in $(systemctl --user show -p ControlGroup --value "$unit" 2>/dev/null \
                 | sed 's#^#/sys/fs/cgroup#' | xargs -r -I{} cat {}/cgroup.procs 2>/dev/null); do
    home="$(cat "/proc/$pid/environ" 2>/dev/null | tr '\0' '\n' | sed -n 's/^HOME=//p' | tail -1 || true)"
    [ "$home" = "$P2777_STATE_ROOT/agent-home" ] && mine=yes
  done
  if [ "$mine" = yes ]; then
    systemctl --user stop "$unit" 2>/dev/null && echo "stopped orphan scope $unit"
  fi
done
pkill -f "podium-oc-attach" 2>/dev/null && echo "reaped stray opencode clients" || true
pkill -f "podium-gk-attach" 2>/dev/null && echo "reaped stray grok clients" || true
pkill -f "podium-cx-attach" 2>/dev/null && echo "reaped stray codex clients" || true
echo "instance '$PODIUM_INSTANCE' down; state kept at $P2777_STATE_ROOT"
