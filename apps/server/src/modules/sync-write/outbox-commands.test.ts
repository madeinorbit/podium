/**
 * EVERY QUEUED COMMAND IS ON THE ENTRY POINT (POD-6350, plan Task 10).
 *
 * Read off the registry the server actually composes, so a family that stopped
 * registering, or registered under another name, fails here rather than as a
 * client write that `sync.submit` answers "unknown command".
 */

import { afterEach, describe, expect, it } from 'vitest'
import { disposeOracles, makeOracle } from '../sessions/oracle-support'
import { OUTBOX_COMMAND_NAMES } from './outbox-commands'

afterEach(() => disposeOracles())

describe('the outbox commands on sync.submit', () => {
  it('the composed registry holds exactly the queued commands', async () => {
    const o = await makeOracle()

    expect(o.reg.modules.syncWrite.registry.names().sort()).toEqual(
      [...OUTBOX_COMMAND_NAMES].sort(),
    )
  })

  it('every registration is at the version the client queues it under (1)', async () => {
    const o = await makeOracle()

    for (const name of OUTBOX_COMMAND_NAMES) {
      expect(o.reg.modules.syncWrite.registry.lookup(name)?.version, name).toBe(1)
    }
  })
})
