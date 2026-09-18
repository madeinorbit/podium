import { kernelFixture } from './kernel-fixture'
import { indexSessionOwnership, sidebarSections } from '@podium/client-core/viewmodels'
import {
  type GitRepositoryWire,
  ISSUE_STAGES,
  type IssueWire,
  type SessionMeta,
} from '@podium/model/browser'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { flushSync } from 'react-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ToolbarSlotProvider, ToolbarSlotTarget } from '@/app/ToolbarSlot'
import { IssuesView } from '@/features/issues/IssuesView'
import {
  ISSUE_VIRTUAL_MAX_ITEMS,
  ISSUE_VIRTUAL_SIZE_CACHE,
} from '@/features/issues/use-bounded-virtual-list'

/** Generated/anonymized Ludovico cardinalities captured in POD-981/POD-991. */
const SCALE = {
  issues: 674,
  sessions: 530,
  repositories: 12,
  worktreesPerRepository: 8,
} as const

const BUDGET = {
  tasksInitialElements: 4_000,
  tasksInitialButtons: 225,
  // Recalibrated on 91808701f: 79,194 reads with the current kanban.
  tasksInitialIssueReads: 80_000,
  sidebarCwdReads: SCALE.sessions * 2,
  sidebarIssueReads: SCALE.issues * 30,
  replicaIncomingReads: SCALE.issues * 100,
} as const

type Counter = { gets: number; ownKeys: number }

const bench = vi.hoisted(() => ({ store: {} as Record<string, unknown> }))

vi.mock('@/app/store', () => ({
  useReplicaIssues: () => bench.store.issues ?? [],
  useStoreSelector: (selector: (store: Record<string, unknown>) => unknown) =>
    selector(bench.store),
}))

vi.mock('@/lib/hooks/use-is-mobile', () => ({ useIsMobile: () => false }))

function counted<T extends object>(value: T, counter: Counter): T {
  return new Proxy(value, {
    get(target, key, receiver) {
      counter.gets++
      return Reflect.get(target, key, receiver)
    },
    ownKeys(target) {
      counter.ownKeys++
      return Reflect.ownKeys(target)
    },
  })
}

function worktreePath(index: number): string {
  const repo = Math.floor(index / SCALE.worktreesPerRepository)
  const slot = index % SCALE.worktreesPerRepository
  return slot === 0 ? `/srv/repos/repo-${repo}` : `/srv/worktrees/wt-${index}`
}

function issueAt(index: number): IssueWire {
  const stage = ISSUE_STAGES[index % ISSUE_STAGES.length] ?? 'backlog'
  const worktree = index % (SCALE.repositories * SCALE.worktreesPerRepository)
  return {
    id: `issue-${String(index).padStart(4, '0')}`,
    displayRef: `POD-${10_000 + index}`,
    repoPath: `/srv/repos/repo-${Math.floor(worktree / SCALE.worktreesPerRepository)}`,
    seq: 10_000 + index,
    title: `Generated benchmark task ${index}`,
    description: `Anonymized deterministic task ${index % 17}`,
    stage,
    worktreePath: worktreePath(worktree),
    branch: `issue/${10_000 + index}-generated`,
    parentBranch: 'main',
    defaultAgent: index % 2 === 0 ? 'codex' : 'claude-code',
    blockedByNotes: [],
    createdAt: `2026-07-${String((index % 17) + 1).padStart(2, '0')}T08:00:00.000Z`,
    updatedAt: `2026-07-${String((index % 17) + 1).padStart(2, '0')}T12:00:00.000Z`,
    archived: false,
    needsHuman: index % 19 === 0,
    sessions: [],
    origin: index % 7 === 0 ? 'agent' : 'human',
    audience: 'human',
    draft: false,
    childCount: 0,
    childDoneCount: 0,
    priority: index % 5,
    type: index % 23 === 0 ? 'bug' : 'task',
    pinned: false,
    labels: [`area-${index % 8}`, `lane-${index % 3}`],
    deps: [],
    dependents: [],
    comments: [],
    ready: true,
    blocked: false,
    deferred: false,
  } as unknown as IssueWire
}

function sessionAt(index: number): SessionMeta {
  const worktree = index % (SCALE.repositories * SCALE.worktreesPerRepository)
  return {
    sessionId: `session-${String(index).padStart(4, '0')}`,
    agentKind: index % 2 === 0 ? 'codex' : 'claude-code',
    cwd: `${worktreePath(worktree)}/apps/web`,
    title: `Generated session ${index}`,
    status: 'live',
    controllerId: `controller-${index % 12}`,
    geometry: { cols: 120, rows: 36 },
    epoch: 1,
    clientCount: 1,
    createdAt: '2026-07-18T08:00:00.000Z',
    lastActiveAt: `2026-07-18T${String(8 + (index % 10)).padStart(2, '0')}:00:00.000Z`,
    origin: { kind: 'spawn' },
    archived: false,
    readAt: null,
    unread: index % 11 === 0,
    issueId: index % 3 === 0 ? `issue-${String(index).padStart(4, '0')}` : undefined,
    agentState: { phase: 'working', since: '2026-07-18T08:00:00.000Z' },
  } as unknown as SessionMeta
}

