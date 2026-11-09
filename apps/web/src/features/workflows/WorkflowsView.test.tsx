/**
 * POD-647 — the seams the OLD WorkflowsView had NO test for, and which a
 * refactor therefore does not inherit coverage of.
 *
 * Three of them, each the behaviour of an effect this refactor DELETED and
 * replaced rather than a property of the slice (that is `workflows.test.ts`'s
 * job):
 *
 *  1. A DENIED write surfaces once; it does not retry, and it does not leave a
 *     success message standing.
 *  2. An EVICTED open workflow leaves quietly — the selection moves on with no
 *     tombstone and nothing asked for (the records are synced, POD-6676).
 *  3. Run history, a request asked for when shown, renders the attribution
 *     PAIR from server fields, and an invisible run subject renders as an
 *     OPAQUE REFERENCE rather than as loading or deleted.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { poolFixtureStore } from '@/test-support/pool-issue-fixture'
import '@/test-support/mock-screen-pool'
import { runInAction } from 'mobx'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeIssue } from '@/lib/test-issue'

let subjects: ReturnType<typeof makeIssue>[] = []
const testHandle = vi.hoisted(() => ({
  getSnapshot: (): unknown => ({}),
  get access(): unknown {
    return this.getSnapshot()
  },
}))
vi.mock('@podium/client-core/react', async (original) => {
  const { fixtureRuntimeHooks } = await import('@podium/client-core/test-support/command-hooks')
  return {
    ...(await original<typeof import('@podium/client-core/react')>()),
    ...fixtureRuntimeHooks(() => testHandle),
  }
})

/*
 * THE RECORDS (POD-6676). Workflows, revisions, bindings, profiles and runs are
 * synced records the screen reads from the pool (`workflowRecords`); here they
 * are an observable the test sets, so a change shows the way a feed change does.
 */
const records = vi.hoisted(() => ({ box: undefined as unknown }))
vi.mock('@podium/client-graph/workflow-views', async (original) => {
  const actual = await original<typeof import('@podium/client-graph/workflow-views')>()
  const { observable } = await import('mobx')
  const box = observable.box<unknown>(undefined, { deep: false })
  records.box = box
  return { ...actual, workflowRecords: () => box.get() }
})
const submit = vi.fn()
const status = vi.fn()

const workflow = (id: string, name: string) => ({
  id,
  name,
  description: '',
  scope: 'global' as const,
  scopeRef: null,
  latestRevisionId: `rev-${id}`,
  latestVersion: 1,
  archivedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
})

const revisionOf = (id: string) => ({
  id: `rev-${id}`,
  workflowId: id,
  version: 1,
  instructions: 'do the thing',
  steps: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  publishedAt: null,
})

type RunRow = Record<string, unknown> & { id: string; status: string }

/** The records the screen sees now, as the pool would hand them over. */
function setRecords(next: { workflows?: ReturnType<typeof workflow>[]; runs?: RunRow[] }): void {
  const workflows = next.workflows ?? []
  const revisions = workflows.map((row) => revisionOf(row.id))
  const runs = (next.runs ?? []).map((run) => ({
    ...run,
    live: run.status === 'active' || run.status === 'blocked',
  }))
  runInAction(() =>
    (records.box as { set(value: unknown): void }).set({
      profiles: [],
      workflows,
      revisionsOf: (id: string) => revisions.filter((revision) => revision.workflowId === id),
      bindings: [],
      runs,
    }),
  )
}

vi.mock('@/app/store', () => {
  const fixtureState = () =>
    poolFixtureStore({
      machines: [],
      issues: subjects,
      sessions: [],
      trpc: {
        sync: { submit: { mutate: submit } },
        workflows: { status: { query: status } },
      },
    })
  testHandle.getSnapshot = fixtureState
  return {
    useStore: fixtureState,
    readFixture: (sel: (s: unknown) => unknown) => sel(fixtureState() as never),
    useSession: (id: string | undefined) =>
      id === undefined
        ? undefined
        : (fixtureState().sessions as Array<{ sessionId: string }>).find(
            (session) => session.sessionId === id,
          ),
  }
})

// Imported after the mock so the module graph picks it up.
const { WorkflowsView } = await import('./WorkflowsView')

beforeEach(() => {
  vi.clearAllMocks()
  subjects = []
  setRecords({ workflows: [workflow('wf-1', 'One')] })
  submit.mockResolvedValue({
    outcome: 'applied',
    result: {},
    receipt: { feedId: 'f', epoch: 'e', seq: 1 },
    replayed: false,
  })
})
afterEach(cleanup)

describe('a denied write', () => {
  it('surfaces the refusal once, and does NOT retry', async () => {
    submit.mockResolvedValue({
      outcome: 'rejected',
      refusal: { kind: 'unauthorized', message: 'not authorized to publish' },
    })
    render(<WorkflowsView />)
    // The open workflow's name shows in the list and in its editor.
    await screen.findAllByText('One')

    fireEvent.click(await screen.findByRole('button', { name: /Publish/ }))

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('not authorized to publish')
    })
    // THE POINT OF THIS TEST. One attempt, ever, on the sync write entry point.
    expect(submit).toHaveBeenCalledTimes(1)
    expect(submit.mock.calls[0]?.[0]).toMatchObject({ command: 'workflows.publish' })
    // And no success sentence was ever shown to take back.
    expect(screen.queryByText('Published this revision.')).toBeNull()
  })
})

