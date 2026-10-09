import { omitGone } from '@podium/client-graph/lookup'
import { worklistView } from '@podium/client-graph/worklist/view-model'
import { worklistRowStatus } from '../../../../apps/mobile/src/lib/work-sections'
import { sidebarComparable } from '../../diagnostics/oracle'
import { MobileTasksBoard } from '@podium/client-graph/mobile-tasks'
import { createCommandPalette } from '@podium/client-graph/command-launch-views'
import { createLaunchCatalogPicker, createLaunchWorkPicker } from '@podium/client-graph/launch-option-views'
import { createReferencePicker } from '@podium/client-graph/chat-context'
import { sidebarView } from '@podium/client-graph/worklist/sidebar'
import { poolIssuePaint } from '../../../../apps/web/src/features/worklist/pool-row-data'
import { effectiveIssueColorHex } from '../../../../apps/web/src/lib/issueColors'
import { isComplexFlightDeckMission } from '../../../../apps/web/src/app/flight-deck-display'
import { mobileWorkView } from '@podium/client-graph/worklist/mobile'
import { headerView } from '@podium/client-graph/header-views'
import { launchOptionViews } from '@podium/client-graph/launch-option-views'
import { sessionPaneView } from '@podium/client-graph/session-pane'
import { settingsView } from '@podium/client-graph/settings-views'
import { referenceView } from '@podium/client-graph/issue-reference'
import { referenceState } from '../../diagnostics/reference-state'
/** All app-wide pool readers, retained as their consumers retain them. No timers or walls are judged. */

import { AUTOMATION_ENTITIES } from '@podium/client-graph/automation-schema'
import { AutomationSource } from '@podium/client-graph/automation-source'
import { automationViews } from '@podium/client-graph/automation-views'
import { createChatContextReader } from '@podium/client-graph/chat-context'
import {
  CHAT_CONTEXT_ENTITIES,
  CHAT_CONTEXT_SUMMARIES,
} from '@podium/client-graph/chat-context-schema'
import { ChatContextSource } from '@podium/client-graph/chat-context-source'
import { COMMAND_SUMMARIES } from '@podium/client-graph/command-launch-schema'
import { attachCommandLaunchSource } from '@podium/client-graph/command-launch-source'
import {
  ISSUE_BOARD_ENTITIES,
  ISSUE_BOARD_SUMMARIES,
} from '@podium/client-graph/issue-board-schema'
import { boardCards } from '@podium/client-graph/issue-board-cards'
import { createIssueBoardSource } from '@podium/client-graph/issue-board-source'
import { readBoardCatalog } from '@podium/client-graph/issue-board-readers'
import { issuePages } from '@podium/client-graph/issue-page'
import { ISSUE_PAGE_SUMMARIES } from '@podium/client-graph/issue-page-schema'
import { attachIssuePageSource } from '@podium/client-graph/issue-page-source'
import {
  missionView,
  readMissionActionInputs,
} from '@podium/client-graph/mission-view'
import { MISSION_VIEW_SUMMARIES } from '@podium/client-graph/mission-view-schema'
import {
  MOBILE_INBOX_ENTITIES,
  MOBILE_INBOX_SUMMARIES,
} from '@podium/client-graph/mobile-inbox-schema'
import { MobileInboxSource } from '@podium/client-graph/mobile-inbox-source'
import { createMobileInboxViews } from '@podium/client-graph/mobile-inbox-views'
import { createMobileSessionReader } from '@podium/client-graph/mobile-session-context'
import { MOBILE_SESSION_SUMMARIES } from '@podium/client-graph/mobile-session-schema'
import {
  createMobileSettingsSource,
  MOBILE_SETTINGS_ENTITIES,
} from '@podium/client-graph/mobile-settings'
import { NOTICE_ENTITIES, NOTICE_SUMMARIES } from '@podium/client-graph/notice-schema'
import { NoticeSource } from '@podium/client-graph/notice-source'
import {
  noticeContinuity,
  noticeInteractions,
  noticeMessages,
  noticeRecovery,
} from '@podium/client-graph/notice-views'
import {
  createPoolProjection,
  createRuntimeWorklistPool,
  samePoolProjection,
} from '@podium/client-graph/runtime-pool'
import {
  SESSION_PANE_ENTITIES,
  SESSION_PANE_SUMMARIES,
} from '@podium/client-graph/session-pane-schema'
import { SessionPaneSource } from '@podium/client-graph/session-pane-source'
import { SHELL_ENTITIES, SHELL_SUMMARIES } from '@podium/client-graph/shell-schema'
import { ShellSource } from '@podium/client-graph/shell-source'
import { shellViews } from '@podium/client-graph/shell-views'
import { mergePoolSummaries } from '@podium/client-graph/source-registry'
import {
  createSuperagentSource,
  SUPERAGENT_ENTITIES,
  SUPERAGENT_SUMMARIES,
  superagentCursor,
  superagentFeed,
  superagentFocus,
  superagentQuestion,
  superagentState,
} from '@podium/client-graph/superagent'
import { workflowMachines, workflowSubject } from '@podium/client-graph/workflow-views'
import { LOADING } from '@podium/client-graph/worklist/rollup'
import { asIssueId, asSessionId, DEFAULT_HARNESS_AGENT, isFinished } from '@podium/model/browser'
import type { WorkflowRunWire } from '@podium/protocol'
import { autorun, compareStructural, observable, runInAction } from 'mobx'
import { resolvePoolWorkMenu as readPoolWorkMenu } from '../../../../apps/mobile/src/lib/pool-work-menu'
import {
  MobileSearchSections,
  mobileRowPaint,
  searchMobileSections,
} from '../../../../apps/mobile/src/lib/work-sections'
import {
  readFiles,
  readLaunchOrigin,
  readTargetMachines,
  readOpen,
  readPalette,
} from '../../../../apps/web/src/app/command-launch-readers'
import { missionPaneReader } from './mission-pane'
import { missionRootId } from '@podium/client-graph/mission-screen'
import {
  coordinatorsOf,
  fieldOf,
  hasAnyTaskOf,
  issueOf,
  onScreenOf,
  rootOf,
} from '../../../../apps/web/src/app/workspace-mission-reads'
import { createPoolNavigationProvider } from '../../../../apps/web/src/app/pool-navigation-provider'
import {
  type FixtureScale,
  type ScenarioEngine,
  startScenarioEngine,
  upsert,
  upsertIssue,
} from '../../shared/src/scenarios'
import { type AsyncLedger, installAsyncLedger } from './async-ledger'
import { FIXED_NOW } from './fixture/corpus'
import { SCREEN_ACTIONS, type ScreenAction, type ScreenWorkCell } from './screen-work-ratios'
import { insideReader, measureWork } from './work-meter'

