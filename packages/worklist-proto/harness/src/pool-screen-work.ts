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
import { createIssueBoardSource } from '@podium/client-graph/issue-board-source'
import { issuePages } from '@podium/client-graph/issue-page'
import { ISSUE_PAGE_SUMMARIES } from '@podium/client-graph/issue-page-schema'
import { attachIssuePageSource } from '@podium/client-graph/issue-page-source'
import {
  missionView,
  readMissionActionInputs,
  readWorkspaceMission,
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
import { asIssueId, asSessionId } from '@podium/model/browser'
import type { WorkflowRunWire } from '@podium/protocol'
import { autorun, compareStructural, observable, runInAction } from 'mobx'
import { resolvePoolWorkMenu as readPoolWorkMenu } from '../../../../apps/mobile/src/lib/pool-work-menu'
import {
  MobileSearchSections,
  searchMobileSections,
} from '../../../../apps/mobile/src/lib/work-sections'
import {
  readFiles,
  readGuardSessions,
  readLaunch,
  readOpen,
  readPalette,
} from '../../../../apps/web/src/app/command-launch-readers'
import { readMissionPane } from '../../../../apps/web/src/app/mission-pane-reader'
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
  const row = ctx.engine
    .getSnapshot()
    .issueProjections.find((issue) => !issue.archived && !issue.deletedAt)!
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
      parentId,
      stage: 'planning',
      archived: false,
      deletedAt: null,
      closedAt: null,
      closedReason: null,
      deps: [],
      audience: 'human',
      updatedAt: ctx.stamp(),
    })
  }
  const seat = ctx.cache.read('session', ctx.targets.phaseSessionId)!.value as Record<
    string,
    unknown
  >
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
      machineId: ctx.corpus.machines[0]!.id,
      archived: false,
      headless: false,
      status: 'live',
      agentKind: 'codex',
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
  ctx.engine.getSnapshot().setSelectedIssueId(asIssueId(ROOT))
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
   * full guard mounts every reader, as the app does. */
  only?: ReadonlySet<string>,
): Promise<ScreenWorkRun> {
  // POD-5466: installed before the engine starts, so every timer the app
  // schedules, the startup ones included, is tagged and can be settled.
  const ledger = installAsyncLedger({ holdBeyondMs: SETTLE_MAX_DELAY_MS, startAt: FIXED_NOW })
  try {
    const ctx = await startScenarioEngine(scale, { ownRows: true })
    try {
      return await measureScreenCells(ctx, scale, ledger, onCell, only)
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
): Promise<ScreenWorkRun> {
  const progress = (message: string) => process.stdout.write(`[screen work] ${scale}x ${message}\n`)
  progress('kernel ready')
  const ref = seedNeighbourhood(ctx, scale)
  // The real web host enables this before attaching a pilot-on pool.
  ctx.engine.enablePoolRuntimeWork()
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
    const mobileInbox = createMobileInboxViews(pool),
      mobileSession = createMobileSessionReader(pool)
    stops.push(() => mobileInbox.dispose())
    const navigation = createPoolNavigationProvider(pool)
    ctx.engine.setNavigationProvider(navigation)
    const locals = () => {
      const state = ctx.engine.getSnapshot()
      return {
        selectedIssueId: state.selectedIssueId,
        paneA: state.paneA,
        paneB: state.paneB,
        split: state.split,
      }
    }
    const window = observable.box(locals(), { deep: false })
    stops.push(
      ctx.engine.subscribe(() => {
        const next = locals()
        if (!compareStructural(window.get(), next)) runInAction(() => window.set(next))
      }),
    )
    const selected = () => window.get().selectedIssueId ?? ROOT
    const readers: ScreenReader[] = []
    const add = (name: string, consumers: readonly string[], read: () => unknown) => {
      if (!only || only.has(name)) readers.push({ name, consumers, read })
    }
    add('sidebar.sections', ['PoolSidebar', 'PoolSidebarRail', 'useSidebarProjectSections'], () =>
      pool.sidebar.sections(layout),
    )
    const worktree = pool.tables.worktree.keys().next().value!
    add('sidebar.row', ['PoolRowSlot', 'PoolSidebarRail'], () => pool.sidebar.row(selected()))
    add('sidebar.worktree', ['PoolWorktreeRow', 'PoolSidebarRail'], () =>
      pool.sidebar.worktree(worktree, layout),
    )
    add('sidebar.selection', ['PoolSidebar'], () => pool.sidebar.selectionEvicted())
    add('mobile-work.sections', ['PoolWorkScreen', 'GroupHeader'], () =>
      pool.mobileWork.sections(layout),
    )
    const search = new MobileSearchSections()
    add('mobile-work.search', ['PoolWorkScreen'], () =>
      searchMobileSections(pool, pool.mobileWork.sections(layout).sections, '', search),
    )
    add('mobile-work.row', ['PoolWorkRowSlot'], () =>
      pool.mobileWork.row({ kind: 'issue', id: selected() }),
    )
    add('header.folded', ['FoldedFlightDeckBar'], () => pool.headerViews.folded())
    add('header.shipping', ['useShippingCounts'], () => pool.headerViews.shipping())
    add('header.fleet', ['FleetOverview', 'ReclaimPanel'], () => ({
      aggregate: pool.headerViews.aggregate(undefined),
      history: pool.headerViews.history(),
      metrics: pool.headerViews.metrics(),
      machines: pool.headerViews.machines(),
      quotas: pool.headerViews.quotas(),
      offline: pool.headerViews.offlineMachines(),
      reclaim: pool.headerViews.reclaimCounts(30),
      working: pool.headerViews.working(),
      selected: pool.headerViews.selectedIssue(),
      session: pool.headerViews.session(SESSION),
      occupancy: pool.headerViews.occupancyKey(),
    }))
    add('shell.chrome', ['AppBody', 'AppShell'], () => shell.chrome())
    add('shell.dock', ['AppShell', 'BrowserOpenOverlay'], () => shell.dock())
    add('shell.links', ['PodiumLinkHost', 'RefMiniview', 'BrowserOpenOverlay'], () => ({
      sessions: shell.sessions(),
      issues: shell.issues(),
    }))
    add('shell.close', ['AppShell'], () => shell.close())
    add('shell.catalogs', ['AppShell'], () => ({
      machines: shell.machines(),
      repos: shell.repositories(),
      approvals: shell.approvals(),
      files: shell.files(),
      lanes: shell.lanes(),
      shipping: shell.shipping(),
    }))
    add('launcher.launch', ['NewPanelMenu', 'NewWorkButton', 'useMobileLaunchData'], () =>
      readLaunch(pool),
    )
    add('launcher.palette', ['CommandPalette'], () => readPalette(pool))
    add('launcher.guard', ['CommandPalette', 'NewPanelMenu', 'NewWorkButton'], () =>
      readGuardSessions(pool),
    )
    add('launcher.window', ['CommandPaletteBoundary', 'CommandPalette'], () => ({
      open: readOpen(pool),
      files: readFiles(pool),
    }))
    add('mission.pane', ['PoolFlightDeck', 'MissionDeck'], () =>
      readMissionPane(pool, { ...window.get(), mode: 'full', handoff: true }),
    )
    add('mission.workspace', ['Workspace', 'FoldedFlightDeckBar'], () =>
      readWorkspaceMission(missionView(pool), selected(), selected()),
    )
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
    add('issue-page.detail', ['IssuePage'], () => page.data(selected()))
    add('issue-page.panel', ['IssuePanel', 'IssueScreen'], () =>
      page.panel({ issueId: selected(), cwd: '/synthetic' }),
    )
    add('issue-page.catalog', ['IssueContextMenu', 'IssueExplorer'], () => ({
      issues: page.issues(),
      explorer: page.explorer(),
    }))
    add('board.catalog', ['useBoardData', 'IssueBoard'], () => board.catalog(false))
    add('board.query', ['IssueBoard', 'IssueExplorer'], () =>
      board.queryIds({ kind: 'board', showAgentTasks: false }),
    )
    add('board.card', ['PoolBoardCard'], () =>
      board.card({ id: selected(), now: ctx.corpus.fixedNow }),
    )
    add('board.model', ['IssueBoard', 'useBoardData'], () =>
      pool.row(
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
      ),
    )
    add('board.explorer', ['IssueExplorer'], () =>
      pool.row('issueExplorerModel', JSON.stringify({ tab: null, query: '', windowed: true })),
    )
    add('chat.detail', ['SessionConversation', 'AgentPanel'], () => ({
      issue: chat.issue(selected()),
      interactions: chat.interactions(SESSION),
      records: chat.records(SESSION),
      artifact: chat.artifactIssue({ sessionId: asSessionId(SESSION), issueId: asIssueId(ROOT) }),
      threads: chat.threads(),
    }))
    add('chat.references', ['RichMarkdown', 'RefMiniview'], () => ({
      issues: chat.mentions(),
      sessions: chat.sessions(),
      machines: chat.machines(),
      repos: chat.repositoryKey(),
    }))
    add('notices', ['MessageNotices', 'Notices'], () => ({
      messages: noticeMessages(pool),
      interactions: noticeInteractions(pool, SESSION),
      recovery: noticeRecovery(pool),
      continuity: noticeContinuity(pool),
    }))
    add('session-pane', ['AgentPanel', 'DockTerminal'], () => ({
      session: pool.sessionPanes.session(SESSION),
      machines: pool.sessionPanes.machines(),
      window: pool.sessionPanes.window(),
      dock: pool.sessionPanes.dock('/synthetic', null),
      confirmed: pool.sessionPanes.spawnConfirmed(SESSION),
      ownership: pool.sessionPanes.ownership(
        pool.sessionPanes.session(SESSION),
        (color) => color ?? undefined,
      ),
    }))
    add('settings', ['SettingsView', 'SettingsScreen', 'NewIssueScreen', 'WorkflowForm'], () => ({
      setup: pool.settingsViews.setup(),
      sessions: pool.settingsViews.sessions(),
      present: pool.settingsViews.sessionPresent(SESSION),
    }))
    add('preferences', ['SettingsView', 'SettingsScreen', 'WorkScreen'], () =>
      pool.row('preference', 'podium:sidebar:pinned-fold'),
    )
    add('references', ['IssueChipLiveness', 'RefChip', 'RefMiniview'], () => ({
      token: pool.references.read('#999999'),
      id: pool.references.id('#999999'),
      byId: pool.references.readById(ROOT),
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
        inbox: mobileInbox.inbox(),
        screening: mobileInbox.screening(),
        rows: mobileInbox.screeningRows([ROOT]),
        ref: mobileInbox.session(ref),
        route: mobileInbox.route({ kind: 'issue', issue: '#999999', search: '', hash: '' }),
      }),
    )
    add('mobile-session', ['SessionScreen', 'TerminalScreen', 'SessionConversation'], () => ({
      session: mobileSession.session(SESSION),
      issue: mobileSession.issue(selected()),
      sessions: mobileSession.sessions(),
      issues: mobileSession.issues(),
      machines: mobileSession.machines(),
      pending: mobileSession.spawnPending(SESSION),
      prompt: mobileSession.spawnPrompt(SESSION),
      exit: mobileSession.exit(SESSION),
      conversation: mobileSession.conversation(SESSION),
      booting: mobileSession.booting(),
    }))
    add('mobile-settings', ['SettingsScreen'], () =>
      pool.row('mobileSettingsDiagnostics', 'diagnostics'),
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
      select: () => ctx.engine.getSnapshot().setSelectedIssueId(asIssueId(CHILD)),
      'stage-change': () =>
        ctx.engine.getSnapshot().updateIssue(asIssueId(ROOT), { stage: 'in_progress' }),
      'pane-switch': () => ctx.engine.getSnapshot().setPane('A', asSessionId(SESSION)),
      'open-menu': () => {
        ctx.engine.getSnapshot().setPaletteOpen(true)
        insideReader('launcher.open-menu', () => readPalette(pool))
      },
      'long-press': () => {
        pressed = insideReader('mobile-work.long-press', () => readPoolWorkMenu(pool, ROOT))
      },
      'navigate-by-ref': () => {
        insideReader('navigation.navigate-by-ref', () =>
          ctx.engine.getSnapshot().navigateToSession(asSessionId(ref)),
        )
      },
      heartbeat: () => seatPatch({ lastActiveAt: ctx.stamp() }),
      'machine-flip': () => {
        const id = ctx.corpus.machines[0]!.id
        const machine = ctx.cache.read('machine', id)!.value as { loggedOutHarnesses: string[] }
        const loggedOutHarnesses = machine.loggedOutHarnesses.includes('codex')
          ? machine.loggedOutHarnesses.filter((kind) => kind !== 'codex')
          : [...machine.loggedOutHarnesses, 'codex']
        upsert(ctx, 'machine', id, { ...machine, loggedOutHarnesses }, 3)
      },
      'lane-change': () => issuePatch({ stage: 'review', updatedAt: ctx.stamp() }),
    }
    const cells: ScreenWorkCell[] = []
    const proveAction = (action: ScreenAction) => {
      const state = ctx.engine.getSnapshot()
      const issue = pool.row('issue', ROOT)
      const session = pool.row('session', SESSION)
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
            Reflect.get(ctx.cache.read('session', SESSION)!.value as object, 'lastActiveAt'))
      )
        throw new Error('Heartbeat did not reach its session')
      if (action === 'machine-flip') {
        const machine = ctx.cache.read('machine', ctx.corpus.machines[0]!.id)!.value as {
          loggedOutHarnesses: string[]
        }
        const wanted = machine.loggedOutHarnesses.includes('codex') ? 'logged-out' : undefined
        if (!session || session === LOADING || Reflect.get(session, 'condition') !== wanted)
          throw new Error('Machine flip did not reach its joined session')
      }
    }
    for (const action of SCREEN_ACTIONS) {
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
      const pane = values.get('mission.pane') as ReturnType<typeof readMissionPane> | undefined
      if (values.has('mission.pane') && (pane === LOADING || pane?.mission.root?.id !== ROOT))
        throw new Error('Mission output lost its root')
      const row = pool.row('issue', ROOT)
      if (!row || row === LOADING || Reflect.get(row, 'title') !== ROOT)
        throw new Error('Pool/legacy row parity failed')
    }
    return {
      scale,
      corpus: {
        issues: ctx.engine.getSnapshot().issueProjections.length,
        sessions: ctx.engine.getSnapshot().sessions.length,
      },
      readers: readers.map(({ name, consumers }) => ({ name, consumers })),
      cells,
    }
  } finally {
    for (const stop of stops.reverse()) stop()
    handle.dispose()
  }
}
