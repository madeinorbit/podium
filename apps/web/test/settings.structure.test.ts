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
    expect(src).toContain('@userinfobot')
    expect(src).toContain('@RawDataBot')
    expect(src).toContain('remove the helper bot')
    expect(src).toContain('getUpdates')
    expect(src).toContain('global for this Podium server')
    expect(src).toContain('both a bot token and chat ID')
  })
})

describe('auto-continue setting', () => {
  it('exposes an auto-continue toggle with a token-cost warning', () => {
    const src = read('SettingsView.tsx')
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
    const src = read('SettingsView.tsx')
    expect(src).toContain('Provider backend (API key or local login)')
    expect(src).toContain('Agent CLI harness')
    expect(src).not.toContain('API provider (key required)')
  })

  it('describes Claude Code harness usage without saying subscriptions are always API-billed', () => {
    const src = read('SettingsView.tsx')
    expect(src).toContain('counts against that account')
    expect(src).toContain('subscribers consume plan usage')
    expect(src).not.toContain('bills pay-per-use API rates even with a subscription')
  })
})
