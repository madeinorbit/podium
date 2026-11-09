// Machines are read as machine models (POD-6644): their classes load with the fixture.
import '@podium/client-graph/synced-models'
import { knownReading, type LiveStore } from '@podium/client-core/live'
import type { SocketHub } from '@podium/client-core/socket-transport'
import type { HostMetricsWire, MachineId } from '@podium/model/browser'
import { runInAction } from 'mobx'
import { createSidebarFixture } from './sidebar-fixture'

/** Operator-sized synthetic data. No operator cache, backend or daemon. */
export function createHeaderFixture(count: number, sessionCount = count, userId = 'operator') {
  const now = Date.now(),
    base = createSidebarFixture(count, now, false, userId)
  const machineIds = ['host-one', 'host-two', 'host-three'] as MachineId[]
  const machines = machineIds.map((id, index) => ({
    id,
    name: `Host ${index + 1}`,
    hostname: `host-${index}`,
    online: true,
    lastSeenAt: new Date(now).toISOString(),
    availability: { daemon: true, server: false, supervisor: false, epoch: 'one' },
  }))
  // Machines and repositories are records; online is the LiveStore's
  // condition, set by publishMachines (POD-6644).
  base.putMachinesAndRepos({
    machines,
    repos: [
      {
        path: '/synthetic/project',
        repoId: 'synthetic-repo',
        kind: 'repository',
        branch: 'main',
        worktrees: [],
      },
    ],
  })
  for (const [key, record] of base.records) {
    if (record.entity !== 'session') continue
    const value = record.value as Record<string, unknown>
    const index = Number(String(value.sessionId).split('-').at(-1)) || 0
    if (index >= sessionCount) {
      base.records.delete(key)
      continue
    }
    base.records.set(key, { ...record, value: { ...value, machineId: machineIds[index % 3] } })
  }
  const quota = [
    {
      machineId: machineIds[0]!,
      machineName: 'Host 1',
      hostname: 'host-0',
      agents: [
        {
          agent: 'codex',
          status: 'ok',
          fetchedAt: new Date(now).toISOString(),
          account: { email: 'synthetic@example.invalid', plan: 'Synthetic' },
          windows: [
            {
              key: 'daily',
              label: 'Daily',
              usedPercent: 40,
              resetsAt: new Date(now + 3600000).toISOString(),
              windowMinutes: 1440,
            },
          ],
        },
      ],
    },
  ]
  const history = {
    sampledAt: new Date(now).toISOString(),
    bucketMs: 1800000,
    peak: 2,
    buckets: Array.from({ length: 24 }, (_, index) => ({
      start: new Date(now - (23 - index) * 1800000).toISOString(),
      count: index % 3,
    })),
  }
  const lifecycle = {
    sessionDefaults: { agent: 'codex' },
    hibernation: { enabled: false, memoryPct: 90, maxIdleSessions: 10, loadPerCore: 1 },
    worktreeGc: { enabled: false, afterDays: 14 },
  }
  Object.assign(base.api, {
    settings: { get: { query: async () => lifecycle } },
    quota: { summary: { query: async () => quota } },
    sessions: { concurrencyHistory: { query: async () => history } },
    usage: {
      summary: {
        query: async () => ({
          hostname: 'synthetic',
          sampledAt: new Date(now).toISOString(),
          buckets: [],
        }),
      },
    },
    version: { current: { query: async () => ({ version: 'synthetic' }) } },
  })
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  const health = { status: 'ok', rttMs: 12, since: now }
  const hub = {
    on(kind: string, listener: (...args: unknown[]) => void) {
      let group = listeners.get(kind)
      if (!group) {
        group = new Set()
        listeners.set(kind, group)
      }
      group.add(listener)
      return () => group!.delete(listener)
    },
    emit(kind: string, ...args: unknown[]) {
      for (const listener of listeners.get(kind) ?? []) listener(...args)
    },
    connectionHealth: () => health,
    onConnectionHealth: () => () => {},
    connect() {},
    connectNow() {},
    dispose() {},
    seedMetadata() {},
    setVisible() {},
    setViewState() {},
    sendSessionDraft() {},
    sendDraftEdit: () => true,
  }
  // Each machine's online and presence facts, as the live feed would deliver them.
  let machineList: readonly ({ id: string } & Record<string, unknown>)[] = machines
  let machineLive: LiveStore | undefined
  function applyConditions() {
    if (!machineLive) return
    const store = machineLive
    runInAction(() => {
      for (const machine of machineList) {
        const { online, lastSeenAt, availability, presenceSource, daemonReadiness } =
          machine as Record<string, unknown>
        store.applyTopic(
          'machine.condition',
          String(machine.id),
          knownReading(
            {
              online: online !== false,
              since: null,
              ...(lastSeenAt !== undefined ? { lastSeenAt } : {}),
              ...(availability !== undefined ? { availability } : {}),
              ...(presenceSource !== undefined ? { presenceSource } : {}),
              ...(daemonReadiness !== undefined ? { daemonReadiness } : {}),
            } as never,
            Date.now(),
          ),
        )
      }
    })
  }
  let metrics: HostMetricsWire[] = []
  let deliver = hub.emit.bind(hub)
  // POD-5798: samples and quota are LiveStore readings, pushed by the server.
  // The fixture writes them where the live feed would.
  let live: LiveStore | undefined
  function publishHostMetrics(next: HostMetricsWire[]) {
    metrics = next
    if (!live) return
    const store = live
    runInAction(() => {
      for (const metric of next)
        store.applyTopic(
          'machine.metrics',
          String(metric.machineId),
          knownReading(metric, Date.now()),
        )
    })
  }
  function publishMetrics(step: number) {
    const next = machineIds.map((machineId, index) => ({
      machineId,
      hostname: `host-${index}`,
      sampledAt: new Date(now + (index === 0 ? step * 5000 : 0)).toISOString(),
      disk: {
        path: '/synthetic/home',
        totalBytes: 100e9,
        usedBytes: 54e9 + index * 9e9,
        availableBytes: 36e9 - index * 9e9,
      },
      memory: {
        totalBytes: 16e9,
        availableBytes: index === 0 ? 8e9 + (step % 5) * 1e8 : 8e9,
        swapTotalBytes: 0,
        swapFreeBytes: 0,
      },
      load: {
        one: 0.3 + (index === 0 ? (step % 5) / 10 : 0),
        five: 0.3,
        fifteen: 0.2,
        cpuCount: 4,
      },
    }))
    publishHostMetrics(next)
  }
  return {
    ...base,
    get replica() {
      return base.replica
    },
    hub: hub as unknown as SocketHub,
    // Exercise the real runtime's already-subscribed channels. No second hub
    // or provider is installed; emit is the hub's private dispatch test seam.
    /**
     * `store` takes the fixture's quota reading as well; `conditions` (POD-6644)
     * is the LiveStore the machines' online and presence go to, without quota.
     */
    bindHub(real: SocketHub, store?: LiveStore, conditions: LiveStore | undefined = store) {
      deliver = (real as unknown as { emit: typeof hub.emit }).emit.bind(real)
      Object.assign(real, {
        connectionHealth: hub.connectionHealth,
        onConnectionHealth: hub.onConnectionHealth,
      })
      live = conditions
      machineLive = conditions
      if (store)
        runInAction(() =>
          store.applyTopic('account.quota', 'me', knownReading({ machines: quota } as never, now)),
        )
      applyConditions()
      publishHostMetrics(metrics)
    },
    /** Machines (records plus their live condition) and repositories (checkout records). */
    putMachinesAndRepos(input: Parameters<typeof base.putMachinesAndRepos>[0]) {
      base.putMachinesAndRepos(input)
      if (input.machines) machineList = input.machines as typeof machines
      applyConditions()
    },
    publishMetrics,
    publishHostMetrics,
    /** The machines come online: their LiveStore condition (POD-6644; the records are seeded). */
    publishMachines: applyConditions,
    inputs: () => ({
      metrics,
      quotas: quota,
      connection: live?.connection,
      afterDays: 14,
      history,
      lifecycle,
      liveOnline: [],
      outboxSize: live?.outbox.pending ?? 0,
    }),
    activity(step: number) {
      const index = step % Math.min(12, sessionCount)
      base.patch('session', `synthetic-session-${index}`, {
        lastActiveAt: new Date().toISOString(),
        agentState: { phase: step % 2 ? 'working' : 'idle', since: new Date().toISOString() },
      })
    },
    idle() {
      for (let index = 0; index < Math.min(12, sessionCount); index++)
        base.patch('session', `synthetic-session-${index}`, {
          agentState: { phase: 'idle', since: new Date().toISOString() },
        })
    },
  }
}
