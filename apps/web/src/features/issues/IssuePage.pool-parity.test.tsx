import { expectPoolOutput } from '../../../../../packages/worklist-proto/harness/src/oracle/pool-output'
// @vitest-environment happy-dom
import '@/test-support/mock-store-action-ports'
import '@/test-support/model-catalog-mock'
import type { ClientRuntime } from '@podium/client-core/engine'
import { dedupeSessions } from '@podium/client-core/engine'
import { recordSliceDerivation, storeStats } from '@podium/client-core/perf'
import { useStoreHandle } from '@podium/client-core/react'
import {
  deriveIssueRollups,
  deriveIssueViews,
  type IssueViewInput,
  type IssueViewModel,
} from '@podium/client-core/replica'
import type { SessionView } from '@podium/client-core/session-values'
import { createPoolHost, type PoolHost } from '@podium/client-graph/host'
import { ISSUE_BOARD_ENTITIES } from '@podium/client-graph/issue-board-schema'
import { createIssueBoardSource } from '@podium/client-graph/issue-board-source'
import { attachIssuePageSource } from '@podium/client-graph/issue-page-source'
import { MobxPool } from '@podium/client-graph/pool'
import { createPoolProjection } from '@podium/client-graph/runtime-pool'
import type { SliceIssue } from '@podium/client-graph/shared/slice-types'
import { asIssueId, asSessionId, asUserId } from '@podium/model/browser'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { type ReactNode, useEffect, useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OperatorFocusProvider } from '@/app/operator-focus'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ConfirmProvider } from '@/lib/hooks/use-confirm'
import { makeIssue } from '@/lib/test-issue'
import { IssuePage } from './IssuePage'
import { IssuePanelView } from './IssuePanelView'
import { PoolIssuePage } from './pool-issue-page'

let forbidden = true,
  legacyReads = 0
let pool: MobxPool
let startupHost: PoolHost | undefined
const poolReads = vi.fn()
let legacyIssues: IssueViewModel[] = [],
  visibleSessions: SessionView[] = []
const STAMP = '2026-09-01T12:00:00.000Z',
  NOW = Date.parse('2026-10-01T12:00:00Z')
const exits: Record<string, 'evicted' | 'removed'> = { invisible: 'evicted', removed: 'removed' }
const replica = {
  exitKind: (_entity: string, id: string) => exits[id],
  subscribeAddressedBatch: () => () => {},
}
const comments = vi.fn(async () => [
  {
    id: 'comment',
    issueId: 'root',
    body: 'Synthetic comment',
    author: 'operator',
    createdAt: STAMP,
  },
])
const events = vi.fn(async () => [
  {
    id: 1,
    ts: STAMP,
    kind: 'issue.created',
    subject: 'root',
    repoPath: '/synthetic',
    payload: null,
  },
])
const mail = vi.fn(async () => [])
const updateIssue = vi.fn(async () => ({})),
  deleteIssue = vi.fn(async () => ({}))
const navigate = vi.fn(),
  select = vi.fn(),
  markRead = vi.fn(),
  setView = vi.fn(),
  setPane = vi.fn()
