# SessionService decomposition oracle

Issue: POD-392  
Grading targets: POD-393, POD-394, POD-395  
Authority: docs/multi-user-readiness.md, read in full on 2026-08-01.

## Result

The named oracle is the apps/server/src/modules/sessions/oracle-*.test.ts family.
POD-379's 171 green session-write characterizations remain the lifecycle/inbox
base. POD-392 adds oracle-decomposition.test.ts and a provisional tag enforced by
oracle-tags.test.ts, so current-head gaps and deliberately open classifications
cannot be mistaken for preservation requirements.

The fixture in oracle-decomposition.test.ts creates two persisted user accounts,
one session per account, and one delegated agent principal per human. Every
settled per-user assertion reads both users' rows.

## Coverage ledger

| Concern | Evidence | Classification |
|---|---|---|
| Create, resume, hibernate, resurrect, kill, continue, stop | oracle-commands.test.ts | must-not-change |
| Direct send, resume-and-send, answer-question, controller bypass | oracle-commands.test.ts and oracle-ask-upload.test.ts | must-not-change |
| Queued send revoked before drain | oracle-decomposition.test.ts | must-not-change; apply-time re-authorization |
| readAt, snooze, pins, tab order for two users | oracle-decomposition.test.ts and oracle-session-state.test.ts | must-not-change per-user state; calling human owns the row |
| Payload user, actor, on-behalf-of fields | oracle-decomposition.test.ts, oracle-attribution.test.ts, oracle-handoff.test.ts | inert; transport wins |
| Activity coalescing and cumulative compute resets | oracle-decomposition.test.ts | must-not-change |
| Focus/visibility priority pushes and daemon reconnect replay | oracle-decomposition.test.ts | viewer-scoped ephemeral input; derived daemon aggregate |
| Handoff export/import, verified common base, target resume, source kill | oracle-handoff.test.ts | must-not-change |
| Worktree reuse, occupied-worktree exclusion, hard-sync import choreography | oracle-handoff.test.ts | must-not-change |
| Mid-transfer crashes, rollback, apply-time grant revocation, single-flight | oracle-handoff.test.ts | must-not-change |
| Spawn and handoff machine-use denial versus offline | oracle-decomposition.test.ts and oracle-handoff.test.ts | must-not-change fail-closed distinction |
| Native identity receipt persistence then owner-scoped acknowledgement | oracle-decomposition.test.ts | named; owner value provisional |
| Browser-open focus/visibility forwarding and callback attribution | oracle-decomposition.test.ts | named; payload identity inert |
| Server-authoritative humanQuestionAskedBy | oracle-attribution.test.ts | must-not-change |
| Composer draft fan-out and persistence | oracle-session-state.test.ts | shared document; materialized-snapshot seam for reserved op-stream |
| Archived and workState | oracle-session-state.test.ts | shared session-owned facts, exp-rev |
| Existence-leak error shapes | oracle-errors.test.ts and session-state/registry.test.ts | session state defaults closed; POD-1070 may revisit policy |

## Current-head multi-user gaps

These are measured observations, not desired behavior. The session-state gaps owned
by POD-393 are resolved: readAt, snooze and tab order are scoped to the transport
principal human; an agent writes the on-behalf-of human row; and invisible and
nonexistent session-state reads collapse to the same absent result.

The remaining provisional gaps belong to the surrounding identity and ownership work:

1. SessionService.sessionOwner still returns the first admin for every session because
   durable session ownership has not reached the session row. The supplied viewer is
   now filtered default-closed: a narrow unrelated principal receives neither row,
   while the transitional all-scope operator can read the instance.
2. ClientPrincipal is still device-grade and maps every browser connection to the
   first admin. Two persisted accounts can be exercised at command-policy seams,
   but the live browser transport cannot yet authenticate them separately.
3. An exact native-identity receipt for a Bob-bound session is acknowledged with
   ownerId user:sole because it consumes the same sessionOwner answer.
4. Owner-routed needs-human delivery cannot yet be distinguished between two
   humans at this service boundary. The suite pins the landed half:
   humanQuestionAskedBy is derived from the transport and payload spoofing is rejected.

The two-user fixture now decisively checks readAt, snooze, pins and tab order for both
humans, including a cross-user clear, and proves payload identity cannot redirect a row.

## Handoff cohesion decision

Measured: handoff already has its own coordinator, ports, refusal vocabulary, and
a 1,000-plus-line oracle covering export, import, common-base verification,
worktree occupancy, target claim, source finalization, rollback, apply-time
authorization, and single-flight behavior. SessionService is the composition root
that supplies session storage, machine RPC, workspace preparation, and lifecycle
callbacks.

Inferred decision for POD-319: retain handoff as a fourth module rather than
folding it into lifecycle. It shares lifecycle ports, but its transaction boundary,
failure recovery, authorization checkpoints, and independent test surface form a
cohesive transfer subsystem. Lifecycle should depend on the handoff coordinator
through explicit ports; it should not absorb the choreography.

## Verification

- Named SessionService oracle: 10 files, 183 tests passed.
- Server package typecheck: passed.
- Repository-wide test lane: passed. Node 9,221; web 1,456; mobile 34;
  Bun SQLite 14 (10,725 passing assertions total, plus the lane's documented
  skips).

A green from before the provisional retag or before
oracle-decomposition.test.ts was added is not evidence for this issue.
