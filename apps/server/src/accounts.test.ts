import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeSettings, type PodiumSettings } from '@podium/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { accountViews } from './accounts'

let home: string
let codexHome: string
const prevCodexHome = process.env.CODEX_HOME
const prevGrokHome = process.env.GROK_HOME

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'acct-home-'))
  codexHome = mkdtempSync(join(tmpdir(), 'acct-codex-'))
  process.env.CODEX_HOME = codexHome
  delete process.env.GROK_HOME
})
afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  rmSync(codexHome, { recursive: true, force: true })
  if (prevCodexHome === undefined) delete process.env.CODEX_HOME
  else process.env.CODEX_HOME = prevCodexHome
  if (prevGrokHome === undefined) delete process.env.GROK_HOME
  else process.env.GROK_HOME = prevGrokHome
})

const settings = (keys: Partial<PodiumSettings['apiKeys']> = {}): PodiumSettings =>
  normalizeSettings({ apiKeys: { openrouter: '', anthropic: '', openai: '', ...keys } })

describe('accountViews', () => {
  it('reports native logins as not-configured when nothing is present', () => {
    const views = accountViews(settings(), home)
    const claude = views.find((v) => v.id === 'native:claude-code')!
    expect(claude.status).toBe('not-configured')
    expect(views.find((v) => v.id === 'native:codex')!.status).toBe('not-configured')
    expect(views.find((v) => v.id === 'native:grok')!.status).toBe('not-configured')
  })

  it('detects a Claude login and surfaces the email as identity', () => {
    writeFileSync(
      join(home, '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: 'mike@example.com' } }),
    )
    const claude = accountViews(settings(), home).find((v) => v.id === 'native:claude-code')!
    expect(claude.status).toBe('connected')
    expect(claude.identity).toBe('mike@example.com')
    expect(claude.source).toBe('native')
  })

  it('detects a Grok login by directory presence', () => {
    mkdirSync(join(home, '.grok'))
    expect(accountViews(settings(), home).find((v) => v.id === 'native:grok')!.status).toBe(
      'connected',
    )
  })

  it('surfaces set API keys as connected managed accounts with a masked identity', () => {
    const views = accountViews(settings({ anthropic: 'sk-ant-abcdefgh1234' }), home)
    const anthropic = views.find((v) => v.id === 'managed:anthropic')!
    expect(anthropic.source).toBe('managed')
    expect(anthropic.kind).toBe('api-key')
    expect(anthropic.status).toBe('connected')
    expect(anthropic.identity).toBe('sk-a…1234') // masked, not the raw key
    expect(anthropic.identity).not.toContain('abcdefgh')
    // Unset keys are present but not-configured.
    expect(views.find((v) => v.id === 'managed:openai')!.status).toBe('not-configured')
  })
})
