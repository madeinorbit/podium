import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { materializeLaunchFiles } from './session'
import { foreignCredentialEnv, serverChildEnv, spawnEnv } from './session-env'

it("drops the credential vars that would outrank a claude session's own login", () => {
  // POD-2296: measured on Claude Code 2.1.224 — with a `max` credential in the
  // home and ANTHROPIC_API_KEY in the env, `claude auth status` reports
  // `apiKeySource: ANTHROPIC_API_KEY` and `subscriptionType: null`.
  expect(foreignCredentialEnv('claude-code')).toEqual(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'])
})

it('keeps a key the SERVER chose for this session — that one is not a leak', () => {
  // A managed account (#216) is Podium resolving an account on purpose. Only what
  // the child would have INHERITED from the daemon is dropped, so the two cannot
  // be told apart by name alone — the spawn frame is what distinguishes them.
  expect(foreignCredentialEnv('claude-code', { ANTHROPIC_API_KEY: 'sk-managed' })).toEqual([
    'ANTHROPIC_AUTH_TOKEN',
  ])
})

it("leaves an operator's shell exactly as they launched it", () => {
  // A shell session is the operator at their own prompt, not an agent resolving
  // an account: removing their key would break work they meant to do.
  expect(foreignCredentialEnv('shell')).toEqual([])
  expect(foreignCredentialEnv(undefined)).toEqual([])
  // An unknown harness id declares nothing, so nothing is guessed for it.
  expect(foreignCredentialEnv('some-future-cli')).toEqual([])
})

it('passes a managed credential through to the spawn env', () => {
  const env = spawnEnv(
    {
      sessionEnv: { ANTHROPIC_API_KEY: 'sk-1' },
      podiumEnv: { PODIUM_SESSION_ID: 's1' },
    },
    {},
  )
  expect(env.ANTHROPIC_API_KEY).toBe('sk-1')
  expect(env.PODIUM_SESSION_ID).toBe('s1')
})

it('is a no-op when the server sends no env', () => {
  expect(spawnEnv({ podiumEnv: { PODIUM_SESSION_ID: 's1' } }, {})).toEqual({
    PODIUM_SESSION_ID: 's1',
  })
})

it("podium's own bindings win a collision — a credential cannot shadow the relay", () => {
  const env = spawnEnv(
    {
      sessionEnv: { PODIUM_SESSION_ID: 'evil' },
      podiumEnv: { PODIUM_SESSION_ID: 's1' },
    },
    {},
  )
  expect(env.PODIUM_SESSION_ID).toBe('s1')
})

it('layers harness env over managed env while preserving Podium-owned bindings', () => {
  expect(
    spawnEnv(
      {
        sessionEnv: { ACCOUNT: 'managed', SHARED: 'managed' },
        harnessEnv: { OPENCODE_CONFIG_CONTENT: '{}', SHARED: 'harness' },
        podiumEnv: { PODIUM_SESSION_ID: 's1', SHARED: 'podium' },
      },
      {},
    ),
  ).toEqual({
    ACCOUNT: 'managed',
    OPENCODE_CONFIG_CONTENT: '{}',
    PODIUM_SESSION_ID: 's1',
    SHARED: 'podium',
  })
})

it('preserves the command environment supplied by the centralized runtime', () => {
  const env = spawnEnv(
    {
      sessionEnv: { PATH: '/managed/bin:/usr/bin' },
      podiumEnv: { HOME: '/root', PODIUM_SESSION_ID: 's1' },
    },
    {},
  )
  expect(env.PATH).toBe('/managed/bin:/usr/bin')
})

it('does not reinterpret PATH from a credential HOME', () => {
  const env = spawnEnv(
    {
      podiumEnv: { HOME: '/home/tester', PATH: '/home/tester/.local/bin:/usr/bin' },
    },
    {},
  )
  expect(env.PATH).toBe('/home/tester/.local/bin:/usr/bin')
})

it('makes the desktop CLI authoritative without requiring a HOME override', () => {
  const env = spawnEnv(
    {
      sessionEnv: {
        PATH:
          '/home/tester/.local/bin:/Applications/Podium.app/Contents/Resources/resources:/usr/bin',
        PODIUM_CLI_PATH: '/stale/session/podium',
      },
      harnessEnv: { PODIUM_CLI_PATH: '/stale/harness/podium' },
      podiumEnv: { PODIUM_SESSION_ID: 's1' },
    },
    {
      PATH: '/usr/bin',
      PODIUM_CLI_PATH: '/Applications/Podium.app/Contents/Resources/resources/podium',
    },
  )
  expect(env.PODIUM_CLI_PATH).toBe(
    '/Applications/Podium.app/Contents/Resources/resources/podium',
  )
  expect(env.PATH).toBe(
    '/Applications/Podium.app/Contents/Resources/resources:/home/tester/.local/bin:/usr/bin',
  )
})

it('gives a server-driver child the INSTANCE home, never the daemon one (POD-2247)', () => {
  // THE PIN: `process.env.HOME` must never reach a server-driver child when the
  // daemon has an instance agent home. This is the exact leak found live — an
  // isolated grok session refreshed the operator's real ~/.grok credentials.
  const env = serverChildEnv(
    {
      agentKind: 'opencode',
      homeDir: '/tmp/pod-op/state/agent-home',
      sessionEnv: { ANTHROPIC_API_KEY: 'sk-1' },
    },
    { PATH: '/usr/bin' },
  )
  expect(env.HOME).toBe('/tmp/pod-op/state/agent-home')
  expect(env.HOME).not.toBe(process.env.HOME)
  // The daemon env still rides underneath (spawn REPLACES the child env, so the
  // spread is what keeps PATH, TERM and the rest alive)…
  expect(env.ANTHROPIC_API_KEY).toBe('sk-1')
  // …and the instance's own install roots lead PATH, exactly as the PTY path
  // derives them.
  expect(env.PATH?.startsWith('/tmp/pod-op/state/agent-home/.local/bin:')).toBe(true)
})

it('cannot have the instance home shadowed by a server-sent env', () => {
  // Same precedence rule spawnEnv gives podiumEnv: an injected credential must
  // never redirect a child back into the operator's real home.
  const env = serverChildEnv({
    agentKind: 'codex',
    homeDir: '/instance/home',
    sessionEnv: { HOME: '/home/operator' },
    harnessEnv: { HOME: '/also/not/this' },
  })
  expect(env.HOME).toBe('/instance/home')
  expect(env.CODEX_HOME).toBe('/instance/home/.codex')
})

it('leaves a default instance exactly as before — daemon env plus overlays', () => {
  const env = serverChildEnv({ agentKind: 'opencode', sessionEnv: { MANAGED: 'x' } })
  expect(env.HOME).toBe(process.env.HOME)
  expect(env.PATH).toBe(process.env.PATH)
  expect(env.MANAGED).toBe('x')
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
