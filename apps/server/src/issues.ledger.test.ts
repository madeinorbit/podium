import type { MetadataChange, ServerMessage } from '@podium/protocol'
import { normalizeSettings } from '@podium/runtime'
import { Ledger } from '@podium/sync'
import { describe, expect, it, vi } from 'vitest'
import { type IssueDeps, IssueService } from './modules/issues/service'
import { issueTestPlumbing } from './modules/issues/service/test-plumbing'
import { SessionStore } from './store'

/**
 * Issue writes on the write-seam Ledger ([spec:SP-3fe2] #255): the REAL Ledger
 * over the REAL SessionStore (store.sync + store.transact), so these tests pin
 * the production wiring — change rows commit atomically with the issue row
 * write, derived ripples reconcile, deletes emit replayable removes.
 */

function harness() {
  // Mutable wall clock: the in-place-rollback tests advance it so a missing
  // updatedAt restore is a REAL wire difference the reconcile would append.
  let wallClock = '2026-07-01T00:00:00.000Z'
  const store = new SessionStore(':memory:')
  const ledger = new Ledger({
    repo: store.sync,
    now: () => 1_000,
    transact: (fn) => store.transact(fn),
  })
  // What reaches clients: legacy snapshots via publishComputed; delta batches
  // via the ledger's onAppended pipe (#256 — publishComputed carries no changes
  // any more, the funnel's ordered pipe is THE metadataDelta emitter).
  const published: { snapshot: ServerMessage }[] = []
  const appended: MetadataChange[][] = []
  ledger.onAppended((changes) => appended.push(changes))
  const plumbing = issueTestPlumbing()
  const deps: IssueDeps = {
    store,
    listSessions: () => [],
    getSettings: () =>
      normalizeSettings({
        gitWorkflow: {
          defaultParentBranch: '',
          mergeStyle: 'ff-only',
          autoRebaseBeforeMerge: true,
        },
        sessionDefaults: { agent: 'claude-code' },
      }),
    spawnSession: () => ({ sessionId: 's1' }),
    repoOp: async () => ({ ok: true, output: '' }),
    funnel: {
      run: plumbing.funnel.run,
      publishComputed: (snapshot) => published.push({ snapshot }),
    },
    ledger,
    publishSpecs: plumbing.publishSpecs,
    now: () => wallClock,
  }
  return {
    store,
    ledger,
    published,
    appended,
    svc: new IssueService(deps),
    setNow: (iso: string) => {
      wallClock = iso
    },
  }
}

/** Replica-style fold: apply a change stream to an id → value map. */
function fold(changes: MetadataChange[]): Map<string, unknown> {
  const state = new Map<string, unknown>()
  for (const c of changes) {
    if (c.op === 'upsert') state.set(c.id, (c as { value?: unknown }).value)
    else state.delete(c.id)
  }
  return state
}

