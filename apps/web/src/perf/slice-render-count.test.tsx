// @vitest-environment happy-dom
import { Profiler, act, type JSX } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SidebarUnified } from '../features/worklist/SidebarUnified'

// ---------------------------------------------------------------------------
// POD-330 RENDER-COUNT PROBE — worklist + chat.
//
// The acceptance criterion for the derive.ts slice split is "no regression, and
// ideally an improvement, versus baseline". A ratio with no measured baseline is
// unfalsifiable, so this file measures TWO quantities on a fixed publish
// sequence and asserts BOUNDS that were recorded on the UNCUT tree first:
//
//   COMMITS     — React Profiler commits of the screen subtree per store
//                 publish. This is the criterion as stated.
//   DERIVATIONS — how many times the view-model derivation actually executes
//                 per publish. This is the quantity the refactor moves: today
//                 every consuming component runs its own memo over the same
//                 inputs, so N consumers means N executions of the same
//                 derivation; a published slice computes it once per change.
//
// A "publish" here is what the real store does — a new snapshot object whose
// slice-relevant CONTENT is unchanged (fresh array identities, same values).
// That is the common case in this app: an unrelated field moves, every consumer
// re-derives. Both numbers are printed on every run so a regression is legible
// as a number and not only as a failed assertion.
// ---------------------------------------------------------------------------

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** Real executions of the two worklist derivations, counted by wrapping them. */
const derivations = { sidebarSections: 0, unifiedWorkList: 0 }

vi.mock('@podium/client-core/viewmodels', async () => {
  const real =
    await vi.importActual<typeof import('@podium/client-core/viewmodels')>(
      '@podium/client-core/viewmodels',
    )
  return {
    ...real,
    sidebarSections: (...args: Parameters<typeof real.sidebarSections>) => {
      derivations.sidebarSections++
      return real.sidebarSections(...args)
    },
    unifiedWorkList: (...args: Parameters<typeof real.unifiedWorkList>) => {
      derivations.unifiedWorkList++
      return real.unifiedWorkList(...args)
    },
  }
})

function sess(id: string, issueId: string, phase: 'idle' | 'working') {
  return {
    sessionId: id,
    agentKind: 'claude-code',
    cwd: '/repo',
    title: id,
    status: 'live',
    controllerId: null,
    geometry: { cols: 80, rows: 24 },
    epoch: 0,
    clientCount: 0,
    createdAt: '2026-07-06T12:00:00.000Z',
    lastActiveAt: '2026-07-06T12:00:00.000Z',
    origin: { kind: 'spawn' },
    archived: false,
    issueId,
    busy: false,
    readAt: null,
    unread: false,
    agentState:
      phase === 'working'
        ? { phase: 'working', since: '2026-07-06T12:00:00.000Z', nativeSubagentCount: 0 }
        : { phase: 'idle', idle: { kind: 'done' } },
  }
}

function issue(id: string, title: string) {
  return {
    id,
    repoPath: '/repo',
    seq: 1,
    title,
    description: '',
    stage: 'in_progress',
    worktreePath: null,
    branch: null,
    parentBranch: 'main',
    defaultAgent: 'claude-code',
    blockedBy: [],
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-20T00:00:00.000Z',
    archived: false,
    needsHuman: false,
    sessions: [],
    sessionSummary: { total: 0, byPhase: {} },
    origin: 'human',
    audience: 'human',
    draft: false,
    childCount: 0,
    childDoneCount: 0,
    priority: 2,
    type: 'task',
    pinned: false,
    labels: [],
    deps: [],
    dependents: [],
    comments: [],
    ready: true,
    blocked: false,
    deferred: false,
    readAt: null,
    unread: false,
  }
}

/** Bumped by each simulated publish so every snapshot is a fresh object graph
 *  with identical slice-relevant content — exactly what a store publish looks
 *  like to a consumer that memoizes on identity. */
let publishNonce = 0

