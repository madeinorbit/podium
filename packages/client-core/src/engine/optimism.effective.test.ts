import { asIssueId, asMutationId, asSessionId, type IssueProjection, type IssueWire, type SessionMeta } from '@podium/model'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PodiumClientApi } from '../api'
import type { OutboxEntry } from '../outbox'
import { createEffectiveChanges, type EffectiveAddress, type EffectiveReadView, type EffectivePublication, type EffectiveLocalState } from './effective-changes'
import type { ReplicaKind, ReplicaRows } from '../replica/contract'
import { OptimismLedger, type OptimismBase, type OptimisticPublicationMeasurement } from './optimism'
import { AWAITING_TRUTH_TTL_MS } from './overlay'
import type { EngineState } from './state'
import { effectiveView } from './effective-view'
import type { ReplicaBindingSnapshot } from './replica-binding'
import type { EngineOutbox } from './wiring'

const session = (id = 's1'): SessionMeta => ({ sessionId: asSessionId(id), name: 'base' }) as SessionMeta
const rename = (id: string, name: string, target = 's1'): OutboxEntry => ({
  mutationId: asMutationId(id), kind: 'rename', input: { sessionId: asSessionId(target), name }, queuedAt: 1,
})
const kinds = ['sessions', 'issues', 'issueProjections'] as const
const key = (row: object): string => 'sessionId' in row ? String(row.sessionId) : String((row as IssueWire).id)
const ledgers: OptimismLedger<PodiumClientApi>[] = []
afterEach(() => { for (const ledger of ledgers.splice(0)) ledger.dispose(); vi.useRealTimers() })

function harness(opts: { enabled?: boolean; queued?: OutboxEntry[]; awaiting?: OutboxEntry[]; size?: number; spawnFails?: boolean } = {}) {
  const base: OptimismBase = {
    sessions: Array.from({ length: opts.size ?? 2 }, (_, i) => session(`s${i + 1}`)),
    issues: [{ id: asIssueId('i1'), title: 'base', archived: false } as IssueWire],
    issueProjections: [{ id: asIssueId('i1'), title: 'base', archived: false } as IssueProjection],
  }
  let queue = opts.queued ?? []
  let painted: Partial<EngineState> = { ...base }
  let depth = 0
  let addresses: EffectiveAddress[] = []
  const commits: Array<{ state: Partial<EngineState>; addresses: EffectiveAddress[] }> = []
  const measures: OptimisticPublicationMeasurement[] = []
  const retire = vi.fn()
  const outbox = {
    pending: () => queue, awaiting: () => opts.awaiting ?? [], retireAwaiting: retire,
    enqueue: vi.fn(async (kind, input, options) => {
      const entry = { kind, input, ...options, queuedAt: Date.now() } as OutboxEntry
      queue = [...queue, entry]
      ledger.recomputeAll()
      return entry
    }),
  }
  let publisher: ReturnType<typeof createEffectiveChanges> | undefined
  const publications: EffectivePublication[] = []
  const view = (snapshot: Partial<EngineState>): EffectiveReadView => ({
    commit: snapshot,
    row: <K extends ReplicaKind>(kind: K, id: string) =>
      ((snapshot[kind as keyof EngineState] as object[] | undefined)?.find((r) => key(r) === id)) as ReplicaRows[K] | undefined,
    ids: (kind) => ((snapshot[kind as keyof EngineState] as object[] | undefined) ?? []).map(key),
    local: (key) => snapshot[key] as EffectiveLocalState[typeof key],
  })
  const commit = () => {
    const rows = addresses
    addresses = []
    commits.push({ state: painted, addresses: rows })
    publisher?.publish({ type: 'update', view: view(painted), rows, local: [] })
  }
  const ledger = new OptimismLedger({
    api: { sessions: { create: { mutate: async () => { if (opts.spawnFails) throw new Error('spawn refused') } } } } as unknown as PodiumClientApi, spawnConfirmGraceMs: 0, outbox: outbox as unknown as EngineOutbox,
    notices: { error: () => {}, info: () => {} }, base: () => base,
    paintedIssues: () => painted.issues!, effectiveChanges: opts.enabled ?? true,
    measureEffectiveChanges: (m) => measures.push(m),
    publish: (patch, rows) => { painted = { ...painted, ...patch }; addresses.push(...rows ?? []); if (!depth) commit() },
    batch: (fn) => { depth++; try { fn() } finally { if (--depth === 0) commit() } },
  })
  ledgers.push(ledger)
  // Seed through the same fold as runtime construction, without a publication.
  for (const kind of kinds) {
    Object.assign(painted, { [kind]: ledger.foldSeed(kind, base[kind] as object[], key).rows })
  }
  const seed = painted
  publisher = createEffectiveChanges(view(seed))
  publisher.subscribe((event) => publications.push(event))
  return { ledger, base, outbox, commits, measures, retire, seed, publications,
    state: () => painted, queue: () => queue,
    setQueue: (entries: OutboxEntry[]) => { queue = entries; ledger.recomputeAll() },
  }
}

