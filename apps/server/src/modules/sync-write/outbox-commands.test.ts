/**
 * EVERY QUEUED COMMAND IS ON THE ENTRY POINT (POD-6350, plan Task 10).
 *
 * Read off the registry the server actually composes, so a family that stopped
 * registering, or registered under another name, fails here rather than as a
 * client write that `sync.submit` answers "unknown command".
 */

import { RECORD_CONTRACTS } from '@podium/commands'
import { afterEach, describe, expect, it } from 'vitest'
import { disposeOracles, makeOracle } from '../sessions/oracle-support'
import { FAMILY_COMMAND_NAMES } from './family-commands'

/** The effect record commands (POD-6393), registered beside the others. */
const EFFECT_COMMAND_NAMES = ['effects.create', 'effects.cancel', 'effects.dismiss']

import { OUTBOX_COMMAND_NAMES } from './outbox-commands'

afterEach(() => disposeOracles())

describe('the outbox commands on sync.submit', () => {
  it('the composed registry holds exactly the queued, the generic record and the family commands', async () => {
    const o = await makeOracle()

    // The generic create, edit and remove (POD-6391) sit beside the queued
    // commands they replace, one family at a time (POD-6355); the families'
    // own writes follow them onto the entry point (POD-6359).
    expect(o.reg.modules.syncWrite.registry.names().sort()).toEqual(
      [
        ...OUTBOX_COMMAND_NAMES,
        ...Object.keys(RECORD_CONTRACTS),
        ...EFFECT_COMMAND_NAMES,
        ...FAMILY_COMMAND_NAMES,
      ].sort(),
    )
  })

  it('every registration is at the version the client queues it under (1)', async () => {
    const o = await makeOracle()

    for (const name of OUTBOX_COMMAND_NAMES) {
      expect(o.reg.modules.syncWrite.registry.lookup(name)?.version, name).toBe(1)
    }
  })
})
