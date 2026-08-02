/**
 * CROSS-BOUNDARY EDGES, RENDERED (POD-646).
 *
 * The seam this file protects had NO test before the port, and that is exactly
 * why it needs one: the old code was `issues.find(i => i.id === id)`, which
 * cannot distinguish invisible from deleted from not-yet-arrived, so there was
 * nothing to assert. Replacing a mechanism does not inherit its coverage — a
 * refactor that reintroduced "render not-visible as removed" INSIDE the new
 * resolver would have been silent.
 *
 * So the assertions here are about the DISTINCTION, not about the wiring:
 *
 *  - a visible target is a working link (the counterfactual — without it,
 *    "renders something inert" is satisfiable by a component that always does);
 *  - an INVISIBLE target renders the opaque sentence and LEAKS NOTHING: no ref,
 *    no title, no stage, no id anywhere in the DOM;
 *  - a DELETED target renders no edge at all, and is therefore distinguishable
 *    from the invisible one — the two must not collapse in either direction;
 *  - an absent target with no exit record renders the bare id, INERT and with no
 *    progressbar/status role, because a reference that can never resolve must
 *    not spin (doc §3.1 rule 2).
 */
import { cleanup, render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeIssue } from '@/lib/test-issue'
import {
  CROSS_BOUNDARY_POLICY,
  IssueEdgeLink,
  IssueExitProvider,
  OPAQUE_EDGE_LABEL,
  useIssueEdgeResolver,
} from './issue-edges'

const VISIBLE = makeIssue({ id: 'i-visible', seq: 7, title: 'A visible blocker' })

vi.mock('@/app/store', () => ({
  useReplicaIssues: () => [VISIBLE],
  useStoreSelector: (sel: (s: unknown) => unknown) => sel({} as never),
}))

afterEach(cleanup)

/** Renders one edge exactly as the page does, under an injected exit lookup. */
function Harness({
  targetId,
  exits = {},
  onNavigate = vi.fn(),
}: {
  targetId: string
  exits?: Record<string, 'removed' | 'evicted'>
  onNavigate?: (id: never) => void
}) {
  return (
    <IssueExitProvider exitOf={(id) => exits[id]}>
      <Edge targetId={targetId} onNavigate={onNavigate} />
    </IssueExitProvider>
  )
}

function Edge({ targetId, onNavigate }: { targetId: string; onNavigate: (id: never) => void }) {
  const resolve = useIssueEdgeResolver()
  return <IssueEdgeLink edge={resolve(targetId)} onNavigate={onNavigate} fallbackId={targetId} />
}

describe('the shipped cross-boundary policy', () => {
  it('is opaque — the constant IS the decision, so it is asserted', () => {
    // Not a tautology: this is the single call-site argument the slice requires,
    // and changing it changes what every edge on this page renders. A test that
    // named neither shape would let it flip silently.
    expect(CROSS_BOUNDARY_POLICY).toBe('opaque')
  })
})

describe('IssueEdgeLink', () => {
  it('renders a visible target as a working link', async () => {
    const onNavigate = vi.fn()
    render(<Harness targetId="i-visible" onNavigate={onNavigate} />)
    const link = screen.getByRole('button', { name: /visible blocker/i })
    await userEvent.click(link)
    expect(onNavigate).toHaveBeenCalledWith('i-visible')
  })

  it('renders an EVICTED target as an anonymous opaque reference, leaking nothing', () => {
    render(<Harness targetId="i-secret" exits={{ 'i-secret': 'evicted' }} />)
    expect(screen.getByTestId('issue-edge-opaque').textContent).toBe(OPAQUE_EDGE_LABEL)
    // The leak check, and the reason an opaque edge carries no `value`: the id we
    // were pointed at must not survive into the DOM in ANY attribute.
    expect(document.body.innerHTML).not.toContain('i-secret')
    // And it is not actionable — there is nothing to navigate to.
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('renders a REMOVED target as no edge at all — distinguishable from evicted', () => {
    const { container } = render(<Harness targetId="i-gone" exits={{ 'i-gone': 'removed' }} />)
    expect(container.textContent).toBe('')
    expect(screen.queryByTestId('issue-edge-opaque')).toBeNull()
  })

  it('renders an unresolved target as the inert id — never a spinner', () => {
    // No exit record (today's web replica cannot supply one), so the slice says
    // `pending`. Rule 2: pending must never spin forever, and this reference has
    // nothing that could ever end the spin.
    render(<Harness targetId="i-unknown" />)
    const pending = screen.getByTestId('issue-edge-pending')
    expect(pending.textContent).toBe('i-unknown')
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.queryByRole('progressbar')).toBeNull()
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('renders nothing for a null reference', () => {
    const { container } = render(<Harness targetId={null as unknown as string} />)
    expect(container.textContent).toBe('')
  })
})
