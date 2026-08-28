#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# A SANDBOX NOBODY CAN TEST THE OFFLINE LAYER ON (POD-2762).
#
# `docker-update-e2e.sh --hold` publishes the coordinator on the host's tailnet
# IP and prints `http://100.x.y.z:32780`. Every hands-on test of the update path
# has been driven through that URL, and it is a URL where HALF THE PRODUCT DOES
# NOT EXIST: a service worker is only defined in a secure context — HTTPS, or
# localhost — so on a plain-HTTP IP `navigator.serviceWorker` is `undefined`,
# registration silently never happens, nothing is precached, and every lazy
# chunk goes to the network. That is how a page came to crash with
# ERR_CONNECTION_REFUSED on four chunks while a handover was in flight: the
# precache that was supposed to serve them had never been written.
#
# Measured on the live sandbox, same build, two origins:
#
#   http://100.113.194.89:32780   isSecureContext=false  serviceWorker absent
#   https://<node>.ts.net:32880   isSecureContext=true   1 worker, 195 entries
#
# So this is not a convenience wrapper. Without it the sandbox is testing a
# configuration nobody runs, and the desktop shell — whose webview needs a
# trustworthy origin for the same reason — cannot be pointed at it either.
#
# WHY `tailscale serve` AND NOT A SELF-SIGNED CERT. A secure context is not the
# only requirement; the certificate has to be TRUSTED, or the browser refuses
# the registration for a reason that reads like a network error. `tailscale
# serve` terminates TLS with a real cert for the node's tailnet name, which
# every device already on the tailnet trusts with no per-device setup. It is
# also what the maintainer's live instance already runs on :55555, so this adds
# an entry to a mechanism that is in use rather than a second one.
#
# The serve configuration is MACHINE-WIDE and OUTLIVES THIS SHELL, which is why
# `down` exists and why `up` refuses to touch a port it did not create.
# ---------------------------------------------------------------------------
set -Eeuo pipefail
shopt -s inherit_errexit

usage() {
  cat <<'EOF'
Put trusted HTTPS in front of a locally published sandbox port, so the web app's
service worker registers and the offline-first layer is actually under test.

USAGE
  scripts/sandbox-https.sh up <host-port> [tailnet-port]
  scripts/sandbox-https.sh down <tailnet-port>
  scripts/sandbox-https.sh status

  up      Proxy https://<node>.<tailnet>.ts.net:<tailnet-port> to
          http://127.0.0.1:<host-port>. The tailnet port defaults to the first
          free port at or above <host-port>+100. Prints the HTTPS URL and the
          exact command that removes it.
  down    Remove one proxy. Only ever removes the port you name.
  status  List the serve entries this machine currently publishes.

EXAMPLES
  scripts/sandbox-https.sh up 32780          # a --hold sandbox on :32780
  scripts/sandbox-https.sh down 32880
EOF
}

die() {
  printf 'sandbox-https: %s\n' "$*" >&2
  exit 1
}

require_tailscale() {
  command -v tailscale >/dev/null 2>&1 || die "tailscale is not installed on this host"
  tailscale status >/dev/null 2>&1 || die "tailscale is installed but not connected"
}

# The node's own tailnet name, without the trailing dot the API returns.
node_dns_name() {
  local name
  name="$(tailscale status --json | jq -r '.Self.DNSName // empty')"
  [[ -n "$name" ]] || die "tailscale did not report a DNS name for this node"
  printf '%s' "${name%.}"
}

# Ports this machine already serves. A collision here would silently REPLACE
# somebody else's proxy — the live instance on :55555 among them — so the
# search skips them rather than reporting a clash after the damage.
served_ports() {
  tailscale serve status --json 2>/dev/null | jq -r '(.TCP // {}) | keys[]' 2>/dev/null || true
}

port_is_served() {
  local port=$1 used
  while read -r used; do
    [[ "$used" == "$port" ]] && return 0
  done < <(served_ports)
  return 1
}

pick_tailnet_port() {
  local base=$1 candidate
  for (( candidate = base; candidate < base + 200; candidate++ )); do
    port_is_served "$candidate" && continue
    # Not enough that serve is free: something else on the host may hold the
    # port, and `serve` would come up and then answer nothing.
    if command -v ss >/dev/null 2>&1 && ss -ltn "sport = :$candidate" | grep -q LISTEN; then
      continue
    fi
    printf '%s' "$candidate"
    return 0
  done
  die "no free tailnet port in [$base, $((base + 200)))"
}

cmd_up() {
  local host_port=${1:-} tailnet_port=${2:-}
  [[ "$host_port" =~ ^[0-9]+$ ]] || { usage >&2; die "host port must be a number"; }
  require_tailscale

  # THE THING BEING FRONTED HAS TO BE THERE FIRST. A proxy onto a dead port
  # comes up perfectly happily and then serves 502s, and the failure reads as
  # "the service worker still will not register" three steps later.
  curl -fsS -o /dev/null --max-time 5 "http://127.0.0.1:$host_port/version" ||
    die "nothing answered http://127.0.0.1:$host_port/version — start the sandbox first"

  if [[ -n "$tailnet_port" ]]; then
    [[ "$tailnet_port" =~ ^[0-9]+$ ]] || die "tailnet port must be a number"
    ! port_is_served "$tailnet_port" ||
      die "tailnet port $tailnet_port is already served; pick another or run: $0 down $tailnet_port"
  else
    tailnet_port="$(pick_tailnet_port "$((host_port + 100))")"
  fi

  tailscale serve --bg --https="$tailnet_port" "http://127.0.0.1:$host_port" >/dev/null

  local url="https://$(node_dns_name):$tailnet_port"
  # PROVE IT, DO NOT ANNOUNCE IT. `tailscale serve` exits 0 as soon as the
  # config is stored; the first request is what shows whether TLS came up and
  # whether the proxy reaches the sandbox.
  curl -fsS -o /dev/null --max-time 20 --retry 5 --retry-delay 1 --retry-connrefused "$url/version" ||
    die "serve accepted the config but $url/version did not answer; remove it with: $0 down $tailnet_port"

  cat <<EOF
HTTPS front: $url
  -> http://127.0.0.1:$host_port
  A secure context, so the service worker registers and the shell precaches.
  Remove it with: $0 down $tailnet_port
EOF
}

cmd_down() {
  local tailnet_port=${1:-}
  [[ "$tailnet_port" =~ ^[0-9]+$ ]] || { usage >&2; die "tailnet port must be a number"; }
  require_tailscale
  port_is_served "$tailnet_port" || die "nothing is served on port $tailnet_port"
  tailscale serve --https="$tailnet_port" off
}

case "${1:-}" in
  up) shift; cmd_up "$@" ;;
  down) shift; cmd_down "$@" ;;
  status) require_tailscale; tailscale serve status ;;
  --help|-h|'') usage ;;
  *) usage >&2; exit 2 ;;
esac
