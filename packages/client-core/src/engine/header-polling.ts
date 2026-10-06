import { createLogger } from '@podium/logger'
import {
  CONFIRMED_AGENT_ACTIVITY_MAX_AGE_MS,
  isAgentConfirmedComputing,
  type MachineQuotaWire,
  type SessionMeta,
} from '@podium/model'
import type { AgentConcurrencyHistoryResult, PodiumClientApi } from '../api'
import type { Replica } from '../replica/kernel/facade'

const log = createLogger('client.header-polling')

export interface HeaderInputRows {
  quota: MachineQuotaWire[]
  history: AgentConcurrencyHistoryResult
  lifecycle: Awaited<ReturnType<PodiumClientApi['settings']['get']['query']>>
}
export type HeaderInputKey = keyof HeaderInputRows

/** Read-only, keyed samples. The header adapter neither starts polls nor calls the API. */
export interface HeaderInputs {
  read<K extends HeaderInputKey>(key: K): HeaderInputRows[K] | undefined
  onInput(key: HeaderInputKey, changed: () => void): () => void
}

/** One service per principal runtime. Stop/restart fences in-flight replies;
 * destroy also releases the cached samples and all listeners. */
export function createHeaderPollingService(ports: {
  api: PodiumClientApi
  replica: Pick<Replica, 'rows' | 'row' | 'subscribeAddressedBatch'>
  reportError?: (key: HeaderInputKey, error: unknown) => void
}) {
  const samples: Partial<HeaderInputRows> = {}
  const listeners = new Map<HeaderInputKey, Set<() => void>>()
  const diagnostics = { errors: 0, counts: {} as Partial<Record<HeaderInputKey, number>> }
  let destroyed = false
  let generation: { stop(): void } | undefined
  const inputs: HeaderInputs = {
    read: (key) => samples[key],
    onInput(key, changed) {
      if (destroyed) return () => {}
      let keyed = listeners.get(key)
      if (!keyed) listeners.set(key, (keyed = new Set()))
      keyed.add(changed)
      return () => {
        keyed.delete(changed)
      }
    },
  }
  function publish<K extends HeaderInputKey>(key: K, value: HeaderInputRows[K]): void {
    samples[key] = value
    for (const changed of [...(listeners.get(key) ?? [])]) {
      try {
        changed()
      } catch (error) {
        log.warn('header input listener failed', { key, error })
      }
    }
  }
  function failed(key: HeaderInputKey, error: unknown): void {
    diagnostics.errors++
    diagnostics.counts[key] = (diagnostics.counts[key] ?? 0) + 1
    if (diagnostics.counts[key] === 1) {
      if (ports.reportError) ports.reportError(key, error)
      else log.warn('header polling failed; retaining the last sample', { key, error })
    }
  }
  function start(): void {
    if (destroyed || generation) return
    const run = { stop: () => {} }
    generation = run
    const current = () => generation === run && !destroyed
    const pending = new Set<HeaderInputKey>()
    let lifecycleReceived = samples.lifecycle !== undefined
    const working = new Map<string, ReturnType<typeof setTimeout>>()
    function updateWorking(id: string, row: SessionMeta | undefined): void {
      const previous = working.get(id)
      if (previous !== undefined) clearTimeout(previous)
      working.delete(id)
      if (!row || !isAgentConfirmedComputing(row, Date.now())) return
      const activity = Math.max(
        ...[row.agentState?.stateObservedAt, row.lastActiveAt, row.agentState?.since]
          .map((stamp) => Date.parse(stamp ?? ''))
          .filter(Number.isFinite),
      )
      // One addressed deadline, rather than scanning the fleet on clock ticks.
      const delay = Math.min(
        2_147_483_647,
        activity + CONFIRMED_AGENT_ACTIVITY_MAX_AGE_MS - Date.now() + 1,
      )
      working.set(
        id,
        setTimeout(() => {
          if (!current()) return
          const before = working.size
          updateWorking(id, ports.replica.row?.('sessions', id))
          if (before !== working.size) history()
        }, delay),
      )
    }
    const resetWorking = () => {
      for (const timer of working.values()) clearTimeout(timer)
      working.clear()
      // Whole scope only at bootstrap/rescope; ordinary updates read their ids.
      for (const row of ports.replica.rows('sessions')) updateWorking(row.sessionId, row)
    }
    resetWorking()
    async function poll<K extends HeaderInputKey>(
      key: K,
      query: () => Promise<HeaderInputRows[K]>,
      accept: (value: HeaderInputRows[K]) => boolean = () => true,
    ): Promise<void> {
      if (!current() || pending.has(key)) return
      pending.add(key)
      try {
        const value = await query()
        if (!current() || !accept(value)) return
        publish(key, value)
        if (key === 'lifecycle') lifecycleReceived = true
      } catch (error) {
        if (current()) failed(key, error)
      } finally {
        pending.delete(key)
      }
    }
    const quota = () => poll('quota', () => ports.api.quota.summary.query())
    const lifecycle = () => {
      if (!lifecycleReceived) void poll('lifecycle', () => ports.api.settings.get.query())
    }
    const history = () => {
      const api = ports.api.sessions?.concurrencyHistory
      if (!api) return
      void poll(
        'history',
        () => api.query(),
        (reading) =>
          reading.buckets.length === 24 &&
          Number.isFinite(reading.bucketMs) &&
          reading.bucketMs > 0 &&
          Number.isInteger(reading.peak) &&
          reading.peak >= 0 &&
          reading.buckets.every(
            (bucket) =>
              Number.isInteger(bucket.count) &&
              bucket.count >= 0 &&
              Number.isFinite(Date.parse(bucket.start)),
          ),
      )
    }
    const off = ports.replica.subscribeAddressedBatch?.((batch) => {
      if (!current()) return
      const before = working.size
      if (batch.type === 'replace') resetWorking()
      else
        for (const record of batch.rows) {
          if (record.kind !== 'sessions') continue
          const row = ports.replica.row?.('sessions', record.id)
          updateWorking(record.id, row)
        }
      if (before !== working.size) history()
    })
    const timer = setInterval(() => {
      void quota()
      lifecycle()
    }, 60_000)
    const historyTimer = setInterval(history, 5 * 60_000)
    run.stop = () => {
      clearInterval(timer)
      clearInterval(historyTimer)
      off?.()
      for (const deadline of working.values()) clearTimeout(deadline)
      working.clear()
    }
    void quota()
    lifecycle()
    history()
  }
  function stop(): void {
    const previous = generation
    generation = undefined
    previous?.stop()
  }
  return {
    inputs,
    diagnostics,
    start,
    stop,
    destroy() {
      stop()
      destroyed = true
      delete samples.quota
      delete samples.history
      delete samples.lifecycle
      listeners.clear()
    },
  }
}
