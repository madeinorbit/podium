/**
 * POD-647 — the workflows slice.
 *
 * The properties under test are the ones the OLD component had no test for and
 * therefore did not inherit: partial-world resolution of a run's subject,
 * fail-closed placement including the null-machineId path, the attribution PAIR,
 * and the evicted-open-item question. Parity of the plain list/detail shaping is
 * covered too, because a refactor that changes it silently is the failure this
 * issue's parity requirement names.
 */
import type {
  WorkflowDetailWire,
  WorkflowRunWire,
  WorkflowWire,
} from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import type { MachineView } from './machines/authority'
import {
  currentStepOf,
  openWorkflowStillVisible,
  placementOptions,
  profilePlacement,
  runAdvances,
  runAttribution,
  runSubjectReference,
  scopeLabel,
  workflowLibraryEntries,
  workflowRevisionDetail,
} from './workflows'

// ---------------------------------------------------------------------------
// Fixtures — the smallest wires that are still real wires.
// ---------------------------------------------------------------------------

function workflow(over: Partial<WorkflowWire> & { id: string; name: string }): WorkflowWire {
  return {
    description: '',
    scope: 'global',
    scopeRef: null,
    latestRevisionId: `rev-${over.id}`,
    latestVersion: 1,
    archivedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  }
}

function revision(id: string, version: number, publishedAt: string | null) {
  return {
    id,
    workflowId: 'wf-1',
    version,
    instructions: `instructions ${version}`,
    steps: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    publishedAt,
  }
}

function step(over: { stepId: string; status: WorkflowRunWire['steps'][number]['status']; position: number }) {
  return {
    title: `step ${over.position}`,
    instructions: '',
    completionGuidance: '',
    executionProfileId: null,
    executionProfileSnapshot: null,
    assignedSessionId: null,
    attempt: 1,
    summary: '',
    evidence: { summary: '', tests: [], artifacts: [] },
    observation: null,
    warnings: [],
    startedAt: null,
    completedAt: null,
    ...over,
  } as WorkflowRunWire['steps'][number]
}

function run(over: Partial<WorkflowRunWire> = {}): WorkflowRunWire {
  return {
    id: 'run-1',
    subjectKind: 'issue',
    subjectId: 'iss-1',
    coordinatorSessionId: 'ses-1' as WorkflowRunWire['coordinatorSessionId'],
    revision: revision('rev-1', 1, '2026-01-01T00:00:00.000Z'),
    status: 'active',
    supersedesRunId: null,
    steps: [],
    history: [],
    startedAt: '2026-01-01T00:00:00.000Z',
    completedAt: null,
    ...over,
  }
}

const view = (id: string, availability: MachineView['availability'], online = true): MachineView => ({
  machine: { id, online },
  grants: { see: true, use: availability !== 'unauthorized', manage: false },
  availability,
})

// ---------------------------------------------------------------------------

describe('workflowLibraryEntries', () => {
  it('orders live entries before archived ones, each group by name', () => {
    const entries = workflowLibraryEntries([
      workflow({ id: 'c', name: 'Charlie' }),
      workflow({ id: 'a', name: 'Alpha', archivedAt: '2026-01-02T00:00:00.000Z' }),
      workflow({ id: 'b', name: 'Bravo' }),
    ])
    expect(entries.map((e) => e.id)).toEqual(['b', 'c', 'a'])
    expect(entries.map((e) => e.archived)).toEqual([false, false, true])
  })

  it('labels a scoped workflow with its ref and a global one without', () => {
    const entries = workflowLibraryEntries([
      workflow({ id: 'g', name: 'G' }),
      workflow({ id: 'r', name: 'R', scope: 'repository', scopeRef: 'repo-7' }),
    ])
    expect(entries.map((e) => e.scopeLabel)).toEqual(['global', 'repository · repo-7'])
    expect(scopeLabel('task', null)).toBe('task')
  })

  it('derives nothing but the rows it was handed — an entry is never invented', () => {
    expect(workflowLibraryEntries([])).toEqual([])
  })

  it('flags an unpublished head only for the entry whose detail is loaded, never by guess', () => {
    const detail: WorkflowDetailWire = {
      workflow: workflow({ id: 'wf-1', name: 'One' }),
      revisions: [revision('rev-2', 2, null), revision('rev-1', 1, '2026-01-01T00:00:00.000Z')],
    }
    const entries = workflowLibraryEntries(
      [workflow({ id: 'wf-1', name: 'One' }), workflow({ id: 'wf-2', name: 'Two' })],
      detail,
    )
    expect(entries.find((e) => e.id === 'wf-1')?.hasUnpublishedHead).toBe(true)
    // wf-2's head is UNKNOWN here, and unknown renders as no badge — not as a
    // guessed one.
    expect(entries.find((e) => e.id === 'wf-2')?.hasUnpublishedHead).toBe(false)
  })
})

describe('openWorkflowStillVisible — eviction leaves quietly', () => {
  it('is false once the open id is no longer in the principal’s list', () => {
    const entries = workflowLibraryEntries([workflow({ id: 'wf-2', name: 'Two' })])
    expect(openWorkflowStillVisible('wf-1', entries)).toBe(false)
  })

  it('is true while the open id is still visible, and with nothing open', () => {
    const entries = workflowLibraryEntries([workflow({ id: 'wf-1', name: 'One' })])
    expect(openWorkflowStillVisible('wf-1', entries)).toBe(true)
    expect(openWorkflowStillVisible(null, entries)).toBe(true)
  })
})

