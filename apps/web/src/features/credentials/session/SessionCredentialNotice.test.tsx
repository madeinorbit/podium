import { asMachineId, asSessionId } from '@podium/model'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { credentialView } from '@/test-support/credential-view'
import { type NoticeSession, SessionCredentialNoticeView } from './SessionCredentialNotice'

afterEach(cleanup)

const max = credentialView({
  label: 'Max plan',
  type: 'anthropic.claude-login',
  identity: { email: 'chosen@example.invalid' },
  homes: [{ machineId: 'laptop', homeId: 'h:claude-code', state: 'in' }],
})
const sick = credentialView({
  label: 'Team key',
  type: 'anthropic.api-key',
  status: 'attention',
  statusReason: 'The provider rejected the key.',
})

const base: NoticeSession = {
  sessionId: asSessionId('session-1'),
  agentKind: 'claude-code',
  machineId: asMachineId('laptop'),
  status: 'live',
}

function show(session: NoticeSession, onRenew = vi.fn()) {
  render(
    <SessionCredentialNoticeView
      session={session}
      views={[max, sick]}
      accepts={[{ type: 'anthropic.api-key' }, { type: 'anthropic.claude-login' }]}
      custodianOf={() => 'user:me'}
      onSwitch={vi.fn(async () => undefined)}
      onRenew={onRenew}
    />,
  )
  return onRenew
}

describe('acceptance 4: a session whose harness answered on another identity', () => {
  it('shows the warning with both identities, and the switch', () => {
    show({
      ...base,
      credentialId: max.id,
      credentialMismatch: {
        chosen: { credentialId: max.id, method: 'subscription', email: 'chosen@example.invalid' },
        reported: { method: 'subscription', email: 'other@example.invalid' },
      },
    })
    const notice = screen.getByRole('status')
    expect(notice.textContent).toContain('Max plan')
    expect(notice.textContent).toContain('other@example.invalid')
    expect(notice.textContent).toContain('It may bill another account.')
    expect(screen.getByRole('button', { name: 'Switch credential' })).toBeTruthy()
  })

  it('names the reported key by its fingerprint when there is no account name', () => {
    show({
      ...base,
      credentialId: max.id,
      credentialMismatch: {
        chosen: { credentialId: max.id },
        reported: { method: 'api-key', fingerprint: 'fp-planted-0001' },
      },
    })
    expect(screen.getByRole('status').textContent).toContain('an API key (fp-planted-0001)')
  })
})

describe('acceptance 4: a session whose credential needs attention', () => {
  it('shows why, with renew and switch', () => {
    const onRenew = show({ ...base, credentialId: sick.id })
    const notice = screen.getByRole('status')
    expect(notice.textContent).toContain('Team key needs attention: The provider rejected the key.')
    fireEvent.click(screen.getByRole('button', { name: 'Renew' }))
    expect(onRenew).toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Switch credential' })).toBeTruthy()
  })
})

describe('a healthy session that runs on what it chose', () => {
  it('shows no notice', () => {
    show({ ...base, credentialId: max.id })
    expect(screen.queryByRole('status')).toBeNull()
  })
})
