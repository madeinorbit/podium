/**
 * THE FIVE CLOUD RUNTIME CONTRACTS — `cloud.createMachine · cloud.createAgent ·
 * cloud.moveSession · cloud.stop · cloud.wake`.
 *
 * Provisioning and lifecycle for HOSTED runtimes: cloud machines, cloud agents,
 * and the move that lifts a local session into one. `capabilities` and `runtime`
 * stay queries.
 *
 * ---------------------------------------------------------------------------
 * CLASSIFICATION: `owned-compute`, AND THE LINT AGREES BY CONSTRUCTION
 * ---------------------------------------------------------------------------
 *
 * ADR 9 D3 rule 3 — facts about a machine inherit the machine's scoping — and a
 * cloud runtime IS a machine, differing from a registered one only in who racks
 * it. `classificationErrors` requires `resource: 'machine'` for this class, which
 * is the correct row gate: there is nothing else for a runtime's grants to hang
 * on.
 *
 * ---------------------------------------------------------------------------
 * TWO VERBS, AND THE SPLIT IS THE ONE JUDGEMENT IN THIS FILE
 * ---------------------------------------------------------------------------
 *
 * `createMachine`, `createAgent`, `stop` and `wake` are `manage`: they PROVISION
 * AND DESTROY compute, they cost money, and they are the acts that decide what
 * hardware exists at all. `moveSession` is `use` — it places an EXISTING session
 * onto compute, which is the same code-execution boundary a spawn crosses
 * (readiness §3.1.4 M2), and grading it `manage` would mean a member who may run
 * work on a tenant could not relocate their own session onto it.
 *
 * The distinction is not cosmetic: it is the difference between "may spend this
 * tenant's budget" and "may run there". A single grade would have collapsed them
 * and forced one of the two to be wrong.
 *
 * ---------------------------------------------------------------------------
 * ONLINE-ONLY, ALL FIVE — D18.3 IS UNARGUABLE HERE
 * ---------------------------------------------------------------------------
 *
 * ADR 3 Amendment 1 D18.3: a command that executes on owned compute may not be
 * queued and replayed after the world has moved. For provisioning the failure is
 * expensive rather than merely wrong — a queued `createMachine` drained after a
 * reconnect bills for a runtime nobody is waiting for, and a queued `stop`
 * replayed against a recycled id stops something else.
 */

import { IssueIdField, SessionIdField } from '@podium/model'
import { z } from 'zod'
import type {
  AttributionPolicy,
  CommandContract,
  DeliveryPolicy,
  ErrorConsistency,
  RedactionPolicy,
  TransportTag,
  VisibilityClass,
} from '../contract'

/** `trpc` alone — the web cloud panel is the only caller. No CLI verb and no MCP
 *  tool names any of these; measured rather than assumed. */
const SERVED_ON: readonly TransportTag[] = ['trpc']

const CLOUD_VISIBILITY: VisibilityClass = 'owned-compute'

const CLOUD_DELIVERY: DeliveryPolicy = {
  class: 'online-only',
  outboxReconciliation:
    'NEVER queued (ADR 3 Amendment 1 D18.3). These provision, destroy and place work on hosted ' +
    'compute, and a replay after the world moved is expensive rather than merely wrong: a drained ' +
    '`createMachine` bills for a runtime nobody awaits, a drained `stop` can hit a recycled id, and ' +
    'a drained `moveSession` would lift a session whose local state has since changed. ADR 3 D4 ' +
    'rule 4 also applies — the relay’s durable agent queue is a delivery mechanism for an ' +
    'already-authorized ONLINE command, never an Outbox offline class.',
  applyTimeReauthorization:
    'Re-authorized at every apply against the delegation resolved LIVE (ADR 9 D5 A1), never a ' +
    'capability frozen at spawn: losing the tenant grant between call and apply denies the command. ' +
    'The provider is also consulted per call — a tenant whose plan no longer permits a size is ' +
    'refused by the provider rather than by a cached answer.',
}

const CLOUD_REDACTION: RedactionPolicy = {
  reviewed: true,
  inputPaths: [],
  outputPaths: [],
  note:
    'No credential crosses this surface, and the candidates were named rather than waved past. ' +
    '`tenantId` is a routing key a refusal must state to be actionable. The repo descriptor is ' +
    'owner/name on a PUBLIC forge coordinate — no token, no clone URL with credentials in it; the ' +
    'provider holds its own forge credential and this command never carries one. `purpose` and ' +
    '`displayName` are human labels. The RESULT is a runtime descriptor (id, status, size) and ' +
    'carries no connection secret back, which is why `outputPaths` is empty rather than unexamined.',
}

