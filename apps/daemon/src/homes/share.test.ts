import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { HarnessHome } from './registry'
import { linkShared, prepareHomeLaunch, SHARED_ENTRIES } from './share'

let base: string
let defaultDir: string
let personState: string

const homeIn = (harness: 'claude-code' | 'codex'): HarnessHome => {
  const dir = join(base, 'homes', 'cred_a', harness)
  mkdirSync(dir, { recursive: true })
  return { homeId: `cred_a:${harness}`, credentialId: 'cred_a', harness, dir }
}

const readJson = (path: string): Record<string, unknown> =>
  JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'podium-share-'))
  defaultDir = join(base, 'person', '.claude')
  personState = join(base, 'person', '.claude.json')
  mkdirSync(defaultDir, { recursive: true })
})

afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

describe('linkShared', () => {
  it('shares exactly what S2 measured safe, per harness', () => {
    expect(SHARED_ENTRIES).toEqual({
      'claude-code': ['settings.json', 'CLAUDE.md', 'skills', 'agents', 'commands', 'plugins'],
      codex: ['config.toml', 'AGENTS.md', 'skills'],
    })
  })

  it('links the entries the person has, and only those', () => {
    writeFileSync(join(defaultDir, 'settings.json'), '{}')
    mkdirSync(join(defaultDir, 'skills'))
    writeFileSync(join(defaultDir, '.credentials.json'), '{"fake":true}')
    const home = homeIn('claude-code')
    expect(linkShared(home, defaultDir).linked.sort()).toEqual(['settings.json', 'skills'])
    expect(readlinkSync(join(home.dir, 'settings.json'))).toBe(join(defaultDir, 'settings.json'))
    expect(lstatSync(join(home.dir, 'skills')).isSymbolicLink()).toBe(true)
    // No dangling link for what the person does not have, and never a login.
    expect(existsSync(join(home.dir, 'CLAUDE.md'))).toBe(false)
    expect(() => lstatSync(join(home.dir, 'CLAUDE.md'))).toThrow()
    expect(existsSync(join(home.dir, '.credentials.json'))).toBe(false)
  })

  it('links an entry the person creates later, on the next launch', () => {
    const home = homeIn('claude-code')
    expect(linkShared(home, defaultDir).linked).toEqual([])
    writeFileSync(join(defaultDir, 'CLAUDE.md'), 'later')
    expect(linkShared(home, defaultDir).linked).toEqual(['CLAUDE.md'])
    expect(linkShared(home, defaultDir).linked).toEqual([])
  })

  it('never replaces a file of the home’s own', () => {
    writeFileSync(join(defaultDir, 'settings.json'), '{"person":true}')
    const home = homeIn('claude-code')
    writeFileSync(join(home.dir, 'settings.json'), '{"home":true}')
    expect(linkShared(home, defaultDir).linked).toEqual([])
    expect(lstatSync(join(home.dir, 'settings.json')).isSymbolicLink()).toBe(false)
    expect(readJson(join(home.dir, 'settings.json'))).toEqual({ home: true })
  })

  it('a marker the person writes after linking is what a session in the home reads (item 9)', () => {
    writeFileSync(join(defaultDir, 'CLAUDE.md'), 'before')
    const home = homeIn('claude-code')
    linkShared(home, defaultDir)
    writeFileSync(join(defaultDir, 'CLAUDE.md'), 'MARK-PERSON-SETTINGS')
    expect(readFileSync(join(home.dir, 'CLAUDE.md'), 'utf8')).toBe('MARK-PERSON-SETTINGS')
  })

  it('links Codex’s config, instructions and skills', () => {
    const codexDefault = join(base, 'person', '.codex')
    mkdirSync(codexDefault, { recursive: true })
    writeFileSync(join(codexDefault, 'config.toml'), 'model = "x"')
    writeFileSync(join(codexDefault, 'AGENTS.md'), 'agents')
    writeFileSync(join(codexDefault, 'auth.json'), '{"fake":true}')
    writeFileSync(join(codexDefault, 'hooks.json'), '{}')
    const home = homeIn('codex')
    expect(linkShared(home, codexDefault).linked.sort()).toEqual(['AGENTS.md', 'config.toml'])
    expect(existsSync(join(home.dir, 'auth.json'))).toBe(false)
    expect(existsSync(join(home.dir, 'hooks.json'))).toBe(false)
  })
})

