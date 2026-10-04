import { EXECUTION_PROFILE_DEFAULT_HARNESS } from '@podium/runtime'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '@/test-support/mock-screen-pool'
import { ExecutionProfiles } from './ExecutionProfiles'

vi.mock('@podium/client-core/react', async (original) => ({
  ...(await original<typeof import('@podium/client-core/react')>()),
  useStoreHandle: () => ({}),
}))

vi.mock('@/app/store', () => ({
  useRuntimeSelector: (sel: (s: unknown) => unknown) =>
    sel({ machines: [], issues: [], sessions: [], trpc: {} } as never),
}))

afterEach(cleanup)

describe('ExecutionProfiles preset default (POD-4737 D6)', () => {
  /**
   * New presets open on the named product preset harness — not a literal in
   * the component, and deliberately not the new-work default. If the policy
   * moves, this follows it with no edit here.
   */
  it('opens a new profile on the named preset harness', () => {
    render(
      <ExecutionProfiles
        source={{
          workflows: [],
          bindings: [],
          profiles: [],
          runs: [],
          detail: null,
          selectedId: null,
          loading: false,
          refreshing: false,
          error: null,
          notice: null,
          showHistory: false,
          select: () => {},
          setShowHistory: () => {},
          refresh: () => Promise.resolve(),
          dispatch: () => Promise.resolve(true),
        }}
        rights={{ write: true, publish: false, advance: false, manageProfiles: false }}
      />,
    )
    const harness = screen.getByLabelText('Harness') as HTMLSelectElement
    expect(harness.value).toBe(EXECUTION_PROFILE_DEFAULT_HARNESS)
  })
})
