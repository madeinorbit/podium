import type { SocketHub } from '@podium/client-core/socket-transport'
import type { ReplicaEvent } from '@podium/sync/replica'
import { describe, expect, it } from 'vitest'
import type { Trpc } from '@/app/trpc'
import { type ShadowReport, startShadowComparison } from './runner'

/** The second connection, faked at the SocketHub seam. The test drives
 *  the Replica adapter's applied hook directly, matching the real wire-v1 path. */
interface FakeHub {
  hub: SocketHub
  applyMetadata(state: {
    cursor: number
    sessions: unknown[]
    issues: unknown[]
    conversations: unknown[]
    automations: unknown[]
    automationRuns: unknown[]
  }): void
  connected: boolean
  disposed: boolean
  health: 'ok' | 'degraded' | 'down'
}

function fakeHubFactory(): { create: (opts: never) => SocketHub; get(): FakeHub } {
  let made: FakeHub | undefined
  const create = (opts: {
    legacyFeed?: { hooks?: { applied?: (state: never) => void } }
    feed?: unknown
  }): SocketHub => {
    // The harness must never build a hub that holds both wire versions — the
    // real SocketHub refuses it at construction, and a fake that quietly
    // accepted both would hide a regression the real one would catch.
    expect(opts.feed).toBeUndefined()
    expect(opts.legacyFeed).toBeDefined()
    const state: FakeHub = {
      connected: false,
      disposed: false,
      health: 'ok',
      applyMetadata: (s) => opts.legacyFeed?.hooks?.applied?.(s as never),
      hub: {
        connect: () => {
          state.connected = true
        },
        dispose: () => {
          state.disposed = true
        },
        connectionHealth: () => ({ status: state.health, rttMs: null, since: 0 }),
      } as unknown as SocketHub,
    }
    made = state
    return state.hub
  }
  return {
    create: create as unknown as (opts: never) => SocketHub,
    get: () => {
      if (made === undefined) throw new Error('no hub was built')
      return made
    },
  }
}

const session = (sessionId: string, name: string) => ({ sessionId, name })

function fakeTrpc(sliceKeys: Array<[string, string]>): Trpc {
  return {
    sync: {
      changesSince: { query: async () => ({ cursor: 0, changes: [] }) },
      feedSlice: {
        query: async () => ({
          feedId: 'f',
          epoch: 'e',
          throughSeq: 1,
          rows: sliceKeys.map(([entity, entityId]) => ({ entity, entityId })),
        }),
      },
    },
  } as unknown as Trpc
}

function build(opts: {
  kernelRows?: Array<{ entity: string; entityId: string; value: unknown; revision?: number }>
  sliceKeys?: Array<[string, string]>
  budgetMs?: number
}) {
  const hubs = fakeHubFactory()
  let emit: (event: ReplicaEvent) => void = () => {}
  const reports: ShadowReport[] = []
  const runner = startShadowComparison({
    kernel: {
      entities: () =>
        (opts.kernelRows ?? []).map((r) => ({ ...r, provenance: { seq: 1 } })) as never,
    } as never,
    trpc: fakeTrpc(opts.sliceKeys ?? []),
    wsClientUrl: 'ws://test/client',
    authorityScoped: false,
    quiesceBudgetMs: opts.budgetMs ?? 200,
    createHub: hubs.create as never,
    onKernelEvent: (listener) => {
      emit = listener
      return () => {
        emit = () => {}
      }
    },
    onReport: (r) => reports.push(r),
  })
  return {
    runner,
    hubs,
    reports,
    live: () => emit({ type: 'posture', posture: 'live', previous: 'cold' }),
  }
}