describe('prepareHomeLaunch for Claude Code', () => {
  it('seeds onboarding and trusts the folder in a new home', () => {
    const home = homeIn('claude-code')
    prepareHomeLaunch(home, {
      shareFrom: { dir: defaultDir, claudeState: personState },
      cwd: '/work/repo',
    })
    const state = readJson(join(home.dir, '.claude.json'))
    expect(state.hasCompletedOnboarding).toBe(true)
    expect(state.projects).toEqual({ '/work/repo': { hasTrustDialogAccepted: true } })
    expect(statSync(join(home.dir, '.claude.json')).mode & 0o777).toBe(0o600)
  })

  it('copies the person’s MCP servers at each launch and keeps what the home holds', () => {
    writeFileSync(
      personState,
      JSON.stringify({
        hasCompletedOnboarding: true,
        oauthAccount: { emailAddress: 'person@example.invalid' },
        mcpServers: { mark: { command: 'mark-v1' } },
      }),
    )
    const home = homeIn('claude-code')
    writeFileSync(
      join(home.dir, '.claude.json'),
      JSON.stringify({
        hasCompletedOnboarding: true,
        oauthAccount: { emailAddress: 'home@example.invalid' },
        mcpServers: { own: { command: 'own' } },
        projects: { '/a': { hasTrustDialogAccepted: true, allowedTools: ['x'] } },
      }),
    )
    prepareHomeLaunch(home, { shareFrom: { dir: defaultDir, claudeState: personState }, cwd: '/b' })
    let state = readJson(join(home.dir, '.claude.json'))
    // The home's identity is its own: never the person's.
    expect(state.oauthAccount).toEqual({ emailAddress: 'home@example.invalid' })
    expect(state.mcpServers).toEqual({ own: { command: 'own' }, mark: { command: 'mark-v1' } })
    expect(state.projects).toEqual({
      '/a': { hasTrustDialogAccepted: true, allowedTools: ['x'] },
      '/b': { hasTrustDialogAccepted: true },
    })

    writeFileSync(personState, JSON.stringify({ mcpServers: { mark: { command: 'mark-v2' } } }))
    prepareHomeLaunch(home, { shareFrom: { dir: defaultDir, claudeState: personState }, cwd: '/b' })
    state = readJson(join(home.dir, '.claude.json'))
    expect(state.mcpServers).toEqual({ own: { command: 'own' }, mark: { command: 'mark-v2' } })
  })

  it('does not touch the person’s own state file', () => {
    writeFileSync(personState, '{"mcpServers":{}}')
    const before = readFileSync(personState, 'utf8')
    prepareHomeLaunch(homeIn('claude-code'), {
      shareFrom: { dir: defaultDir, claudeState: personState },
      cwd: '/x',
    })
    expect(readFileSync(personState, 'utf8')).toBe(before)
  })

  it('writes no .claude.json into a Codex home', () => {
    const home = homeIn('codex')
    prepareHomeLaunch(home, { shareFrom: { dir: defaultDir, claudeState: personState }, cwd: '/x' })
    expect(existsSync(join(home.dir, '.claude.json'))).toBe(false)
  })
})

describe('prepareHomeLaunch with an unreadable state file', () => {
  it('leaves a .claude.json it cannot parse as it is', () => {
    const home = homeIn('claude-code')
    writeFileSync(join(home.dir, '.claude.json'), '{"oauthAccount":')
    prepareHomeLaunch(home, { shareFrom: { dir: defaultDir, claudeState: personState }, cwd: '/x' })
    expect(readFileSync(join(home.dir, '.claude.json'), 'utf8')).toBe('{"oauthAccount":')
  })
})