const uiState = { get: () => null, set: vi.fn(), subscribe: () => () => {} }
const trpc = {
  issues: {
    comments: { query: comments },
    events: { query: events },
    mailInbox: { mutate: mail },
    update: { mutate: updateIssue },
    start: { mutate: vi.fn(async () => ({})) },
    addSession: { mutate: vi.fn(async () => ({})) },
    addShell: { mutate: vi.fn(async () => ({})) },
    close: { mutate: vi.fn(async () => ({})) },
    clearNeedsHuman: { mutate: vi.fn(async () => ({})) },
    panelApply: { mutate: vi.fn(async () => ({})) },
    addComment: { mutate: vi.fn(async () => ({})) },
  },
  settings: { get: { query: vi.fn(async () => ({ gitWorkflow: { mergeStyle: 'ff-only' } })) } },
  sessions: { sendText: { mutate: vi.fn(async () => ({})) } },
}
const state = {
  get replica() {
    if (forbidden) throw new Error('Pool page read the store replica')
    return replica
  },
  get issues() {
    if (forbidden) throw new Error('Pool page read legacy issues')
    legacyReads++
    return legacyIssues
  },
  get sessions() {
    if (forbidden) throw new Error('Pool page read legacy sessions')
    legacyReads++
    return visibleSessions
  },
  trpc,
  hub: { onIssues: () => () => {} },
  uiState,
  httpOrigin: '',
  repos: [],
  machines: [],
  selectedIssueId: asIssueId('root'),
  setSelectedIssueId: select,
  markIssueRead: markRead,
  markIssueUnread: vi.fn(),
  markSessionRead: vi.fn(),
  setPane,
  setView,
  setOpenIssueId: vi.fn(),
  setSelectedWorktree: vi.fn(),
  navigateToSession: navigate,
  updateIssue,
  deleteIssue,
  closeIssue: vi.fn(async () => ({})),
  deferIssue: vi.fn(),
  undeferIssue: vi.fn(),
  setIssueLabels: vi.fn(),
  restoreIssue: vi.fn(),
  setIssuePlacement: vi.fn(),
  renameSession: vi.fn(async () => ({})),
  archiveSession: vi.fn(),
  openFileInWorktree: vi.fn(),
  openArtifact: vi.fn(),
}
vi.mock('@/app/store', () => ({
  useStore: () => state,
  useRuntimeSelector: (select: (owner: unknown) => unknown) => select(state),
  useReplicaIssues: () => {
    recordSliceDerivation(replica, 'replica.issueViews')
    return state.issues
  },
}))
vi.mock('@/app/store-worklist-pool', () => ({
  useWorklistPool: () => {
    // biome-ignore lint/correctness/useHookAtTopLevel: The test selects its host before mounting and clears it only after cleanup.
    const current = startupHost ? startupHost.usePool() : pool
    poolReads(current)
    return current
  },
  useWorklistPoolProjection: (read: (pool: MobxPool) => unknown, empty: unknown) =>
    startupHost
      ? // biome-ignore lint/correctness/useHookAtTopLevel: The test selects its host before mounting and clears it only after cleanup.
        startupHost.usePoolProjection(read, empty)
      : createPoolProjection(pool, read).getSnapshot(),
}))
vi.mock('@podium/client-graph/runtime-pool', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@podium/client-graph/runtime-pool')>()),
  // Keep the actual host's asynchronous attach and React subscriptions; the
  // row-source factory supplies this test's existing normalized pool.
  createRuntimeWorklistPool: () => ({ pool, dispose: () => {} }),
}))
vi.mock('@/lib/use-feature', () => ({ useFeature: () => false }))
vi.mock('../cost/useTaskCost', () => ({ useTaskCost: () => ({ view: null }) }))
vi.mock('./explorer/explorer-context', () => ({
  useIssueExplorer: () => ({
    tab: null,
    setTab: vi.fn(),
    query: '',
    setQuery: vi.fn(),
    push: vi.fn(),
    listScrollTop: () => 0,
    rememberListScrollTop: vi.fn(),
  }),
}))

const session = (id: string, issueId: string, patch: Record<string, unknown> = {}) =>
  ({
    sessionId: asSessionId(id),
    issueId: asIssueId(issueId),
    refIssueId: asIssueId(issueId),
    cwd: '/synthetic',
    name: `Named ${id}`,
    title: `Session ${id}`,
    displayRef: `S-${id}`,
    agentKind: 'codex',
    status: 'live',
    archived: false,
    createdAt: STAMP,
    lastActiveAt: STAMP,
    resumable: true,
    agentState: { phase: 'working', since: STAMP },
    ...patch,
  }) as unknown as SessionView
