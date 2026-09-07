import type { SessionId } from '@podium/model'
import { describe, expect, it, vi } from 'vitest'
import { SessionRegistry } from './relay'
import { openTestStore } from './test-support/open-test-store'

async function registryWithDaemon(store?: Awaited<ReturnType<typeof openTestStore>>) {
  const messages: unknown[] = []
  const resolvedStore = store ?? (await openTestStore(':memory:'))
  const registry = await SessionRegistry.create(resolvedStore, undefined, { instanceId: 'default' })
  registry.gateway.attachDaemon(registry.sessionStore.hostMachineId, (message) => messages.push(message))
  return { registry, store: resolvedStore, messages }
}

describe('issue/session deletion lifecycle', () => {
  it('tombstones and restores the issue with all member session records', async () => {
    const { registry, store, messages } = await registryWithDaemon()
    const issue = await registry.issues.create({
      repoPath: '/repo',
      title: 'Recoverable',
      startNow: false,
    })
    await registry.issues.update(issue.id, { worktreePath: '/repo/worktree' })
    const attached = (await registry.modules.sessions.createSession({
      agentKind: 'claude-code',
      cwd: '/repo',
      issueId: issue.id,
    })).sessionId
    const inWorktree = (await registry.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/repo/worktree',
    })).sessionId
    const unrelated = (await registry.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/repo',
    })).sessionId
    const projectionEvents: Array<
      Parameters<Parameters<typeof registry.modules.sessions.onSessionProjection>[0]>[0]
    > = []
    const offProjection = registry.modules.sessions.onSessionProjection((event) =>
      projectionEvents.push(event),
    )

    const result = await registry.modules.issueSessionLifecycle.deleteIssue(issue.id)

    expect(new Set(result.deletedSessionIds)).toEqual(new Set([attached, inWorktree]))
    expect(result.issue.deletedAt).toBeTruthy()
    expect(result.issue).not.toHaveProperty('sessions')
    expect((await registry.issues.get(issue.id))?.deletedAt).toBeTruthy()
    expect((await store.issues.getIssue(issue.id))?.deletedAt).toBeTruthy()
    expect((await registry.modules.sessions.listSessions()).map((s) => s.sessionId)).toEqual([unrelated])
    expect((await store.sessions.loadSessions()).map((s) => s.id)).toEqual([unrelated])
    const tombstones = await store.sessions.loadDeletedSessionsForIssue(issue.id)
    expect(new Set(tombstones.map((s) => s.id))).toEqual(new Set([attached, inWorktree]))
    expect(tombstones.every((s) => !!s.deletedAt)).toBe(true)
    expect(tombstones.every((s) => s.deletionSource === 'issue')).toBe(true)
    expect(tombstones.every((s) => s.deletedByIssueId === issue.id)).toBe(true)
    const killed = messages
      .filter(
        (message): message is { type: string; sessionId: SessionId } =>
          !!message && typeof message === 'object' && 'type' in message && 'sessionId' in message,
      )
      .filter((message) => message.type === 'kill')
      .map((message) => message.sessionId)
    expect(new Set(killed)).toEqual(new Set([attached, inWorktree]))
    expect(projectionEvents).toHaveLength(1)
    expect(projectionEvents[0]?.changes.map((change) => change.op)).toEqual(['remove', 'remove'])
    expect(projectionEvents[0]?.ledgerCursor).toBeGreaterThanOrEqual(
      projectionEvents[0]?.changes.at(-1)?.seq ?? 0,
    )

    const restored = await registry.modules.issueSessionLifecycle.restoreIssue(issue.id)
    expect(restored.issue.deletedAt).toBeUndefined()
    expect(new Set(restored.restoredSessionIds)).toEqual(new Set([attached, inWorktree]))
    expect((await store.issues.getIssue(issue.id))?.deletedAt).toBeNull()
    expect(await store.sessions.loadDeletedSessionsForIssue(issue.id)).toEqual([])
    expect(new Set((await store.sessions.loadSessions()).map((s) => s.id))).toEqual(
      new Set([attached, inWorktree, unrelated]),
    )
    const restoredMetas = (await registry.modules.sessions
      .listSessions())
      .filter((s) => restored.restoredSessionIds.includes(s.sessionId))
    expect(restoredMetas.map((s) => s.status)).toEqual(['exited', 'exited'])
    expect(projectionEvents).toHaveLength(2)
    expect(projectionEvents[1]?.generation).toBeGreaterThan(projectionEvents[0]?.generation ?? 0)
    expect(projectionEvents[1]?.changes.map((change) => change.op)).toEqual(['upsert', 'upsert'])
    expect(projectionEvents[1]?.ledgerCursor).toBeGreaterThanOrEqual(
      projectionEvents[1]?.changes.at(-1)?.seq ?? 0,
    )
    offProjection()
    await registry.dispose()
  })

  it('prepares restore reads before publishing and applies synchronously', async () => {
    const { registry, store } = await registryWithDaemon()
    try {
      const issue = await registry.issues.create({ repoPath: '/repo', title: 'Prepared restore', startNow: false })
      const { sessionId } = await registry.modules.sessions.createSession({ agentKind: 'shell', cwd: '/repo', issueId: issue.id })
      await registry.modules.issueSessionLifecycle.deleteIssue(issue.id)
      const plan = await registry.modules.sessions.prepareIssueSessionRestore(issue.id)
      const times = vi.spyOn(store.sessions, 'loadDraftTimes').mockRejectedValue(new Error('read during apply'))
      const docs = vi.spyOn(store.sessions, 'loadDraftDocs').mockRejectedValue(new Error('read during apply'))
      expect((await registry.modules.sessions.listSessions()).some(s => s.sessionId === sessionId)).toBe(false)
      expect(plan.apply([], 1)).toBeUndefined()
      expect(times).not.toHaveBeenCalled()
      expect(docs).not.toHaveBeenCalled()
      expect((await registry.modules.sessions.listSessions()).some(s => s.sessionId === sessionId)).toBe(true)
      times.mockRestore()
      docs.mockRestore()
    } finally {
      registry.dispose()
    }
  })

  it.each(['tombstone', 'queue'] as const)(
    'rolls back deletion when the asynchronous %s write rejects',
    async (failure) => {
      const { registry, store } = await registryWithDaemon()
      try {
        const issue = await registry.issues.create({ repoPath: '/repo', title: 'Failed deletion', startNow: false })
        const { sessionId } = await registry.modules.sessions.createSession({ agentKind: 'shell', cwd: '/repo', issueId: issue.id })
        const reject = async () => {
          await new Promise(resolve => setTimeout(resolve, 0))
          throw new Error('session write failed')
        }
        const write = failure === 'tombstone'
          ? vi.spyOn(store.sessions, 'softDeleteForIssue').mockImplementationOnce(reject)
          : vi.spyOn(store.sync, 'deleteQueuedMessagesForSession').mockImplementationOnce(reject)
        await expect(registry.modules.issueSessionLifecycle.deleteIssue(issue.id)).rejects.toThrow('session write failed')
        expect(write).toHaveBeenCalledOnce()
        expect((await store.issues.getIssue(issue.id))?.deletedAt).toBeNull()
        expect(await store.sessions.loadDeletedSessionsForIssue(issue.id)).toEqual([])
        expect((await registry.modules.sessions.listSessions()).some(s => s.sessionId === sessionId)).toBe(true)
      } finally {
        await registry.dispose()
      }
    },
  )

  it('keeps both tombstones when the asynchronous session restore rejects', async () => {
    const { registry, store } = await registryWithDaemon()
    try {
      const issue = await registry.issues.create({ repoPath: '/repo', title: 'Failed restoration', startNow: false })
      const { sessionId } = await registry.modules.sessions.createSession({ agentKind: 'shell', cwd: '/repo', issueId: issue.id })
      await registry.modules.issueSessionLifecycle.deleteIssue(issue.id)
      vi.spyOn(store.sessions, 'restoreDeletedForIssue').mockImplementationOnce(async () => {
        await new Promise(resolve => setTimeout(resolve, 0))
        throw new Error('session restore failed')
      })
      await expect(registry.modules.issueSessionLifecycle.restoreIssue(issue.id)).rejects.toThrow('session restore failed')
      expect((await store.issues.getIssue(issue.id))?.deletedAt).toBeTruthy()
      expect((await store.sessions.loadDeletedSessionsForIssue(issue.id)).map(s => s.id)).toEqual([sessionId])
      expect((await registry.modules.sessions.listSessions()).some(s => s.sessionId === sessionId)).toBe(false)
    } finally {
      await registry.dispose()
    }
  })

  it('rolls back both aggregates and leaves runtime sessions alive when the ledger append fails', async () => {
    const { registry, store, messages } = await registryWithDaemon()
    const issue = await registry.issues.create({ repoPath: '/repo', title: 'Atomic', startNow: false })
    const sessionId = (await registry.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/repo',
      issueId: issue.id,
    })).sessionId
    const spy = vi.spyOn(store.sync, 'appendChanges').mockImplementationOnce(() => {
      throw new Error('append failed')
    })

    await expect(registry.modules.issueSessionLifecycle.deleteIssue(issue.id)).rejects.toThrow(
      'append failed',
    )
    spy.mockRestore()

    expect((await registry.issues.get(issue.id))?.deletedAt).toBeUndefined()
    expect((await store.issues.getIssue(issue.id))?.deletedAt).toBeNull()
    expect((await registry.modules.sessions.listSessions()).some((s) => s.sessionId === sessionId)).toBe(
      true,
    )
    expect((await store.sessions.loadSessions()).some((s) => s.id === sessionId)).toBe(true)
    expect(await store.sessions.loadDeletedSessionsForIssue(issue.id)).toEqual([])
    expect(messages).not.toContainEqual({ type: 'kill', sessionId })
    await registry.dispose()
  })

  it('rolls back both tombstone restores when the ledger append fails', async () => {
    const { registry, store } = await registryWithDaemon()
    const issue = await registry.issues.create({
      repoPath: '/repo',
      title: 'Restore atomicity',
      startNow: false,
    })
    const sessionId = (await registry.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/repo',
      issueId: issue.id,
    })).sessionId
    await registry.modules.issueSessionLifecycle.deleteIssue(issue.id)
    // Deletion may still publish its issue projection. Fail the restore's
    // session upsert specifically, rather than whichever append arrives next.
    const appendChanges = store.sync.appendChanges.bind(store.sync)
    const spy = vi.spyOn(store.sync, 'appendChanges').mockImplementation(async (rows, eventTime) => {
      if (rows.some(row => row.entity === 'session' && row.entityId === sessionId && row.op === 'upsert')) {
        throw new Error('restore append failed')
      }
      return appendChanges(rows, eventTime)
    })

    await expect(registry.modules.issueSessionLifecycle.restoreIssue(issue.id)).rejects.toThrow(
      'restore append failed',
    )
    spy.mockRestore()

    expect((await registry.issues.get(issue.id))?.deletedAt).toBeTruthy()
    expect((await store.issues.getIssue(issue.id))?.deletedAt).toBeTruthy()
    expect((await registry.modules.sessions.listSessions()).some((s) => s.sessionId === sessionId)).toBe(
      false,
    )
    expect((await store.sessions.loadSessions()).some((s) => s.id === sessionId)).toBe(false)
    expect((await store.sessions.loadDeletedSessionsForIssue(issue.id)).map((s) => s.id)).toEqual([
      sessionId,
    ])
    await registry.dispose()
  })

  it('rolls back a failed restore after its append writes inside an enclosing span', async () => {
    const { registry, store } = await registryWithDaemon()
    let spy: ReturnType<typeof vi.spyOn> | undefined
    try {
      const issue = await registry.issues.create({ repoPath: '/repo', title: 'Nested restore', startNow: false })
      const { sessionId } = await registry.modules.sessions.createSession({
        agentKind: 'shell', cwd: '/repo', issueId: issue.id,
      })
      await registry.modules.issueSessionLifecycle.deleteIssue(issue.id)
      const before = await store.sync.maxChangeSeq()
      const appendChanges = store.sync.appendChanges.bind(store.sync)
      const failure = new Error('restore failed after append')
      let injected = 0
      spy = vi.spyOn(store.sync, 'appendChanges').mockImplementation(async (rows, eventTime) => {
        const result = await appendChanges(rows, eventTime)
        if (rows.some(row => row.entity === 'session' && row.entityId === sessionId && row.op === 'upsert')) {
          // Prove the failing path performed real writes before rejecting.
          expect((await store.issues.getIssue(issue.id))?.deletedAt).toBeNull()
          expect((await store.sessions.loadSessions()).some(row => row.id === sessionId)).toBe(true)
          expect(await store.sync.maxChangeSeq()).toBeGreaterThan(before)
          injected++
          throw failure
        }
        return result
      })

      await store.transact(async () => {
        // Catch inside the enclosing span: its successful commit must not save
        // any writes or commit callbacks left behind by the failed restore.
        await expect(registry.modules.issueSessionLifecycle.restoreIssue(issue.id)).rejects.toBe(failure)
        expect(injected).toBe(1)
        expect((await store.issues.getIssue(issue.id))?.deletedAt).toBeTruthy()
        expect((await store.sessions.loadDeletedSessionsForIssue(issue.id)).map(row => row.id)).toEqual([sessionId])
      })
      spy.mockRestore()

      expect((await registry.issues.get(issue.id))?.deletedAt).toBeTruthy()
      expect((await store.issues.getIssue(issue.id))?.deletedAt).toBeTruthy()
      expect((await store.sessions.loadDeletedSessionsForIssue(issue.id)).map(row => row.id)).toEqual([sessionId])
      expect((await store.sessions.loadSessions()).some(row => row.id === sessionId)).toBe(false)
      expect((await registry.modules.sessions.listSessions()).some(row => row.sessionId === sessionId)).toBe(false)
      // The delete may publish a tombstoned issueProjection after the baseline.
      // Reject restored state, rather than treating that valid publication as a leak.
      const remaining = await store.sync.changesSince(before)
      expect(remaining.filter(row => row.entity === 'session' && row.entityId === sessionId)).toEqual([])
      for (const row of remaining.filter(row => row.entityId === issue.id)) {
        expect(row.payload).not.toBeNull()
        expect(JSON.parse(row.payload!).deletedAt).toBeTruthy()
      }
      expect(await store.events.listEventsSince(0, { kinds: ['issue.restored'], subject: issue.id })).toEqual([])
    } finally {
      spy?.mockRestore()
      await registry.dispose()
    }
  })

})
