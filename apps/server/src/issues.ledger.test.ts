import { asSessionId, asUserId, firstAdminMemberId, issueUserStateRowId } from '@podium/model'
import type { MetadataChange, ServerMessage } from '@podium/protocol'
import { normalizeSettings } from '@podium/runtime'
import { Ledger } from '@podium/sync'
import { describe, expect, it, vi } from 'vitest'
import { type IssueDeps, IssueService } from './modules/issues/service'
import { issueTestPlumbing } from './modules/issues/service/test-plumbing'
import { applyAfterCommit, spanOpen } from './store/executor/executor'
import { openTestStore } from './test-support/open-test-store'
import { sessionReadPorts } from './test-support/session-facts'

/**
 * Issue writes on the write-seam Ledger ([spec:SP-3fe2] #255): the REAL Ledger
 * over the REAL SessionStore (store.sync + store.transact), so these tests pin
 * the production wiring — change rows commit atomically with the issue row
 * write, derived ripples reconcile, deletes emit replayable removes.
 */

async function harness() {
  // Mutable wall clock: the in-place-rollback tests advance it so a missing
  // updatedAt restore is a REAL wire difference the reconcile would append.
  let wallClock = '2026-07-01T00:00:00.000Z'
  const store = await openTestStore(':memory:')
  // Issues are placed on a machine that reported their repo (2b803efb5 refuses
  // implicit placement), so the fixture's repo is reported by the host machine.
  await store.repos.addRepo('/r', store.hostMachineId)
  const applyCommit = { spanOpen, onCommit: applyAfterCommit }
  const ledger = new Ledger({
    repo: store.sync,
    now: () => 1_000,
    transact: async (fn) => await store.transact(fn),
    applyCommit,
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
    ...sessionReadPorts(() => []),
    getSettings: async () =>
      normalizeSettings({
        gitWorkflow: {
          defaultParentBranch: '',
          mergeStyle: 'ff-only',
          autoRebaseBeforeMerge: true,
        },
        sessionDefaults: { agent: 'claude-code' },
      }),
    spawnSession: async () => ({ sessionId: asSessionId('s1') , machine: 'machine-under-test' }),
    repoOp: async () => ({ ok: true, output: '' }),
    funnel: {
      run: plumbing.funnel.run,
    },
    ledger,
    applyCommit,

    now: () => wallClock,
  }
  return {
    store,
    ledger,
    appended,
    svc: await IssueService.create(deps),
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
  it('publishes personal markers from their keyed storage and removes an empty row', async () => {
    const { svc, store, ledger } = await harness()
    try {
      const issue = await svc.create({ repoPath: '/r', title: 'Personal state', startNow: false })
      const user = await firstAdminMemberId(store)
      const key = issueUserStateRowId(user, issue.id)
      await svc.update(issue.id, { pinned: true })
      await svc.markIssueRead(issue.id)
      await svc.update(issue.id, { stage: 'done' })
      await svc.setIssueTucked(issue.id, true)
      const personal = ((await ledger.changesSince(0)) ?? []).filter(
        (c) => c.entity === 'issueUserState',
      )
      expect(personal.at(-1)).toMatchObject({
        id: key,
        op: 'upsert',
        value: {
          userId: user,
          entityId: issue.id,
          pinned: true,
          readAt: expect.any(String),
          tuckedAt: expect.any(String),
        },
      })
      expect(await svc.get(issue.id)).toMatchObject({
        pinned: true,
        readAt: expect.any(String),
        tuckedAt: expect.any(String),
      })
      await svc.setIssueTucked(issue.id, false)
      await svc.markIssueUnread(issue.id)
      await svc.update(issue.id, { pinned: false })
      expect(
        ((await ledger.changesSince(0)) ?? []).filter((c) => c.entity === 'issueUserState').at(-1),
      ).toMatchObject({ id: key, op: 'remove' })
      expect(await store.issues.getIssueUserState(user, issue.id)).toBeUndefined()
    } finally {
      await store.close()
    }
  })

  it('boot reconciles every user and removes stale git observations after restart', async () => {
    const { svc, store, ledger } = await harness()
    try {
      const issue = await svc.create({
        repoPath: '/r',
        title: 'Recoverable companions',
        startNow: false,
      })
      const other = asUserId('user:other')
      await store.issues.setIssueUserState(other, issue.id, {
        readAt: '2026-07-02',
        pinnedAt: '2026-07-02',
      })
      svc.gitStates.set(issue.id, {
        updatedAt: '2026-07-02',
        branch: 'feature',
        shared: false,
        ahead: 2,
        dirtyFiles: 0,
        merged: false,
      })
      await svc.broadcastIssue(await svc.rowOrThrow(issue.id))
      const cursor = await ledger.cursor()
      svc.gitStates.clear()
      await svc.boot()
      expect(
        ((await ledger.changesSince(cursor)) ?? []).find((c) => c.entity === 'issueGitState'),
      ).toMatchObject({ id: issue.id, op: 'remove' })
      const personal = ((await ledger.changesSince(0)) ?? []).filter(
        (c) => c.entity === 'issueUserState',
      )
      expect(personal).toContainEqual(
        expect.objectContaining({
          id: issueUserStateRowId(other, issue.id),
          value: expect.objectContaining({ userId: other, entityId: issue.id, pinned: true }),
        }),
      )
    } finally {
      await store.close()
    }
  })

  it('git publication appends only the changed observation', async () => {
    const { svc, store, ledger, appended } = await harness()
    try {
      const issue = await svc.create({ repoPath: '/r', title: 'Git observation', startNow: false })
      const other = await svc.create({ repoPath: '/r', title: 'Untouched', startNow: false })
      const cursor = await ledger.cursor()
      svc.gitStates.set(issue.id, {
        updatedAt: '2026-07-02',
        branch: 'feature',
        shared: false,
        ahead: 2,
        dirtyFiles: 0,
        merged: false,
      })
      appended.length = 0
      await svc.broadcastIssue(await svc.rowOrThrow(issue.id))
      const changes = (await ledger.changesSince(cursor)) ?? []
      expect(changes.find((c) => c.entity === 'issueGitState')).toMatchObject({
        id: issue.id,
        op: 'upsert',
        value: { id: issue.id, shared: false, ahead: 2, merged: false },
      })
      expect(appended).toHaveLength(1)
      expect(appended[0]?.map((c) => c.entity)).toEqual(['issueGitState'])
      expect(((await ledger.changesSince(cursor)) ?? []).some((c) => c.id === other.id)).toBe(false)
      const unchanged = await ledger.cursor()
      await svc.broadcastIssue(await svc.rowOrThrow(issue.id))
      expect(await ledger.cursor()).toBe(unchanged)
    } finally {
      await store.close()
    }
  })

  it('delete and restore declare normalized and companion truth before their publish tail', async () => {
    const { svc, store, ledger, appended } = await harness()
    try {
      const issue = await svc.create({
        repoPath: '/r',
        title: 'Lifecycle companions',
        startNow: false,
      })
      const user = await firstAdminMemberId(store)
      svc.gitStates.set(issue.id, {
        updatedAt: '2026-07-02',
        branch: 'feature',
        shared: false,
        ahead: 1,
        dirtyFiles: 0,
        merged: true,
      })
      await svc.broadcastIssue(await svc.rowOrThrow(issue.id))
      await store.issues.setIssueUserState(user, issue.id, { readAt: '2026-07-02' })
      const deleting = await svc.prepareSoftDelete(issue.id)
      appended.length = 0
      await ledger.commit({
        write: deleting.write,
        changes: deleting.changes,
        apply: deleting.apply,
      })
      expect(appended).toHaveLength(1)
      expect(appended[0]?.map((c) => c.entity)).toEqual(
        expect.arrayContaining(['issueProjection', 'issueGitState', 'issueUserState']),
      )
      const projection = appended[0]?.find((c) => c.entity === 'issueProjection')
      expect(projection).toMatchObject({
        value: {
          deletedAt: expect.any(String),
          revision: (await store.issues.getIssue(issue.id))?.revision,
        },
      })
      expect(appended[0]?.find((c) => c.entity === 'issueGitState')).toMatchObject({ op: 'remove' })
      await store.issues.setIssueUserState(user, issue.id, { pinnedAt: '2026-07-03' })
      const restoring = await svc.prepareRestore(issue.id)
      appended.length = 0
      await ledger.commit({
        write: restoring.write,
        changes: restoring.changes,
        apply: restoring.apply,
      })
      expect(appended).toHaveLength(1)
      expect(appended[0]?.map((c) => c.entity)).toEqual(
        expect.arrayContaining(['issueProjection', 'issueGitState', 'issueUserState']),
      )
      expect(appended[0]?.find((c) => c.entity === 'issueProjection')).toMatchObject({
        value: { revision: (await store.issues.getIssue(issue.id))?.revision },
      })
      expect(
        (
          appended[0]?.find((c) => c.entity === 'issueProjection') as {
            value: { deletedAt?: string }
          }
        ).value.deletedAt,
      ).toBeUndefined()
      expect(appended[0]?.find((c) => c.entity === 'issueGitState')).toMatchObject({
        op: 'upsert',
        value: { merged: true },
      })
    } finally {
      await store.close()
    }
  })

  it('rolls back a personal marker and its feed declaration together', async () => {
    const { svc, store, ledger } = await harness()
    try {
      const issue = await svc.create({ repoPath: '/r', title: 'Atomic marker', startNow: false })
      const before = await ledger.cursor()
      const append = vi
        .spyOn(store.sync, 'appendChanges')
        .mockRejectedValueOnce(new Error('marker append failed'))
      await expect(svc.writeIssueUserState(issue.id, { pinnedAt: '2026-07-02' })).rejects.toThrow(
        'marker append failed',
      )
      append.mockRestore()
      expect(
        await store.issues.getIssueUserState(await firstAdminMemberId(store), issue.id),
      ).toBeUndefined()
      expect(svc.issueOverlay(issue.id).pinned).toBe(false)
      expect(await ledger.cursor()).toBe(before)
    } finally {
      await store.close()
    }
  })
  it('rolls back staged markers and requested reports with an enclosing span', async () => {
    const { svc, store, ledger } = await harness()
    try {
      const issue = await svc.create({ repoPath: '/r', title: 'Staged marker', startNow: false })
      const before = await ledger.cursor()
      await expect(
        store.transact(async () => {
          await svc.writeIssueUserState(issue.id, { pinnedAt: '2026-07-02' })
          expect(svc.issueOverlay(issue.id).pinned).toBe(true)
          expect((await svc.list()).find((row) => row.id === issue.id)?.pinned).toBe(true)
          throw new Error('enclosing span failed')
        }),
      ).rejects.toThrow('enclosing span failed')
      expect(await store.issues.getIssueUserState(await firstAdminMemberId(store), issue.id)).toBeUndefined()
      expect(await ledger.cursor()).toBe(before)
      expect(svc.issueOverlay(issue.id).pinned).toBe(false)
      expect((await svc.list()).find((row) => row.id === issue.id)?.pinned).toBe(false)
      await svc.writeIssueUserState(issue.id, { pinnedAt: '2026-07-03' })
      expect((await svc.list()).find((row) => row.id === issue.id)?.pinned).toBe(true)
      expect(((await ledger.changesSince(before)) ?? []).find((row) => row.entity === 'issueUserState')).toMatchObject({
        value: { pinned: true },
      })
    } finally {
      await store.close()
    }
  })
  it('commits the upsert change row atomically with the issue row write', async () => {
    const { ledger, svc, appended } = await harness()
    const wire = await svc.create({ repoPath: '/r', title: 'A', startNow: false })
    const recorded = (await ledger.changesSince(0)) ?? []
    expect(recorded.some((c) => c.id === wire.id && c.op === 'upsert')).toBe(true)
    // The committed change entered the delta pipe (durable before fan-out), and
    // it carries the VALUE a client is served — which the deleted snapshot used
    // to carry separately.
    const row = appended.flat().find((c) => c.id === wire.id && c.op === 'upsert')
    expect(row).toBeDefined()
    expect((row as { value?: { title?: string } }).value?.title).toBe('A')
  })

  it('a throw between the row write and the change append rolls BOTH back', async () => {
    const { store, ledger, svc } = await harness()
    const wire = await svc.create({ repoPath: '/r', title: 'original', startNow: false })
    const cursorBefore = await ledger.cursor()
    const row = (await store.issues.listIssueRows()).find((r) => r.id === wire.id)
    if (!row) throw new Error('row missing')
    await expect(
      ledger.commit({
        write: async () => await store.issues.upsertIssue({ ...row, title: 'mutated' }),
        changes: () => {
          throw new Error('declaration failed')
        },
      }),
    ).rejects.toThrow('declaration failed')
    // The entity write inside the same transact span rolled back with the append.
    expect((await store.issues.listIssueRows()).find((r) => r.id === wire.id)?.title).toBe('original')
    expect(await ledger.cursor()).toBe(cursorBefore)
    // The baseline is untouched: re-declaring the ORIGINAL wire truth is a no-op.
    const redo = await ledger.commit({
      write: async () => {},
      changes: () => [{ entity: 'issueProjection', id: wire.id, op: 'upsert', value: wire }],
    })
    expect(redo.changes).toEqual([])
  })

  it('closing an issue makes the requested dependent report ready without republishing it', async () => {
    const { svc, appended } = await harness()
    const a = await svc.create({ repoPath: '/r', title: 'A', startNow: false })
    const b = await svc.create({ repoPath: '/r', title: 'B', startNow: false })
    await svc.addDep(b.id, a.id, 'blocks') // B waits on A
    expect((await svc.get(b.id))?.blocked).toBe(true)
    appended.length = 0
    await svc.close(a.id)
    expect(appended.flat().some((change) => change.entity === 'issueProjection' && change.id === b.id)).toBe(false)
    expect(appended.flat()).toContainEqual(expect.objectContaining({ entity: 'issueProjection', id: a.id, op: 'upsert' }))
    expect(await svc.get(b.id)).toMatchObject({ ready: true, blocked: false })
  })

  it('internal draft purge emits the remove and the log replays to live state', async () => {
    const { ledger, svc, appended } = await harness()
    const parent = await svc.create({ repoPath: '/r', title: 'epic', startNow: false })
    const child = await svc.create({ repoPath: '/r', title: 'kid', startNow: false, parentId: parent.id })
    appended.length = 0
    await svc.purgeEmptyDraft(parent.id)
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
    const folded = fold(await ledger.changesSince(0) ?? [])
    expect([...folded.keys()].sort()).toEqual(
      (await svc
        .list())
        .map((i) => i.id)
        .sort(),
    )
    expect(folded.has(parent.id)).toBe(false)
  })

  it('a failed change append on create leaves NO phantom row in memory (map installs post-commit, #247)', async () => {
    const { store, ledger, svc } = await harness()
    await svc.create({ repoPath: '/r', title: 'pre-existing', startNow: false })
    const cursorBefore = await ledger.cursor()
    const spy = vi.spyOn(store.sync, 'appendChanges').mockImplementationOnce(() => {
      throw new Error('append failed')
    })
    await expect(svc.create({ repoPath: '/r', title: 'phantom', startNow: false })).rejects.toThrow(
      'append failed',
    )
    spy.mockRestore()
    // Memory truth unchanged: the rows map never installed the rolled-back row…
    expect((await svc.list()).map((w) => w.title)).toEqual(['pre-existing'])
    // …the store rolled it back with the append, and nothing was logged.
    expect((await store.issues.listIssueRows()).map((r) => r.title)).toEqual(['pre-existing'])
    expect(await ledger.cursor()).toBe(cursorBefore)
    // A subsequent full-list reconcile appends NOTHING — no fabricated upsert
    // for a row the store never accepted.
    const reconciled = await ledger.reconcile(
      'issueProjection',
      (await svc.allProjections()) ?? [],
    )
    expect(reconciled).toEqual([])
    expect(await ledger.cursor()).toBe(cursorBefore)
  })

  it('a failed change append on UPDATE rolls the in-place row mutation back (#247)', async () => {
    const { store, ledger, svc, setNow } = await harness()
    const wire = await svc.create({ repoPath: '/r', title: 'old title', startNow: false })
    const cursorBefore = await ledger.cursor()
    setNow('2026-07-01T00:01:00.000Z') // a later stamp must roll back too
    const spy = vi.spyOn(store.sync, 'appendChanges').mockImplementationOnce(() => {
      throw new Error('append failed')
    })
    // update() mutates the MAP-OWNED row object in place BEFORE the commit;
    // persistWith's backup seam must roll those fields back on the throw.
    await expect(svc.update(wire.id, { title: 'phantom' })).rejects.toThrow('append failed')
    spy.mockRestore()
    // Memory shows the OLD title (in-place rollback — same object reference)…
    expect((await svc.get(wire.id))?.title).toBe('old title')
    // …matching the store, whose write rolled back inside the transact span.
    expect((await store.issues.getIssue(wire.id))?.title).toBe('old title')
    expect(await ledger.cursor()).toBe(cursorBefore)
    // A follow-up full-list reconcile appends NOTHING — the phantom title is
    // gone from memory, so nothing fabricates a durable upsert for it.
    const reconciled = await ledger.reconcile(
      'issueProjection',
      (await svc.allProjections()) ?? [],
    )
    expect(reconciled).toEqual([])
    expect(await ledger.cursor()).toBe(cursorBefore)
    // A successful retry then works end to end.
    const retried = await svc.update(wire.id, { title: 'new title' })
    expect(retried.title).toBe('new title')
    expect((await svc.get(wire.id))?.title).toBe('new title')
    expect((await store.issues.getIssue(wire.id))?.title).toBe('new title')
    const healed = await ledger.changesSince(cursorBefore) ?? []
    expect(
      healed.some(
        (c) =>
          c.id === wire.id &&
          c.op === 'upsert' &&
          (c.value as { title?: string }).title === 'new title',
      ),
    ).toBe(true)
  })

  it('a failed extra-write commit (setLabels) restores updatedAt and leaves no phantom label (#247)', async () => {
    const { store, ledger, svc, setNow } = await harness()
    const wire = await svc.create({ repoPath: '/r', title: 'labelled', startNow: false })
    const updatedAtBefore = (await svc.get(wire.id))?.updatedAt
    const cursorBefore = await ledger.cursor()
    setNow('2026-07-01T00:01:00.000Z')
    const spy = vi.spyOn(store.sync, 'appendChanges').mockImplementationOnce(() => {
      throw new Error('append failed')
    })
    await expect(svc.setLabels(wire.id, ['urgent'])).rejects.toThrow('append failed')
    spy.mockRestore()
    // The label write rolled back with the row, and the in-place updatedAt
    // stamp was restored — a reconcile sees byte-identical wire truth.
    expect(await store.issues.getIssueLabels(wire.id)).toEqual([])
    expect((await svc.get(wire.id))?.updatedAt).toBe(updatedAtBefore)
    const reconciled = await ledger.reconcile(
      'issueProjection',
      (await svc.allProjections()) ?? [],
    )
    expect(reconciled).toEqual([])
    expect(await ledger.cursor()).toBe(cursorBefore)
  })

  it('a failed change append on purge keeps the row in memory and the store (#247)', async () => {
    const { store, ledger, svc } = await harness()
    const wire = await svc.create({ repoPath: '/r', title: 'survivor', startNow: false })
    const cursorBefore = await ledger.cursor()
    const spy = vi.spyOn(store.sync, 'appendChanges').mockImplementationOnce(() => {
      throw new Error('append failed')
    })
    await expect(svc.purgeEmptyDraft(wire.id)).rejects.toThrow('append failed')
    spy.mockRestore()
    // Memory truth intact (the re-hydrate runs only after a committed tx)…
    expect((await svc.get(wire.id))?.title).toBe('survivor')
    // …and the store delete rolled back inside the same transact span.
    expect((await store.issues.listIssueRows()).some((r) => r.id === wire.id)).toBe(true)
    expect(await ledger.cursor()).toBe(cursorBefore)
    // A subsequent reconcile of the (unchanged) truth appends nothing.
    const reconciled = await ledger.reconcile(
      'issueProjection',
      (await svc.allProjections()) ?? [],
    )
    expect(reconciled).toEqual([])
  })

  it('boot reconcile records rows changed while the server was down, without fan-out', async () => {
    const { store, svc } = await harness()
    const wire = await svc.create({ repoPath: '/r', title: 'before', startNow: false })
    // Simulate an offline mutation + restart: new ledger/service over the same store.
    const row = (await store.issues.listIssueRows()).find((r) => r.id === wire.id)
    if (!row) throw new Error('row missing')
    await store.issues.upsertIssue({ ...row, title: 'changed offline' })
    const ledger2 = new Ledger({
      repo: store.sync,
      now: () => 2_000,
      transact: async (fn) => await store.transact(fn),
    })
    const plumbing2 = issueTestPlumbing()
    const svc2 = await IssueService.create({
      store,
      ...sessionReadPorts(() => []),
      getSettings: async () => normalizeSettings({ sessionDefaults: { agent: 'claude-code' } }),
      spawnSession: async () => ({ sessionId: asSessionId('s1') , machine: 'machine-under-test' }),
      repoOp: async () => ({ ok: true, output: '' }),
      funnel: {
        run: plumbing2.funnel.run,
      },
      ledger: ledger2,

      now: () => '2026-07-02T00:00:00.000Z',
    })
    const cursorBefore = await ledger2.cursor()
    await svc2.boot()
    // WAS: `published2` was empty — "boot reconcile never fans out". There is no
    // snapshot list to be empty any more, so the claim is made where it is now
    // decidable: the reconcile appends its rows and a client learns of them the
    // same way it learns of everything else.
    const healed = await ledger2.changesSince(cursorBefore) ?? []
    const change = healed.find(
      (c) => c.id === wire.id && c.op === 'upsert' && c.entity === 'issueProjection',
    ) as { value?: { title?: string } } | undefined
    expect(change?.value?.title).toBe('changed offline')

    expect(healed.some(row => String(row.entity) === 'issue')).toBe(false)
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
  const revisionOf = async (svc: Awaited<ReturnType<typeof harness>>['svc'], id: string): Promise<number | undefined> =>
    (await svc.get(id))?.revision

  it('starts at 1 on create and increments on EVERY accepted write', async () => {
    const { svc } = await harness()
    const wire = await svc.create({ repoPath: '/r', title: 'A', startNow: false })
    expect(wire.revision).toBe(1)
    expect((await svc.update(wire.id, { title: 'B' })).revision).toBe(2)
    expect((await svc.update(wire.id, { title: 'C' })).revision).toBe(3)
    expect((await svc.update(wire.id, { priority: 1 })).revision).toBe(4)
    expect(await revisionOf(svc, wire.id)).toBe(4)
  })

  it('is per-entity, not a feed position — two issues advance independently', async () => {
    // The category error D3 exists to prevent: `seq` is global across entities,
    // so two clients editing different issues have wildly different seqs with no
    // bearing on either issue's staleness. Revision is the per-entity answer.
    const { svc, ledger } = await harness()
    const a = await svc.create({ repoPath: '/r', title: 'A', startNow: false })
    const b = await svc.create({ repoPath: '/r', title: 'B', startNow: false })
    await svc.update(a.id, { title: 'A2' })
    await svc.update(a.id, { title: 'A3' })
    expect(await revisionOf(svc, a.id)).toBe(3)
    expect(await revisionOf(svc, b.id)).toBe(1) // untouched by A's writes
    expect(await ledger.cursor()).toBeGreaterThan(3) // the feed seq is a different number
  })

  it('rides the change payload, so a replica folding the feed sees the same token as the wire', async () => {
    const { svc, appended } = await harness()
    const wire = await svc.create({ repoPath: '/r', title: 'A', startNow: false })
    appended.length = 0
    const updated = await svc.update(wire.id, { title: 'B' })
    const change = appended.flat().find((c) => c.id === wire.id && c.op === 'upsert') as {
      value?: { revision?: number }
    }
    expect(change?.value?.revision).toBe(updated.revision)
    expect(change?.value?.revision).toBe(2)
  })

  it('survives a reboot: it lives in the row, not in memory', async () => {
    const { store, svc } = await harness()
    const wire = await svc.create({ repoPath: '/r', title: 'A', startNow: false })
    await svc.update(wire.id, { title: 'B' })
    expect((await store.issues.getIssue(wire.id))?.revision).toBe(2)
    // A fresh write against the persisted row continues the sequence rather than
    // restarting it — the value is read back from SQL at each write.
    await svc.update(wire.id, { title: 'C' })
    expect((await store.issues.getIssue(wire.id))?.revision).toBe(3)
  })

  it('rolls back with the transaction: a failed write burns no revision', async () => {
    const { store, ledger, svc } = await harness()
    const wire = await svc.create({ repoPath: '/r', title: 'original', startNow: false })
    const row = (await store.issues.listIssueRows()).find((r) => r.id === wire.id)
    if (!row) throw new Error('row missing')
    await expect(
      ledger.commit({
        write: async () => await store.issues.upsertIssue({ ...row, title: 'mutated' }),
        changes: () => {
          throw new Error('declaration failed')
        },
      }),
    ).rejects.toThrow('declaration failed')
    // upsertIssue assigned revision 2 inside the span; the throw rolled the row
    // back, so the token must have gone with it — a burned revision would leave
    // the authority claiming a write that never landed, and the next real write
    // would skip a number the client can never account for.
    expect((await store.issues.getIssue(wire.id))?.revision).toBe(1)
    expect((await svc.update(wire.id, { title: 'next' })).revision).toBe(2)
  })

  // ---- The dedup interaction (the one that could quietly break either half) ----

  it('does NOT burn on a write-less reconcile — the dedup keeps working', async () => {
    // The byte-equality baseline exists to stop no-op churn, and a revision that
    // moved on every republish would defeat it AND lie about writes that never
    // happened. Reconcile is the write-less path (full-list rebroadcast on
    // session churn / staleness flips); it never reaches upsertIssue, so
    // nothing moves and nothing is appended.
    const { svc, ledger, appended } = await harness()
    const wire = await svc.create({ repoPath: '/r', title: 'A', startNow: false })
    const before = await revisionOf(svc, wire.id)
    appended.length = 0
    const cursorBefore = await ledger.cursor()

    // Two republishes of unchanged truth.
    await ledger.reconcile('issueProjection', (await svc.allProjections()) ?? [])
    await ledger.reconcile('issueProjection', (await svc.allProjections()) ?? [])

    expect(appended.flat()).toEqual([]) // fully deduped
    expect(await ledger.cursor()).toBe(cursorBefore) // nothing appended
    expect(await revisionOf(svc, wire.id)).toBe(before) // and no revision burned
  })

  it('a derived report changes without republishing or revising a dependent', async () => {
    const { svc, appended } = await harness()
    const a = await svc.create({ repoPath: '/r', title: 'A', startNow: false })
    const b = await svc.create({ repoPath: '/r', title: 'B', startNow: false })
    await svc.addDep(b.id, a.id, 'blocks')
    const revision = await revisionOf(svc, b.id)
    expect((await svc.get(b.id))?.blocked).toBe(true)
    appended.length = 0
    await svc.close(a.id)
    expect(appended.flat().filter(c => c.id === b.id && c.entity === 'issueProjection')).toEqual([])
    expect(await svc.get(b.id)).toMatchObject({ ready: true, blocked: false, revision })
  })

  it('a repeated write is still an accepted write, and is never deduped away', async () => {
    // Writing the same title twice is a WRITE (the authority accepted it), so it
    // takes a revision and appends. This is the deliberate reading of "no-op":
    // a no-op is the write-less reconcile above, not an accepted command whose
    // payload happens to match. The alternative — suppressing it — would leave
    // the client's revision behind the authority's with no change row to catch
    // it up, which is the divergence D3 exists to prevent.
    const { svc, ledger } = await harness()
    const wire = await svc.create({ repoPath: '/r', title: 'A', startNow: false })
    const cursorBefore = await ledger.cursor()
    const again = await svc.update(wire.id, { title: 'A' })
    expect(again.revision).toBe(2)
    expect(await ledger.cursor()).toBeGreaterThan(cursorBefore)
  })
})
