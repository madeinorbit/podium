import { describe, expect, it } from 'vitest'
import {
  parseVpsActivation,
  parseVpsActivationValue,
  serializeVpsActivation,
  vpsIntroState,
} from './vps-activation'

describe('fresh VPS activation state', () => {
  it('round-trips the small direct-bootstrap checkpoint', () => {
    const state = vpsIntroState('vps-choice')
    expect(parseVpsActivation(serializeVpsActivation(state))).toEqual(state)
  })

  it('still parses checkpoints written before the VPS question existed', () => {
    for (const returnRoute of ['welcome', 'local-project'] as const) {
      const state = vpsIntroState(returnRoute)
      expect(parseVpsActivation(serializeVpsActivation(state))).toEqual(state)
    }
  })

  it('collapses an old transfer checkpoint back to direct VPS setup', () => {
    expect(
      parseVpsActivationValue({
        version: 1,
        route: 'vps-transfer',
        returnRoute: 'welcome',
        baselineMachineIds: ['old-machine'],
        moveServer: true,
        target: { machineId: 'vps', name: 'VPS' },
      }),
    ).toEqual(vpsIntroState('welcome'))
  })

  it('rejects malformed and future state', () => {
    expect(parseVpsActivation('{nope')).toBeNull()
    expect(
      parseVpsActivationValue({ version: 99, route: 'vps-intro', returnRoute: 'welcome' }),
    ).toBeNull()
    expect(
      parseVpsActivationValue({ version: 2, route: 'vps-intro', returnRoute: 'elsewhere' }),
    ).toBeNull()
  })
})
