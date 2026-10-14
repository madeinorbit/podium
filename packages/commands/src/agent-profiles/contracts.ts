/**
 * AGENT PROFILES — `agentProfiles.create · update · delete · import`
 * (POD-6107, flight deck decisions D3/D4).
 *
 * A profile is a named agent setup (ordered harness/model/effort candidates, an
 * optional machine, optional instructions) that issues and sessions point at.
 * It is instance-wide configuration: the matrix row `agent-profiles` is
 * `deployment-substrate` with no owner, so the writes take the instance
 * settings' policy — ADMIN floor, never queued. Decision D4 adds one rule the
 * role floor cannot express: profiles are edited by PEOPLE only. An agent may
 * pick a profile (`--profile` on an issue or a spawn) but every command here
 * refuses an agent-session caller; that check lives in `AgentProfileService`.
 *
 * The reads (`list`, `show`, `export`) are a query table on the server, not
 * contracts: a visibility class describes what a command WRITES.
 */

import {
  AgentCandidates,
  AgentProfileName,
  MAX_AGENT_PROFILE_INSTRUCTIONS,
} from '@podium/model'
import { z } from 'zod'
import type {
  AttributionPolicy,
  CommandContract,
  CreationOwnership,
  DeliveryPolicy,
  ErrorConsistency,
  RedactionPolicy,
  TransportTag,
} from '../contract'

const SERVED_ON: readonly TransportTag[] = ['trpc']

/** A profile by id or by name (names are unique, so either addresses one row). */
export const AgentProfileRef = z.string().trim().min(1).max(100)
const Description = z.string().trim().max(2_000)
const Instructions = z.string().max(MAX_AGENT_PROFILE_INSTRUCTIONS)
/** A machine name or id; null clears it. */
const MachineRef = z.string().trim().max(200).nullable()

export const agentProfileCreateInput = z.object({
  name: AgentProfileName,
  description: Description.default(''),
  candidates: AgentCandidates.default([]),
  machine: MachineRef.optional(),
  instructions: Instructions.default(''),
})

export const agentProfileUpdateInput = z.object({
  ref: AgentProfileRef,
  name: AgentProfileName.optional(),
  description: Description.optional(),
  candidates: AgentCandidates.optional(),
  machine: MachineRef.optional(),
  instructions: Instructions.optional(),
})

export const agentProfileDeleteInput = z.object({ ref: AgentProfileRef })

export const agentProfileImportInput = z.object({
  files: z
    .array(
      z.object({
        /** The file name without `.md`, used when the frontmatter has no `name:`. */
        name: z.string().trim().max(100).optional(),
        text: z.string().max(MAX_AGENT_PROFILE_INSTRUCTIONS + 10_000),
      }),
    )
    .min(1)
    .max(100),
})

const POLICY_RATIONALE =
  'Instance-wide configuration every issue and session may point at, so the floor is ADMIN — the ' +
  'matrix row `agent-profiles` says "Write is admin-grade, and never an agent session’s", the ' +
  'same answer as instance preferences. `resource: "settings-domain"`: the gate is the ' +
  'configuration surface, not a person’s row. No `machineVerb`: saving a profile that names a ' +
  'machine places no work there; `use` is checked when a session actually spawns. Flight deck D4 ' +
  'adds the people-only rule (an agent session is refused even under an admin’s delegation), which ' +
  'the service enforces because a role floor cannot say it.'

/** The matrix row's rule: a save replaces the whole profile, and the later
 *  Authority commit wins outright — never field-merged. */
const CONFLICT_RULE =
  'ROW.agentProfiles declared rule; a save replaces the whole profile and the later Authority commit wins outright'

const DELIVERY: DeliveryPolicy = {
  class: 'online-only',
  outboxReconciliation:
    'NEVER queued. Profile edits are rare, made from the CLI or a settings screen with the server ' +
    'in reach, and a replayed edit could silently undo a newer one. Nothing is lost by refusing ' +
    'offline: the caller is told and runs it again.',
  applyTimeReauthorization:
    'Re-authorized live at apply: the caller’s role is read at that moment, so an admin demoted ' +
    'mid-call is refused.',
}

const REDACTION: RedactionPolicy = {
  reviewed: true,
  inputPaths: [],
  outputPaths: [],
  note:
    'Nothing redacted. A profile holds harness and model NAMES, effort levels, a machine reference ' +
    'and instruction text written by the instance’s own people — no credential, unlike the older ' +
    '`execution_profiles`, which names a managed account.',
}

const OWNERSHIP: CreationOwnership = {
  creates: [],
  note:
    'A profile row has no owner (`owner: { kind: "none", reason: "substrate" }`): it belongs to the ' +
    'deployment, like an instance preference, so there is no ADR 9 D5 A4 owner to assign and no ' +
    'grant to inherit. `created_by`/`updated_by` record who wrote it, as history only.',
}

