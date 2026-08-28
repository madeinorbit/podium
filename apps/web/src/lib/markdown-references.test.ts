import { afterEach, describe, expect, it } from 'vitest'
import {
  getKnownRefPrefixes,
  isKnownRefPrefix,
  setKnownRefPrefixes,
} from './markdown-references'

afterEach(() => setKnownRefPrefixes([]))

describe('Markdown reference registry', () => {
  it('shares the latest prefix set without parser or DOM state', () => {
    setKnownRefPrefixes(['POD', 'SDK'])

    expect(isKnownRefPrefix('POD')).toBe(true)
    expect(isKnownRefPrefix('SDK')).toBe(true)
    expect(isKnownRefPrefix('UTF')).toBe(false)
    expect([...getKnownRefPrefixes()]).toEqual(['POD', 'SDK'])
  })

  it('replaces stale prefixes when repositories change', () => {
    setKnownRefPrefixes(['OLD'])
    setKnownRefPrefixes(['NEW'])

    expect(isKnownRefPrefix('OLD')).toBe(false)
    expect(isKnownRefPrefix('NEW')).toBe(true)
  })
})
