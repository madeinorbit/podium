/** Real mobile StoreProvider + real pool + real RN-web SectionList. Only
 * platform/navigation chrome is stubbed; rows, launch inputs and folds are real. */
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { Profiler, type ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ClientRuntime } from '@podium/client-core/engine'
import type { MobileTrpc } from '../client/trpc'
import type { MobilePool } from '../client/mobile-pool'
import type { MobileWorkSection } from '@podium/client-graph/worklist/mobile'
import { commandLaunchViews } from '@podium/client-graph/command-launch-views'
import { useStoreHandle } from '@podium/client-core/react'
import { buildCorpus } from '../../../../packages/worklist-proto/harness/src/fixture'
import { renderWithMobileStore } from '../client/test-support'

const state = vi.hoisted(() => ({ host: null as MobilePool | null, on: false,
  sections: [] as readonly MobileWorkSection[], runtime: null as ClientRuntime<MobileTrpc> | null,
  counts: new Map<string, number>(), sliceReads: 0, rowDerivations: 0, errors: [] as string[] }))
const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }))
vi.mock('expo-router', async () => {
  const { useEffect } = await import('react')
  return { useRouter: () => router, usePathname: () => '/work', Stack: { SearchBar: () => null },
    useFocusEffect: (effect: () => void) => useEffect(effect, [effect]) }
})
vi.mock('../client/mobile-pool', async importOriginal => {
  const real = await importOriginal<typeof import('../client/mobile-pool')>()
  return { ...real,
    mobileDataLayer: () => state.host!.layer(),
    useMobilePool: () => state.host!.host.usePool(),
    useMobilePoolProjection: (read: never, empty: never) => state.host!.host.usePoolProjection(read, empty),
    useMobileLaunchData: () => state.host!.host.usePoolProjection(readLaunch, null),
  }
})
function readLaunch(pool: Parameters<typeof commandLaunchViews>[0]) {
  const data = commandLaunchViews(pool).launch()
  return data && typeof data !== 'symbol' ? data : null
}
vi.mock('@podium/client-core/react', async importOriginal => {
  const real = await importOriginal<typeof import('@podium/client-core/react')>()
  return { ...real, useSlice: (...args: Parameters<typeof real.useSlice>) => {
    state.sliceReads++
    if (state.on) throw new Error('pool path subscribed to a legacy slice')
    return real.useSlice(...args)
  } }
})
vi.mock('@podium/client-core/viewmodels', async importOriginal => {
  const real = await importOriginal<typeof import('@podium/client-core/viewmodels')>()
  const guard = <T extends (...args: never[]) => unknown>(fn: T): T => ((...args: never[]) => {
    if (state.on) { state.rowDerivations++; throw new Error('pool row called a legacy row derivation') }
    return fn(...args)
  }) as T
  return { ...real, rowMotionPhase: guard(real.rowMotionPhase), rowHasWorkingSession: guard(real.rowHasWorkingSession),
    rowWaitingCount: guard(real.rowWaitingCount), rowPendingDecision: guard(real.rowPendingDecision),
    rowUnreadEmphasized: guard(real.rowUnreadEmphasized), isDraftAgentVessel: guard(real.isDraftAgentVessel),
    deriveFleetPresence: guard(real.deriveFleetPresence) }
})
vi.mock('react-native', async importOriginal => {
  const real = await importOriginal<typeof import('react-native')>()
  const { createElement } = await import('react')
  return { ...real, SectionList: (props: { sections: readonly MobileWorkSection[] }) => {
    state.sections = props.sections
    return createElement(real.SectionList, props as never)
  } }
})
vi.mock('../components/PressableScale', () => ({ PressableScale: ({ children, accessibilityLabel, onPress, onLongPress, ...props }: {
  children: ReactNode; accessibilityLabel?: string; onPress?: () => void; onLongPress?: () => void
}) => <Profiler id={accessibilityLabel ?? 'chrome'} onRender={(_, phase) => {
  if (phase === 'mount') return
  const key = accessibilityLabel?.match(/^([A-Z]+-\d+|#\d+) /)?.[1] ?? (accessibilityLabel?.startsWith('Worktree ') ? accessibilityLabel : null)
  if (key) state.counts.set(key, (state.counts.get(key) ?? 0) + 1)
}}><div data-label={accessibilityLabel} aria-label={accessibilityLabel} onClick={onPress} onContextMenu={onLongPress}
  {...('aria-expanded' in props ? { 'aria-expanded': props['aria-expanded'] as boolean } : {})}>{children}</div></Profiler> }))
vi.mock('../components/Screen', () => ({ Screen: ({ title, subtitle, right, children }: { title: string; subtitle: ReactNode; right: ReactNode; children: ReactNode }) =>
  <div><div>{title}{subtitle}{right}</div>{children}</div>, HeaderButton: ({ children, label, onPress }: { children: ReactNode; label: string; onPress: () => void }) =>
  <button aria-label={label} onClick={onPress}>{children}</button> }))
vi.mock('../components/LaunchPlaceholders', () => ({ BootstrapCrossfade: ({ resolved, children }: { resolved: boolean; children: ReactNode }) =>
  <div data-resolved={resolved}>{children}</div>, WorkSkeleton: () => null }))
vi.mock('../components/StorageNoticeAlert', () => ({ StorageNoticeAlert: () => null }))
vi.mock('../components/RefreshOffer', () => ({ RefreshOffer: () => null }))
vi.mock('../components/WorkspaceContinuityNotice', () => ({ WorkspaceContinuityNotice: () => null }))
vi.mock('../components/PullToRefreshBoundary', () => ({ PullToRefreshBoundary: ({ children }: { children: ReactNode }) => children }))
vi.mock('../components/BottomSheet', () => ({ BottomSheet: ({ visible, head, children }: { visible: boolean; head: ReactNode; children: ReactNode }) => visible ? <div>{head}{children}</div> : null }))
vi.mock('../components/WorkIssueMenu', () => ({ WorkIssueMenu: ({ target, issues, sessions }: { target: { issue: { id: string } }; issues: { id: string }[]; sessions: unknown[] }) =>
  <div data-testid="menu" data-issue={target.issue.id} data-issues={issues.length} data-sessions={sessions.length} /> }))
vi.mock('../hooks/useContentBottomInset', () => ({ useContentBottomInset: () => 0 }))
vi.mock('../hooks/useMinimizeTabBarOnScroll', () => ({ useMinimizeTabBarOnScroll: () => ({}) }))
vi.mock('../hooks/useReduceMotion', () => ({ useReduceMotion: () => true }))
vi.mock('../hooks/useRefreshableTab', async () => {
  const { useRef } = await import('react')
  return { useRefreshableTab: () => ({ listRef: useRef(null), refreshAccessibilityProps: {}, connected: true, refreshing: false, onRefresh: () => {} }) }
})
const { createMobilePool } = await import('../client/mobile-pool')
const { WorkScreen } = await import('./WorkScreen')

function Capture() { state.runtime = useStoreHandle<MobileTrpc>() as unknown as ClientRuntime<MobileTrpc>; return <WorkScreen /> }
async function mount(on: boolean, scale: 1 | 4) {
  state.on = on; state.sliceReads = 0; state.rowDerivations = 0; state.counts.clear(); state.errors.length = 0
  state.host = createMobilePool(false, () => ({ get: () => undefined, device: () => on }))
  state.host.initialize({} as Parameters<MobilePool['initialize']>[0])
  const corpus = buildCorpus(scale)
  vi.spyOn(Date, 'now').mockReturnValue(corpus.fixedNow)
  const view = await renderWithMobileStore(<Capture />, {
    issueProjections: corpus.issueProjections, issueUserStates: corpus.issueUserStates,
    issueGitStates: corpus.issueGitStates, repoProjections: corpus.repoProjections, issueDeps: corpus.issueDeps,
    sessions: corpus.sessions, repos: corpus.repos, machines: corpus.machines,
    attachRuntime: runtime => state.host!.host.attach(runtime, cause => { state.errors.push(cause.message) }),
  })
  await waitFor(() => expect(view.container.querySelector('[data-resolved="true"]')).not.toBeNull())
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)) })
  expect(state.errors).toEqual([])
  return { view, corpus }
}
function output(container: HTMLElement) {
  return { text: container.textContent,
    labels: [...container.querySelectorAll('[data-label]')].map(el => el.getAttribute('data-label')),
    styles: [...container.querySelectorAll('[style]')].map(el => el.getAttribute('style')) }
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); state.counts.clear() })

