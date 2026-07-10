// @vitest-environment node
// Reads source files off disk via import.meta.url — needs the real file URL,
// which happy-dom (this package's default test env) mangles. The repo-root
// config runs these in node; this matches it for the worktree-local config.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../src/${rel}`, import.meta.url)), 'utf8')

// The store provider implementation moved to @podium/client-core (arch-v2 P3,
// issue #192) and then dissolved into the non-React engine + a thin React
// binding (P5b, issue #262). Structure assertions about the store's
// implementation read the engine sources (plus the binding).
const readStore = () =>
  ['engine/engine.ts', 'engine/wiring.ts', 'react/provider.tsx']
    .map((rel) =>
      readFileSync(
        fileURLToPath(new URL(`../../../packages/client-core/src/${rel}`, import.meta.url)),
        'utf8',
      ),
    )
    .join('\n')

describe('web shell structure', () => {
  it('AppShell auto-resolves the relay (no manual connect screen) and renders sidebar + workspace', () => {
    const src = read('app/AppShell.tsx')
    // The relay address is derived automatically via serverConfig — never typed by the user.
    expect(src).toContain('serverConfig')
    expect(src).not.toContain('ConnectScreen')
    expect(src).toContain('ErrorBoundary')
    expect(src).toContain('AppErrorPage')
    expect(src).toContain('<SidebarUnified')
    expect(src).toContain('<Workspace')
  })
  it('store exposes the live server feeds', () => {
    const src = readStore()
    // Conversations are no longer a store feed — search reads the durable server
    // index directly (trpc.conversations.search), so the push copy was removed.
    for (const feed of ['repos', 'sessions', 'hostMetrics']) expect(src).toContain(feed)
    expect(src).toContain('onFatalError')
    expect(src).toContain('onError')
    expect(src).toContain('reposToViews')
    expect(src).toContain('setSelectedWorktree')
    expect(src).toContain('reposLoading')
    expect(src).toContain('repoDiagnostics')
    expect(src).toContain('setTimeout')
    expect(src).toContain('clearTimeout')
  })

  it('store exposes shared pin state and mutations', () => {
    const src = readStore()
    expect(src).toContain('pins')
    expect(src).toContain('setPinned')
    expect(src).toContain('pins.list')
    expect(src).toContain('pins.set')
  })
  it('sidebar renders pin-aware sections and pin controls', () => {
    const src = read('features/worklist/SidebarUnified.tsx')
    expect(src).toContain('sidebarSections')
    expect(src).toContain('"PINNED"')
    expect(src).toContain('setPinned')
  })
  it('workspace and mobile tabs use the persisted manual order (pins as fallback)', () => {
    expect(read('app/Workspace.tsx')).toContain('orderTabs')
    expect(read('app/MobileApp.tsx')).toContain('orderTabs')
  })
  it('store loads and persists the manual tab order', () => {
    const src = readStore()
    expect(src).toContain('tabOrders')
    expect(src).toContain('tabs.listOrders')
    expect(src).toContain('tabs.setOrder')
  })
  it('workspace tabs are sortable with fixed actions outside the scrolling strip', () => {
    const src = read('app/Workspace.tsx')
    expect(src).toContain('DndContext')
    expect(src).toContain('SortableContext')
    expect(src).toContain('horizontalListSortingStrategy')
    expect(src).toContain('useSortable')
    expect(src).toContain('arrayMove')
    expect(src).toContain('setTabOrder')
    // The strip itself scrolls horizontally; drags are clamped to the row.
    expect(src).toContain('overflow-x-auto')
    expect(src).toContain('restrictToHorizontalAxis')
    // The fixed actions (new-panel menu, split) render OUTSIDE the sortable
    // scrolling strip — after the DndContext closes.
    expect(src.indexOf('<NewPanelMenu')).toBeGreaterThan(src.indexOf('</DndContext>'))
    // Clicks must keep working: drags only start after the pointer moves.
    expect(src).toContain('activationConstraint')
  })
  it('repo add flow uses the scan flow on desktop and mobile', () => {
    // AppToolsRow owns the scan flow; mobile reaches it by composing that row
    // into its home view (#227), desktop by composing it into the sidebar.
    expect(read('features/worklist/SidebarUnified.tsx')).toContain('RepoScanFlow')
    expect(read('app/MobileApp.tsx')).toContain('AppToolsRow')
  })
  it('sidebar work panels navigate directly to the panel when clicked', () => {
    // Each panel row is an interactive button (not an inert div) that focuses the
    // session: select its worktree and point pane A at it.
    expect(read('features/worklist/sidebar-common.tsx')).toContain('onClick={onSelect}')
    const src = read('features/worklist/SidebarUnified.tsx')
    expect(src).toContain('setSelectedWorktree(worktreePath)')
    expect(src).toContain("setPane('A', sessionId)")
  })
  it('repo picker browses folders, hides hidden by default, and offers a scan action', () => {
    const src = read('features/setup/RepoPickerModal.tsx')
    expect(src).toContain('showHidden')
    expect(src).toContain('includeHidden')
    expect(src).toContain('Show hidden')
    expect(src).toContain('onScan')
    expect(src).toContain('Scan for repos here')
  })
  it('first run shows the onboarding wizard only once repos are known empty', () => {
    const src = read('app/AppShell.tsx')
    expect(src).toContain('OnboardingWizard')
    expect(src).toContain('reposLoaded')
    expect(src).toContain('repos.length === 0')
  })
  it('scan flow ranks results and persists the selection', () => {
    const flow = read('features/setup/RepoScanFlow.tsx')
    expect(flow).toContain('scanFolder')
    expect(flow).toContain('rankRepoCandidates')
    expect(flow).toContain('addMany')
    const results = read('features/setup/RepoScanResults.tsx')
    expect(results).toContain('PROJECTS')
    expect(results).toContain('HIDDEN / SYSTEM')
  })
  it('workspace renders the new-panel menu outside the scrolling tabbar', () => {
    // NewPanelMenu owns its own trigger and a portalled, auto-positioned
    // dropdown (the old fixed 'workspace-menu-layer' the parent positioned is
    // gone) — so the menu never scrolls with, or is clipped by, the tab strip.
    const src = read('app/Workspace.tsx')
    expect(src).toContain('NewPanelMenu')
    const menu = read('app/NewPanelMenu.tsx')
    expect(menu).toContain('DropdownMenuTrigger')
    expect(menu).toContain('DropdownMenuContent')
  })
  it('initial store load does not block on a conversation scan', () => {
    const src = readStore()
    // Conversations are read on demand from the durable server index, so the
    // boot fan-out is repos + pins + tab orders — never a conversation rescan.
    const bootStart = src.indexOf('void Promise.all([')
    const boot = src.slice(bootStart, src.indexOf('.catch', bootStart))
    expect(boot).toContain('this.refreshRepos()')
    expect(boot).toContain('this.refreshPins()')
    expect(boot).toContain('this.refreshTabOrders()')
    expect(src).not.toContain('rescanConversations')
    expect(src).not.toContain('onConversations')
  })
  it('new-panel menu offers claude, codex, grok, and shell', () => {
    const src = read('app/NewPanelMenu.tsx')
    expect(src).toContain('New Claude')
    expect(src).toContain('New Codex')
    expect(src).toContain('New Grok')
    expect(src).toContain('New Shell')
  })
  it('agent panel offers chat mode for structured-transcript harnesses before first append', () => {
    const src = read('features/terminal/AgentPanel.tsx')
    // The harness fallback lives in defaultChatCapable (which harnesses, incl.
    // codex, is asserted in derive.test.ts); the server's transcriptAvailable
    // still wins when present.
    expect(src).toContain('defaultChatCapable')
    expect(src).toContain('transcriptAvailable')
  })
  it('new-panel menu is the mini search: indexed, capped, with last-active dates', () => {
    const src = read('app/NewPanelMenu.tsx')
    // Server-indexed search via the shared hook (capped, recency-first, dated).
    expect(src).toContain('useConversationSearch')
    expect(src).toContain('MINI_LIMIT')
    expect(src).toContain('relativeTime')
    // The hook is the thing that hits the durable server index.
    expect(read('lib/useConversationSearch.ts')).toContain('trpc.conversations.search')
  })
})

