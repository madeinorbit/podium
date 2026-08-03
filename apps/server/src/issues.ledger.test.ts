import { asSessionId } from '@podium/model'
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
  // WHAT REACHES CLIENTS, since POD-1203: the appended rows, and nothing else.
  // There was a second list here — the legacy snapshots `publishComputed` fanned
  // out — and the fact that it is gone is the deliverable: a snapshot could
  // disagree with the rows below, and that is what a dual read path IS.
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
    spawnSession: () => ({ sessionId: asSessionId('s1') , machine: 'machine-under-test' }),
    repoOp: async () => ({ ok: true, output: '' }),
    funnel: {
      run: plumbing.funnel.run,
    },
    ledger,
    publishSpecs: plumbing.publishSpecs,
    now: () => wallClock,
  }
  return {
    store,
    ledger,
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
    const { ledger, svc, appended } = harness()
    const wire = svc.create({ repoPath: '/r', title: 'A', startNow: false })
    const recorded = ledger.changesSince(0) ?? []
    expect(recorded.some((c) => c.id === wire.id && c.op === 'upsert')).toBe(true)
    // The committed change entered the delta pipe (durable before fan-out), and
    // it carries the VALUE a client is served — which the deleted snapshot used
    // to carry separately.
    const row = appended.flat().find((c) => c.id === wire.id && c.op === 'upsert')
    expect(row).toBeDefined()
    expect((row as { value?: { title?: string } }).value?.title).toBe('A')
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
    const plumbing2 = issueTestPlumbing()
    const svc2 = new IssueService({
      store,
      listSessions: () => [],
      getSettings: () => normalizeSettings({ sessionDefaults: { agent: 'claude-code' } }),
      spawnSession: () => ({ sessionId: asSessionId('s1') , machine: 'machine-under-test' }),
      repoOp: async () => ({ ok: true, output: '' }),
      funnel: {
        run: plumbing2.funnel.run,
      },
      ledger: ledger2,
      publishSpecs: plumbing2.publishSpecs,
      now: () => '2026-07-02T00:00:00.000Z',
    })
    const cursorBefore = ledger2.cursor()
    svc2.boot()
    // WAS: `published2` was empty — "boot reconcile never fans out". There is no
    // snapshot list to be empty any more, so the claim is made where it is now
    // decidable: the reconcile appends its rows and a client learns of them the
    // same way it learns of everything else.
    const healed = ledger2.changesSince(cursorBefore) ?? []
    const change = healed.find(
      (c) => c.id === wire.id && c.op === 'upsert' && c.entity === 'issue',
    ) as { value?: { title?: string } } | undefined
    expect(change?.value?.title).toBe('changed offline')

    // POD-1574: boot reconciliation is what carries projection freshness now that
    // the `issues.session-derived-projection` reaction is deleted. That reaction
    // named `issueProjection` as the kind it reconciled, and it was the only
    // place naming it outside the mutation path — so the boot reconcile's
    // projection half is pinned HERE rather than left to prose. Asserted beside
    // the `issue` row above, because a reconcile that healed only one of the two
    // kinds would satisfy the assertion above on its own.
    const projection = healed.find(
      (c) => c.id === wire.id && c.op === 'upsert' && c.entity === 'issueProjection',
    ) as { value?: { title?: string } } | undefined
    expect(projection?.value?.title).toBe('changed offline')
  })
})

/**
 * Per-entity revision (ADR 2 D3) over the REAL IssuesRepository and the REAL
 * Ledger. The token exists so ADR 1's expected-revision conflict rule has
 * something to check against; these pin the two properties that makes it
 * trustworthy — it moves on every accepted write, and it does NOT move for
 * anything else.
 */
