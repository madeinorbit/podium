import { describe, expect, it } from 'vitest'
import { AUTH_ROLES, PeerCredential } from '../envelope'
import { createRecordingMinter, fakeClientSessions, fakeDelegations, fakeMachines } from '../test-support'
import { createDefaultAuthRegistry } from './default-registry'
import { createAuthStrategyRegistry } from './registry'

const allPorts = () => ({
  clientSessions: fakeClientSessions({}),
  machines: fakeMachines({}),
  delegations: fakeDelegations([]),
  mint: createRecordingMinter(),
})

/** Every `kind` the envelope's credential union can carry. */
const CREDENTIAL_KINDS = PeerCredential.options.map((o) => o.shape.kind.value)

describe('auth strategy registry', () => {
  it('selects by (role, credentialKind) — a lookup, not a conditional', () => {
    const registry = createDefaultAuthRegistry(allPorts())
    expect(registry.lookup('machine', 'daemonSecret')?.name).toBe('machine-local-secret')
    expect(registry.lookup('machine', 'pairCode')?.name).toBe('machine-pair-code')
    expect(registry.lookup('machine', 'machineToken')?.name).toBe('machine-token')
    expect(registry.lookup('console', 'sessionCookie')?.name).toBe('console-cookie')
    expect(registry.lookup('agent-relay', 'delegationRef')?.name).toBe('agent-relay-delegation')
    expect(registry.lookup('node', 'nodeCredential')?.name).toBe('node-reserved-inert')
  })

  it('has an entry for every role and every credential kind — no silent gaps', () => {
    const entries = createDefaultAuthRegistry(allPorts()).entries()
    const roles = new Set(entries.map((e) => e.role))
    for (const role of AUTH_ROLES) expect([...roles]).toContain(role)
    const kinds = new Set(entries.map((e) => e.credentialKind))
    for (const kind of CREDENTIAL_KINDS) expect([...kinds]).toContain(kind)
  })

  it('refuses a credential a role does not claim', () => {
    const registry = createDefaultAuthRegistry(allPorts())
    // A console peer cannot reach the machine credentials by naming one.
    expect(registry.lookup('console', 'daemonSecret')).toBeNull()
    expect(registry.lookup('machine', 'sessionCookie')).toBeNull()
    // Nor can a peer reach the relay's or the operator channel's strategy.
    expect(registry.lookup('machine', 'delegationRef')).toBeNull()
    expect(registry.lookup('console', 'operatorChannel')).toBeNull()
  })

  it('registers an explicit refusal, not a gap, when a port is unwired', () => {
    // Production today: no per-user client sessions (POD-1075 not landed).
    const registry = createDefaultAuthRegistry({ machines: fakeMachines({}), mint: createRecordingMinter() })
    const console_ = registry.lookup('console', 'sessionCookie')
    expect(console_?.name).toBe('unavailable(console/sessionCookie)')
    const outcome = console_?.authenticate({
      credential: { kind: 'sessionCookie' },
      hello: {
        type: 'peerHello',
        v: 1,
        caps: [],
        credential: { kind: 'sessionCookie' },
      },
      transport: { endpoint: '/client', cookies: { podium_session: 'anything' } },
    })
    expect(outcome).toMatchObject({ ok: false, reason: 'auth-failed' })
  })

  it('rejects two strategies claiming the same pair', () => {
    const one = createDefaultAuthRegistry(allPorts()).entries()[0]
    expect(one).toBeDefined()
    expect(() =>
      createAuthStrategyRegistry([
        {
          role: 'machine',
          credentialKind: 'daemonSecret',
          name: 'a',
          authenticate: () => ({ ok: false, reason: 'auth-failed' }),
        },
        {
          role: 'machine',
          credentialKind: 'daemonSecret',
          name: 'b',
          authenticate: () => ({ ok: false, reason: 'auth-failed' }),
        },
      ]),
    ).toThrow(/duplicate auth strategy/)
  })
})
