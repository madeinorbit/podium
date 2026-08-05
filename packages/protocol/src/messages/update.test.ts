import { describe, expect, it } from 'vitest'
import { ControlMessage } from './control'
import { DaemonMessage } from './daemon'
import { CONVERGENCE_STATES, UpdateGrantMessage, UpdateStatusMessage } from './update'

const target = {
  version: '0.4.2',
  critical: false,
  artifacts: {},
}

describe('update frames', () => {
  it('parses a grant', () => {
    const g = UpdateGrantMessage.parse({ type: 'updateGrant', grantId: 'g1', target })
    expect(g.target.version).toBe('0.4.2')
  })

  it('is routable as a server-to-daemon control frame', () => {
    const m = ControlMessage.parse({ type: 'updateGrant', grantId: 'g1', target })
    expect(m.type).toBe('updateGrant')
  })

  it('parses a status report', () => {
    const s = UpdateStatusMessage.parse({
      type: 'updateStatus',
      grantId: 'g1',
      state: 'restarting',
      version: '0.4.1',
    })
    expect(s.state).toBe('restarting')
  })

  it('is routable as a daemon-to-server frame', () => {
    const m = DaemonMessage.parse({ type: 'updateStatus', state: 'current', version: '0.4.2' })
    expect(m.type).toBe('updateStatus')
  })

  it('carries no machineId: the machine comes from the authenticated transport', () => {
    const s = UpdateStatusMessage.parse({
      type: 'updateStatus',
      state: 'current',
      version: '0.4.2',
      machineId: 'm-forged',
    })
    expect(s).not.toHaveProperty('machineId')
  })

  it('allows a status with no grantId, for an unsolicited report on reconnect', () => {
    expect(() =>
      UpdateStatusMessage.parse({ type: 'updateStatus', state: 'current', version: '0.4.2' }),
    ).not.toThrow()
  })

  it('accepts a development identity as the reported version', () => {
    const s = UpdateStatusMessage.parse({
      type: 'updateStatus',
      state: 'current',
      version: 'dev+9f3a1c2',
    })
    expect(s.version).toBe('dev+9f3a1c2')
  })

  it('names the six convergence states', () => {
    expect(CONVERGENCE_STATES).toEqual([
      'current',
      'granted',
      'downloading',
      'restarting',
      'rejected',
      'stuck',
    ])
  })

  it('rejects a state outside the closed set', () => {
    expect(() =>
      UpdateStatusMessage.parse({ type: 'updateStatus', state: 'vibing', version: '0.4.2' }),
    ).toThrow()
  })
})