describe('host health indicators', () => {
  it('store subscribes to the host metrics feed', () => {
    const src = readStore()
    // Via the P5a typed subscription seam (the deprecated onHostMetrics wrapper
    // is gone from the engine).
    expect(src).toContain("on('hostMetrics'")
    expect(src).toContain('hostMetrics')
  })
  it('the strip is mounted in the desktop sidebar and the mobile header', () => {
    expect(read('features/worklist/SidebarUnified.tsx')).toContain('<HostIndicators')
    expect(read('app/MobileApp.tsx')).toContain('<HostIndicators')
  })
  it('the connection indicator shows on the hysteresis signal; memory chips per host', () => {
    const src = read('features/machines/HostIndicators.tsx')
    expect(src).toContain('connVisible')
    expect(src).toContain('<ConnectionIndicator')
    expect(src).toContain('hostMetrics.length > 1')
    expect(src).toContain('hostMemoryView')
  })
  it('the connection indicator is icon-based with an explanatory tooltip', () => {
    const src = read('features/machines/ConnectionIndicator.tsx')
    expect(src).toContain('describeHealth')
    expect(src).toContain('onConnectionHealth')
    // The custom conn-tooltip div became the shared Tooltip primitives.
    expect(src).toContain('TooltipTrigger')
    expect(src).toContain('TooltipContent')
    expect(src).toContain('ms ping') // the number the tooltip explains
  })
})

describe('memory breakdown view', () => {
  it('the memory chip is a button that opens the host info panel', () => {
    const src = read('features/machines/HostIndicators.tsx')
    expect(src).toContain('<button')
    expect(src).toContain('<HostInfoView')
  })
  it('fetches the clicked machine breakdown via the hosts endpoint and refreshes while open', () => {
    const src = read('features/machines/HostMemoryView.tsx')
    // Machine-aware: the breakdown is requested for the clicked machine (#136),
    // not always the first online daemon.
    expect(src).toContain(
      'trpc.hosts.memoryBreakdown.mutate(machineId ? { machineId } : undefined)',
    )
    expect(src).toContain('setInterval')
    expect(src).toContain('clearInterval')
  })
  it('separates agents, project processes, and the rest', () => {
    const src = read('features/machines/HostMemoryView.tsx')
    expect(src).toContain('AGENTS & SHELLS')
    expect(src).toContain('PROJECT PROCESSES')
    expect(src).toContain('otherBytes')
    expect(src).toContain('supported') // totals-only fallback on hosts without /proc
  })
})
