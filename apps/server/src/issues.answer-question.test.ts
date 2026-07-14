import { normalizeSettings } from '@podium/runtime'
import { describe, expect, it, vi } from 'vitest'
import { OPERATOR } from './issue-authz'
import { type IssueCommandDeps, IssueCommandDispatcher } from './modules/issues/registry'
import { type IssueDeps, IssueService } from './modules/issues/service'
import { issueTestPlumbing } from './modules/issues/service/test-plumbing'
import { SessionStore } from './store'

/**
 * issues.answerQuestion end-to-end over the command dispatcher (issue #53):
 * deliver the answer to the asking session via the injected
 * answerSessionQuestion seam, then clear needsHuman — ONLY on successful
 * delivery. Failure paths must leave the pending question untouched.
 */

function harness(
  answerSessionQuestion?: IssueCommandDeps['answerSessionQuestion'],
  opts: { actorSessionId?: string } = {},
) {
  const store = new SessionStore(':memory:')
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
    spawnSession: vi.fn(() => ({ sessionId: 's1' })),
    repoOp: vi.fn(async () => ({ ok: true, output: '' })),
    ...issueTestPlumbing(),
    now: () => '2026-07-14T00:00:00.000Z',
  }
  const svc = new IssueService(deps)
  const dispatcher = new IssueCommandDispatcher({
    issues: () => svc,
    deleteIssue: () => undefined,
    restoreIssue: () => undefined,
    isUpstreamIssue: () => false,
    forwardIssueMutation: async () => undefined,
    upstreamIssueRepoPaths: () => new Set(),
    withMutation: (_mutationId, _proc, fn) => fn(),
    listSessions: () => [],
    repoPaths: () => ['/r'],
    inferRepoFromPath: () => undefined,
    ...(answerSessionQuestion ? { answerSessionQuestion } : {}),
  })
  const caller = {
    capability: {
      ...OPERATOR,
      ...(opts.actorSessionId ? { actorSessionId: opts.actorSessionId } : {}),
    },
  }
  const call = (proc: string, input: unknown) => {
    const p = dispatcher.dispatch(caller, 'issues', proc, input)
    if (!p) throw new Error(`no such proc ${proc}`)
    return p
  }
  return { svc, call }
}

describe('issues.answerQuestion (issue #53)', () => {
  it('delivers to the asking session, then clears needsHuman', async () => {
    const deliver = vi.fn(async () => ({ ok: true as const, via: 'text' as const }))
    const { svc, call } = harness(deliver)
    const a = svc.create({ repoPath: '/r', title: 'A', startNow: false })
    await call('setNeedsHuman', {
      id: a.id,
      question: 'merge?',
      options: ['Yes', 'No'],
      askedBy: 'sess_asker',
    })
    const r = (await call('answerQuestion', { id: a.id, answer: 'Yes' })) as {
      issue: { needsHuman: boolean; humanQuestion?: string; humanQuestionOptions?: string[] }
      deliveredVia: string
    }
    expect(deliver).toHaveBeenCalledWith('sess_asker', 'Yes')
    expect(r.deliveredVia).toBe('text')
    expect(r.issue.needsHuman).toBe(false)
    expect(r.issue.humanQuestion).toBeUndefined()
    expect(r.issue.humanQuestionOptions).toBeUndefined()
  })

  it('keeps the pending question when delivery fails', async () => {
    const deliver = vi.fn(async () => ({ ok: false as const, message: 'unknown session' }))
    const { svc, call } = harness(deliver)
    const a = svc.create({ repoPath: '/r', title: 'A', startNow: false })
    await call('setNeedsHuman', { id: a.id, question: 'merge?', askedBy: 'sess_gone' })
    await expect(call('answerQuestion', { id: a.id, answer: 'Yes' })).rejects.toThrow(
      /answer not delivered: unknown session/,
    )
    const after = svc.get(a.id)!
    expect(after.needsHuman).toBe(true)
    expect(after.humanQuestion).toBe('merge?')
  })

  it('refuses when no question is pending, and when the question is unattributed', async () => {
    const deliver = vi.fn(async () => ({ ok: true as const, via: 'text' as const }))
    const { svc, call } = harness(deliver)
    const a = svc.create({ repoPath: '/r', title: 'A', startNow: false })
    await expect(call('answerQuestion', { id: a.id, answer: 'Yes' })).rejects.toThrow(
      /no pending question/,
    )
    // Legacy flag with no asking session recorded: nothing to route to.
    await call('setNeedsHuman', { id: a.id, question: 'merge?' })
    await expect(call('answerQuestion', { id: a.id, answer: 'Yes' })).rejects.toThrow(
      /no asking session/,
    )
    expect(deliver).not.toHaveBeenCalled()
    expect(svc.get(a.id)!.needsHuman).toBe(true)
  })

  it('refuses cleanly when delivery is not wired (test/legacy deps)', async () => {
    const { svc, call } = harness(undefined)
    const a = svc.create({ repoPath: '/r', title: 'A', startNow: false })
    await call('setNeedsHuman', { id: a.id, question: 'merge?', askedBy: 'sess_asker' })
    await expect(call('answerQuestion', { id: a.id, answer: 'Yes' })).rejects.toThrow(/not wired/)
    expect(svc.get(a.id)!.needsHuman).toBe(true)
  })

  it('setNeedsHuman defaults askedBy to the calling session', async () => {
    const { svc, call } = harness(undefined, { actorSessionId: 'sess_self' })
    const a = svc.create({ repoPath: '/r', title: 'A', startNow: false })
    await call('setNeedsHuman', { id: a.id, question: 'merge?' })
    expect(svc.get(a.id)!.humanQuestionAskedBy).toBe('sess_self')
    // An explicit askedBy wins over the caller's own session.
    await call('setNeedsHuman', { id: a.id, question: 'merge?', askedBy: 'sess_other' })
    expect(svc.get(a.id)!.humanQuestionAskedBy).toBe('sess_other')
  })
})
