import { asSessionId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { SessionRegistry } from './relay'

// Issue archive → session cascade (issue #133), through the REAL relay wiring
// (IssueService's setSessionArchived hook → SessionRegistry.setArchived). Archiving
// an issue must archive its member sessions so the sidebar doesn't keep a bare,
// session-less WORKTREE row where the issue used to be.

function regWithDaemon() {
  const reg = new SessionRegistry(undefined, undefined, { instanceId: 'default' })
  reg.gateway.attachDaemon(reg.sessionStore.hostMachineId, () => {})
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

  it('frees the checkout too, after parking the agents standing in it (POD-567)', async () => {
    // The ordering is the point, and only the real wiring can prove it: the
    // cascade parks each member session SYNCHRONOUSLY (setArchived → onArchived →
    // parkArchivedSession), so the free's "no live session in this path" gate sees
    // them already parked instead of refusing against the very agents this call
    // just stopped. A unit test whose setSessionArchived is a spy cannot show that.
    const reg = regWithDaemon()
    const repoOps: { op: string; args?: Record<string, string> }[] = []
    const rpc = (
      reg.modules.sessions as unknown as {
        rpc: {
          repoOp: (
            op: string,
            cwd: string,
            args?: Record<string, string>,
          ) => Promise<{ ok: boolean; output: string }>
        }
      }
    ).rpc
    rpc.repoOp = async (op, _cwd, args) => {
      repoOps.push({ op, ...(args ? { args } : {}) })
      return { ok: true, output: op === 'status' ? '## issue/real-work\n' : '' }
    }
    const issue = reg.issues.create({ repoPath: '/repo', title: 'Real work', startNow: false })
    reg.issues.update(issue.id, { worktreePath: '/repo/wt', branch: 'issue/real-work' })
    const s = reg.modules.sessions.createSession({
      agentKind: 'claude-code',
      cwd: '/repo/wt',
      issueId: issue.id,
    }).sessionId

    reg.issues.archive(issue.id)
    await new Promise((resolve) => setTimeout(resolve, 0)) // the free is fire-and-forget

    const parked = reg.modules.sessions.listSessions().find((x) => x.sessionId === s)
    expect(parked?.archived).toBe(true)
    expect(parked?.status === 'hibernated' || parked?.status === 'exited').toBe(true)
    expect(repoOps.find((o) => o.op === 'worktreeRemove')?.args).toEqual({ path: '/repo/wt' })
    expect(reg.issues.get(issue.id)?.worktreePath).toBeNull()
    // The branch is what makes this reversible — resume rebuilds the checkout from it.
    expect(reg.issues.get(issue.id)?.branch).toBe('issue/real-work')
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
