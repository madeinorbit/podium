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

  it('writes the welcome step too, so stepping back keeps the checkpoint', () => {
    // The first step used to be the one step that erased the param, which is how
    // closing the project picker after it had added a repo dropped the whole
    // wizard and revealed a half-configured shell (POD-1200).
    const url = activationUrl({ pathname: '/', search: '?e2e=1', hash: '' }, { route: 'welcome' })
    expect(new URL(url, 'https://podium.test').searchParams.get('activation')).toBe('welcome')
    expect(hasActivationState(new URL(url, 'https://podium.test').search)).toBe(true)
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
    const settled = {
      loaded: true,
      repoCount: 1,
      setupInProgress: false,
      hasActivationCheckpoint: false,
      hasVpsCheckpoint: false,
    }
    expect(isActivationEligible({ ...settled, sessionCount: 2, hasVpsCheckpoint: true })).toBe(true)
    expect(isActivationEligible({ ...settled, sessionCount: 0 })).toBe(false)
    expect(
      isActivationEligible({ ...settled, sessionCount: 1, hasActivationCheckpoint: true }),
    ).toBe(true)
  })

  it('keeps unfinished setup on screen once its first step has created a repo', () => {
    // The step that adds a project retires "nothing exists yet" three steps
    // before setup is over (POD-1200). Only finishing — which clears the flag —
    // hands the shell over.
    const midSetup = {
      loaded: true,
      repoCount: 1,
      sessionCount: 0,
      setupInProgress: true,
      hasActivationCheckpoint: false,
      hasVpsCheckpoint: false,
    }
    expect(isActivationEligible(midSetup)).toBe(true)
    expect(isActivationEligible({ ...midSetup, setupInProgress: false })).toBe(false)
    // Still nothing before the repo list has loaded: a flag cannot outvote that.
    expect(isActivationEligible({ ...midSetup, loaded: false })).toBe(false)
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