const ROOT = 'guard-root',
  CHILD = 'guard-child',
  NEXT = 'guard-next'
const SESSION = 'guard-seat',
  OTHER_SESSION = 'guard-other-seat'
const layout = { pinnedRepos: [], pinnedWorktrees: [], projectOrder: [] }

export interface ScreenReader {
  name: string
  /** Product consumers/entry points: the coverage inventory is part of the report. */
  consumers: readonly string[]
  read(): unknown
}
export interface ScreenWorkRun {
  scale: FixtureScale
  corpus: { issues: number; sessions: number }
  readers: { name: string; consumers: readonly string[] }[]
  cells: ScreenWorkCell[]
}

/** The drawn neighbourhood is fixed; unrelated rows and closed mission history grow ×4.
 * Use real normalized kernel rows and the real row-source pipeline, never a second pool index. */
function seedNeighbourhood(ctx: ScenarioEngine, scale: FixtureScale): string {
  const row = referenceState(ctx.engine).issueProjections.find(
    (issue) => !issue.archived && !issue.deletedAt,
  )!
  for (const [id, parentId] of [
    [ROOT, null],
    [CHILD, ROOT],
    [NEXT, ROOT],
  ] as const) {
    upsertIssue(ctx, id, {
      ...row,
      id,
      seq: id === ROOT ? 999999 : id === CHILD ? 999998 : 999997,
      title: id,
      // Search-gram work belongs to the visible input, which must be identical
      // at both scales rather than inherit a different corpus row's body.
      description: { value: 'Guard body' },
      parentId,
      stage: 'planning',
      archived: false,
      deletedAt: null,
      closedAt: null,
      closedReason: null,
      deps: [],
      audience: 'human',
      // The corpus's first issue/phase seat differ between 1x and 4x. Their
      // inherited nesting, optional paint fields and execution state cannot
      // be the addressed neighbourhood: keep these facts fixed as well.
      worktreePath: null,
      startedBySession: null,
      isDraftVessel: false,
      intentOrigin: 'human',
      needsHuman: false,
      asked: false,
      branch: null,
      supersededBy: null,
      duplicateOf: null,
      deferUntil: null,
      color: null,
      linearIdentifier: null,
      updatedAt: ctx.stamp(),
    })
  }
  const seat = ctx.cache.read('session', ctx.targets.phaseSessionId)!.value as Record<
    string,
    unknown
  >
  // The picked phase seat can belong to a different checkout at each scale.
  // Keep the displayed handoff source identical: otherwise the 1x menu can
  // be blocked while the 4x menu has destinations, despite a fixed neighbourhood.
  const guardSource = ctx.corpus.repos.find(
    (repo) => repo.machineId === ctx.corpus.machines[0]!.id && repo.worktrees.length > 0,
  )!.worktrees[0]!.path
  for (const [id, owner] of [
    [SESSION, ROOT],
    [OTHER_SESSION, CHILD],
  ] as const) {
    upsert(ctx, 'session', id, {
      ...seat,
      id,
      sessionId: id,
      resume: undefined,
      issueId: owner,
      cwd: guardSource,
      machineId: ctx.corpus.machines[0]!.id,
      archived: false,
      headless: false,
      status: 'live',
      // The guard seat runs the product default harness, as an identifier:
      // the flip below must toggle this seat's own kind (POD-5614).
      agentKind: DEFAULT_HARNESS_AGENT,
      agentState: { phase: 'working', since: ctx.stamp() },
      busy: false,
      offer: null,
      stoppedAt: null,
      stopReason: null,
      snoozedUntil: null,
      handoffTarget: null,
      lastInputAt: ctx.stamp(),
      draftUpdatedAt: null,
      unread: false,
      lastActiveAt: ctx.stamp(),
    })
  }
  // Closed historical sessions in the addressed mission expose full-history walks
  // without enlarging the visible roster or the click's addressed neighbourhood.
  const old = new Date(ctx.corpus.fixedNow - 90 * 86_400_000).toISOString()
  for (let index = 0; index < 32 * scale; index++) {
    const id = `guard-history-${index}`
    upsert(ctx, 'session', id, {
      ...seat,
      id,
      sessionId: id,
      resume: undefined,
      issueId: ROOT,
      archived: true,
      status: 'exited',
      headless: false,
      lastActiveAt: old,
      finishedAt: old,
      createdAt: old,
      refRepoId: row.repoId,
      refSeq: index === 32 * scale - 1 ? 999999 : 1000000 + index,
      refLetter: 'Z',
    })
  }
  referenceState(ctx.engine).setSelectedIssueId(asIssueId(ROOT))
  const repo = ctx.cache.read('repo', row.repoId!)!.value as { prefix: string }
  return `${repo.prefix}-999999-Z`
}

async function drain(pool: ReturnType<typeof createRuntimeWorklistPool>['pool']): Promise<void> {
  // Flush the existing coalesced load window, including loads first demanded by
  // an event handler. Do not sleep for its wall-clock deadline or count the oracle.
  for (let turn = 0; turn < 16; turn++) {
    await Promise.resolve()
    pool.hydrate()
  }
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  pool.hydrate()
}

