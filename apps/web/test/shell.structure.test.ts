// @vitest-environment node
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

// This file is deliberately narrow: source-grep assertions that only check a
// symbol is present bitrot without guarding behavior, so POD-619 removed them.
// What survives guards a documented regression (the negative "must NOT contain"
// invariants) or an issue-cited layout contract.
describe('web shell structure', () => {
  it('AppShell auto-resolves the relay (no manual connect screen)', () => {
    const src = read('app/AppShell.tsx')
    // The relay address is derived automatically via serverConfig — never typed
    // by the user; the old ConnectScreen must never come back.
    expect(src).toContain('serverConfig')
    expect(src).not.toContain('ConnectScreen')
  })

  it('sidebar renders always-on project groups and the pinned issue section (#41, POD-166/169)', () => {
    const src = read('features/worklist/SidebarUnified.tsx')
    expect(src).toContain('sidebarSections')
    expect(src).toContain('groupUnifiedWorkRows')
    expect(src).toContain('ProjectGroupLabel')
    // Panel-pinning is retired (POD-169) — issue pinning renders its own section.
    expect(src).toContain('splitPinnedWork')
    expect(src).not.toContain('setPinned')
  })

  it('workspace tabs keep the fixed actions outside the sortable scrolling strip', () => {
    const src = read('app/Workspace.tsx')
    // The fixed actions (new-panel menu, split) render OUTSIDE the sortable
    // scrolling strip — after the DndContext closes — so they never scroll away.
    expect(src.indexOf('<NewPanelMenu')).toBeGreaterThan(src.indexOf('</DndContext>'))
    // Clicks must keep working: drags only start after the pointer moves.
    expect(src).toContain('activationConstraint')
  })

  it('repo add flow uses the scan flow (#227)', () => {
    // AppToolsRow owns the scan flow; desktop composes it into the sidebar.
    expect(read('features/worklist/SidebarUnified.tsx')).toContain('RepoScanFlow')
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
})

describe('memory breakdown view', () => {
  it('fetches the clicked machine breakdown via the hosts endpoint and refreshes while open (#136)', () => {
    const src = read('features/machines/HostMemoryView.tsx')
    // Machine-aware: the breakdown is requested for the clicked machine (#136),
    // not always the first online daemon.
    expect(src).toContain(
      'trpc.hosts.memoryBreakdown.mutate(machineId ? { machineId } : undefined)',
    )
    expect(src).toContain('setInterval')
    expect(src).toContain('clearInterval')
  })
})