/** Test-only oracle: every visibly changed row must be addressed. The shipping
 * adapter never runs this collection diff. Replaying addresses must equal legacy. */
function assertComplete(h: ReturnType<typeof harness>): void {
  let previous = h.seed
  const pilot = Object.fromEntries(kinds.map((kind) => [kind, new Map((previous[kind] as object[]).map((r) => [key(r), r]))]))
  for (const [index, { state, addresses }] of h.commits.entries()) {
    const publication = h.publications[index + 1]!
    expect(publication.type).toBe('update')
    expect(publication.view.commit).toBe(state)
    if (publication.type !== 'update') throw new Error('expected update')
    for (const kind of kinds) {
      const before = new Map((previous[kind] as object[]).map((r) => [key(r), r]))
      const after = new Map((state[kind] as object[]).map((r) => [key(r), r]))
      for (const id of new Set([...before.keys(), ...after.keys()])) {
        if (JSON.stringify(before.get(id)) !== JSON.stringify(after.get(id))) {
          expect(addresses, `${kind}/${id} was not addressed`).toContainEqual({ kind, id })
        }
      }
      for (const address of publication.rows.filter((a) => a.kind === kind)) {
        const row = publication.view.row(kind, address.id)
        expect(address.presence).toBe(row === undefined ? 'absent' : 'present')
        if (row) pilot[kind]!.set(address.id, row)
        else pilot[kind]!.delete(address.id)
      }
      expect(pilot[kind]).toEqual(after)
    }
    previous = state
  }
}

