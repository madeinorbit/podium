import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { platform, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildInventory, type ProbeExec } from './build-inventory.js'

let home: string
const prevCodexHome = process.env.CODEX_HOME
const prevGrokHome = process.env.GROK_HOME

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'inv-home-'))
  // The codex/grok detectors honor these env overrides; pin them to the fixture
  // home so a real login on the test host can't leak into assertions.
  process.env.CODEX_HOME = join(home, '.codex')
  process.env.GROK_HOME = join(home, '.grok')
})
afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  if (prevCodexHome === undefined) delete process.env.CODEX_HOME
  else process.env.CODEX_HOME = prevCodexHome
  if (prevGrokHome === undefined) delete process.env.GROK_HOME
  else process.env.GROK_HOME = prevGrokHome
})

/** Fake exec that answers `--version` per binary basename; anything else throws. */
function fakeExec(versions: Record<string, string>): ProbeExec {
  return async (argv) => {
    const bin = (argv[0] as string).split('/').pop() as string
    const v = versions[bin]
    if (v === undefined) throw new Error(`ENOENT: ${argv[0]}`)
    return v
  }
}

function jwt(payload: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`
}

describe('buildInventory', () => {
  it('derives os and arch from the host', async () => {
    const inv = await buildInventory({ homeDir: home, exec: fakeExec({}) })
    expect(inv.os).toBe(platform() === 'darwin' ? 'darwin' : 'linux')
    expect(inv.arch).toBe(process.arch === 'arm64' ? 'arm64' : 'x64')
    // podiumVersion stays absent until #221 lands `podium --version`.
    expect(inv.podiumVersion).toBeUndefined()
  })

  it('reports all 5 kinds, absent when every candidate fails', async () => {
    const inv = await buildInventory({ homeDir: home, exec: fakeExec({}) })
    expect(inv.agents.map((a) => a.kind).sort()).toEqual(
      ['claude-code', 'codex', 'cursor', 'grok', 'opencode'].sort(),
    )
    for (const a of inv.agents) {
      expect(a.installed).toBe(false)
      expect(a.version).toBeUndefined()
      expect(a.path).toBeUndefined()
    }
  })

  it('captures version + resolved path for an installed CLI', async () => {
    const inv = await buildInventory({
      homeDir: home,
      exec: fakeExec({ claude: '2.1.9 (Claude Code)\n' }),
    })
    const claude = inv.agents.find((a) => a.kind === 'claude-code')!
    expect(claude.installed).toBe(true)
    expect(claude.version).toBe('2.1.9 (Claude Code)') // trimmed
    expect(claude.path).toBe(join(home, '.local', 'bin', 'claude')) // first candidate wins
  })

  it('treats a rejecting exec (timeout) as absent, never throwing', async () => {
    const timeoutExec: ProbeExec = async () => {
      throw new Error('spawn ETIMEDOUT')
    }
    const inv = await buildInventory({ homeDir: home, exec: timeoutExec })
    expect(inv.agents.every((a) => !a.installed)).toBe(true)
  })

  it('computes login regardless of installed state', async () => {
    writeFileSync(
      join(home, '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: 'mike@example.com' } }),
    )
    mkdirSync(join(home, '.codex'), { recursive: true })
    writeFileSync(
      join(home, '.codex', 'auth.json'),
      JSON.stringify({
        tokens: {
          access_token: 'a',
          refresh_token: 'r',
          account_id: 'acct-1',
          id_token: jwt({ name: 'Mike Example', email: 'mike@example.com' }),
        },
      }),
    )
    mkdirSync(join(home, '.grok'), { recursive: true })
    writeFileSync(
      join(home, '.grok', 'auth.json'),
      JSON.stringify({
        'https://auth.x.ai::account': {
          key: 'credential',
          first_name: 'Grace',
          last_name: 'Hopper',
          email: 'grace@example.com',
        },
      }),
    )
    // No CLI installed anywhere (fake exec always throws) — logins still detected.
    const inv = await buildInventory({ homeDir: home, exec: fakeExec({}) })
    const byKind = Object.fromEntries(inv.agents.map((a) => [a.kind, a]))
    expect(byKind['claude-code']!.login).toEqual({ state: 'in', account: 'mike@example.com' })
    expect(byKind['codex']!.login).toEqual({
      state: 'in',
      account: 'Mike Example · mike@example.com',
    })
    expect(byKind['grok']!.login).toEqual({
      state: 'in',
      account: 'Grace Hopper · grace@example.com',
    })
    // No detector exists for these two — honest 'unknown', not a lying 'out'.
    expect(byKind['opencode']!.login).toEqual({ state: 'unknown' })
    expect(byKind['cursor']!.login).toEqual({ state: 'unknown' })
    expect(byKind['claude-code']!.installed).toBe(false)
  })

  it('reports logged-out when the credential files are missing', async () => {
    const inv = await buildInventory({ homeDir: home, exec: fakeExec({}) })
    const byKind = Object.fromEntries(inv.agents.map((a) => [a.kind, a]))
    expect(byKind['claude-code']!.login).toEqual({ state: 'out' })
    expect(byKind['codex']!.login).toEqual({ state: 'out' })
    expect(byKind['grok']!.login).toEqual({ state: 'out' })
  })

  it('probes gh into tools[] — absent when not installed (#214)', async () => {
    const inv = await buildInventory({ homeDir: home, exec: fakeExec({}) })
    const gh = inv.tools.find((t) => t.name === 'gh')!
    expect(gh).toEqual({ name: 'gh', installed: false })
  })

  it('captures gh version (first line only) + resolved path when installed (#214)', async () => {
    const inv = await buildInventory({
      homeDir: home,
      exec: fakeExec({ gh: 'gh version 2.40.0 (2024-01-01)\nhttps://github.com/cli/cli/releases' }),
    })
    const gh = inv.tools.find((t) => t.name === 'gh')!
    expect(gh.installed).toBe(true)
    expect(gh.version).toBe('gh version 2.40.0 (2024-01-01)') // first line, trimmed
    expect(gh.path).toBe(join(home, '.local', 'bin', 'gh')) // first candidate wins
  })
})
