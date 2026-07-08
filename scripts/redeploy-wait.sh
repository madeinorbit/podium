#!/usr/bin/env bash
# Pre-restart gate for podium-redeploy.service (ExecStartPre). Two jobs:
#
# 1. Wait for git to be quiescent before the redeploy restart picks up source.
#    A fast-forward merge writes .git/logs/HEAD (which triggers podium-redeploy.path)
#    while it still holds .git/index.lock for the working-tree checkout; under load the
#    restart can beat the checkout and boot STALE source. Block until the lock clears.
#
# 2. Install dependencies when the deploy changed them (#173/#176). The services run
#    from source, so a deploy whose diff touches bun.lock or any package.json used to
#    crash-loop the server on unresolvable workspace modules. We persist the
#    last-deployed HEAD in a state file; if bun.lock or any package.json changed since
#    then (or on first run / unknown previous HEAD), run
#    `bun install --frozen-lockfile --linker=hoisted`. If the install FAILS we exit
#    non-zero so systemd aborts the unit BEFORE ExecStart restarts any service —
#    failing the deploy loudly instead of booting services against a broken node_modules.
set -u
repo="${1:?usage: redeploy-wait.sh <repo-root>}"
lock="$repo/.git/index.lock"
timeout="${REDEPLOY_WAIT_TIMEOUT:-30}"   # seconds; cap so a stuck lock can't wedge redeploy
settle="${REDEPLOY_WAIT_SETTLE:-0.5}"     # filesystem-flush grace once the lock is gone
state_file="${REDEPLOY_STATE_FILE:-$repo/.git/podium-redeploy-head}"  # last successfully deployed HEAD
deadline=$(( $(date +%s) + timeout ))
while [ -e "$lock" ]; do
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "[redeploy-wait] index.lock still present after ${timeout}s — proceeding anyway" >&2
    break
  fi
  sleep 0.1
done
sleep "$settle"

# ---- dependency install gate ----------------------------------------------

head="$(git -C "$repo" rev-parse HEAD 2>/dev/null || true)"
if [ -z "$head" ]; then
  # Not a resolvable git repo (or git missing): we cannot detect dependency drift.
  # Don't block the deploy — restarting services here matches the pre-#176 behavior.
  echo "[redeploy-wait] cannot resolve HEAD in $repo — skipping dependency check" >&2
  exit 0
fi

need_install=0
prev=""
if [ -r "$state_file" ]; then
  prev="$(head -n1 "$state_file" | tr -d '[:space:]')"
fi
if [ -z "$prev" ]; then
  echo "[redeploy-wait] no previously deployed HEAD recorded — installing dependencies" >&2
  need_install=1
elif [ "$prev" != "$head" ]; then
  # Pathspec wildcards match across directories: '*package.json' hits every
  # workspace manifest as well as the root one.
  if changed="$(git -C "$repo" diff --name-only "$prev" "$head" -- bun.lock '*package.json' 2>/dev/null)"; then
    if [ -n "$changed" ]; then
      echo "[redeploy-wait] dependency manifests changed ${prev}..${head}:" >&2
      echo "$changed" | sed 's/^/[redeploy-wait]   /' >&2
      need_install=1
    fi
  else
    # Previous HEAD unknown to this repo (force-push, gc, rewritten history):
    # we can't prove deps are unchanged, so install to be safe.
    echo "[redeploy-wait] cannot diff ${prev}..${head} — installing dependencies to be safe" >&2
    need_install=1
  fi
fi

if [ "$need_install" -eq 1 ]; then
  bun_bin="${REDEPLOY_BUN:-}"
  if [ -z "$bun_bin" ]; then
    bun_bin="$(command -v bun || true)"
    [ -z "$bun_bin" ] && [ -x "$HOME/.bun/bin/bun" ] && bun_bin="$HOME/.bun/bin/bun"
  fi
  if [ -z "$bun_bin" ]; then
    echo "[redeploy-wait] FATAL: dependencies changed but bun not found — refusing to restart services" >&2
    exit 1
  fi
  echo "[redeploy-wait] running: $bun_bin install --frozen-lockfile --linker=hoisted (in $repo)" >&2
  if ! (cd "$repo" && "$bun_bin" install --frozen-lockfile --linker=hoisted); then
    echo "[redeploy-wait] FATAL: bun install failed — aborting deploy, services NOT restarted" >&2
    echo "[redeploy-wait] last successfully deployed HEAD remains ${prev:-<none>}" >&2
    exit 1
  fi
fi

# Record this HEAD as successfully deployed only once deps are known-good.
printf '%s\n' "$head" > "$state_file"
exit 0
