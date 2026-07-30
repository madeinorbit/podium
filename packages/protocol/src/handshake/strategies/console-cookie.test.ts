import { describe, expect, it } from 'vitest'
import { SESSION_COOKIE } from '../../session-cookie'
import {
  clientSession,
  createRecordingMinter,
  fakeClientSessions,
  helloFor,
  HOSTILE_CLAIMS,
  transportFacts,
} from '../test-support'
import { createConsoleCookieStrategy } from './console-cookie'

const hello = helloFor({ kind: 'sessionCookie' })

const strategyWith = (sessions: Parameters<typeof fakeClientSessions>[0]) => {
  const mint = createRecordingMinter()
  return {
    mint,
    strategy: createConsoleCookieStrategy({
      clientSessions: fakeClientSessions(sessions),
      mint,
    }),
  }
}

describe('console cookie strategy', () => {
  it('resolves a (user, device) principal from a per-user client session', () => {
    const { strategy } = strategyWith({ 'tok-a': clientSession('usr-ada', 'dev-laptop') })
    const outcome = strategy.authenticate({
      credential: { kind: 'sessionCookie' },
      hello,
      transport: transportFacts({ endpoint: '/client', cookies: { [SESSION_COOKIE]: 'tok-a' } }),
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.principal).toMatchObject({
      kind: 'user',
      user: 'usr-ada',
      // The DEVICE half is the client session, kept distinct from the person:
      // one user may hold many (ADR 3 Amendment 1 D14.1).
      device: 'dev-laptop',
    })
  })

  it('is payload-inert: a hello asserting another user changes nothing', () => {
    const { strategy } = strategyWith({ 'tok-a': clientSession('usr-ada', 'dev-laptop') })
    const transport = transportFacts({
      endpoint: '/client',
      cookies: { [SESSION_COOKIE]: 'tok-a' },
    })
    const honest = strategy.authenticate({ credential: { kind: 'sessionCookie' }, hello, transport })
    const forged = strategy.authenticate({
      credential: { kind: 'sessionCookie' },
      hello: {
        ...hello,
        claims: { ...HOSTILE_CLAIMS, user: 'usr-root', onBehalfOf: 'usr-root' },
      },
      transport,
    })
    expect(forged).toEqual(honest)
    expect(forged.ok && forged.principal).toMatchObject({ user: 'usr-ada' })
  })

  it('fails closed with no cookie on the transport — and mints nothing', () => {
    const { strategy, mint } = strategyWith({ 'tok-a': clientSession('usr-ada', 'dev-laptop') })
    const outcome = strategy.authenticate({
      credential: { kind: 'sessionCookie' },
      hello,
      transport: transportFacts({ endpoint: '/client' }),
    })
    expect(outcome).toMatchObject({ ok: false, reason: 'auth-failed' })
    expect(mint.minted).toEqual([])
  })

  it('fails closed on an unknown cookie, with no fallback to an ambient operator', () => {
    const { strategy } = strategyWith({ 'tok-a': clientSession('usr-ada', 'dev-laptop') })
    const outcome = strategy.authenticate({
      credential: { kind: 'sessionCookie' },
      hello,
      transport: transportFacts({
        endpoint: '/client',
        cookies: { [SESSION_COOKIE]: 'tok-forged' },
      }),
    })
    expect(outcome.ok).toBe(false)
    // The pre-multi-user behaviour was "whoever reaches /trpc is the OPERATOR".
    // There must be no principal at all here.
    expect(outcome.ok ? outcome.principal : null).toBeNull()
  })

  it('fails closed for a revoked or disabled account whose cookie is still valid', () => {
    const { strategy } = strategyWith({
      'tok-a': clientSession('usr-ada', 'dev-laptop', /* userActive */ false),
    })
    const outcome = strategy.authenticate({
      credential: { kind: 'sessionCookie' },
      hello,
      transport: transportFacts({ endpoint: '/client', cookies: { [SESSION_COOKIE]: 'tok-a' } }),
    })
    expect(outcome).toMatchObject({ ok: false, reason: 'auth-failed' })
  })

  it('refuses a cookie smuggled in the frame instead of the transport', () => {
    // The console credential carries no material by design. A peer that puts a
    // token in the envelope must not authenticate with it.
    const { strategy } = strategyWith({ 'tok-a': clientSession('usr-ada', 'dev-laptop') })
    const outcome = strategy.authenticate({
      credential: { kind: 'sessionCookie' },
      hello: {
        ...hello,
        // biome-ignore lint/suspicious/noExplicitAny: deliberately malformed peer input.
        claims: { ...HOSTILE_CLAIMS, [SESSION_COOKIE]: 'tok-a' } as any,
      },
      transport: transportFacts({ endpoint: '/client' }),
    })
    expect(outcome).toMatchObject({ ok: false, reason: 'auth-failed' })
  })
})
