/**
 * Layout contracts (POD-1350) — closed vocabulary, per-user-state class, outbox.
 */

import { describe, expect, it } from 'vitest'
import { classificationErrors } from '../contract'
import {
  LAYOUT_CONTRACT_NAMES,
  LAYOUT_CONTRACTS,
  layoutClearInput,
  layoutSetInput,
} from './contracts'

describe('layout contracts classify cleanly', () => {
  it.each(LAYOUT_CONTRACT_NAMES)('%s passes classificationErrors', (name) => {
    expect(classificationErrors(LAYOUT_CONTRACTS[name])).toEqual([])
  })

  it('both writes are per-user-state, offline-eligible, and on the outbox', () => {
    for (const name of LAYOUT_CONTRACT_NAMES) {
      const c = LAYOUT_CONTRACTS[name]
      expect(c.visibility).toBe('per-user-state')
      expect(c.delivery.class).toBe('offline-eligible')
      expect(c.exposure).toContain('trpc')
      expect(c.exposure).toContain('outbox')
      expect(c.conflict).toBe('single-writer')
      expect(c.policy.roleFloor).toBe('member')
      expect(c.policy.resource).toBe('none')
    }
  })
})

describe('layout.set input is closed over isLayoutKey', () => {
  it('accepts a known exact key and a dynamic section key', () => {
    expect(
      layoutSetInput.safeParse({ values: { dockTab: 'files', 'sidebar.section.closed': true } })
        .success,
    ).toBe(true)
  })

  it('refuses an empty patch and a free-form key', () => {
    expect(layoutSetInput.safeParse({ values: {} }).success).toBe(false)
    expect(layoutSetInput.safeParse({ values: { 'podium.view': 'workspace' } }).success).toBe(
      false,
    )
    expect(layoutSetInput.safeParse({ values: { 'sidebar.width': 320 } }).success).toBe(false)
  })

  it('refuses device-local route and geometry keys by their layout names too', () => {
    // Even without the podium. prefix, these are not in the closed list.
    expect(layoutSetInput.safeParse({ values: { view: 'workspace' } }).success).toBe(false)
    expect(layoutSetInput.safeParse({ values: { paneA: 's1' } }).success).toBe(false)
    expect(layoutSetInput.safeParse({ values: { split: '0.5' } }).success).toBe(false)
  })
})

describe('layout.clear input', () => {
  it('accepts known keys and refuses an empty list or unknown key', () => {
    expect(layoutClearInput.safeParse({ keys: ['dockTab', 'superOpen'] }).success).toBe(true)
    expect(layoutClearInput.safeParse({ keys: [] }).success).toBe(false)
    expect(layoutClearInput.safeParse({ keys: ['podium.view'] }).success).toBe(false)
  })
})
