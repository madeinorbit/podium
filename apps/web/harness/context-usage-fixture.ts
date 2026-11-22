/** Invented normalized observations. No native telemetry or provider calls. */
import '@podium/client-graph/synced-models'
import { liveFixture } from '@podium/client-graph/live-fixture'
import { MobxPool } from '@podium/client-graph/pool'
import { ContextDetailResult, ContextSummary, HarnessId, Inventory } from '@podium/model/browser'

export const quantity = (value: number, accuracy: 'reported' | 'estimated' = 'reported') => ({
  value,
  accuracy,
  source: 'Synthetic observation',
})
export const sample = {
  id: 'synthetic-context-sample',
  at: '2026-11-21T12:00:00.000Z',
  bindingVersion: 1,
  observerGeneration: 1,
  contextRevision: 1,
  turnEpoch: 0,
}
const capacity = { ...quantity(200_000), basis: 'configured' as const }
export const measured = {
  version: 1 as const,
  status: 'available' as const,
  sample,
  model: { providerId: 'synthetic-provider', modelId: 'observed-model' },
  occupancy: {
    basis: 'current-context' as const,
    usedTokens: quantity(84_000),
    percent: quantity(42),
    remainingTokens: quantity(116_000),
  },
  effectiveCapacity: capacity,
  modelCapacity: { ...quantity(1_000_000), basis: 'model-metadata' as const },
  compaction: {
    source: 'Synthetic policy',
    enabled: true,
    thresholdTokens: quantity(160_000),
    reserveTokens: quantity(20_000),
  },
}

export const contextStates = {
  reported: measured,
  estimated: {
    ...measured,
    occupancy: {
      basis: 'native-estimate',
      usedTokens: quantity(42_750, 'estimated'),
      percent: quantity(21.375, 'estimated'),
      remainingTokens: quantity(157_250, 'estimated'),
    },
  },
  zero: {
    ...measured,
    occupancy: {
      basis: 'current-context',
      usedTokens: quantity(0),
      percent: quantity(0),
      remainingTokens: quantity(200_000),
    },
  },
  over: {
    ...measured,
    occupancy: {
      basis: 'current-context',
      usedTokens: quantity(250_000),
      percent: quantity(125),
      remainingTokens: quantity(0),
    },
  },
  percentOnly: {
    version: 1,
    status: 'available',
    sample,
    occupancy: { basis: 'current-context', percent: quantity(13.25) },
  },
  countOnly: {
    version: 1,
    status: 'available',
    sample,
    occupancy: { basis: 'last-request', usedTokens: quantity(13_000, 'estimated') },
  },
  countCapacity: {
    version: 1,
    status: 'available',
    sample,
    effectiveCapacity: capacity,
    occupancy: { basis: 'native-estimate', usedTokens: quantity(647, 'estimated') },
  },
  remainingOnly: {
    version: 1,
    status: 'available',
    sample,
    occupancy: { basis: 'current-context', remainingTokens: quantity(500) },
  },
  pending: {
    version: 1,
    status: 'pending',
    revision: { ...sample, contextRevision: 2 },
    effectiveCapacity: capacity,
    reason: { code: 'compaction', message: 'Waiting for a post-compaction measurement' },
  },
  unavailable: {
    version: 1,
    status: 'unavailable',
    revision: sample,
    effectiveCapacity: capacity,
    reason: { code: 'unavailable', message: 'No current measurement is available' },
  },
  stale: {
    ...measured,
    status: 'stale',
    reason: { code: 'offline', message: 'Offline; showing the last measurement' },
  },
  unsupported: {
    version: 1,
    status: 'unsupported',
    reason: { code: 'unsupported', message: 'This session does not support context measurements' },
  },
  requestOnly: { ...measured, occupancy: { ...measured.occupancy, basis: 'last-request' } },
} satisfies Record<string, ContextSummary>
export type ContextFixtureState = keyof typeof contextStates
for (const state of Object.values(contextStates)) ContextSummary.parse(state)

