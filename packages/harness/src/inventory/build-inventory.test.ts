import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { platform, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CommandEnvironment } from '@podium/runtime/command-environment'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  fingerprintForLoginIdentity,
  readFreshnessFromAuthContents,
  readIdentityFromAuthContents,
} from '../codex-auth-identity.js'
import { harnessLoginReadEnv } from '../registry.js'
import { AGENT_VERSION_PROBE_TIMEOUT_MS } from '../version-probe.js'
import {
  buildInventory as buildInventoryWithEnv,
  type LoginProbeExec,
  type ProbeExec,
} from './build-inventory.js'

let home: string
let childEnv: NodeJS.ProcessEnv

function hermeticTestEnv(
  overrides: Readonly<Record<string, string | undefined>>,
): NodeJS.ProcessEnv {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  )
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key]
    else env[key] = value
  }
  return env
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'inv-home-'))
  childEnv = hermeticTestEnv({
    CODEX_HOME: join(home, '.codex'),
    GROK_HOME: join(home, '.grok'),
    CLAUDE_CONFIG_DIR: undefined,
  })
})
afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

function buildInventory(
  options: Parameters<typeof buildInventoryWithEnv>[0] = {},
): ReturnType<typeof buildInventoryWithEnv> {
  return buildInventoryWithEnv({ env: childEnv, ...options })
}

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

/**
 * A directory on PATH holding a REAL runnable file of each given name, so the
 * command resolver genuinely answers for it. Used to prove the injected-exec seam
 * ignores the host (POD-2826) on every machine, not just one without the CLIs.
 */
