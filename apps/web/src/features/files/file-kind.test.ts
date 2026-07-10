import { describe, expect, it } from 'vitest'
import { fileKindForPath, isHtmlPath, isMarkdownPath } from './file-kind'

describe('file kind helpers', () => {
  it('detects static HTML extensions case-insensitively', () => {
    expect(isHtmlPath('/repo/index.html')).toBe(true)
    expect(isHtmlPath('/repo/export.HTM')).toBe(true)
    expect(isHtmlPath('/repo/readme.md')).toBe(false)
  })

  it('keeps markdown detection separate from html detection', () => {
    expect(isMarkdownPath('/repo/readme.md')).toBe(true)
    expect(isMarkdownPath('/repo/docs/guide.markdown')).toBe(true)
    expect(isMarkdownPath('/repo/index.html')).toBe(false)
  })

  it('classifies paths for the file panel router', () => {
    expect(fileKindForPath('/repo/index.html')).toBe('html')
    expect(fileKindForPath('/repo/readme.md')).toBe('markdown')
    expect(fileKindForPath('/repo/src/app.ts')).toBe('source')
  })
})