describe('optimistic effective addresses', () => {
  it('paints offline enqueue and rolls failed persistence back; omission fails the replay oracle', async () => {
    for (const enabled of [false, true]) {
      const h = harness({ enabled })
      h.outbox.enqueue.mockRejectedValueOnce(new Error('disk unavailable'))
      await expect(h.ledger.enqueueOverlayed('rename', { sessionId: asSessionId('s1'), name: 'local' })).rejects.toThrow('disk unavailable')
      expect(h.commits[0]!.state.sessions![0]!.name).toBe('local')
      expect(h.state().sessions![0]!.name).toBe('base')
      if (enabled) assertComplete(h)
      else expect(() => assertComplete(h)).toThrow(/was not addressed/)
    }
    const h = harness()
    await h.ledger.enqueueOverlayed('rename', { sessionId: asSessionId('s1'), name: 'offline' })
    expect(h.state().sessions![0]!.name).toBe('offline')
    assertComplete(h)
  })

  it('reports old and new recovery targets, queue reorder, rejection and discard', () => {
    const first = rename('one', 'first')
    const second = rename('two', 'second')
    const h = harness({ queued: [first, second] })
    h.setQueue([second, first])
    expect(h.state().sessions![0]!.name).toBe('first')
    h.setQueue([{ ...first, input: { sessionId: asSessionId('s2'), name: 'edited' } }])
    expect(h.commits.at(-1)!.addresses).toEqual(expect.arrayContaining([
      { kind: 'sessions', id: 's1' }, { kind: 'sessions', id: 's2' },
    ]))
    const dropped = h.queue()[0]!
    h.setQueue([])
    h.ledger.mutationDropped(dropped)
    assertComplete(h)
  })

  it.each(['ack-first', 'echo-first', 'evict', 'expiry'] as const)('%s keeps all overlay presence transitions addressed', async (order) => {
    const h = harness()
    await h.ledger.enqueueOverlayed('rename', { sessionId: asSessionId('s1'), name: 'local' })
    const entry = h.queue()[0]!
    if (order === 'echo-first') {
      h.base.sessions = [{ ...session(), name: 'local' }, session('s2')]
      h.ledger.recomputeAll()
    }
    if (order === 'evict') {
      h.base.sessions = [session('s2')]
      h.ledger.recomputeAll()
    }
    h.ledger.mutationApplied(entry)
    h.setQueue([])
    if (order === 'ack-first') {
      h.base.sessions = [{ ...session(), name: 'local' }, session('s2')]
      h.ledger.recomputeAll()
    }
    if (order === 'expiry') {
      vi.useFakeTimers()
      vi.setSystemTime(Date.now() + AWAITING_TRUTH_TTL_MS + 50)
      h.ledger.recomputeAll()
      expect(h.state().sessions![0]!.name).toBe('base')
      expect(h.retire).toHaveBeenCalledWith(entry.mutationId)
    }
    assertComplete(h)
  })

  it('restores durable awaiting work and reports mirrored issue projection retirement', () => {
    const entry: OutboxEntry = { mutationId: asMutationId('curation'), kind: 'issueUpdate',
      input: { id: asIssueId('i1'), patch: { archived: true } }, queuedAt: Date.now(), resolvedAt: Date.now() }
    const h = harness({ awaiting: [entry] })
    expect(h.state().issueProjections![0]!.archived).toBe(true)
    h.base.issues = [{ ...h.base.issues[0]!, archived: true }]
    // Issue truth retires the shared overlay; the projection base still lags.
    h.ledger.recomputeAll()
    expect(h.state().issueProjections![0]!.archived).toBe(false)
    expect(h.commits.at(-1)!.addresses).toContainEqual({ kind: 'issueProjections', id: 'i1' })
    assertComplete(h)
  })

  it.each([false, true])('spawn placeholders settle as one session/issue pair (failure=%s)', async (spawnFails) => {
    const h = harness({ spawnFails })
    const made = h.ledger.spawnDraftAgent({ target: { path: '/w', repoPath: '/w' }, agentKind: 'codex', firstPrompt: 'hello' })
    expect(h.commits).toHaveLength(1)
    expect(h.commits[0]!.addresses).toEqual(expect.arrayContaining([
      { kind: 'sessions', id: made.sessionId }, { kind: 'issues', id: made.issueId },
    ]))
    expect(await made.settled).toBe(!spawnFails)
    if (!spawnFails) {
      h.base.sessions = h.state().sessions!
      h.base.issues = h.state().issues!
      h.ledger.recomputeAll()
    }
    expect(h.state().pendingSpawnIds?.size).toBe(0)
    expect(h.state().pendingSpawnPrompts?.size).toBe(0)
    assertComplete(h)
  })

  it('measures overlay bookkeeping separately from the legacy collection fold', async () => {
    const results = []
    for (const size of [100, 10000]) {
      const h = harness({ size })
      h.measures.length = 0
      await h.ledger.enqueueOverlayed('rename', { sessionId: asSessionId('s1'), name: 'local' })
      const m = h.measures.find((m) => m.entity === 'sessions')!
      expect(m.overlayEntries).toBe(1)
      expect(m.addresses).toBe(1)
      expect(m.legacyBaseRows).toBe(size)
      expect(m.adapterMs).toBeGreaterThanOrEqual(0)
      // Development-only full-array bridge baseline. These are real visits,
      // measured in the test, never installed on the runtime hot path.
      let bridgeVisits = 0
      const start = performance.now()
      const before = new Map(h.seed.sessions!.map((row) => { bridgeVisits++; return [row.sessionId, row] }))
      const bridgeChanges: string[] = []
      for (const row of h.state().sessions!) {
        bridgeVisits++
        if (before.get(row.sessionId) !== row) bridgeChanges.push(row.sessionId)
        before.delete(row.sessionId)
      }
      bridgeChanges.push(...before.keys())
      expect(bridgeChanges).toEqual(['s1'])
      const bridgeMs = performance.now() - start
      expect(bridgeVisits).toBe(size * 2)
      let indexVisits = 0
      const pinned = effectiveView(h.state() as EngineState, {} as ReplicaBindingSnapshot,
        (_kind, rows) => { indexVisits += rows })
      const indexStart = performance.now()
      expect(pinned.row('sessions', 's1')?.name).toBe('local')
      pinned.row('sessions', 's1')
      const indexMs = performance.now() - indexStart
      expect(indexVisits).toBe(size) // one lazy index, separately counted
      results.push({ ...m, bridgeVisits, bridgeMs, indexVisits, indexMs })
      assertComplete(h)
    }
    process.stdout.write(`D4 bookkeeping vs legacy fold: ${JSON.stringify(results)}\n`)
  })
})
