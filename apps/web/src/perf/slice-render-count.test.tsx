// @vitest-environment happy-dom
import { Profiler, act, type JSX } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CommandPalette } from '../app/CommandPalette'
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

/**
 * Real executions of the two worklist derivations, counted by wrapping the
 * barrel exports.
 *
 * WHAT THIS COUNTER CAN AND CANNOT SEE, and why there are now two of them.
 * Wrapping `@podium/client-core/viewmodels` catches a COMPONENT that calls
 * `sidebarSections` for itself, because components import it through the
 * barrel. It does NOT catch the published slice, which calls the same function
 * through a package-internal relative import — so once a surface is ported,
 * this counter goes to zero for that surface, and zero passes every ceiling.
 *
 * That is the "probe reports a flattering figure" shape POD-330 hit once
 * already, and it was caught here the same way: the can-say-NO guard
 * (`toBeGreaterThan`) failed rather than the ceiling passing. So the port did
 * not get to keep this counter's silence as evidence — it had to bring the
 * mechanism's OWN counter, below.
 */
const derivations = { sidebarSections: 0, unifiedWorkList: 0 }

/** The publisher's own derivation counts (`SliceDerivationCounts`), which
 *  `publish.ts` exposes for exactly this probe. Set by the store mock. */
const sliceCounts = vi.hoisted(() => ({
  read: (): Record<string, number> => ({}),
}))

/** How many times the published `worklist` slice actually derived. */
const worklistDerivations = (): number => sliceCounts.read().worklist ?? 0

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
    blockedByNotes: [],
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

/**
 * THE SNAPSHOT MUST BE STABLE BETWEEN PUBLISHES, or this probe measures a lie.
 *
 * The publisher's cache key is snapshot IDENTITY (`slices/publish.ts`). A
 * `storeSnapshot()` that minted a fresh object on every read — which is what
 * this file did while every consumer derived for itself — would miss the cache
 * on every single read, so the published slice would appear to derive once per
 * consumer per render and the port would measure as no improvement at all.
 *
 * The real store publishes ONE object per change and hands the same one to
 * every reader within that change. This mirrors that: a new object per
 * simulated publish, the same object for every read in between.
 */
let currentSnapshot: ReturnType<typeof buildSnapshot> | null = null
let builtForNonce = -1
function storeSnapshot() {
  if (currentSnapshot === null || builtForNonce !== publishNonce) {
    currentSnapshot = buildSnapshot()
    builtForNonce = publishNonce
  }
  return currentSnapshot
}

function buildSnapshot() {
  void publishNonce
  return {
    // The coarse clock (POD-331) is part of the snapshot, so a time-dependent
    // slice re-derives when time moves. Pinned here: this probe measures
    // derivations per PUBLISH, and a wall clock would add unrelated ticks.
    coarseNow: Date.parse('2026-07-06T12:00:00.000Z'),
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
    // --- CommandPalette (the SECOND consumer, see the two-consumer probe) ---
    paletteOpen: true,
    setPaletteOpen: vi.fn(),
    superOpen: false,
    setSuperOpen: vi.fn(),
    setSnooze: vi.fn(async () => {}),
    clearSnooze: vi.fn(async () => {}),
    hibernateSession: vi.fn(async () => {}),
    resurrectSession: vi.fn(async () => {}),
    startBtw: vi.fn(async () => {}),
  }
}

