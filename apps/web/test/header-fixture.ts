import type { SocketHub } from '@podium/client-core/socket-transport'
import type { HostMetricsWire, MachineId } from '@podium/model/browser'
import { createSidebarFixture } from './sidebar-fixture'

/** Operator-sized synthetic data. No operator cache, backend or daemon. */
export function createHeaderFixture(count: number) {
  const now = Date.now(), base = createSidebarFixture(count, now)
  const machineIds = ['host-one', 'host-two', 'host-three'] as MachineId[]
  const machines = machineIds.map((id, index) => ({ id, name: `Host ${index + 1}`, hostname: `host-${index}`,
    online: true, lastSeenAt: new Date(now).toISOString(), availability: { daemon: true, server: false, supervisor: false, epoch: 'one' } }))
  for (const [key, record] of base.records) {
    if (record.entity !== 'session') continue
    const value = record.value as Record<string, unknown>
    const index = Number(String(value.sessionId).split('-').at(-1)) || 0
    base.records.set(key, { ...record, value: { ...value, machineId: machineIds[index % 3] } })
  }
  const quota = [{ machineId: machineIds[0]!, machineName: 'Host 1', hostname: 'host-0', agents: [{
    agent: 'codex', status: 'ok', fetchedAt: new Date(now).toISOString(),
    account: { email: 'synthetic@example.invalid', plan: 'Synthetic' },
    windows: [{ key: 'daily', label: 'Daily', usedPercent: 40, resetsAt: new Date(now + 3600000).toISOString(), windowMinutes: 1440 }],
  }] }]
  const history = { sampledAt: new Date(now).toISOString(), bucketMs: 1800000, peak: 2,
    buckets: Array.from({ length: 24 }, (_, index) => ({ start: new Date(now - (23 - index) * 1800000).toISOString(), count: index % 3 })) }
  Object.assign(base.api, {
    discovery: { refreshRepos: { mutate: async () => ({ repositories: [{ path: '/synthetic/project', repoId: 'synthetic-repo', kind: 'repository', branch: 'main', worktrees: [] }], machines, diagnostics: [] }) } },
    settings: { get: { query: async () => ({ sessionDefaults: { agent: 'codex' }, hibernation: { enabled: false, memoryPct: 90, maxIdleSessions: 10, loadPerCore: 1 }, worktreeGc: { enabled: false, afterDays: 14 } }) } },
    quota: { summary: { query: async () => quota } },
    sessions: { concurrencyHistory: { query: async () => history } },
    usage: { summary: { query: async () => ({ hostname: 'synthetic', sampledAt: new Date(now).toISOString(), buckets: [] }) } },
    version: { current: { query: async () => ({ version: 'synthetic' }) } },
  })
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  const health = { status: 'ok', rttMs: 12, since: now }
  const hub = {
    on(kind: string, listener: (...args: unknown[]) => void) {
      let group = listeners.get(kind)
      if (!group) { group = new Set(); listeners.set(kind, group) }
      group.add(listener)
      return () => group!.delete(listener)
    },
    emit(kind: string, ...args: unknown[]) { for (const listener of listeners.get(kind) ?? []) listener(...args) },
    connectionHealth: () => health,
    onConnectionHealth: () => () => {},
    connect() {}, connectNow() {}, dispose() {}, seedMetadata() {}, setVisible() {}, setViewState() {}, sendSessionDraft() {}, sendDraftEdit: () => true,
  }
  let metrics: HostMetricsWire[] = []
  function publishMetrics(step: number) {
    metrics = machineIds.map((machineId, index) => ({ machineId, hostname: `host-${index}`,
      sampledAt: new Date(now + (index === 0 ? step * 5000 : 0)).toISOString(),
      memory: { totalBytes: 16e9, availableBytes: index === 0 ? 8e9 + (step % 5) * 1e8 : 8e9, swapTotalBytes: 0, swapFreeBytes: 0 },
      load: { one: 0.3 + (index === 0 ? (step % 5) / 10 : 0), five: 0.3, fifteen: 0.2, cpuCount: 4 } }))
    hub.emit('hostMetrics', metrics)
  }
  return { ...base, get replica() { return base.replica }, hub: hub as unknown as SocketHub,
    publishMetrics, publishMachines: () => hub.emit('machines', machines),
    inputs: () => ({ metrics, quotas: quota, connection: health, afterDays: 14 }),
    activity(step: number) {
      const index = step % Math.min(12, count)
      base.patch('session', `synthetic-session-${index}`, { lastActiveAt: new Date().toISOString(),
        agentState: { phase: step % 2 ? 'working' : 'idle', since: new Date().toISOString() } })
    },
    idle() {
      for (let index = 0; index < Math.min(12, count); index++) base.patch('session', `synthetic-session-${index}`, {
        agentState: { phase: 'idle', since: new Date().toISOString() },
      })
    },
  }
}
