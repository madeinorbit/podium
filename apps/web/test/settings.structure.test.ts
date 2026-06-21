// @vitest-environment node
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL('../src/' + rel, import.meta.url)), 'utf8')

describe('settings structure', () => {
  it('explains how to configure Telegram notifications', () => {
    const src = read('SettingsView.tsx')
    expect(src).toContain('Telegram setup')
    expect(src).toContain('@BotFather')
    expect(src).toContain('/newbot')
    expect(src).toContain('getUpdates')
    expect(src).toContain('global for this Podium server')
    expect(src).toContain('both a bot token and chat ID')
  })
})
