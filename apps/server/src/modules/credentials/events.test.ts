import { asMachineId, asSessionId, asUserId } from '@podium/model'
import { afterEach, describe, expect, expectTypeOf, it } from 'vitest'
import type { SessionStore } from '../../store'
import { openTestStore } from '../../test-support/open-test-store'
import { asCredentialId } from './credential-id'
import { type CredentialEvent, recordCredentialEvent } from './events'

/** Obviously fake. */
const CANARY = 'FAKE-sk-event-canary-0001'

describe('recordCredentialEvent', () => {
  let store: SessionStore | undefined

  afterEach(async () => {
    await store?.close()
    store = undefined
  })

  it('writes an event to the security trail that reads back', async () => {
    store = await openTestStore(':memory:')
    await recordCredentialEvent(store, {
      kind: 'deliver',
      credentialId: asCredentialId('cred_00000000-0000-4000-8000-000000000001'),
      actorUserId: asUserId('user:owner'),
      sessionId: asSessionId('session-1'),
      machineId: asMachineId('machine-1'),
      detail: 'env',
    })
    await recordCredentialEvent(store, {
      kind: 'refuse',
      credentialId: null,
      actorUserId: asUserId('user:owner'),
      detail: 'not-yours',
    })
    const rows = (await store.settingsAudit.list()).filter((r) =>
      r.command.startsWith('credentials.'),
    )
    expect(rows).toEqual([
      expect.objectContaining({
        command: 'credentials.deliver',
        outcome: 'applied',
        actorKind: 'user',
        actorId: 'user:owner',
        onBehalfOf: 'user:owner',
        detail: {
          credentialId: 'cred_00000000-0000-4000-8000-000000000001',
          sessionId: 'session-1',
          machineId: 'machine-1',
          detail: 'env',
        },
      }),
      expect.objectContaining({
        command: 'credentials.refuse',
        outcome: 'refused',
        detail: { credentialId: null, detail: 'not-yours' },
      }),
    ])
  })

  it('has no parameter that takes a secret, and drops one smuggled in', async () => {
    expectTypeOf<keyof CredentialEvent>().toEqualTypeOf<
      'kind' | 'credentialId' | 'actorUserId' | 'sessionId' | 'machineId' | 'detail'
    >()
    store = await openTestStore(':memory:')
    const smuggled = {
      kind: 'add',
      credentialId: null,
      actorUserId: asUserId('user:owner'),
      secret: CANARY,
      plaintext: CANARY,
    }
    // Canary: the search finds the secret in what was passed.
    expect(JSON.stringify(smuggled)).toContain(CANARY)
    await recordCredentialEvent(store, smuggled as unknown as CredentialEvent)
    expect(JSON.stringify(await store.settingsAudit.list(1000))).not.toContain(CANARY)
  })
})
