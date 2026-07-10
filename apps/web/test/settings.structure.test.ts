// @vitest-environment node
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL('../src/' + rel, import.meta.url)), 'utf8')

// P5d (#264) split SettingsView's tab ladder into features/settings/sections/*;
// wording assertions read the section that owns each surface. The Telegram flow
// spans two files: the section renders the guidance, the view owns the state
// machine + startTelegramSetup (so the poll survives tab switches).
describe('settings structure', () => {
  it('explains how to configure Telegram notifications', () => {
    const src = read('features/settings/sections/notifications.tsx')
    // The manual chat-ID hunt (@userinfobot / @RawDataBot / getUpdates) was
    // replaced by the guided connect flow: create a bot, click Connect
    // Telegram, send the prefilled start message — Podium fills the chat ID.
    expect(src).toContain('Telegram setup')
    expect(src).toContain('@BotFather')
    expect(src).toContain('/newbot')
    expect(src).toContain('Connect Telegram')
    expect(src).toContain('setup code')
    expect(src).toContain('for this Podium server')
    expect(read('features/settings/SettingsView.tsx')).toContain('startTelegramSetup')
  })
})

describe('auto-continue setting', () => {
  it('exposes an auto-continue toggle with a token-cost warning', () => {
    const src = read('features/settings/sections/sessions.tsx')
    expect(src).toContain('Auto-continue on errors')
    expect(src).toContain('autoContinue')
    expect(src).toContain('enabled: checked')
    // The plain warning the spec requires.
    expect(src).toContain('indefinitely')
    expect(src).toContain('tokens')
  })
})

describe('background LLM backend wording', () => {
  it('does not imply every API backend needs a separate key', () => {
    const src = read('features/settings/sections/shared.tsx')
    expect(src).toContain('Provider backend (API key or local login)')
    expect(src).toContain('Agent CLI harness')
    expect(src).not.toContain('API provider (key required)')
  })

  it('describes Claude Code harness usage without saying subscriptions are always API-billed', () => {
    const src = read('features/settings/sections/shared.tsx')
    expect(src).toContain('counts against that account')
    expect(src).toContain('subscribers consume plan usage')
    expect(src).not.toContain('bills pay-per-use API rates even with a subscription')
  })
})
