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
  it('repo add flow uses the scan flow on desktop and mobile', () => {
    expect(read('Sidebar.tsx')).toContain('RepoScanFlow')
    expect(read('MobileApp.tsx')).toContain('RepoScanFlow')
  })
  it('sidebar work panels navigate directly to the panel when clicked', () => {
    const src = read('Sidebar.tsx')
    // Each panel row is an interactive button (not an inert div) that focuses the
    // session: select its worktree and point pane A at it.
    expect(src).toContain("className={panelActive ? 'panel-row active' : 'panel-row'}")
    expect(src).toContain('setSelectedWorktree(wt.path)')
    expect(src).toContain("setPane('A', s.sessionId)")
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
    expect(src).toContain('void refreshRepos()')
    expect(src).not.toContain('Promise.all([refreshRepos(), rescanConversations()])')
  })
  it('new-panel menu offers claude, codex, and shell', () => {
    const src = read('NewPanelMenu.tsx')
    expect(src).toContain('New Claude')
    expect(src).toContain('New Codex')
    expect(src).toContain('New Shell')
  })
  it('new-panel menu refreshes resumable conversations when opened', () => {
    const src = read('NewPanelMenu.tsx')
    expect(src).toContain('useEffect')
    expect(src).toContain('void rescanConversations().catch')
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
  it('renders nothing without a reporting daemon and labels hosts only when several report', () => {
    const src = read('HostIndicators.tsx')
    expect(src).toContain('hostMetrics.length === 0) return null')
    expect(src).toContain('hostMetrics.length > 1')
    expect(src).toContain('hostMemoryView')
  })
})
