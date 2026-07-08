import { describe, expect, it } from 'vitest'
import { SessionRegistry } from './relay'

// Issue archive → session cascade (issue #133), through the REAL relay wiring
// (IssueService's setSessionArchived hook → SessionRegistry.setArchived). Archiving
// an issue must archive its member sessions so the sidebar doesn't keep a bare,
// session-less WORKTREE row where the issue used to be.

function regWithDaemon() {
  const reg = new SessionRegistry()
  reg.modules.sessions.attachDaemon('local', () => {})
  return reg
}

describe('issue archive cascades to member sessions (real relay #133)', () => {
  it('archiving an issue archives every attached session', () => {
    const reg = regWithDaemon()
    const issue = reg.issues.create({ repoPath: '/repo', title: 'Real work', startNow: false })
    reg.issues.update(issue.id, { worktreePath: '/repo/wt' })
    const a = reg.modules.sessions.createSession({ agentKind: 'claude-code', cwd: '/repo/wt', issueId: issue.id })
      .sessionId
    const b = reg.modules.sessions.createSession({ agentKind: 'claude-code', cwd: '/repo/wt', issueId: issue.id })
      .sessionId
    expect(reg.modules.sessions.listSessions().filter((s) => s.archived)).toHaveLength(0)

    reg.issues.archive(issue.id)

    const archived = new Set(
      reg
        .modules.sessions.listSessions()
        .filter((s) => s.archived)
        .map((s) => s.sessionId),
    )
    expect(archived.has(a)).toBe(true)
    expect(archived.has(b)).toBe(true)
    // The issue itself is archived (and, being a real issue, not reaped).
    expect(reg.issues.get(issue.id)?.archived).toBe(true)
  })

  it('un-archiving the issue leaves the sessions archived (no cascade back)', () => {
    const reg = regWithDaemon()
    const issue = reg.issues.create({ repoPath: '/repo', title: 'Real work', startNow: false })
    const s = reg.modules.sessions.createSession({ agentKind: 'claude-code', cwd: '/repo', issueId: issue.id })
      .sessionId
    reg.issues.archive(issue.id)
    reg.issues.update(issue.id, { archived: false })
    expect(reg.modules.sessions.listSessions().find((x) => x.sessionId === s)?.archived).toBe(true)
  })
})
