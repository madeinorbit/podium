import { prefetchAfterFirstPaint } from '@/lib/prefetch-after-first-paint'

const board = () => import('@/features/issues/IssuesView')

/** Import real modules into this document's module map, beyond HTTP preloads. */
export const mainScreenImports = {
  board,
  deck: () => import('./FlightDeck'),
  issuePage: () => import('@/features/issues/IssuePage'),
  // Search is the board's task filter, with no separate lazy entry.
  search: board,
  workflows: () => import('@/features/workflows/WorkflowsView'),
  automations: () => import('@/features/automations/AutomationsView'),
  specs: () => import('@/features/specs/SpecsView'),
}

export function prefetchMainScreens(): () => void {
  return prefetchAfterFirstPaint(() =>
    Promise.allSettled(Object.values(mainScreenImports).map((load) => load())),
  )
}
