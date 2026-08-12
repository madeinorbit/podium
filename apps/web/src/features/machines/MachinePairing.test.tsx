import { asMachineId } from '@podium/model'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MachinePairing, type MachinePairingProps } from './MachinePairing'

afterEach(cleanup)

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

    expect(screen.getByRole('status').textContent).toMatch(/server url needed/i)
    fireEvent.click(screen.getByRole('button', { name: /set server url/i }))
    expect(onChangeUrl).toHaveBeenCalledTimes(1)
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

    expect(screen.getByRole('status').textContent).toMatch(/production vps.*ready for transfer/i)
    fireEvent.click(screen.getByRole('button', { name: /review transfer/i }))
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
})