function assertObservedParity(
  readers: readonly ScreenReader[],
  values: ReadonlyMap<string, unknown>,
): void {
  for (const reader of readers) {
    let direct: unknown, failure: unknown
    // A fresh consumer has the app's tracking context. Reading outside a
    // reaction bypasses the product's cachedGroup helpers and measures a
    // different path, needlessly rebuilding every catalogue for the oracle.
    const stop = autorun(() => {
      try {
        direct = reader.read()
      } catch (cause) {
        failure = cause
      }
    })
    stop()
    if (failure !== undefined) throw failure
    if (!compareStructural(values.get(reader.name), direct)) {
      throw new Error(`Observed/direct parity failed: ${reader.name}`)
    }
  }
}

export async function poolScreenCellsAt(
  scale: FixtureScale,
  onCell?: (cell: ScreenWorkCell) => void,
  /** Mount only these readers: a focused gate for one screen's fix. The
   * full diagnostic guard retains readers from every screen. */
  only?: ReadonlySet<string>,
  actions: readonly ScreenAction[] = SCREEN_ACTIONS,
  scene?: 'background-terminal',
): Promise<ScreenWorkRun> {
  // POD-5466: installed before the engine starts, so every timer the app
  // schedules, the startup ones included, is tagged and can be settled.
  const ledger = installAsyncLedger({ holdBeyondMs: SETTLE_MAX_DELAY_MS, startAt: FIXED_NOW })
  try {
    const ctx = await startScenarioEngine(scale, { ownRows: true })
    try {
      return await measureScreenCells(ctx, scale, ledger, onCell, only, actions, scene)
    } finally {
      ctx.engine.destroy()
    }
  } finally {
    ledger.dispose()
  }
}

/** A window owes every microtask and every timer up to this delay it scheduled. */
const SETTLE_MAX_DELAY_MS = 1_000
/** Virtual time between two scripted clicks (POD-5466). */
const CLICK_INTERVAL_MS = 5_000
/** Wall-clock bound on one settle; past it the meter fails rather than guess. */
const SETTLE_DEADLINE_MS = 30_000

