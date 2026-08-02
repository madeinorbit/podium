/**
 * POD-647 — the seams the OLD WorkflowsView had NO test for, and which a
 * refactor therefore does not inherit coverage of.
 *
 * Three of them, each the behaviour of an effect this refactor DELETED and
 * replaced rather than a property of the slice (that is `workflows.test.ts`'s
 * job):
 *
 *  1. A DENIED write surfaces and re-reads; it does not retry, and it does not
 *     leave a success message standing.
 *  2. An EVICTED open workflow leaves quietly — the selection moves on with no
 *     tombstone and no re-request of the vanished id. The old detail effect
 *     would have re-fetched it and painted an error banner forever.
 *  3. Run history renders the attribution PAIR from server fields, and an
 *     invisible run subject renders as an OPAQUE REFERENCE rather than as
 *     loading or deleted.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const list = vi.fn()
const get = vi.fn()
const bindings = vi.fn<() => Promise<unknown[]>>(async () => [])
const profiles = vi.fn<() => Promise<unknown[]>>(async () => [])
const runs = vi.fn<() => Promise<unknown[]>>(async () => [])
const publish = vi.fn()

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

const detailOf = (id: string) => ({
  workflow: workflow(id, id),
  revisions: [
    {
      id: `rev-${id}`,
      workflowId: id,
      version: 1,
      instructions: 'do the thing',
      steps: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      publishedAt: null,
    },
  ],
})

vi.mock('@/app/store', () => {
  const useStore = () => ({
    machines: [],
    issues: [],
    sessions: [],
    trpc: {
      workflows: {
        list: { query: list },
        get: { query: get },
        bindings: { query: bindings },
        profiles: { query: profiles },
        runs: { query: runs },
        publish: { mutate: publish },
      },
    },
  })
  return {
    useStore,
    useStoreSelector: (sel: (s: unknown) => unknown) => sel(useStore() as never),
    useReplicaIssues: () => [],
  }
})

// Imported after the mock so the module graph picks it up.
const { WorkflowsView } = await import('./WorkflowsView')

beforeEach(() => {
  vi.clearAllMocks()
  list.mockResolvedValue([workflow('wf-1', 'One')])
  get.mockImplementation(async ({ id }: { id: string }) => detailOf(id))
  runs.mockResolvedValue([])
})
afterEach(cleanup)

describe('a denied write', () => {
  it('surfaces the refusal, re-reads, and does NOT retry', async () => {
    publish.mockRejectedValue(new Error('not authorized to publish'))
    render(<WorkflowsView />)
    await screen.findByText('One')

    const listsBefore = list.mock.calls.length
    const button = await screen.findByRole('button', { name: /Publish/ })
    fireEvent.click(button)

    await waitFor(() => expect(publish).toHaveBeenCalled())
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('not authorized to publish')
    })
    // The rollback: the surface re-read the authority rather than keeping an
    // optimistic overlay.
    expect(list.mock.calls.length).toBeGreaterThan(listsBefore)
    // THE POINT OF THIS TEST. One attempt, ever.
    expect(publish).toHaveBeenCalledTimes(1)
    // And no success sentence was ever shown to take back.
    expect(screen.queryByText('Published this revision.')).toBeNull()
  })
})

describe('an evicted open workflow', () => {
  it('leaves quietly: the selection moves on, and the vanished id is never re-requested', async () => {
    list.mockResolvedValueOnce([workflow('wf-1', 'One'), workflow('wf-2', 'Two')])
    render(<WorkflowsView />)
    await screen.findByText('One')
    await waitFor(() => expect(get).toHaveBeenCalledWith({ id: 'wf-1' }))

    // wf-1 loses visibility with nothing deleted anywhere.
    list.mockResolvedValue([workflow('wf-2', 'Two')])
    const getsForWf1 = get.mock.calls.filter(([arg]) => arg.id === 'wf-1').length
    fireEvent.click(screen.getByRole('button', { name: /Refresh/ }))

    await waitFor(() => expect(screen.queryByText('One')).toBeNull())
    // No deletion affordance, no tombstone, no toast — nothing announces it.
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByText(/deleted|removed/i)).toBeNull()
    // NO HEAL LOOP: the id we can no longer see is not asked for again.
    await waitFor(() => {
      expect(get.mock.calls.filter(([arg]) => arg.id === 'wf-1').length).toBe(getsForWf1)
    })
  })
})

describe('run progress', () => {
  const run = (over: Record<string, unknown> = {}) => ({
    id: 'run-1',
    subjectKind: 'issue',
    subjectId: 'iss-invisible',
    coordinatorSessionId: 'ses-1',
    revision: detailOf('wf-1').revisions[0],
    status: 'active',
    supersedesRunId: null,
    steps: [],
    history: [],
    startedAt: '2026-01-01T00:00:00.000Z',
    completedAt: null,
    ...over,
  })

  it('renders an invisible subject as an opaque reference, not as loading or deleted', async () => {
    runs.mockResolvedValue([run()])
    render(<WorkflowsView />)
    fireEvent.click(screen.getByRole('button', { name: 'Progress' }))

    const reference = await screen.findByText(/iss-invisible · no access/)
    expect(reference).toBeTruthy()
    expect(screen.queryByText(/deleted|removed/i)).toBeNull()
    expect(screen.queryByText(/Loading/)).toBeNull()
  })

  it('shows the attribution PAIR, and states a missing human rather than inventing one', async () => {
    runs.mockResolvedValue([
      run({
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
      }),
    ])
    render(<WorkflowsView />)
    fireEvent.click(screen.getByRole('button', { name: 'Progress' }))

    expect(await screen.findByText('on behalf of user:alice')).toBeTruthy()
    expect(screen.getByText('by session ses-9')).toBeTruthy()
    // The null is STATED. It is not filled in with the operator.
    expect(screen.getByText('no delegating human')).toBeTruthy()
  })
})
