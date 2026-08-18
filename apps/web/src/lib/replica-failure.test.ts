import { describe, expect, it } from 'vitest'
import { classifyAuthStatus, describeReplicaFailure, endpointLabel } from './replica-failure'

const READY = { state: 'ready', reason: null, dataPlane: 'available' } as const
const BLOCKED = { state: 'unconfigured', reason: 'setup_required', dataPlane: 'blocked' } as const

describe('classifying the account answer', () => {
  it('takes the principal when the server names one', () => {
    expect(classifyAuthStatus({ userId: 'alice', needsAuth: true, readiness: READY })).toEqual({
      principal: 'alice',
    })
  })

  it('reads a password-protected server with no session as a sign-in, not a fault', () => {
    expect(classifyAuthStatus({ needsAuth: true, readiness: READY })).toEqual({
      kind: 'signed-out',
    })
  })

  it('reads a blocked data plane as a starting server even when a password is set', () => {
    // The whole point of the ordering: an operator who IS signed in gets no
    // principal from a half-started server, and a password box they cannot use
    // would be the wrong screen AND a lie about what is wrong.
    expect(classifyAuthStatus({ needsAuth: true, readiness: BLOCKED })).toEqual({
      kind: 'server-starting',
      readiness: BLOCKED,
    })
  })

  it('reads an open server with no account as a missing account', () => {
    expect(classifyAuthStatus({ needsAuth: false, readiness: READY })).toEqual({
      kind: 'account-missing',
    })
  })

  it('refuses an empty principal string rather than opening a nameless slice', () => {
    expect(classifyAuthStatus({ userId: '', needsAuth: false })).toEqual({ kind: 'account-missing' })
  })
})

describe('what the operator is told', () => {
  it('never puts the internal string in the visible copy', () => {
    const kinds = [
      { kind: 'account-missing' },
      { kind: 'auth-insecure' },
      { kind: 'auth-refused', status: 502 },
      { kind: 'auth-intercepted' },
      { kind: 'offline-unknown' },
      { kind: 'offline-ambiguous', count: 2 },
      { kind: 'replica-blocked' },
      { kind: 'unknown' },
      { kind: 'server-starting', readiness: BLOCKED },
    ] as const
    for (const failure of kinds) {
      const copy = describeReplicaFailure(failure, { endpoint: 'pod.test' })
      expect(copy.prose).not.toContain('authenticated account is unavailable')
      expect(copy.prose).not.toContain('IndexedDB')
      expect(copy.headline.length).toBeGreaterThan(0)
      expect(copy.eyebrow).toMatch(/ \/ /)
    }
  })

  it('names the reason a half-started server gives, rather than one generic wait', () => {
    const setup = describeReplicaFailure(
      { kind: 'server-starting', readiness: BLOCKED },
      { endpoint: 'pod.test' },
    )
    expect(setup.headline).toContain('set up')
    expect(setup.selfClearing).toBe(true)

    const restart = describeReplicaFailure(
      {
        kind: 'server-starting',
        readiness: { state: 'activation_pending', reason: 'restart_required', dataPlane: 'blocked' },
      },
      { endpoint: 'pod.test' },
    )
    expect(restart.headline).toContain('old settings')
  })

  it('carries the refusal code into the console rather than into the sentence', () => {
    const copy = describeReplicaFailure({ kind: 'auth-refused', status: 502 }, { endpoint: 'x' })
    expect(copy.prose).not.toContain('502')
    expect(copy.fields.some((f) => f.value === 'HTTP 502' && f.tone === 'fault')).toBe(true)
  })

  it('offers a command to run for the faults an operator can act on', () => {
    for (const failure of [{ kind: 'account-missing' }, { kind: 'auth-insecure' }] as const) {
      const copy = describeReplicaFailure(failure, { endpoint: 'x' })
      expect(copy.fields.some((f) => f.tone === 'command')).toBe(true)
    }
  })
})

describe('the server label', () => {
  it('prints the host, not the whole origin', () => {
    expect(endpointLabel('https://pod.example.com:8443/')).toBe('pod.example.com:8443')
  })

  it('says something rather than nothing for an empty origin', () => {
    expect(endpointLabel('')).not.toBe('')
  })
})
