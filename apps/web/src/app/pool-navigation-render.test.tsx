import { type EngineState, workspaceKeyForState } from '@podium/client-core/engine'
import type { IssueViewModel } from '@podium/client-core/replica'
import { routeDefaults } from '@podium/client-core/ui-state'
import { emptyWorkspace, openTab } from '@podium/client-core/viewmodels'
import { createRuntimeWorklistPool } from '@podium/client-graph/runtime-pool'
import { computed } from '@podium/client-graph/react'
import { asIssueId } from '@podium/model/browser'
import { cleanup, render } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { planNavigation } from '../../../../packages/client-core/src/engine/navigation'
import { startScenarioEngine } from '../../../../packages/worklist-proto/shared/src/scenarios'
import { createPoolNavigationProvider } from './pool-navigation-provider'
import { NAVIGATION_SUMMARIES } from './pane-pool-screen'

const binding = vi.hoisted(() => ({ state: {} as EngineState, issues: [] as IssueViewModel[] }))
vi.mock('./store', () => ({
  useStoreSelector: (select: (state: EngineState) => unknown) => select(binding.state),
  useReplicaIssues: () => binding.issues,
}))
vi.mock('@/features/terminal/AgentPanelBoundary', () => ({ AgentPanelBoundary: () => <div /> }))
vi.mock('@/features/terminal/use-warm-set', () => ({ useWarmSet: (ids: string[]) => new Set(ids) }))
vi.mock('@/features/setup/ColdStartComposer', () => ({ ColdStartComposer: () => <div /> }))
vi.mock('./NewPanelMenu', () => ({ NewPanelMenu: ({ trigger }: { trigger: ReactNode }) => trigger }))
vi.mock('./operator-focus', () => ({ useOperatorFocus: () => ({ focusedIssueId: null, setFocusedIssueId: vi.fn() }) }))
vi.mock('@podium/client-core/react', async original => ({
  ...await original<typeof import('@podium/client-core/react')>(),
  useHarnessDescriptors: () => ({ served: [] }),
}))
vi.mock('@/lib/use-feature', () => ({ useFeature: () => false }))
const { Workspace } = await import('./Workspace')
afterEach(cleanup)

// Keep every rendered text node and ordered layout/label attribute. Generated
// React ids differ between mounts and do not describe screen content.
const output = (container: HTMLElement) => Array.from(container.querySelectorAll('*'), element => ({
  tag: element.tagName,
  attributes: ['class', 'style', 'role', 'aria-label', 'title', 'data-testid', 'data-tab-drag-id', 'data-pane-id', 'aria-selected']
    .map(name => [name, element.getAttribute(name)]),
  text: Array.from(element.childNodes).filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent),
}))

it('renders identical workspace labels, tab order and layout after pool navigation', async () => {
  const ctx = await startScenarioEngine(1, { start: false, ownRows: true })
  const runtime = ctx.engine
  const handle = createRuntimeWorklistPool(runtime, { summaries: NAVIGATION_SUMMARIES })
  const provider = createPoolNavigationProvider(handle.pool)
  try {
    const initial = runtime.getSnapshot()
    const target = asIssueId(ctx.targets.visibleRootId)
    const child = initial.issueProjections.find(row => row.parentId === target && !row.archived && !row.deletedAt)!
    const seats = initial.sessions.filter(row => !row.archived && row.issueId === target).slice(0, 2)
    expect(seats).toHaveLength(2)
    const key = workspaceKeyForState({ ...initial, selectedIssueId: child.id })
    let layout = emptyWorkspace(key)
    for (const seat of seats) layout = openTab(layout, seat.sessionId, { permanent: true })
    let legacy: EngineState = { ...initial, workspaces: { [key]: layout } }
    let pool: EngineState = { ...legacy, navigation: provider }
    let route = routeDefaults('issues')
    binding.issues = initial.issueProjections as unknown as IssueViewModel[]
    const screen = (state: EngineState) => {
      binding.state = { ...state, workspaceKey: () => workspaceKeyForState(state) } as EngineState
      const view = render(<Workspace />)
      const result = output(view.container)
      expect(view.container.querySelectorAll('[data-tab-drag-id]').length).toBeGreaterThan(0)
      view.unmount()
      return result
    }
    for (const id of [child.id, target, child.id]) {
      const intent = { view: 'workspace' as const, selectedIssueId: id, tabId: seats[0]!.sessionId }
      const context = { visible: true, now: initial.issueProjections[0]!.updatedAt }
      const expected = planNavigation(legacy, route, intent, context)
      const actual = computed(() => planNavigation(pool, route, intent, context)).get()
      expect(actual.pending).toBe(false)
      legacy = { ...legacy, ...expected.patch }
      pool = { ...pool, ...actual.patch }
      expect(screen(pool)).toEqual(screen(legacy))
      route = expected.route
    }
  } finally { handle.dispose(); runtime.destroy() }
}, 60_000)
