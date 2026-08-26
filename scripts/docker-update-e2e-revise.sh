#!/usr/bin/env bash
# Put a new Podium version into a sandbox that is ALREADY STANDING.
#
# WHY THIS EXISTS (POD-2835). Testing a new version used to mean tearing the
# sandbox down and running the gate again, which re-provisioned an entire
# container image to change one binary. Caching the base image removed most of
# that wait, but it did not remove the shape of the mistake: this epic exists to
# prove that a RUNNING install takes a new version IN PLACE, and if changing the
# version in a sandbox required a rebuilt sandbox then the sandbox was never
# using the mechanism the gate proves.
#
# So the primary path here is the PRODUCT path, and it is the same one the
# `dev-release` and `rollout` rows assert: move the source the coordinator
# watches onto a new ref, let it propose a development release, approve it, and
# let the running fleet take the offer. Nothing is rebuilt and nothing restarts
# that the updater would not itself restart.
#
# `--swap-bundle` exists for the other job, and only for it: standing up a
# PRE-UPDATE state the updater would not legitimately hand you — a machine
# pinned to an old build, a deliberately mismatched pair — so that an update can
# then be driven FROM there. It writes over an install behind the updater's
# back, which is exactly why it is not the default and says so when it runs.
set -Eeuo pipefail
shopt -s inherit_errexit

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

usage() {
  cat <<'EOF'
Usage:
  docker-update-e2e-revise.sh --run RUN_ID [--ref REF] [--accept]
  docker-update-e2e-revise.sh --run RUN_ID --swap-bundle TARBALL --into CONTAINER

Put a new version into a sandbox that is already running, without rebuilding it.
RUN_ID is the `Run label:` value the hold printed, minus the label key.

  --run RUN_ID       the standing run to act on (required)
  --ref REF          host git ref to move the coordinator's source onto
                     (default: the current HEAD of this worktree)
  --accept           after the offer appears, start the update and wait for the
                     fleet to converge on it. Without this the offer is left
                     pending so it can be accepted by hand in the UI, which is
                     usually what a sandbox is for.
  --swap-bundle T    ESCAPE HATCH. Write tarball T over an install directly,
                     behind the updater's back. For standing up a pre-update
                     state the updater would not legitimately produce.
  --into CONTAINER   which container --swap-bundle writes into (required with it)

PODIUM_UPDATE_E2E_PASSWORD must match the password the run was created with, and
PODIUM_UPDATE_E2E_INSTANCE the instance it was created with if that was not the
default. Both are printed by the hold.
EOF
}

RUN_TARGET=""
REF=""
ACCEPT=0
SWAP_BUNDLE=""
SWAP_INTO=""
while (( $# > 0 )); do
  case "$1" in
    --run) RUN_TARGET="${2:-}"; shift 2 ;;
    --ref) REF="${2:-}"; shift 2 ;;
    --accept) ACCEPT=1; shift ;;
    --swap-bundle) SWAP_BUNDLE="${2:-}"; shift 2 ;;
    --into) SWAP_INTO="${2:-}"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done
[[ -n "$RUN_TARGET" ]] || { usage >&2; exit 2; }
if [[ -n "$SWAP_BUNDLE" && -z "$SWAP_INTO" ]]; then
  echo "--swap-bundle needs --into to say which container to write" >&2
  exit 2
fi

# The gate's own helpers, verbatim: `rpc`, `container_exec`, `wait_for`, the
# authenticated session handling, the head/version identity contract. Sourcing
# runs nothing — its `main` runs only when the file is executed — and every
# object name falls out of PODIUM_UPDATE_E2E_RUN_ID. Reimplementing any of this
# here is how the two would drift, and the identity contract has drifted before
# (POD-2747), so it gets one implementation.
export PODIUM_UPDATE_E2E_RUN_ID="$RUN_TARGET"
# shellcheck source=./docker-update-e2e.sh
source "$ROOT/scripts/docker-update-e2e.sh"

