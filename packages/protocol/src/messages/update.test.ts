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
      targetVersion: '0.4.2',
      version: '0.4.1',
    })
    expect(s.state).toBe('restarting')
    expect(s.targetVersion).toBe('0.4.2')
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

  describe('progress heartbeats (POD-2101)', () => {
    it('parses a frame written by a daemon that predates them', () => {
      // THE COMPATIBILITY GATE. An old daemon reports a phase once and nothing
      // else; the fields added for heartbeats must be absent, not empty.
      const s = UpdateStatusMessage.parse({
        type: 'updateStatus',
        grantId: 'g1',
        state: 'downloading',
        version: '0.4.1',
      })
      expect(s).not.toHaveProperty('percent')
      expect(s).not.toHaveProperty('phaseDetail')
    })

    it('carries how far the phase has got', () => {
      const s = UpdateStatusMessage.parse({
        type: 'updateStatus',
        grantId: 'g1',
        state: 'downloading',
        version: '0.4.1',
        percent: 62,
        phaseDetail: 'downloading',
      })
      expect(s.percent).toBe(62)
      expect(s.phaseDetail).toBe('downloading')
    })

    it('is routable as a daemon-to-server frame with the new fields', () => {
      const m = DaemonMessage.parse({
        type: 'updateStatus',
        state: 'downloading',
        version: '0.4.1',
        percent: 7,
        phaseDetail: 'git-fetch',
      })
      expect(m).toMatchObject({ percent: 7, phaseDetail: 'git-fetch' })
    })

    it('refuses a percent that is not a whole number in 0–100', () => {
      for (const percent of [-1, 101, 42.5]) {
        expect(() =>
          UpdateStatusMessage.parse({
            type: 'updateStatus',
            state: 'downloading',
            version: '0.4.1',
            percent,
          }),
        ).toThrow()
      }
    })
  })
})
