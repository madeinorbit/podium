/**
 * A CREDENTIAL IS NEVER QUEUED (credential management Task 4, acceptance 5).
 *
 * An `add` made while the client is offline is rejected, not stored for later:
 * the client's queue knows no `credentials.*` kind, and the sync kernel's outbox
 * refuses the contract's own delivery class before anything is persisted, so the
 * secret never reaches device storage.
 */

import { CREDENTIAL_CONTRACT_NAMES, CREDENTIAL_CONTRACTS } from '@podium/commands'
import { asUserId } from '@podium/model'
import {
  type EnqueueRequest,
  InMemoryOutboxStore,
  ManualClock,
  Outbox,
  OutboxUsageError,
  ScriptedAuthority,
  sequentialMutationIds,
} from '@podium/sync/outbox'
import { describe, expect, it } from 'vitest'
import { OUTBOX_COMMANDS } from './wiring'

const PLANT = 'FAKE-sk-ant-offline-plant-6891'

describe('credentials are never queued', () => {
  it('the client queue has no credentials.* kind', () => {
    const queued = Object.values(OUTBOX_COMMANDS).map((command) => command.name)
    // Probe: the list is real and names commands by their dotted name.
    expect(queued).toContain('effects.create')
    for (const name of CREDENTIAL_CONTRACT_NAMES) {
      expect(queued).not.toContain(`credentials.${name}`)
    }
  })

  it('an offline credentials.add is refused by the outbox and nothing is stored', async () => {
    const store = new InMemoryOutboxStore()
    let submitted = 0
    const outbox = await Outbox.open({
      store,
      submit: new ScriptedAuthority(() => {
        submitted += 1
        return { kind: 'unreachable' }
      }),
      principal: 'u-owner',
      now: new ManualClock().now,
      maxAgeMs: 60_000,
      newMutationId: sequentialMutationIds('m'),
      onStoreUnreadable: () => {},
    })
    const contract = CREDENTIAL_CONTRACTS.add
    const request = {
      command: {
        name: contract.name,
        version: contract.version,
        delivery: contract.delivery.class,
      },
      input: { type: 'anthropic.api-key', label: 'Mine', secret: PLANT },
      attribution: {
        actor: { kind: 'user', id: asUserId('u-owner') },
        onBehalfOf: asUserId('u-owner'),
      },
    } as unknown as EnqueueRequest

    // Canary: the request itself carries the plant.
    expect(JSON.stringify(request)).toContain(PLANT)
    await expect(outbox.enqueue(request)).rejects.toThrow(OutboxUsageError)
    await outbox.drain()

    expect(outbox.all()).toEqual([])
    expect(store.durable()).toEqual([])
    expect(JSON.stringify(store.durable())).not.toContain(PLANT)
    expect(submitted).toBe(0)
  })
})
