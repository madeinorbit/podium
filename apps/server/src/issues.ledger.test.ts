import type { MetadataChange, ServerMessage } from '@podium/protocol'
import { normalizeSettings } from '@podium/runtime'
import { Ledger } from '@podium/sync'
import { describe, expect, it } from 'vitest'
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
  const store = new SessionStore(':memory:')
  const ledger = new Ledger({
    repo: store.sync,
    now: () => 1_000,
    transact: (fn) => store.transact(fn),
  })
  const published: { snapshot: ServerMessage; changes: MetadataChange[] }[] = []
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
      publishComputed: (snapshot, changes) => published.push({ snapshot, changes }),
    },
    ledger,
    publishSpecs: plumbing.publishSpecs,
    now: () => '2026-07-01T00:00:00.000Z',
  }
  return { store, ledger, published, svc: new IssueService(deps) }
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
    const { ledger, svc, published } = harness()
    const wire = svc.create({ repoPath: '/r', title: 'A', startNow: false })
    const recorded = ledger.changesSince(0) ?? []
    expect(recorded.some((c) => c.id === wire.id && c.op === 'upsert')).toBe(true)
    // The committed changes are what fanned out (durable before fan-out).
    expect(published.some((p) => p.changes.some((c) => c.id === wire.id))).toBe(true)
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
    const { svc, published } = harness()
    const a = svc.create({ repoPath: '/r', title: 'A', startNow: false })
    const b = svc.create({ repoPath: '/r', title: 'B', startNow: false })
    svc.addDep(b.id, a.id, 'blocks') // B waits on A
    expect(svc.get(b.id)?.blocked).toBe(true)
    published.length = 0
    svc.close(a.id)
    // The full-list reconcile caught B's DERIVED flip — no write touched B's row.
    const rippled = published.flatMap((p) => p.changes)
    const bChange = rippled.find((c) => c.id === b.id && c.op === 'upsert') as
      | { value?: { ready?: boolean; blocked?: boolean } }
      | undefined
    expect(bChange?.value?.ready).toBe(true)
    expect(bChange?.value?.blocked).toBe(false)
  })

  it('delete emits the remove to delta clients and the log replays to the live state', () => {
    const { ledger, svc, published } = harness()
    const parent = svc.create({ repoPath: '/r', title: 'epic', startNow: false })
    const child = svc.create({ repoPath: '/r', title: 'kid', startNow: false, parentId: parent.id })
    published.length = 0
    svc.delete(parent.id)
    // The committed remove rides the fan-out (reconcile alone would dedup it away
    // and delta clients would keep the deleted issue until their next snapshot).
    const last = published[published.length - 1]
    expect(last?.changes.some((c) => c.id === parent.id && c.op === 'remove')).toBe(true)
    // Reparented child rippled in the same batch (its parentId cleared).
    const childChange = last?.changes.find((c) => c.id === child.id && c.op === 'upsert') as
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
    const published2: { snapshot: ServerMessage; changes: MetadataChange[] }[] = []
    const plumbing2 = issueTestPlumbing()
    const svc2 = new IssueService({
      store,
      listSessions: () => [],
      getSettings: () => normalizeSettings({ sessionDefaults: { agent: 'claude-code' } }),
      spawnSession: () => ({ sessionId: 's1' }),
      repoOp: async () => ({ ok: true, output: '' }),
      funnel: {
        run: plumbing2.funnel.run,
        publishComputed: (snapshot, changes) => published2.push({ snapshot, changes }),
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