describe('an evicted open workflow', () => {
  it('leaves quietly: the selection moves on, and nothing is asked for', async () => {
    setRecords({ workflows: [workflow('wf-1', 'One'), workflow('wf-2', 'Two')] })
    render(<WorkflowsView />)
    await screen.findAllByText('One')

    // wf-1 loses visibility with nothing deleted anywhere: its record leaves.
    setRecords({ workflows: [workflow('wf-2', 'Two')] })

    await waitFor(() => expect(screen.queryAllByText('One')).toEqual([]))
    expect((await screen.findAllByText('Two')).length).toBeGreaterThan(0)
    // No deletion affordance, no tombstone, no toast — nothing announces it.
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByText(/deleted|removed/i)).toBeNull()
    // No request at all: the records are the feed's.
    expect(submit).not.toHaveBeenCalled()
    expect(status).not.toHaveBeenCalled()
  })
})

describe('run progress', () => {
  const run = (over: Record<string, unknown> = {}): RunRow => ({
    id: 'run-1',
    subjectKind: 'issue',
    subjectId: 'iss-invisible',
    coordinatorSessionId: 'ses-1',
    revisionId: 'rev-wf-1',
    workflowId: 'wf-1',
    status: 'active',
    supersedesRunId: null,
    steps: [],
    startedAt: '2026-01-01T00:00:00.000Z',
    completedAt: null,
    ...over,
  })

  it('shows the live runs, and the finished ones too when asked', async () => {
    setRecords({
      workflows: [workflow('wf-1', 'One')],
      runs: [
        run({ id: 'run-live-1' }),
        run({ id: 'run-live-2', status: 'blocked' }),
        ...[1, 2, 3].map((n) => run({ id: `run-done-${n}`, status: 'complete' })),
      ],
    })
    render(<WorkflowsView />)
    fireEvent.click(screen.getByRole('button', { name: 'Progress' }))
    expect(await screen.findAllByText(/^run-[a-z]+-\d+ ·/)).toHaveLength(2)
    fireEvent.click(await screen.findByRole('checkbox'))
    await waitFor(() => expect(screen.getAllByText(/^run-[a-z]+-\d+ ·/)).toHaveLength(5))
  })

  it('renders a present subject with only normalized replica rows', async () => {
    subjects = [makeIssue({ id: 'iss-visible', title: 'Projection subject' })]
    const world = poolFixtureStore({ issues: subjects })
    setRecords({ workflows: [workflow('wf-1', 'One')], runs: [run({ subjectId: 'iss-visible' })] })
    render(<WorkflowsView />)
    fireEvent.click(screen.getByRole('button', { name: 'Progress' }))
    expect(await screen.findByText('issue · iss-visible')).toBeTruthy()
    expect(screen.queryByText(/iss-visible · no access/)).toBeNull()
    expect(world).toBeTruthy()
  })

  it('renders an invisible subject as an opaque reference, not as loading or deleted', async () => {
    setRecords({ workflows: [workflow('wf-1', 'One')], runs: [run()] })
    render(<WorkflowsView />)
    fireEvent.click(screen.getByRole('button', { name: 'Progress' }))

    const reference = await screen.findByText(/iss-invisible · no access/)
    expect(reference).toBeTruthy()
    expect(screen.queryByText(/deleted|removed/i)).toBeNull()
    expect(screen.queryByText(/Loading/)).toBeNull()
  })

  it('asks for the history when shown, and states a missing human rather than inventing one', async () => {
    setRecords({ workflows: [workflow('wf-1', 'One')], runs: [run()] })
    status.mockResolvedValue({
      ...run(),
      history: [
        {
          kind: 'workflow.run_started',
          actorKind: 'session',
          actorId: 'ses-9',
          onBehalfOf: 'user:alice',
          createdAt: '2026-01-01T00:00:01.000Z',
        },
        {
          kind: 'workflow.step_skipped',
          actorKind: 'system',
          actorId: null,
          onBehalfOf: null,
          createdAt: '2026-01-01T00:00:02.000Z',
        },
      ],
    })
    render(<WorkflowsView />)
    fireEvent.click(screen.getByRole('button', { name: 'Progress' }))
    // The history grows, so it is a request answer, asked for only when shown.
    expect(status).not.toHaveBeenCalled()
    fireEvent.click(await screen.findByRole('button', { name: 'Run history' }))

    expect(await screen.findByText('on behalf of user:alice')).toBeTruthy()
    expect(status).toHaveBeenCalledWith({ runId: 'run-1' })
    expect(screen.getByText('by session ses-9')).toBeTruthy()
    // The null is STATED. It is not filled in with the operator.
    expect(screen.getByText('no delegating human')).toBeTruthy()
  })
})