export const requestDetail = {
  input: quantity(80_000),
  output: quantity(4_000),
  cacheRead: quantity(60_000),
  cacheWrite: quantity(2_000),
  reasoning: quantity(1_000),
  model: { modelId: 'request-model' },
}
export const compositionDetail = {
  coverage: 'partial' as const,
  usedTokens: quantity(84_000),
  truncated: false,
  rows: [
    {
      id: 'system',
      label: 'System instructions',
      category: 'system',
      kind: 'used' as const,
      attribution: 'category' as const,
      tokens: quantity(12_000),
    },
    {
      id: 'messages',
      label: 'Messages',
      category: 'messages',
      kind: 'used' as const,
      attribution: 'category' as const,
      tokens: quantity(60_000),
      childrenCoverage: 'partial' as const,
    },
    {
      id: 'recent',
      parentId: 'messages',
      label: 'Recent conversation',
      category: 'messages',
      kind: 'used' as const,
      attribution: 'item' as const,
      tokens: quantity(40_000),
    },
    {
      id: 'tools',
      label: 'Tool definitions',
      category: 'tools',
      kind: 'used' as const,
      attribution: 'category' as const,
      tokens: quantity(12_000),
    },
    {
      id: 'unknown',
      label: 'Additional attribution',
      category: 'unknown',
      kind: 'used' as const,
      attribution: 'unattributed' as const,
    },
    {
      id: 'reserve',
      label: 'Compaction buffer',
      category: 'reserve',
      kind: 'reserve' as const,
      attribution: 'category' as const,
      tokens: quantity(20_000),
    },
    {
      id: 'deferred',
      label: 'Deferred tools',
      category: 'tools',
      kind: 'deferred' as const,
      attribution: 'category' as const,
    },
    {
      id: 'excluded',
      label: 'Unloaded material',
      category: 'excluded',
      kind: 'excluded' as const,
      attribution: 'category' as const,
      tokens: quantity(2_000),
    },
    {
      id: 'free',
      label: 'Remaining window',
      category: 'free',
      kind: 'free' as const,
      attribution: 'category' as const,
      tokens: quantity(116_000),
    },
  ],
}

export function detailFor(context: ContextSummary, requestOnly = false): ContextDetailResult {
  const occupancy =
    context.status === 'available' || context.status === 'stale' ? context.occupancy : undefined
  const full = occupancy?.usedTokens?.value === 84_000
  return ContextDetailResult.parse({
    version: 1,
    status: 'available',
    sample: 'sample' in context ? context.sample : sample,
    ...(full || requestOnly ? { lastRequest: requestDetail } : {}),
    ...(requestOnly
      ? {}
      : {
          composition: full
            ? compositionDetail
            : {
                coverage: 'unknown',
                usedTokens: occupancy?.usedTokens,
                truncated: false,
                rows: [
                  {
                    id: 'unknown',
                    label: 'Native attribution not provided',
                    category: 'unknown',
                    kind: 'used',
                    attribution: 'unattributed',
                  },
                ],
              },
        }),
  })
}

/** Real shared SessionModel + live reading, including a never-before-known
 * harness identity. The component consumes no harness metadata from here. */
export function createContextFixture(
  state: ContextFixtureState = 'reported',
  future = false,
  readonly = false,
) {
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(sample.at) })
  const agentKind = HarnessId.parse(future ? 'invented-context-harness' : 'codex')
  const driverId = 'synthetic-context-driver'
  const row = {
    sessionId: 'context-fixture',
    title: 'Synthetic conversation',
    status: 'live',
    agentKind,
    driverId,
    machineId: 'context-machine',
    cwd: '/synthetic/project',
    createdAt: sample.at,
    lastActiveAt: sample.at,
    observedModel: 'demo-pro',
    observedEffort: 'high',
    requestedModel: 'demo-pro',
    requestedEffort: 'high',
    configureFields: readonly ? [] : ['model', 'effort'],
    observedMode: 'default',
  }
  const inventory = Inventory.parse({
    os: 'linux',
    arch: 'x64',
    agents: [],
    runtimeDrivers: [],
    contextCapabilities: [
      {
        harness: agentKind,
        driverId,
        capability: { summary: 'passive', detail: 'on-demand' },
        availability: { status: 'available' },
      },
    ],
  })
  pool.apply({
    type: 'replace',
    rows: [
      { kind: 'session', id: row.sessionId, value: row as never },
      {
        kind: 'session',
        id: 'other-context-session',
        value: { ...row, sessionId: 'other-context-session' } as never,
      },
      {
        kind: 'machine',
        id: row.machineId,
        value: { id: row.machineId, name: 'Synthetic machine', inventory } as never,
      },
    ],
  })
  const live = liveFixture(pool, () => Date.parse(sample.at))
  live.online(row.machineId, true)
  const publish = (
    context: ContextSummary | undefined,
    legacyPercent?: number,
    id = row.sessionId,
  ) =>
    live.sessionCondition(id, {
      busy: false,
      requestsGated: 0,
      context,
      contextUsagePercent: legacyPercent,
    })
  publish(contextStates[state])
  return {
    pool,
    live,
    row,
    session: pool.sessionObject(row.sessionId),
    other: pool.sessionObject('other-context-session'),
    publish,
  }
}
