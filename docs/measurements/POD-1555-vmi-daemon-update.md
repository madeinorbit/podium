# POD-1555 — vmi3407763 daemon brought to current main

Measured 2026-08-03 on ludovico (server) and vmi3407763 (second machine).

## Symptom

Every placement onto vmi timed out:

    podium issue start --id 1127 --agent codex --machine vmi3407763
    podium issue: agent relay timed out

Only vmi's own journal named the cause — a strict zod parse throwing inside
`handleControlMessage` before any reply is sent, so the server waited out its 35s
budget. Version skew is indistinguishable from an offline machine from the caller's
side. This is the exact failure the `payloadRejectionReply` header in
`apps/daemon/src/daemon.ts` (POD-1464) predicts.

## Route taken: rebuild and ship the packaged bundle

vmi now runs the packaged headless bundle built from current `main`, not a
from-source daemon. Why:

- The packaged path is what the product ships and is therefore the path that must
  work. Running vmi from source would have removed the skew by removing the thing
  under test — and vmi is the intended target for POD-1281 (live upgrade rehearsal),
  POD-1407 (VPS daemon soak) and POD-1463 (paired-instance soak), all of which want a
  machine that looks like a real install.
- vmi's checkout (`~/src/podium`) is on branch `vmi-verify` on the rewrite lineage,
  not on main. From-source would have meant keeping a second checkout in sync — a new
  skew surface in place of the old one.
- ludovico stays from-source, so the fleet still covers both shapes.

## What was done

    bun install && bun run package:headless        # in the POD-1555 worktree, HEAD == main 5513c70e
    rsync dist-bun/headless/ -> vmi:~/.local/share/podium/
    # old bundle kept at ~/.local/share/podium.bak-0.1.2-edge.1-20260803
    systemctl --user restart podium-daemon.service

## Evidence — the version string proves nothing

`podium --version` reads `0.1.2-edge.1` on BOTH the old and the new bundle (the
version comes from root `package.json`, which did not change). The binary swap was
verified by content instead:

| probe                                      | old bundle | new bundle |
| ------------------------------------------ | ---------- | ---------- |
| `sha256(podium-cli)`                        | `388c8ce3…` | `6e800644…` |
| `strings -a \| grep -c "is not supported by this daemon"` | 0 | 1 |
| control: `grep -c "handleControlMessage"`   | 2          | 2          |

The control symbol is present in both, so a zero on the first row is a real absence
rather than a broken probe.

## Proof by placing real work

Not a version read — an actual session:

    podium issue start --id 1556 --agent claude --machine c2ba4db0-eeb8-4768-a9be-98816c878a68
    started #1556 (issue/1556-vmi-daemon-placement-proof @ /home/mgw/src/podium/.worktrees/…)
    → returned in 1.8s (previously: 35s timeout)

The session ran on vmi and reported back through the relay:

    vmi3407763
    /home/mgw/src/podium/.worktrees/issue-1556-vmi-daemon-placement-proof
    6e80064488073b4baa2f81ee5bb46345879c9553c5947ec2863b4d08e97fd4b1  …/podium-cli
    ---STRINGS COUNT---
    1

The worktree creation is itself a repo op over the control channel — the class of
frame that produced nothing but a timeout before.

## Discovered, filed separately

- **POD-1557** — `payloadRejectionReply` answers only `repoOpRequest`; every other
  request type a stale build cannot parse still dies as a silent timeout. The next
  skew looks like this one all over again.
- **POD-1558** — the placed session spawned correctly but received no opening turn
  for ~6 minutes, until it was poked with `session send`. Spawn and repo ops are
  fine; first-turn delivery to a remote machine is not.

## Rollback

    systemctl --user stop podium-daemon.service
    rsync -a --delete ~/.local/share/podium.bak-0.1.2-edge.1-20260803/ ~/.local/share/podium/
    systemctl --user start podium-daemon.service