function hostBinDir(...names: readonly string[]): string {
  const dir = join(home, 'host-bin')
  mkdirSync(dir, { recursive: true })
  for (const name of names) writeFileSync(join(dir, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  return dir
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

  it('reports all 6 kinds, absent when every candidate fails', async () => {
    const inv = await buildInventory({ homeDir: home, exec: fakeExec({}) })
    expect(inv.agents.map((a) => a.kind).sort()).toEqual(
      ['claude-code', 'codex', 'cursor', 'grok', 'opencode', 'pi'].sort(),
    )
    for (const a of inv.agents) {
      expect(a.installed).toBe(false)
      expect(a.version).toBeUndefined()
      expect(a.path).toBeUndefined()
    }
  })

  it('keeps the agent seam argv-only when the host resolves the same name (POD-2826)', async () => {
    // Without the fix this returns `<home>/host-bin/claude`, and on a developer's
    // box it returned `/home/<user>/.local/bin/claude` — the assertion's answer came
    // from the machine, so the same commit was red locally and green on CI.
    const dir = hostBinDir('claude')
    const inv = await buildInventory({
      homeDir: home,
      env: { ...childEnv, PATH: dir },
      exec: fakeExec({ claude: '2.1.9 (Claude Code)\n' }),
    })
    const claude = inv.agents.find((a) => a.kind === 'claude-code')!
    expect(claude.installed).toBe(true)
    expect(claude.path).toBe('claude')
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
    // Equal, no longer IDENTICAL: the probe runs under a composed credential
    // environment now (POD-2692), not the machine environment verbatim. Here the
    // credential home IS `env.HOME`, so every entry still matches — what changed
    // is that the composition, not the caller's object, decides `HOME`.
    expect(calls[0]!.env).not.toBe(env)
    expect(calls[0]!.env.HOME).toBe(home)
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
    expect(observed).toEqual(env)
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

  it('keeps an unverified identity timeout unknown', async () => {
    const exec: ProbeExec = async (argv) => {
      const bin = (argv[0] as string).split('/').pop()
      if (bin !== 'agent') throw new Error(`ENOENT: ${argv[0]}`)
      if (argv[1] === '--version') return '2026.07.22'
      throw Object.assign(new Error('Command failed'), { killed: true, signal: 'SIGTERM' })
    }
    const inv = await buildInventory({ homeDir: home, exec })
    expect(inv.agents.find((agent) => agent.kind === 'cursor')).toMatchObject({
      installed: null,
      probeError: { reason: 'timed-out', timeoutMs: AGENT_VERSION_PROBE_TIMEOUT_MS },
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

  it('reads Codex login from the credential home, not an ambient CODEX_HOME', async () => {
    /**
     * THE CREDENTIAL HOME WINS OVER AN AMBIENT SELECTOR (POD-2692), and it has to,
     * because that is already what the SPAWNED CHILD gets: `harnessInstanceEnv`
     * sets `CODEX_HOME` to `<instance home>/.codex` on every session. While this
     * probe followed the ambient value instead, the readout named one account and
     * the session ran as another — the divergence this issue exists to close.
     *
     * The env still reaches the reader (that is what the previous spelling of this
     * test was really pinning); it is now composed on the way rather than passed
     * through, so the reader cannot be pointed anywhere but the named home.
     */
    const codexHome = join(home, 'configured-codex')
    mkdirSync(codexHome, { recursive: true })
    writeFileSync(
      join(codexHome, 'auth.json'),
      JSON.stringify({
        tokens: {
          access_token: 'a',
          refresh_token: 'r',
          account_id: 'acct-env',
          id_token: jwt({ name: 'Configured User', email: 'configured@example.com' }),
        },
      }),
    )
    const env = Object.freeze({
      PATH: '/verified/bin',
      HOME: home,
      CODEX_HOME: codexHome,
    })
    // The same credential, written where the CREDENTIAL HOME says it lives.
    mkdirSync(join(home, '.codex'), { recursive: true })
    writeFileSync(
      join(home, '.codex', 'auth.json'),
      JSON.stringify({
        tokens: {
          access_token: 'a',
          refresh_token: 'r',
          account_id: 'acct-home',
          id_token: jwt({ name: 'Home User', email: 'home@example.com' }),
        },
      }),
    )
    const inv = await buildInventoryWithEnv({
      homeDir: home,
      credentialHome: home,
      commandEnvironment: commandEnvironment(env),
      exec: fakeExec({}),
    })
    expect(inv.agents.find((agent) => agent.kind === 'codex')!.login).toMatchObject({
      state: 'in',
      account: 'Home User · home@example.com',
      identity: {
        email: 'home@example.com',
        providerAccountId: 'acct-home',
        fingerprint: expect.any(String),
      },
    })
  })

  it('discovers OpenCode in its known user install directory outside PATH', async () => {
    const opencodePath = join(home, '.opencode', 'bin', 'opencode')
    const env = Object.freeze({ PATH: '/usr/bin:/bin', HOME: home })
    const inv = await buildInventoryWithEnv({
      machineHome: home,
      credentialHome: home,
      commandEnvironment: {
        env,
        pathEntries: ['/usr/bin', '/bin'],
        source: 'inherited',
        generation: 3,
        machineHome: home,
        loginShell: '/bin/sh',
        resolve: (candidate) => (candidate === opencodePath ? opencodePath : undefined),
      },
      exec: fakeExec({ opencode: '1.18.16' }),
    })

    expect(inv.agents.find((agent) => agent.kind === 'opencode')).toMatchObject({
      installed: true,
      version: '1.18.16',
      path: opencodePath,
    })
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

  it('keeps the tool seam argv-only when the host resolves the same name (POD-2826)', async () => {
    // probeTool resolves separately from candidatePaths, so it needs its own guard:
    // this box answered `/usr/bin/gh` where a clean one answered `gh`.
    const dir = hostBinDir('gh')
    const inv = await buildInventory({
      homeDir: home,
      env: { ...childEnv, PATH: dir },
      exec: fakeExec({ gh: 'gh version 2.40.0 (2024-01-01)' }),
    })
    const gh = inv.tools.find((t) => t.name === 'gh')!
    expect(gh.installed).toBe(true)
    expect(gh.path).toBe('gh')
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

  /**
   * POD-2692. A named instance points the agent at ITS OWN credentials while the
   * machine home stays the operator's, and these are the reads that decide how a
   * session starts. Measured on a real instance before the fix: an agent-home
   * holding no credential at all was published as `in`, naming the operator's
   * email, because `claude auth status` ran under the operator's `HOME`. The
   * reverse pairing published `out` for an instance that was signed in, which is
   * what silently demotes a session off the headless drivers.
   *
   * These pin the MECHANISM — the environment the probe is handed — rather than
   * the resulting state, because the state is only wrong via that environment.
   */
  describe('login reads answer for the credential home (POD-2692)', () => {
    it('runs the Claude login command probe under the credential home, not the machine home', async () => {
      const machineHome = mkdtempSync(join(tmpdir(), 'inv-machine-'))
      try {
        const env = Object.freeze({ PATH: '/verified/bin', HOME: machineHome })
        let observed: Readonly<Record<string, string>> | undefined
        const inv = await buildInventoryWithEnv({
          credentialHome: home,
          commandEnvironment: { ...commandEnvironment(env), machineHome },
          exec: async () => '2.1.50 (Claude Code)',
          loginExec: async (_argv, _timeoutMs, probeEnv) => {
            observed = probeEnv
            return {
              // The answer the operator's home would have given.
              stdout: JSON.stringify({ loggedIn: true, email: 'operator@example.com' }),
              stderr: '',
              exitCode: 0,
              timedOut: false,
            }
          },
        })
        expect(observed?.HOME).toBe(home)
        expect(observed?.HOME).not.toBe(machineHome)
        // The verdict still comes from the probe; what changed is which home it
        // was asked about.
        expect(inv.agents.find((agent) => agent.kind === 'claude-code')?.login.state).toBe('in')
      } finally {
        rmSync(machineHome, { recursive: true, force: true })
      }
    })

    it("pins a harness's own home selector to the credential home", async () => {
      const machineHome = mkdtempSync(join(tmpdir(), 'inv-machine-'))
      try {
        // The operator's selector, as an ambient value would arrive.
        const env = Object.freeze({
          PATH: '/verified/bin',
          HOME: machineHome,
          CODEX_HOME: join(machineHome, '.codex'),
          GROK_HOME: join(machineHome, '.grok'),
        })
        const observed = new Map<string, Readonly<Record<string, string>>>()
        await buildInventoryWithEnv({
          credentialHome: home,
          commandEnvironment: { ...commandEnvironment(env), machineHome },
          exec: async (argv) => {
            observed.set((argv[0] as string).split('/').pop() as string, env)
            return '1.0.0'
          },
        })
        // Read the composition directly: it is what both the file detector and the
        // command probe are handed, and what a spawned child of this harness gets.
        expect(harnessLoginReadEnv('codex', home, env).CODEX_HOME).toBe(join(home, '.codex'))
        expect(harnessLoginReadEnv('grok', home, env).GROK_HOME).toBe(join(home, '.grok'))
        // Claude declares no selector, so HOME alone moves it — and nothing else does.
        expect(harnessLoginReadEnv('claude-code', home, env)).not.toHaveProperty(
          'CLAUDE_CONFIG_DIR',
        )
      } finally {
        rmSync(machineHome, { recursive: true, force: true })
      }
    })

    it('drops the credentials a spawned child would drop, so the readout names the account that will run', () => {
      const env = Object.freeze({
        PATH: '/verified/bin',
        HOME: '/machine',
        ANTHROPIC_API_KEY: 'sk-inherited',
        CLAUDE_CODE_ENTRYPOINT: 'cli',
      })
      const composed = harnessLoginReadEnv('claude-code', home, env)
      // `foreignCredentialEnv` — an inherited key selects a DIFFERENT account than
      // the login on disk, and the child strips it. A probe that kept it would
      // report the key's billing state for a session that will not use the key.
      expect(composed).not.toHaveProperty('ANTHROPIC_API_KEY')
      // `environment.removeInherited` — parent-invocation controls, likewise.
      expect(composed).not.toHaveProperty('CLAUDE_CODE_ENTRYPOINT')
      expect(composed.PATH).toBe('/verified/bin')
    })
  })
})