function storeSnapshot() {
  void publishNonce
  return {
    uiState: { get: () => null, set: vi.fn() },
    repos: [{ path: '/repo', kind: 'repository', branch: 'main', worktrees: [] }],
    sessions: [
      sess('s-a', 'i-a', 'working'),
      sess('s-b', 'i-b', 'idle'),
      sess('s-c', 'i-c', 'idle'),
    ],
    machines: [],
    pins: { panels: [], worktrees: [], repos: [] },
    setPinned: vi.fn(),
    issues: [issue('i-a', 'Alpha'), issue('i-b', 'Bravo'), issue('i-c', 'Charlie')],
    trpc: {
      settings: {
        get: { query: vi.fn(async () => ({ sessionDefaults: { agent: 'claude-code' } })) },
      },
      issues: { defer: { mutate: vi.fn(async () => ({})) } },
    },
    selectedWorktree: null,
    setSelectedWorktree: vi.fn(),
    selectedIssueId: null,
    setSelectedIssueId: vi.fn(),
    setOpenIssueId: vi.fn(),
    paneA: null,
    setPane: vi.fn(),
    fileTabs: [],
    view: 'workspace',
    setView: vi.fn(),
    sidebarSettings: { groupByRepo: false },
    setSidebarSettings: vi.fn(),
    spawnDraftAgent: vi.fn(),
    markIssueRead: vi.fn(async () => {}),
    markIssueUnread: vi.fn(async () => {}),
    markSessionRead: vi.fn(async () => {}),
    markSessionUnread: vi.fn(async () => {}),
  }
}

vi.mock('@/app/store', () => {
  const useStore = () => storeSnapshot()
  return {
    useStore,
    useReplicaIssues: () => (useStore() as unknown as { issues?: unknown[] }).issues ?? [],
    useStoreSelector: (sel: (s: unknown) => unknown) => sel(useStore() as never),
  }
})
vi.mock('@/features/machines/HostIndicators', () => ({ HostIndicators: () => null }))
vi.mock('@/lib/hooks/use-session-guard', () => ({
  useSessionGuard: () => ({ guardedKill: vi.fn(), guardedArchive: vi.fn() }),
}))


/** How many publishes the probe drives. Enough that a per-publish regression is
 *  visible above mount noise, small enough to stay fast. */
const PUBLISHES = 5

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  publishNonce = 0
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('POD-330 render-count probe — worklist', () => {
  it('records commits and derivation executions per store publish', () => {
    let commits = 0
    // A FRESH element every time: re-rendering the same element object makes
    // React bail out before the component runs at all, which would make this
    // probe measure nothing and report zero — a green that means "never fired".
    const tree = (): JSX.Element => (
      <Profiler
        id="worklist"
        onRender={(_id, phase) => {
          if (phase !== 'mount') commits++
        }}
      >
        <SidebarUnified />
      </Profiler>
    )

    act(() => root.render(tree()))
    const atMount = { ...derivations }

    for (let i = 0; i < PUBLISHES; i++) {
      publishNonce++
      act(() => root.render(tree()))
    }

    // The probe must be able to say NO. If the derivations never ran, the
    // numbers below are meaningless and a passing assertion is a false green.
    expect(derivations.sidebarSections).toBeGreaterThan(atMount.sidebarSections)

    const perPublishCommits = commits / PUBLISHES
    const perPublishSections = (derivations.sidebarSections - atMount.sidebarSections) / PUBLISHES
    const perPublishWorkList = (derivations.unifiedWorkList - atMount.unifiedWorkList) / PUBLISHES

    // Printed on every run so the numbers are readable, not merely asserted.
    console.log(
      `[POD-330 worklist] per publish: commits=${perPublishCommits} ` +
        `sidebarSections=${perPublishSections} unifiedWorkList=${perPublishWorkList} ` +
        `(mount: sections=${atMount.sidebarSections} workList=${atMount.unifiedWorkList})`,
    )

    // BOUNDS RECORDED ON THE UNCUT TREE. The split must not raise them.
    expect(perPublishCommits).toBeLessThanOrEqual(BASELINE.worklist.commitsPerPublish)
    expect(perPublishSections).toBeLessThanOrEqual(BASELINE.worklist.sidebarSectionsPerPublish)
    expect(perPublishWorkList).toBeLessThanOrEqual(BASELINE.worklist.unifiedWorkListPerPublish)
  })
})

/**
 * Measured on the UNCUT tree at c3b8247e, before any of POD-330's changes.
 * These are CEILINGS, not targets: the slice split may lower them (that is the
 * point), and must never raise them.
 */
const BASELINE = {
  worklist: {
    /** Measured 2.2 on the uncut tree. */
    commitsPerPublish: 2.2,
    /** Measured 1 on the uncut tree — one execution per consuming component. */
    sidebarSectionsPerPublish: 1,
    /** Measured 1 on the uncut tree. */
    unifiedWorkListPerPublish: 1,
  },
} as const
