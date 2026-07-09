#!/usr/bin/env bash
# Spike for #214: a server-held GitHub token, injected as env only, makes `gh` and
# `git` work on a machine that has never been logged in to GitHub.
#
# Simulates the daemon by running every command under `env -i` with an empty HOME:
# no ~/.config/gh, no ~/.git-credentials, no ssh keys, no ambient auth.
#
# The propagation surface is exactly three environment variables. Nothing is
# written to the daemon's disk.
#
# Usage: scripts/spike-gh-auth-propagation.sh [<https-repo-url>]
#   Requires a `gh` login on THIS machine only to source the token (stands in for
#   the server's credential store). All operations are read-only or --dry-run.

set -euo pipefail

REPO_URL="${1:-https://github.com/madeinorbit/podium.git}"
WORK="$(mktemp -d)"
FAKE_HOME="$WORK/home"
mkdir -p "$FAKE_HOME"
trap 'rm -rf "$WORK"' EXIT

# Stand-in for the server's credential store. In the real design this is minted
# by the server (GitHub App user access token) and pushed over the daemon socket.
TOKEN="$(gh auth token)"

# `env -i` = a daemon with nothing inherited. This is what the server must supply.
daemon() {
  env -i \
    HOME="$FAKE_HOME" \
    PATH=/usr/bin:/bin \
    GH_TOKEN="$TOKEN" \
    GIT_CONFIG_COUNT=1 \
    GIT_CONFIG_KEY_0='credential.https://github.com.helper' \
    GIT_CONFIG_VALUE_0='!gh auth git-credential' \
    "$@"
}

bare_daemon() { env -i HOME="$FAKE_HOME" PATH=/usr/bin:/bin "$@"; }

step() { printf '\n=== %s ===\n' "$1"; }

step "baseline: fresh machine has no GitHub auth (both must fail)"
! bare_daemon gh auth status 2>&1 | grep -q 'Logged in' || { echo "FAIL: unexpectedly logged in"; exit 1; }
! bare_daemon git ls-remote "$REPO_URL" >/dev/null 2>&1 || { echo "FAIL: unexpectedly authorized"; exit 1; }
echo "ok — no ambient credential"

step "gh authenticates from GH_TOKEN alone"
daemon gh auth status 2>&1 | sed -E 's/gh[pousr]_[A-Za-z0-9_]+/<redacted>/'
echo "identity: $(daemon gh api /user -q .login)"

step "git reads the same token through gh's credential helper (private repo)"
daemon git ls-remote "$REPO_URL" HEAD

step "clone + authenticated push path (dry-run, writes nothing upstream)"
daemon git clone --quiet --depth 1 "$REPO_URL" "$WORK/clone"
daemon git -C "$WORK/clone" push --dry-run origin HEAD:refs/heads/podium-spike-dry-run 2>&1 | tail -2

step "disk footprint on the daemon"
COUNT="$(find "$FAKE_HOME" -type f | wc -l)"
echo "files written to daemon HOME: $COUNT"
[ "$COUNT" -eq 0 ] || { echo "FAIL: token or config leaked to disk"; exit 1; }

printf '\nPASS — server-held token → daemon env → gh + git, zero files on disk.\n'
