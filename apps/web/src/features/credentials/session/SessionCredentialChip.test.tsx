import { asCredentialId, asMachineId, asSessionId } from '@podium/model'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { credentialView } from '@/test-support/credential-view'
import { type ChipSession, SessionCredentialChipView } from './SessionCredentialChip'
import { switchOutcome } from './switch-outcome'

afterEach(cleanup)

const ACCEPTS = [
  { type: 'anthropic.api-key' },
  { type: 'anthropic.claude-token' },
  { type: 'anthropic.claude-login' },
]
const custodianOf = () => 'user:me'
const key = credentialView({ label: 'Work key', type: 'anthropic.api-key' })
const max = credentialView({
  label: 'Max plan',
  type: 'anthropic.claude-login',
  homes: [{ machineId: 'laptop', homeId: 'h:claude-code', state: 'in' }],
})
const pro = credentialView({
  label: 'Pro plan',
  type: 'anthropic.claude-login',
  homes: [{ machineId: 'laptop', homeId: 'p:claude-code', state: 'in' }],
})
const openai = credentialView({ label: 'OpenAI key', type: 'openai.api-key' })

const session = (over: Partial<ChipSession> = {}): ChipSession => ({
  sessionId: asSessionId('session-1'),
  agentKind: 'claude-code',
  machineId: asMachineId('laptop'),
  status: 'live',
  credentialId: max.id,
  ...over,
})

function renderChip(
  s: ChipSession,
  onSwitch = vi.fn(async () => ({ continuedAs: 'resume' as const })),
) {
  render(
    <SessionCredentialChipView
      session={s}
      views={[key, max, pro, openai]}
      accepts={ACCEPTS}
      custodianOf={custodianOf}
      onSwitch={onSwitch}
    />,
  )
  return onSwitch
}

const chip = () => screen.getByRole('button', { name: /^Credential/ })

describe('acceptance 2: every session shows its credential’s label and kind', () => {
  it('a subscription', () => {
    renderChip(session())
    expect(chip().textContent).toContain('Max plan')
    expect(chip().textContent).toContain('Subscription')
  })

  it('an API key', () => {
    renderChip(session({ credentialId: key.id }))
    expect(chip().textContent).toContain('Work key')
    expect(chip().textContent).toContain('API key')
  })

  it('the harness’s own login', () => {
    renderChip(session({ credentialId: undefined }))
    expect(chip().textContent).toContain('Its own login')
  })

  it('a credential the viewer cannot see: what the harness reported', () => {
    renderChip(
      session({
        credentialId: asCredentialId('cred_00000000-0000-4000-8000-0000000000ff'),
        effectiveAuth: { method: 'token' },
      }),
    )
    expect(chip().textContent).toContain('Another member’s credential')
    expect(chip().textContent).toContain('Token')
  })
})

describe('acceptance 3: switch credential', () => {
  it('lists the eligible credentials, the current one checked, and the own login', () => {
    renderChip(session())
    fireEvent.click(chip())
    const items = screen.getAllByRole('menuitem').map((item) => item.textContent ?? '')
    expect(items.some((t) => t.includes('Work key'))).toBe(true)
    expect(items.some((t) => t.includes('Pro plan'))).toBe(true)
    expect(items.some((t) => t.includes('OpenAI key'))).toBe(false)
    expect(items.at(-1)).toContain('Its own login')
  })

  it('between turns it switches at once, without asking', async () => {
    const onSwitch = renderChip(session())
    fireEvent.click(chip())
    fireEvent.click(screen.getByRole('menuitem', { name: /Pro plan/ }))
    await waitFor(() => expect(onSwitch).toHaveBeenCalledWith(pro.id, 'wait'))
    expect(screen.queryByText(/A turn is running/)).toBeNull()
  })

  it('during a turn it asks to wait or interrupt, and sends the answer', async () => {
    const turn = {
      agentState: { phase: 'working', turnStartedAt: '2026-11-17T10:00:00.000Z' },
    } as Partial<ChipSession>
    const onSwitch = renderChip(session(turn))
    fireEvent.click(chip())
    fireEvent.click(screen.getByRole('menuitem', { name: /Pro plan/ }))
    await screen.findByText(/A turn is running/)
    expect(onSwitch).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Interrupt now' }))
    await waitFor(() => expect(onSwitch).toHaveBeenCalledWith(pro.id, 'interrupt'))
  })

  it('during a turn, waiting is the other answer', async () => {
    const turn = {
      agentState: { phase: 'working', turnStartedAt: '2026-11-17T10:00:00.000Z' },
    } as Partial<ChipSession>
    const onSwitch = renderChip(session(turn))
    fireEvent.click(chip())
    fireEvent.click(screen.getByRole('menuitem', { name: /Its own login/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Wait for the turn to end' }))
    await waitFor(() => expect(onSwitch).toHaveBeenCalledWith(null, 'wait'))
  })

  it('picking the current one does nothing', () => {
    const onSwitch = renderChip(session())
    fireEvent.click(chip())
    fireEvent.click(screen.getByRole('menuitem', { name: /Max plan/ }))
    expect(onSwitch).not.toHaveBeenCalled()
  })
})

describe('acceptance 3: the outcome of a switch', () => {
  it('names what happened for each way the session continued', () => {
    expect(switchOutcome({ continuedAs: 'resume' }, 'Pro plan').text).toBe(
      'Switched to Pro plan. The conversation continues.',
    )
    expect(switchOutcome({ continuedAs: 'resume', waitingForTurnEnd: true }, 'Pro plan').text).toBe(
      'Switches to Pro plan when this turn ends.',
    )
    expect(switchOutcome({ continuedAs: 'next-wake' }, 'Pro plan').text).toBe(
      'Switched to Pro plan. It takes effect when the session next starts.',
    )
    const handoff = switchOutcome(
      { continuedAs: 'handoff', handoffSessionId: asSessionId('session-2') },
      'Pro plan',
    )
    expect(handoff.text).toBe(
      'Pro plan could not resume this conversation, so it continues in a new session with a summary.',
    )
    expect(handoff.openSessionId).toBe('session-2')
  })
})
