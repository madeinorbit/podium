import { HARNESS_VERSION_POLICIES } from '@podium/harness/browser'
import { DRIVER_IDS, RETIRED_DRIVER_IDS } from '@podium/harness/metadata'
import {
  AgentCandidate,
  AgentKind,
  DEFAULT_FLEET_UPDATE_CHANNEL,
  FEED_EVENT_KINDS,
  instancePreferencesRecordOf,
  MAX_AGENT_PROFILE_CANDIDATES,
  WorkflowStep,
  WorkflowStepEvidence,
} from '@podium/model'
import {
  FeedChange,
  MetadataChange,
  type MetadataEntityKind,
  SERVER_MOVE_CAPABILITY,
  type SyncKindTokens,
  schemaDigest,
  wireSchemaDigest,
} from '@podium/protocol'
import { DEFAULT_SETTINGS } from '@podium/runtime'
import type { SyncRepository } from '@podium/sync'
import { driverFamilyForId, harnessCapabilitiesFor } from '../harness-manifest'
import { EFFECT_PUBLISHED_INPUT } from '../modules/effects/published-input'
import { FEED_WINDOW } from '../modules/issue-events/feed'
import { CONFIRMED_PER_SESSION } from '../modules/message-feed/feed'
import { OOM_ATTRIBUTION_WINDOW_MS } from '../modules/sessions/session-record'
import { DATABASE_ONLY_BUILDERS } from './record-builders'

// Code constants that influence a record's value or membership automatically
// change its token. The change capture cannot notice these changes on
// upgrade: no row changed. Keep these inputs beside the schema inputs.
const profileInputs = {
  modelDefault: AgentCandidate.shape.model.parse(undefined),
  effortDefault: AgentCandidate.shape.effort.parse(undefined),
  maxCandidates: MAX_AGENT_PROFILE_CANDIDATES,
}
const codeInputs: Partial<Record<MetadataEntityKind, unknown>> = {
  machine: {
    agentKinds: AgentKind.options,
    defaultUpdateChannel: DEFAULT_FLEET_UPDATE_CHANNEL,
  },
  machineAccess: {
    harnessVersionPolicies: HARNESS_VERSION_POLICIES,
    wireSchemaDigest: wireSchemaDigest(),
    serverMoveCapability: SERVER_MOVE_CAPABILITY,
  },
  session: {
    harnessCapabilities: Object.fromEntries(
      AgentKind.options.map((kind) => {
        const capabilities = harnessCapabilitiesFor(kind)
        return [
          kind,
          capabilities
            ? { handoff: capabilities.handoff, promptModeHints: capabilities.promptModeHints }
            : null,
        ]
      }),
    ),
    driverFamilies: Object.fromEntries(
      [...DRIVER_IDS, ...RETIRED_DRIVER_IDS].map((id) => [id, driverFamilyForId(id) ?? null]),
    ),
    oomAttributionWindowMs: OOM_ATTRIBUTION_WINDOW_MS,
  },
  instancePreferences: instancePreferencesRecordOf(DEFAULT_SETTINGS),
  // The wire schema fingerprints default wrappers, not their values. These
  // parsers fill absent fields when reading stored profiles, steps and evidence.
  agentProfile: profileInputs,
  workflowRevision: {
    instructionsDefault: WorkflowStep.shape.instructions.parse(undefined),
    completionGuidanceDefault: WorkflowStep.shape.completionGuidance.parse(undefined),
  },
  workflowRun: { profile: profileInputs, evidenceDefaults: WorkflowStepEvidence.parse({}) },
  issueEvent: { window: FEED_WINDOW, kinds: FEED_EVENT_KINDS },
  message: { confirmedPerSession: CONFIRMED_PER_SESSION },
}

// Change the salt when a kind's published meaning changes in a way neither
// its schema nor the code inputs above describe (for example a projection
// algorithm). A data migration that rewrites a kind instead increments its
// generation in the same migration:
// INSERT INTO sync_kind (tenant_id, kind, generation) VALUES ('local', 'example', 1)
// ON CONFLICT (tenant_id, kind) DO UPDATE SET generation = sync_kind.generation + 1;
const salts: Partial<Record<MetadataEntityKind, string>> = {}

// The scoped feed has its own schema for some kinds. Other kinds use the
// opaque arm of the feed envelope and publish the value from MetadataChange.
const schemas = new Map(
  [...MetadataChange.options, ...FeedChange.options].map(
    (arm) => [arm.shape.entity.value, arm.shape.value] as const,
  ),
)
const kinds = DATABASE_ONLY_BUILDERS.map(({ kind }) => kind)

/** Object insertion order is not a policy change. Arrays retain their order. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, canonical(item)]),
    )
  }
  return value
}

function digestFor(kind: MetadataEntityKind, input: unknown = codeInputs[kind]): string {
  const schema = schemas.get(kind)
  if (!schema) throw new Error(`No wire schema for sync kind ${kind}`)
  const salt = salts[kind] ?? ''
  return schemaDigest(
    schema,
    input === undefined ? salt : `${salt}\n${JSON.stringify(canonical(input))}`,
  )
}
const digests = kinds.map((kind) => digestFor(kind))

export async function readKindTokens(
  sync: SyncRepository,
  effectKinds: readonly string[] = [],
): Promise<SyncKindTokens> {
  const generations = new Map(
    (await sync.readKindGenerations()).map(({ kind, generation }) => [kind, generation]),
  )
  // The worker receives the same served set as the server's executor registry.
  // Registration order and repeated entries do not change published records.
  const effectDigest = digestFor('effect', {
    rules: EFFECT_PUBLISHED_INPUT,
    served: [...new Set(effectKinds)].sort(),
  })
  return Object.fromEntries(
    kinds.map((kind, index) => [
      kind,
      `${kind === 'effect' ? effectDigest : digests[index]}:${generations.get(kind) ?? 0}`,
    ]),
  )
}
