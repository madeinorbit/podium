import { describe, expect, it } from 'vitest'
import { ControlMessage } from './control'
import { DaemonMessage } from './daemon'
import { CAP_HARNESS_INSTALLS, HarnessInstallAction } from './installs'
import { CONTROL_PLANE_CLASS, DAEMON_PLANE_CLASS } from './message-class'

const pairs = [
  'Install',
  'Check',
  'Back',
  'Pause',
  'Resume',
  'TakeSettings',
  'RemoveChanges',
  'Changes',
  'Remove',
  'HomeInfo',
  'HomeRemove',
] as const

describe('managed harness wire actions', () => {
  it('declares the negotiated capability', () =>
    expect(CAP_HARNESS_INSTALLS).toBe('harness.installs.v1'))
  it.each(pairs)('%s has its own request and result, both control commands', (action) => {
    const request = {
      type: `harness${action}Request`,
      requestId: 'request-1',
      harness: 'codex',
      ...(action === 'HomeRemove' ? { confirmedConversations: ['conversation-1'] } : {}),
    }
    const reply = { type: `harness${action}Result`, requestId: 'request-1', ok: true }
    expect(ControlMessage.parse(request)).toEqual(request)
    expect(DaemonMessage.parse(reply)).toEqual(reply)
    expect(CONTROL_PLANE_CLASS[request.type as keyof typeof CONTROL_PLANE_CLASS]).toBe(
      'control.command',
    )
    expect(DAEMON_PLANE_CLASS[reply.type as keyof typeof DAEMON_PLANE_CLASS]).toBe(
      'control.command',
    )
    expect(ControlMessage.safeParse({ ...request, harness: '../outside' }).success).toBe(false)
  })
  it('requires explicit conversation confirmation for deleting a home', () => {
    expect(
      ControlMessage.safeParse({
        type: 'harnessHomeRemoveRequest',
        requestId: 'r',
        harness: 'codex',
      }).success,
    ).toBe(false)
    expect(HarnessInstallAction.options).toHaveLength(pairs.length)
  })
})
