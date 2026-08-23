import { describe, expect, it } from 'vitest'
import {
  fileKindForPath,
  isAudioPath,
  isHtmlPath,
  isImagePath,
  isJsonPath,
  isMarkdownPath,
  isPdfPath,
  isTablePath,
  isVideoPath,
} from './file-kind'

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

  it('claims .json but leaves the comment-bearing dialects alone', () => {
    expect(isJsonPath('/repo/package.json')).toBe(true)
    expect(isJsonPath('/repo/DATA.JSON')).toBe(true)
    expect(isJsonPath('/repo/tsconfig.jsonc')).toBe(false)
    expect(isJsonPath('/repo/config.json5')).toBe(false)
    expect(isJsonPath('/repo/notes.json.md')).toBe(false)
  })

  it('classifies paths for the file panel router', () => {
    expect(fileKindForPath('/repo/index.html')).toBe('html')
    expect(fileKindForPath('/repo/readme.md')).toBe('markdown')
    expect(fileKindForPath('/repo/package.json')).toBe('json')
    expect(fileKindForPath('/repo/results.csv')).toBe('table')
    expect(fileKindForPath('/repo/hero.avif')).toBe('image')
    expect(fileKindForPath('/repo/design.pdf')).toBe('pdf')
    expect(fileKindForPath('/repo/demo.webm')).toBe('video')
    expect(fileKindForPath('/repo/interview.flac')).toBe('audio')
    expect(fileKindForPath('/repo/src/app.ts')).toBe('source')
  })

  it('recognises the previewable asset families case-insensitively', () => {
    expect(isTablePath('DATA.TSV')).toBe(true)
    expect(isImagePath('photo.JPEG')).toBe(true)
    expect(isPdfPath('brief.PDF')).toBe(true)
    expect(isVideoPath('clip.M4V')).toBe(true)
    expect(isAudioPath('voice.M4A')).toBe(true)
  })
})