describe('workflowRevisionDetail', () => {
  it('publishes the head, its editable buffers and the full history', () => {
    const model = workflowRevisionDetail({
      workflow: workflow({ id: 'wf-1', name: 'One', description: 'desc' }),
      revisions: [revision('rev-2', 2, null), revision('rev-1', 1, '2026-01-01T00:00:00.000Z')],
    })
    expect(model.head).toEqual({ id: 'rev-2', version: 2, published: false })
    expect(model.instructions).toBe('instructions 2')
    expect(model.stepsJson).toBe('[]')
    expect(model.history.map((r) => [r.version, r.published])).toEqual([
      [2, false],
      [1, true],
    ])
  })

  it('has no head for a workflow with no revision, rather than a fabricated one', () => {
    const model = workflowRevisionDetail({
      workflow: workflow({ id: 'wf-1', name: 'One' }),
      revisions: [],
    })
    expect(model.head).toBeUndefined()
    expect(model.instructions).toBe('')
  })
})

describe('run progress', () => {
  it('addresses the active step, else the blocked one, else the first pending', () => {
    expect(
      currentStepOf(
        run({
          steps: [
            step({ stepId: 's1', status: 'complete', position: 0 }),
            step({ stepId: 's2', status: 'active', position: 1 }),
            step({ stepId: 's3', status: 'pending', position: 2 }),
          ],
        }),
      )?.stepId,
    ).toBe('s2')
    expect(
      currentStepOf(run({ steps: [step({ stepId: 's1', status: 'pending', position: 0 })] }))?.stepId,
    ).toBe('s1')
  })

  it('offers retry only on a blocked step, and neither advance on a terminal run', () => {
    const blocked = run({ steps: [step({ stepId: 's1', status: 'blocked', position: 0 })], status: 'blocked' })
    expect(runAdvances(blocked)).toEqual({ skip: true, retry: true })

    const active = run({ steps: [step({ stepId: 's1', status: 'active', position: 0 })] })
    expect(runAdvances(active)).toEqual({ skip: true, retry: false })

    const done = run({ status: 'complete', steps: [step({ stepId: 's1', status: 'complete', position: 0 })] })
    expect(runAdvances(done)).toEqual({ skip: false, retry: false })
  })

  it('offers no advance on a prompt-only run, which has no step to address', () => {
    expect(runAdvances(run({ steps: [] }))).toEqual({ skip: false, retry: false })
  })
})

describe('runAttribution — the pair, never collapsed', () => {
  it('keeps actor and on-behalf-of apart and marks the delegated ones', () => {
    const rows = runAttribution(
      run({
        history: [
          {
            kind: 'run.started',
            actorKind: 'session',
            actorId: 'ses-9',
            onBehalfOf: 'user:alice',
            createdAt: '2026-01-01T00:00:01.000Z',
          },
          {
            kind: 'step.skipped',
            actorKind: 'system',
            actorId: null,
            onBehalfOf: null,
            createdAt: '2026-01-01T00:00:02.000Z',
          },
        ],
      }),
    )
    expect(rows.map((r) => [r.actorKind, r.actorId, r.onBehalfOf, r.delegated])).toEqual([
      ['session', 'ses-9', 'user:alice', true],
      // No human behind a system act — and the null is NOT filled in with the
      // operator, which is the lie this assertion exists to catch.
      ['system', null, null, false],
    ])
  })

  it('is empty for a run with no recorded acts, not a synthesised one', () => {
    expect(runAttribution(run())).toEqual([])
  })
})

describe('runSubjectReference — a partial world', () => {
  const present = (id: string) => (id === 'iss-1' ? { id } : undefined)
  const nothing = () => undefined

  it('resolves a visible subject', () => {
    expect(runSubjectReference(run(), present).state).toBe('present')
  })

  it('renders an EVICTED subject as not-visible — an opaque reference, never removed', () => {
    const ref = runSubjectReference(run(), nothing, () => 'evicted')
    expect(ref.state).toBe('not-visible')
    expect(ref.value).toBeUndefined()
    // The id survives so the UI can show an opaque reference rather than
    // spinning or claiming a deletion.
    expect(ref.id).toBe('iss-1')
  })

  it('distinguishes removed from still-arriving', () => {
    expect(runSubjectReference(run(), nothing, () => 'removed').state).toBe('removed')
    expect(runSubjectReference(run(), nothing).state).toBe('pending')
  })
})

describe('placement fails closed', () => {
  it('treats a null machineId as UNPLACED, never as “anything available”', () => {
    expect(profilePlacement({ id: 'p1', machineId: null }, [view('m1', 'available')])).toEqual({
      profileId: 'p1',
      machineId: null,
      state: 'unplaced',
    })
  })

  it('carries unauthorized and unreachable through as different answers', () => {
    const views = [view('m1', 'unauthorized'), view('m2', 'unreachable', false)]
    expect(profilePlacement({ id: 'p1', machineId: 'm1' }, views).state).toBe('unauthorized')
    expect(profilePlacement({ id: 'p2', machineId: 'm2' }, views).state).toBe('unreachable')
  })

  it('reports a machine the principal cannot see as unknown — the same as a nonexistent id', () => {
    expect(profilePlacement({ id: 'p1', machineId: 'm-invisible' }, []).state).toBe('unknown')
  })

  it('offers only usable machines, and reports the refused ones separately', () => {
    const options = placementOptions([
      view('m1', 'available'),
      view('m2', 'unauthorized'),
      view('m3', 'unreachable', false),
    ])
    expect(options.offerable.map((m) => m.id)).toEqual(['m1'])
    expect(options.unauthorized.map((m) => m.id)).toEqual(['m2'])
    expect(options.unreachable.map((m) => m.id)).toEqual(['m3'])
  })
})