describe('per-entity revision (ADR 2 D3)', () => {
  const revisionOf = (svc: ReturnType<typeof harness>['svc'], id: string): number | undefined =>
    svc.get(id)?.revision

  it('starts at 1 on create and increments on EVERY accepted write', () => {
    const { svc } = harness()
    const wire = svc.create({ repoPath: '/r', title: 'A', startNow: false })
    expect(wire.revision).toBe(1)
    expect(svc.update(wire.id, { title: 'B' }).revision).toBe(2)
    expect(svc.update(wire.id, { title: 'C' }).revision).toBe(3)
    expect(svc.update(wire.id, { priority: 1 }).revision).toBe(4)
    expect(revisionOf(svc, wire.id)).toBe(4)
  })

  it('is per-entity, not a feed position — two issues advance independently', () => {
    // The category error D3 exists to prevent: `seq` is global across entities,
    // so two clients editing different issues have wildly different seqs with no
    // bearing on either issue's staleness. Revision is the per-entity answer.
    const { svc, ledger } = harness()
    const a = svc.create({ repoPath: '/r', title: 'A', startNow: false })
    const b = svc.create({ repoPath: '/r', title: 'B', startNow: false })
    svc.update(a.id, { title: 'A2' })
    svc.update(a.id, { title: 'A3' })
    expect(revisionOf(svc, a.id)).toBe(3)
    expect(revisionOf(svc, b.id)).toBe(1) // untouched by A's writes
    expect(ledger.cursor()).toBeGreaterThan(3) // the feed seq is a different number
  })

  it('rides the change payload, so a replica folding the feed sees the same token as the wire', () => {
    const { svc, appended } = harness()
    const wire = svc.create({ repoPath: '/r', title: 'A', startNow: false })
    appended.length = 0
    const updated = svc.update(wire.id, { title: 'B' })
    const change = appended.flat().find((c) => c.id === wire.id && c.op === 'upsert') as {
      value?: { revision?: number }
    }
    expect(change?.value?.revision).toBe(updated.revision)
    expect(change?.value?.revision).toBe(2)
  })

  it('survives a reboot: it lives in the row, not in memory', () => {
    const { store, svc } = harness()
    const wire = svc.create({ repoPath: '/r', title: 'A', startNow: false })
    svc.update(wire.id, { title: 'B' })
    expect(store.issues.getIssue(wire.id)?.revision).toBe(2)
    // A fresh write against the persisted row continues the sequence rather than
    // restarting it — the value is read back from SQL at each write.
    svc.update(wire.id, { title: 'C' })
    expect(store.issues.getIssue(wire.id)?.revision).toBe(3)
  })

  it('rolls back with the transaction: a failed write burns no revision', () => {
    const { store, ledger, svc } = harness()
    const wire = svc.create({ repoPath: '/r', title: 'original', startNow: false })
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
    // upsertIssue assigned revision 2 inside the span; the throw rolled the row
    // back, so the token must have gone with it — a burned revision would leave
    // the authority claiming a write that never landed, and the next real write
    // would skip a number the client can never account for.
    expect(store.issues.getIssue(wire.id)?.revision).toBe(1)
    expect(svc.update(wire.id, { title: 'next' }).revision).toBe(2)
  })

  // ---- The dedup interaction (the one that could quietly break either half) ----

  it('does NOT burn on a write-less reconcile — the dedup keeps working', () => {
    // The byte-equality baseline exists to stop no-op churn, and a revision that
    // moved on every republish would defeat it AND lie about writes that never
    // happened. Reconcile is the write-less path (full-list rebroadcast on
    // session churn / staleness flips); it never reaches upsertIssue, so
    // nothing moves and nothing is appended.
    const { svc, ledger, appended } = harness()
    const wire = svc.create({ repoPath: '/r', title: 'A', startNow: false })
    const before = revisionOf(svc, wire.id)
    appended.length = 0
    const cursorBefore = ledger.cursor()

    // Two republishes of unchanged truth.
    ledger.reconcile('issue', [{ id: wire.id, value: svc.get(wire.id) }])
    ledger.reconcile('issue', [{ id: wire.id, value: svc.get(wire.id) }])

    expect(appended.flat()).toEqual([]) // fully deduped
    expect(ledger.cursor()).toBe(cursorBefore) // nothing appended
    expect(revisionOf(svc, wire.id)).toBe(before) // and no revision burned
  })

  it('a DERIVED ripple republishes under an UNCHANGED revision', () => {
    // An issue's wire row carries derived data (ready/blocked, child counts,
    // sessions). Closing A flips B's `ready` with no write touching B — so B's
    // wire value must change while B's revision must NOT: a client holding an
    // in-flight expectedRevision for B has not been made stale by someone else's
    // edit, and bumping here would reject its write for no reason.
    const { svc, appended } = harness()
    const a = svc.create({ repoPath: '/r', title: 'A', startNow: false })
    const b = svc.create({ repoPath: '/r', title: 'B', startNow: false })
    svc.addDep(b.id, a.id, 'blocks')
    const bRevision = revisionOf(svc, b.id)
    expect(svc.get(b.id)?.blocked).toBe(true)
    appended.length = 0

    svc.close(a.id)

    const ripple = appended
      .flat()
      .filter((c) => c.id === b.id && c.op === 'upsert')
      .pop() as { value?: { ready?: boolean; revision?: number } } | undefined
    expect(ripple?.value?.ready).toBe(true) // the ripple really was published
    expect(ripple?.value?.revision).toBe(bRevision) // under B's unchanged token
    expect(revisionOf(svc, b.id)).toBe(bRevision)
  })

  it('a repeated write is still an accepted write, and is never deduped away', () => {
    // Writing the same title twice is a WRITE (the authority accepted it), so it
    // takes a revision and appends. This is the deliberate reading of "no-op":
    // a no-op is the write-less reconcile above, not an accepted command whose
    // payload happens to match. The alternative — suppressing it — would leave
    // the client's revision behind the authority's with no change row to catch
    // it up, which is the divergence D3 exists to prevent.
    const { svc, ledger } = harness()
    const wire = svc.create({ repoPath: '/r', title: 'A', startNow: false })
    const cursorBefore = ledger.cursor()
    const again = svc.update(wire.id, { title: 'A' })
    expect(again.revision).toBe(2)
    expect(ledger.cursor()).toBeGreaterThan(cursorBefore)
  })
})
