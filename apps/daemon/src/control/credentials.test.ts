import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { installPortableCredential, readPortableCredential } from './credentials'

let source: string
let target: string

beforeEach(() => {
  source = mkdtempSync(join(tmpdir(), 'podium-credential-source-'))
  target = mkdtempSync(join(tmpdir(), 'podium-credential-target-'))
})

afterEach(() => {
  rmSync(source, { recursive: true, force: true })
  rmSync(target, { recursive: true, force: true })
})

describe('portable native credentials', () => {
  it('copies only the known Codex auth file and installs it owner-only', () => {
    mkdirSync(join(source, '.codex'), { recursive: true })
    const secret = JSON.stringify({ tokens: { access_token: 'do-not-log' } })
    writeFileSync(join(source, '.codex', 'auth.json'), secret)

    const bundle = readPortableCredential('codex', source)
    expect(bundle?.kind).toBe('codex')
    if (!bundle) throw new Error('bundle missing')
    installPortableCredential(bundle, target)

    const path = join(target, '.codex', 'auth.json')
    expect(readFileSync(path, 'utf8')).toBe(secret)
    expect(lstatSync(path).mode & 0o777).toBe(0o600)
    expect(lstatSync(join(target, '.codex')).mode & 0o777).toBe(0o700)
  })

  it('refuses malformed or missing auth files', () => {
    expect(readPortableCredential('grok', source)).toBeNull()
    mkdirSync(join(source, '.grok'), { recursive: true })
    writeFileSync(join(source, '.grok', 'auth.json'), 'not-json')
    expect(() => readPortableCredential('grok', source)).toThrow()
    expect(() =>
      installPortableCredential(
        { kind: 'grok', contentBase64: Buffer.from('bad').toString('base64') },
        target,
      ),
    ).toThrow()
  })

  it('copies only Claude onboarding markers and merges them into target-local state', () => {
    writeFileSync(
      join(source, '.claude.json'),
      JSON.stringify({
        hasCompletedOnboarding: true,
        lastOnboardingVersion: '2.1.92',
        installMethod: 'native',
        machineID: 'must-not-cross-machines',
        projects: { '/secret/source/path': {} },
        oauthAccount: { emailAddress: 'must-not-cross' },
      }),
    )
    writeFileSync(
      join(target, '.claude.json'),
      JSON.stringify({ machineID: 'target-machine', projects: { '/target/path': {} } }),
    )

    const bundle = readPortableCredential('claude-code-state', source)
    expect(bundle).not.toBeNull()
    if (!bundle) throw new Error('bundle missing')
    expect(JSON.parse(Buffer.from(bundle.contentBase64, 'base64').toString('utf8'))).toEqual({
      hasCompletedOnboarding: true,
      lastOnboardingVersion: '2.1.92',
      installMethod: 'native',
    })
    installPortableCredential(bundle, target)

    const path = join(target, '.claude.json')
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      machineID: 'target-machine',
      projects: { '/target/path': {} },
      hasCompletedOnboarding: true,
      lastOnboardingVersion: '2.1.92',
      installMethod: 'native',
    })
    expect(lstatSync(path).mode & 0o777).toBe(0o600)
  })
})
