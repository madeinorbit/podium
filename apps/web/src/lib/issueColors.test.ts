import { describe, expect, it } from 'vitest'
import { FLOW_SLATE, ISSUE_PALETTE, issueColorHex, issueSquareFg } from './issueColors'

describe('issue colour palette', () => {
  it('keeps the canonical spectrum order and values from the design handoff', () => {
    expect(ISSUE_PALETTE).toEqual([
      { name: 'rose', hex: '#f43f5e' },
      { name: 'pink', hex: '#ec4899' },
      { name: 'fuchsia', hex: '#d946ef' },
      { name: 'violet', hex: '#8b5cf6' },
      { name: 'indigo', hex: '#6366f1' },
      { name: 'blue', hex: '#3b82f6' },
      { name: 'cyan', hex: '#06b6d4' },
      { name: 'teal', hex: '#14b8a6' },
      { name: 'green', hex: '#22c55e' },
      { name: 'lime', hex: '#84cc16' },
    ])
  })

  it('keeps status and no-colour accents out of the pickable palette', () => {
    const pickable = new Set(ISSUE_PALETTE.map(({ hex }) => hex.toLowerCase()))

    expect(pickable.size).toBe(10)
    expect(pickable.has('#f59e0b')).toBe(false) // attention
    expect(pickable.has('#d97757')).toBe(false) // Claude
    expect(pickable.has('#10b981')).toBe(false) // working
    expect(pickable.has(FLOW_SLATE)).toBe(false) // no-colour flow
  })

  it('resolves persisted slot names without accepting arbitrary values', () => {
    expect(issueColorHex('violet')).toBe('#8b5cf6')
    expect(issueColorHex('amber')).toBeUndefined()
    expect(issueColorHex(null)).toBeUndefined()
  })

  it('uses the canonical 30%-into-black foreground recipe for solid fills', () => {
    expect(issueSquareFg('#8b5cf6')).toBe('color-mix(in srgb, #8b5cf6 30%, #000)')
  })
})
