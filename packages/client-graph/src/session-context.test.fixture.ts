/** Invented normalized readings for shared-model consumers; no native fields. */
import '@podium/client-graph/synced-models'
import { type ContextSummary, HarnessId, Inventory } from '@podium/model'
import { liveFixture } from './live-fixture'
import { MobxPool, type PoolLazyOptions } from './pool'

export const contextStamp = '2026-11-21T12:00:00.000Z'
export const contextQuantity = (value: number) => ({
  value,
  accuracy: 'reported' as const,
  source: 'synthetic adapter',
})
export const contextSample: Extract<ContextSummary, { status: 'available' }> = {
  version: 1,
  status: 'available',
  sample: {
    id: 'synthetic-main-sample',
    at: contextStamp,
    bindingVersion: 3,
    observerGeneration: 2,
    contextRevision: 1,
    turnEpoch: 0,
    nativeSessionId: 'synthetic-native-session',
  },
  model: { providerId: 'synthetic-provider', modelId: 'observed-model' },
  occupancy: {
    basis: 'current-context',
    usedTokens: contextQuantity(20),
    percent: contextQuantity(10),
    remainingTokens: contextQuantity(180),
  },
  effectiveCapacity: { ...contextQuantity(200), basis: 'configured' },
  modelCapacity: { ...contextQuantity(1000), basis: 'model-metadata' },
  compaction: { source: 'synthetic policy', thresholdTokens: contextQuantity(160) },
}

export const contextInventory: Inventory = {
  os: 'linux',
  arch: 'x64',
  agents: [],
  tools: [],
  runtimeDrivers: [
    { harness: 'codex', id: 'generic-pty', family: 'terminal' },
    { harness: 'cursor', id: 'generic-pty', family: 'terminal' },
  ],
  contextCapabilities: [
    {
      harness: HarnessId.parse('codex'),
      driverId: 'generic-pty',
      capability: { summary: 'passive', detail: 'on-demand' },
      availability: {
        status: 'unavailable',
        reason: { code: 'not-probed', message: 'No native inspection port' },
      },
    },
    {
      harness: HarnessId.parse('cursor'),
      driverId: 'generic-pty',
      availability: {
        status: 'unsupported',
        reason: { code: 'no-channel', message: 'Synthetic unsupported implementation' },
      },
    },
    {
      harness: HarnessId.parse('codex'),
      driverId: 'headless',
      capability: { summary: 'passive', detail: 'none' },
      availability: { status: 'available' },
    },
  ],
}

/** Newer peers may advertise a harness and driver this client cannot name.
 * Legacy session/launch vocabularies stay untouched; the new context field
 * carries the existing open wire identity and common capability value. */
export const futureContextInventory = Inventory.parse({
  os: 'linux',
  arch: 'x64',
  agents: [],
  runtimeDrivers: [],
  contextCapabilities: [
    {
      harness: 'future-context-harness',
      driverId: 'future-context-driver',
      capability: { summary: 'passive', detail: 'on-demand' },
      availability: { status: 'available' },
    },
  ],
})

export function sessionContextFixture(lazy?: PoolLazyOptions) {
  let now = Date.parse(contextStamp)
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: now }, undefined, lazy)
  const session = {
    sessionId: 's1',
    title: 'Synthetic session',
    status: 'live',
    agentKind: 'codex',
    cwd: '/synthetic/project',
    machineId: 'm1',
    driverId: 'generic-pty',
    requestedModel: 'requested-model',
    createdAt: contextStamp,
    lastActiveAt: contextStamp,
  }
  const machine = { id: 'm1', name: 'Synthetic machine', inventory: contextInventory }
  pool.apply({
    type: 'replace',
    rows: [
      { kind: 'session', id: 's1', value: session as never },
      { kind: 'session', id: 's2', value: { ...session, sessionId: 's2' } as never },
      { kind: 'machine', id: 'm1', value: machine as never },
    ],
  })
  const live = liveFixture(pool, () => now)
  live.online('m1', true)
  return {
    pool,
    live,
    session,
    machine,
    model: pool.sessionObject('s1'),
    advanceTime() {
      now += 365 * 24 * 60 * 60 * 1000
    },
    publish(context: ContextSummary | undefined, legacyPercent?: number, id = 's1') {
      live.sessionCondition(id, {
        busy: false,
        requestsGated: 0,
        context,
        contextUsagePercent: legacyPercent,
      })
    },
    updateSession(patch: Partial<typeof session>) {
      pool.apply({
        type: 'update',
        rows: [{ kind: 'session', id: 's1', value: { ...session, ...patch } as never }],
      })
    },
    updateInventory(inventory: Inventory | undefined) {
      pool.apply({
        type: 'update',
        rows: [{ kind: 'machine', id: 'm1', value: { ...machine, inventory } as never }],
      })
    },
  }
}