# `attach` rather than `main`: the containers exist, so what has to be rebuilt is
# only this process's view of them — the published port, and a logged-in session.
attach() {
  docker inspect "$SOURCE" >/dev/null 2>&1 ||
    die "no standing run named '$RUN_TARGET' (container $SOURCE does not exist)"
  [[ "$(docker inspect -f '{{.State.Running}}' "$SOURCE")" == true ]] ||
    die "run '$RUN_TARGET' exists but its source container is not running"
  SOURCE_PORT="$(docker inspect "$SOURCE" |
    jq -r '.[0].NetworkSettings.Ports["18787/tcp"][] |
      select(.HostIp=="127.0.0.1") | .HostPort')"
  [[ -n "$SOURCE_PORT" ]] || die "source container publishes no 127.0.0.1 port for 18787"
  # A run created WITH a password answers 401 to every call made without one,
  # and a 401 reads to a wait_for loop as "not ready yet" — it would time out
  # with no mention of auth at all (POD-2832). So the login is checked here,
  # once, where it can still say what is wrong.
  if [[ -n "$E2E_PASSWORD" ]]; then
    e2e_login "$SOURCE" ||
      die "could not log in to $SOURCE; PODIUM_UPDATE_E2E_PASSWORD must match the password this run was created with"
  fi
  rpc GET updates.fleet >/dev/null ||
    die "the coordinator refused a fleet read; if this run has a password, set PODIUM_UPDATE_E2E_PASSWORD"
  # THE INSTANCE NAME IS CHECKED, NOT ASSUMED. `install_path` and `unit_name`
  # are both built from `$INSTANCE`, which defaults to `update-e2e` — so a run
  # created with PODIUM_UPDATE_E2E_INSTANCE set would have every path here point
  # at an install that does not exist. `--swap-bundle` would then `rm -rf` a
  # directory it had just created and restart a unit that was never there.
  local installed
  if ! container_exec "$SOURCE" test -d "$(install_path)"; then
    installed="$(container_exec "$SOURCE" \
      sh -c 'ls /home/podium/.local/share/podium-instances 2>/dev/null | tr "\n" " "' || true)"
    die "run '$RUN_TARGET' has no instance named '$INSTANCE'; it holds: ${installed:-none}. Set PODIUM_UPDATE_E2E_INSTANCE to the one the hold printed."
  fi
  # `WORK` is where the gate's helpers write their evidence. A revise is not a
  # gate run and records no matrix, but the helpers it borrows still write, and
  # a red one leaves its logs behind exactly as the gate's would.
  WORK="$(mktemp -d "${TMPDIR:-/tmp}/$RUN_TARGET-revise.XXXXXX")"
  mkdir -p "$WORK/logs"
  say "attached to $RUN_TARGET on 127.0.0.1:$SOURCE_PORT; evidence in $WORK/logs"
}

# Move the source the coordinator watches onto a new host ref.
#
# `/input` is the host repository, still bind-mounted read-only, and the clone
# was made with `--local --shared`, so a fetch here costs no copying: the objects
# are already reachable. Nothing is rebuilt to get a new version in — the source
# tree simply becomes a different commit, which is the input the release
# proposal is computed from.
#
# The new HEAD is reported in a global rather than on stdout, because `say`
# writes to stdout too: captured with `$(...)` this returned the progress line
# and the sha stuck together, and every later comparison was then made against a
# value that could never match anything.
REVISED_HEAD=""
move_source_to_ref() {
  local ref=$1 candidate
  candidate="$(git -C "$ROOT" rev-parse "$ref^{commit}")" ||
    die "'$ref' is not a commit in this worktree"
  say "moving the coordinator's source onto $ref ($candidate)"
  # REACHABLE FIRST, FETCH ONLY IF IT IS NOT. The clone was made `--shared`, so
  # `/work/source` reads `/input`'s object store through `objects/info/alternates`
  # — and that alternate is read live, so a commit made on the host AFTER the
  # sandbox started is usually already present with nothing transferred.
  #
  # The fallback is a full branch fetch and not `git fetch /input <sha>`, because
  # fetching a bare object id is refused unless the far side advertises it
  # (`uploadpack.allowReachableSHA1InWant`), and a commit that is not any
  # branch's tip is exactly the case this has to survive.
  container_exec "$SOURCE" bash -lc \
    "set -Eeuo pipefail
     cd /work/source
     if ! git cat-file -e '$candidate^{commit}' 2>/dev/null; then
       git fetch --no-tags /input '+refs/heads/*:refs/remotes/input/*'
     fi
     git checkout -B update-e2e-source '$candidate'" \
    >"$WORK/logs/revise-source-checkout.log" 2>&1 ||
    die "could not move /work/source onto $candidate; see $WORK/logs/revise-source-checkout.log"
  REVISED_HEAD="$(container_exec "$SOURCE" git -C /work/source rev-parse --short=7 HEAD)"
  [[ -n "$REVISED_HEAD" ]] || die "moved /work/source but could not read its HEAD back"
}

