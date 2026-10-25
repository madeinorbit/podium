import type { JSX } from 'react'
import { PoolSidebarUnified, PoolWorkSections } from './pool-sidebar'

/** The sidebar reads the principal-owned pool. */
export function SidebarUnified(): JSX.Element {
  return <PoolSidebarUnified />
}
export function WorkSections({ query = '' }: { query?: string } = {}): JSX.Element {
  return <PoolWorkSections query={query} />
}
