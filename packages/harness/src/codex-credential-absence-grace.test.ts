import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CodexCredentialAbsenceGrace } from './codex-credential-absence-grace.js'
import { codexManifest } from './manifests/codex.js'

describe('Codex credential absence grace', () => {
  it('retains a settled login for one missing read, then expires the grace', () => {
    let now = 100
    const grace = new CodexCredentialAbsenceGrace(() => now)
    const path = '/fixture/.codex/auth.json'
    const login = { state: 'in' as const, account: 'ChatGPT' }

    expect(grace.present(path, login)).toEqual(login)
    expect(grace.missing(path, true)).toEqual(login)
    now = 5_099
    expect(grace.missing(path, true)).toEqual(login)
    now = 5_100
    expect(grace.missing(path, true)).toEqual({ state: 'out' })
  })

  it('does not grace a missing parent directory', () => {
    let now = 100
    const grace = new CodexCredentialAbsenceGrace(() => now)
    const path = '/fixture/.codex/auth.json'
    grace.present(path, { state: 'in' })
    now = 101
    expect(grace.missing(path, false)).toEqual({ state: 'out' })
  })
})

describe('Codex manifest settled-file rules', () => {
  let home: string
  let previousCodexHome: string | undefined

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'podium-codex-grace-'))
    previousCodexHome = process.env.CODEX_HOME
    process.env.CODEX_HOME = join(home, '.codex')
    mkdirSync(join(home, '.codex'), { recursive: true })
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = previousCodexHome
  })

  it('treats valid JSON without credentials as immediately settled out', () => {
    writeFileSync(join(home, '.codex', 'auth.json'), JSON.stringify({ tokens: {} }))
    expect(codexManifest.inventory.detectLogin(home)).toEqual({ state: 'out' })
  })
})
