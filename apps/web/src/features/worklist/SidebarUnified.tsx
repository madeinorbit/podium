import type { JSX } from 'react'
import { PoolSidebarUnified, PoolWorkSections } from './pool-sidebar'

/** Both sidebar surfaces read the principal-owned pool. */
export function SidebarUnified(): JSX.Element {
  return <PoolSidebarUnified />
}
export function WorkSections({ query = '' }: { query?: string } = {}): JSX.Element {
  return <PoolWorkSections query={query} />
}
