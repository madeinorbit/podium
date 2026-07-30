import { describe, expect, it } from 'vitest'
import { asUserId } from '../../planes/principal'
import {
  clientSession,
  createRecordingMinter,
  fakeClientSessions,
  helloFor,
  HOSTILE_CLAIMS,
  transportFacts,
} from '../test-support'
import { createOperatorChannelStrategy } from './operator-channel'

const sessions = fakeClientSessions({ 'tok-cli': clientSession('usr-ada', 'dev-cli') })

const strategy = (over: Partial<Parameters<typeof createOperatorChannelStrategy>[0]> = {}) =>
  createOperatorChannelStrategy({
    clientSessions: sessions,
    mint: createRecordingMinter(),
    ...over,
  })

const run = (
  s: ReturnType<typeof createOperatorChannelStrategy>,
  credential: { kind: 'operatorChannel'; sessionToken?: string },
  transport = transportFacts({ endpoint: 'cli' }),
) => s.authenticate({ credential, hello: helloFor(credential), transport })

describe('operator channel (cli / in-process mcp)', () => {
  it('resolves the in-process bound user', () => {
    const outcome = run(
      strategy({ boundUser: () => asUserId('usr-ada') }),
      { kind: 'operatorChannel' },
      transportFacts({ endpoint: 'in-process', inProcess: true }),
    )
    expect(outcome.ok && outcome.principal).toMatchObject({ kind: 'user', user: 'usr-ada' })
  })

  it('resolves the local operator client session when the CLI presents one', () => {
    const outcome = run(strategy(), { kind: 'operatorChannel', sessionToken: 'tok-cli' })
    expect(outcome.ok && outcome.principal).toMatchObject({
      kind: 'user',
      user: 'usr-ada',
      device: 'dev-cli',
    })
  })

  it('is payload-inert', () => {
    const s = strategy()
    const credential = { kind: 'operatorChannel', sessionToken: 'tok-cli' } as const
    const honest = run(s, credential)
    const forged = s.authenticate({
      credential,
      hello: helloFor(credential, { claims: { ...HOSTILE_CLAIMS, user: 'usr-root' } }),
      transport: transportFacts({ endpoint: 'cli' }),
    })
    expect(forged).toEqual(honest)
  })

  it('has NO ambient operator: no binding and no session is a refusal', () => {
    // The single most tempting fallback in the codebase, and the one readiness
    // §3.1.6 S4 names as the multi-user hole.
    expect(run(strategy(), { kind: 'operatorChannel' })).toMatchObject({
      ok: false,
      reason: 'auth-failed',
    })
  })

  it('refuses an in-process claim that arrives without an in-process transport', () => {
    // `inProcess` is a fact the gateway asserts, not something a peer can send:
    // a socket peer that omits a token gets nothing, bound user or not.
    const outcome = run(
      strategy({ boundUser: () => asUserId('usr-ada') }),
      { kind: 'operatorChannel' },
      transportFacts({ endpoint: '/client', inProcess: false }),
    )
    expect(outcome).toMatchObject({ ok: false, reason: 'auth-failed' })
  })

  it('refuses when the in-process binding names a disabled user', () => {
    const outcome = run(
      strategy({ boundUser: () => asUserId('usr-ada'), userIsActive: () => false }),
      { kind: 'operatorChannel' },
      transportFacts({ endpoint: 'in-process', inProcess: true }),
    )
    expect(outcome).toMatchObject({ ok: false, reason: 'auth-failed' })
  })

  it('refuses an unknown session token', () => {
    expect(run(strategy(), { kind: 'operatorChannel', sessionToken: 'tok-nope' })).toMatchObject({
      ok: false,
      reason: 'auth-failed',
    })
  })
})
