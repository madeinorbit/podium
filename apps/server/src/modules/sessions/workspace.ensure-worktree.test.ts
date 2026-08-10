import { describe, expect, it, vi } from 'vitest'
import type { SessionIssueWorkflowPort } from './issue-workflow-port'
import type { Session } from './session'
import { SessionWorkspace, type SessionWorkspacePorts } from './workspace'

type EnsureWorktreeResult = Awaited<ReturnType<SessionIssueWorkflowPort['ensureWorktree']>>

/**
 * POD-1704 — `ensureSessionWorktree` decides whether a session about to be
 * resurrected still has a directory to spawn into, and rebuilds it from the
 * preserved branch when it does not.
 *
 * The bug: the rebuild was gated on `session.stopReason`, so only a session that
 * had been DELIBERATELY stopped got its workspace back. One that crashed, or was
 * killed externally, fell through and returned its recorded cwd unchanged — a
 * path that is not there — and the spawn went into it. How a process died says
 * nothing about whether its directory exists.
 *
 * The second test is the load-bearing one for POD-197 and is why the fix is
 * scoped the way it is: the common wake path must stay SYNCHRONOUS, because
 * `queueText` fire-and-forgets the resurrect and needs the spawn on the wire
 * before it returns. Only the branch that was already async widened.
 */

const issueMeta = (over: {
  worktreePath?: string | null
  branch?: string | null
  machineId?: string
  repoPath?: string
}) => ({
  worktreePath: over.worktreePath ?? null,
  branch: over.branch ?? null,
  ...(over.machineId ? { machineId: over.machineId } : {}),
  ...(over.repoPath ? { repoPath: over.repoPath } : {}),
})

function harness(meta: ReturnType<typeof issueMeta>) {
  const ensureWorktree = vi.fn(
    async (_issueId: string): Promise<EnsureWorktreeResult> => ({
      ok: true,
      output: 'recreated',
      worktreePath: '/repo/.worktrees/issue-7',
      issue: {} as never,
    }),
  )
  const workspace = new SessionWorkspace({
    issueAccess: { getMeta: () => meta, issueForCwd: () => 'iss_7' },
  } as unknown as SessionWorkspacePorts)
  const issues = { ensureWorktree } as unknown as SessionIssueWorkflowPort
  return { workspace, issues, ensureWorktree }
}

const session = (over: Partial<Session>) =>
  ({
    issueId: 'iss_7',
    cwd: '/repo/.worktrees/issue-7',
    machineId: 'machine-b',
    ...over,
  }) as Session

describe('ensureSessionWorktree rebuilds regardless of how the process died', () => {
  // A crash leaves no stopReason. This is the case the old gate dropped.
  it('recreates for a session that exited without being stopped', async () => {
    const { workspace, issues, ensureWorktree } = harness(
      issueMeta({ worktreePath: null, branch: 'issue/7-thing' }),
    )
    const result = await workspace.ensureSessionWorktree(session({}), issues)

    expect(ensureWorktree).toHaveBeenCalledWith('iss_7')
    expect(result).toEqual({ ok: true, cwd: '/repo/.worktrees/issue-7' })
  })

  it('still recreates for a deliberately stopped session', async () => {
    const { workspace, issues, ensureWorktree } = harness(
      issueMeta({ worktreePath: null, branch: 'issue/7-thing' }),
    )
    await workspace.ensureSessionWorktree(session({ stopReason: 'self' }), issues)

    expect(ensureWorktree).toHaveBeenCalledOnce()
  })

  it('reports the rebuild failure rather than spawning into a dead path', async () => {
    const { workspace, issues, ensureWorktree } = harness(
      issueMeta({ worktreePath: null, branch: 'issue/7-thing' }),
    )
    ensureWorktree.mockResolvedValueOnce({
      ok: false,
      output: 'worktree recreate failed: branch is checked out elsewhere',
      worktreePath: null,
      issue: {} as never,
    })

    const result = await workspace.ensureSessionWorktree(session({}), issues)

    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/branch is checked out elsewhere/)
  })

  it('cannot rebuild without a branch, and says so by leaving the cwd alone', async () => {
    const { workspace, issues, ensureWorktree } = harness(
      issueMeta({ worktreePath: null, branch: null }),
    )
    const result = await workspace.ensureSessionWorktree(session({}), issues)

    expect(ensureWorktree).not.toHaveBeenCalled()
    expect(result).toEqual({ ok: true, cwd: '/repo/.worktrees/issue-7' })
  })

  /**
   * POD-197: `queueText` fire-and-forgets this call and relies on the spawn being
   * on the wire before it returns, so the common wake path must not become a
   * promise. Asserting the RETURN TYPE, not just the value — an `await` in the
   * test would hide exactly the regression this guards.
   */
  it('resolves synchronously when the worktree is already recorded', () => {
    const { workspace, issues, ensureWorktree } = harness(
      issueMeta({ worktreePath: '/repo/.worktrees/issue-7', branch: 'issue/7-thing' }),
    )
    const result = workspace.ensureSessionWorktree(session({}), issues)

    expect(result).not.toBeInstanceOf(Promise)
    expect(result).toEqual({ ok: true, cwd: '/repo/.worktrees/issue-7' })
    expect(ensureWorktree).not.toHaveBeenCalled()
  })

  it('reconciles a recorded worktree when the session moved to another machine', async () => {
    const { workspace, issues, ensureWorktree } = harness(
      issueMeta({
        worktreePath: '/repo-a/.worktrees/issue-7',
        branch: 'issue/7-thing',
        machineId: 'machine-a',
        repoPath: '/repo-a',
      }),
    )

    const result = await workspace.ensureSessionWorktree(session({}), issues)

    expect(result).toEqual({ ok: true, cwd: '/repo/.worktrees/issue-7' })
    expect(ensureWorktree).toHaveBeenCalledWith('iss_7', 'machine-b')
  })
})
