import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  SERVER_TRANSFER_CONFIRMATION,
  ServerTransfer,
  ServerTransferProgress,
  type ServerTransferProps,
} from './ServerTransfer'

afterEach(cleanup)

function props(overrides: Partial<ServerTransferProps> = {}): ServerTransferProps {
  return {
    open: true,
    targetName: 'VPS',
    sourceName: 'Laptop',
    publicUrl: '',
    confirmation: '',
    displayState: null,
    error: null,
    awaitingStatus: false,
    checkingTarget: false,
    showProgress: false,
    urlIsValid: false,
    canStart: false,
    onOpenChange: vi.fn(),
    onPublicUrlChange: vi.fn(),
    onConfirmationChange: vi.fn(),
    onStart: vi.fn(),
    onCheckTarget: vi.fn(),
    ...overrides,
  }
}

describe('ServerTransferProgress', () => {
  it.each([
    ['preparing', 'Preparing'],
    ['copying', 'Copying'],
    ['validating', 'Validating'],
    ['switching', 'Switching'],
    ['connected', 'Connected'],
  ] as const)('renders %s as its own durable phase', (state, label) => {
    render(<ServerTransferProgress state={state} targetName="VPS" />)

    expect(screen.getByText(label).getAttribute('data-transfer-state')).toBe(
      state === 'connected' ? 'complete' : 'active',
    )
  })

  it('keeps an uncertain commit distinct and warns against retrying', () => {
    render(<ServerTransferProgress state="commit-uncertain" targetName="VPS" />)

    const alert = screen.getByRole('alert')
    expect(alert.textContent).toMatch(/could not be confirmed/i)
    expect(alert.textContent).toMatch(/do not retry/i)
  })

  it('describes an abort as safe for the source server', () => {
    render(<ServerTransferProgress state="aborted" targetName="VPS" />)

    expect(screen.getByRole('alert').textContent).toMatch(/current server is still active/i)
  })
})

