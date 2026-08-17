import { describe, expect, it } from 'vitest'
import {
  activationUrl,
  DEFAULT_ACTIVATION_STATE,
  hasActivationState,
  isActivationEligible,
  readActivationState,
  shouldStartRemoteClientAtProjects,
} from './activation-route'

describe('activation route persistence', () => {
  it('defaults missing or unknown state to the welcome route', () => {
    expect(readActivationState('')).toEqual(DEFAULT_ACTIVATION_STATE)
    expect(readActivationState('?activation=future-step')).toEqual(DEFAULT_ACTIVATION_STATE)
  })

  it('restores the exact local-project route and ignores a retired exploring URL', () => {
    expect(readActivationState('?activation=local-project')).toEqual({ route: 'local-project' })
    expect(readActivationState('?activation=local-project&activationMode=exploring')).toEqual({
      route: 'local-project',
    })
  })

  it('restores both VPS routes and retires obsolete transfer subroutes', () => {
    expect(readActivationState('?activation=vps-choice')).toEqual({ route: 'vps-choice' })
    expect(readActivationState('?activation=vps-intro')).toEqual({ route: 'vps-intro' })
    expect(readActivationState('?activation=vps-transfer')).toEqual(DEFAULT_ACTIVATION_STATE)
  })

  it('restores every existing-install route exactly', () => {
    for (const route of ['existing-podium', 'existing-client', 'existing-machine'] as const) {
      expect(readActivationState(`?activation=${route}`)).toEqual({ route })
    }
  })

  it('restores the agent and first-task setup routes exactly', () => {
    for (const route of ['agent', 'first-task'] as const) {
      expect(readActivationState(`?activation=${route}`)).toEqual({ route })
    }
  })

  it('preserves shell/router query state while writing the setup step', () => {
    const url = activationUrl(
      {
        pathname: '/issues',
        search: '?server=ws%3A%2F%2Fhost%3A9&e2e&wt=%2Frepo',
        hash: '#detail',
      },
      { route: 'local-project' },
    )
    const parsed = new URL(url, 'https://podium.test')

    expect(parsed.pathname).toBe('/issues')
    expect(parsed.searchParams.get('server')).toBe('ws://host:9')
    expect(parsed.searchParams.has('e2e')).toBe(true)
    expect(parsed.searchParams.get('wt')).toBe('/repo')
    expect(parsed.searchParams.get('activation')).toBe('local-project')
    // Retired with the Explore/Resume hatch: never written, always swept.
    expect(parsed.searchParams.has('activationMode')).toBe(false)
    expect(parsed.hash).toBe('#detail')
  })

  it('retires only setup params after real setup completes', () => {
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

  it('keeps a durable VPS handoff resumable after a restart has created work', () => {
    expect(
      isActivationEligible({
        loaded: true,
        repoCount: 1,
        sessionCount: 2,
        hasActivationCheckpoint: false,
        hasVpsCheckpoint: true,
      }),
    ).toBe(true)
    expect(
      isActivationEligible({
        loaded: true,
        repoCount: 1,
        sessionCount: 0,
        hasActivationCheckpoint: false,
        hasVpsCheckpoint: false,
      }),
    ).toBe(false)
    expect(
      isActivationEligible({
        loaded: true,
        repoCount: 1,
        sessionCount: 1,
        hasActivationCheckpoint: true,
        hasVpsCheckpoint: false,
      }),
    ).toBe(true)
  })

  it('continues a fresh native client at remote project intake', () => {
    const freshClient = {
      launchMode: 'client',
      loaded: true,
      repoCount: 0,
      sessionCount: 0,
      route: 'welcome' as const,
      hasActivationCheckpoint: false,
      hasVpsCheckpoint: false,
    }
    expect(shouldStartRemoteClientAtProjects(freshClient)).toBe(true)
    expect(shouldStartRemoteClientAtProjects({ ...freshClient, launchMode: 'all-in-one' })).toBe(
      false,
    )
    expect(shouldStartRemoteClientAtProjects({ ...freshClient, repoCount: 1 })).toBe(false)
    expect(
      shouldStartRemoteClientAtProjects({ ...freshClient, hasActivationCheckpoint: true }),
    ).toBe(false)
  })
})
