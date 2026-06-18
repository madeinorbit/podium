import { describe, expect, it } from 'vitest'
import { langIdForPath } from './editor-lang'

describe('langIdForPath', () => {
  it('maps extensions to language ids', () => {
    expect(langIdForPath('/a/b.ts')).toBe('javascript')
    expect(langIdForPath('/a/b.tsx')).toBe('javascript')
    expect(langIdForPath('/a/b.json')).toBe('json')
    expect(langIdForPath('/a/readme.md')).toBe('markdown')
    expect(langIdForPath('/a/x.unknownext')).toBe('plain')
  })
})
