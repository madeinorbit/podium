/**
 * THE HIDDEN-READ INVENTORY, RUN AGAINST THIS CHECKOUT [POD-3256, POD-3372].
 *
 * Two halves, and the epic needs both. The script's own `--probe` proves the
 * scan can still SAY YES — POD-3372 was a scan that had stopped classifying
 * correctly, and a scan nobody trusts is one people skim past the one true
 * finding in. This file adds the half a probe cannot cover: that shipping code
 * is clean on the tree as it stands, so a hidden read reintroduced into a
 * constructor or a getter fails the suite rather than waiting for somebody to
 * remember to run the script.
 */

import { describe, expect, it } from 'vitest'
import { probe, scanCheckout } from './scan-hidden-store-reads'

describe('the hidden-read inventory', () => {
  it('can say yes, and stays quiet on the shapes that are not reads', () => {
    // Reasons rather than a count, so a failure says WHICH half broke: losing a
    // planted read and flooding on a handle accessor are opposite defects.
    expect(probe()).toEqual([])
  })

  it('finds no store read in a constructor or getter in shipping code', () => {
    // Named sites rather than a length, so a failure names the constructor.
    expect(scanCheckout().shipping.map((f) => `${f.file}:${f.line} ${f.holder}`)).toEqual([])
  })

  it('still counts the boot reads and the registration instead of hiding them', () => {
    // The residue is visible ON PURPOSE: nine SessionStore boot reads the flip
    // [B1] converts, and one listener install that issues no statement. If this
    // count moves, either the flip happened or something new slipped into
    // `SessionStore`'s constructor — both want a human.
    const { boot, registrations } = scanCheckout()
    expect(boot).toHaveLength(9)
    expect(registrations.map((f) => `${f.holder}.${f.call}`)).toEqual([
      'SessionRegistry.this.store.events.onAppend',
    ])
  })
})
