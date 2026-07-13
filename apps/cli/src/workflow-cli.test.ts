import type { ApprovalOp, WorkflowGitObservation, WorkflowRunWire } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import {
  parseWorkflowArgs,
  runWorkflowCli,
  type WorkflowCliDeps,
  WorkflowCliError,
} from './workflow-cli'

function fakeClient(
  invoke: (proc: string, input: unknown, query: boolean) => unknown | Promise<unknown>,
): WorkflowCliDeps['client'] {
  return {
    workflows: new Proxy(
      {},
      {
        get: (_target, proc) => ({
          query: (input: unknown) => invoke(String(proc), input, true),
          mutate: (input: unknown) => invoke(String(proc), input, false),
        }),
      },
    ),
  } as WorkflowCliDeps['client']
}

const observation: WorkflowGitObservation = {
  cwd: '/repo/wt',
  worktree: '/repo/wt',
  branch: 'issue/285',
  head: 'abc',
  dirty: false,
  ahead: 1,
  behind: 0,
  observedAt: '2026-07-13T12:00:00.000Z',
}

function run(status: WorkflowRunWire['status'] = 'active'): WorkflowRunWire {
  return {
    id: 'wrun_1',
    subjectKind: 'issue',
    subjectId: 'issue-1',
    coordinatorSessionId: 'session-1',
    revision: {
      id: 'wfr_1',
      workflowId: 'wf_1',
      version: 1,
      instructions: 'Ship it.',
      steps: [{ id: 'build', title: 'Build', instructions: '', completionGuidance: '' }],
      createdAt: '2026-07-13T12:00:00.000Z',
      publishedAt: null,
    },
    status,
    supersedesRunId: null,
    steps: [
      {
        stepId: 'build',
        position: 0,
        title: 'Build',
        instructions: '',
        completionGuidance: '',
        executionProfileId: null,
        executionProfileSnapshot: null,
        status: status === 'complete' ? 'complete' : 'active',
        assignedSessionId: 'session-1',
        attempt: 1,
        summary: '',
        evidence: { summary: '', tests: [], artifacts: [] },
        observation: null,
        warnings: [],
        startedAt: null,
        completedAt: null,
      },
    ],
    startedAt: '2026-07-13T12:00:00.000Z',
    completedAt: null,
  }
}

describe('podium workflow CLI', () => {
  it('parses flags without treating their values as positionals', () => {
    expect(
      parseWorkflowArgs([
        'checkpoint',
        'complete',
        '--summary',
        'done',
        '--tests=unit,integration',
        '--json',
      ]),
    ).toEqual({
      command: 'checkpoint',
      positionals: ['complete'],
      args: { summary: 'done', tests: 'unit,integration', json: true },
    })
  })

  it('creates a workflow from markdown and structured step files', async () => {
    const calls: Array<{ proc: string; input: unknown }> = []
    const deps: WorkflowCliDeps = {
      cwd: '/repo',
      client: fakeClient((proc, input) => {
        calls.push({ proc, input })
        return { workflow: { id: 'wf_1' }, revision: { id: 'wfr_1' } }
      }),
      readText: async (path) =>
        path.endsWith('.md')
          ? '# Research, plan, implement'
          : '[{"id":"research","title":"Research","instructions":"","completionGuidance":""}]',
    }
    await runWorkflowCli(
      [
        'create',
        'RPI',
        '--scope',
        'repository',
        '--scope-ref',
        'repo-1',
        '--instructions-file',
        'workflow.md',
        '--steps-file',
        'steps.json',
      ],
      deps,
    )
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      proc: 'create',
      input: {
        name: 'RPI',
        scope: 'repository',
        scopeRef: 'repo-1',
        instructions: '# Research, plan, implement',
        steps: [{ id: 'research', title: 'Research' }],
      },
    })
  })

  it('checkpoints with only standard git observations and prints the next action', async () => {
    let sent: Record<string, unknown> | undefined
    const text = await runWorkflowCli(['checkpoint', 'complete', '--summary', 'tests pass'], {
      cwd: '/repo/wt',
      observeGit: () => observation,
      client: fakeClient((_proc, input) => {
        sent = input as Record<string, unknown>
        return {
          run: run('complete'),
          currentStep: null,
          nextStep: null,
          message: 'Workflow complete.',
          warnings: [],
        }
      }),
    })
    expect(sent).toMatchObject({
      status: 'complete',
      summary: 'tests pass',
      evidence: { summary: 'tests pass' },
      observation,
    })
    expect(text).toBe('Workflow complete.')
  })

  it('requests typed approval for shared defaults without invoking assign directly', async () => {
    const ops: ApprovalOp[] = []
    const text = await runWorkflowCli(['default', 'global', 'wfr_1'], {
      cwd: '/repo',
      relayEndpoint: 'http://relay',
      client: fakeClient(() => {
        throw new Error('should not call workflow assign before approval')
      }),
      approve: async (_endpoint, op) => {
        ops.push(op)
        return { text: 'approved', exitCode: 0 }
      },
    })
    expect(text).toBe('approved')
    expect(ops).toEqual([
      {
        kind: 'workflow-set-default',
        targetKind: 'global',
        targetId: '',
        revisionId: 'wfr_1',
      },
    ])
  })

  it('turns only the server approval-required publication response into an approval', async () => {
    const ops: ApprovalOp[] = []
    await runWorkflowCli(['publish', 'wfr_1'], {
      cwd: '/repo',
      relayEndpoint: 'http://relay',
      client: fakeClient(() => {
        throw new Error('approval required to publish a global workflow revision')
      }),
      approve: async (_endpoint, op) => {
        ops.push(op)
        return { text: 'published', exitCode: 0 }
      },
    })
    expect(ops).toEqual([{ kind: 'workflow-publish', revisionId: 'wfr_1' }])
  })

  it('rejects arbitrary or misspelled flags', async () => {
    await expect(
      runWorkflowCli(['checkpoint', 'complete', '--execute', 'rm'], {
        cwd: '/repo',
        client: fakeClient(() => null),
      }),
    ).rejects.toBeInstanceOf(WorkflowCliError)
  })
})
