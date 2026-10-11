import { describe, expect, it } from 'vitest'
import { offerServerMoveWhenPairing, SERVER_MOVE_OFFERED } from './MachinesPanel'

describe('server move offers', () => {
  // Off until server transfer has been tested end to end (POD-5969): no pre-ticked
  // "make this the server" when pairing, and no "Make server" on machine rows.
  it('offers no server move anywhere in the Machines panel', () => {
    expect(SERVER_MOVE_OFFERED).toBe(false)
  })

  // Off until server transfer from pairing has been tested end to end (POD-5969): adding a
  // first extra machine must not pre-tick "make this the server".
  it('offers no server move when adding a machine, even to a one-machine fleet', () => {
    expect(offerServerMoveWhenPairing(1)).toBe(false)
    expect(offerServerMoveWhenPairing(2)).toBe(false)
  })
})
