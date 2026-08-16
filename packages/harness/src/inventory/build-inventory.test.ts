import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { platform, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CommandEnvironment } from '@podium/runtime/command-environment'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildInventory, type LoginProbeExec, type ProbeExec } from './build-inventory.js'
import { AGENT_VERSION_PROBE_TIMEOUT_MS } from '../version-probe.js'
import {
  fingerprintForLoginIdentity,
  readFreshnessFromAuthContents,
  readIdentityFromAuthContents,
} from '../codex-auth-identity.js'
import { AGENT_VERSION_PROBE_TIMEOUT_MS } from '../version-probe.js'
import { buildInventory, type ProbeExec } from './build-inventory.js'

let home: string
const prevCodexHome = process.env.CODEX_HOME
const prevGrokHome = process.env.GROK_HOME
const prevClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'inv-home-'))
  // The codex/grok detectors honor these env overrides; pin them to the fixture
  // home so a real login on the test host can't leak into assertions.
  process.env.CODEX_HOME = join(home, '.codex')
  process.env.GROK_HOME = join(home, '.grok')
  delete process.env.CLAUDE_CONFIG_DIR
})
afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  if (prevCodexHome === undefined) delete process.env.CODEX_HOME
  else process.env.CODEX_HOME = prevCodexHome
  if (prevGrokHome === undefined) delete process.env.GROK_HOME
  else process.env.GROK_HOME = prevGrokHome
  if (prevClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = prevClaudeConfigDir
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

const resolvedClaude = '/verified/bin/claude'

function commandEnvironment(
  env: Readonly<Record<string, string>>,
  installed = true,
): CommandEnvironment {
  return {
    env,
    pathEntries: ['/verified/bin'],
    source: 'inherited',
    generation: 7,
    machineHome: home,
    loginShell: '/bin/sh',
    resolve: (command) => (installed && command === 'claude' ? resolvedClaude : undefined),
  }
}

describe('buildInventory', () => {
  it('derives os and arch from the host', async () => {
    const inv = await buildInventory({ homeDir: home, exec: fakeExec({}) })
    expect(inv.os).toBe(platform() === 'darwin' ? 'darwin' : 'linux')
    expect(inv.arch).toBe(process.arch === 'arm64' ? 'arm64' : 'x64')
    // Baked in by build-bun --define; 'dev' when running from source (as tests do) [POD-838].
    expect(inv.podiumVersion).toBe(process.env.PODIUM_APP_VERSION ?? 'dev')
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
    expect(claude.path).toBe('claude') // injected exec keeps the legacy argv-only test seam
  })

  it('uses the exact resolved Claude path, probe arguments, timeout, and immutable environment', async () => {
    const env = Object.freeze({
      PATH: '/verified/bin',
      HOME: home,
      CLAUDE_CONFIG_DIR: '',
      CLAUDE_SECURESTORAGE_CONFIG_DIR: '/secure/storage',
    })
    const calls: Array<{
      argv: readonly string[]
      timeoutMs: number
      env: Readonly<Record<string, string>>
    }> = []
    const loginExec: LoginProbeExec = async (argv, timeoutMs, probeEnv) => {
      calls.push({ argv, timeoutMs, env: probeEnv })
      return {
        stdout: JSON.stringify({ loggedIn: true, email: 'keychain@example.com' }),
        stderr: '',
        exitCode: 0,
        timedOut: false,
      }
    }
    const inv = await buildInventory({
      credentialHome: home,
      commandEnvironment: commandEnvironment(env),
      exec: async () => '2.1.50 (Claude Code)',
      loginExec,
      platform: 'darwin',
    })

    expect(calls).toEqual([{ argv: [resolvedClaude, 'auth', 'status'], timeoutMs: 12_000, env }])
    expect(calls[0]!.env).toBe(env)
    expect(calls[0]!.env.CLAUDE_CONFIG_DIR).toBe('')
    expect(calls[0]!.env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe('/secure/storage')
    expect(inv.agents.find((agent) => agent.kind === 'claude-code')).toMatchObject({
      installed: true,
      version: '2.1.50 (Claude Code)',
      path: resolvedClaude,
      login: {
        state: 'in',
        account: 'keychain@example.com',
        identity: { email: 'keychain@example.com', fingerprint: expect.any(String) },
      },
    })
  })

  it('preserves absent Claude config variables in the command environment', async () => {
    const env = Object.freeze({ PATH: '/verified/bin', HOME: home })
    let observed: Readonly<Record<string, string>> | undefined
    await buildInventory({
      credentialHome: home,
      commandEnvironment: commandEnvironment(env),
      exec: async () => '2.1.50',
      loginExec: async (_argv, _timeoutMs, probeEnv) => {
        observed = probeEnv
        return {
          stdout: JSON.stringify({ loggedIn: false }),
          stderr: '',
          exitCode: 1,
          timedOut: false,
        }
      },
    })
    expect(observed).toBe(env)
    expect(observed).not.toHaveProperty('CLAUDE_CONFIG_DIR')
    expect(observed).not.toHaveProperty('CLAUDE_SECURESTORAGE_CONFIG_DIR')
  })

  it('keeps a verified executable installed when command status is unknown without stale identity', async () => {
    writeFileSync(
      join(home, '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: 'stale@example.com' } }),
    )
    const inv = await buildInventory({
      credentialHome: home,
      commandEnvironment: commandEnvironment(Object.freeze({ PATH: '/verified/bin', HOME: home })),
      exec: async () => '2.1.50',
      loginExec: async () => ({
        stdout: 'not json',
        stderr: '',
        exitCode: 1,
        timedOut: false,
      }),
    })
    expect(inv.agents.find((agent) => agent.kind === 'claude-code')).toEqual({
      kind: 'claude-code',
      installed: true,
      version: '2.1.50',
      path: resolvedClaude,
      login: { state: 'unknown' },
    })
  })

  it('uses file state and identity only for the verified unsupported-command fallback', async () => {
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(join(home, '.claude', '.credentials.json'), JSON.stringify({ oauth: 'secret' }))
    writeFileSync(
      join(home, '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: 'legacy@example.com' } }),
    )
    const env = Object.freeze({ PATH: '/verified/bin', HOME: home })
    const unsupported: LoginProbeExec = async () => ({
      stdout: '',
      stderr: "error: unknown command 'status'",
      exitCode: 1,
      timedOut: false,
    })
    const legacy = await buildInventory({
      credentialHome: home,
      commandEnvironment: commandEnvironment(env),
      exec: async () => '2.1.0',
      loginExec: unsupported,
      platform: 'darwin',
    })
    expect(legacy.agents.find((agent) => agent.kind === 'claude-code')!.login).toMatchObject({
      state: 'in',
      account: 'legacy@example.com',
      identity: { email: 'legacy@example.com' },
    })

    const missingHome = join(home, 'missing-legacy-home')
    mkdirSync(missingHome)
    const missing = await buildInventory({
      credentialHome: missingHome,
      commandEnvironment: commandEnvironment(env),
      exec: async () => '2.1.0',
      loginExec: unsupported,
      platform: 'darwin',
    })
    expect(missing.agents.find((agent) => agent.kind === 'claude-code')!.login).toEqual({
      state: 'out',
    })
  })

  it('reports unknown on Darwin when neither a Claude executable nor credential file exists', async () => {
    const inv = await buildInventory({
      credentialHome: home,
      commandEnvironment: commandEnvironment(
        Object.freeze({ PATH: '/verified/bin', HOME: home }),
        false,
      ),
      exec: fakeExec({}),
      loginExec: async () => {
        throw new Error('must not run')
      },
      platform: 'darwin',
    })
    expect(inv.agents.find((agent) => agent.kind === 'claude-code')).toMatchObject({
      installed: false,
      login: { state: 'unknown' },
    })
  })

  it('distinguishes valid, empty, missing, unreadable, and malformed legacy credential files', async () => {
    const cases = [
      { name: 'valid', contents: JSON.stringify({ oauth: 'secret' }), state: 'in' },
      { name: 'empty', contents: '', state: 'out' },
      { name: 'missing', state: 'out' },
      { name: 'malformed', contents: '{', state: 'unknown' },
      { name: 'unreadable', directory: true, state: 'unknown' },
    ] as const

    for (const fixture of cases) {
      const fixtureHome = join(home, fixture.name)
      const claudeHome = join(fixtureHome, '.claude')
      mkdirSync(claudeHome, { recursive: true })
      const credentialPath = join(claudeHome, '.credentials.json')
      if ('directory' in fixture) mkdirSync(credentialPath)
      else if ('contents' in fixture) writeFileSync(credentialPath, fixture.contents)
      const inv = await buildInventory({
        credentialHome: fixtureHome,
        machineHome: fixtureHome,
        exec: fakeExec({}),
        platform: 'linux',
      })
      expect(
        inv.agents.find((agent) => agent.kind === 'claude-code')!.login.state,
        fixture.name,
      ).toBe(fixture.state)
    }
  })

  it("does not mistake Grok's generic agent alias for Cursor", async () => {
    const exec: ProbeExec = async (argv) => {
      const bin = (argv[0] as string).split('/').pop()
      if (bin !== 'agent') throw new Error(`ENOENT: ${argv[0]}`)
      return argv[1] === '--help' ? 'Grok CLI help' : 'grok 0.2.111'
    }
    const inv = await buildInventory({ homeDir: home, exec })
    expect(inv.agents.find((agent) => agent.kind === 'cursor')).toMatchObject({
      installed: false,
    })
  })

  it('accepts the generic agent executable when Cursor identifies itself', async () => {
    const exec: ProbeExec = async (argv) => {
      const bin = (argv[0] as string).split('/').pop()
      if (bin !== 'agent') throw new Error(`ENOENT: ${argv[0]}`)
      return argv[1] === '--help' ? 'Cursor Agent command line' : '2026.07.22'
    }
    const inv = await buildInventory({ homeDir: home, exec })
    expect(inv.agents.find((agent) => agent.kind === 'cursor')).toMatchObject({
      installed: true,
      version: '2026.07.22',
      path: 'agent',
    })
  })

  it('keeps a successful version observation when the identity probe times out', async () => {
    const exec: ProbeExec = async (argv) => {
      const bin = (argv[0] as string).split('/').pop()
      if (bin !== 'agent') throw new Error(`ENOENT: ${argv[0]}`)
      if (argv[1] === '--version') return '2026.07.22'
      throw Object.assign(new Error('Command failed'), { killed: true, signal: 'SIGTERM' })
    }
    const inv = await buildInventory({ homeDir: home, exec })
    expect(inv.agents.find((agent) => agent.kind === 'cursor')).toMatchObject({
      installed: true,
      version: '2026.07.22',
      path: 'agent',
    })
  })

  it('recognizes Node execFile killed errors as timed-out probes', async () => {
    const killedExec: ProbeExec = async () => {
      throw Object.assign(new Error('Command failed'), { killed: true, signal: 'SIGTERM' })
    }
    const inv = await buildInventory({ homeDir: home, exec: killedExec })
    expect(inv.agents.find((agent) => agent.kind === 'claude-code')).toMatchObject({
      installed: null,
      probeError: { reason: 'timed-out', timeoutMs: AGENT_VERSION_PROBE_TIMEOUT_MS },
    })
  })

  it('reports a timed-out probe as unknown, never absent or thrown', async () => {
    const timeoutExec: ProbeExec = async (_argv, timeoutMs) => {
      expect(timeoutMs).toBe(AGENT_VERSION_PROBE_TIMEOUT_MS)
      throw new Error('spawn ETIMEDOUT')
    }
    const inv = await buildInventory({ homeDir: home, exec: timeoutExec })
    expect(
      inv.agents.every(
        (agent) =>
          agent.installed === null &&
          agent.probeError?.reason === 'timed-out' &&
          agent.probeError.timeoutMs === AGENT_VERSION_PROBE_TIMEOUT_MS,
      ),
    ).toBe(true)
    expect(inv.tools).toEqual([
      {
        name: 'gh',
        installed: null,
        probeError: { reason: 'timed-out', timeoutMs: AGENT_VERSION_PROBE_TIMEOUT_MS },
      },
    ])
  })

  it('believes a later successful probe without a process restart', async () => {
    let loaded = true
    const exec: ProbeExec = async (argv) => {
      const bin = (argv[0] as string).split('/').pop()
      if (loaded) throw new Error('spawn ETIMEDOUT')
      if (bin === 'claude') return '2.1.9 (Claude Code)'
      throw new Error(`ENOENT: ${argv[0]}`)
    }

    const unknown = await buildInventory({ homeDir: home, exec })
    expect(unknown.agents.find((agent) => agent.kind === 'claude-code')).toMatchObject({
      installed: null,
      probeError: { reason: 'timed-out', timeoutMs: AGENT_VERSION_PROBE_TIMEOUT_MS },
    })

    loaded = false
    const recovered = await buildInventory({ homeDir: home, exec })
    expect(recovered.agents.find((agent) => agent.kind === 'claude-code')).toMatchObject({
      installed: true,
      version: '2.1.9 (Claude Code)',
    })
  })

  it('computes login regardless of installed state', async () => {
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(join(home, '.claude', '.credentials.json'), JSON.stringify({ oauth: 'secret' }))
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
    expect(byKind['claude-code']!.login).toMatchObject({
      state: 'in',
      account: 'mike@example.com',
      identity: { email: 'mike@example.com', fingerprint: expect.any(String) },
    })
    expect(byKind['codex']!.login).toMatchObject({
      state: 'in',
      account: 'Mike Example · mike@example.com',
      identity: {
        email: 'mike@example.com',
        providerAccountId: 'acct-1',
        fingerprint: expect.any(String),
      },
    })
    expect(byKind['grok']!.login).toMatchObject({
      state: 'in',
      account: 'Grace Hopper · grace@example.com',
      identity: { email: 'grace@example.com', fingerprint: expect.any(String) },
    })
    // OpenCode has a local auth detector; a missing auth file is logged out.
    expect(byKind['opencode']!.login).toEqual({ state: 'out' })
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

  it('does not mistake metadata-only directories for native logins', async () => {
    mkdirSync(join(home, '.grok'), { recursive: true })
    writeFileSync(join(home, '.grok', 'config.toml'), '[cli]\n')
    writeFileSync(
      join(home, '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: 'stale@example.com' } }),
    )
    const inv = await buildInventory({ homeDir: home, exec: fakeExec({}) })
    const byKind = Object.fromEntries(inv.agents.map((agent) => [agent.kind, agent]))
    expect(byKind['claude-code']!.login.state).toBe('out')
    expect(byKind.grok!.login.state).toBe('out')
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
    expect(gh.path).toBe('gh') // injected exec keeps the legacy argv-only test seam
  })
  it('extracts a non-secret fingerprint and freshness from the Codex id token', () => {
    const email = 'mike' + '@example.com'
    const contents = JSON.stringify({
      tokens: {
        id_token: jwt({
          email: undefined,
          exp: 200,
          iat: 100,
          'https://api.openai.com/auth': {
            chatgpt_account_id: 'acct-secret',
            workspace_account_id: 'workspace-1',
          },
          'https://api.openai.com/profile': { email },
        }),
        expires_at: 250,
      },
      refresh_token: 'credential-bytes',
    })

    expect(readIdentityFromAuthContents(contents)).toEqual({
      fingerprint: fingerprintForLoginIdentity('acct-secret'),
      email,
      providerAccountId: 'acct-secret',
    })
    expect(readFreshnessFromAuthContents(contents)).toBe(250)
    expect(JSON.stringify(readIdentityFromAuthContents(contents))).not.toContain('credential-bytes')
  })
})
