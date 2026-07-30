import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { materializeLaunchFiles, spawnEnv } from './session'

it('passes a managed credential through to the spawn env', () => {
  const env = spawnEnv({
    sessionEnv: { ANTHROPIC_API_KEY: 'sk-1' },
    podiumEnv: { PODIUM_SESSION_ID: 's1' },
  })
  expect(env.ANTHROPIC_API_KEY).toBe('sk-1')
  expect(env.PODIUM_SESSION_ID).toBe('s1')
})

it('is a no-op when the server sends no env', () => {
  expect(spawnEnv({ podiumEnv: { PODIUM_SESSION_ID: 's1' } })).toEqual({
    PODIUM_SESSION_ID: 's1',
  })
})

it("podium's own bindings win a collision — a credential cannot shadow the relay", () => {
  const env = spawnEnv({
    sessionEnv: { PODIUM_SESSION_ID: 'evil' },
    podiumEnv: { PODIUM_SESSION_ID: 's1' },
  })
  expect(env.PODIUM_SESSION_ID).toBe('s1')
})

it('layers harness env over managed env while preserving Podium-owned bindings', () => {
  expect(
    spawnEnv({
      sessionEnv: { ACCOUNT: 'managed', SHARED: 'managed' },
      harnessEnv: { OPENCODE_CONFIG_CONTENT: '{}', SHARED: 'harness' },
      podiumEnv: { PODIUM_SESSION_ID: 's1', SHARED: 'podium' },
    }),
  ).toEqual({
    ACCOUNT: 'managed',
    OPENCODE_CONFIG_CONTENT: '{}',
    PODIUM_SESSION_ID: 's1',
    SHARED: 'podium',
  })
})

it('makes unattended user-installed harnesses executable for detached daemons', () => {
  const env = spawnEnv({
    sessionEnv: { PATH: '/managed/bin:/usr/bin' },
    podiumEnv: { HOME: '/root', PODIUM_SESSION_ID: 's1' },
  })
  expect(env.PATH).toBe('/root/.local/bin:/root/.bun/bin:/root/.opencode/bin:/managed/bin:/usr/bin')
})

it('deduplicates a user harness directory already present in PATH', () => {
  const env = spawnEnv({
    podiumEnv: { HOME: '/home/tester', PATH: '/home/tester/.local/bin:/usr/bin' },
  })
  expect(env.PATH).toBe(
    '/home/tester/.local/bin:/home/tester/.bun/bin:/home/tester/.opencode/bin:/usr/bin',
  )
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
