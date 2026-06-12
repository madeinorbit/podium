import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../src/${rel}`, import.meta.url)), 'utf8')

describe('web shell structure', () => {
  it('AppShell auto-resolves the relay (no manual connect screen) and renders sidebar + workspace', () => {
    const src = read('AppShell.tsx')
    // The relay address is derived automatically via serverConfig — never typed by the user.
    expect(src).toContain('serverConfig')
    expect(src).not.toContain('ConnectScreen')
    expect(src).toContain('ErrorBoundary')
    expect(src).toContain('AppErrorPage')
    expect(src).toContain('<Sidebar')
    expect(src).toContain('<Workspace')
  })
  it('store exposes the three server feeds', () => {
    const src = read('store.tsx')
    for (const feed of ['repos', 'conversations', 'sessions']) expect(src).toContain(feed)
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
    const src = read('store.tsx')
    expect(src).toContain('pins')
    expect(src).toContain('setPinned')
    expect(src).toContain('pins.list')
    expect(src).toContain('pins.set')
  })
  it('sidebar renders pin-aware moved sections and pin controls', () => {
    const src = read('Sidebar.tsx')
    expect(src).toContain('sidebarSections')
    expect(src).toContain('PinButton')
    expect(src).toContain('PINNED PANELS')
    expect(src).toContain('PINNED WORKTREES')
    expect(src).toContain('PINNED REPOS')
    expect(src).toContain('setPinned')
  })
  it('workspace and mobile tabs use the persisted manual order (pins as fallback)', () => {
    expect(read('Workspace.tsx')).toContain('orderTabs')
    expect(read('MobileApp.tsx')).toContain('orderTabs')
  })
  it('store loads and persists the manual tab order', () => {
    const src = read('store.tsx')
    expect(src).toContain('tabOrders')
    expect(src).toContain('tabs.listOrders')
    expect(src).toContain('tabs.setOrder')
  })
  it('workspace tabs are sortable with fixed actions outside the scrolling strip', () => {
    const src = read('Workspace.tsx')
    expect(src).toContain('DndContext')
    expect(src).toContain('SortableContext')
    expect(src).toContain('horizontalListSortingStrategy')
    expect(src).toContain('useSortable')
    expect(src).toContain('arrayMove')
    expect(src).toContain('setTabOrder')
    expect(src).toContain('tabbar-tabs')
    expect(src).toContain('tabbar-actions')
    // Clicks must keep working: drags only start after the pointer moves.
    expect(src).toContain('activationConstraint')
  })
  it('repo add flow uses the scan flow on desktop and mobile', () => {
    expect(read('Sidebar.tsx')).toContain('RepoScanFlow')
    expect(read('MobileApp.tsx')).toContain('RepoScanFlow')
  })
  it('sidebar work panels navigate directly to the panel when clicked', () => {
    const src = read('Sidebar.tsx')
    // Each panel row is an interactive button (not an inert div) that focuses the
    // session: select its worktree and point pane A at it.
    expect(src).toContain("className={active ? 'panel-row active' : 'panel-row'}")
    expect(src).toContain('setSelectedWorktree(worktreePath)')
    expect(src).toContain("setPane('A', sessionId)")
  })
  it('repo picker browses folders, hides hidden by default, and offers a scan action', () => {
    const src = read('RepoPickerModal.tsx')
    expect(src).toContain('showHidden')
    expect(src).toContain('includeHidden')
    expect(src).toContain('Show hidden')
    expect(src).toContain('onScan')
    expect(src).toContain('Scan for repos here')
  })
  it('first run shows the onboarding wizard only once repos are known empty', () => {
    const src = read('AppShell.tsx')
    expect(src).toContain('OnboardingWizard')
    expect(src).toContain('reposLoaded')
    expect(src).toContain('repos.length === 0')
  })
  it('scan flow ranks results and persists the selection', () => {
    const flow = read('RepoScanFlow.tsx')
    expect(flow).toContain('scanFolder')
    expect(flow).toContain('rankRepoCandidates')
    expect(flow).toContain('addMany')
    const results = read('RepoScanResults.tsx')
    expect(results).toContain('PROJECTS')
    expect(results).toContain('HIDDEN / SYSTEM')
  })
  it('workspace renders the new-panel menu outside the scrolling tabbar', () => {
    const src = read('Workspace.tsx')
    expect(src).toContain('workspace-menu-layer')
    expect(src).toContain('NewPanelMenu')
  })
  it('conversation discovery is pushed instead of blocking initial store load', () => {
    const src = read('store.tsx')
    expect(src).toContain('hub.onConversations(setConversations)')
    expect(src).toContain('Promise.all([refreshRepos(), refreshPins(), refreshTabOrders()])')
    expect(src).not.toContain('Promise.all([refreshRepos(), rescanConversations()])')
  })
  it('new-panel menu offers claude, codex, and shell', () => {
    const src = read('NewPanelMenu.tsx')
    expect(src).toContain('New Claude')
    expect(src).toContain('New Codex')
    expect(src).toContain('New Shell')
  })
  it('new-panel menu is the mini search: indexed, capped, with last-active dates', () => {
    const src = read('NewPanelMenu.tsx')
    expect(src).toContain('trpc.conversations.search')
    expect(src).toContain('MINI_LIMIT')
    expect(src).toContain('relativeTime')
  })
})

describe('host health indicators', () => {
  it('store subscribes to the host metrics feed', () => {
    const src = read('store.tsx')
    expect(src).toContain('onHostMetrics')
    expect(src).toContain('hostMetrics')
  })
  it('the strip is mounted in the desktop sidebar and the mobile header', () => {
    expect(read('Sidebar.tsx')).toContain('<HostIndicators')
    expect(read('MobileApp.tsx')).toContain('<HostIndicators')
  })
  it('the strip always renders the connection indicator; memory chips per host', () => {
    const src = read('HostIndicators.tsx')
    expect(src).toContain('<ConnectionIndicator')
    expect(src).toContain('hostMetrics.length > 1')
    expect(src).toContain('hostMemoryView')
  })
  it('the connection indicator is icon-based with an explanatory tooltip', () => {
    const src = read('ConnectionIndicator.tsx')
    expect(src).toContain('describeHealth')
    expect(src).toContain('onConnectionHealth')
    expect(src).toContain('conn-tooltip')
    expect(src).toContain('ms ping') // the number the tooltip explains
  })
})

describe('memory breakdown view', () => {
  it('the memory chip is a button that opens the breakdown', () => {
    const src = read('HostIndicators.tsx')
    expect(src).toContain('<button')
    expect(src).toContain('<HostMemoryView')
  })
  it('fetches via the hosts endpoint and refreshes while open', () => {
    const src = read('HostMemoryView.tsx')
    expect(src).toContain('trpc.hosts.memoryBreakdown.mutate()')
    expect(src).toContain('setInterval')
    expect(src).toContain('clearInterval')
  })
  it('separates agents, project processes, and the rest', () => {
    const src = read('HostMemoryView.tsx')
    expect(src).toContain('AGENTS & SHELLS')
    expect(src).toContain('PROJECT PROCESSES')
    expect(src).toContain('otherBytes')
    expect(src).toContain('supported') // totals-only fallback on hosts without /proc
  })
})
