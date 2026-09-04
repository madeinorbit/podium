import { afterEach, describe, expect, it } from 'vitest'
import { SessionRegistry } from '../relay'
import { openTestStore } from '../test-support/open-test-store'

/**
 * THE LIVE RUNTIME TEARDOWN WAITS FOR THE OUTERMOST COMMIT [POD-3366, sites 6,
 * 7 and 8 of POD-3361's audit].
 *
 * `IssueSessionLifecycle.deleteIssue` / `restoreIssue` and
 * `SessionKillService.killSession` all did their runtime work on the statement
 * after a `ledger.commit`. The comment at the kill site already said the right
 * thing — "durable tombstone FIRST, live teardown after" — but it was written
 * against a top-level commit. Nested inside a caller's span that commit is a
 * SAVEPOINT, and its release is not a commit.
 *
 * WHY THIS ONE IS WORSE THAN A STALE PROJECTION. The teardown is IRREVERSIBLE:
 * `removeSessionRuntime` detaches the PTY and drops every client attachment.
 * There is no un-kill to compensate with, so a rolled-back enclosing span left
 * a session that the database still holds, dead in every way that matters.
 *
 * WHAT THESE TESTS ASSERT ON: the live session map, read after the rollback,
 * with nothing in between that reloads it. `state.loadFromStore()` would
 * repopulate from durable truth and hide the whole defect.
 */