describe('the two-connection shadow runner', () => {
  it('opens its own v1 connection and connects it', () => {
    const { hubs, runner } = build({})
    expect(hubs.get().connected).toBe(true)
    runner.stop()
    expect(hubs.get().disposed).toBe(true)
  })

  it('reports could-not-sample — and says what was moving — before the replica is live', async () => {
    const { runner, reports } = build({})
    const report = await runner.sample()
    expect(report.status).toBe('could-not-sample')
    expect(report.status === 'could-not-sample' && report.reason).toMatch(/posture is cold/)
    expect(reports).toHaveLength(1)
    runner.stop()
  })

  it('refuses to sample while the second connection is DOWN, even when the kernel is live', async () => {
    const { runner, hubs, live } = build({})
    live()
    hubs.get().health = 'down'
    const report = await runner.sample()
    expect(report.status).toBe('could-not-sample')
    expect(report.status === 'could-not-sample' && report.reason).toMatch(/shadow connection/)
    runner.stop()
  })

  it('samples once quiescent, and reports AGREEMENT from two independent sources', async () => {
    const { runner, hubs, live } = build({
      kernelRows: [{ entity: 'session', entityId: 's1', value: session('s1', 'One') }],
      sliceKeys: [['session', 's1']],
    })
    live()
    // The legacy side is fed by ITS OWN connection — nothing the kernel path
    // touched. That independence is the whole point of the two connections.
    hubs.get().applyMetadata({
      cursor: 1,
      sessions: [session('s1', 'One')],
      issues: [],
      conversations: [],
      automations: [],
      automationRuns: [],
    })
    const report = await runner.sample()
    expect(report.status).toBe('sampled')
    if (report.status !== 'sampled') return
    expect(report.divergences).toEqual([])
    expect(report.counts.agree).toBe(1)
    runner.stop()
  })

  it('CATCHES a content difference between the two paths', async () => {
    const { runner, hubs, live } = build({
      kernelRows: [{ entity: 'session', entityId: 's1', value: session('s1', 'kernel-name') }],
      sliceKeys: [['session', 's1']],
    })
    live()
    hubs.get().applyMetadata({
      cursor: 1,
      sessions: [session('s1', 'legacy-name')],
      issues: [],
      conversations: [],
      automations: [],
      automationRuns: [],
    })
    const report = await runner.sample()
    expect(report.status).toBe('sampled')
    if (report.status !== 'sampled') return
    expect(report.divergences.map((d) => d.class)).toEqual(['content-drift'])
    runner.stop()
  })

  it('CATCHES a row the kernel path holds that the Authority does not', async () => {
    const { runner, live } = build({
      kernelRows: [{ entity: 'issue', entityId: 'leaked', value: { id: 'leaked' } }],
      sliceKeys: [],
    })
    live()
    const report = await runner.sample()
    expect(report.status).toBe('sampled')
    if (report.status !== 'sampled') return
    expect(report.divergences.map((d) => d.class)).toEqual(['kernel-leak'])
    runner.stop()
  })

  it('CATCHES a row the Authority holds that the kernel path lost', async () => {
    const { runner, hubs, live } = build({ kernelRows: [], sliceKeys: [['issue', 'i1']] })
    live()
    hubs.get().applyMetadata({
      cursor: 1,
      sessions: [],
      issues: [{ id: 'i1' }],
      conversations: [],
      automations: [],
      automationRuns: [],
    })
    const report = await runner.sample()
    expect(report.status).toBe('sampled')
    if (report.status !== 'sampled') return
    expect(report.divergences.map((d) => d.class)).toEqual(['kernel-missing'])
    runner.stop()
  })

  it('a row only the legacy path holds, absent from the Authority, is the EXPECTED difference', async () => {
    const { runner, hubs, live } = build({ kernelRows: [], sliceKeys: [] })
    live()
    hubs.get().applyMetadata({
      cursor: 1,
      sessions: [],
      issues: [{ id: 'not-in-my-slice' }],
      conversations: [],
      automations: [],
      automationRuns: [],
    })
    const report = await runner.sample()
    expect(report.status).toBe('sampled')
    if (report.status !== 'sampled') return
    expect(report.divergences).toEqual([])
    expect(report.counts['scoped-out']).toBe(1)
    runner.stop()
  })

  it('PERSISTS NOTHING — the shadow replica never touches the store the app ships on', () => {
    // Stated in the module header ("a user who turns the flag on, runs the shadow,
    // and turns it off again must find their legacy replica exactly as they left
    // it"), and until POD-1252 nothing measured it. It is measured now because the
    // claim became load-bearing twice over: the app's guarantee to the user, and
    // the fact the client audit's `unattributed-store-read` item reads off this
    // root's construction to decide it owes no attribution question. A future edit
    // swapping `memoryStorage()` for `window.localStorage` would silence both — the
    // harness would start adopting the user's rows AND the audit would start
    // grading it — so the swap has to be a red test, not a quiet one.
    const before = { ...window.localStorage }
    const { runner, hubs, live } = build({ kernelRows: [], sliceKeys: [] })
    live()
    hubs.get().applyMetadata({
      cursor: 99,
      sessions: [{ sessionId: 's1', name: 'One' }],
      issues: [{ id: 'i1' }],
      conversations: [],
      automations: [],
      automationRuns: [],
    })
    expect({ ...window.localStorage }).toEqual(before)
    runner.stop()
  })
})
