/** All app-wide pool readers, retained as their consumers retain them. No timers or walls are judged. */
import { autorun, compareStructural, observable, runInAction } from 'mobx'
import { asIssueId, asSessionId } from '@podium/model/browser'
import { LOADING } from '@podium/client-graph/worklist/rollup'
import { createRuntimeWorklistPool } from '@podium/client-graph/runtime-pool'
import { mergePoolSummaries } from '@podium/client-graph/source-registry'
import { attachCommandLaunchSource } from '@podium/client-graph/command-launch-source'
import { COMMAND_SUMMARIES } from '@podium/client-graph/command-launch-schema'
import { ShellSource } from '@podium/client-graph/shell-source'
import { SHELL_ENTITIES, SHELL_SUMMARIES } from '@podium/client-graph/shell-schema'
import { shellViews } from '@podium/client-graph/shell-views'
import { attachIssuePageSource } from '@podium/client-graph/issue-page-source'
import { ISSUE_PAGE_SUMMARIES } from '@podium/client-graph/issue-page-schema'
import { issuePages } from '@podium/client-graph/issue-page'
import { createIssueBoardSource } from '@podium/client-graph/issue-board-source'
import { ISSUE_BOARD_ENTITIES, ISSUE_BOARD_SUMMARIES } from '@podium/client-graph/issue-board-schema'
import { ChatContextSource } from '@podium/client-graph/chat-context-source'
import { CHAT_CONTEXT_ENTITIES, CHAT_CONTEXT_SUMMARIES } from '@podium/client-graph/chat-context-schema'
import { createChatContextReader } from '@podium/client-graph/chat-context'
import { NoticeSource } from '@podium/client-graph/notice-source'
import { NOTICE_ENTITIES, NOTICE_SUMMARIES } from '@podium/client-graph/notice-schema'
import { noticeMessages, noticeInteractions, noticeRecovery, noticeContinuity } from '@podium/client-graph/notice-views'
import { SessionPaneSource } from '@podium/client-graph/session-pane-source'
import { SESSION_PANE_ENTITIES, SESSION_PANE_SUMMARIES } from '@podium/client-graph/session-pane-schema'
import { MISSION_VIEW_SUMMARIES } from '@podium/client-graph/mission-view-schema'
import { missionView, readWorkspaceMission, readMissionActionInputs } from '@podium/client-graph/mission-view'
import { AutomationSource } from '@podium/client-graph/automation-source'
import { AUTOMATION_ENTITIES } from '@podium/client-graph/automation-schema'
import { automationViews } from '@podium/client-graph/automation-views'
import { workflowMachines } from '@podium/client-graph/workflow-views'
import { createSuperagentSource, SUPERAGENT_ENTITIES, SUPERAGENT_SUMMARIES,
  superagentState, superagentFeed, superagentFocus, superagentCursor, superagentQuestion } from '@podium/client-graph/superagent'
import { MobileInboxSource } from '@podium/client-graph/mobile-inbox-source'
import { MOBILE_INBOX_ENTITIES, MOBILE_INBOX_SUMMARIES } from '@podium/client-graph/mobile-inbox-schema'
import { createMobileInboxViews } from '@podium/client-graph/mobile-inbox-views'
import { createMobileSessionReader } from '@podium/client-graph/mobile-session-context'
import { MOBILE_SESSION_SUMMARIES } from '@podium/client-graph/mobile-session-schema'
import { createMobileSettingsSource, MOBILE_SETTINGS_ENTITIES } from '@podium/client-graph/mobile-settings'
import { readLaunch, readPalette, readGuardSessions } from '../../../../../apps/web/src/app/command-launch-readers'
import { readMissionPane } from '../../../../../apps/web/src/app/mission-pane-reader'
import { createPoolNavigationProvider } from '../../../../../apps/web/src/app/pool-navigation-provider'
import { readPoolWorkMenu } from '../../../../../apps/mobile/src/lib/pool-work-menu'
import { startScenarioEngine, upsert, upsertIssue, type FixtureScale, type ScenarioEngine } from '../../shared/src/scenarios'
import { insideReader, measureWork } from './work-meter'
import { SCREEN_ACTIONS, type ScreenAction, type ScreenWorkCell } from './screen-work-ratios'