async function measureScreenCells(
  ctx: ScenarioEngine,
  scale: FixtureScale,
  ledger: AsyncLedger,
  onCell?: (cell: ScreenWorkCell) => void,
  only?: ReadonlySet<string>,
  selectedActions: readonly ScreenAction[] = SCREEN_ACTIONS,
  scene?: 'background-terminal',
): Promise<ScreenWorkRun> {
  const progress = (message: string) => process.stdout.write(`[screen work] ${scale}x ${message}\n`)
  progress('kernel ready')
  const ref = seedNeighbourhood(ctx, scale)
  // POD-5501's fresh background recipe selects a fixed control mission and
  // opens its native terminal, then updates the first live corpus session.
  // The update is independent of the selected control's pane/mission.
  const heartbeatId =
    scene === 'background-terminal'
      ? ctx.corpus.sessions.find((session) => session.status === 'live')!.sessionId
      : SESSION
  if (scene === 'background-terminal') referenceState(ctx.engine).setPane('A', asSessionId(SESSION))
  // The real web host enables this before attaching a pilot-on pool.

  const handle = createRuntimeWorklistPool(ctx.engine, {
    header: true,
    settings: true,
    preferences: true,
    summaries: mergePoolSummaries(
      COMMAND_SUMMARIES,
      SHELL_SUMMARIES,
      ISSUE_PAGE_SUMMARIES,
      ISSUE_BOARD_SUMMARIES,
      CHAT_CONTEXT_SUMMARIES,
      NOTICE_SUMMARIES,
      SESSION_PANE_SUMMARIES,
      MISSION_VIEW_SUMMARIES,
      SUPERAGENT_SUMMARIES,
      MOBILE_INBOX_SUMMARIES,
      MOBILE_SESSION_SUMMARIES,
    ),
  })
  const pool = handle.pool
  const stops: (() => void)[] = []
  const values = new Map<string, unknown>()
  try {
    const commands = attachCommandLaunchSource(pool, ctx.engine)
    stops.push(() => commands.dispose(), attachIssuePageSource(pool, ctx.engine))
    pool.sources.register(SHELL_ENTITIES, new ShellSource(ctx.engine))
    pool.sources.register(NOTICE_ENTITIES, new NoticeSource(ctx.engine))
    pool.sources.register(SESSION_PANE_ENTITIES, new SessionPaneSource(ctx.engine))
    pool.sources.register(SUPERAGENT_ENTITIES, await createSuperagentSource(ctx.engine))
    pool.sources.register(AUTOMATION_ENTITIES, new AutomationSource(ctx.engine.replica))
    pool.sources.register(MOBILE_INBOX_ENTITIES, new MobileInboxSource(ctx.engine, pool))
    pool.sources.register(MOBILE_SETTINGS_ENTITIES, await createMobileSettingsSource(ctx.engine))
    // This app attachment shares the pane/notice/chat sources through ensure.
    // Register chat through its normal ensure key before the mobile attachment.
    await pool.sources.ensure(
      'chat-context',
      CHAT_CONTEXT_ENTITIES,
      () => new ChatContextSource(ctx.engine, pool),
    )
    // Pane and exit sources are attached below by the mobile seam; pane is already
    // installed above, so attach only the mobile reader/window with its factory.
    const { createMobileSessionSource } = await import(
      '@podium/client-graph/mobile-session-context'
    )
    const { MOBILE_SESSION_ENTITIES } = await import('@podium/client-graph/mobile-session-schema')
    pool.sources.register(MOBILE_SESSION_ENTITIES, createMobileSessionSource(ctx.engine, pool))
    const { createSessionExitSource } = await import('@podium/client-graph/session-exit-source')
    const { SESSION_EXIT_ENTITIES } = await import('@podium/client-graph/session-exit-schema')
    pool.sources.register(SESSION_EXIT_ENTITIES, await createSessionExitSource(ctx.engine))
    const board = createIssueBoardSource(pool, ctx.engine)
    pool.sources.register(ISSUE_BOARD_ENTITIES, board)
    const shell = shellViews(pool),
      page = issuePages(pool),
      chat = createChatContextReader(pool)
    const palettePicker = createCommandPalette(pool), catalogPicker = createLaunchCatalogPicker(pool), phonePicker = createLaunchWorkPicker(pool), referencePicker = createReferencePicker(pool)
    // These consumers represent open menus. The action owns their ordering,
    // outside any reaction; reopen is also exercised by the focused answer tests.
    palettePicker.open()
    catalogPicker.open()
    phonePicker.open()
    // The chat mention menu, as just after typing '@': a bounded source window.
    referencePicker.search('', 5)
    stops.push(() => palettePicker.close(), () => referencePicker.close())
    const panelOrigin = readLaunchOrigin(pool, '/repo-000')
    const panelPreferred = panelOrigin !== LOADING && panelOrigin.repo
      ? runInAction(() => readTargetMachines(pool, panelOrigin.repo, panelOrigin.machines, ['claude-code', 'codex'])) : {}
    const mobileInbox = createMobileInboxViews(pool),
      mobileSession = createMobileSessionReader(pool)
    stops.push(() => mobileInbox.dispose())
    const navigation = createPoolNavigationProvider(pool)
    ctx.engine.setNavigationProvider(navigation)
    const locals = () => {
      const state = referenceState(ctx.engine)
      return {
        selectedIssueId: state.selectedIssueId,
        paneA: state.paneA,
        paneB: state.paneB,
        split: state.split,
      }
    }
    const window = observable.box(locals(), { deep: false })
    stops.push(
      ctx.engine.onLocals(['selectedIssueId', 'paneA', 'paneB', 'split'], () => {
        const next = locals()
        if (!compareStructural(window.get(), next)) runInAction(() => window.set(next))
      }),
    )
    worklistView(pool).setLayout(layout)
    const selected = () => window.get().selectedIssueId ?? ROOT
    const readers: ScreenReader[] = []
    const add = (name: string, consumers: readonly string[], read: () => unknown) => {
      if (!only || only.has(name)) readers.push({ name, consumers, read })
    }
    add('sidebar.sections', ['PoolSidebar', 'PoolSidebarRail', 'useSidebarProjectSections'], () =>
      sidebarView(pool).sections(layout),
    )
    const worktree = pool.tables.worktree.keys().next().value!
    // Retain the actual painted fields in the watched read at both versions.
    // Serializing a wire issue would also observe menu/history-only fields;
    // retaining only a live companion's port would observe readiness alone.
    const rowAnswers = (value: unknown) => value === undefined || typeof value === 'symbol'
      ? value : JSON.parse(JSON.stringify(value))
    add('sidebar.row', ['PoolRowSlot', 'PoolSidebarRail'], () => {
      const row = sidebarView(pool).row(selected())
      return row === undefined || row === LOADING ? row : rowAnswers(poolIssuePaint(sidebarComparable(row) as never))
    })
    add('sidebar.worktree', ['PoolWorktreeRow', 'PoolSidebarRail'], () =>
      sidebarView(pool).worktree(worktree, layout),
    )
    add('sidebar.selection', ['PoolSidebar'], () => sidebarView(pool).selectionGone())
    add('mobile-work.sections', ['PoolWorkScreen', 'GroupHeader'], () =>
      { const view = mobileWorkView(pool).mobileSections(); return {
        sectionKeys: view.sectionKeys, orderingSectionKeys: view.orderingSectionKeys,
        issueCount: view.issueCount, pinnedCount: view.pinnedCount,
        attentionCount: view.attentionCount, pending: view.pending,
      } },
    )
    const search = new MobileSearchSections()
    add('mobile-work.search', ['PoolWorkScreen'], () =>
      searchMobileSections(pool, mobileWorkView(pool).mobileSections().sectionKeys, '', search),
    )
    add('mobile-work.row', ['PoolWorkRowSlot'], () => {
      const row = mobileWorkView(pool).mobileRow({ kind: 'issue', id: selected() })
      return row === undefined || row === LOADING ? row : rowAnswers({ id: row.id, title: row.title, timing: row.timing, working: row.visibleWorking, waiting: row.waitingCount, fleet: row.visibleFleet, ...('issue' in row ? { progress: row.progress, unread: row.emphasizeUnread, status: worklistRowStatus(row, pool.clock.trackedNow()), issue: sidebarComparable(row).issue } : {}) })
    })
    add('header.folded', ['FoldedFlightDeckBar'], () => headerView(pool).folded())
    add('header.shipping', ['useShippingCounts'], () => headerView(pool).shipping())
    add('header.fleet', ['FleetOverview'], () => ({
      aggregate: headerView(pool).aggregate(undefined),
      history: headerView(pool).history(),
      metrics: headerView(pool).metrics(),
      machines: headerView(pool).machines(),
      quotas: headerView(pool).quotas(),
      offline: headerView(pool).offlineMachines(),
      working: headerView(pool).working(),
      selected: headerView(pool).selectedIssue(),
      session: headerView(pool).session(SESSION),
      occupancy: headerView(pool).occupancyKey(),
    }))
    add('shell.chrome', ['AppBody', 'AppShell'], () => {
      const value = shell.chrome()
      if (!value || value === LOADING) return value
      // AppShell reads color scalars late from stable companions. Count those
      // watched reads too, and retain their answer rather than the live port.
      const { colorIssue, colorById, missionRoot, ...chrome } = value
      return { ...chrome, missionRootId: missionRoot?.id,
        missionExpanded: isComplexFlightDeckMission(missionRoot),
        color: effectiveIssueColorHex(colorIssue, colorById) }
    })
    // RightDock reads each routing field where a panel shows it.
    add('shell.dock', ['AppShell'], () => ({
      active: shell.dock.active,
      scope: shell.dock.scope,
      gitIssue: shell.dock.gitIssue,
      mailIssueId: shell.dock.mailIssueId,
    }))
    // These actions do not deliver URLs or open a browser target. The real
    // always-mounted hosts retain no catalog/row demand in that state. Their
    // addressed activation and pending-target guards run against the apps.
    add('shell.links', ['PodiumLinkHost'], () => undefined)
    add('shell.browserOpen', ['BrowserOpenOverlay'], () => undefined)
    add('shell.close', ['AppShell'], () => shell.close())
    add('shell.catalogs', ['AppShell'], () => ({
      machines: shell.machines(),
      repos: shell.repositories(),
      approvals: shell.approvals(),
      files: shell.files(),
      lanes: shell.lanes(),
      shipping: shell.dock.shipping,
    }))
    launchOptionViews(pool)
    add('launcher.launch', ['NewIssueDialog'], () =>
      // NewIssueDialog mounts only when opened. The fresh
      // background terminal recipe has triggers, with no launch catalog demand.
      scene === 'background-terminal' ? undefined : {
        catalog: catalogPicker.catalog(),
        origin: readLaunchOrigin(pool, '/repo-000'),
      },
    )
    add('launcher.panel', ['NewPanelMenu'], () => {
      if (scene === 'background-terminal') return undefined
      const origin = readLaunchOrigin(pool, '/repo-000')
      if (origin === LOADING) return origin
      return { ...origin, targets: origin.repo
        ? readTargetMachines(pool, origin.repo, origin.machines, ['claude-code', 'codex'], panelPreferred) : {} }
    })
    add('launcher.phone', ['NewWorkButton', 'NewIssueScreen'], () =>
      scene === 'background-terminal' ? undefined : {
        work: phonePicker.newWork(),
        paths: phonePicker.repositoryPaths,
      },
    )
    add('launcher.palette', ['CommandPalette'], () => palettePicker.palette())
    // Close facts are asked for the action's issue at press time. Closed
    // launch controls have no guard roster projection.
    add('launcher.guard', ['CommandPalette', 'NewPanelMenu', 'NewWorkButton'], () => undefined)
    add('launcher.window', ['CommandPaletteBoundary', 'CommandPalette'], () => ({
      open: readOpen(pool),
      files: readFiles(pool),
    }))
    const missionPane = missionPaneReader(pool)
    stops.push(() => missionPane.dispose())
    add('mission.pane', ['PoolFlightDeck', 'MissionDeck'], () =>
      missionPane.read({
        ...window.get(),
        mode: 'full',
        handoff: scene !== 'background-terminal',
      }),
    )
    add('mission.workspace', ['Workspace', 'FoldedFlightDeckBar'], () => {
      const id = selected()
      const issueId = issueOf(pool, id, id)
      const root = missionRootId(pool, id)
      const folded = typeof root === 'string' ? missionPane.open(root) : undefined
      return {
        root: rootOf(pool, id),
        issueId,
        worktreePath: typeof issueId === 'string' ? fieldOf(pool, issueId, 'worktreePath') : null,
        repoPath: typeof issueId === 'string' ? fieldOf(pool, issueId, 'repoPath') : null,
        coordinators: coordinatorsOf(pool, id),
        onScreen: onScreenOf(pool, id),
        hasAnyTask: hasAnyTaskOf(pool),
        folded: folded?.ready
          ? { progress: folded.progress, live: folded.liveCount, working: folded.workingCount, needs: folded.needsCount }
          : LOADING,
      }
    })
    add('mission.menu', ['PoolIssueContextMenu', 'PoolSessionContextMenu'], () =>
      readMissionActionInputs(missionView(pool), [selected()]),
    )
    add('mission.session-menu', ['PoolSessionContextMenu'], () =>
      readMissionActionInputs(missionView(pool), [], SESSION),
    )
    add('navigation.activity', ['ClientRuntime navigation watch'], () =>
      navigation.activityAt(ROOT),
    )
    add('navigation.ref', ['navigateToSession', 'PodiumLinkHost'], () => navigation.session(ref))
    add('navigation.mission', ['ClientRuntime navigation watch'], () => ({
      root: navigation.missionRoot(selected()),
      members: navigation.missionMembers(ROOT),
      readAt: navigation.issueReadAt(selected()),
    }))
    // Exercise the fields read by the mounted sections, rather than replacing
    // the retired bundle with a trivial identity-only consumer. Closed Details,
    // completed and retired folds deliberately own no payload demand.
    const detail = (mode: 'page' | 'panel' | 'phone' | 'inspector') => {
      const issue =
        mode === 'panel'
          ? page.panelIssue({ issueId: selected(), cwd: '/synthetic' })
          : page.issue(selected())
      if (!issue || issue === LOADING) return issue
      const row = page.row(issue.id),
        children = row.children
      const crew =
        mode === 'phone'
          ? row.phoneSessions
          : mode === 'inspector'
            ? row.inspectorSessions
            : mode === 'panel'
              ? row.dockActiveSessions
              : row.activeSessions
      if (children === LOADING || crew === LOADING) return LOADING
      const parent = issue.parentId ? pool.issueObject(issue.parentId) : undefined
      return {
        id: issue.id,
        title: row.title,
        description: issue.description,
        ref: issue.displayRef,
        stage: issue.stage,
        ready: issue.ready,
        parent: parent?.authoredTitle,
        childCount: issue.childCount,
        childDoneCount: issue.childDoneCount,
        children: children
          ?.filter((child) => mode !== 'panel' || !isFinished(child))
          .map((child) => ({
            id: child.id,
            title: child.authoredTitle,
            ref: child.displayRef,
            stage: child.stage,
            workers: child.confirmedWorkingAgents,
          })),
        crew: crew?.map((session) => ({
          id: session.sessionId,
          title: session.title,
          name: session.name,
          asking: session.asking,
          motion: session.motion,
        })),
        memberCount: issue.memberCount,
        retiredCount: mode === 'panel' ? row.retiredCount : undefined,
        presence: mode === 'panel' && !crew?.length ? row.presence : undefined,
        relations: issue.relationGroups,
      }
    }
    add('issue-page.detail',
      ['IssuePage', 'IssueTitle', 'IssueDescription', 'IssueSubIssues', 'IssueNow'],
      () => detail('page'),
    )
    add('issue-page.panel', ['IssuePanel', 'RecentActivity model owner'], () => detail('panel'))
    add('issue-page.phone', ['IssueScreen', 'PhoneNow', 'PhoneProperties closed'], () =>
      detail('phone'),
    )
    add('issue-page.inspector', ['TaskSheet', 'SessionConversation peek'], () =>
      detail('inspector'),
    )
    add('issue-page.catalog', ['IssueContextMenu', 'IssueExplorer'], () => ({
      issues: page.issues(),
      explorer: page.explorer(),
    }))
    // These clicks open the launcher palette, not the Tasks filter menu.
    add('board.catalog', ['useBoardCatalog', 'IssueBoard'], () =>
      readBoardCatalog(pool, false, false),
    )
    const phoneTasks = new MobileTasksBoard(pool, {
      showDone: false,
      expanded: [],
      filter: { text: 'guard-' },
      ordering: 'priority',
      showAgentTasks: false,
    })
    add('phone-tasks.sections', ['IssuesScreen', 'StageSections'], () => phoneTasks.sections)
    add('phone-tasks.proposals', ['ProposalsBanner'], () => phoneTasks.proposals)
    add('phone-tasks.row', ['TaskRow'], () => {
      const issue = phoneTasks.issue(ROOT)
      return {
        title: issue.title,
        stage: issue.stage,
        working: issue.confirmedWorkingAgents,
        progress: issue.taskProgress,
        dependents: issue.dependents,
      }
    })
    add('board.query', ['IssueBoard', 'IssueExplorer'], () =>
      board.queryIds({ kind: 'board', showAgentTasks: false }),
    )
    // A mounted desktop card reads the shared issue model and its board rule.
    add('board.card', ['PoolBoardCard'], () => {
      const cards = boardCards(pool), issue = cards.issue(selected())
      return {
        title: issue.title,
        stage: issue.stage,
        unread: issue.unread,
        working: issue.confirmedWorkingAgents,
        progress: issue.taskProgress,
        dependents: issue.dependents,
        fleet: issue.presentMembers,
        stages: cards.card(issue, false).stageCounts,
        word: cards.explorerRow(issue).state,
      }
    })
    add('board.model', ['IssueBoard', 'useBoardData'], () =>
      omitGone(pool.row(
        'issueBoardModel',
        JSON.stringify({
          display: { layout: 'board', ordering: 'priority', showAgentTasks: false },
          filter: {},
          expanded: [],
          isMobile: false,
          openIssueId: selected(),
          now: 0,
          windowed: true,
        }),
      )),
    )
    add('board.explorer', ['IssueExplorer'], () =>
      omitGone(pool.row('issueExplorerModel', JSON.stringify({ tab: null, query: '', windowed: true }))),
    )
    add('chat.detail', ['SessionConversation', 'AgentPanel'], () => ({
      issue: chat.issue(selected()),
      interactions: chat.interactions( SESSION),
      records: chat.records(SESSION),
      artifact: chat.artifactIssue({ sessionId: asSessionId(SESSION), issueId: asIssueId(ROOT) }),
      threads: chat.threads(),
    }))
    add('chat.references', ['RichMarkdown', 'RefMiniview'], () => ({
      issueIds: referencePicker.issueIds,
      machines: chat.machines(),
      repos: chat.repositoryKey(),
    }))
    add('notices', ['MessageNotices', 'Notices'], () => ({
      messages: noticeMessages(pool),
      interactions: noticeInteractions(pool, SESSION),
      recovery: noticeRecovery(pool),
      continuity: noticeContinuity(pool),
    }))
    add('session-pane', ['AgentPanel', 'DockTerminal'], () => {
      const panes = sessionPaneView(pool),
        mapped = panes.window().dockShells['/synthetic']
      return {
        session: panes.session(SESSION),
        machines: panes.machines(),
        window: panes.window(),
        dock: { mapped, present: !!panes.loaded(mapped), hasSessions: panes.hasSessions() },
        confirmed: panes.spawnConfirmed(SESSION),
        ownership: {
          selectedIssueId: panes.selectedIssueId,
          stamp: panes.loaded(SESSION)?.stampIssue,
          issueHex: panes.issueHex((color) => color ?? undefined),
        },
      }
    })
    add('settings', ['SettingsView', 'SettingsScreen', 'NewIssueScreen', 'WorkflowForm'], () => ({
      setup: settingsView(pool).setup(['/synthetic']),
      count: settingsView(pool).sessionCount(),
      present: settingsView(pool).sessionPresent(SESSION),
    }))
    add('preferences', ['SettingsView', 'SettingsScreen', 'WorkScreen'], () =>
      omitGone(pool.row('preference', 'podium:sidebar:pinned-fold')),
    )
    add('references', ['IssueChipLiveness', 'RefChip', 'RefMiniview'], () => ({
      token: referenceView(pool).read('#999999'),
      id: referenceView(pool).id('#999999'),
      byId: referenceView(pool).readById(ROOT),
    }))
    const automations = automationViews(pool)
    add('automations', ['AutomationsView', 'SpecsView', 'AutomationForm'], () => ({
      list: automations.list(),
      targets: automations.targets(),
      session: automations.session(SESSION),
    }))
    const workflowRun: WorkflowRunWire = {
      id: 'guard-workflow-run',
      subjectKind: 'session',
      subjectId: SESSION,
      coordinatorSessionId: asSessionId(SESSION),
      status: 'active',
      supersedesRunId: null,
      revision: {
        id: 'guard-revision',
        workflowId: 'guard-workflow',
        version: 1,
        instructions: '',
        steps: [],
        createdAt: new Date(ctx.corpus.fixedNow).toISOString(),
        publishedAt: null,
      },
      steps: [],
      history: [],
      startedAt: new Date(ctx.corpus.fixedNow).toISOString(),
      completedAt: null,
    }
    add('workflows', ['WorkflowsView', 'WorkflowForm', 'useWorkflowSubject'], () => ({
      machines: workflowMachines(pool),
      session: workflowSubject(pool, workflowRun),
      issue: workflowSubject(pool, { ...workflowRun, subjectKind: 'issue', subjectId: selected() }),
    }))
    add('superagent', ['SuperagentView', 'SuperagentScreen'], () => ({
      state: superagentState(pool),
      feed: superagentFeed(pool),
      focus: superagentFocus(pool),
      cursor: superagentCursor(pool),
      question: superagentQuestion(pool, asSessionId(SESSION)),
    }))
    add(
      'mobile-inbox',
      ['InboxScreen', 'SessionsScreen', 'ScreeningScreen', 'PodiumLinkHost'],
      () => ({
        inbox: {
          groups: mobileInbox.inbox().groups,
          booting: mobileInbox.inbox().booting,
          outboxSize: mobileInbox.inbox().outboxSize,
        },
        screening: { queue: mobileInbox.screening().queue, booting: mobileInbox.screening().booting },
        row: mobileInbox.issue(ROOT),
        ref: mobileInbox.session(ref),
        route: mobileInbox.route({ kind: 'issue', issue: '#999999', search: '', hash: '' }),
      }),
    )
    add('mobile-session', ['SessionScreen', 'TerminalScreen', 'SessionConversation'], () => ({
      session: mobileSession.session(SESSION),
      issue: mobileSession.issue(selected()),
      machines: mobileSession.machines(),
      pending: mobileSession.spawnPending(SESSION),
      prompt: mobileSession.spawnPrompt(SESSION),
      exit: mobileSession.exit(SESSION),
      conversation: mobileSession.conversation(SESSION),
      booting: mobileSession.booting(),
    }))
    add('mobile-settings', ['SettingsScreen'], () =>
      omitGone(pool.row('mobileSettingsDiagnostics', 'diagnostics')),
    )
    for (const reader of readers) {
      const projection = createPoolProjection(pool, () => insideReader(reader.name, reader.read), {
        name: `consumer:${reader.name}`,
        equals: (before, next) =>
          insideReader(`${reader.name}.compare`, () => samePoolProjection(before, next)),
      })
      const paint = () => values.set(reader.name, projection.getSnapshot())
      paint()
      stops.push(projection.subscribe(paint))
    }
    progress('readers mounted')
    await drain(pool)
    await ledger.settle(null, {
      maxDelayMs: SETTLE_MAX_DELAY_MS,
      deadlineMs: SETTLE_DEADLINE_MS,
      poll: () => pool.hydrate(),
    })
    assertObservedParity(readers, values)
    progress(`${readers.length} reader projections settled`)
    // The neighbourhood is declared from the actual rows drawn by this probe,
    // not all members/history of the selected mission. It is inspected per step.
    function neighbourhood(): string[] {
      const keys = [ROOT, CHILD, NEXT]
        .filter((id) => ctx.cache.read('issueProjection', id) !== undefined)
        .map((id) => `issue:${id}`)
      if (pool.tables.worktree.has(worktree)) keys.push(`worktree:${worktree}`)
      for (const id of [SESSION, OTHER_SESSION])
        if (ctx.cache.read('session', id)) keys.push(`session:${id}`)
      if (scene === 'background-terminal' && !keys.includes(`session:${heartbeatId}`))
        keys.push(`session:${heartbeatId}`)
      const state = window.get()
      for (const id of [state.paneA, state.split ? state.paneB : null]) {
        if (id && ctx.cache.read('session', id) && !keys.includes(`session:${id}`))
          keys.push(`session:${id}`)
      }
      return keys
    }
    const issuePatch = (patch: Record<string, unknown>) =>
      upsertIssue(
        ctx,
        ROOT,
        { ...(ctx.cache.read('issueProjection', ROOT)!.value as object), ...patch },
        3,
      )
    const seatPatch = (patch: Record<string, unknown>) =>
      upsert(
        ctx,
        'session',
        SESSION,
        { ...(ctx.cache.read('session', SESSION)!.value as object), ...patch },
        3,
      )
    let pressed: ReturnType<typeof readPoolWorkMenu>
    const actions: Record<ScreenAction, () => void | Promise<unknown>> = {
      select: () => referenceState(ctx.engine).setSelectedIssueId(asIssueId(CHILD)),
      'stage-change': () =>
        referenceState(ctx.engine).updateIssue(asIssueId(ROOT), { stage: 'in_progress' }),
      'pane-switch': () => referenceState(ctx.engine).setPane('A', asSessionId(SESSION)),
      'open-menu': () => {
        referenceState(ctx.engine).setPaletteOpen(true)
        insideReader('launcher.open-menu', () => palettePicker.palette())
      },
      'long-press': () => {
        pressed = insideReader('mobile-work.long-press', () => readPoolWorkMenu(pool, ROOT))
      },
      'navigate-by-ref': () => {
        insideReader('navigation.navigate-by-ref', () =>
          referenceState(ctx.engine).navigateToSession(asSessionId(ref)),
        )
      },
      heartbeat: () =>
        upsert(
          ctx,
          'session',
          heartbeatId,
          {
            ...(ctx.cache.read('session', heartbeatId)!.value as object),
            lastActiveAt: ctx.stamp(),
          },
          3,
        ),
      'machine-flip': () => {
        const id = ctx.corpus.machines[0]!.id
        const machine = ctx.cache.read('machine', id)!.value as { loggedOutHarnesses: string[] }
        // Toggle the guard seat's own kind, as identifiers: branching on a
        // quoted harness literal here is vendor behaviour (POD-5614).
        const loggedOutHarnesses = machine.loggedOutHarnesses.includes(DEFAULT_HARNESS_AGENT)
          ? machine.loggedOutHarnesses.filter((kind) => kind !== DEFAULT_HARNESS_AGENT)
          : [...machine.loggedOutHarnesses, DEFAULT_HARNESS_AGENT]
        upsert(ctx, 'machine', id, { ...machine, loggedOutHarnesses }, 3)
      },
      'lane-change': () => issuePatch({ stage: 'review', updatedAt: ctx.stamp() }),
    }
    const cells: ScreenWorkCell[] = []
    const proveAction = (action: ScreenAction) => {
      const state = referenceState(ctx.engine)
      const issue = omitGone(pool.row('issue', ROOT))
      const sessionId = action === 'heartbeat' ? heartbeatId : SESSION
      const session = omitGone(pool.row('session', sessionId))
      if (action === 'select' && state.selectedIssueId !== CHILD)
        throw new Error('Selection click did not select its row')
      if (action === 'pane-switch' && state.paneA !== SESSION)
        throw new Error('Pane switch did not open its session')
      if (action === 'open-menu' && !state.paletteOpen)
        throw new Error('Menu click did not open the palette')
      if (action === 'long-press' && pressed?.target.issue.id !== ROOT)
        throw new Error('Long press did not resolve its pressed row')
      if (action === 'navigate-by-ref' && state.paneA !== `guard-history-${32 * scale - 1}`)
        throw new Error('Birth-ref navigation did not open its target')
      if (action === 'stage-change' || action === 'lane-change') {
        const wanted = action === 'stage-change' ? 'in_progress' : 'review'
        if (!issue || issue === LOADING || Reflect.get(issue, 'stage') !== wanted)
          throw new Error(`${action} did not change its row`)
      }
      if (
        action === 'heartbeat' &&
        (!session ||
          session === LOADING ||
          Reflect.get(session, 'lastActiveAt') !==
            Reflect.get(ctx.cache.read('session', sessionId)!.value as object, 'lastActiveAt'))
      )
        throw new Error('Heartbeat did not reach its session')
      if (action === 'machine-flip') {
        const machine = ctx.cache.read('machine', ctx.corpus.machines[0]!.id)!.value as {
          loggedOutHarnesses: string[]
        }
        const wanted = machine.loggedOutHarnesses.includes(DEFAULT_HARNESS_AGENT)
          ? 'logged-out'
          : undefined
        if (!session || session === LOADING || Reflect.get(session, 'condition') !== wanted)
          throw new Error('Machine flip did not reach its joined session')
      }
    }
    for (const action of selectedActions) {
      const before = neighbourhood()
      const tag = `${scale}x ${action}`
      const settle = (owner: string | null) =>
        ledger.settle(owner, {
          maxDelayMs: SETTLE_MAX_DELAY_MS,
          deadlineMs: SETTLE_DEADLINE_MS,
          poll: () => pool.hydrate(),
        })
      // Nothing scheduled before this window may still be due inside it.
      await settle(null)
      ledger.takeForeign()
      // Clicks are seconds apart on the virtual clock, the same every run, so
      // a time-throttled reaction behaves the same however slow the host is.
      ledger.advance(CLICK_INTERVAL_MS)
      ledger.open(tag)
      let counted: Awaited<ReturnType<typeof measureWork>>
      try {
        counted = await measureWork(
          async () => {
            await actions[action]()
            await drain(pool)
            // The window closes only once the work this action deferred has run.
            await settle(tag)
          },
          { pool },
        )
      } finally {
        ledger.close()
      }
      const foreign = ledger.takeForeign()
      // Work charged to the wrong window makes the count meaningless: refuse it.
      if (foreign.length > 0) {
        const sites = [
          ...new Set(
            foreign.map(
              (f) =>
                `${f.kind} ${f.delayMs} ms ${f.site} from ${f.scheduledIn ?? 'between windows'}`,
            ),
          ),
        ]
        throw new Error(
          `${tag} ran ${foreign.length} deferred callback(s) from elsewhere: ${sites.slice(0, 8).join('; ')}`,
        )
      }
      const members = [...new Set([...before, ...neighbourhood()])]
      cells.push({ action, neighbourhood: members, work: counted.work, foreign })
      onCell?.(cells[cells.length - 1]!)
      progress(
        `${action}: ${counted.work.rows} row calls, ${counted.work.derivations} derivations, ${counted.work.elements} collection elements; neighbourhood ${members.length}; foreign ${foreign.length}${foreign.length ? ` (${[...new Set(foreign.map((f) => `${f.kind} ${f.delayMs}ms ${f.site} from ${f.scheduledIn ?? 'between'}`))].slice(0, 6).join(' | ')})` : ''}`,
      )
      // Correctness is outside the count window, and is never expected-failed.
      await drain(pool)
      assertObservedParity(readers, values)
      proveAction(action)
      const pane = values.get('mission.pane') as ReturnType<ReturnType<typeof missionPaneReader>['read']> | undefined
      if (values.has('mission.pane') && (pane === LOADING || pane?.root !== ROOT))
        throw new Error('Mission output lost its root')
      const row = omitGone(pool.row('issue', ROOT))
      if (!row || row === LOADING || Reflect.get(row, 'title') !== ROOT)
        throw new Error('Pool/legacy row parity failed')
    }
    return {
      scale,
      corpus: {
        issues: ctx.replica.rows('issueProjections').length,
        sessions: ctx.replica.rowCount!('sessions'),
      },
      readers: readers.map(({ name, consumers }) => ({ name, consumers })),
      cells,
    }
  } finally {
    for (const stop of stops.reverse()) stop()
    handle.dispose()
  }
}
