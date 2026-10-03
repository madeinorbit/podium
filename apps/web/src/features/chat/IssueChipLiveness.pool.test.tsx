import { chipPerf } from '@podium/client-core/perf'
import { MobxPool } from '@podium/client-graph'
import { act, type JSX, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { IssueChipLiveness } from './IssueChipLiveness'

const fixture = vi.hoisted(() => ({ pool: null as unknown, owner: {} }))
vi.mock('@podium/client-core/react', () => ({ useStoreHandle: () => fixture.owner }))
vi.mock('@/app/store', () => ({
  useReplicaIssues: () => {
    throw new Error('Pool chip called legacy list reader')
  },
}))
vi.mock('@/app/store-worklist-pool', () => ({ useWorklistPool: () => fixture.pool }))