const ROOT = 'guard-root', CHILD = 'guard-child', NEXT = 'guard-next'
const SESSION = 'guard-seat', OTHER_SESSION = 'guard-other-seat'
const REF = 'POD-999999-Z'
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
function seedNeighbourhood(ctx: ScenarioEngine, scale: FixtureScale): void {
  const row = ctx.engine.getSnapshot().issueProjections.find(issue => !issue.archived && !issue.deletedAt)!
  for (const [id, parentId] of [[ROOT, null], [CHILD, ROOT], [NEXT, ROOT]] as const) {
    upsertIssue(ctx, id, { ...row, id, seq: id === ROOT ? 999999 : id === CHILD ? 999998 : 999997,
      title: id, parentId, stage: 'planning', archived: false, deletedAt: null, closedAt: null,
      closedReason: null, deps: [], audience: 'human', updatedAt: ctx.stamp() })
  }
  const seat = ctx.cache.read('session', ctx.targets.phaseSessionId)!.value as Record<string, unknown>
  for (const [id, owner] of [[SESSION, ROOT], [OTHER_SESSION, CHILD]] as const) {
    upsert(ctx, 'session', id, { ...seat, id, sessionId: id, resume: undefined, issueId: owner, machineId: ctx.engine.getSnapshot().machines[0]!.id, archived: false, headless: false,
      status: 'live', agentKind: 'codex', lastActiveAt: ctx.stamp() })
  }
  // Closed historical sessions in the addressed mission expose full-history walks
  // without enlarging the visible roster or the click's addressed neighbourhood.
  const old = new Date(ctx.corpus.fixedNow - 90 * 86_400_000).toISOString()
  for (let index = 0; index < 32 * scale; index++) {
    const id = `guard-history-${index}`
    upsert(ctx, 'session', id, { ...seat, id, sessionId: id, resume: undefined, issueId: ROOT, archived: true, status: 'exited',
      headless: false, lastActiveAt: old, finishedAt: old, createdAt: old })
  }
  ctx.engine.getSnapshot().setSelectedIssueId(asIssueId(ROOT))
}

async function drain(pool: ReturnType<typeof createRuntimeWorklistPool>['pool']): Promise<void> {
  // Flush the existing coalesced load window, including loads first demanded by
  // an event handler. Do not sleep for its wall-clock deadline or count the oracle.
  for (let turn = 0; turn < 16; turn++) {
    await Promise.resolve()
    pool.hydrate()
  }
  await new Promise<void>(resolve => setTimeout(resolve, 0))
  pool.hydrate()
}

function assertObservedParity(readers: readonly ScreenReader[], values: ReadonlyMap<string, unknown>): void {
  for (const reader of readers) {
    if (!compareStructural(values.get(reader.name), reader.read())) {
      throw new Error(`Observed/direct parity failed: ${reader.name}`)
    }
  }
}

