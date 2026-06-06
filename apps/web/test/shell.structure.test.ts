import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../src/${rel}`, import.meta.url)), 'utf8')

describe('web shell structure', () => {
  it('AppShell gates on connection and renders sidebar + workspace', () => {
    const src = read('AppShell.tsx')
    expect(src).toContain('ConnectScreen')
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
  it('repo add flow uses the server-side picker on desktop and mobile', () => {
    expect(read('Sidebar.tsx')).toContain('RepoPickerModal')
    expect(read('MobileApp.tsx')).toContain('RepoPickerModal')
  })
  it('repo picker hides hidden directories by default with a toggle', () => {
    const src = read('RepoPickerModal.tsx')
    expect(src).toContain('showHidden')
    expect(src).toContain('includeHidden')
    expect(src).toContain('Show hidden')
  })
  it('workspace renders the new-panel menu outside the scrolling tabbar', () => {
    const src = read('Workspace.tsx')
    expect(src).toContain('workspace-menu-layer')
    expect(src).toContain('NewPanelMenu')
  })
  it('new-panel menu offers claude, codex, and shell', () => {
    const src = read('NewPanelMenu.tsx')
    expect(src).toContain('New Claude')
    expect(src).toContain('New Codex')
    expect(src).toContain('New Shell')
  })
})
