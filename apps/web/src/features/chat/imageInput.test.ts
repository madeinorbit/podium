import { buildImagePrompt } from '@podium/client-core/viewmodels'
import { describe, expect, it } from 'vitest'
import { hasImageItems } from './image-items'

describe('buildImagePrompt', () => {
  it('returns text unchanged when no paths', () => {
    expect(buildImagePrompt([], 'hello')).toBe('hello')
  })
  it('prepends a single path', () => {
    expect(buildImagePrompt(['/tmp/img.png'], 'hello')).toBe('/tmp/img.png\nhello')
  })
  it('prepends multiple paths', () => {
    expect(buildImagePrompt(['/tmp/a.png', '/tmp/b.png'], 'hi')).toBe('/tmp/a.png\n/tmp/b.png\nhi')
  })
})

describe('hasImageItems', () => {
  const makeItems = (types: string[]) => {
    const items = types.map((type) => ({
      type,
      kind: 'file' as DataTransferItem['kind'],
      getAsFile: () => null,
      getAsString: () => undefined,
      webkitGetAsEntry: () => null,
    }))
    return Object.assign(items, { length: items.length }) as unknown as DataTransferItemList
  }
  it('returns true when image item present', () => {
    expect(hasImageItems(makeItems(['image/png']))).toBe(true)
  })
  it('returns false with no images', () => {
    expect(hasImageItems(makeItems(['text/plain']))).toBe(false)
  })
  it('returns true when mixed items include image', () => {
    expect(hasImageItems(makeItems(['text/plain', 'image/jpeg']))).toBe(true)
  })
})
