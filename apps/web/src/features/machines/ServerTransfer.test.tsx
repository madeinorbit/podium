import { cleanup, fireEvent, render, screen } from '@testing-library/react'
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
    fireEvent.change(screen.getByLabelText('Server transfer confirmation'), {
      target: { value: SERVER_TRANSFER_CONFIRMATION },
    })

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
})
