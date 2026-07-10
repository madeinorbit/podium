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
#
# 3. Typecheck the deploy before restarting anything (#251). A type/syntax error merged
#    to main used to deploy anyway and crash-loop the services. When any *.ts/*.tsx/*.json
#    file changed since the last deployed HEAD (json covers tsconfig + workspace
#    manifests), run `bun run typecheck`; a failure exits non-zero so systemd aborts the
#    unit while the OLD deploy keeps serving. Cache-aware via the same state file: a
#    deploy that provably touched no such file skips the typecheck entirely.
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

# Resolve the bun binary once, for both the install and typecheck gates.
resolve_bun() {
  bun_bin="${REDEPLOY_BUN:-}"
  if [ -z "$bun_bin" ]; then
    bun_bin="$(command -v bun || true)"
    [ -z "$bun_bin" ] && [ -x "$HOME/.bun/bin/bun" ] && bun_bin="$HOME/.bun/bin/bun"
  fi
}

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
# Deps-dirty marker (#251 review): written before bun install mutates the live
# node_modules, cleared only after the WHOLE gate (install + typecheck)
# succeeds. Without it, a typecheck failure after an install leaves
# node_modules from the rejected commit while the state file still says A —
# and a later revert whose manifests match A would diff clean, skip the
# install, and restart services against the rejected commit's dependencies.
deps_dirty_file="${state_file}.deps-dirty"
if [ -e "$deps_dirty_file" ]; then
  echo "[redeploy-wait] node_modules marked dirty by a previously aborted deploy — reinstalling" >&2
  need_install=1
fi
if [ "$need_install" -eq 0 ] && [ -z "$prev" ]; then
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
  resolve_bun
  if [ -z "$bun_bin" ]; then
    echo "[redeploy-wait] FATAL: dependencies changed but bun not found — refusing to restart services" >&2
    exit 1
  fi
  echo "[redeploy-wait] running: $bun_bin install --frozen-lockfile --linker=hoisted (in $repo)" >&2
  printf '%s\n' "$head" > "$deps_dirty_file"
  if ! (cd "$repo" && "$bun_bin" install --frozen-lockfile --linker=hoisted); then
    echo "[redeploy-wait] FATAL: bun install failed — aborting deploy, services NOT restarted" >&2
    echo "[redeploy-wait] last successfully deployed HEAD remains ${prev:-<none>}" >&2
    exit 1
  fi
fi

# ---- typecheck gate (#251) --------------------------------------------------
# Runs AFTER the install gate (typecheck needs node_modules to resolve imports).

# A fired install gate implies a typecheck too: first deploy / unknown-prev cases can't
# prove the tree typechecks, and a dependency bump can break types without touching *.ts.
need_typecheck="$need_install"
if [ "$need_typecheck" -eq 0 ] && [ "$prev" != "$head" ]; then
  if ts_changed="$(git -C "$repo" diff --name-only "$prev" "$head" -- '*.ts' '*.tsx' '*.json' 2>/dev/null)"; then
    if [ -n "$ts_changed" ]; then
      echo "[redeploy-wait] type-relevant files changed ${prev}..${head} — running typecheck" >&2
      need_typecheck=1
    fi
  else
    # Same unknown-prev fallback as the install gate: verify to be safe.
    echo "[redeploy-wait] cannot diff ${prev}..${head} — running typecheck to be safe" >&2
    need_typecheck=1
  fi
fi

if [ "$need_typecheck" -eq 1 ]; then
  resolve_bun
  if [ -z "$bun_bin" ]; then
    echo "[redeploy-wait] FATAL: typecheck needed but bun not found — refusing to restart services" >&2
    exit 1
  fi
  echo "[redeploy-wait] running: $bun_bin run typecheck (in $repo)" >&2
  if ! (cd "$repo" && "$bun_bin" run typecheck); then
    echo "[redeploy-wait] FATAL: typecheck failed — aborting deploy, services NOT restarted" >&2
    echo "[redeploy-wait] last successfully deployed HEAD remains ${prev:-<none>}" >&2
    exit 1
  fi
fi

# Record this HEAD as successfully deployed only once deps + types are known-good,
# and clear the deps-dirty marker — node_modules now provably matches this HEAD.
rm -f "$deps_dirty_file"
printf '%s\n' "$head" > "$state_file"
exit 0