const CLOUD_ATTRIBUTION: AttributionPolicy = {
  actor: 'from-capability',
  onBehalfOf: 'from-delegation',
  wirePlacement: 'separate-field',
  reservedWireKeys: ['actor', 'onBehalfOf'],
  rationale:
    'Both halves from the transport principal, never from payload. These commands SPEND MONEY and ' +
    'start compute, so "who asked" is the accountability record that matters most in the whole ' +
    'command plane — and `tenantId` is a routing address, which Amendment 1 D17 forbids doubling as ' +
    'the record. An agent provisioning on its human’s behalf must be distinguishable from the human.',
}

/**
 * readiness §3.1.4 M5 over Amendment 1 D20.2, the machine carve-out, for the same
 * reason it applies to every other owned-compute family: "you may not use this
 * tenant" and "this runtime is gone" demand different actions from the caller,
 * and collapsing them makes hosted compute unusable. The shipped surface already
 * behaves this way — an unconfigured provider raises
 * `CloudRuntimeUnavailableError` and surfaces as PRECONDITION_FAILED, which is a
 * different refusal from a denied grant.
 */
const CLOUD_ERRORS: ErrorConsistency = {
  callerSuppliedTargetId: true,
  invisibleFailsAs: 'nonexistent',
  distinguishesUnauthorizedFromUnreachable: true,
  note:
    'M5 wins at the machine boundary: an unavailable or unconfigured provider fails ' +
    'PRECONDITION_FAILED while a denied tenant grant fails as a refusal, because "not yours" and ' +
    '"not there" need different responses. D20.2 still governs inside a tenant the caller may ' +
    'already use — an unknown runtime id and one belonging to another tenant fail alike, so the id ' +
    'space cannot be iterated to enumerate someone else’s runtimes.',
}

const CREATES_A_RUNTIME = {
  creates: ['cloud-runtime'],
  owner: 'on-behalf-of-human',
  visibility: CLOUD_VISIBILITY,
  inheritanceOnCreate: 'parent',
  note:
    'A new runtime inherits the TENANT it was provisioned in (ADR 9 D3 rule 3), which is what ' +
    '`inheritanceOnCreate: "parent"` records — the `owner` field admits one literal and cannot ' +
    'express an inherits-from-tenant rule, so the inheritance column carries it. Nobody gains or ' +
    'loses sight of a runtime by creating one; the tenant already decided who can see it.',
} as const

const CREATES_NOTHING = {
  creates: [],
  note: 'Acts on a runtime that already exists. Mints no entity and moves no ownership.',
} as const

// ---------------------------------------------------------------------------
// Shared input pieces — the SAME objects the shipped surface validated with
// ---------------------------------------------------------------------------

export const cloudRepoInput = z.object({
  provider: z.literal('github'),
  owner: z.string().min(1),
  name: z.string().min(1),
  ref: z.string().min(1).optional(),
})

export const cloudRuntimeSizeInput = z.enum(['small', 'medium', 'large'])

export const cloudSourceSessionInput = z.object({
  sessionId: z.string().min(1).pipe(SessionIdField),
  agent: z.enum(['claude-code', 'codex']),
  resumeRef: z.string().min(1).optional(),
  cwd: z.string().min(1).optional(),
  machineId: z.string().min(1).optional(),
})

export const cloudRuntimeIdInput = z.object({ id: z.string().min(1) })

// ---------------------------------------------------------------------------
// cloud.createMachine
// ---------------------------------------------------------------------------

export const cloudCreateMachineInput = z.object({
  tenantId: z.string().min(1),
  displayName: z.string().min(1),
  size: cloudRuntimeSizeInput,
  repo: cloudRepoInput.optional(),
  purpose: z.string().optional(),
})

