/**
 * The one update-status reader (POD-6683): when it polls, and when it does not.
 * Fake timers, a fake plain-HTTP client, and no socket or replica anywhere.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Trpc } from '@/app/trpc'

vi.mock('@/lib/workspace-request', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/workspace-request')>()),
  workspaceFetch: async () => ({ ok: false }),
}))

const { ACTIVE_POLL_MS, RETRY_POLL_MS, STALE_READ_MS, UpdateStatus, WATCHED_POLL_MS } =
  await import('./update-status')

const running = { id: 'op_1', kind: 'update', state: 'running', steps: [] }

function client() {
  const active = vi.fn(async (): Promise<unknown> => null)
  const history = vi.fn(async (): Promise<unknown[]> => [])
  const fleet = vi.fn(async (): Promise<unknown> => ({ machines: [], allMachines: [] }))
  const proposal = vi.fn(async (): Promise<unknown> => null)
  const trpc = {
    operations: { active: { query: active }, history: { query: history } },
    updates: { fleet: { query: fleet }, proposal: { query: proposal } },
  } as unknown as Trpc
  return { trpc, active, history, fleet, proposal }
}

let visibility: DocumentVisibilityState = 'visible'
let status: InstanceType<typeof UpdateStatus> | undefined

async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
}

beforeEach(() => {
  vi.useFakeTimers()
  visibility = 'visible'
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => visibility,
  })
})

afterEach(() => {
  status?.dispose()
  status = undefined
  vi.useRealTimers()
})

function reader(transport = client()) {
  status = new UpdateStatus('http://podium.test', { trpc: transport.trpc })
  return { status, ...transport }
}

describe('UpdateStatus polling', () => {
  it('reads once and then nothing while no update runs and no update screen is open', async () => {
    const { status, active } = reader()
    status.start()
    await advance(0)
    expect(active).toHaveBeenCalledTimes(1)
    expect(status.operation).toBeNull()
    await advance(10 * 60_000)
    expect(active).toHaveBeenCalledTimes(1)
  })

  it('polls every second while an operation runs, and stops when it ends', async () => {
    const transport = client()
    transport.active.mockResolvedValue(running)
    const { status, active } = reader(transport)
    status.start()
    await advance(0)
    expect(status.moving).toBe(true)
    await advance(3 * ACTIVE_POLL_MS)
    expect(active).toHaveBeenCalledTimes(4)

    active.mockResolvedValue(null)
    await advance(ACTIVE_POLL_MS)
    expect(status.operation).toBeNull()
    const calls = active.mock.calls.length
    await advance(10 * 60_000)
    expect(active).toHaveBeenCalledTimes(calls)
  })

  it('polls while a machine converges, even with no operation', async () => {
    const transport = client()
    transport.fleet.mockResolvedValue({
      machines: [],
      allMachines: [{ id: 'm1', state: 'downloading', version: '0.4.1' }],
    })
    const { status, fleet } = reader(transport)
    status.start()
    await advance(0)
    await advance(2 * ACTIVE_POLL_MS)
    expect(fleet).toHaveBeenCalledTimes(3)
  })

  it('reads when an update screen opens, polls while it is open, and stops when it closes', async () => {
    const { status, active } = reader()
    status.start()
    await advance(0)
    const release = status.watch()
    await advance(0)
    expect(active).toHaveBeenCalledTimes(2)
    await advance(2 * WATCHED_POLL_MS)
    expect(active).toHaveBeenCalledTimes(4)
    release()
    await advance(10 * WATCHED_POLL_MS)
    expect(active).toHaveBeenCalledTimes(4)
  })

  it('does not poll a hidden tab, and reads at once when it becomes visible', async () => {
    const { status, active } = reader()
    status.start()
    status.watch()
    await advance(0)
    visibility = 'hidden'
    document.dispatchEvent(new Event('visibilitychange'))
    await advance(0)
    const calls = active.mock.calls.length
    await advance(5 * WATCHED_POLL_MS)
    expect(active).toHaveBeenCalledTimes(calls)
    visibility = 'visible'
    document.dispatchEvent(new Event('visibilitychange'))
    await advance(0)
    expect(active).toHaveBeenCalledTimes(calls + 1)
  })

  it('retries a failed first read until the operation is known', async () => {
    const transport = client()
    transport.active.mockRejectedValue(new Error('server is restarting'))
    const { status, active } = reader(transport)
    status.start()
    await advance(0)
    expect(status.operation).toBeUndefined()
    await advance(RETRY_POLL_MS)
    expect(active).toHaveBeenCalledTimes(2)
    active.mockResolvedValue(null)
    await advance(RETRY_POLL_MS)
    expect(status.operation).toBeNull()
    await advance(5 * RETRY_POLL_MS)
    expect(active).toHaveBeenCalledTimes(3)
  })

  it('keeps the last operation through a restart and reads past a hanging request', async () => {
    const transport = client()
    transport.active.mockResolvedValue(running)
    const { status, active } = reader(transport)
    status.start()
    await advance(0)
    // The server goes away and one request never answers.
    active.mockImplementation(() => new Promise(() => {}))
    await advance(STALE_READ_MS - ACTIVE_POLL_MS)
    expect(status.operation?.id).toBe('op_1')
    const hung = active.mock.calls.length
    active.mockResolvedValue({ ...running, state: 'done' })
    await advance(2 * ACTIVE_POLL_MS)
    expect(active.mock.calls.length).toBeGreaterThan(hung)
    expect(status.operation?.state).toBe('done')
  })

  it('never lets a reading that started before an action move the operation', async () => {
    const transport = client()
    transport.active.mockResolvedValue(running)
    const { status, active } = reader(transport)
    status.start()
    await advance(0)
    let answer!: (value: unknown) => void
    active.mockImplementation(() => new Promise((resolve) => (answer = resolve)))
    await advance(ACTIVE_POLL_MS)
    status.noteOperation({ ...running, id: 'op_2' } as never)
    answer(null)
    await advance(0)
    expect(status.operation?.id).toBe('op_2')
  })
})