function repositories(): GitRepositoryWire[] {
  return Array.from({ length: SCALE.repositories }, (_, repoIndex) => ({
    path: `/srv/repos/repo-${repoIndex}`,
    branch: 'main',
    originUrl: `github.com/anonymized/repo-${repoIndex}`,
    machineId: `machine-${repoIndex % 3}`,
    worktrees: Array.from({ length: SCALE.worktreesPerRepository - 1 }, (_, child) => {
      const worktree = repoIndex * SCALE.worktreesPerRepository + child + 1
      return { path: `/srv/worktrees/wt-${worktree}`, branch: `issue/${worktree}-generated` }
    }),
  })) as unknown as GitRepositoryWire[]
}

function metric(name: string, values: Record<string, number>): void {
  console.info(`[large-state] ${JSON.stringify({ name, ...values })}`)
}

function setNativeInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  if (!setter) throw new Error('HTMLInputElement.value setter is unavailable')
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('Ludovico-scale frontend budgets [spec:SP-0b2e] [spec:SP-e2c8] [spec:SP-d562]', () => {
  it('bounds Tasks DOM, defers text filtering, and preserves full-order navigation', async () => {
    const issueReads: Counter = { gets: 0, ownKeys: 0 }
    const issues = Array.from({ length: SCALE.issues }, (_, index) =>
      counted(issueAt(index), issueReads),
    )
    const setOpenIssueId = vi.fn()
    bench.store = {
      issues,
      sessions: [],
      openIssueId: null,
      setOpenIssueId,
      uiState: { get: () => null, set: vi.fn(), subscribe: () => () => {} },
      trpc: {
        issues: {
          update: { mutate: vi.fn(async () => ({})) },
          setLabels: { mutate: vi.fn(async () => ({})) },
          delete: { mutate: vi.fn(async () => ({})) },
        },
      },
    }

    const started = performance.now()
    const originalConsoleError = console.error
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      if (!String(args[0]).startsWith('Base UI: A component that acts as a button')) {
        originalConsoleError(...args)
      }
    })
    const { container } = render(
      <ToolbarSlotProvider>
        <ToolbarSlotTarget />
        <IssuesView />
      </ToolbarSlotProvider>,
    )
    const renderMs = performance.now() - started
    const initialElements = container.querySelectorAll('*').length
    const initialButtons = container.querySelectorAll('button').length
    const initialCards = container.querySelectorAll('[data-issue-id]').length
    const initialIssueReads = issueReads.gets
    // Each grouped stage owns its own bounded window; report the aggregate ceiling
    // explicitly so the DOM budget does not imply one global 36-row window.
    const aggregateGroupedListBound = ISSUE_STAGES.length * ISSUE_VIRTUAL_MAX_ITEMS

    expect(ISSUE_VIRTUAL_MAX_ITEMS).toBe(36)
    expect(ISSUE_VIRTUAL_SIZE_CACHE).toBe(128)
    expect(initialCards).toBeLessThanOrEqual(aggregateGroupedListBound)
    expect(initialCards).toBeLessThan(SCALE.issues)
    expect(initialElements).toBeLessThanOrEqual(BUDGET.tasksInitialElements)
    expect(initialButtons).toBeLessThanOrEqual(BUDGET.tasksInitialButtons)
    expect(initialIssueReads).toBeLessThanOrEqual(BUDGET.tasksInitialIssueReads)
    const windowedCards = initialCards

    // The Tasks toolbar lives in ToolbarSlot's portal, outside this render's
    // container but inside the same document.
    const search = document.querySelector<HTMLInputElement>('[aria-label="Search tasks"]')
    expect(search).not.toBeNull()
    const initialCardIds = [...container.querySelectorAll<HTMLElement>('[data-issue-id]')].map(
      (card) => card.dataset.issueId,
    )
    flushSync(() => setNativeInputValue(search as HTMLInputElement, 'Generated benchmark task 673'))
    expect(search?.value).toBe('Generated benchmark task 673')
    expect(
      [...container.querySelectorAll<HTMLElement>('[data-issue-id]')].map(
        (card) => card.dataset.issueId,
      ),
    ).toEqual(initialCardIds)
    await act(async () => {})
    expect(
      [...container.querySelectorAll<HTMLElement>('[data-issue-id]')].map(
        (card) => card.dataset.issueId,
      ),
    ).toEqual(['issue-0673'])

    flushSync(() => setNativeInputValue(search as HTMLInputElement, ''))
    await act(async () => {})

    // Shift-click the last initially visible card, then move to the first hidden position in
    // the next stage. Full-order navigation must mount that hidden target.
    const selected = container.querySelectorAll<HTMLElement>('[data-issue-id]')[15] as HTMLElement
    expect(selected).toBeDefined()
    fireEvent.click(selected, { shiftKey: true })
    fireEvent.keyDown(window, { key: 'ArrowDown' })
    const keyboardCards = container.querySelectorAll('[data-issue-id]').length
    expect(keyboardCards).toBeLessThanOrEqual(aggregateGroupedListBound + 1)
    const focused = container.querySelector<HTMLElement>('[data-issue-id].ring-2')
    expect(focused).not.toBeNull()
    const focusedId = focused?.dataset.issueId
    expect(focusedId).toBeDefined()
    expect(focusedId).not.toBe(selected.dataset.issueId)
    fireEvent.keyDown(window, { key: 'Enter' })
    expect(setOpenIssueId).toHaveBeenCalledOnce()
    expect(setOpenIssueId).toHaveBeenCalledWith(focusedId)

    metric('tasks', {
      issues: SCALE.issues,
      initialElements,
      initialButtons,
      initialCards,
      windowedCards,
      aggregateGroupedListBound,
      keyboardCards,
      initialIssuePropertyReads: initialIssueReads,
      renderMs: Math.round(renderMs * 10) / 10,
    })
  })

  it('derives sidebar ownership with one cwd resolution per session', () => {
    const cwdReads = { value: 0 }
    const issueReads: Counter = { gets: 0, ownKeys: 0 }
    const issues = Array.from({ length: SCALE.issues }, (_, index) =>
      counted(issueAt(index), issueReads),
    )
    const sessions = Array.from({ length: SCALE.sessions }, (_, index) => {
      const session = sessionAt(index)
      return new Proxy(session, {
        get(target, key, receiver) {
          if (key === 'cwd') cwdReads.value++
          return Reflect.get(target, key, receiver)
        },
      })
    })
    const repos = repositories()
    const worktreePaths = repos.flatMap((repo) => [
      repo.path,
      ...repo.worktrees.map((worktree) => worktree.path),
    ])

    const started = performance.now()
    const ownership = indexSessionOwnership(sessions, issues, worktreePaths)
    const sections = sidebarSections(
      repos,
      sessions,
      { panels: [], worktrees: [], repos: [] },
      Date.parse('2026-07-18T18:00:00.000Z'),
      issues,
    )
    const deriveMs = performance.now() - started
    const derivedWorktrees = sections.repos.reduce((sum, repo) => sum + repo.worktrees.length, 0)

    expect(ownership.sessionById.size).toBe(SCALE.sessions)
    expect(derivedWorktrees).toBe(SCALE.repositories * SCALE.worktreesPerRepository)
    expect(cwdReads.value).toBeLessThanOrEqual(BUDGET.sidebarCwdReads)
    expect(issueReads.gets).toBeLessThanOrEqual(BUDGET.sidebarIssueReads)

    metric('sidebar', {
      issues: SCALE.issues,
      sessions: SCALE.sessions,
      worktrees: derivedWorktrees,
      cwdReads: cwdReads.value,
      issuePropertyReads: issueReads.gets,
      deriveMs: Math.round(deriveMs * 10) / 10,
    })
  })

  it('uses the shipped kernel facade and updates only the changed durable row', async () => {
    const { cache, replica, upsert } = kernelFixture()
    const initial = Array.from({ length: SCALE.issues }, (_, index) => issueAt(index))
    for (const row of initial) cache.put('issue', row.id, row)
    const before = replica.rows('issues')
    const notify = vi.fn()
    const off = replica.subscribeRows('issues', notify)
    // Kernel events follow a committed durable write; the facade never writes
    // wire-v1 snapshots. Replaying an identical durable object is a no-op.
    upsert('issue', initial[337]!.id, initial[337]!)
    await replica.flush()
    expect(replica.rows('issues')).toBe(before)
    const scans = cache.scans
    cache.reads = 0
    notify.mockClear()
    upsert('issue', initial[337]!.id, { ...initial[337]!, title: 'Changed title' })
    await replica.flush()
    expect(notify).toHaveBeenCalledOnce()
    expect(replica.rows('issues')[337]?.title).toBe('Changed title')
    expect(replica.rows('issues')[0]).toBe(before[0])
    expect(cache.scans).toBe(scans)
    expect(cache.reads).toBe(1)
    expect(() => replica.applySnapshot('issues', initial)).toThrow('wire-v1')
    off()
    metric('kernel-replica', {
      issues: SCALE.issues,
      durableReads: cache.reads,
      globalScans: cache.scans - scans,
      notifications: notify.mock.calls.length,
    })
  })
})