describe('ServerTransfer', () => {
  it('presents the transfer review and relays controlled field changes', () => {
    const onPublicUrlChange = vi.fn()
    const onConfirmationChange = vi.fn()
    render(<ServerTransfer {...props({ onPublicUrlChange, onConfirmationChange })} />)

    expect(screen.getByRole('dialog').textContent).toMatch(/laptop to vps/i)
    fireEvent.change(screen.getByLabelText('New public URL'), {
      target: { value: 'https://podium.example' },
    })
    fireEvent.change(
      screen.getByLabelText(`Type ${SERVER_TRANSFER_CONFIRMATION} to confirm server transfer`),
      {
        target: { value: SERVER_TRANSFER_CONFIRMATION },
      },
    )

    expect(onPublicUrlChange).toHaveBeenCalledWith('https://podium.example')
    expect(onConfirmationChange).toHaveBeenCalledWith(SERVER_TRANSFER_CONFIRMATION)
  })

  it('enables start only for a complete HTTP(S) URL and the exact phrase', () => {
    const onStart = vi.fn()
    const view = render(<ServerTransfer {...props({ onStart })} />)
    expect(screen.getByRole('button', { name: /transfer server/i })).toHaveProperty(
      'disabled',
      true,
    )

    view.rerender(
      <ServerTransfer
        {...props({
          publicUrl: 'ssh://podium.example',
          confirmation: SERVER_TRANSFER_CONFIRMATION,
          urlIsValid: false,
          canStart: false,
          onStart,
        })}
      />,
    )
    expect(screen.getByRole('alert').textContent).toMatch(/complete http or https/i)
    expect(screen.getByRole('button', { name: /transfer server/i })).toHaveProperty(
      'disabled',
      true,
    )

    view.rerender(
      <ServerTransfer
        {...props({
          publicUrl: 'https://podium.example',
          confirmation: SERVER_TRANSFER_CONFIRMATION,
          urlIsValid: true,
          canStart: true,
          onStart,
        })}
      />,
    )
    const start = screen.getByRole('button', { name: /transfer server/i })
    expect(start).toHaveProperty('disabled', false)
    fireEvent.click(start)
    expect(onStart).toHaveBeenCalledTimes(1)
  })

  it('shows waiting progress without claiming the mutation succeeded', () => {
    render(<ServerTransfer {...props({ awaitingStatus: true, showProgress: true })} />)

    expect(screen.getByRole('status').textContent).toMatch(/preparing/i)
    expect(screen.queryByText(/proved it is serving/i)).toBeNull()
  })

  it('replaces a stale aborted retry form with preparing while the new attempt is pending', () => {
    render(
      <ServerTransfer
        {...props({
          awaitingStatus: true,
          displayState: 'aborted',
          detail: 'the previous attempt was safely aborted',
          showProgress: true,
        })}
      />,
    )

    expect(screen.getByRole('status').textContent).toMatch(/preparing server transfer/i)
    expect(screen.queryByText(/transfer stopped safely/i)).toBeNull()
    expect(screen.queryByText(/previous attempt was safely aborted/i)).toBeNull()
    expect(screen.queryByLabelText('New public URL')).toBeNull()
    expect(screen.getByRole('dialog').getAttribute('aria-busy')).toBe('true')
  })

  it('marks acknowledgement waiting as busy, focuses progress, and clears on advance', async () => {
    const view = render(<ServerTransfer {...props()} />)

    view.rerender(<ServerTransfer {...props({ awaitingStatus: true, showProgress: true })} />)
    const progress = screen.getByRole('region', { name: /server transfer progress for vps/i })
    expect(screen.getByRole('dialog').getAttribute('aria-busy')).toBe('true')
    await waitFor(() => expect(document.activeElement).toBe(progress))

    view.rerender(
      <ServerTransfer
        {...props({
          awaitingStatus: false,
          displayState: 'copying',
          showProgress: true,
        })}
      />,
    )
    expect(screen.getByRole('dialog').getAttribute('aria-busy')).toBe('false')
  })

  it('keeps the phase strip readable on narrow surfaces without destructive progress styling', () => {
    render(<ServerTransferProgress state="copying" targetName="VPS" />)

    const phases = screen.getByRole('list', { name: /server transfer phases for vps/i })
    expect(phases.className).toMatch(/min-w-\[26rem\]/)
    expect(phases.parentElement?.className).toMatch(/overflow-x-auto/)
    expect(screen.getByText('Copying').className).not.toMatch(/destructive/)
  })

  it('shows connected only when supplied by the durable controller', () => {
    render(<ServerTransfer {...props({ displayState: 'connected', showProgress: true })} />)

    expect(screen.getByRole('status').textContent).toMatch(/proved it is serving/i)
    expect(screen.getByText('Connected').getAttribute('data-transfer-state')).toBe('complete')
  })

  it('keeps commit uncertainty in recovery and relays target inspection', () => {
    const onCheckTarget = vi.fn()
    render(
      <ServerTransfer
        {...props({
          displayState: 'commit-uncertain',
          showProgress: true,
          detail: 'promotion reply was lost',
          error: 'target inspection unavailable',
          onCheckTarget,
        })}
      />,
    )

    expect(screen.getAllByRole('alert')[0]?.textContent).toMatch(/promotion reply was lost/i)
    expect(screen.getAllByRole('alert')[0]?.textContent).toMatch(/does not restart or roll back/i)
    expect(screen.getAllByRole('alert')[0]?.textContent).toMatch(/do not retry/i)
    expect(screen.getByText(/target inspection unavailable/i)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /check target/i }))
    expect(onCheckTarget).toHaveBeenCalledTimes(1)
  })

  it('allows a safely aborted transfer to be reviewed again with fresh inputs', () => {
    render(
      <ServerTransfer
        {...props({
          displayState: 'aborted',
          detail: 'candidate validation failed',
        })}
      />,
    )

    expect(screen.getByRole('alert').textContent).toMatch(/candidate validation failed/i)
    expect(screen.getByLabelText('New public URL')).toHaveProperty('value', '')
    expect(screen.getByRole('button', { name: /transfer server/i })).toHaveProperty(
      'disabled',
      true,
    )
  })

  it('makes irreversible cutover consequences explicit and reserves destructive styling for it', () => {
    render(
      <ServerTransfer
        {...props({
          publicUrl: 'https://podium.example',
          confirmation: SERVER_TRANSFER_CONFIRMATION,
          urlIsValid: true,
          canStart: true,
        })}
      />,
    )

    expect(
      screen.getByText(/reversing this requires another validated server transfer/i),
    ).toBeTruthy()
    const transfer = screen.getByRole('button', { name: /transfer server/i })
    expect(transfer.className).toMatch(/bg-destructive/)
    expect(
      screen.getByLabelText(`Type ${SERVER_TRANSFER_CONFIRMATION} to confirm server transfer`),
    ).toBeTruthy()
  })
})
