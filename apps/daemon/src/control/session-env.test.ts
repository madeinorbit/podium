import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { testHarnessContext } from '@podium/harness/driver/testing'
import type { SessionId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { engineEnvBuilder } from '../runtime/host'
import { materializeLaunchFiles, sessionProcessEnv } from './session'
import { headlessTurnChildEnv, shellChildEnv } from './session-env'

// The layer order and strip rules themselves are pinned once, in
// packages/harness/src/harness-child-env.test.ts. These cases pin what each
// daemon path hands that recipe.

describe('the operator shell keeps its own path', () => {
  it("leaves an operator's shell exactly as they launched it: nothing is stripped", () => {
    // A shell session is the operator at their own prompt, not an agent
    // resolving an account: removing their key would break work they meant to do.
    const env = shellChildEnv(
      { launchEnv: { ANTHROPIC_API_KEY: 'sk-operator' }, podiumEnv: { PODIUM_SESSION_ID: 's1' } },
      {},
    )
    expect(env.ANTHROPIC_API_KEY).toBe('sk-operator')
  })

  it("podium's own bindings win a collision — a credential cannot shadow the relay", () => {
    const env = shellChildEnv(
      { sessionEnv: { PODIUM_SESSION_ID: 'evil' }, podiumEnv: { PODIUM_SESSION_ID: 's1' } },
      {},
    )
    expect(env.PODIUM_SESSION_ID).toBe('s1')
  })

  it('makes the desktop CLI authoritative without requiring a HOME override', () => {
    const env = shellChildEnv(
      {
        launchEnv: {
          PATH: '/home/tester/.local/bin:/Applications/Podium.app/Contents/Resources/resources:/usr/bin',
          PODIUM_CLI_PATH: '/stale/launch/podium',
        },
        podiumEnv: { PODIUM_SESSION_ID: 's1' },
      },
      {
        PATH: '/usr/bin',
        PODIUM_CLI_PATH: '/Applications/Podium.app/Contents/Resources/resources/podium',
      },
    )
    expect(env.PODIUM_CLI_PATH).toBe('/Applications/Podium.app/Contents/Resources/resources/podium')
    expect(env.PATH).toBe(
      '/Applications/Podium.app/Contents/Resources/resources:/home/tester/.local/bin:/usr/bin',
    )
  })
})

describe('engine children', () => {
  it('gives a server-driver child the INSTANCE home, never the daemon one (POD-2247)', () => {
    // THE PIN: the daemon's own HOME must never reach a server-driver child. This
    // is the exact leak found live — an isolated grok session refreshed the
    // operator's real ~/.grok credentials.
    const env = engineEnvBuilder(() => ({}))({
      sessionId: 'engine-home' as SessionId,
      agentKind: 'opencode',
      harnessContext: testHarnessContext({
        kind: 'opencode',
        home: '/tmp/pod-op/state/agent-home',
        env: { PATH: '/usr/bin', HOME: '/home/operator' },
      }),
      sessionEnv: { ANTHROPIC_API_KEY: 'sk-1' },
    })
    expect(env.HOME).toBe('/tmp/pod-op/state/agent-home')
    // The managed credential on the frame rides through…
    expect(env.ANTHROPIC_API_KEY).toBe('sk-1')
    // …and the instance's own install roots lead PATH.
    expect(env.PATH?.startsWith('/tmp/pod-op/state/agent-home/.local/bin:')).toBe(true)
  })

  it('cannot have the instance home shadowed by a server-sent env', () => {
    const env = engineEnvBuilder(() => ({}))({
      sessionId: 'engine-shadow' as SessionId,
      agentKind: 'codex',
      harnessContext: testHarnessContext({ kind: 'codex', home: '/instance/home' }),
      sessionEnv: { HOME: '/home/operator' },
      harnessEnv: { HOME: '/also/not/this' },
    })
    expect(env.HOME).toBe('/instance/home')
    expect(env.CODEX_HOME).toBe('/instance/home/.codex')
  })
})

it('binds the relay pair and browser shim into every session process (POD-5814)', () => {
  const settingsDir = mkdtempSync(join(tmpdir(), 'podium-session-env-'))
  try {
    const ctx = {
      agentRelayEndpointFor: (id: string) => `http://127.0.0.1:45778/session/${id}`,
      instanceId: 'default',
      instanceUuid: 'instance-uuid',
      settingsDir,
    }
    const agent = sessionProcessEnv(ctx, 'agent-1' as SessionId, 'claude-code')
    expect(agent.PODIUM_AGENT_RELAY).toBe('http://127.0.0.1:45778/session/agent-1')
    expect(agent.PODIUM_SESSION_RELAY).toBe('http://127.0.0.1:45778/session/agent-1')
    expect(agent.BROWSER).toBe(join(settingsDir, 'browser-shims', 'podium-browser-open'))
    // A shell is the operator: transport, never the delegate identity.
    const shell = sessionProcessEnv(ctx, 'shell-1' as SessionId, 'shell')
    expect(shell.PODIUM_SESSION_RELAY).toBe('http://127.0.0.1:45778/session/shell-1')
    expect(shell.PODIUM_AGENT_RELAY).toBeUndefined()
  } finally {
    rmSync(settingsDir, { recursive: true, force: true })
  }
})

it("gives every engine child its own session's relay, which a spawn frame cannot redirect", () => {
  const buildEnv = engineEnvBuilder((sessionId) => ({
    PODIUM_AGENT_RELAY: `http://relay/session/${sessionId}`,
  }))
  const env = buildEnv({
    sessionId: 'engine-1' as SessionId,
    agentKind: 'codex',
    harnessContext: testHarnessContext({ kind: 'codex' }),
    sessionEnv: { PODIUM_AGENT_RELAY: 'http://elsewhere/session/other' },
    harnessEnv: { PODIUM_AGENT_RELAY: 'http://also/not/this' },
  })
  expect(env.PODIUM_AGENT_RELAY).toBe('http://relay/session/engine-1')
  expect(env.PODIUM_SESSION_ID).toBe('engine-1')
})

it('materializes nested ephemeral launch files with owner-only permissions', () => {
  const root = mkdtempSync(join(tmpdir(), 'podium-launch-files-'))
  const path = join(root, 'rules', 'workflow.md')
  try {
    materializeLaunchFiles([{ path, contents: 'hidden workflow context' }])
    expect(readFileSync(path, 'utf8')).toBe('hidden workflow context')
    expect(statSync(path).mode & 0o777).toBe(0o600)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('headless turns', () => {
  // POD-3059. The adapter's exec env may carry a HOME (a stale machine one).
  // Letting it win reverted the child to the operator account home; on a named
  // instance the harness then wrote its transcript where the reader does not
  // look, and `sessions.read` answered empty for every item type.
  const context = testHarnessContext({
    kind: 'claude-code',
    home: '/state/blue/agent-home',
    env: {
      PATH: '/opt:/usr/bin:/bin',
      HOME: '/state/blue/agent-home',
      ANTHROPIC_API_KEY: 'sk-inherited',
    },
  })

  it('keeps the account HOME when the adapter env carries the machine HOME', () => {
    const { env } = headlessTurnChildEnv({
      context,
      instanceEnv: { PODIUM_SESSION_ID: 's1' },
      execEnv: { HOME: '/home/operator', PODIUM_MCP_BEARER_PODIUM: 'sekret' },
      envOverlay: { IS_SANDBOX: '1', HOME: '/overlay-must-not-win' },
    })
    expect(env.HOME).toBe('/state/blue/agent-home')
    // ...and the adapter's own per-turn key still reaches the child (POD-1021).
    expect(env.PODIUM_MCP_BEARER_PODIUM).toBe('sekret')
    expect(env.IS_SANDBOX).toBe('1')
    expect(env.PODIUM_SESSION_ID).toBe('s1')
  })

  it('lets an adapter override a key the instance did not decide, never one it did', () => {
    const { env } = headlessTurnChildEnv({
      context,
      instanceEnv: { CLAUDE_CONFIG_DIR: '/state/blue/agent-home/.claude' },
      execEnv: { PATH: '/adapter/bin', CLAUDE_CONFIG_DIR: '/adapter/claude' },
    })
    expect(env.PATH?.split(':')).toContain('/adapter/bin')
    expect(env.PATH?.split(':')).not.toContain('/opt')
    expect(env.CLAUDE_CONFIG_DIR).toBe('/state/blue/agent-home/.claude')
  })

  it('strips every inherited credential: a turn has no spawn-frame env to choose one (F10)', () => {
    const { env, strip } = headlessTurnChildEnv({ context })
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(strip).toContain('ANTHROPIC_API_KEY')
    // The instance env rides with Podium's vars; it never marks a key chosen.
    const instance = headlessTurnChildEnv({ context, instanceEnv: { ANTHROPIC_API_KEY: 'sk-x' } })
    expect(instance.strip).toContain('ANTHROPIC_API_KEY')
  })
})