function seed(
  patch: Partial<IssueViewModel> = {},
  extra: IssueViewModel[] = [],
  roster?: SessionView[],
) {
  const raw = [
    makeIssue({
      id: 'parent',
      seq: 5,
      title: 'Archived parent',
      repoPath: '/synthetic',
      repoId: 'R',
      prefix: 'SYN',
      archived: true,
      stage: 'done',
      updatedAt: STAMP,
      createdAt: STAMP,
    }),
    makeIssue({
      id: 'root',
      seq: 10,
      title: 'Exact page title',
      repoPath: '/synthetic',
      repoId: 'R',
      prefix: 'SYN',
      parentId: 'parent',
      description: 'The complete synthetic description.',
      brief: 'The synthetic brief.',
      design: 'The design text.',
      acceptance: 'The acceptance text.',
      notes: 'Private notes in the process.',
      activityNotes: 'The current synthetic update.',
      notesUpdatedAt: STAMP,
      labels: ['alpha', 'beta'],
      createdAt: STAMP,
      updatedAt: STAMP,
      defaultAgent: 'codex',
      worktreePath: '/synthetic/work',
      branch: 'issue/10-synthetic',
      owner: asUserId('operator'),
      createdBy: { actor: { kind: 'user', id: asUserId('operator') }, onBehalfOf: null },
      needsHuman: true,
      asked: { question: 'A synthetic decision?', options: ['One', 'Two'] },
      estimateMin: 45,
      color: 'blue',
      deps: [
        { id: 'target', type: 'blocks' },
        { id: 'invisible', type: 'related' },
        { id: 'removed', type: 'blocks' },
        { id: 'pending', type: 'custom' },
      ],
      gitState: {
        branch: 'issue/10-synthetic',
        ahead: 2,
        dirtyFiles: 1,
        shared: false,
        merged: false,
        updatedAt: STAMP,
      },
      ...patch,
    }),
    makeIssue({
      id: 'child-a',
      seq: 12,
      title: 'Open child',
      parentId: 'root',
      repoPath: '/synthetic',
      repoId: 'R',
      prefix: 'SYN',
      createdAt: STAMP,
      updatedAt: STAMP,
    }),
    makeIssue({
      id: 'child-b',
      seq: 11,
      title: 'Archived done child',
      parentId: 'root',
      stage: 'done',
      archived: true,
      repoPath: '/synthetic',
      repoId: 'R',
      prefix: 'SYN',
      createdAt: STAMP,
      updatedAt: STAMP,
    }),
    makeIssue({
      id: 'target',
      seq: 20,
      title: 'Blocking task',
      repoPath: '/synthetic',
      repoId: 'R',
      prefix: 'SYN',
      createdAt: STAMP,
      updatedAt: STAMP,
    }),
    makeIssue({
      id: 'source',
      seq: 21,
      title: 'Related source',
      repoPath: '/synthetic',
      repoId: 'R',
      prefix: 'SYN',
      deps: [
        { id: 'root', type: 'blocks' },
        { id: 'root', type: 'custom' },
      ],
      createdAt: STAMP,
      updatedAt: STAMP,
    }),
    ...extra,
  ].sort((a, b) => a.id.localeCompare(b.id))
  const seats = (
    roster ?? [
      session('worker-a', 'root'),
      session('worker-b', 'root', {
        agentState: { phase: 'waiting', since: STAMP, idle: { kind: 'needs-input' } },
      }),
      session('headless', 'root', { headless: true }),
      session('shell', 'root', { agentKind: 'shell' }),
      session('twin-a', 'root', {
        status: 'hibernated',
        resume: { kind: 'codex-thread', value: 'same' },
      }),
      session('twin-b', 'root', {
        status: 'exited',
        resume: { kind: 'codex-thread', value: 'same' },
      }),
      session('moved', 'child-a', { refIssueId: asIssueId('root') }),
    ]
  ).sort((a, b) => a.sessionId.localeCompare(b.sessionId))
  const inputs = raw as unknown as IssueViewInput[]
  const rollupSeats = seats.map((seat) => ({ ...seat, phase: seat.agentState?.phase }))
  const index = new Map(rollupSeats.map((seat) => [seat.sessionId, seat]))
  const views = deriveIssueViews(inputs, rollupSeats, { now: () => NOW })
  legacyIssues = raw.map((row) => ({
    ...row,
    ...views.get(row.id),
    ...deriveIssueRollups(row, views.get(row.id)!.memberSessionIds, (id) => index.get(id)),
    id: row.id,
  }))
  visibleSessions = dedupeSessions(seats)
  pool = new MobxPool({ selectedIssueId: 'root', coarseNow: NOW })
  pool.sources.register(ISSUE_BOARD_ENTITIES, createIssueBoardSource(pool))
  pool.apply({
    type: 'replace',
    rows: [
      {
        kind: 'worktree',
        id: '/synthetic/work',
        value: {
          path: '/synthetic/work',
          repoId: 'R',
          repoName: 'Synthetic',
          repoPath: '/synthetic',
          prefix: 'SYN',
        },
      },
      ...seats.map((value) => ({ kind: 'session' as const, id: value.sessionId, value })),
      ...legacyIssues.map((value) => ({ kind: 'issue' as const, id: value.id, value })),
    ],
  })
  attachIssuePageSource(pool, { replica } as Parameters<typeof attachIssuePageSource>[1])
}

/** The actual DOM, in order, including text, labels and layout attributes.
 * Only React's generated accessibility IDs are renamed consistently. */
