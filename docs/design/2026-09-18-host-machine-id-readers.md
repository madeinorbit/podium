# Host machine id reader inventory

Work order for POD-4163 / phase S9. Source snapshot: `be733ad420aecaf2137444fb2532661c5c1e1c3d`, 2026-09-18. No implementation change. Initially delivered as an uncommitted issue artifact; committed at the coordinator’s request as the durable S9 work order.

## Contract and scope

Authority: POD-3957 artifact 1, “Target model and plan”, retrieved 2026-09-18 (currently rev 25; brief cites rev 22), Part C “The server’s own machine id: 108 readers, 12 files”. The linked “Installation versus machine” section supplies the transfer invariant. Part C still specifies: historical backfills become one-time migrations; conjure refuses; defaults use an assigned-and-available daemon the caller may use; shared-secret hello disappears with setup enrolment; hosted updater needs a server-is-external placement fact. No boot repair, owner inference, aliases, or invented placement.

Rows below describe target behavior, not a claim that current code implements it. Exact API/error names are implementation choices. For transfer, the current contract is server assignment moving between enrolled machine rows; with no source machine, the existing machine-to-machine path must be unavailable. This does not invent an external-host migration protocol or remove transfer between real self-hosted machines.

One row per matching source line (including declarations, wiring and comments, explicitly labelled in the role column), not one per token. Search is case-sensitive `hostMachineId` beneath `apps/server/src`; it does not claim to enumerate aliases or uppercase variants. Tests and test helpers are separately accounted for below; they are not production readers. This makes the literal recursive search reproducible without confusing fixture setup with runtime behavior.

The current search has **112 production matching lines in 19 files**, plus **1000 test/helper matching lines in 96 files** (1112 total). The brief’s historical 108/12 is not a current acceptance limit; its printed per-file counts sum to 95, not 108. All current production matches are included, including readers beyond those named in the brief.

## File census

| File (under apps/server/src) | Matching lines |
|---|---:|
| `gateway/machine-directory.ts` | 8 |
| `gateway/peer-handshake.ts` | 1 |
| `modules/cost/service.ts` | 1 |
| `modules/issues/service/core.ts` | 1 |
| `modules/issues/service/workflow.ts` | 2 |
| `modules/issues/service/worktree-gc.ts` | 2 |
| `modules/machines/rpc.ts` | 2 |
| `modules/machines/service.ts` | 10 |
| `modules/updates/dev-publisher-wiring.ts` | 2 |
| `modules/updates/operation.ts` | 14 |
| `modules/updates/service.ts` | 5 |
| `modules/updates/trpc.ts` | 12 |
| `relay.ts` | 5 |
| `server.ts` | 17 |
| `store.ts` | 9 |
| `store/conversations.ts` | 2 |
| `store/conversations/index.ts` | 2 |
| `store/issues.ts` | 13 |
| `store/repos.ts` | 4 |

## Reader table

Kinds are the five Part C groups plus `other` for identity plumbing, authentication, availability and local-filesystem assumptions. Wiring inherits the behavior of its consumer. Historical migration helpers must not use a newly selected daemon as evidence of where old data lived.

