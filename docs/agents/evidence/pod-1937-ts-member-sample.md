# TypeScript entity-id member sample

Measured on the installed tree after rebasing onto `adefd6975`:
`bun scripts/entity-id-audit.ts --sites --form ts-string` reports **1,229** sites.
The detector already distinguishes the discharge: `sessionId: string` is
`ts-string`, while `sessionId: SessionId` is `other`.

## Method

The sample is stratified across all eleven high-volume areas named in the issue
brief: three sites from each of store, sessions, server top-level, machines,
issues/service, server-transfer, messages and sync; two each from memory,
daemon and client-core/engine. Classification uses the requested three buckets:

- **A — delete:** a hand-restatement of a model-owned shape that should use its
  canonical inferred type.
- **B — brand:** a real internal member/signature that should carry the brand.
- **C — fixture:** a production characterization double or fixture.

Inspection exposed a necessary fourth bucket:

- **D — boundary:** a raw database, legacy, provider-native or foreign carrier.
  Branding these directly would assert validity at the wrong side of the parse
  boundary. They need either a narrow conversion at ingress or a counted
  `UNBRANDED` decision when the id is not Podium-owned.

## The 30 sites

| Area | Site | Class | Reason |
|---|---|---:|---|
| store | `store/accounts.ts:13 ManagedAccountRow.id` | B | Domain row identity; should be `AccountId`. |
| store | `store/accounts.ts:25 Row.id` | D | Raw sqlite result before `toRow`. |
| store | `store/auth.ts:86 user_id` | D | Raw sqlite result, converted to `UserId` in the returned shape. |
| sessions | `sessions/account-env.ts:14 accountId` | B | Internal resolver input. |
| sessions | `sessions/command-ctx.ts:178 FleetRepoRow.machineId` | B | Internal fleet projection member. |
| sessions | `sessions/command-plane.ts:189 machineId` | B | Authorization service input. |
| server top | `auth-route.ts:149 AccountCredentialStore.get(userId)` | B | Internal credential port. |
| server top | `cloud-runtime.ts:55 CloudAgentSourceSession.machineId` | B | Podium id entering the one declared external mapper; JSON remains a string. |
| server top | `cloud-runtime.ts:96 CloudAgentRequest.issueId` | B | Podium issue identity passed to the cloud port. |
| machines | `machines/diagnostics.ts:9 recipients(machineId)` | B | Internal diagnostic routing port. |
| machines | `machines/enrollment.ts:73 authenticated machineId` | B | Verified enrollment result, after the trust boundary. |
| machines | `machines/enrollment.ts:148 mintEnrolledToken(machineId)` | B | Internal token ledger input. |
| issues | `issues/service/attention.ts:45 releaseWorktreeIfIdle(id)` | B | Narrow issue-worktree port. |
| issues | `issues/service/attention.ts:439 observed.issueId` | B | Fenced janitor service input, not an IssueWire restatement. |
| issues | `issues/service/attention.ts:442 observed.readerUserId` | B | Fenced janitor service input. |
| server-transfer | `server-transfer/rpc-adapter.ts:9 prepare machineId` | B | Internal RPC adapter principal. |
| server-transfer | `server-transfer/rpc-adapter.ts:19 chunk machineId` | B | Internal RPC adapter principal. |
| server-transfer | `server-transfer/rpc-adapter.ts:21 validate machineId` | B | Internal RPC adapter principal. |
| messages | `messages/brakes.ts:159 takeSpawnBudget(issueId)` | B | Internal containment key. |
| messages | `messages/characterization-support.ts:75 SessionFixture.machineId` | C | Production characterization fixture. |
| messages | `messages/characterization-support.ts:173 setWorktree(issueId)` | C | Production characterization port. |
| sync | `sync/adapters/indexeddb/schema.ts:86 StoredOutboxRecord.mutationId` | B | Typed IndexedDB persistence record. |
| sync | `sync/adapters/legacy-replica/import.ts:97 rejection.mutationId` | D | Diagnostic may describe a malformed, unvalidated legacy id. |
| sync | `sync/adapters/legacy-replica/import.ts:135 LegacyOutboxEntry.mutationId` | D | Parsed only after reading an unknown legacy blob. |
| memory | `memory/lake.ts:36 LakeReadSession.machineId` | B | Composed internal read projection. |
| memory | `memory/lake.ts:141 triggerSweep(machineId)` | B | Internal mirror/index service input. |
| daemon | `daemon/binding-store.ts:187 providerSessionId` | D | Provider-native id, not a Podium `SessionId`. |
| daemon | `daemon/control/context.ts:34 DaemonContext.machineId` | B | Daemon's registered Podium machine identity. |
| client engine | `client-core/engine/actions.ts:160 ActionState.superThreadId` | B | Device-local state keyed by a Podium thread. |
| client engine | `client-core/engine/kernel-outbox.ts:199 retireAwaiting(mutationId)` | B | Internal API currently casting at the callee. |

## Split and scope consequence

The requested split is **A 0 / B 23 / C 2**, plus **D 5** boundary sites the
three requested buckets cannot describe honestly. In particular, no sampled
site is `z.infer`-derived: an inferred alias does not have a `string` RHS for
this detector to classify as `ts-string`. The inherited claim that many of the
1,229 sites follow a zod flip automatically is therefore unsupported.

The broad class is real declaration/signature work, with call-site fallout.
Production characterization fixtures should flip with the contract they model.
Raw and foreign carriers must be handled at their boundary, not mechanically
branded. Shape-restatement deletion remains owned by the separate
`issue-shapes` and `session-shapes` items; this sample found no basis for moving
part of this issue into those items before the sweep.
