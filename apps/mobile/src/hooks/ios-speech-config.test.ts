import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('iOS speech configuration', () => {
  it('declares the microphone purpose without server speech authorization', () => {
    const app = JSON.parse(readFileSync(resolve(process.cwd(), 'app.json'), 'utf8'))
    const infoPlist = app.expo.ios.infoPlist

    expect(infoPlist.NSMicrophoneUsageDescription).toMatch(/dictat|voice/i)
    expect(infoPlist).not.toHaveProperty('NSSpeechRecognitionUsageDescription')
  })
})
