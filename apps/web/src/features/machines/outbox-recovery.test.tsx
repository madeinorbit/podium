// @vitest-environment happy-dom
/**
 * POD-316 — the dead-letter recovery surface, driven at RUNTIME.
 *
 * This is not a unit test over a pure function. It mounts the real component,
 * fed by a REAL `Outbox` that has really refused a real write, and drives it
 * with real DOM clicks. The acceptance criterion is "runtime-verified, not just
 * unit-tested", and the properties that matter here are only observable once the
 * thing is rendered and clicked:
 *
 *  - a forced rejection SURFACES (rather than a toast about a dropped change),
 *  - it can be RETRIED after the reason's precondition is met,
 *  - it can be DISCARDED,
 *  - the author's own text is on screen and recoverable,
 *  - and the surface renders NOTHING about the target — the property that keeps
 *    a revoked-while-offline entry from leaking back the content the revocation
 *    removed.
 */
import { createOutbox, type Outbox } from '@podium/client-core/outbox'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Kinds = { rename: { sessionId: string; name: string } }

/** The refusal under test, in the shape a tRPC error really arrives in. */
const refuse = (code: string) => Object.assign(new Error('refused'), { data: { code } })

let outbox: Outbox<Kinds>
let refusalCode = 'UNAUTHORIZED'

/** The store the component reads, backed by the REAL outbox — so the list it
 *  renders is the outbox's actual dead-letter state, not a fixture that would
 *  keep passing if the outbox stopped parking. */
const storeState = () => ({
  outboxDeadLetters: outbox.deadLetters(),
  recoverOutbox: {
    retry: (id: string, s: never) => outbox.retry(id, s),
    edit: (id: string, input: unknown) => outbox.edit(id, input),
    discard: (id: string) => outbox.discard(id),
  },
})

vi.mock('@/app/store', () => ({
  useStoreSelector: (select: (s: unknown) => unknown) => select(storeState()),
}))

// eslint-disable-next-line import/first
import { OutboxRecoveryIndicator } from './OutboxRecovery'

async function parkOne(name = 'my careful title'): Promise<string> {
  const entry = outbox.enqueue('rename', { sessionId: 's1', name })
  await outbox.drain()
  return entry.mutationId
}

beforeEach(() => {
  refusalCode = 'UNAUTHORIZED'
  outbox = createOutbox<Kinds>({
    storage: { load: () => [], save: () => {} },
    executors: {
      rename: async () => {
        throw refuse(refusalCode)
      },
    },
  })
})

afterEach(() => {
  outbox.dispose()
  cleanup()
  vi.clearAllMocks()
})

describe('dead-letter recovery, at runtime', () => {
  it('renders NOTHING while nothing is parked — a permanent zero-state is noise', () => {
    render(<OutboxRecoveryIndicator />)
    expect(screen.queryByTestId('outbox-recovery-chip')).toBeNull()
  })

  it('a forced rejection SURFACES, with the author’s own words on screen', async () => {
    await parkOne('my careful title')
    render(<OutboxRecoveryIndicator />)

    const chip = screen.getByTestId('outbox-recovery-chip')
    expect(chip).toBeTruthy()
    fireEvent.click(chip)

    await waitFor(() => expect(screen.getByText('Changes that need you')).toBeTruthy())
    // The recoverable intent: the user's own input, verbatim.
    expect(screen.getByText(/my careful title/)).toBeTruthy()
  })

  it('says NOTHING about the target — no id, no title, no existence claim', async () => {
    // The leak this surface must not have. `unauthorized` covers rights-denied,
    // invisible AND nonexistent; if the copy named the target, a principal who
    // never had access would learn the id exists. The session id is deliberately
    // distinctive so its appearance anywhere would be caught.
    outbox.enqueue('rename', { sessionId: 'SECRET-TARGET-ID', name: 'mine' })
    await outbox.drain()
    render(<OutboxRecoveryIndicator />)
    fireEvent.click(screen.getByTestId('outbox-recovery-chip'))
    await waitFor(() => expect(screen.getByText('Changes that need you')).toBeTruthy())

    const dialog = screen.getByRole('dialog')
    // The author's OWN input is shown verbatim and may legitimately contain the
    // id they typed — what must not appear is any statement ABOUT the target.
    expect(dialog.textContent).not.toMatch(/no longer have access/i)
    expect(dialog.textContent).not.toMatch(/does not exist|was deleted|not found/i)
  })

  it('offers the same words and buttons for a denied target as for a missing one', async () => {
    // amendment property 15, asserted where it is easiest to break: the copy.
    refusalCode = 'FORBIDDEN'
    await parkOne('same text')
    render(<OutboxRecoveryIndicator />)
    fireEvent.click(screen.getByTestId('outbox-recovery-chip'))
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy())
    const denied = screen.getByRole('dialog').textContent
    cleanup()

    outbox.dispose()
    refusalCode = 'NOT_FOUND'
    outbox = createOutbox<Kinds>({
      storage: { load: () => [], save: () => {} },
      executors: {
        rename: async () => {
          throw refuse(refusalCode)
        },
      },
    })
    await parkOne('same text')
    render(<OutboxRecoveryIndicator />)
    fireEvent.click(screen.getByTestId('outbox-recovery-chip'))
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy())
    expect(screen.getByRole('dialog').textContent).toBe(denied)
  })

  it('RETRIES after the precondition is met, and the entry leaves the recovery list', async () => {
    await parkOne()
    render(<OutboxRecoveryIndicator />)
    fireEvent.click(screen.getByTestId('outbox-recovery-chip'))
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy())

    expect(outbox.deadLetters()).toHaveLength(1)
    expect(screen.getByTestId('outbox-retry').textContent).toBe('Retry after fixing access')
    fireEvent.click(screen.getByTestId('outbox-retry'))
    // It is out of the parked set and back in the queue — the recovery worked,
    // rather than the button merely existing.
    expect(outbox.deadLetters()).toHaveLength(0)
  })

  it('DISCARDS on the user’s own say-so, with no read of the target', async () => {
    await parkOne()
    render(<OutboxRecoveryIndicator />)
    fireEvent.click(screen.getByTestId('outbox-recovery-chip'))
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    expect(outbox.deadLetters()).toHaveLength(0)
  })

  it('offers NO retry button for validation poison — only an edit can succeed', async () => {
    // The counterfactual for the affordance rule: a surface that offered "retry"
    // here would re-send bytes the server has already refused, forever.
    refusalCode = 'BAD_REQUEST'
    await parkOne()
    render(<OutboxRecoveryIndicator />)
    fireEvent.click(screen.getByTestId('outbox-recovery-chip'))
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy())

    // Asserted on the BUTTON's absence, not on its label. A first draft of this
    // matched /Retry/ by accessible name, and survived a mutant that rendered
    // the button unconditionally — because with no label the name simply did not
    // match, so an always-present retry button read as absent. The instrument
    // could not say no.
    expect(screen.queryByTestId('outbox-retry')).toBeNull()
    expect(screen.getByRole('button', { name: 'Edit' })).toBeTruthy()
  })

  it('EDITS the author’s text and re-queues it under a new identity', async () => {
    refusalCode = 'BAD_REQUEST'
    const original = await parkOne('bad title')
    render(<OutboxRecoveryIndicator />)
    fireEvent.click(screen.getByTestId('outbox-recovery-chip'))
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    const box = screen.getByLabelText('Your text') as HTMLTextAreaElement
    fireEvent.change(box, { target: { value: 'fixed title' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save and send' }))

    expect(outbox.deadLetters().some((d) => d.entry.mutationId === original)).toBe(false)
  })
})