| File:line (under apps/server/src) | Kind | Role / current expression | Correct behavior with no host machine |
|---|---|---|---|
| `gateway/machine-directory.ts:71` | other | declaration: `readonly hostMachineId: MachineId` | Delete shared-secret host hello with setup enrolment, including the host-only authenticator field/probe plumbing. Authenticate an explicitly enrolled daemon identity; absence of a host cannot authorize a synthetic hello. |
| `gateway/machine-directory.ts:82` | other | declaration: `readonly hostMachineId: MachineId` | Delete shared-secret host hello with setup enrolment, including the host-only authenticator field/probe plumbing. Authenticate an explicitly enrolled daemon identity; absence of a host cannot authorize a synthetic hello. |
| `gateway/machine-directory.ts:146` | other | read / wiring: `machineId: machines.hostMachineId,` | Delete shared-secret host hello with setup enrolment, including the host-only authenticator field/probe plumbing. Authenticate an explicitly enrolled daemon identity; absence of a host cannot authorize a synthetic hello. |
| `gateway/machine-directory.ts:148` | other | read / wiring: `hostname: observed?.hostname ?? machines.hostMachineId,` | Delete shared-secret host hello with setup enrolment, including the host-only authenticator field/probe plumbing. Authenticate an explicitly enrolled daemon identity; absence of a host cannot authorize a synthetic hello. |
| `gateway/machine-directory.ts:256` | other | read / wiring: `machineId: machines.hostMachineId,` | Delete shared-secret host hello with setup enrolment, including the host-only authenticator field/probe plumbing. Authenticate an explicitly enrolled daemon identity; absence of a host cannot authorize a synthetic hello. |
| `gateway/machine-directory.ts:258` | other | read / wiring: `hostname: observed?.hostname ?? machines.hostMachineId,` | Delete shared-secret host hello with setup enrolment, including the host-only authenticator field/probe plumbing. Authenticate an explicitly enrolled daemon identity; absence of a host cannot authorize a synthetic hello. |
| `gateway/machine-directory.ts:346` | other | read / wiring: `machines: Pick<MachineAuthenticator, 'hostMachineId'>,` | Delete shared-secret host hello with setup enrolment, including the host-only authenticator field/probe plumbing. Authenticate an explicitly enrolled daemon identity; absence of a host cannot authorize a synthetic hello. |
| `gateway/machine-directory.ts:352` | other | declaration: `hostMachineId: machines.hostMachineId,` | Delete shared-secret host hello with setup enrolment, including the host-only authenticator field/probe plumbing. Authenticate an explicitly enrolled daemon identity; absence of a host cannot authorize a synthetic hello. |
| `gateway/peer-handshake.ts:312` | other | declaration: `hostMachineId: prepared.deps.machines.hostMachineId,` | Delete shared-secret host hello with setup enrolment, including the host-only authenticator field/probe plumbing. Authenticate an explicitly enrolled daemon identity; absence of a host cannot authorize a synthetic hello. |
| `modules/cost/service.ts:469` | other | read / wiring: `const local = this.store.hostMachineId` | Treat all machine-owned transcripts as remote: retain sessions with registered transcript paths without statting those paths on the hosted server filesystem. |
| `modules/issues/service/core.ts:135` | default-machine | read / wiring: `this.deps.store.hostMachineId` | Keep an explicit machine or an assigned-and-available daemon the caller may use; remove only the final host fallback. If resolution fails, refuse with a placement-required/unavailable outcome. |
| `modules/issues/service/workflow.ts:313` | default-machine | read / wiring: `row.machineId ?? this.store.d.store.hostMachineId,` | Validate model selection against the resolved authorized execution machine. Use the issue machine when present, otherwise an assigned-and-available daemon the caller may use; refuse if none, never use a server catalog. |
| `modules/issues/service/workflow.ts:1417` | default-machine | read / wiring: `row.machineId ?? this.store.d.store.hostMachineId,` | Validate model selection against the resolved authorized execution machine. Use the issue machine when present, otherwise an assigned-and-available daemon the caller may use; refuse if none, never use a server catalog. |
| `modules/issues/service/worktree-gc.ts:65` | default-machine | read / wiring: `const targetMachineId = machineId ?? this.store.d.store.hostMachineId` | Use an explicitly selected authorized machine or resolve an assigned-and-available daemon the caller may use. If none exists, report no usable target; never list the hosted server as a worktree machine. |
| `modules/issues/service/worktree-gc.ts:124` | default-machine | read / wiring: `machineByRow.get(row.id) ?? this.store.deps.store.hostMachineId` | Preserve each resolved worktree machine. If a row has no proven placement, exclude it from destructive GC and surface unresolved placement; do not redirect its path to a fallback host or another machine. |
| `modules/machines/rpc.ts:192` | transfer | declaration: `hostMachineId: MachineId` | Require a real enrolled source for the current identity-bound machine transfer manifest. Without a host, refuse before preparation/side effects; never substitute target, installation id, or a default daemon as source. |
| `modules/machines/rpc.ts:1672` | transfer | read / wiring: `const sourceMachineId = this.deps.hostMachineId` | Require a real enrolled source for the current identity-bound machine transfer manifest. Without a host, refuse before preparation/side effects; never substitute target, installation id, or a default daemon as source. |
| `modules/machines/service.ts:273` | other | declaration: `hostMachineId: MachineId` | Expose explicit no-host placement and remove claims that every server has a fleet identity; downstream readers must handle absence. |
| `modules/machines/service.ts:303` | other | read / wiring: `return { epoch: this.availabilityEpoch, server: machineId === this.deps.hostMachineId,` | Report server availability false on every fleet row; the external server is not a daemon/supervisor machine. Preserve independently observed daemon and supervisor availability. |
| `modules/machines/service.ts:494` | other | comment: `/** This host's machine id — see {@link MachinesDeps.hostMachineId}. Exposed because` | Expose explicit no-host placement and remove claims that every server has a fleet identity; downstream readers must handle absence. |
| `modules/machines/service.ts:505` | other | read / wiring: `get hostMachineId(): MachineId {` | Expose explicit no-host placement and remove claims that every server has a fleet identity; downstream readers must handle absence. |
| `modules/machines/service.ts:506` | other | read / wiring: `return this.deps.hostMachineId` | Expose explicit no-host placement and remove claims that every server has a fleet identity; downstream readers must handle absence. |
| `modules/machines/service.ts:1041` | other | read / wiring: `const row = await this.deps.store.machines.getMachine(this.deps.hostMachineId)` | Return false/no grant when there is no host; never create a machine or infer custody from the first admin. Ownership remains an explicit enrolment/custody transition. |
| `modules/machines/service.ts:1042` | other | read / wiring: `if (!row &#124;&#124; row.revokedAt &#124;&#124; await this.deps.store.machines.custodian(this.deps.hostMachineId) !== null) return false` | Return false/no grant when there is no host; never create a machine or infer custody from the first admin. Ownership remains an explicit enrolment/custody transition. |
| `modules/machines/service.ts:1043` | other | read / wiring: `await this.deps.store.machines.setMachineOwner(this.deps.hostMachineId, ownerUserId)` | Return false/no grant when there is no host; never create a machine or infer custody from the first admin. Ownership remains an explicit enrolment/custody transition. |
| `modules/machines/service.ts:1454` | transfer | read / wiring: `currentServer: m.id === this.deps.hostMachineId,` | No fleet row is currentServer. Evaluate target eligibility from actual enrolled capabilities; do not imply that an external server supplies a valid machine transfer source. |
| `modules/machines/service.ts:1807` | conjure | read / wiring: `const id = this.deps.hostMachineId` | Do not run host-row upsert for an external server. Remove boot row creation; enrolled self-hosted rows retain their ids, and promotion assignments belong to the explicit transfer transition. |
| `modules/updates/dev-publisher-wiring.ts:182` | updater | declaration: `hostMachineId: string,` | With an external server, every enrolled feed-capable machine is remote. Do not exclude an invented host; retain revoked filtering at the caller. |
| `modules/updates/dev-publisher-wiring.ts:184` | updater | read / wiring: `return machine.id !== hostMachineId && machine.deliveryCaps.includes('update.delivery.feed')` | With an external server, every enrolled feed-capable machine is remote. Do not exclude an invented host; retain revoked filtering at the caller. |
| `modules/updates/operation.ts:766` | updater | declaration: `hostMachineId?: string` | Carry an explicit server-is-external placement fact. No fleet member is the server; retain normal enrolled-fleet updates without inferring local server restart/delivery from a missing host id. |
| `modules/updates/operation.ts:998` | updater | read / wiring: `const host = input.hostMachineId` | Resolve no host fleet row; external placement must prevent absence being interpreted as a missing/offline self-hosted coordinator. |
| `modules/updates/operation.ts:999` | updater | read / wiring: `? input.fleet.find((machine) => machine.id === input.hostMachineId)` | Resolve no host fleet row; external placement must prevent absence being interpreted as a missing/offline self-hosted coordinator. |
| `modules/updates/operation.ts:1083` | updater | read / wiring: `(input.onlyMachines === undefined &#124;&#124; (input.hostMachineId !== undefined && input.onlyMachines.includes(input.hostMachineId))) &&` | External placement must suppress the local server-restart step, including unrestricted onlyMachines. Absence alone currently allows this branch; remote fleet delivery remains eligible. |
| `modules/updates/operation.ts:1397` | updater | declaration: `hostMachineId?: string` | Carry an explicit server-is-external placement fact. No fleet member is the server; retain normal enrolled-fleet updates without inferring local server restart/delivery from a missing host id. |
| `modules/updates/operation.ts:1810` | updater | read / wiring: `if (context.hostMachineId && context.prepareCoordinatorUpdate && context.requestCoordinatorRestart) {` | Do not reserve, register, prepare, or grant a local coordinator update without a self-hosted placement. Continue eligible remote fleet steps; external-server update belongs to its deployment authority. |
| `modules/updates/operation.ts:1811` | updater | read / wiring: `const hostId = context.hostMachineId` | Do not reserve, register, prepare, or grant a local coordinator update without a self-hosted placement. Continue eligible remote fleet steps; external-server update belongs to its deployment authority. |
| `modules/updates/operation.ts:2203` | updater | read / wiring: `if (context.hostMachineId && context.prepareCoordinatorUpdate && details &&` | Do not reserve, register, prepare, or grant a local coordinator update without a self-hosted placement. Continue eligible remote fleet steps; external-server update belongs to its deployment authority. |
| `modules/updates/operation.ts:2205` | updater | read / wiring: `const hostId = context.hostMachineId` | Do not reserve, register, prepare, or grant a local coordinator update without a self-hosted placement. Continue eligible remote fleet steps; external-server update belongs to its deployment authority. |
| `modules/updates/operation.ts:2269` | updater | read / wiring: `(context.hostMachineId !== undefined &&` | A machine-scoped coordinator grant cannot be active without its host; fail closed for that grant. External placement must also prevent a no-grant path from initiating local server replacement. |
| `modules/updates/operation.ts:2270` | updater | read / wiring: `(await context.updates.coordinatorGrantActive(context.hostMachineId, grant))))` | A machine-scoped coordinator grant cannot be active without its host; fail closed for that grant. External placement must also prevent a no-grant path from initiating local server replacement. |
| `modules/updates/operation.ts:2926` | updater | read / wiring: `if (context.hostMachineId && context.prepareCoordinatorUpdate && context.requestCoordinatorRestart) {` | Do not reserve, register, prepare, or grant a local coordinator update without a self-hosted placement. Continue eligible remote fleet steps; external-server update belongs to its deployment authority. |
| `modules/updates/operation.ts:2927` | updater | read / wiring: `context.updates.reserveCoordinatorUpdate(context.hostMachineId)` | Do not reserve, register, prepare, or grant a local coordinator update without a self-hosted placement. Continue eligible remote fleet steps; external-server update belongs to its deployment authority. |
| `modules/updates/operation.ts:2944` | updater | read / wiring: `...(context.hostMachineId ? { hostMachineId: context.hostMachineId } : {}),` | Carry an explicit server-is-external placement fact. No fleet member is the server; retain normal enrolled-fleet updates without inferring local server restart/delivery from a missing host id. |
| `modules/updates/service.ts:2066` | updater | read / wiring: `async operationChannel(hostMachineId?: string): Promise<UpdateChannel> {` | With no host row, use fleetDefaultChannel() (already supported), and advertise only its published target. Keep server-is-external placement separate from channel selection. |
| `modules/updates/service.ts:2067` | updater | read / wiring: `const host = hostMachineId` | With no host row, use fleetDefaultChannel() (already supported), and advertise only its published target. Keep server-is-external placement separate from channel selection. |
| `modules/updates/service.ts:2068` | updater | read / wiring: `? (await this.deps.machines()).find((candidate) => candidate.id === hostMachineId)` | With no host row, use fleetDefaultChannel() (already supported), and advertise only its published target. Keep server-is-external placement separate from channel selection. |
| `modules/updates/service.ts:2094` | updater | read / wiring: `async advertisedTarget(hostMachineId?: string): Promise<UpdateTarget &#124; undefined> {` | With no host row, use fleetDefaultChannel() (already supported), and advertise only its published target. Keep server-is-external placement separate from channel selection. |
| `modules/updates/service.ts:2095` | updater | read / wiring: `const channel = await this.operationChannel(hostMachineId)` | With no host row, use fleetDefaultChannel() (already supported), and advertise only its published target. Keep server-is-external placement separate from channel selection. |
| `modules/updates/trpc.ts:195` | updater | declaration: `hostMachineId?: string,` | Use the fleet default channel when no host exists; fleet snapshots/counts/legacy results describe enrolled machines, with separate external-server placement rather than a phantom coordinator. |
| `modules/updates/trpc.ts:197` | updater | read / wiring: `const channel = await updates.operationChannel(hostMachineId)` | Use the fleet default channel when no host exists; fleet snapshots/counts/legacy results describe enrolled machines, with separate external-server placement rather than a phantom coordinator. |
| `modules/updates/trpc.ts:288` | updater | declaration: `hostMachineId?: string` | Carry an explicit server-is-external placement fact. No fleet member is the server; retain normal enrolled-fleet updates without inferring local server restart/delivery from a missing host id. |
| `modules/updates/trpc.ts:321` | updater | read / wiring: `...(input.hostMachineId ? { hostMachineId: input.hostMachineId } : {}),` | Carry an explicit server-is-external placement fact. No fleet member is the server; retain normal enrolled-fleet updates without inferring local server restart/delivery from a missing host id. |
| `modules/updates/trpc.ts:379` | updater | read / wiring: `channel: await state.modules.updates.operationChannel(state.store.hostMachineId),` | Use the fleet default channel when no host exists; fleet snapshots/counts/legacy results describe enrolled machines, with separate external-server placement rather than a phantom coordinator. |
| `modules/updates/trpc.ts:383` | updater | declaration: `hostMachineId: state.store.hostMachineId,` | Carry an explicit server-is-external placement fact. No fleet member is the server; retain normal enrolled-fleet updates without inferring local server restart/delivery from a missing host id. |
| `modules/updates/trpc.ts:628` | updater | read / wiring: `state.store.hostMachineId,` | Use the fleet default channel when no host exists; fleet snapshots/counts/legacy results describe enrolled machines, with separate external-server placement rather than a phantom coordinator. |
| `modules/updates/trpc.ts:634` | updater | read / wiring: `const hostChannel = await updates.operationChannel(state.store.hostMachineId)` | Use the fleet default channel when no host exists; fleet snapshots/counts/legacy results describe enrolled machines, with separate external-server placement rather than a phantom coordinator. |
| `modules/updates/trpc.ts:682` | updater | declaration: `hostMachineId?: string,` | Use the fleet default channel when no host exists; fleet snapshots/counts/legacy results describe enrolled machines, with separate external-server placement rather than a phantom coordinator. |
| `modules/updates/trpc.ts:694` | updater | read / wiring: `const fleet = await fleetSnapshot(updates, undefined, hostMachineId)` | Use the fleet default channel when no host exists; fleet snapshots/counts/legacy results describe enrolled machines, with separate external-server placement rather than a phantom coordinator. |
| `modules/updates/trpc.ts:749` | default-machine | read / wiring: `const machineId = input?.id ? asMachineId(input.id) : state.store.hostMachineId` | An explicit id remains the repair target. Without a host, require an explicit eligible machine for payload repair; do not silently repair an arbitrary daemon or synthesize a server machine. |
| `modules/updates/trpc.ts:866` | updater | read / wiring: `state.store.hostMachineId,` | Use the fleet default channel when no host exists; fleet snapshots/counts/legacy results describe enrolled machines, with separate external-server placement rather than a phantom coordinator. |
| `relay.ts:744` | other | declaration: `hostMachineId: this.store.hostMachineId,` | Pass explicit absent server placement to MachinesService; never manufacture a fleet member for the server. |
| `relay.ts:804` | updater | read / wiring: `...(machine.id === machines.hostMachineId ? { coordinator: true } : {}),` | Mark no fleet machine as coordinator; supply the separate server-is-external placement fact to planning. |
| `relay.ts:1146` | transfer | declaration: `hostMachineId: machines.hostMachineId,` | No source fleet machine exists. Do not construct or accept a machine-to-machine transfer using a fabricated source; report this transfer path unavailable. Preserve installation identity/generation; any external-host transfer needs its own explicit transition contract. |
| `relay.ts:1194` | transfer | read / wiring: `sourceMachineId: this.store.hostMachineId,` | No source fleet machine exists. Do not construct or accept a machine-to-machine transfer using a fabricated source; report this transfer path unavailable. Preserve installation identity/generation; any external-host transfer needs its own explicit transition contract. |
| `relay.ts:1204` | transfer | read / wiring: `(machine) => machine.id === this.store.hostMachineId,` | No source fleet machine exists. Do not construct or accept a machine-to-machine transfer using a fabricated source; report this transfer path unavailable. Preserve installation identity/generation; any external-host transfer needs its own explicit transition contract. |
| `server.ts:626` | conjure | read / wiring: `const hostMachineId = readOrCreateLocalMachineId()` | Hosted boot must not read-or-create a machine identity. Obtain explicit external placement; an enrolled self-hosted machine keeps its existing id. |
| `server.ts:632` | other | read / wiring: `const store = await SessionStore.open(undefined, asMachineId(hostMachineId), {` | Open the store with explicit absent host placement; never cast or replace absence with a new UUID. |
| `server.ts:820` | transfer | read / wiring: `targetTransferRecovery({ machineId: hostMachineId }, config) &&` | Do not match/adopt a machine promotion or source journal using an absent host. Current machine-to-machine transfer requires proven enrolled endpoints; preserve installation identity/generation and fail unavailable for external-source initiation, without invented placement or boot assignment repair. |
| `server.ts:821` | transfer | read / wiring: `bootTargetPromotion?.targetMachineId === hostMachineId &&` | Do not match/adopt a machine promotion or source journal using an absent host. Current machine-to-machine transfer requires proven enrolled endpoints; preserve installation identity/generation and fail unavailable for external-source initiation, without invented placement or boot assignment repair. |
| `server.ts:888` | other | read / wiring: `localMachineId: asMachineId(hostMachineId),` | Repo discovery has no local-machine exemption: every enrolled machine is remote to this server. Do not skip a scan or adopt local repositories under a fabricated host. |
| `server.ts:982` | updater | read / wiring: `!machine.revokedAt && isRemoteUpdateConsumer(machine, hostMachineId),` | Treat all enrolled feed-capable consumers as remote when the server is external; keep revocation filtering. |
| `server.ts:1017` | updater | read / wiring: `machineId: hostMachineId,` | Do not start a local fleet update participant when the server has no machine. External server delivery is not a fleet participant. |
| `server.ts:1105` | updater | read / wiring: `channel: await registry.modules.updates.operationChannel(hostMachineId),` | Use the fleet default update channel when no host row exists; published targets remain valid independently of external server placement. |
| `server.ts:1109` | updater | read / wiring: `hostMachineId,` | Pass explicit server-is-external placement into update adoption/planning; do not let an omitted host mean an offline local coordinator. |
| `server.ts:1151` | transfer | read / wiring: `machineId: hostMachineId,` | Do not match/adopt a machine promotion or source journal using an absent host. Current machine-to-machine transfer requires proven enrolled endpoints; preserve installation identity/generation and fail unavailable for external-source initiation, without invented placement or boot assignment repair. |
| `server.ts:1221` | transfer | read / wiring: `deferredSourceJournal.record.sourceMachineId === hostMachineId &&` | Do not match/adopt a machine promotion or source journal using an absent host. Current machine-to-machine transfer requires proven enrolled endpoints; preserve installation identity/generation and fail unavailable for external-source initiation, without invented placement or boot assignment repair. |
| `server.ts:1249` | transfer | read / wiring: `machineId: hostMachineId,` | Do not match/adopt a machine promotion or source journal using an absent host. Current machine-to-machine transfer requires proven enrolled endpoints; preserve installation identity/generation and fail unavailable for external-source initiation, without invented placement or boot assignment repair. |
| `server.ts:1299` | transfer | read / wiring: `machineId: hostMachineId,` | Do not match/adopt a machine promotion or source journal using an absent host. Current machine-to-machine transfer requires proven enrolled endpoints; preserve installation identity/generation and fail unavailable for external-source initiation, without invented placement or boot assignment repair. |
| `server.ts:1429` | updater | read / wiring: `updateTarget: async () => registry.modules.updates.advertisedTarget(hostMachineId),` | Use the fleet default update channel when no host row exists; published targets remain valid independently of external server placement. |
| `server.ts:1440` | other | read / wiring: `registry.modules.machines.onlineMachineIds().includes(asMachineId(hostMachineId)),` | Report no local daemon connection (false); hosted readiness must not require a local daemon, and must not substitute any remote daemon to satisfy a self-hosted handover check. |
| `server.ts:1454` | other | read / wiring: `await store.machines.getMachineByToken(hostMachineId, token),` | No host-machine credential exists for this maintenance realm. Reject host-token authentication/remove that host-only route capability; never authenticate against an arbitrary fleet row. |
| `server.ts:1473` | other | read / wiring: `localMachineId: asMachineId(hostMachineId),` | Pass no local-machine exclusion to MaintenanceService. Its connect-scan command already names observed.machineId; with no host, every enrolled machine is remote and remains subject to the existing revocation, observation and run-key checks. |
| `store/conversations/index.ts:68` | conjure | declaration: `private readonly hostMachineId: MachineId,` | Remove the assumed-host constructor dependency. setMeta may update an existing conversation; refuse missing-row creation without authoritative placement, rather than inventing a conversation on the server. |
| `store/conversations/index.ts:223` | conjure | read / wiring: `machineId: this.hostMachineId,` | Remove the assumed-host constructor dependency. setMeta may update an existing conversation; refuse missing-row creation without authoritative placement, rather than inventing a conversation on the server. |
| `store/conversations.ts:22` | conjure | declaration: `hostMachineId: MachineId,` | Remove the assumed-host constructor dependency. setMeta may update an existing conversation; refuse missing-row creation without authoritative placement, rather than inventing a conversation on the server. |
| `store/conversations.ts:28` | conjure | read / wiring: `this.index = new ConversationIndexRepository(queries, hostMachineId)` | Remove the assumed-host constructor dependency. setMeta may update an existing conversation; refuse missing-row creation without authoritative placement, rather than inventing a conversation on the server. |
| `store/issues.ts:882` | historical backfill | read / wiring: `): Promise<{ hostMachineId: MachineId; backfilled: number; skipped: number } &#124; undefined> {` | Confine this helper/receipt/query to the one-time historical migration. Require proven historical machine identity; absent that evidence, leave unresolved rows for explicit recovery and do not write a host receipt or infer placement at boot. |
| `store/issues.ts:889` | historical backfill | read / wiring: `const hostMachineId = host.id` | Confine this helper/receipt/query to the one-time historical migration. Require proven historical machine identity; absent that evidence, leave unresolved rows for explicit recovery and do not write a host receipt or infer placement at boot. |
| `store/issues.ts:890` | historical backfill | read / wiring: `const { legacyWorktreeRow, contradictorySession } = this.legacyWorktreeTerms(hostMachineId)` | Confine this helper/receipt/query to the one-time historical migration. Require proven historical machine identity; absent that evidence, leave unresolved rows for explicit recovery and do not write a host receipt or infer placement at boot. |
| `store/issues.ts:891` | historical backfill | read / wiring: `const skipped = (await this.legacyWorktreeSkippedQuery(hostMachineId).get())?.c ?? 0` | Confine this helper/receipt/query to the one-time historical migration. Require proven historical machine identity; absent that evidence, leave unresolved rows for explicit recovery and do not write a host receipt or infer placement at boot. |
| `store/issues.ts:900` | historical backfill | read / wiring: `.set({ machineId: hostMachineId })` | Confine this helper/receipt/query to the one-time historical migration. Require proven historical machine identity; absent that evidence, leave unresolved rows for explicit recovery and do not write a host receipt or infer placement at boot. |
| `store/issues.ts:906` | historical backfill | read / wiring: `value: JSON.stringify({ hostMachineId, backfilled, skipped }),` | Confine this helper/receipt/query to the one-time historical migration. Require proven historical machine identity; absent that evidence, leave unresolved rows for explicit recovery and do not write a host receipt or infer placement at boot. |
| `store/issues.ts:908` | historical backfill | read / wiring: `return { hostMachineId, backfilled, skipped }` | Confine this helper/receipt/query to the one-time historical migration. Require proven historical machine identity; absent that evidence, leave unresolved rows for explicit recovery and do not write a host receipt or infer placement at boot. |
| `store/issues.ts:917` | historical backfill | read / wiring: `private legacyWorktreeTerms(hostMachineId: MachineId) {` | Confine this helper/receipt/query to the one-time historical migration. Require proven historical machine identity; absent that evidence, leave unresolved rows for explicit recovery and do not write a host receipt or infer placement at boot. |
| `store/issues.ts:934` | historical backfill | read / wiring: `ne(sessions.machineId, hostMachineId),` | Confine this helper/receipt/query to the one-time historical migration. Require proven historical machine identity; absent that evidence, leave unresolved rows for explicit recovery and do not write a host receipt or infer placement at boot. |
| `store/issues.ts:942` | historical backfill | read / wiring: `private legacyWorktreeSkippedQuery(hostMachineId: MachineId) {` | Confine this helper/receipt/query to the one-time historical migration. Require proven historical machine identity; absent that evidence, leave unresolved rows for explicit recovery and do not write a host receipt or infer placement at boot. |
| `store/issues.ts:943` | historical backfill | read / wiring: `const { legacyWorktreeRow, contradictorySession } = this.legacyWorktreeTerms(hostMachineId)` | Confine this helper/receipt/query to the one-time historical migration. Require proven historical machine identity; absent that evidence, leave unresolved rows for explicit recovery and do not write a host receipt or infer placement at boot. |
| `store/issues.ts:957` | historical backfill | read / wiring: `legacyWorktreeContradictionSql(hostMachineId: MachineId): string {` | Confine this helper/receipt/query to the one-time historical migration. Require proven historical machine identity; absent that evidence, leave unresolved rows for explicit recovery and do not write a host receipt or infer placement at boot. |
| `store/issues.ts:958` | historical backfill | read / wiring: `return this.legacyWorktreeSkippedQuery(hostMachineId).toSQL().sql` | Confine this helper/receipt/query to the one-time historical migration. Require proven historical machine identity; absent that evidence, leave unresolved rows for explicit recovery and do not write a host receipt or infer placement at boot. |
| `store/repos.ts:91` | conjure | comment: `/** This host's minted machine id (`SessionStore.hostMachineId`) — the machine` | Keep a matching registered repo identity. If no registered root matches, refuse the path-derived fallback instead of deriving an id from an invented host; remove the obsolete host dependency/comment. |
| `store/repos.ts:93` | conjure | declaration: `private readonly hostMachineId: MachineId,` | Keep a matching registered repo identity. If no registered root matches, refuse the path-derived fallback instead of deriving an id from an invented host; remove the obsolete host dependency/comment. |
| `store/repos.ts:499` | conjure | read / wiring: `const hostMachineId = this.hostMachineId` | Keep a matching registered repo identity. If no registered root matches, refuse the path-derived fallback instead of deriving an id from an invented host; remove the obsolete host dependency/comment. |
| `store/repos.ts:507` | conjure | read / wiring: `return match?.repoId ?? deriveRepoId({ machineId: hostMachineId, path: normalizedRepoPath })` | Keep a matching registered repo identity. If no registered root matches, refuse the path-derived fallback instead of deriving an id from an invented host; remove the obsolete host dependency/comment. |
| `store.ts:239` | other | declaration: `readonly hostMachineId: MachineId` | Carry explicit absence through store construction; do not cast absence to a MachineId or synthesize an identity. |
| `store.ts:256` | conjure | read / wiring: `hostMachineId: MachineId = asMachineId(randomUUID()),` | Remove the implicit random UUID mint for a hostless store; fixtures needing a host must provide one explicitly. |
| `store.ts:321` | other | read / wiring: `const store = new SessionStore(path, hostMachineId, options, database, executor)` | Carry explicit absence through store construction; do not cast absence to a MachineId or synthesize an identity. |
| `store.ts:332` | other | declaration: `hostMachineId: MachineId,` | Carry explicit absence through store construction; do not cast absence to a MachineId or synthesize an identity. |
| `store.ts:340` | other | read / wiring: `this.hostMachineId = asMachineId(hostMachineId)` | Carry explicit absence through store construction; do not cast absence to a MachineId or synthesize an identity. |
| `store.ts:378` | conjure | read / wiring: `this.hostMachineId,` | Stop forwarding an assumed host to fallback row creation; repositories must preserve known placement or refuse a placement-less creation. |
| `store.ts:383` | conjure | read / wiring: `this.conversations = new ConversationsRepository(this.queries, this.hostMachineId)` | Stop forwarding an assumed host to fallback row creation; repositories must preserve known placement or refuse a placement-less creation. |
| `store.ts:466` | historical backfill | read / wiring: `const result = await this.issues.backfillLegacyWorktreeMachineIds(this.hostMachineId)` | Use the one-time historical migration and its recorded evidence only. With no proven historical host, do not stamp rows or report a fabricated host; no boot-time repair or owner inference. |
| `store.ts:469` | historical backfill | read / wiring: ``[podium:store] pinned ${result.backfilled} legacy worktree issue(s) to ${result.hostMachineId}; ` +` | Use the one-time historical migration and its recorded evidence only. With no proven historical host, do not stamp rows or report a fabricated host; no boot-time repair or owner inference. |

