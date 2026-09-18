import { describe, expect, it } from 'vitest'
import { attributionOf } from '../../planes/principal'
import { helloFor, transportFacts } from '../test-support'
import { createHandshakeAcceptor } from '../acceptor'
import { createAuthStrategyRegistry } from './registry'
import { createNodeReservedStrategy } from './node-reserved'
import { createSystemStrategy, SYSTEM_JOBS, systemPrincipal } from './system'

describe('node peer role — reserved and inert (ADR 5 D4/D5)', () => {
  it('refuses with role-not-implemented, and does not throw', () => {
    const strategy = createNodeReservedStrategy()
    const credential = { kind: 'nodeCredential' } as const
    const outcome = strategy.authenticate({
      credential,
      hello: helloFor(credential, { peerRole: 'node', feedId: 'feed-1' }),
      transport: transportFacts({ endpoint: '/daemon' }),
    })
    expect(outcome).toMatchObject({ ok: false, reason: 'role-not-implemented' })
  })

  it('grants nothing — there is no principal on the refusal path', () => {
    const outcome = createNodeReservedStrategy().authenticate({
      credential: { kind: 'nodeCredential' },
      hello: helloFor({ kind: 'nodeCredential' }),
      transport: transportFacts(),
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.ok ? outcome.principal : undefined).toBeUndefined()
  })
})

describe('system principals (ADR 3 Am.1 D21)', () => {
  it('are not reachable from any transport', () => {
    const outcome = createSystemStrategy().authenticate({
      credential: { kind: 'operatorChannel' },
      hello: helloFor({ kind: 'operatorChannel' }),
      // Even in-process: the class is constructed, never authenticated.
      transport: transportFacts({ endpoint: 'in-process', inProcess: true }),
    })
    expect(outcome).toMatchObject({ ok: false, reason: 'auth-failed' })
  })

  it.each(['/client', '/daemon', '/machine'])('refuses a wire system claim on %s before establishing a principal', (endpoint) => {
    const acceptor = createHandshakeAcceptor({
      registry: createAuthStrategyRegistry([createSystemStrategy()]),
      transport: transportFacts({ endpoint, inProcess: false }),
    })
    const claim = {
      ...helloFor({ kind: 'operatorChannel' }),
      peerRole: 'system',
      principal: { kind: 'system', job: 'steward' },
    }
    expect(acceptor.receive(JSON.stringify(claim))).toMatchObject({
      action: 'reject', reply: { reason: 'malformed-hello' },
    })
    expect(acceptor.state).toBe('closed')
    expect(acceptor.peer).toBeNull()
    expect(acceptor.receive(JSON.stringify({ type: 'inventoryRequest' })).action).not.toBe('deliver')
  })

  it('refuses wire authentication even when the composition root selects the system strategy', () => {
    const acceptor = createHandshakeAcceptor({
      registry: createAuthStrategyRegistry([createSystemStrategy()]),
      role: 'system',
      transport: transportFacts({ endpoint: '/daemon', inProcess: false }),
    })
    expect(acceptor.receive(JSON.stringify(helloFor({ kind: 'operatorChannel' })))).toMatchObject({
      action: 'reject', reply: { reason: 'auth-failed' },
    })
    expect(acceptor.peer).toBeNull()
    expect(acceptor.state).toBe('closed')
  })

  it('resolve as system with NO on-behalf-of, for every named job', () => {
    for (const job of SYSTEM_JOBS) {
      const principal = systemPrincipal(job)
      expect(principal).toEqual({ kind: 'system', job })
      // "None" is a representable value, never defaulted to an operator or to
      // the row's owner (D17.5).
      expect(attributionOf(principal)).toEqual({ actor: job, onBehalfOf: null })
    }
  })
})