vi.mock('@/app/store', async () => {
  // THE REAL PUBLISHER, not a stand-in. A hand-written `useSlice` that just
  // called `def.derive(snapshot)` would count one derivation per consumer and
  // report the port as having changed nothing; a hand-written one that cached
  // forever would report a flattering zero. Using the shipped mechanism over
  // the mocked snapshot is what makes the number evidence about the mechanism.
  const { createSlicePublisher } =
    await vi.importActual<typeof import('@podium/client-core/viewmodels')>(
      '@podium/client-core/viewmodels',
    )
  const publisher = createSlicePublisher(() => storeSnapshot())
  sliceCounts.read = () => publisher.derivations() as Record<string, number>
  const useStore = () => storeSnapshot()
  return {
    useStore,
    useReplicaIssues: () => (useStore() as unknown as { issues?: unknown[] }).issues ?? [],
    useStoreSelector: (sel: (s: unknown) => unknown) => sel(useStore() as never),
    useSlice: (def: Parameters<typeof publisher.read>[0]) => publisher.read(def),
  }
})
vi.mock('@/features/machines/HostIndicators', () => ({ HostIndicators: () => null }))
vi.mock('@/lib/hooks/use-session-guard', () => ({
  useSessionGuard: () => ({ guardedKill: vi.fn(), guardedArchive: vi.fn() }),
}))
vi.mock('@/lib/use-feature', () => ({ useFeature: () => true }))


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
    const atMount = { ...derivations, worklist: worklistDerivations() }

    for (let i = 0; i < PUBLISHES; i++) {
      publishNonce++
      act(() => root.render(tree()))
    }

    // The probe must be able to say NO. If the derivation never ran, the
    // numbers below are meaningless and a passing assertion is a false green.
    // This now guards the PUBLISHED slice: the old barrel counter goes to zero
    // once a surface is ported (see `derivations` above), and zero is exactly
    // the reading that would sail past every ceiling.
    expect(worklistDerivations()).toBeGreaterThan(atMount.worklist)

    const perPublishCommits = commits / PUBLISHES
    const perPublishWorklist = (worklistDerivations() - atMount.worklist) / PUBLISHES
    const perPublishDirect = (derivations.sidebarSections - atMount.sidebarSections) / PUBLISHES

    // Printed on every run so the numbers are readable, not merely asserted.
    console.log(
      `[POD-330 worklist] per publish: commits=${perPublishCommits} ` +
        `worklistSlice=${perPublishWorklist} directSidebarSections=${perPublishDirect}`,
    )

    // BOUNDS RECORDED ON THE UNCUT TREE. The split must not raise them.
    expect(perPublishCommits).toBeLessThanOrEqual(BASELINE.worklist.commitsPerPublish)
    // One derivation per publish — and, since the slice calls `sidebarSections`
    // exactly once, this is the same quantity the uncut tree measured as 1.
    expect(perPublishWorklist).toBeLessThanOrEqual(BASELINE.worklist.sidebarSectionsPerPublish)
    // NOBODY DERIVES LOCALLY ANY MORE. This zero is only meaningful next to the
    // can-say-NO guard above, which proves the work still happens somewhere.
    expect(perPublishDirect).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// THE TWO-CONSUMER PROBE (POD-331).
//
// POD-330's map, §6.4, records why the single-consumer probe above cannot show
// the improvement it exists to measure:
//
//   "The probe renders SidebarUnified and nothing else, so it observes ONE
//    consumer. A published hook would move the number from 1-per-consumer to
//    1-per-change, but with one consumer those are the same number."
//
// So the gain is only observable with a SECOND, INDEPENDENT consumer of the
// same derivation. `CommandPalette` is that consumer in the real app — it calls
// `sidebarSections` itself (via `@/lib/derive`, which `export *`s the module
// this file wraps), and it can be open while the sidebar is mounted.
//
// This test is deliberately landed BEFORE the port and its ceiling recorded on
// the UNPORTED tree, so the before/after is a measured pair rather than a
// remembered one.
// ---------------------------------------------------------------------------
describe('POD-331 render-count probe — worklist with a second consumer', () => {
  it('records derivation executions per publish across two independent consumers', () => {
    let commits = 0
    const tree = (): JSX.Element => (
      <Profiler
        id="worklist-two-consumer"
        onRender={(_id, phase) => {
          if (phase !== 'mount') commits++
        }}
      >
        <SidebarUnified />
        <CommandPalette />
      </Profiler>
    )

    act(() => root.render(tree()))
    const atMount = { ...derivations, worklist: worklistDerivations() }

    for (let i = 0; i < PUBLISHES; i++) {
      publishNonce++
      act(() => root.render(tree()))
    }

    // Same can-say-NO guard as above: numbers from a derivation that never ran
    // are not a measurement, and zero passes every ceiling.
    expect(worklistDerivations()).toBeGreaterThan(atMount.worklist)

    const perPublishCommits = commits / PUBLISHES
    const perPublishWorklist = (worklistDerivations() - atMount.worklist) / PUBLISHES
    const perPublishDirect = (derivations.sidebarSections - atMount.sidebarSections) / PUBLISHES

    console.log(
      `[POD-331 two-consumer] per publish: commits=${perPublishCommits} ` +
        `worklistSlice=${perPublishWorklist} directSidebarSections=${perPublishDirect}`,
    )

    // THE WHOLE POINT: two independent consumers, ONE derivation per publish.
    // The unported tree measured 2 here (see BASELINE.twoConsumer).
    expect(perPublishWorklist).toBeLessThanOrEqual(1)
    expect(perPublishDirect).toBe(0)
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
  /**
   * MEASURED ON THE UNPORTED TREE at 5409a3ac, with SidebarUnified and
   * CommandPalette both mounted:
   *
   *   [POD-331 two-consumer] per publish: commits=3 sidebarSections=2 unifiedWorkList=1
   *
   * `sidebarSections=2` against the single-consumer probe's 1 is the
   * per-CONSUMER cost the published slice exists to remove — the second
   * consumer bought a second execution of the identical derivation. This is a
   * CEILING: the port must bring it to 1 and may never raise it.
   *
   * `unifiedWorkList` stays 1 because CommandPalette does not call it — only
   * `sidebarSections` has two consumers here, which is exactly why the pair of
   * numbers is reported rather than one.
   */
  twoConsumer: {
    sidebarSectionsPerPublish: 2,
    unifiedWorkListPerPublish: 1,
  },
} as const
