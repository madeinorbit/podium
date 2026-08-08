import type { ReactNode } from 'react'

/** Native scrolling owns the gesture through RefreshControl on the child list. */
export function PullToRefreshBoundary({ children }: { children: ReactNode }) {
  return children
}
