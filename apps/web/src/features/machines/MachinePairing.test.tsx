import { asMachineId } from '@podium/model'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MachinePairing, type MachinePairingProps } from './MachinePairing'

const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard)
  else Reflect.deleteProperty(navigator, 'clipboard')
})

function stubClipboard(writeText: (value: string) => Promise<void>): void {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  })
}

function props(overrides: Partial<MachinePairingProps> = {}): MachinePairingProps {
  return {
    pairingCode: null,
    joinCommand: null,
    publicUrl: null,
    loading: false,
    error: null,
    podiumManaged: true,
    recommendServer: false,
    makeServerAfterPair: false,
    newMachine: null,
    onManagedChange: vi.fn(),
    onMakeServerAfterPairChange: vi.fn(),
    onChangeUrl: vi.fn(),
    onReviewPairedMachine: vi.fn(),
    ...overrides,
  }
}

describe('MachinePairing', () => {
  it('announces the initial wait without exposing incomplete controls', () => {
    render(<MachinePairing {...props({ loading: true })} />)

    expect(screen.getByRole('status').textContent).toMatch(/generating pairing code/i)
    expect(screen.queryByRole('button', { name: /copy command/i })).toBeNull()
  })

  it('shows a controller error verbatim in an alert', () => {
    render(<MachinePairing {...props({ error: 'pairing is disabled on this server' })} />)

    expect(screen.getByRole('alert').textContent).toMatch(/pairing is disabled on this server/i)
  })

  it('presents the one-line command and relays controlled choices', () => {
    const onManagedChange = vi.fn()
    const onMakeServerAfterPairChange = vi.fn()
    const onChangeUrl = vi.fn()
    render(
      <MachinePairing
        {...props({
          pairingCode: 'ABCD-EFGH',
          joinCommand: 'curl -fsSL https://podium.example/join | sh -s -- ABCD-EFGH',
          publicUrl: 'https://podium.example',
          recommendServer: true,
          makeServerAfterPair: true,
          onManagedChange,
          onMakeServerAfterPairChange,
          onChangeUrl,
        })}
      />,
    )

    expect(screen.getByTitle(/curl -fsSL/).textContent).toMatch(/^curl -fsSL/)
    fireEvent.click(screen.getByRole('checkbox', { name: /podium-managed machine/i }))
    fireEvent.click(
      screen.getByRole('checkbox', {
        name: /recommended: make this the server/i,
      }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Change…' }))

    expect(onManagedChange).toHaveBeenCalledWith(false)
    expect(onMakeServerAfterPairChange).toHaveBeenCalledWith(false)
    expect(onChangeUrl).toHaveBeenCalledTimes(1)
  })

  it('offers network setup when a code cannot yet include a join command', () => {
    const onChangeUrl = vi.fn()
    render(
      <MachinePairing
        {...props({
          pairingCode: 'ABCD-EFGH',
          joinCommand: null,
          onChangeUrl,
        })}
      />,
    )

    expect(screen.getByText('Server URL needed').parentElement?.textContent).toMatch(
      /finish network setup/i,
    )
    fireEvent.click(screen.getByRole('button', { name: /set server url/i }))
    expect(onChangeUrl).toHaveBeenCalledTimes(1)
  })

  it('keeps VPS ownership choices out of the primary pairing path', () => {
    render(
      <MachinePairing
        {...props({
          pairingCode: 'ABCD-EFGH',
          joinCommand: 'podium join ABCD-EFGH',
          publicUrl: 'https://podium.example',
          recommendServer: true,
          makeServerAfterPair: true,
          variant: 'vps',
        })}
      />,
    )

    expect(screen.getByText('Ready for an always-on Podium server')).toBeTruthy()
    expect(screen.getByText('Advanced VPS options')).toBeTruthy()
    expect(screen.getByRole('checkbox', { name: /let podium manage agent tools/i })).toBeTruthy()
    expect(screen.getByRole('checkbox', { name: /move the podium server here/i })).toBeTruthy()
    expect(screen.queryByText('Podium-managed machine')).toBeNull()
    expect(screen.queryByText('Recommended: make this the server')).toBeNull()
  })

  it('announces the newly paired machine and exposes review as an explicit action', () => {
    const onReviewPairedMachine = vi.fn()
    render(
      <MachinePairing
        {...props({
          pairingCode: 'ABCD-EFGH',
          joinCommand: 'podium join ABCD-EFGH',
          newMachine: { id: asMachineId('vps'), name: 'Production VPS' },
          onReviewPairedMachine,
        })}
      />,
    )

    const review = screen.getByRole('button', { name: /review transfer/i })
    expect(review.parentElement?.textContent).toMatch(/production vps.*ready for transfer/i)
    fireEvent.click(review)
    expect(onReviewPairedMachine).toHaveBeenCalledTimes(1)
  })

  it('disables pairing choices and actions while a remint is pending', () => {
    render(
      <MachinePairing
        {...props({
          pairingCode: 'ABCD-EFGH',
          joinCommand: 'podium join ABCD-EFGH',
          loading: true,
          newMachine: { id: asMachineId('vps'), name: 'VPS' },
        })}
      />,
    )

    expect(screen.getByRole('checkbox', { name: /podium-managed machine/i })).toHaveProperty(
      'disabled',
      true,
    )
    expect(screen.getByRole('button', { name: /copy command/i })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: /review transfer/i })).toHaveProperty(
      'disabled',
      true,
    )
  })

  it('announces successful copy feedback to assistive technology', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    stubClipboard(writeText)
    render(
      <MachinePairing
        {...props({ pairingCode: 'ABCD-EFGH', joinCommand: 'podium join ABCD-EFGH' })}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /copy command/i }))

    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toBe('Command copied to clipboard.'),
    )
    expect(writeText).toHaveBeenCalledWith('podium join ABCD-EFGH')
  })

  it('handles clipboard rejection and offers a retry without an unhandled promise', async () => {
    stubClipboard(vi.fn().mockRejectedValue(new Error('clipboard permission denied')))
    render(
      <MachinePairing
        {...props({ pairingCode: 'ABCD-EFGH', joinCommand: 'podium join ABCD-EFGH' })}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /copy command/i }))

    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toMatch(/select and copy it manually/i),
    )
    expect(screen.getByRole('button', { name: /try copy again/i })).toBeTruthy()
  })

  it('clears copy feedback timers across remints and unmount', async () => {
    vi.useFakeTimers()
    stubClipboard(vi.fn().mockResolvedValue(undefined))
    const view = render(
      <MachinePairing {...props({ pairingCode: 'FIRST', joinCommand: 'podium join FIRST' })} />,
    )

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /copy command/i }))
      await Promise.resolve()
    })
    expect(vi.getTimerCount()).toBe(1)

    view.rerender(
      <MachinePairing {...props({ pairingCode: 'SECOND', joinCommand: 'podium join SECOND' })} />,
    )
    expect(vi.getTimerCount()).toBe(0)
    expect(screen.queryByText('Command copied to clipboard.')).toBeNull()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /copy command/i }))
      await Promise.resolve()
    })
    expect(vi.getTimerCount()).toBe(1)
    view.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })
})
