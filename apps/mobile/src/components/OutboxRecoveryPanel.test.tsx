import { asMutationId } from '@podium/model'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Alert } from 'react-native'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mobile = vi.hoisted(() => ({
  state: {} as {
    outboxDeadLetters: unknown[]
    recoverOutbox: {
      retry: ReturnType<typeof vi.fn>
      edit: ReturnType<typeof vi.fn>
      discard: ReturnType<typeof vi.fn>
    }
  },
}))

vi.mock('../client/use-pool-notices', () => ({ usePoolRecovery: () => mobile.state.outboxDeadLetters }))

vi.mock('@podium/client-core/react', () => ({ useStoreHandle: () => ({ getSnapshot: () => mobile.state }) }))

import { OutboxRecoveryPanel } from './OutboxRecoveryPanel'

function parked(code: 'invalid' | 'conflict' | 'max-age' = 'invalid') {
  return {
    entry: {
      mutationId: asMutationId('mutation-one'),
      kind: 'issueUpdate',
      input: { id: 'SECRET-TARGET', patch: { title: 'careful words' } },
      queuedAt: 1,
      state: 'dead-letter' as const,
    },
    reason: { code },
    parkedFrom: 'rejected' as const,
    deadLetteredAt: 2,
    attempts: 1,
  }
}

beforeEach(() => {
  mobile.state = {
    outboxDeadLetters: [parked()],
    recoverOutbox: { retry: vi.fn(), edit: vi.fn(), discard: vi.fn() },
  }
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('mobile parked-write recovery', () => {
  it('shows only the author input and edits it through the shared store action', () => {
    render(<OutboxRecoveryPanel />)

    expect(screen.getByText('careful words')).toBeTruthy()
    expect(screen.queryByText('SECRET-TARGET')).toBeNull()
    expect(screen.queryByTestId('outbox-retry')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    const editor = screen.getByLabelText('Your text') as HTMLTextAreaElement
    fireEvent.change(editor, { target: { value: 'repaired words' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send updated' }))

    expect(mobile.state.recoverOutbox.edit).toHaveBeenCalledWith(asMutationId('mutation-one'), {
      id: 'SECRET-TARGET',
      patch: { title: 'repaired words' },
    })
  })

  it('derives retry satisfaction from the shared conflict recovery plan', () => {
    mobile.state.outboxDeadLetters = [parked('conflict')]
    render(<OutboxRecoveryPanel />)

    fireEvent.click(screen.getByTestId('outbox-retry'))

    expect(mobile.state.recoverOutbox.retry).toHaveBeenCalledWith(asMutationId('mutation-one'), {
      expectedRevision: 0,
    })
  })

  it('re-issues an aged-out change and leaves the id to the queue (POD-4762)', () => {
    mobile.state.outboxDeadLetters = [parked('max-age')]
    render(<OutboxRecoveryPanel />)

    fireEvent.click(screen.getByTestId('outbox-retry'))

    // No id minted here: the queue keeps the same one while a receipt for it is
    // certain (a chat message that gave up), and mints a fresh one after.
    expect(mobile.state.recoverOutbox.retry).toHaveBeenCalledWith(asMutationId('mutation-one'), {
      reissue: true,
    })
  })

  it('requires destructive confirmation before discarding the saved change', () => {
    vi.spyOn(Alert, 'alert').mockImplementation((_title, _message, buttons) => {
      buttons?.find((button) => button.style === 'destructive')?.onPress?.()
    })
    render(<OutboxRecoveryPanel />)

    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))

    expect(mobile.state.recoverOutbox.discard).toHaveBeenCalledWith(asMutationId('mutation-one'))
  })
})
