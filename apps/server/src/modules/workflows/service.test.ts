import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SessionStore } from '../../store'
import { type WorkflowCaller, WorkflowService, workflowInputs } from './service'

const operator: WorkflowCaller = {
  actor: { kind: 'operator', id: null },
  protectedWrite: true,
}
const agent = (sessionId: string, issueId = 'issue-1'): WorkflowCaller => ({
  actor: { kind: 'session', id: sessionId },
  capability: {
    role: 'worker',
    scope: { kind: 'subtree', rootId: issueId },
    actorSessionId: sessionId,
  },
})

describe('WorkflowService', () => {
  let store: SessionStore
  let service: WorkflowService
  let notices: Array<{ sessionId: string; text: string }>
  const sessions = new Map([
    [
      's1',
      {
        sessionId: 's1',
        cwd: '/repo/wt',
        issueId: 'issue-1',
        agentKind: 'claude-code',
        machineId: 'm1',
      },
    ],
    [
      's2',
      { sessionId: 's2', cwd: '/repo/wt', issueId: 'issue-1', agentKind: 'codex', machineId: 'm1' },
    ],
  ])

  beforeEach(() => {
    store = new SessionStore(':memory:')
    notices = []
    service = new WorkflowService({
      store: store.workflows,
      now: () => '2026-07-13T12:00:00.000Z',
      session: (id) => sessions.get(id),
      issue: (id) =>
        id === 'issue-1'
          ? { id, repoId: 'repo-1', repoPath: '/repo', worktreePath: '/repo/wt' }
          : undefined,
      repoIdForPath: () => 'repo-1',
      notifyCoordinator: (sessionId, text) => notices.push({ sessionId, text }),
    })
  })

  afterEach(() => store.close())

  it('stores immutable revisions and resolves one exact binding by task → repo → global', () => {
    const global = service.create(
      { name: 'Global', description: '', scope: 'global', instructions: 'global rules', steps: [] },
      operator,
    )
    const repo = service.create(
      {
        name: 'Repo',
        description: '',
        scope: 'repository',
        scopeRef: 'repo-1',
        instructions: 'repo rules',
        steps: [],
      },
      operator,
    )
    const task = service.create(
      {
        name: 'Task',
        description: '',
        scope: 'task',
        scopeRef: 'issue-1',
        instructions: 'task rules',
        steps: [],
      },
      operator,
    )
    service.publish({ revisionId: global.revision.id }, operator)
    service.publish({ revisionId: repo.revision.id }, operator)
    service.assign({ targetKind: 'global', targetId: '', revisionId: global.revision.id }, operator)
    service.assign(
      { targetKind: 'repository', targetId: 'repo-1', revisionId: repo.revision.id },
      operator,
    )
    service.assign(
      { targetKind: 'issue', targetId: 'issue-1', revisionId: task.revision.id },
      operator,
    )

    expect(
      service.resolveRevision({ sessionId: 's1', cwd: '/repo/wt', issueId: 'issue-1' })?.id,
    ).toBe(task.revision.id)

    const revised = service.revise(
      { workflowId: task.workflow.id, instructions: 'new task rules', steps: [] },
      agent('s1'),
    )
    expect(revised.version).toBe(2)
    expect(store.workflows.getRevision(task.revision.id)?.instructions).toBe('task rules')
    // The binding points at an exact revision; editing never changes unstarted tasks silently.
    expect(
      service.resolveRevision({ sessionId: 's1', cwd: '/repo/wt', issueId: 'issue-1' })?.id,
    ).toBe(task.revision.id)
  })

  it('requires approval authority for agent global publication/default changes', () => {
    const created = service.create(
      { name: 'Candidate', description: '', scope: 'global', instructions: 'rules', steps: [] },
      agent('s1'),
    )
    expect(() => service.publish({ revisionId: created.revision.id }, agent('s1'))).toThrow(
      'approval required',
    )
    expect(() =>
      service.assign(
        { targetKind: 'global', targetId: '', revisionId: created.revision.id },
        agent('s1'),
      ),
    ).toThrow('approval required')
    expect(
      service.publish({ revisionId: created.revision.id }, operator).publishedAt,
    ).not.toBeNull()
  })
  it('filters task-scoped workflow reads and bindings at the agent boundary', () => {
    const own = service.create(
      {
        name: 'Own task',
        description: '',
        scope: 'task',
        scopeRef: 'issue-1',
        instructions: '',
        steps: [],
      },
      operator,
    )
    const other = service.create(
      {
        name: 'Other task',
        description: '',
        scope: 'task',
        scopeRef: 'issue-other',
        instructions: '',
        steps: [],
      },
      operator,
    )
    service.assign(
      { targetKind: 'issue', targetId: 'issue-1', revisionId: own.revision.id },
      operator,
    )
    service.assign(
      { targetKind: 'issue', targetId: 'issue-other', revisionId: other.revision.id },
      operator,
    )
    expect(service.list({}, agent('s1')).map((workflow) => workflow.id)).toContain(own.workflow.id)
    expect(service.list({}, agent('s1')).map((workflow) => workflow.id)).not.toContain(
      other.workflow.id,
    )
    expect(() => service.get({ id: other.workflow.id }, agent('s1'))).toThrow(
      'outside this session',
    )
    expect(service.bindings({}, agent('s1'))).toMatchObject([
      { targetKind: 'issue', targetId: 'issue-1' },
    ])
    expect(() =>
      service.assign(
        { targetKind: 'issue', targetId: 'issue-1', revisionId: other.revision.id },
        agent('s1'),
      ),
    ).toThrow('outside this session')
  })

  it('reports an unavailable execution profile in prime and checkpoint responses', () => {
    const created = service.create(
      {
        name: 'Missing profile',
        description: '',
        scope: 'task',
        scopeRef: 'issue-1',
        instructions: '',
        steps: [
          {
            id: 'review',
            title: 'Review',
            instructions: '',
            completionGuidance: '',
            executionProfileId: 'profile-missing',
          },
        ],
      },
      operator,
    )
    const run = service.startRun({
      sessionId: 's1',
      cwd: '/repo/wt',
      issueId: 'issue-1',
      revisionId: created.revision.id,
    })
    expect(service.prime({}, agent('s1'))).toContain(
      'Execution profile unavailable: profile-missing',
    )
    const checkpoint = service.checkpoint(
      {
        runId: run.id,
        status: 'active',
        summary: '',
        evidence: { summary: '', tests: [], artifacts: [] },
      },
      agent('s1'),
    )
    expect(checkpoint.warnings).toContain('execution profile profile-missing is unavailable')
  })

  it('checkpoints linear steps, records observations, and tells the coordinator what is next', () => {
    const profile = service.profileSave(
      {
        name: 'Codex review',
        accountId: 'native:codex',
        harness: 'codex',
        model: 'gpt-5.6',
        effort: 'medium',
      },
      operator,
    )
    const created = service.create(
      {
        name: 'Build',
        description: '',
        scope: 'task',
        scopeRef: 'issue-1',
        instructions: 'Drive it through completion.',
        steps: [
          {
            id: 'implement',
            title: 'Implement',
            instructions: 'Build it',
            completionGuidance: 'Tests pass',
          },
          {
            id: 'review',
            title: 'Review',
            instructions: 'Review it',
            completionGuidance: 'Findings resolved',
            executionProfileId: profile.id,
          },
        ],
      },
      operator,
    )
    const run = service.startRun({
      sessionId: 's1',
      cwd: '/repo/wt',
      issueId: 'issue-1',
      revisionId: created.revision.id,
    })
    expect(
      service.executionProfileForLaunch({
        profileId: profile.id,
        runId: run.id,
        stepId: 'review',
      }),
    ).toMatchObject({ harness: 'codex', model: 'gpt-5.6', effort: 'medium' })
    service.profileSave(
      {
        id: profile.id,
        name: 'Codex review updated',
        accountId: 'native:claude-code',
        harness: 'claude-code',
        model: 'claude-fable-5',
        effort: 'high',
      },
      operator,
    )
    expect(
      service.executionProfileForLaunch({
        profileId: profile.id,
        runId: run.id,
        stepId: 'review',
      }),
    ).toMatchObject({ harness: 'codex', model: 'gpt-5.6', effort: 'medium' })
    expect(service.executionProfileForLaunch({ profileId: profile.id })).toMatchObject({
      harness: 'claude-code',
      model: 'claude-fable-5',
    })
    const first = service.checkpoint(
      {
        runId: run.id,
        stepId: 'implement',
        status: 'complete',
        summary: 'implemented',
        evidence: { summary: 'done', tests: ['bun test: pass'], artifacts: ['abc123'] },
        observation: {
          cwd: '/repo/wt',
          worktree: '/repo/wt',
          branch: 'feature',
          head: 'abc123',
          dirty: true,
          ahead: 1,
          behind: 0,
          observedAt: '2026-07-13T12:00:00.000Z',
        },
      },
      agent('s1'),
    )
    expect(first.message).toBe('Step complete. Next: Review')
    expect(first.warnings).toContain('step completed with uncommitted worktree changes')
    expect(first.nextStep?.stepId).toBe('review')
    expect(service.runs({}, operator).map((item) => item.id)).toEqual([run.id])
    expect(service.renderRunPrime(first.run, 's1')).toContain(
      `podium agent spawn --issue issue-1 --prompt "<task>" --workflow-run-id ${run.id} --workflow-step-id review --execution-profile-id ${profile.id}`,
    )

    service.assignStep({ runId: run.id, stepId: 'review', sessionId: 's2' }, agent('s1'))
    const completed = service.checkpoint(
      {
        runId: run.id,
        stepId: 'review',
        status: 'complete',
        summary: 'reviewed',
        evidence: { summary: '', tests: [], artifacts: [] },
      },
      agent('s2'),
    )
    expect(completed.run.status).toBe('complete')
    expect(completed.message).toBe('Workflow complete.')
    expect(notices).toEqual([
      { sessionId: 's1', text: 'Workflow step "Review" complete: reviewed' },
    ])
    expect(service.runs({}, operator)).toEqual([])
    expect(service.runs({ includeTerminal: true }, operator)).toHaveLength(1)
  })

  it('keeps later issue sessions on the active run revision until explicit adoption', () => {
    const created = service.create(
      {
        name: 'Pinned issue workflow',
        description: '',
        scope: 'task',
        scopeRef: 'issue-1',
        instructions: 'version one',
        steps: [{ id: 'build', title: 'Build', instructions: '', completionGuidance: '' }],
      },
      operator,
    )
    const run = service.startRun({
      sessionId: 's1',
      cwd: '/repo/wt',
      issueId: 'issue-1',
      revisionId: created.revision.id,
    })
    const revised = service.revise(
      {
        workflowId: created.workflow.id,
        instructions: 'version two',
        steps: [{ id: 'build', title: 'Build', instructions: '', completionGuidance: '' }],
      },
      agent('s1'),
    )

    const prepared = service.prepareStart({
      sessionId: 's2',
      cwd: '/repo/wt',
      issueId: 'issue-1',
    })
    expect(prepared?.revision.id).toBe(created.revision.id)
    expect(prepared?.prompt).toContain('version one')
    expect(service.prime({}, agent('s2'))).toContain('role: issue participant')
    expect(service.status({}, agent('s2')).id).toBe(run.id)
    expect(() =>
      service.checkpoint(
        {
          runId: run.id,
          status: 'active',
          summary: '',
          evidence: { summary: '', tests: [], artifacts: [] },
        },
        agent('s2'),
      ),
    ).toThrow('not assigned')
    expect(() =>
      service.prepareStart({
        sessionId: 's2',
        cwd: '/repo/wt',
        issueId: 'issue-1',
        explicitRevisionId: revised.id,
      }),
    ).toThrow('adopt a new revision explicitly')
  })

  it('validates adoption completely before superseding the live run', () => {
    const created = service.create(
      {
        name: 'Safe adoption',
        description: '',
        scope: 'task',
        scopeRef: 'issue-1',
        instructions: '',
        steps: [{ id: 'build', title: 'Build', instructions: '', completionGuidance: '' }],
      },
      operator,
    )
    const run = service.startRun({
      sessionId: 's1',
      cwd: '/repo/wt',
      issueId: 'issue-1',
      revisionId: created.revision.id,
    })
    expect(() => service.adopt({ revisionId: 'missing' }, agent('s1'))).toThrow(
      'unknown workflow revision',
    )
    expect(store.workflows.getRun(run.id)?.status).toBe('active')
    expect(() =>
      service.adopt({ revisionId: created.revision.id, startStepId: 'missing' }, agent('s1')),
    ).toThrow('workflow has no step missing')
    expect(store.workflows.getRun(run.id)?.status).toBe('active')
  })

  it('rejects duplicate step ids and keeps execution profiles operator-managed', () => {
    expect(() =>
      workflowInputs.create.parse({
        name: 'Invalid steps',
        scope: 'global',
        steps: [
          { id: 'same', title: 'One' },
          { id: 'same', title: 'Two' },
        ],
      }),
    ).toThrow('duplicate workflow step id')
    expect(() =>
      service.profileSave(
        { name: 'Shared', accountId: 'acct', harness: 'codex', model: 'auto', effort: 'auto' },
        agent('s1'),
      ),
    ).toThrow('only the operator')
    expect(() =>
      workflowInputs.profileSave.parse({ name: 'Bad', accountId: 'acct', harness: 'unknown' }),
    ).toThrow()
  })

  it('adopts a new revision explicitly and preserves the superseded run', () => {
    const created = service.create(
      {
        name: 'Adoptable',
        description: '',
        scope: 'task',
        scopeRef: 'issue-1',
        instructions: 'v1',
        steps: [
          { id: 'research', title: 'Research', instructions: '', completionGuidance: '' },
          { id: 'build', title: 'Build', instructions: '', completionGuidance: '' },
        ],
      },
      operator,
    )
    const first = service.startRun({
      sessionId: 's1',
      cwd: '/repo/wt',
      issueId: 'issue-1',
      revisionId: created.revision.id,
    })
    const secondRevision = service.revise(
      {
        workflowId: created.workflow.id,
        instructions: 'v2',
        steps: [
          { id: 'research', title: 'Research', instructions: '', completionGuidance: '' },
          { id: 'build', title: 'Build', instructions: 'new', completionGuidance: '' },
        ],
      },
      agent('s1'),
    )
    const adopted = service.adopt(
      { revisionId: secondRevision.id, startStepId: 'build' },
      agent('s1'),
    )
    expect(adopted.supersedesRunId).toBe(first.id)
    expect(adopted.revision.id).toBe(secondRevision.id)
    expect(adopted.steps[0]?.status).toBe('skipped')
    expect(adopted.steps[1]?.status).toBe('pending')
    expect(store.workflows.getRun(first.id)?.status).toBe('superseded')
  })
})
