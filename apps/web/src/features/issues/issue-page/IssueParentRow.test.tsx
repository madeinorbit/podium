/**
 * REPARENT AS A PERMISSION-AFFECTING OPERATION (POD-646, doc §3.1.5 case 2).
 *
 * Two shipped decisions, each tested for what it does AND for what it refuses to
 * do — the refusals are the load-bearing half:
 *
 *  1. The scope note is ALWAYS present. A user who cannot see that reparenting
 *     moves an agent's subtree scope cannot be said to have decided it.
 *  2. The cross-owner confirm fires ONLY on a known boundary crossing. The
 *     "unknown owner does not confirm" case is the one that matters on today's
 *     tree: `owner` is absent on every row right now, so a confirm keyed on
 *     "not equal" would fire on every reparent and be trained away long before
 *     the field is real.
 */

import type { IssueEdge } from '@podium/client-core/viewmodels'
import { cleanup, render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeIssue } from '@/lib/test-issue'
import {
  crossesOwnerBoundary,
  crossOwnerConfirmMessage,
  IssueParentRow,
  REPARENT_SCOPE_NOTE,
} from './IssueParentRow'

vi.mock('@/app/store', () => ({
  useReplicaIssues: () => [],
  useStoreSelector: (sel: (s: unknown) => unknown) => sel({} as never),
}))

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  Reflect.deleteProperty(window, 'confirm')
})

/** happy-dom ships no `window.confirm`, so there is nothing to spy ON — the
 *  stub is installed rather than wrapped. Named here because a bare
 *  `vi.spyOn(window, 'confirm')` fails with "can only spy on a function",
 *  which reads like a test-runner problem and is actually a missing global. */
const stubConfirm = (answer: boolean) => {
  const fn = vi.fn(() => answer)
  Object.defineProperty(window, 'confirm', { value: fn, configurable: true, writable: true })
  return fn
}

const PENDING_EDGE: IssueEdge = { resolution: { state: 'pending' }, render: 'pending' }

describe('crossesOwnerBoundary', () => {
  it('is true only when both owners are known and differ', () => {
    expect(crossesOwnerBoundary({ owner: 'alice' }, { owner: 'bob' })).toBe(true)
  })

  it('is false for the same owner', () => {
    expect(crossesOwnerBoundary({ owner: 'alice' }, { owner: 'alice' })).toBe(false)
  })

  it('is false when EITHER owner is unknown — missing data is not a crossing', () => {
    // The whole reason the confirm is usable today. Both directions, because a
    // one-sided check would still fire on half of the current tree.
    expect(crossesOwnerBoundary({ owner: undefined }, { owner: 'bob' })).toBe(false)
    expect(crossesOwnerBoundary({ owner: 'alice' }, { owner: undefined })).toBe(false)
    expect(crossesOwnerBoundary({ owner: undefined }, { owner: undefined })).toBe(false)
  })

  it('is false when there is no target at all — clearing the parent', () => {
    expect(crossesOwnerBoundary({ owner: 'alice' }, undefined)).toBe(false)
  })
})

describe('the parent row', () => {
  const renderRow = (
    issue: Parameters<typeof makeIssue>[0],
    mates: Parameters<typeof makeIssue>[0][],
    onSetParent = vi.fn(),
  ) => {
    const mateModels = mates.map((m) => makeIssue(m))
    render(
      <IssueParentRow
        issue={makeIssue(issue)}
        parentEdge={PENDING_EDGE}
        busy={false}
        mateOptions={mateModels.map((m) => ({ value: m.id, label: m.title }))}
        matesById={new Map(mateModels.map((m) => [m.id as string, m]))}
        onSetParent={onSetParent}
        onNavigate={vi.fn()}
      />,
    )
    return onSetParent
  }

  it('always states that reparenting changes agent scope', () => {
    renderRow({ id: 'i-1' }, [])
    expect(screen.getByTestId('reparent-scope-note').textContent).toBe(REPARENT_SCOPE_NOTE)
    expect(REPARENT_SCOPE_NOTE).toMatch(/which agents can see this issue/)
  })

  it('confirms — and can be cancelled — when the move crosses a known owner boundary', async () => {
    const confirm = stubConfirm(false)
    const onSetParent = renderRow({ id: 'i-1', owner: 'alice' }, [
      { id: 'i-epic', seq: 9, title: 'Bobs epic', owner: 'bob' },
    ])
    await userEvent.click(screen.getByRole('button', { name: /no parent/i }))
    await userEvent.click(await screen.findByText('Bobs epic'))

    expect(confirm).toHaveBeenCalledWith(
      crossOwnerConfirmMessage(makeIssue({ id: 'i-epic', seq: 9, title: 'Bobs epic' })),
    )
    // Cancelled means NOT moved — the confirm has to be able to stop the write.
    expect(onSetParent).not.toHaveBeenCalled()
  })

  it('does NOT confirm when the owners are unknown — the single-user case', async () => {
    const confirm = stubConfirm(true)
    const onSetParent = renderRow({ id: 'i-1' }, [{ id: 'i-epic', seq: 9, title: 'An epic' }])
    await userEvent.click(screen.getByRole('button', { name: /no parent/i }))
    await userEvent.click(await screen.findByText('An epic'))

    expect(confirm).not.toHaveBeenCalled()
    expect(onSetParent).toHaveBeenCalledWith('i-epic')
  })

  it('does not confirm when clearing the parent', async () => {
    const confirm = stubConfirm(true)
    const onSetParent = renderRow({ id: 'i-1', owner: 'alice', parentId: 'i-epic' }, [
      { id: 'i-epic', seq: 9, title: 'Bobs epic', owner: 'bob' },
    ])
    // The trigger reads "No parent" whenever the parent does not RESOLVE, even
    // though `parentId` is set — unchanged from before the port, and the reason
    // the menu item is addressed by role rather than by text here.
    await userEvent.click(screen.getByRole('button', { name: /no parent/i }))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'No parent' }))

    expect(confirm).not.toHaveBeenCalled()
    expect(onSetParent).toHaveBeenCalledWith(null)
  })
})
