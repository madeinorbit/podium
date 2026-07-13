import { describe, expect, it, vi } from 'vitest'
import { SessionRegistry } from './relay'
import { SessionStore } from './store'

function registryWithDaemon(store = new SessionStore(':memory:')) {
  const messages: unknown[] = []
  const registry = new SessionRegistry(store)
  registry.modules.sessions.attachDaemon('local', (message) => messages.push(message))
  return { registry, store, messages }
}

describe('issue/session deletion lifecycle', () => {
  it('tombstones and restores the issue with all member session records', () => {
    const { registry, store, messages } = registryWithDaemon()
    const issue = registry.issues.create({
      repoPath: '/repo',
      title: 'Recoverable',
      startNow: false,
    })
    registry.issues.update(issue.id, { worktreePath: '/repo/worktree' })
    const attached = registry.modules.sessions.createSession({
      agentKind: 'claude-code',
      cwd: '/repo',
      issueId: issue.id,
    }).sessionId
    const inWorktree = registry.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/repo/worktree',
    }).sessionId
    const unrelated = registry.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/repo',
    }).sessionId

    const result = registry.modules.issueSessionLifecycle.deleteIssue(issue.id)

    expect(new Set(result.deletedSessionIds)).toEqual(new Set([attached, inWorktree]))
    expect(result.issue.deletedAt).toBeTruthy()
    expect(result.issue.sessions).toEqual([])
    expect(registry.issues.get(issue.id)?.deletedAt).toBeTruthy()
    expect(store.issues.getIssue(issue.id)?.deletedAt).toBeTruthy()
    expect(registry.modules.sessions.listSessions().map((s) => s.sessionId)).toEqual([unrelated])
    expect(store.sessions.loadSessions().map((s) => s.id)).toEqual([unrelated])
    const tombstones = store.sessions.loadDeletedSessionsForIssue(issue.id)
    expect(new Set(tombstones.map((s) => s.id))).toEqual(new Set([attached, inWorktree]))
    expect(tombstones.every((s) => !!s.deletedAt)).toBe(true)
    expect(tombstones.every((s) => s.deletionSource === 'issue')).toBe(true)
    expect(tombstones.every((s) => s.deletedByIssueId === issue.id)).toBe(true)
    const killed = messages
      .filter(
        (message): message is { type: string; sessionId: string } =>
          !!message && typeof message === 'object' && 'type' in message && 'sessionId' in message,
      )
      .filter((message) => message.type === 'kill')
      .map((message) => message.sessionId)
    expect(new Set(killed)).toEqual(new Set([attached, inWorktree]))

    const restored = registry.modules.issueSessionLifecycle.restoreIssue(issue.id)
    expect(restored.issue.deletedAt).toBeUndefined()
    expect(new Set(restored.restoredSessionIds)).toEqual(new Set([attached, inWorktree]))
    expect(store.issues.getIssue(issue.id)?.deletedAt).toBeNull()
    expect(store.sessions.loadDeletedSessionsForIssue(issue.id)).toEqual([])
    expect(new Set(store.sessions.loadSessions().map((s) => s.id))).toEqual(
      new Set([attached, inWorktree, unrelated]),
    )
    const restoredMetas = registry.modules.sessions
      .listSessions()
      .filter((s) => restored.restoredSessionIds.includes(s.sessionId))
    expect(restoredMetas.map((s) => s.status)).toEqual(['exited', 'exited'])
    registry.dispose()
  })

  it('rolls back both aggregates and leaves runtime sessions alive when the ledger append fails', () => {
    const { registry, store, messages } = registryWithDaemon()
    const issue = registry.issues.create({ repoPath: '/repo', title: 'Atomic', startNow: false })
    const sessionId = registry.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/repo',
      issueId: issue.id,
    }).sessionId
    const spy = vi.spyOn(store.sync, 'appendChanges').mockImplementationOnce(() => {
      throw new Error('append failed')
    })

    expect(() => registry.modules.issueSessionLifecycle.deleteIssue(issue.id)).toThrow(
      'append failed',
    )
    spy.mockRestore()

    expect(registry.issues.get(issue.id)?.deletedAt).toBeUndefined()
    expect(store.issues.getIssue(issue.id)?.deletedAt).toBeNull()
    expect(registry.modules.sessions.listSessions().some((s) => s.sessionId === sessionId)).toBe(
      true,
    )
    expect(store.sessions.loadSessions().some((s) => s.id === sessionId)).toBe(true)
    expect(store.sessions.loadDeletedSessionsForIssue(issue.id)).toEqual([])
    expect(messages).not.toContainEqual({ type: 'kill', sessionId })
    registry.dispose()
  })

  it('rolls back both tombstone restores when the ledger append fails', () => {
    const { registry, store } = registryWithDaemon()
    const issue = registry.issues.create({
      repoPath: '/repo',
      title: 'Restore atomicity',
      startNow: false,
    })
    const sessionId = registry.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/repo',
      issueId: issue.id,
    }).sessionId
    registry.modules.issueSessionLifecycle.deleteIssue(issue.id)
    const spy = vi.spyOn(store.sync, 'appendChanges').mockImplementationOnce(() => {
      throw new Error('restore append failed')
    })

    expect(() => registry.modules.issueSessionLifecycle.restoreIssue(issue.id)).toThrow(
      'restore append failed',
    )
    spy.mockRestore()

    expect(registry.issues.get(issue.id)?.deletedAt).toBeTruthy()
    expect(store.issues.getIssue(issue.id)?.deletedAt).toBeTruthy()
    expect(registry.modules.sessions.listSessions().some((s) => s.sessionId === sessionId)).toBe(
      false,
    )
    expect(store.sessions.loadSessions().some((s) => s.id === sessionId)).toBe(false)
    expect(store.sessions.loadDeletedSessionsForIssue(issue.id).map((s) => s.id)).toEqual([
      sessionId,
    ])
    registry.dispose()
  })
})