export async function poolScreenCellsAt(scale: FixtureScale): Promise<ScreenWorkRun> {
  const ctx = await startScenarioEngine(scale, { ownRows: true })
  seedNeighbourhood(ctx, scale)
  const handle = createRuntimeWorklistPool(ctx.engine, { header: true, settings: true, preferences: true,
    summaries: mergePoolSummaries(COMMAND_SUMMARIES, SHELL_SUMMARIES, ISSUE_PAGE_SUMMARIES,
      ISSUE_BOARD_SUMMARIES, CHAT_CONTEXT_SUMMARIES, NOTICE_SUMMARIES, SESSION_PANE_SUMMARIES,
      MISSION_VIEW_SUMMARIES, SUPERAGENT_SUMMARIES, MOBILE_INBOX_SUMMARIES, MOBILE_SESSION_SUMMARIES) })
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
    await pool.sources.ensure('chat-context', CHAT_CONTEXT_ENTITIES, () => new ChatContextSource(ctx.engine, pool))
    // Pane and exit sources are attached below by the mobile seam; pane is already
    // installed above, so attach only the mobile reader/window with its factory.
    const { createMobileSessionSource } = await import('@podium/client-graph/mobile-session-context')
    const { MOBILE_SESSION_ENTITIES } = await import('@podium/client-graph/mobile-session-schema')
    pool.sources.register(MOBILE_SESSION_ENTITIES, createMobileSessionSource(ctx.engine, pool))
    const { createSessionExitSource } = await import('@podium/client-graph/session-exit-source')
    const { SESSION_EXIT_ENTITIES } = await import('@podium/client-graph/session-exit-schema')
    pool.sources.register(SESSION_EXIT_ENTITIES, await createSessionExitSource(ctx.engine))
    const board = createIssueBoardSource(pool, ctx.engine)
    pool.sources.register(ISSUE_BOARD_ENTITIES, board)
    const shell = shellViews(pool), page = issuePages(pool), chat = createChatContextReader(pool)
    const mobileInbox = createMobileInboxViews(pool), mobileSession = createMobileSessionReader(pool)
    stops.push(() => mobileInbox.dispose())
    const navigation = createPoolNavigationProvider(pool)
    const locals = () => {
      const state = ctx.engine.getSnapshot()
      return { selectedIssueId: state.selectedIssueId, paneA: state.paneA, paneB: state.paneB, split: state.split }
    }
    const window = observable.box(locals(), { deep: false })
    stops.push(ctx.engine.subscribe(() => {
      const next = locals()
      if (!compareStructural(window.get(), next)) runInAction(() => window.set(next))
    }))
    const selected = () => window.get().selectedIssueId ?? ROOT
    const readers: ScreenReader[] = []
    const add = (name: string, consumers: readonly string[], read: () => unknown) => readers.push({ name, consumers, read })
    add('sidebar.sections', ['PoolSidebar', 'PoolSidebarRail', 'useSidebarProjectSections'], () => pool.sidebar.sections(layout))
    add('sidebar.row', ['PoolRowSlot'], () => pool.issue(selected())?.sidebar)
    add('mobile-work.sections', ['PoolWorkScreen', 'GroupHeader'], () => pool.mobileWork.sections(layout))
    add('mobile-work.row', ['PoolWorkRowSlot'], () => pool.mobileWork.row({ kind: 'issue', id: selected() }))
    add('header.folded', ['FoldedFlightDeckBar'], () => pool.headerViews.folded())
    add('header.shipping', ['useShippingCounts'], () => pool.headerViews.shipping())
    add('header.fleet', ['FleetOverview', 'ReclaimPanel'], () => ({ aggregate: pool.headerViews.aggregate(undefined),
      history: pool.headerViews.history(), metrics: pool.headerViews.metrics(), machines: pool.headerViews.machines(),
      quotas: pool.headerViews.quotas(), offline: pool.headerViews.offlineMachines(), reclaim: pool.headerViews.reclaimCounts(30) }))
    add('shell.chrome', ['AppBody', 'AppShell'], () => shell.chrome())
    add('shell.dock', ['AppShell', 'BrowserOpenOverlay'], () => shell.dock())
    add('shell.links', ['PodiumLinkHost', 'RefMiniview', 'BrowserOpenOverlay'], () => ({ sessions: shell.sessions(), issues: shell.issues() }))
    add('shell.close', ['AppShell'], () => shell.close())
    add('shell.catalogs', ['AppShell'], () => ({ machines: shell.machines(), repos: shell.repositories(),
      approvals: shell.approvals(), files: shell.files(), lanes: shell.lanes(), shipping: shell.shipping() }))
    add('launcher.launch', ['NewPanelMenu', 'NewWorkButton', 'useMobileLaunchData'], () => readLaunch(pool))
    add('launcher.palette', ['CommandPalette'], () => readPalette(pool))
    add('launcher.guard', ['CommandPalette', 'NewPanelMenu', 'NewWorkButton'], () => readGuardSessions(pool))
    add('mission.pane', ['PoolFlightDeck', 'MissionDeck'], () => readMissionPane(pool, { ...window.get(), mode: 'full', handoff: false }))
    add('mission.workspace', ['Workspace', 'FoldedFlightDeckBar'], () => readWorkspaceMission(missionView(pool), selected(), selected()))
    add('mission.menu', ['PoolIssueContextMenu', 'PoolSessionContextMenu'], () => readMissionActionInputs(missionView(pool), [selected()]))
    add('navigation.activity', ['ClientRuntime navigation watch'], () => navigation.activityAt(ROOT))
    add('navigation.ref', ['navigateToSession', 'PodiumLinkHost'], () => navigation.session(REF))
    add('navigation.mission', ['ClientRuntime navigation watch'], () => ({ root: navigation.missionRoot(selected()), members: navigation.missionMembers(ROOT), readAt: navigation.issueReadAt(selected()) }))
    add('issue-page.detail', ['IssuePage'], () => page.data(selected()))
    add('issue-page.panel', ['IssuePanel', 'IssueScreen'], () => page.panel({ issueId: selected(), cwd: '/synthetic' }))
    add('issue-page.catalog', ['IssueContextMenu', 'IssueExplorer'], () => ({ issues: page.issues(), explorer: page.explorer() }))
    add('board.catalog', ['useBoardData', 'IssueBoard'], () => board.catalog(false))
    add('board.query', ['IssueBoard', 'IssueExplorer'], () => board.queryIds({ kind: 'board', showAgentTasks: false }))
    add('board.card', ['PoolBoardCard'], () => board.card({ id: selected(), now: ctx.corpus.fixedNow }))
    add('chat.detail', ['SessionConversation', 'AgentPanel'], () => ({ issue: chat.issue(selected()), interactions: chat.interactions(SESSION),
      records: chat.records(SESSION), artifact: chat.artifactIssue({ sessionId: asSessionId(SESSION), issueId: asIssueId(ROOT) }), threads: chat.threads() }))
    add('chat.references', ['RichMarkdown', 'RefMiniview'], () => ({ issues: chat.mentions(), sessions: chat.sessions(), machines: chat.machines(), repos: chat.repositoryKey() }))
    add('notices', ['MessageNotices', 'Notices'], () => ({ messages: noticeMessages(pool), interactions: noticeInteractions(pool, SESSION),
      recovery: noticeRecovery(pool), continuity: noticeContinuity(pool) }))
    add('session-pane', ['AgentPanel', 'DockTerminal'], () => ({ session: pool.sessionPanes.session(SESSION), machines: pool.sessionPanes.machines(),
      window: pool.sessionPanes.window(), dock: pool.sessionPanes.dock('/synthetic', null), ownership: pool.sessionPanes.ownership(pool.sessionPanes.session(SESSION), color => color ?? undefined) }))
    add('settings', ['SettingsView', 'SettingsScreen', 'NewIssueScreen'], () => ({ setup: pool.settingsViews.setup(), sessions: pool.settingsViews.sessions() }))
    add('preferences', ['SettingsView', 'SettingsScreen', 'WorkScreen'], () => pool.row('preference', 'podium:sidebar:pinned-fold'))
    add('references', ['IssueChipLiveness', 'RefChip'], () => pool.references.read('#999999'))
    const automations = automationViews(pool)
    add('automations', ['AutomationsView', 'SpecsView', 'AutomationForm'], () => ({ list: automations.list(), targets: automations.targets(), session: automations.session(SESSION) }))
    add('workflows', ['WorkflowsView', 'WorkflowForm'], () => workflowMachines(pool))
    add('superagent', ['SuperagentView', 'SuperagentScreen'], () => ({ state: superagentState(pool), feed: superagentFeed(pool), focus: superagentFocus(pool),
      cursor: superagentCursor(pool), question: superagentQuestion(pool, asSessionId(SESSION)) }))
    add('mobile-inbox', ['InboxScreen', 'SessionsScreen', 'ScreeningScreen', 'PodiumLinkHost'], () => ({ inbox: mobileInbox.inbox(), screening: mobileInbox.screening(),
      rows: mobileInbox.screeningRows([ROOT]), ref: mobileInbox.session(REF), route: mobileInbox.route({ kind: 'issue', issue: '#999999', search: '', hash: '' }) }))
    add('mobile-session', ['SessionScreen', 'TerminalScreen', 'SessionConversation'], () => ({ session: mobileSession.session(SESSION), issue: mobileSession.issue(selected()),
      sessions: mobileSession.sessions(), issues: mobileSession.issues(), machines: mobileSession.machines(), pending: mobileSession.spawnPending(SESSION),
      prompt: mobileSession.spawnPrompt(SESSION), exit: mobileSession.exit(SESSION), conversation: mobileSession.conversation(SESSION), booting: mobileSession.booting() }))
    add('mobile-settings', ['SettingsScreen'], () => pool.row('mobileSettingsDiagnostics', 'diagnostics'))
    for (const reader of readers) stops.push(autorun(() => values.set(reader.name, insideReader(reader.name, reader.read)), { name: `consumer:${reader.name}` }))
    await drain(pool)
    assertObservedParity(readers, values)
    // The neighbourhood is declared from the actual rows drawn by this probe,
    // not all members/history of the selected mission. It is inspected per step.
    function neighbourhood(): string[] {
      const keys = [ROOT, CHILD, NEXT].filter(id => ctx.cache.read('issueProjection', id) !== undefined).map(id => `issue:${id}`)
      for (const id of [SESSION, OTHER_SESSION]) if (ctx.cache.read('session', id)) keys.push(`session:${id}`)
      return keys
    }
    const issuePatch = (patch: Record<string, unknown>) => upsertIssue(ctx, ROOT, { ...ctx.cache.read('issueProjection', ROOT)!.value as object, ...patch }, 3)
    const seatPatch = (patch: Record<string, unknown>) => upsert(ctx, 'session', SESSION, { ...ctx.cache.read('session', SESSION)!.value as object, ...patch }, 3)
    const actions: Record<ScreenAction, () => void | Promise<unknown>> = {
      select: () => ctx.engine.getSnapshot().setSelectedIssueId(asIssueId(CHILD)),
      'stage-change': () => ctx.engine.getSnapshot().updateIssue(asIssueId(ROOT), { stage: 'in_progress' }),
      'pane-switch': () => ctx.engine.getSnapshot().setPane('A', asSessionId(SESSION)),
      'open-menu': () => { ctx.engine.getSnapshot().setPaletteOpen(true); insideReader('launcher.open-menu', () => readPalette(pool)) },
      'long-press': () => { insideReader('mobile-work.long-press', () => readPoolWorkMenu(pool, ROOT)) },
      'navigate-by-ref': () => { insideReader('navigation.navigate-by-ref', () => navigation.session(REF)) },
      heartbeat: () => seatPatch({ lastActiveAt: ctx.stamp() }),
      'machine-flip': () => {
        const id = ctx.engine.getSnapshot().machines[0]!.id
        upsert(ctx, 'machine', id, { ...ctx.cache.read('machine', id)!.value as object, online: false }, 3)
      },
      'lane-change': () => issuePatch({ stage: 'review', updatedAt: ctx.stamp() }),
    }
    const cells: ScreenWorkCell[] = []
    for (const action of SCREEN_ACTIONS) {
      const before = neighbourhood()
      const counted = await measureWork(async () => { await actions[action](); await drain(pool) }, { pool })
      const members = [...new Set([...before, ...neighbourhood()])]
      cells.push({ action, neighbourhood: members, work: counted.work })
      // Correctness is outside the count window, and is never expected-failed.
      await drain(pool)
      assertObservedParity(readers, values)
      const pane = values.get('mission.pane') as ReturnType<typeof readMissionPane>
      if (pane === LOADING || pane.mission.root?.id !== ROOT) throw new Error('Mission output lost its root')
      const row = pool.row('issue', ROOT)
      if (!row || row === LOADING || Reflect.get(row, 'title') !== ROOT) throw new Error('Pool/legacy row parity failed')
    }
    return { scale, corpus: { issues: ctx.engine.getSnapshot().issueProjections.length, sessions: ctx.engine.getSnapshot().sessions.length },
      readers: readers.map(({ name, consumers }) => ({ name, consumers })), cells }
  } finally {
    for (const stop of stops.reverse()) stop()
    handle.dispose()
    ctx.engine.destroy()
  }
}
