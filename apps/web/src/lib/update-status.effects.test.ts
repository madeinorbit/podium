/**
 * Synced effect records are a trigger for the update-status reader, never a
 * dependency (POD-6683). A real pool carries the records, as the feed does.
 */
import type { ReplicaAddressedBatch, ReplicaKind } from '@podium/client-core/replica'
import { createRuntimeWorklistPool, type WorklistRuntime } from '@podium/client-graph/runtime-pool'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Trpc } from '@/app/trpc'

vi.mock('@/lib/workspace-request', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/workspace-request')>()),
  workspaceFetch: async () => ({ ok: false }),
}))

const { ACTIVE_POLL_MS, UpdateStatus, WAKE_MIN_AGE_MS } = await import('./update-status')

type Row = Readonly<Record<string, unknown>>
const stamp = '2026-11-08T12:00:00.000Z'
const UPDATE = 'eff_00000000-0000-4000-8000-0000000000e1'
const OTHER = 'eff_00000000-0000-4000-8000-0000000000e2'
const running = { id: 'op_1', kind: 'update', state: 'running', steps: [] }

function effectRecord(id: string, kind: string, status: string): Row {
  return {
    id,
    kind,
    target: { kind: 'machine', id: 'mach_1' },
    input: {},
    cancelRequested: false,
    effect: { status, attempts: 1 },
    createdBy: 'u-1',
    createdAt: stamp,
    updatedAt: stamp,
    revision: 1,
  }
}

/** The smallest runtime a pool attaches to: an effects table and its batches. */
function poolRuntime() {
  const effects = new Map<string, Row>()
  const listeners: ((batch: ReplicaAddressedBatch) => void)[] = []
  const rt = {
    principal: { userId: 'u-1' },
    readLocal: (key: string) => (key === 'repos' ? [] : null),
    onLocals: () => () => {},
    replica: {
      rows: (kind: ReplicaKind) => (kind === 'effects' ? [...effects.values()] : []),
      row: (kind: ReplicaKind, id: string) => (kind === 'effects' ? effects.get(id) : undefined),
      subscribeAddressedBatch(listener: (batch: ReplicaAddressedBatch) => void) {
        listeners.push(listener)
        return () => listeners.splice(listeners.indexOf(listener), 1)
      },
    },
    outbox: {
      pending: () => [],
      awaiting: () => [],
      deadLetters: () => [],
      subscribe: () => () => {},
      enqueue: async () => {},
    },
    subscribeOutboxOutcomes: () => () => {},
    attachPoolWriter: () => () => {},
    spawnNotices: { error: () => {}, info: () => {} },
  }
  const handle = createRuntimeWorklistPool(rt as unknown as WorklistRuntime)
  return {
    pool: handle.pool,
    /** One feed batch: the row changes, then every subscriber hears it. */
    publish(id: string, value: Row) {
      effects.set(id, value)
      const batch: ReplicaAddressedBatch = { type: 'update', rows: [{ kind: 'effects', id }] }
      for (const listener of [...listeners]) listener(batch)
    },
    dispose: () => handle.dispose(),
  }
}

function client() {
  const active = vi.fn(async (): Promise<unknown> => null)
  const trpc = {
    operations: { active: { query: active }, history: { query: vi.fn(async () => []) } },
    updates: {
      fleet: { query: vi.fn(async () => ({ machines: [], allMachines: [] })) },
      proposal: { query: vi.fn(async () => null) },
    },
  } as unknown as Trpc
  return { trpc, active }
}

let status: InstanceType<typeof UpdateStatus> | undefined
let runtime: ReturnType<typeof poolRuntime> | undefined

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  status?.dispose()
  status = undefined
  runtime?.dispose()
  runtime = undefined
  vi.useRealTimers()
})

describe('UpdateStatus and synced effect records', () => {
  it('reads exactly once when a new update effect record arrives', async () => {
    const { trpc, active } = client()
    status = new UpdateStatus('http://podium.test', { trpc })
    runtime = poolRuntime()
    const stop = status.followEffects(runtime.pool)
    await vi.advanceTimersByTimeAsync(0)
    expect(active).toHaveBeenCalledTimes(1)

    // Another device asked for an update: its record reaches this device.
    runtime.publish(UPDATE, effectRecord(UPDATE, 'server.update', 'pending'))
    await vi.advanceTimersByTimeAsync(0)
    expect(active).toHaveBeenCalledTimes(2)

    // Nothing is running on the server yet, so nothing polls.
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(active).toHaveBeenCalledTimes(2)
    stop()
  })

  it('ignores effect records that are not an update or a server move', async () => {
    const { trpc, active } = client()
    status = new UpdateStatus('http://podium.test', { trpc })
    runtime = poolRuntime()
    status.followEffects(runtime.pool)
    await vi.advanceTimersByTimeAsync(0)
    runtime.publish(OTHER, effectRecord(OTHER, 'session.interrupt', 'pending'))
    await vi.advanceTimersByTimeAsync(0)
    expect(active).toHaveBeenCalledTimes(1)
  })

  it('a status change shows the started operation, which is then followed by polling', async () => {
    const { trpc, active } = client()
    status = new UpdateStatus('http://podium.test', { trpc })
    runtime = poolRuntime()
    runtime.publish(UPDATE, effectRecord(UPDATE, 'server.update', 'pending'))
    status.followEffects(runtime.pool)
    await vi.advanceTimersByTimeAsync(0)
    active.mockResolvedValue(running)
    runtime.publish(UPDATE, effectRecord(UPDATE, 'server.update', 'running'))
    await vi.advanceTimersByTimeAsync(0)
    expect(status.operation?.id).toBe('op_1')
    const calls = active.mock.calls.length
    await vi.advanceTimersByTimeAsync(3 * ACTIVE_POLL_MS)
    expect(active.mock.calls.length).toBe(calls + 3)
  })

  it('works with the replica unavailable: no pool ever attaches, and focus still finds the update', async () => {
    const { trpc, active } = client()
    status = new UpdateStatus('http://podium.test', { trpc })
    status.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(status.operation).toBeNull()

    active.mockResolvedValue(running)
    await vi.advanceTimersByTimeAsync(WAKE_MIN_AGE_MS)
    window.dispatchEvent(new Event('focus'))
    await vi.advanceTimersByTimeAsync(0)
    expect(status.operation?.id).toBe('op_1')
    await vi.advanceTimersByTimeAsync(2 * ACTIVE_POLL_MS)
    expect(active).toHaveBeenCalledTimes(4)
  })
})
