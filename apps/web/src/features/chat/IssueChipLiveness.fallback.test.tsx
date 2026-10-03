import type { IssueReferenceSource } from '@podium/client-core/viewmodels'
import { MobxPool } from '@podium/client-graph'
import { parseAnyRef } from '@podium/protocol'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { renderMarkdown } from '@/lib/markdown'
import { setKnownRefPrefixes } from '@/lib/markdown-references'
import { IssueChipLiveness } from './IssueChipLiveness'

const fixture = vi.hoisted(() => ({
  layer: 'legacy' as 'legacy' | 'pool',
  pool: null as unknown,
  owner: {},
  issues: [] as IssueReferenceSource[],
}))
vi.mock('@podium/client-core/react', () => ({ useStoreHandle: () => fixture.owner }))
vi.mock('@/app/store', () => ({ useReplicaIssues: () => fixture.issues }))
vi.mock('@/app/store-worklist-pool', () => ({ useWorklistPool: () => fixture.pool }))