export const cloudCreateMachineContract = {
  name: 'cloud.createMachine',
  version: 1,
  visibility: CLOUD_VISIBILITY,
  input: cloudCreateMachineInput,
  policy: {
    action: 'manage',
    roleFloor: 'admin',
    resource: 'machine',
    confirmation: 'confirm',
    rationale:
      'Provisions a billed cloud machine, so `manage`/`admin`: deciding what hardware exists and ' +
      'what it costs is administration of the tenant, not work inside it. `confirmation: "confirm"` ' +
      'even though nothing is destroyed — ADR 3 D2’s confirmation is for writes whose consequences ' +
      'the caller cannot easily undo, and an accidental `large` runtime bills until someone notices. ' +
      '`size` is REQUIRED here where `createAgent` leaves it optional, and that asymmetry is the ' +
      'shipped schema kept verbatim: a bare machine has no workload to infer a size from.',
    machineVerb: 'manage',
  },
  exposure: SERVED_ON,
  delivery: CLOUD_DELIVERY,
  redaction: CLOUD_REDACTION,
  ownership: CREATES_A_RUNTIME,
  attribution: CLOUD_ATTRIBUTION,
  errorConsistency: CLOUD_ERRORS,
  conflict: 'cmd',
  conflictRule:
    'Provisions an external cloud machine and mints its fleet row in one commit; the provider request is keyed so a retry adopts the existing machine rather than provisioning a second',
} as const satisfies CommandContract<typeof cloudCreateMachineInput>

// ---------------------------------------------------------------------------
// cloud.createAgent
// ---------------------------------------------------------------------------

export const cloudCreateAgentInput = z.object({
  tenantId: z.string().min(1),
  displayName: z.string().min(1),
  size: cloudRuntimeSizeInput.optional(),
  repo: cloudRepoInput,
  issueId: IssueIdField.optional(),
  purpose: z.string().optional(),
  sourceSession: cloudSourceSessionInput.optional(),
})

export const cloudCreateAgentContract = {
  name: 'cloud.createAgent',
  version: 1,
  visibility: CLOUD_VISIBILITY,
  input: cloudCreateAgentInput,
  policy: {
    action: 'manage',
    roleFloor: 'admin',
    resource: 'machine',
    confirmation: 'confirm',
    rationale:
      'Provisions a billed cloud agent — `createMachine`’s grade and for its reasons. `repo` is ' +
      'REQUIRED here and optional on `createMachine`, which is the shipped schema and the right ' +
      'shape: an agent exists to work on a checkout, a bare machine does not. Note the surface this ' +
      'shares with `moveSession`: `sourceSession` lets a caller seed a new runtime from an existing ' +
      'session WITHOUT hibernating the local one, which is why `moveSession` is a separate command ' +
      'rather than a flag — the two differ in what happens to the session you already have.',
    machineVerb: 'manage',
  },
  exposure: SERVED_ON,
  delivery: CLOUD_DELIVERY,
  redaction: CLOUD_REDACTION,
  ownership: CREATES_A_RUNTIME,
  attribution: CLOUD_ATTRIBUTION,
  errorConsistency: CLOUD_ERRORS,
  conflict: 'cmd',
  conflictRule:
    'As cloud.createMachine — the provider call is the commit point and a retry adopts rather than duplicates',
} as const satisfies CommandContract<typeof cloudCreateAgentInput>

// ---------------------------------------------------------------------------
// cloud.moveSession
// ---------------------------------------------------------------------------

export const cloudMoveSessionInput = z.object({
  sessionId: z.string().min(1).pipe(SessionIdField),
  tenantId: z.string().min(1),
  size: cloudRuntimeSizeInput.optional(),
  repo: cloudRepoInput.optional(),
  hibernateLocal: z.boolean().optional(),
})

/**
 * THE ONE COMMAND HERE THAT WRITES SOMETHING OTHER THAN A RUNTIME, and it is why
 * this contract is not a copy of `createAgent`'s.
 *
 * With `hibernateLocal`, it parks the LOCAL session — a `personal` write on a
 * session row — in addition to provisioning. The visibility class stays
 * `owned-compute` because that is the state the command is ABOUT and the class
 * the gate hangs on, but the local hibernate is a real second effect and the
 * handler orders it deliberately: the runtime is created FIRST and the local
 * session parked only after it succeeds, so a provisioning failure never leaves
 * the user with a hibernated session and nowhere for it to have gone.
 */
