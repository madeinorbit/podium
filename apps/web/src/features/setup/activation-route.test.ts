import { describe, expect, it } from 'vitest'
import {
  activationUrl,
  DEFAULT_ACTIVATION_STATE,
  hasActivationState,
  isActivationEligible,
  readActivationState,
} from './activation-route'

describe('activation route persistence', () => {
  it('defaults missing or unknown state to the active welcome route', () => {
    expect(readActivationState('')).toEqual(DEFAULT_ACTIVATION_STATE)
    expect(readActivationState('?activation=future-step&activationMode=bogus')).toEqual(
      DEFAULT_ACTIVATION_STATE,
    )
  })

  it('restores the exact local-project route and paused exploration mode', () => {
    expect(readActivationState('?activation=local-project')).toEqual({
      route: 'local-project',
      mode: 'active',
    })
    expect(readActivationState('?activation=local-project&activationMode=exploring')).toEqual({
      route: 'local-project',
      mode: 'exploring',
    })
  })

  it('restores every nested VPS route exactly', () => {
    for (const route of ['vps-intro', 'vps-pairing', 'vps-transfer'] as const) {
      expect(readActivationState(`?activation=${route}`)).toEqual({ route, mode: 'active' })
    }
  })

  it('preserves shell/router query state while writing activation', () => {
    const url = activationUrl(
      {
        pathname: '/issues',
        search: '?server=ws%3A%2F%2Fhost%3A9&e2e&wt=%2Frepo',
        hash: '#detail',
      },
      { route: 'local-project', mode: 'exploring' },
    )
    const parsed = new URL(url, 'https://podium.test')

    expect(parsed.pathname).toBe('/issues')
    expect(parsed.searchParams.get('server')).toBe('ws://host:9')
    expect(parsed.searchParams.has('e2e')).toBe(true)
    expect(parsed.searchParams.get('wt')).toBe('/repo')
    expect(parsed.searchParams.get('activation')).toBe('local-project')
    expect(parsed.searchParams.get('activationMode')).toBe('exploring')
    expect(parsed.hash).toBe('#detail')
  })

  it('retires only activation params after real setup completes', () => {
    const url = activationUrl(
      {
        pathname: '/workspace',
        search: '?activation=local-project&activationMode=exploring&e2e=1',
        hash: '',
      },
      null,
    )

    expect(url).toBe('/workspace?e2e=1')
    expect(hasActivationState('?activation=welcome')).toBe(true)
    expect(hasActivationState('?e2e=1')).toBe(false)
  })

  it('keeps a durable VPS handoff resumable after work is created while exploring', () => {
    expect(
      isActivationEligible({
        loaded: true,
        repoCount: 1,
        sessionCount: 2,
        hasVpsCheckpoint: true,
      }),
    ).toBe(true)
    expect(
      isActivationEligible({
        loaded: true,
        repoCount: 1,
        sessionCount: 0,
        hasVpsCheckpoint: false,
      }),
    ).toBe(false)
  })
})
