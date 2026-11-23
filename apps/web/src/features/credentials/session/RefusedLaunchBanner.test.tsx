import { ACCESS_REFUSAL_MESSAGES } from '@podium/model'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { credentialView } from '@/test-support/credential-view'
import { RefusedLaunchBannerView } from './RefusedLaunchBanner'

afterEach(cleanup)

const key = credentialView({ label: 'Work key', type: 'anthropic.api-key' })

function show(refusal: keyof typeof ACCESS_REFUSAL_MESSAGES) {
  const props = {
    refusal,
    choices: [{ view: key }],
    onRenew: vi.fn(),
    onPick: vi.fn(),
    onDismiss: vi.fn(),
  }
  render(<RefusedLaunchBannerView {...props} />)
  return props
}

describe('a start refused for its credential (coordinator note on Task 3)', () => {
  it('says the refusal and the way out, and never that a transcript is read-only', () => {
    const props = show('needs-attention')
    const bar = screen.getByRole('status')
    expect(bar.textContent).toContain('This session did not start.')
    expect(bar.textContent).toContain(ACCESS_REFUSAL_MESSAGES['needs-attention'])
    expect(bar.textContent).not.toContain('read-only')
    expect(bar.textContent).not.toContain('no longer running')
    fireEvent.click(screen.getByRole('button', { name: 'Renew' }))
    expect(props.onRenew).toHaveBeenCalled()
  })

  it('starts again on another credential the person picks', () => {
    const props = show('needs-attention')
    fireEvent.click(screen.getByRole('button', { name: 'Pick another credential' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /Work key/ }))
    expect(props.onPick).toHaveBeenCalledWith(key.id)
  })

  it('offers renewal only where renewing helps', () => {
    show('not-on-this-machine')
    expect(screen.getByRole('status').textContent).toContain(
      ACCESS_REFUSAL_MESSAGES['not-on-this-machine'],
    )
    expect(screen.queryByRole('button', { name: 'Renew' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Pick another credential' })).toBeTruthy()
  })

  it('can be let go', () => {
    const props = show('revoked')
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(props.onDismiss).toHaveBeenCalled()
  })
})