# The product path, end to end.
revise_by_release() {
  local ref=$1 head proposal target
  move_source_to_ref "$ref"
  head="$REVISED_HEAD"
  say "waiting for the coordinator to propose a release for $head"
  wait_for 120 "release proposal for $head" proposal_for "$head" ||
    die "no development release proposal named $head. If the sandbox is already running that commit there is nothing to propose; pick a ref with new commits on it."
  proposal="$(rpc GET updates.proposal)"
  printf '%s\n' "$proposal" >"$WORK/logs/revise-proposal.json"
  # The same head/version identity contract the gate's own rows assert, pinned
  # to the commit just checked out.
  proposal_identity_holds "$proposal" "$head" ||
    die "the proposal did not satisfy the HEAD/version identity contract; raw payload: $WORK/logs/revise-proposal.json"
  say "approving $(jq -r .version <<<"$proposal"); this starts the build inside the sandbox"
  approve_release "$WORK/logs/revise-proposal.json" "$WORK/logs/revise-approval.json" ||
    die "the approval was refused; response: $WORK/logs/revise-approval.json"
  wait_for 600 "published development feed" published ||
    die "the release was approved but never published; see the sandbox's own build logs"
  target="$(jq -r .version <"$WORK/logs/revise-proposal.json")"
  wait_for 60 "update offer for $target" target_is "$target" ||
    die "the feed published $target but the fleet was never offered it"
  say "the standing sandbox is now offered $target, with nothing rebuilt"
  if (( ACCEPT == 0 )); then
    cat <<EOF

OFFER PENDING — ACCEPT IT FROM THE RUNNING UI
  The sandbox is untouched apart from the offer: every machine still runs what
  it ran before, which is the state you want to accept the update FROM.
  Re-run with --accept to have this drive the acceptance instead.
EOF
    return 0
  fi
  accept_offer "$target"
}

# Take the offer the way the UI's Update button does.
accept_offer() {
  local target=$1 started id
  say "accepting $target through updates.start, the same call the UI makes"
  started="$(start_update)" || die "updates.start did not hand back an operation of its own"
  printf '%s\n' "$started" >"$WORK/logs/revise-start.json"
  # `.operationId`, which is what `updates.start` actually returns — the same
  # field `rollback` reads. Asking for `.id` yielded the STRING "null", and the
  # wait then polled an operation that cannot exist for its full budget while
  # the real update ran to completion behind it. A wrong field name reads
  # exactly like a stalled wave, so the id is checked before it is waited on.
  id="$(jq -r '.operationId // empty' <<<"$started")"
  [[ -n "$id" ]] ||
    die "updates.start returned no operationId; raw response: $WORK/logs/revise-start.json"
  if ! wait_for 420 "update operation $id to settle" terminal_operation "$id"; then
    dump_update_operations revise
    say_watch_budget 420
    die "operation $id did not reach a terminal state; operations written to $WORK/logs"
  fi
  operation "$id" >"$WORK/logs/revise-operation.json"
  jq -e '.state=="done"' >/dev/null <"$WORK/logs/revise-operation.json" ||
    die "the update operation ended $(jq -r .state <"$WORK/logs/revise-operation.json"); see $WORK/logs/revise-operation.json"
  wait_for 120 "fleet installed on $target" installed_versions_are "$target" ||
    die "the operation reported done but the fleet is not installed on $target"
  say "the running sandbox took $target in place; no container and no image was rebuilt"
}

# THE ESCAPE HATCH, AND WHY IT IS ONE.
#
# This writes an install directory from a tarball without the updater's
# involvement: no grant, no signature check by the running product, no operation
# recorded. That is not a way to deliver a version — it is a way to CONSTRUCT a
# starting state the updater would never legitimately produce, so that a real
# update can then be driven from it. Use it to build a pre-update world, never
# to test the update path itself, because a swapped install proves nothing about
# the mechanism this epic exists to prove.
#
# It follows the installer's own layout (a `headless/` directory inside the
# tarball becomes the install root) and stages then renames the way the
# installer does, so a swap cannot leave a half-written install behind.
swap_bundle() {
  local tarball=$1 container=$2 destination version
  [[ -f "$tarball" ]] || die "no such bundle: $tarball"
  docker inspect "$container" >/dev/null 2>&1 || die "no such container: $container"
  destination="$(install_path)"
  say "SWAPPING THE INSTALL IN $container BEHIND THE UPDATER'S BACK."
  say "  This is a pre-update state, not an update. Nothing about the update path is proven by it."
  docker cp "$tarball" "$container:/tmp/revise-bundle.tar.gz"
  container_exec "$container" systemctl --user stop "$(unit_name)"
  container_exec "$container" bash -lc "
    set -Eeuo pipefail
    stage=\"\$(dirname '$destination')/.revise-swap.\$\$\"
    rm -rf \"\$stage\"; mkdir -p \"\$stage\"
    tar -xzf /tmp/revise-bundle.tar.gz -C \"\$stage\"
    test -d \"\$stage/headless\" || { echo 'bundle has no headless/ directory' >&2; exit 1; }
    rm -rf '$destination'; mv \"\$stage/headless\" '$destination'; rm -rf \"\$stage\"
    rm -f /tmp/revise-bundle.tar.gz" ||
    die "the swap failed; $container's install may be incomplete and the unit is stopped"
  container_exec "$container" systemctl --user start "$(unit_name)"
  version="$(container_exec "$container" cat "$destination/VERSION")"
  say "$container now runs $version, installed by hand"
}

main_revise() {
  attach
  if [[ -n "$SWAP_BUNDLE" ]]; then
    swap_bundle "$SWAP_BUNDLE" "$SWAP_INTO"
    return 0
  fi
  revise_by_release "${REF:-HEAD}"
}

main_revise
