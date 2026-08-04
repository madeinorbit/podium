# POD-1660 — cross-machine dispatch: a stale daemon bundle, not a code defect

Diagnosed 2026-08-04, re-verified and closed out 2026-08-13, on ludovico (server)
and the second machine — provider hostname `vmi3407763`, now `flatblock`
(`/etc/hosts`: `127.0.1.1 vmi3407763.contaboserver.net vmi3407763`), podium
machine id `c2ba4db0-eeb8-4768-a9be-98816c878a68`, the same id POD-1555 placed on.

## Symptom

    podium issue start 1658 --machine vmi3407763 --model claude-opus-5 --effort low
    -> podium issue: could not fetch issue/279-integration on the target:
       unsafe transferId: expected [A-Za-z0-9_-]{1,64} (got '')

## Root cause: a protocol field rename the target's build predates

The bundle transport passes an opaque name for the staged bundle; each daemon
derives its own stage path from it. That field was renamed `transferId` →
`token` when the rewrite lineage landed (`272122b1d`, POD-1578, 2026-08-03 17:10).

| side | build | field |
| --- | --- | --- |
| server, `apps/server/src/modules/sessions/workspace.ts:236-267` | current | sends `{ token, ref }` |
| daemon, `apps/daemon/src/control/exec.ts:33-45` | current | reads `args.token` |
| daemon, `272122b1d^:apps/daemon/src/control/exec.ts:91` | the one on vmi | reads `msg.args?.transferId ?? ''` |

The old daemon read a field the new server no longer sent, got `''`, and its own
guard rejected it — verbatim the reported message. Both lineages were internally
consistent; only the *pair* was broken. Nothing upstream failed to mint the id.

Note for the next grep: `unsafe transferId` exists nowhere in current source.
That absence is not evidence the bug is gone — it is evidence the string lives
only in the *deployed binary*.

## Evidence — the deployed binary, not the source tree

`podium --version` read `0.1.2-edge.1` on both builds (the version comes from
root `package.json`), so the skew had to be shown by content:

| probe | vmi bundle, built 2026-08-03 11:08 | vmi binary, rebuilt 2026-08-13 08:40 |
| --- | --- | --- |
| `strings -a podium-cli \| grep -c "unsafe transferId"` | 1 | 0 |
| `strings -a podium-cli \| grep -c "bundle path must be absolute"` | 2 | 2 |

The second row is the control: a bundle-op string is present in both, so the
zero in the first row is a real absence rather than a broken probe.

## Resolution

No code change was required on either lineage. The skew closed when the second
machine's binary was rebuilt on 2026-08-13 08:40 (sha256 `0e654739…`) in the
course of the updater work (POD-1738 / POD-1783 lineage); its checkout carries
`args.token` at `b53df2a0f`, and `origin/main` now has `token` on both sides.

An interim fix built from `issue/279-integration` on 2026-08-04 (sha256
`2741b143…`, 0 hits) was never installed — the deploy was refused by the
permission classifier, and the fleet's own update path overtook it.

## Acceptance — a real remote start, 2026-08-13

Placement proof issue POD-1971, started on the second machine:

    podium issue create --parent-id 1660 --title "Remote placement proof" \
      --agent claude --model claude-opus-5 --effort low --machine flatblock --start

The worktree and branch were created **on the target** —
`/home/mgw/src/podium/.worktrees/issue-1971-remote-placement-proof`, branch
`issue/1971-remote-placement-proof` at `b2e885b34` — which is the branch-fetch
step that previously died with the `transferId` error.

The first `--start` returned `agent relay timed out` after the worktree landed;
a retry via `podium agent spawn --issue POD-1971` spawned session
`8e39ce7e-c38c-4337-b2b7-050fdac17c2a` on flatblock, whose first turn reported:

    hostname: flatblock
    pwd:      /home/mgw/src/podium/.worktrees/issue-1971-remote-placement-proof
    git log --oneline -1:            b2e885b34 Repair rebased mirror ID fixture
    git rev-parse --abbrev-ref HEAD: issue/1971-remote-placement-proof

Worker placed, branch fetched, session running. POD-1971 closed; its worktree
was clean (`git status --porcelain` empty).

## Harness sign-in on the second machine

Not a blocker, and no longer a gap: `podium machine list` reports flatblock with
claude-code 2.1.223, codex-cli 0.147.0 and grok 0.2.118 all **ready** and signed
in as mike.wirth@gmail.com. On 2026-08-04 codex and grok there were not logged
in; a human signed them in since.

## Loose ends worth a look

- **The relay timeout on first `--start` is unexplained.** The worktree and
  branch landed on the target and the issue was claimed, but the agent spawn's
  ack did not arrive inside the budget; an identical spawn seconds later
  succeeded. `podium mail reply` timed out once the same way on 2026-08-04 and
  succeeded on retry. This is POD-1557's shape — a request type whose failure
  presents only as a timeout — but under load, not skew, so it is a different
  cause with the same face.
- **Nothing checks that a target daemon speaks the server's protocol before
  work is placed on it.** This is the second skew of this shape (POD-1555 was
  the first) and it cost the fleet a day of serialised work on one box. POD-1557
  covers the diagnosability half; a pre-placement version handshake does not
  exist.