describe('issue writes on the write-seam Ledger ([spec:SP-3fe2] #255)', () => {
  it('commits the upsert change row atomically with the issue row write', () => {
    const { ledger, svc, published, appended } = harness()
    const wire = svc.create({ repoPath: '/r', title: 'A', startNow: false })
    const recorded = ledger.changesSince(0) ?? []
    expect(recorded.some((c) => c.id === wire.id && c.op === 'upsert')).toBe(true)
    // The committed change entered the delta pipe (durable before fan-out) and
    // the legacy snapshot fanned out alongside it.
    expect(appended.flat().some((c) => c.id === wire.id && c.op === 'upsert')).toBe(true)
    expect(published.length).toBeGreaterThan(0)
  })

  it('a throw between the row write and the change append rolls BOTH back', () => {
    const { store, ledger, svc } = harness()
    const wire = svc.create({ repoPath: '/r', title: 'original', startNow: false })
    const cursorBefore = ledger.cursor()
    const row = store.issues.listIssueRows().find((r) => r.id === wire.id)
    if (!row) throw new Error('row missing')
    expect(() =>
      ledger.commit({
        write: () => store.issues.upsertIssue({ ...row, title: 'mutated' }),
        changes: () => {
          throw new Error('declaration failed')
        },
      }),
    ).toThrow('declaration failed')
    // The entity write inside the same transact span rolled back with the append.
    expect(store.issues.listIssueRows().find((r) => r.id === wire.id)?.title).toBe('original')
    expect(ledger.cursor()).toBe(cursorBefore)
    // The baseline is untouched: re-declaring the ORIGINAL wire truth is a no-op.
    const redo = ledger.commit({
      write: () => {},
      changes: () => [{ entity: 'issue', id: wire.id, op: 'upsert', value: wire }],
    })
    expect(redo.changes).toEqual([])
  })

  it('closing an issue reconciles derived ripples: the dependent flips to ready', () => {
    const { svc, appended } = harness()
    const a = svc.create({ repoPath: '/r', title: 'A', startNow: false })
    const b = svc.create({ repoPath: '/r', title: 'B', startNow: false })
    svc.addDep(b.id, a.id, 'blocks') // B waits on A
    expect(svc.get(b.id)?.blocked).toBe(true)
    appended.length = 0
    svc.close(a.id)
    // The full-list reconcile caught B's DERIVED flip — no write touched B's
    // row — and it reached the delta pipe via onAppended.
    const rippled = appended.flat()
    const bChange = rippled.find((c) => c.id === b.id && c.op === 'upsert') as
      | { value?: { ready?: boolean; blocked?: boolean } }
      | undefined
    expect(bChange?.value?.ready).toBe(true)
    expect(bChange?.value?.blocked).toBe(false)
  })

  it('internal draft purge emits the remove and the log replays to live state', () => {
    const { ledger, svc, appended } = harness()
    const parent = svc.create({ repoPath: '/r', title: 'epic', startNow: false })
    const child = svc.create({ repoPath: '/r', title: 'kid', startNow: false, parentId: parent.id })
    appended.length = 0
    svc.purgeEmptyDraft(parent.id)
    // The committed remove entered the delta pipe (the reconcile alone would
    // dedup it away — the baseline already dropped the id — and delta clients
    // would keep the deleted issue until their next snapshot).
    const emitted = appended.flat()
    expect(emitted.some((c) => c.id === parent.id && c.op === 'remove')).toBe(true)
    // Reparented child rippled in the same burst (its parentId cleared).
    const childChange = emitted.find((c) => c.id === child.id && c.op === 'upsert') as
      | { value?: { parentId?: string } }
      | undefined
    expect(childChange?.value?.parentId).toBeUndefined()
    // Replica-style replay of the WHOLE durable log folds to the live truth.
    const folded = fold(ledger.changesSince(0) ?? [])
    expect([...folded.keys()].sort()).toEqual(
      svc
        .allWire()
        .map((i) => i.id)
        .sort(),
    )
    expect(folded.has(parent.id)).toBe(false)
  })

  it('a failed change append on create leaves NO phantom row in memory (map installs post-commit, #247)', () => {
    const { store, ledger, svc } = harness()
    svc.create({ repoPath: '/r', title: 'pre-existing', startNow: false })
    const cursorBefore = ledger.cursor()
    const spy = vi.spyOn(store.sync, 'appendChanges').mockImplementationOnce(() => {
      throw new Error('append failed')
    })
    expect(() => svc.create({ repoPath: '/r', title: 'phantom', startNow: false })).toThrow(
      'append failed',
    )
    spy.mockRestore()
    // Memory truth unchanged: the rows map never installed the rolled-back row…
    expect(svc.allWire().map((w) => w.title)).toEqual(['pre-existing'])
    // …the store rolled it back with the append, and nothing was logged.
    expect(store.issues.listIssueRows().map((r) => r.title)).toEqual(['pre-existing'])
    expect(ledger.cursor()).toBe(cursorBefore)
    // A subsequent full-list reconcile appends NOTHING — no fabricated upsert
    // for a row the store never accepted.
    const reconciled = ledger.reconcile(
      'issue',
      svc.allWire().map((w) => ({ id: w.id, value: w })),
    )
    expect(reconciled).toEqual([])
    expect(ledger.cursor()).toBe(cursorBefore)
  })

  it('a failed change append on UPDATE rolls the in-place row mutation back (#247)', () => {
    const { store, ledger, svc, setNow } = harness()
    const wire = svc.create({ repoPath: '/r', title: 'old title', startNow: false })
    const cursorBefore = ledger.cursor()
    setNow('2026-07-01T00:01:00.000Z') // a later stamp must roll back too
    const spy = vi.spyOn(store.sync, 'appendChanges').mockImplementationOnce(() => {
      throw new Error('append failed')
    })
    // update() mutates the MAP-OWNED row object in place BEFORE the commit;
    // persistWith's backup seam must roll those fields back on the throw.
    expect(() => svc.update(wire.id, { title: 'phantom' })).toThrow('append failed')
    spy.mockRestore()
    // Memory shows the OLD title (in-place rollback — same object reference)…
    expect(svc.get(wire.id)?.title).toBe('old title')
    // …matching the store, whose write rolled back inside the transact span.
    expect(store.issues.getIssue(wire.id)?.title).toBe('old title')
    expect(ledger.cursor()).toBe(cursorBefore)
    // A follow-up full-list reconcile appends NOTHING — the phantom title is
    // gone from memory, so nothing fabricates a durable upsert for it.
    const reconciled = ledger.reconcile(
      'issue',
      svc.allWire().map((w) => ({ id: w.id, value: w })),
    )
    expect(reconciled).toEqual([])
    expect(ledger.cursor()).toBe(cursorBefore)
    // A successful retry then works end to end.
    const retried = svc.update(wire.id, { title: 'new title' })
    expect(retried.title).toBe('new title')
    expect(svc.get(wire.id)?.title).toBe('new title')
    expect(store.issues.getIssue(wire.id)?.title).toBe('new title')
    const healed = ledger.changesSince(cursorBefore) ?? []
    expect(
      healed.some(
        (c) =>
          c.id === wire.id &&
          c.op === 'upsert' &&
          (c.value as { title?: string }).title === 'new title',
      ),
    ).toBe(true)
  })

  it('a failed extra-write commit (setLabels) restores updatedAt and leaves no phantom label (#247)', () => {
    const { store, ledger, svc, setNow } = harness()
    const wire = svc.create({ repoPath: '/r', title: 'labelled', startNow: false })
    const updatedAtBefore = svc.get(wire.id)?.updatedAt
    const cursorBefore = ledger.cursor()
    setNow('2026-07-01T00:01:00.000Z')
    const spy = vi.spyOn(store.sync, 'appendChanges').mockImplementationOnce(() => {
      throw new Error('append failed')
    })
    expect(() => svc.setLabels(wire.id, ['urgent'])).toThrow('append failed')
    spy.mockRestore()
    // The label write rolled back with the row, and the in-place updatedAt
    // stamp was restored — a reconcile sees byte-identical wire truth.
    expect(store.issues.getIssueLabels(wire.id)).toEqual([])
    expect(svc.get(wire.id)?.updatedAt).toBe(updatedAtBefore)
    const reconciled = ledger.reconcile(
      'issue',
      svc.allWire().map((w) => ({ id: w.id, value: w })),
    )
    expect(reconciled).toEqual([])
    expect(ledger.cursor()).toBe(cursorBefore)
  })

  it('a failed change append on purge keeps the row in memory and the store (#247)', () => {
    const { store, ledger, svc } = harness()
    const wire = svc.create({ repoPath: '/r', title: 'survivor', startNow: false })
    const cursorBefore = ledger.cursor()
    const spy = vi.spyOn(store.sync, 'appendChanges').mockImplementationOnce(() => {
      throw new Error('append failed')
    })
    expect(() => svc.purgeEmptyDraft(wire.id)).toThrow('append failed')
    spy.mockRestore()
    // Memory truth intact (the re-hydrate runs only after a committed tx)…
    expect(svc.get(wire.id)?.title).toBe('survivor')
    // …and the store delete rolled back inside the same transact span.
    expect(store.issues.listIssueRows().some((r) => r.id === wire.id)).toBe(true)
    expect(ledger.cursor()).toBe(cursorBefore)
    // A subsequent reconcile of the (unchanged) truth appends nothing.
    const reconciled = ledger.reconcile(
      'issue',
      svc.allWire().map((w) => ({ id: w.id, value: w })),
    )
    expect(reconciled).toEqual([])
  })

  it('boot reconcile records rows changed while the server was down, without fan-out', () => {
    const { store, svc } = harness()
    const wire = svc.create({ repoPath: '/r', title: 'before', startNow: false })
    // Simulate an offline mutation + restart: new ledger/service over the same store.
    const row = store.issues.listIssueRows().find((r) => r.id === wire.id)
    if (!row) throw new Error('row missing')
    store.issues.upsertIssue({ ...row, title: 'changed offline' })
    const ledger2 = new Ledger({
      repo: store.sync,
      now: () => 2_000,
      transact: (fn) => store.transact(fn),
    })
    const published2: { snapshot: ServerMessage }[] = []
    const plumbing2 = issueTestPlumbing()
    const svc2 = new IssueService({
      store,
      listSessions: () => [],
      getSettings: () => normalizeSettings({ sessionDefaults: { agent: 'claude-code' } }),
      spawnSession: () => ({ sessionId: 's1' }),
      repoOp: async () => ({ ok: true, output: '' }),
      funnel: {
        run: plumbing2.funnel.run,
        publishComputed: (snapshot) => published2.push({ snapshot }),
      },
      ledger: ledger2,
      publishSpecs: plumbing2.publishSpecs,
      now: () => '2026-07-02T00:00:00.000Z',
    })
    const cursorBefore = ledger2.cursor()
    svc2.boot()
    expect(published2).toEqual([]) // boot reconcile never fans out
    const healed = ledger2.changesSince(cursorBefore) ?? []
    const change = healed.find((c) => c.id === wire.id && c.op === 'upsert') as
      | { value?: { title?: string } }
      | undefined
    expect(change?.value?.title).toBe('changed offline')
  })
})