function rendered(root: Element): unknown {
  const ids = new Map<string, string>()
  const id = (value: string) => {
    if (!ids.has(value)) ids.set(value, `id-${ids.size}`)
    return ids.get(value)!
  }
  const visit = (node: Node): unknown => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent?.replace(/\s+/g, ' ')
    if (!(node instanceof Element)) return null
    const attrs = Object.fromEntries(
      [...node.attributes].map((attr) => [
        attr.name,
        /^(id|aria-controls|aria-describedby|aria-labelledby|aria-owns|data-rootownerid)$/.test(
          attr.name,
        )
          ? attr.value.split(' ').map(id).join(' ')
          : attr.value,
      ]),
    )
    return {
      tag: node.tagName,
      attrs,
      children: [...node.childNodes].map(visit).filter((value) => value !== null),
    }
  }
  return visit(root)
}
const actions = () => ({
  select: select.mock.calls,
  read: markRead.mock.calls,
  view: setView.mock.calls,
  pane: setPane.mock.calls,
  navigate: navigate.mock.calls,
})
function wrap(child: ReactNode) {
  return (
    <TooltipProvider>
      <ConfirmProvider>
        <OperatorFocusProvider missionId="root">{child}</OperatorFocusProvider>
      </ConfirmProvider>
    </TooltipProvider>
  )
}
async function arm(surface: 'page' | 'panel' | 'list') {
  forbidden = true
  legacyReads = 0
  storeStats.reset()
  const issue = legacyIssues.find((row) => row.id === 'root')!
  const view = render(
    wrap(
      surface === 'page' ? (
        <IssuePage
          issue={{ ...issue, title: 'Stale caller title' }}
          orderedIds={[asIssueId('parent'), issue.id, asIssueId('target')]}
          onBack={vi.fn()}
          onNavigate={navigate}
        />
      ) : (
        <IssuePanelView
          cwd={surface === 'list' ? '/unknown' : '/synthetic/work'}
          issueId={surface === 'panel' ? issue.id : undefined}
        />
      ),
    ),
  )
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  await waitFor(() =>
    expect(
      surface === 'list'
        ? screen.getByRole('textbox', { name: 'Search tasks' })
        : screen.getAllByText('Exact page title').length,
    ).toBeTruthy(),
  )
  if (surface !== 'list')
    await waitFor(() => expect(screen.getAllByText('Synthetic comment').length).toBeGreaterThan(0))
  const main = rendered(view.container)
  if (surface === 'page') {
    fireEvent.click(screen.getByTitle('More actions'))
    await screen.findByRole('menu')
  } else if (surface === 'panel') {
    const completed = screen.queryByText(/Show 1 completed/)
    if (completed) fireEvent.click(completed)
    const retired = screen.queryByText(/Show .*retired/)
    if (retired) fireEvent.click(retired)
  }
  const expanded = rendered(document.body)
  const counts = storeStats.snapshot().runtimes.flatMap((row) => Object.entries(row.slices))
  const reads = legacyReads
  const text = view.container.textContent
  cleanup()
  return { main, expanded, counts, reads, text, actions: actions() }
}

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW)
  storeStats.enable()
  seed()
})
afterEach(() => {
  forbidden = true
  cleanup()
  startupHost = undefined
  pool.dispose()
  storeStats.enable(false)
  storeStats.reset()
  vi.restoreAllMocks()
  vi.clearAllMocks()
})
describe('issue page rendered pool parity', () => {
  it.each([
    'page',
    'panel',
    'list',
  ] as const)('preserves the %s text, labels, order, layout and loader results with zero legacy derivations', async (surface) => {
    const next = await arm(surface)
    expectPoolOutput({ main: next.main, expanded: next.expanded }, 'rendered output')
    expect(next.reads).toBe(0)
    expect(
      next.counts.filter(
        ([name]) => name.startsWith('issue-page.') || name === 'replica.issueViews',
      ),
    ).toEqual([])
    if (surface !== 'list') {
      expect(comments).toHaveBeenCalled()
      expect(events).toHaveBeenCalled()
    }
  })

  it('preserves the rendered continuation after multiple spin-off hops', async () => {
    pool.dispose()
    seed(
      { stage: 'in_progress', needsHuman: false },
      [
        makeIssue({
          id: 'hop',
          seq: 23,
          title: 'Finished continuation',
          stage: 'done',
          repoPath: '/synthetic',
          repoId: 'R',
          prefix: 'SYN',
          deps: [{ id: 'root', type: 'discovered-from' }],
          createdAt: STAMP,
          updatedAt: STAMP,
        }),
        makeIssue({
          id: 'tip',
          seq: 24,
          title: 'Staffed continuation',
          stage: 'backlog',
          repoPath: '/synthetic',
          repoId: 'R',
          prefix: 'SYN',
          deps: [{ id: 'hop', type: 'discovered-from' }],
          createdAt: STAMP,
          updatedAt: STAMP,
        }),
      ],
      [session('tip-worker', 'tip')],
    )
    const next = await arm('panel')
    expect(next.text).toContain('Work continued in SYN-24')
    expectPoolOutput({ main: next.main, expanded: next.expanded }, 'rendered output')
    expect(next.reads).toBe(0)
  })

  it('preserves the fallback list close dialog, working members, child counts, question and delivery words', async () => {
    pool.dispose()
    seed({ parentId: undefined })
    async function closeFromList() {
      forbidden = true
      legacyReads = 0
      const view = render(wrap(<IssuePanelView cwd="/unknown" />))
      await screen.findByRole('textbox', { name: 'Search tasks' })
      const row = (await screen.findAllByTestId('explorer-row')).find((node) =>
        node.textContent?.includes('Exact page title'),
      )
      if (!row) throw new Error('Missing close test issue row')
      fireEvent.click(within(row).getByTestId('issue-status-picker'))
      fireEvent.click(await screen.findByRole('menuitem', { name: /^Done$/ }))
      const dialog = await screen.findByRole('alertdialog')
      const result = { tree: rendered(dialog), text: dialog.textContent, reads: legacyReads }
      expect(state.closeIssue).not.toHaveBeenCalled()
      cleanup()
      return result
    }
    const next = await closeFromList()
    expect(next.text).toContain('still working')
    expect(next.text).toContain('A synthetic decision?')
    expect(next.text).toContain('awaiting delivery')
    expectPoolOutput(next.tree, 'close dialog')
    expect(next.reads).toBe(0)
  })

  it('keeps pool hooks stable through the real host attach from no pool to an attached pool', async () => {
    forbidden = true
    legacyReads = 0
    const errors = vi.fn(),
      back = vi.fn(),
      initial = vi.fn()
    startupHost = createPoolHost({
      screens: [{}],
      dev: false,
    })
    const issue = legacyIssues.find((row) => row.id === 'root')!
    let attach: (() => void) | undefined, stop: (() => void) | undefined
    function AttachAfterRender() {
      const owner = useStoreHandle()
      const first = useRef(startupHost!.usePool())
      useEffect(() => {
        initial(first.current)
        attach = () => {
          stop = startupHost!.attach(
            Object.assign(owner, { ui: { get: () => null } }) as unknown as ClientRuntime,
            errors,
          )
        }
        return () => stop?.()
      }, [owner])
      return (
        <PoolIssuePage issueId={issue.id} orderedIds={[]} onBack={back} onNavigate={navigate} />
      )
    }
    const view = render(wrap(<AttachAfterRender />))
    // Mount the actual pool page body before the host's asynchronous attach.
    await waitFor(() => expect(poolReads).toHaveBeenCalledWith(null))
    expect(view.container.textContent).toBe('')
    expect(initial).toHaveBeenCalledExactlyOnceWith(null)
    await act(async () => {
      attach!()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    await screen.findByText('Exact page title')
    expect(errors).not.toHaveBeenCalled()
    expect(back).not.toHaveBeenCalled()
    expect(legacyReads).toBe(0)
  })

  it('leaves once per issue ID, matching the legacy latch when the same row returns', async () => {
    forbidden = true
    const issue = legacyIssues.find((row) => row.id === 'root')!,
      back = vi.fn()
    const payload = pool.row('issue', issue.id)
    if (!payload || typeof payload === 'symbol') throw new Error('Missing eviction fixture payload')
    const view = render(
      wrap(<IssuePage issue={issue} orderedIds={[]} onBack={back} onNavigate={navigate} />),
    )
    await screen.findByText('Exact page title')
    pool.apply({ type: 'update', rows: [{ kind: 'issue', id: issue.id, value: undefined }] })
    view.rerender(
      wrap(<IssuePage issue={issue} orderedIds={[]} onBack={back} onNavigate={navigate} />),
    )
    await waitFor(() => expect(back).toHaveBeenCalledTimes(1))
    view.rerender(
      wrap(<IssuePage issue={issue} orderedIds={[]} onBack={back} onNavigate={navigate} />),
    )
    expect(back).toHaveBeenCalledTimes(1)
    pool.apply({
      type: 'update',
      rows: [{ kind: 'issue', id: issue.id, value: payload as SliceIssue }],
    })
    view.rerender(
      wrap(<IssuePage issue={issue} orderedIds={[]} onBack={back} onNavigate={navigate} />),
    )
    await screen.findByText('Exact page title')
    pool.apply({ type: 'update', rows: [{ kind: 'issue', id: issue.id, value: undefined }] })
    view.rerender(
      wrap(<IssuePage issue={issue} orderedIds={[]} onBack={back} onNavigate={navigate} />),
    )
    expect(back).toHaveBeenCalledTimes(1)
  })
})
