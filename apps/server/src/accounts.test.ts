import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeSettings, type PodiumSettings } from '@podium/runtime'
import { openDatabase } from '@podium/runtime/sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AccountConnectInput, accountViews } from './accounts'
import { MIGRATIONS, runMigrations } from './migrations'
import { AccountsRepository } from './store/accounts'

let home: string
let codexHome: string
let accounts: AccountsRepository
const prevCodexHome = process.env.CODEX_HOME
const prevGrokHome = process.env.GROK_HOME

/** A fresh, empty managed-accounts store — the "no stored credential" baseline. */
function emptyAccounts(): AccountsRepository {
  const db = openDatabase(':memory:')
  runMigrations(db, MIGRATIONS)
  return new AccountsRepository(db)
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'acct-home-'))
  codexHome = mkdtempSync(join(tmpdir(), 'acct-codex-'))
  process.env.CODEX_HOME = codexHome
  delete process.env.GROK_HOME
  accounts = emptyAccounts()
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
    const views = accountViews(settings(), accounts, home)
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
    const claude = accountViews(settings(), accounts, home).find(
      (v) => v.id === 'native:claude-code',
    )!
    expect(claude.status).toBe('connected')
    expect(claude.identity).toBe('mike@example.com')
    expect(claude.source).toBe('native')
  })

  it('detects a Grok login by directory presence', () => {
    mkdirSync(join(home, '.grok'))
    expect(
      accountViews(settings(), accounts, home).find((v) => v.id === 'native:grok')!.status,
    ).toBe('connected')
  })

  it('surfaces set API keys as connected managed accounts with a masked identity', () => {
    const views = accountViews(settings({ anthropic: 'sk-ant-abcdefgh1234' }), accounts, home)
    const anthropic = views.find((v) => v.id === 'managed:anthropic')!
    expect(anthropic.source).toBe('managed')
    expect(anthropic.kind).toBe('api-key')
    expect(anthropic.status).toBe('connected')
    expect(anthropic.identity).toBe('sk-a…1234') // masked, not the raw key
    expect(anthropic.identity).not.toContain('abcdefgh')
    // Unset keys are present but not-configured.
    expect(views.find((v) => v.id === 'managed:openai')!.status).toBe('not-configured')
  })

  /** A legacy settings key has NO row for accounts.remove() to delete. Marking it
   *  'legacy' is what stops the UI offering a Disconnect the server cannot honour
   *  (the button reported ok:true, deleted nothing, and the row stayed connected —
   *  an unbreakable loop for anyone with a pre-hub API key). */
  it('marks a legacy settings key as legacy, and a stored credential as stored', () => {
    const legacy = accountViews(
      settings({ anthropic: 'sk-ant-abcdefgh1234' }),
      accounts,
      home,
    ).find((v) => v.id === 'managed:anthropic')!
    expect(legacy.status).toBe('connected')
    expect(legacy.credentialSource).toBe('legacy')

    accounts.upsert({
      id: 'managed:anthropic',
      provider: 'anthropic',
      kind: 'api-key',
      credential: 'sk-ant-stored',
      identity: 'sk-a…ored',
      scope: 'role',
      createdAt: 1,
    })
    const stored = accountViews(
      settings({ anthropic: 'sk-ant-abcdefgh1234' }),
      accounts,
      home,
    ).find((v) => v.id === 'managed:anthropic')!
    // The stored row wins over the legacy key, and IS disconnectable.
    expect(stored.credentialSource).toBe('stored')
    expect(stored.identity).toBe('sk-a…ored')
  })

  it('leaves an unconfigured managed row with no credential source', () => {
    const view = accountViews(settings(), accounts, home).find((v) => v.id === 'managed:openai')!
    expect(view.status).toBe('not-configured')
    expect(view.credentialSource).toBeUndefined()
  })

  /** identity is a display mask, not the credential. A stored row with an empty one
   *  still injects a live key at spawn — status keys off the ROW, not the string. */
  it('reports a stored row with an empty identity as connected, not not-configured', () => {
    accounts.upsert({
      id: 'managed:openai',
      provider: 'openai',
      kind: 'api-key',
      credential: 'sk-live-key',
      identity: '',
      scope: 'role',
      createdAt: 1,
    })
    const view = accountViews(settings(), accounts, home).find((v) => v.id === 'managed:openai')!
    expect(view.status).toBe('connected')
    expect(view.credentialSource).toBe('stored')
    expect(JSON.stringify(view)).not.toContain('sk-live-key')
  })

  it('shows a connected managed account as connected, masked, and never leaks the secret', () => {
    accounts.upsert({
      id: 'managed:anthropic',
      provider: 'anthropic',
      kind: 'api-key',
      credential: 'sk-ant-supersecret',
      identity: 'sk-a…cret',
      scope: 'role',
      createdAt: 1,
    })

    const views = accountViews(settings(), accounts, home)
    const view = views.find((v) => v.id === 'managed:anthropic')

    expect(view?.status).toBe('connected')
    expect(view?.identity).toBe('sk-a…cret')
    // The security invariant: a credential never rides out in a response payload.
    expect(JSON.stringify(views)).not.toContain('sk-ant-supersecret')
  })

  it('shows a stored Claude setup-token as its own connected oauth account', () => {
    expect(
      accountViews(settings(), accounts, home).find((v) => v.id === 'managed:claude-oauth')!.status,
    ).toBe('not-configured')

    accounts.upsert({
      id: 'managed:claude-oauth',
      provider: 'anthropic',
      kind: 'oauth',
      credential: 'sk-ant-oat01-supersecret',
      identity: 'sk-a…cret',
      scope: 'role',
      createdAt: 2,
    })

    const views = accountViews(settings(), accounts, home)
    const oauth = views.find((v) => v.id === 'managed:claude-oauth')!
    expect(oauth.status).toBe('connected')
    expect(oauth.kind).toBe('oauth')
    expect(oauth.identity).toBe('sk-a…cret')
    expect(JSON.stringify(views)).not.toContain('sk-ant-oat01-supersecret')
  })

  it('prefers a stored credential over the legacy settings key', () => {
    accounts.upsert({
      id: 'managed:openai',
      provider: 'openai',
      kind: 'api-key',
      credential: 'sk-stored-9999',
      identity: 'sk-s…9999',
      scope: 'role',
      createdAt: 3,
    })
    const views = accountViews(settings({ openai: 'sk-legacy-abcd1234' }), accounts, home)
    const openai = views.find((v) => v.id === 'managed:openai')!
    expect(openai.identity).toBe('sk-s…9999')
    expect(JSON.stringify(views)).not.toContain('sk-stored-9999')
  })
})

describe('AccountConnectInput', () => {
  it('rejects oauth for non-anthropic providers', () => {
    const res = AccountConnectInput.safeParse({
      provider: 'openai',
      kind: 'oauth',
      credential: 'x',
    })
    expect(res.success).toBe(false)
    if (!res.success)
      expect(res.error.issues[0]!.message).toContain(
        'OAuth accounts are only supported for Anthropic',
      )
  })

  it('accepts oauth for anthropic', () => {
    expect(
      AccountConnectInput.safeParse({ provider: 'anthropic', kind: 'oauth', credential: 'x' })
        .success,
    ).toBe(true)
  })

  it('accepts api-key for other providers', () => {
    expect(
      AccountConnectInput.safeParse({ provider: 'openai', kind: 'api-key', credential: 'x' })
        .success,
    ).toBe(true)
  })
})