describe('the lifecycle runtime tail waits for the outermost commit (POD-3366)', () => {
  const registries: SessionRegistry[] = []
  afterEach(() => {
    for (const registry of registries.splice(0)) registry.dispose()
  })

  async function build() {
    const store = await openTestStore(':memory:')
    const registry = SessionRegistry.create(store, undefined, { instanceId: 'default' })
    registries.push(registry)
    return { store, registry }
  }

  const liveSessionIds = (registry: SessionRegistry) =>
    registry.modules.sessions.listSessions().map((session) => session.sessionId)

  it('does not tear a session down for a kill the enclosing span rolled back (site 8)', async () => {
    const { store, registry } = await build()
    const { sessionId } = registry.modules.sessions.createSession({
      agentKind: 'claude-code',
      cwd: '/w',
    })
    expect(liveSessionIds(registry)).toContain(sessionId)

    expect(() =>
      store.transact(() => {
        registry.modules.sessions.killSession({ sessionId })
        throw new Error('enclosing span failed')
      }),
    ).toThrow('enclosing span failed')

    // The tombstone rolled back, so the session row is live again…
    expect(store.sessions.loadSessions().map((row) => row.id)).toContain(sessionId)
    // …and the runtime must never have been torn down. Read with nothing
    // reloaded in between: `state.loadFromStore()` here would hide the defect
    // by rebuilding the map from the database that just rolled back.
    expect(liveSessionIds(registry)).toContain(sessionId)
  })

  it('still tears the session down when the enclosing span commits (site 8)', async () => {
    const { store, registry } = await build()
    const { sessionId } = registry.modules.sessions.createSession({
      agentKind: 'claude-code',
      cwd: '/w',
    })

    await store.transact(() => {
      registry.modules.sessions.killSession({ sessionId })
    })

    expect(liveSessionIds(registry)).not.toContain(sessionId)
    expect(store.sessions.loadSessions().map((row) => row.id)).not.toContain(sessionId)
  })

  it('does not delete an issue in memory when the enclosing span rolls back (site 6)', async () => {
    const { store, registry } = await build()
    const issue = registry.issues.create({
      repoPath: '/repo',
      title: 'issue to delete',
      startNow: false,
    })

    expect(() =>
      store.transact(() => {
        registry.modules.issueSessionLifecycle.deleteIssue(issue.id)
        throw new Error('enclosing span failed')
      }),
    ).toThrow('enclosing span failed')

    expect(registry.issues.get(issue.id)?.deletedAt).toBeFalsy()
    expect(store.issues.listIssueRows().find((row) => row.id === issue.id)?.deletedAt).toBeFalsy()
  })

  it('does not kill the issue\'s sessions when the enclosing span rolls back (site 6)', async () => {
    // THE HALF THE ROW MAP DOES NOT COVER, and mutation M14 is how I found that
    // it needed its own test: with the apply arm forced inline, the two issue
    // assertions above still passed, because Group C's staged row layer already
    // protects the issue side. What the ARM protects here is the SESSION side —
    // `sessionPlan.apply` calls `removeSessionRuntime` for every session of the
    // issue, and that detaches the PTY and every client. It is the irreversible
    // half, and it was running for a delete the enclosing span could roll back.
    const { store, registry } = await build()
    const issue = registry.issues.create({
      repoPath: '/repo',
      title: 'issue with a session',
      startNow: false,
    })
    const { sessionId } = registry.modules.sessions.createSession({
      agentKind: 'claude-code',
      cwd: '/w',
      issueId: issue.id,
    })
    expect(liveSessionIds(registry)).toContain(sessionId)

    expect(() =>
      store.transact(() => {
        registry.modules.issueSessionLifecycle.deleteIssue(issue.id)
        throw new Error('enclosing span failed')
      }),
    ).toThrow('enclosing span failed')

    expect(store.sessions.loadSessions().map((row) => row.id)).toContain(sessionId)
    expect(liveSessionIds(registry)).toContain(sessionId)
  })

  it('still deletes when the enclosing span commits (site 6)', async () => {
    const { store, registry } = await build()
    const issue = registry.issues.create({
      repoPath: '/repo',
      title: 'issue to delete',
      startNow: false,
    })

    await store.transact(() => {
      registry.modules.issueSessionLifecycle.deleteIssue(issue.id)
    })

    expect(registry.issues.get(issue.id)?.deletedAt).toBeTruthy()
  })

  it('does not restore an issue in memory when the enclosing span rolls back (site 7)', async () => {
    const { store, registry } = await build()
    const issue = registry.issues.create({
      repoPath: '/repo',
      title: 'issue to restore',
      startNow: false,
    })
    registry.modules.issueSessionLifecycle.deleteIssue(issue.id)
    expect(registry.issues.get(issue.id)?.deletedAt).toBeTruthy()

    expect(() =>
      store.transact(() => {
        registry.modules.issueSessionLifecycle.restoreIssue(issue.id)
        throw new Error('enclosing span failed')
      }),
    ).toThrow('enclosing span failed')

    expect(registry.issues.get(issue.id)?.deletedAt).toBeTruthy()
    expect(store.issues.listIssueRows().find((row) => row.id === issue.id)?.deletedAt).toBeTruthy()
  })

  it('does not install runtime sessions for a restore the enclosing span rolled back (site 7)', async () => {
    // The restore's own half, in the opposite direction from the delete's: its
    // apply calls `state.loadFromStore()` and `installStoredSession`, so a
    // rolled-back restore left LIVE sessions in the map for rows the database
    // still holds tombstoned.
    const { store, registry } = await build()
    const issue = registry.issues.create({
      repoPath: '/repo',
      title: 'issue with a session',
      startNow: false,
    })
    const { sessionId } = registry.modules.sessions.createSession({
      agentKind: 'claude-code',
      cwd: '/w',
      issueId: issue.id,
    })
    registry.modules.issueSessionLifecycle.deleteIssue(issue.id)
    expect(liveSessionIds(registry)).not.toContain(sessionId)

    expect(() =>
      store.transact(() => {
        registry.modules.issueSessionLifecycle.restoreIssue(issue.id)
        throw new Error('enclosing span failed')
      }),
    ).toThrow('enclosing span failed')

    expect(store.sessions.loadSessions().map((row) => row.id)).not.toContain(sessionId)
    expect(liveSessionIds(registry)).not.toContain(sessionId)
  })
})