export const cloudMoveSessionContract = {
  name: 'cloud.moveSession',
  version: 1,
  visibility: CLOUD_VISIBILITY,
  input: cloudMoveSessionInput,
  policy: {
    action: 'write',
    roleFloor: 'member',
    resource: 'machine',
    confirmation: 'none',
    rationale:
      '`use` AND `member`, where the other four are `manage`/`admin`, and this is the judgement the ' +
      'file header sets out. Moving a session PLACES EXISTING WORK on compute — the same ' +
      'code-execution boundary a spawn crosses (readiness §3.1.4 M2) — rather than deciding what ' +
      'hardware exists. Grading it `manage` would mean a member who may run work on a tenant could ' +
      'not relocate their own session onto it, which is the difference between "may spend this ' +
      'tenant’s budget" and "may run there". `write` rather than `manage` for the same reason, and ' +
      'because with `hibernateLocal` it writes the caller’s own session row. No confirmation: the ' +
      'local session is HIBERNATED rather than killed, and the handler refuses outright when it ' +
      'cannot be parked safely — the guard is a precondition, not a dialog.',
    machineVerb: 'use',
  },
  exposure: SERVED_ON,
  delivery: CLOUD_DELIVERY,
  redaction: CLOUD_REDACTION,
  ownership: CREATES_A_RUNTIME,
  attribution: CLOUD_ATTRIBUTION,
  errorConsistency: CLOUD_ERRORS,
  conflict: 'cmd',
  conflictRule:
    'Relocates a session to another machine; a move racing a second move is refused rather than applied twice, since a session has exactly one placement',
} as const satisfies CommandContract<typeof cloudMoveSessionInput>

// ---------------------------------------------------------------------------
// cloud.stop · cloud.wake
// ---------------------------------------------------------------------------

export const cloudStopInput = cloudRuntimeIdInput

export const cloudStopContract = {
  name: 'cloud.stop',
  version: 1,
  visibility: CLOUD_VISIBILITY,
  input: cloudStopInput,
  policy: {
    action: 'manage',
    roleFloor: 'admin',
    resource: 'machine',
    confirmation: 'confirm',
    rationale:
      'Stops a runtime, terminating whatever is running on it. `manage`/`admin` because it disposes ' +
      'of compute, and `confirmation: "confirm"` because it is the destructive direction — work in ' +
      'flight on that runtime does not survive, and the caller may not be the person who started ' +
      'it. Symmetric with `wake` in grade but not in consequence, which is why only this one and ' +
      'the two provisioning commands carry a confirmation.',
    machineVerb: 'manage',
  },
  exposure: SERVED_ON,
  delivery: CLOUD_DELIVERY,
  redaction: CLOUD_REDACTION,
  ownership: CREATES_NOTHING,
  attribution: CLOUD_ATTRIBUTION,
  errorConsistency: CLOUD_ERRORS,
  conflict: 'cmd',
  conflictRule:
    'Idempotent stop; stopping an already-stopped machine is a no-op rather than a rejection',
} as const satisfies CommandContract<typeof cloudStopInput>

export const cloudWakeInput = cloudRuntimeIdInput

export const cloudWakeContract = {
  name: 'cloud.wake',
  version: 1,
  visibility: CLOUD_VISIBILITY,
  input: cloudWakeInput,
  policy: {
    action: 'manage',
    roleFloor: 'admin',
    resource: 'machine',
    confirmation: 'none',
    rationale:
      'Resumes a stopped runtime. `manage`/`admin` because waking one RESTARTS BILLING, which is the ' +
      'same authority as provisioning pointed at an existing runtime — that is the reason it is not ' +
      'graded `use` despite looking like the harmless half of the pair. NO confirmation, unlike ' +
      '`stop`: waking is additive, loses nothing, and is undone by stopping again.',
    machineVerb: 'manage',
  },
  exposure: SERVED_ON,
  delivery: CLOUD_DELIVERY,
  redaction: CLOUD_REDACTION,
  ownership: CREATES_NOTHING,
  attribution: CLOUD_ATTRIBUTION,
  errorConsistency: CLOUD_ERRORS,
  conflict: 'cmd',
  conflictRule:
    'Idempotent wake; a concurrent wake joins the in-flight one rather than starting a second boot',
} as const satisfies CommandContract<typeof cloudWakeInput>

export const CLOUD_CONTRACTS = {
  createMachine: cloudCreateMachineContract,
  createAgent: cloudCreateAgentContract,
  moveSession: cloudMoveSessionContract,
  stop: cloudStopContract,
  wake: cloudWakeContract,
} as const

export type CloudContractName = keyof typeof CLOUD_CONTRACTS

export const CLOUD_CONTRACT_NAMES = Object.keys(CLOUD_CONTRACTS).sort() as CloudContractName[]