## S9 handoff

- POD-4164: updater rows, especially the unrestricted server-step condition in `operation.ts:1083`; optional host fields alone do not express external deployment.
- POD-4165: conjure and default-machine rows, including issue workflow, GC, and payload repair’s implicit target.
- POD-4149 coordinator: identity plumbing, local filesystem/health semantics, and cross-phase coordination with S5 for shared-secret hello, host enrolment/custody and transfer promotion. These are assignments for the existing phase, not new implementation scope in this inventory.
- Historical backfill: retain one-time evidence and receipts; a hosted runtime must not backfill by choosing a currently available daemon. Part C mentions repos.json, but no production `hostMachineId` occurrence for that import remains in this snapshot; the repo occurrences above are conjure, not historical import.

## Search exclusions (fully accounted)

These are fixture/test assertions, not production work-order rows. When making host placement optional, update affected fixtures to state whether they model self-hosted or hosted; never restore production UUID defaults to satisfy tests. `modules/sessions/oracle-support.ts` and `test-support/open-test-store.ts` are explicitly included here as test helpers despite not having `.test.ts` names.

| Test/helper file (under apps/server/src) | Matching lines |
|---|---:|
| `causal-observation-gate.test.ts` | 27 |
| `characterization.test.ts` | 9 |
| `conversations.ledger.test.ts` | 3 |
| `enrollment-durability.test.ts` | 2 |
| `event-log.test.ts` | 4 |
| `gateway/machine-keypair.test.ts` | 2 |
| `gateway/peer-handshake.test.ts` | 4 |
| `gateway/reattach-storm.integration.test.ts` | 1 |
| `gateway/wire-window.integration.test.ts` | 1 |
| `issues.attach.test.ts` | 4 |
| `issues.normalized-wire.test.ts` | 1 |
| `issues.test.ts` | 22 |
| `ledger.baseline-fold.test.ts` | 2 |
| `ledger.commit-application.test.ts` | 1 |
| `machine-components.test.ts` | 3 |
| `machine-supersession.test.ts` | 1 |
| `migrations/customer-upgrade-fixture.test.ts` | 2 |
| `migrations/pre-migrated-fixture.test.ts` | 2 |
| `modules/cost/service.test.ts` | 1 |
| `modules/daemon-request.test.ts` | 2 |
| `modules/issue-session-lifecycle.sweep-reap.test.ts` | 1 |
| `modules/issues/registry.test.ts` | 1 |
| `modules/lock/session-exit.test.ts` | 6 |
| `modules/machines/facts.test.ts` | 1 |
| `modules/machines/service.test.ts` | 12 |
| `modules/machines/version-state.test.ts` | 3 |
| `modules/messages/cutover.test.ts` | 2 |
| `modules/server-transfer/upload-fence.test.ts` | 2 |
| `modules/sessions/archive-park.test.ts` | 4 |
| `modules/sessions/broadcast-issue-skip.test.ts` | 2 |
| `modules/sessions/command-plane.test.ts` | 1 |
| `modules/sessions/contract-input-recency.test.ts` | 5 |
| `modules/sessions/deterministic-status.test.ts` | 3 |
| `modules/sessions/model-validation-wiring.test.ts` | 2 |
| `modules/sessions/oracle-ask-upload.test.ts` | 14 |
| `modules/sessions/oracle-attribution.test.ts` | 3 |
| `modules/sessions/oracle-authz.test.ts` | 1 |
| `modules/sessions/oracle-commands.test.ts` | 20 |
| `modules/sessions/oracle-decomposition.test.ts` | 9 |
| `modules/sessions/oracle-errors.test.ts` | 7 |
| `modules/sessions/oracle-idempotency.test.ts` | 2 |
| `modules/sessions/oracle-session-state.test.ts` | 4 |
| `modules/sessions/oracle-support.ts` | 2 |
| `modules/sessions/rename-offline.test.ts` | 1 |
| `modules/sessions/rename-shadow.test.ts` | 1 |
| `modules/sessions/session-control-identity.test.ts` | 1 |
| `modules/sessions/session-meta-ops.test.ts` | 1 |
| `modules/sessions/session-start.test.ts` | 23 |
| `modules/sessions/session-state/registry.test.ts` | 2 |
| `modules/sessions/spawn-account-env.test.ts` | 2 |
| `modules/sessions/spawn-model-defaults.test.ts` | 2 |
| `modules/sessions/spawn-name.test.ts` | 1 |
| `modules/sessions/stop.test.ts` | 4 |
| `modules/sessions/terminal-sizing-claims.test.ts` | 16 |
| `modules/sessions/viewport-request.test.ts` | 4 |
| `modules/updates/operation.test.ts` | 12 |
| `offer.test.ts` | 11 |
| `relay-agent-relay.test.ts` | 1 |
| `relay.archive-cascade.test.ts` | 1 |
| `relay.conversation-registry.test.ts` | 7 |
| `relay.draft-reap.test.ts` | 19 |
| `relay.issue-session-delete.test.ts` | 1 |
| `relay.model-catalog.test.ts` | 4 |
| `relay.outbox.test.ts` | 35 |
| `relay.test.ts` | 418 |
| `repo-registry.test.ts` | 1 |
| `restart-notification-storm.integration.test.ts` | 9 |
| `router.auth.test.ts` | 1 |
| `router.cloud.test.ts` | 7 |
| `router.machines.test.ts` | 2 |
| `router.setup.test.ts` | 2 |
| `router.test.ts` | 9 |
| `router.updates.test.ts` | 24 |
| `search.test.ts` | 1 |
| `server.role.test.ts` | 9 |
| `session-cutover.audit.test.ts` | 2 |
| `sessions.ledger.test.ts` | 3 |
| `sessions.refs.test.ts` | 2 |
| `store.legacy-worktree-machine.test.ts` | 1 |
| `store.lifecycle.test.ts` | 6 |
| `store.machines.test.ts` | 9 |
| `store.refs.test.ts` | 5 |
| `store.repo-id.test.ts` | 4 |
| `store.search-index.test.ts` | 2 |
| `store.test.ts` | 8 |
| `store/prepared-loop-scaling.test.ts` | 1 |
| `store/runtime-events.test.ts` | 49 |
| `store/users-disable.test.ts` | 3 |
| `store/users-remove.test.ts` | 1 |
| `superagent-concierge.test.ts` | 5 |
| `superagent-headless.test.ts` | 14 |
| `superagent.test.ts` | 15 |
| `terminal-hibernation-proof.test.ts` | 31 |
| `test-support/open-test-store.ts` | 2 |
| `transport-compression.integration.test.ts` | 1 |
| `wsServer.client-auth.test.ts` | 3 |

## Validation

The table keys were checked against the current recursive literal search: exactly one row for every production matching line, with no missing/duplicate locations. No runtime behavior changed and no specialized runtime lane is warranted. Checkout-local setup completed. `bun run test`: lean gate green; typecheck and span-effect lint succeeded, and 129 tests ran across 4 of 1375 node-project files (not a full-suite result). The coordinator requested this document be committed and landed on the integration branch after artifact review; no runtime code changes are included.
