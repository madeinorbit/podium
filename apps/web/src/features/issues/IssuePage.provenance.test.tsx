/**
 * The hub staleness indicator, rendered — POD-304's "UI staleness indicators
 * unchanged" criterion.
 *
 * This chip had NO coverage at any level before this file: not a component
 * test, not an e2e. So the read path moving from `issue.viaHub` to
 * `isViaHub(issue)` had nothing to protect it, which is precisely the situation
 * where a refactor quietly loses an indicator nobody looks at.
 *
 * Rendered through the real `IssuePage` rather than by calling the accessors,
 * because the accessors passing tells you nothing about whether the chip still
 * appears. All four provenance states are exercised, INCLUDING the local one —
 * the counterfactual that stops "the chip renders" from being satisfiable by a
 * chip that always renders.
 */

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeIssue } from '@/lib/test-issue'
import { IssuePage } from './IssuePage'

vi.mock('@/app/store', () => {
  const state = () =>
    ({
      trpc: {
        settings: { get: { query: vi.fn(async () => ({})) } },
        issues: {
          events: { query: vi.fn(async () => []) },
          comments: { query: vi.fn(async () => []) },
          addSession: { mutate: vi.fn() },
          addShell: { mutate: vi.fn() },
          start: { mutate: vi.fn() },
          update: { mutate: vi.fn() },
          addComment: { mutate: vi.fn() },
        },
      },
      hub: { onIssues: () => () => {} },
      machines: [],
      issues: [],
      setSelectedWorktree: vi.fn(),
      setPane: vi.fn(),
      setView: vi.fn(),
    }) as never
  return {
    useStore: () => state(),
    useStoreSelector: (sel: (s: unknown) => unknown) => sel(state()),
  }
})

afterEach(cleanup)

const show = (over: Parameters<typeof makeIssue>[0]) => {
  const issue = makeIssue({ id: 'i-1', repoPath: '/r', ...over })
  render(<IssuePage issue={issue} orderedIds={[issue.id]} onBack={vi.fn()} onNavigate={vi.fn()} />)
}

describe('hub provenance chip', () => {
  it('shows no chip for a locally-homed issue', () => {
    // The counterfactual for all three cases below.
    show({})
    expect(screen.queryByText('hub')).toBeNull()
    expect(screen.queryByText('hub · stale')).toBeNull()
    expect(screen.queryByText('hub · syncing')).toBeNull()
  })

  it('shows `hub` for a mirrored issue', () => {
    show({ viaHub: true })
    expect(screen.getByText('hub')).toBeTruthy()
    expect(screen.getByTitle('Mirrored from this node’s upstream hub')).toBeTruthy()
  })

  it('shows `hub · stale` when the hub is unreachable', () => {
    show({ viaHub: true, upstreamStale: true })
    expect(screen.getByText('hub · stale')).toBeTruthy()
    expect(
      screen.getByTitle('Mirrored from an unreachable hub — last-known state'),
    ).toBeTruthy()
  })

  it('shows `hub · syncing` when a local edit is queued upstream', () => {
    show({ viaHub: true, pendingSync: true })
    expect(screen.getByText('hub · syncing')).toBeTruthy()
    expect(screen.getByTitle('Edit queued for the hub — shown optimistically')).toBeTruthy()
  })

  it('prefers stale over syncing when both are set', () => {
    // Precedence is behaviour, not an accident of the ternary order: a stale
    // mirror is the more important thing to tell the user about, because the
    // value shown is not merely unconfirmed — it is old.
    show({ viaHub: true, upstreamStale: true, pendingSync: true })
    expect(screen.getByText('hub · stale')).toBeTruthy()
    expect(screen.queryByText('hub · syncing')).toBeNull()
  })

  it('ignores staleness flags with no `viaHub` — a local issue is never stale', () => {
    // Both flags are documented as "only ever set alongside viaHub"; a peer that
    // violates that must not make a local issue render as a hub mirror.
    show({ upstreamStale: true, pendingSync: true })
    expect(screen.queryByText('hub · stale')).toBeNull()
    expect(screen.queryByText('hub')).toBeNull()
  })
})
