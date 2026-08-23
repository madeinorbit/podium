import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('iOS speech configuration', () => {
  it('declares the microphone purpose without server speech authorization', () => {
    const app = JSON.parse(readFileSync(new URL('../../app.json', import.meta.url), 'utf8'))
    const infoPlist = app.expo.ios.infoPlist

    expect(infoPlist.NSMicrophoneUsageDescription).toMatch(/dictat|voice/i)
    expect(infoPlist).not.toHaveProperty('NSSpeechRecognitionUsageDescription')
  })
})