describe('mobile WorkScreen pool consumer', () => {
  for (const scale of [1, 4] as const) it(`same native rows, bands and look at ${scale}x with no legacy reader`, async () => {
    const legacy = await mount(false, scale)
    const expected = output(legacy.view.container)
    expect(state.sliceReads).toBeGreaterThan(0)
    legacy.view.unmount()
    const pool = await mount(true, scale)
    expect(output(pool.view.container)).toEqual(expected)
    expect(state.sliceReads).toBe(0)
    expect(state.rowDerivations).toBe(0)
    expect(state.sections.length).toBeGreaterThan(1)
    const keys = state.sections.flatMap(section => section.data.map(ref => ref.listKey))
    expect(new Set(keys).size).toBe(keys.length)
  }, 120_000)

  for (const scale of [1, 4] as const) it(`only commits changed paint, keeps native lane identity, and never exceeds legacy at ${scale}x`, async () => {
    const cells: unknown[] = []
    let legacyCounts: number[] = []
    for (const on of [false, true]) {
      const { view, corpus } = await mount(on, scale)
      const initial = output(view.container)
      const label = view.container.querySelector('[data-label^="POD-"]')!.getAttribute('data-label')!
      const seq = Number(label.match(/POD-(\d+)/)![1])
      const target = corpus.issueProjections.find(row => row.seq === seq)!
      expect(target).toBeDefined()
      const measure = async (kind: string, patch: Record<string, unknown>) => {
        const before = state.sections
        state.counts.clear()
        await act(async () => {
          view.replica.applySnapshot('issueProjections', corpus.issueProjections.map(row => row.id === target.id ? { ...row, ...patch } : row))
        })
        const commits = [...state.counts.values()].reduce((sum, n) => sum + n, 0)
        if (on) {
          expect([...state.counts.keys()].every(ref => ref === `POD-${seq}`), kind).toBe(true)
          expect(commits, kind).toBeLessThanOrEqual(legacyCounts[cells.filter((cell: unknown) => (cell as { on: boolean }).on).length]!)
          expect(state.sections, `${kind}: no section geometry changed`).toBe(before)
        }
        cells.push({ on, kind, commits })
        return commits
      }
      const counts = [await measure('unshown description', { description: 'bookkeeping only' }),
        await measure('shown title', { title: 'Native row renamed' })]
      if (on) expect(counts[0]).toBe(0)
      expect(counts[1]).toBeGreaterThan(0)
      expect(view.container.textContent).toContain('Native row renamed')
      if (!on) legacyCounts = counts
      expect(initial.text).not.toContain('Native row renamed')
      view.unmount()
    }
    console.info('[mobile commits]', JSON.stringify(cells))
  }, 120_000)

  it('search overrides folds, uses native match counts, and the pool menu resolves on long press', async () => {
    const { view, corpus } = await mount(true, 1)
    const project = state.sections.find(section => section.kind === 'project' && section.data.length > 0)!
    expect(project).toBeDefined()
    const before = state.sections
    fireEvent.click(screen.getByLabelText(`${project.label} · ${project.total}`))
    await waitFor(() => expect(state.sections.find(section => section.key === project.key)!.data).toHaveLength(0))
    for (const section of state.sections) if (section.key !== project.key) expect(section).toBe(before.find(old => old.key === section.key))
    fireEvent.click(screen.getByLabelText('Search work'))
    const ref = before[0]!.data[0]!
    const issue = state.runtime!.replica.rows('issueProjections').find(row => row.id === ref.id)!
    fireEvent.change(screen.getByLabelText('Search work', { selector: 'input' }), { target: { value: issue.title } })
    await waitFor(() => expect(state.sections.some(section => section.data.some(row => row.id === ref.id))).toBe(true))
    expect(state.sections.every(section => section.total === section.data.length)).toBe(true)
    expect(state.sections.flatMap(section => section.data).every(row => {
      const title = corpus.issueProjections.find(issue => issue.id === row.id)?.title
      return title?.toLowerCase().includes(issue.title.toLowerCase())
    })).toBe(true)
    const row = view.container.querySelector(`[data-label="POD-${issue.seq} ${issue.title}"]`)!
    fireEvent.contextMenu(row)
    await screen.findByTestId('menu')
    expect(screen.getByTestId('menu').getAttribute('data-issue')).toBe(ref.id)
    expect(state.sliceReads).toBe(0)
  }, 120_000)

  it('launch choices come from the existing pool without worklistSlice', async () => {
    await mount(true, 1)
    fireEvent.click(screen.getByLabelText('New work'))
    await waitFor(() => expect(screen.getAllByLabelText(/^Start in /).length).toBe(1))
    expect(state.sliceReads).toBe(0)
  }, 120_000)
})