const ATTRIBUTION: AttributionPolicy = {
  actor: 'from-capability',
  onBehalfOf: 'from-delegation',
  wirePlacement: 'separate-field',
  reservedWireKeys: ['actor', 'onBehalfOf'],
  rationale:
    'Both halves from the transport principal, never from the payload. The actor half is also what ' +
    'the people-only rule reads: an agent session as actor is refused.',
}

const ERRORS: ErrorConsistency = {
  callerSuppliedTargetId: true,
  invisibleFailsAs: 'nonexistent',
  distinguishesUnauthorizedFromUnreachable: false,
  note:
    'The target is a profile name or id. Every profile is visible to every member (substrate), so ' +
    'there is no hidden row an error could reveal; an unknown ref fails as "no agent profile" and ' +
    'lists the names that exist, which `list` already shows.',
}

export const agentProfileCreateContract = {
  name: 'agentProfiles.create',
  version: 1,
  visibility: 'deployment-substrate',
  input: agentProfileCreateInput,
  policy: {
    action: 'write',
    roleFloor: 'admin',
    resource: 'settings-domain',
    confirmation: 'none',
    rationale: POLICY_RATIONALE,
  },
  exposure: SERVED_ON,
  delivery: DELIVERY,
  redaction: REDACTION,
  ownership: OWNERSHIP,
  attribution: ATTRIBUTION,
  errorConsistency: ERRORS,
  conflict: 'cmd',
  conflictRule: CONFLICT_RULE,
} as const satisfies CommandContract<typeof agentProfileCreateInput>

export const agentProfileUpdateContract = {
  name: 'agentProfiles.update',
  version: 1,
  visibility: 'deployment-substrate',
  input: agentProfileUpdateInput,
  policy: {
    action: 'write',
    roleFloor: 'admin',
    resource: 'settings-domain',
    confirmation: 'none',
    rationale: POLICY_RATIONALE,
  },
  exposure: SERVED_ON,
  delivery: DELIVERY,
  redaction: REDACTION,
  ownership: OWNERSHIP,
  attribution: ATTRIBUTION,
  errorConsistency: ERRORS,
  conflict: 'cmd',
  conflictRule: CONFLICT_RULE,
} as const satisfies CommandContract<typeof agentProfileUpdateInput>

export const agentProfileDeleteContract = {
  name: 'agentProfiles.delete',
  version: 1,
  visibility: 'deployment-substrate',
  input: agentProfileDeleteInput,
  policy: {
    action: 'manage',
    roleFloor: 'admin',
    resource: 'settings-domain',
    confirmation: 'confirm',
    rationale:
      `${POLICY_RATIONALE} A delete is \`manage\` and confirmed: the row is removed outright. It is ` +
      'refused while an open issue points at the profile; sessions keep the values they ran with.',
  },
  exposure: SERVED_ON,
  delivery: DELIVERY,
  redaction: REDACTION,
  ownership: OWNERSHIP,
  attribution: ATTRIBUTION,
  errorConsistency: ERRORS,
  conflict: 'cmd',
  conflictRule: CONFLICT_RULE,
} as const satisfies CommandContract<typeof agentProfileDeleteInput>

export const agentProfileImportContract = {
  name: 'agentProfiles.import',
  version: 1,
  visibility: 'deployment-substrate',
  input: agentProfileImportInput,
  policy: {
    action: 'write',
    roleFloor: 'admin',
    resource: 'settings-domain',
    confirmation: 'none',
    rationale:
      `${POLICY_RATIONALE} Import is create-or-replace by name from \`.podium/agents/<name>.md\` ` +
      'texts; every file is parsed before any row is written, so one bad file changes nothing.',
  },
  exposure: SERVED_ON,
  delivery: DELIVERY,
  redaction: REDACTION,
  ownership: OWNERSHIP,
  attribution: ATTRIBUTION,
  errorConsistency: ERRORS,
  conflict: 'cmd',
  conflictRule: CONFLICT_RULE,
} as const satisfies CommandContract<typeof agentProfileImportInput>

export const AGENT_PROFILE_CONTRACTS = {
  create: agentProfileCreateContract,
  update: agentProfileUpdateContract,
  delete: agentProfileDeleteContract,
  import: agentProfileImportContract,
} as const

export type AgentProfileContractName = keyof typeof AGENT_PROFILE_CONTRACTS

export const AGENT_PROFILE_CONTRACT_NAMES = Object.keys(
  AGENT_PROFILE_CONTRACTS,
).sort() as AgentProfileContractName[]
