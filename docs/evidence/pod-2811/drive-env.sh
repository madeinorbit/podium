# POD-2811's own identity for POD-2777's rig.
#
# Source this INSTEAD of nothing, then use POD-2777's scripts unchanged:
#
#   . docs/evidence/pod-2811/drive-env.sh
#   bash docs/evidence/pod-2777/drive-up.sh
#   bun  docs/evidence/pod-2811/fault-watch.ts
#
# WHY A SECOND IDENTITY RATHER THAN SHARING p2777's. Two sessions drove `p2777`
# at once on 2026-08-26 and each silently killed the other: `drive-up.sh` stops
# "the previous pair" through $PODIUM_DRIVE_BASE/*.pid, so a neighbour's
# bring-up reaps yours and then writes ITS commit into YOUR log. What surfaced
# it was a server answering on :19847 stamped `dev+15cdfa0-dirty` — the POD-2777
# worktree's commit — inside /tmp/pod-2777/logs/server.log while this session's
# pin check had just verified 79fedcd. Two readings were lost to it before the
# stamp was read.
#
# The rig's own header always promised that every rig on this box can run side
# by side; POD-2811 made its identity overridable so that is true rather than
# stated. Nothing else about the rig changes, and with none of these set it
# comes up exactly as p2777 did.
export P2777_INSTANCE=p2811
export P2777_BASE=/tmp/pod-2811
# PORT BASE 19857 — after POD-2245 (19797), POD-2290 (19807), POD-2753 (19817),
# POD-2761 (19827), POD-2773 (19837), POD-2777 (19847) and POD-2853 (19887).
export P2777_PORT=19857
export P2777_HOOK_PORT=46857
export P2777_RELAY_PORT=46858
# THE CODE UNDER TEST IS THIS WORKTREE. Left unset it is POD-2777's, which is a
# different branch at a different commit — the neighbour's, not ours.
export P2777_REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

# THEN THE RIG'S OWN ENVIRONMENT, with the overrides above already exported.
# Sourcing it here rather than leaving it to the caller is not tidiness: it is
# what puts ~/.bun/bin and the harness binaries on PATH and scrubs the inherited
# Podium session. Forgetting it is the documented way to end up driving the
# neighbour's instance — and, more quietly, `bun: command not found`.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")/../pod-2777" && pwd)/drive-env.sh"
