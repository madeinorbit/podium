/**
 * THE HARNESS'S OWN ANSWER, READ WITH THE SESSION'S ENVIRONMENT (credential
 * management §9 "Launching", epic plan Task 10, acceptance 5 and 6).
 *
 * A stand-in `claude` (a shell script) answers `auth status` the way Claude
 * Code does, and lets a competing variable win the way a real harness would:
 * `ANTHROPIC_AUTH_TOKEN` over `ANTHROPIC_API_KEY` over its home login. The
 * environment is built by the real `harnessChildEnv`, layered over a daemon
 * environment that holds competing keys. Every secret is obviously fake.
 */

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { harnessChildEnv, harnessContext } from '@podium/harness'
import type { AccessField } from '@podium/protocol'
import { afterAll, describe, expect, it } from 'vitest'
import { deliveryOverlay } from './access'
import { readEffectiveAuth, sessionProcessEnvironment } from './effective-auth'

const DELIVERED = 'sk-ant-FAKE-chosen-key-0001'
const COMPETING_KEY = 'sk-ant-FAKE-competing-key-0002'
const COMPETING_TOKEN = 'sk-ant-FAKE-competing-token-0003'

const dir = mkdtempSync(join(tmpdir(), 'effective-auth-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const claude = join(dir, 'claude')
writeFileSync(
  claude,
  [
    '#!/bin/sh',
    // A key on a descriptor (POD-7378), read to its end. The probe's is its
    // stdin, which Bun makes a socket: Claude Code reads a socket directly.
    'if [ -n "$CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR" ]; then',
    '  if [ "$(cat <&$CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR)" = "sk-ant-FAKE-chosen-key-0001" ]; then',
    '    echo \'{"loggedIn":true,"authMethod":"api_key","apiKeySource":"ANTHROPIC_API_KEY"}\'; exit 0',
    '  fi',
    '  echo \'{"loggedIn":false}\'; exit 1',
    'fi',
    'if [ -n "$ANTHROPIC_AUTH_TOKEN" ]; then',
    '  echo \'{"loggedIn":true,"authMethod":"api_key","apiKeySource":"ANTHROPIC_AUTH_TOKEN"}\'; exit 0',
    'fi',
    'if [ -n "$ANTHROPIC_API_KEY" ]; then',
    '  echo \'{"loggedIn":true,"authMethod":"api_key","apiKeySource":"ANTHROPIC_API_KEY"}\'; exit 0',
    'fi',
    'echo \'{"loggedIn":true,"authMethod":"claude.ai","email":"own@example.invalid"}\'',
    '',
  ].join('\n'),
)
chmodSync(claude, 0o755)

/** The daemon's own environment, with a competing key and token planted in it. */
const DAEMON_ENV = {
  PATH: process.env.PATH ?? '/usr/bin:/bin',
  HOME: dir,
  ANTHROPIC_API_KEY: COMPETING_KEY,
  ANTHROPIC_AUTH_TOKEN: COMPETING_TOKEN,
}

const context = harnessContext(
  {
    executables: new Map([
      ['claude-code', { kind: 'claude-code', path: claude, version: '2.1.323', generation: 1 }],
    ]),
    commandEnvironment: {
      env: DAEMON_ENV,
      pathEntries: [],
      source: 'login-shell',
      generation: 1,
      machineHome: dir,
      loginShell: '/bin/sh',
      resolve: () => undefined,
    },
  } as never,
  'claude-code',
  dir,
)

const ACCESS: AccessField = {
  credentialId: 'cred_00000000-0000-4000-8000-000000000001',
  delivery: { kind: 'env', variable: 'ANTHROPIC_API_KEY', secret: DELIVERED },
}

/** The environment a session's process gets, built as the terminal spawn builds it. */
const sessionEnv = (access: AccessField | undefined, platform: NodeJS.Platform = 'darwin') => {
  const overlay = deliveryOverlay('claude-code', access, { platform })
  const child = harnessChildEnv(context, { sessionEnv: overlay.env })
  return {
    env: sessionProcessEnvironment(DAEMON_ENV, {
      ...child,
      strip: [...new Set([...child.strip, ...overlay.strip])],
    }),
    pipe: overlay.pipe,
  }
}

describe('readEffectiveAuth', () => {
  it('can see a competing variable win when nothing strips it (canary)', async () => {
    const report = await readEffectiveAuth({
      agentKind: 'claude-code',
      executable: claude,
      env: { ...DAEMON_ENV, ANTHROPIC_API_KEY: DELIVERED },
      access: ACCESS,
    })
    expect(report).toEqual({ method: 'api-key', source: 'ANTHROPIC_AUTH_TOKEN', delivered: false })
  })

  it('a competing key in the daemon environment does not change what the harness uses', async () => {
    // A key delivered in its variable: macOS (Linux pipes it, below).
    const { env } = sessionEnv(ACCESS)
    expect(env.ANTHROPIC_API_KEY).toBe(DELIVERED)
    expect(env).not.toHaveProperty('ANTHROPIC_AUTH_TOKEN')
    const report = await readEffectiveAuth({
      agentKind: 'claude-code',
      executable: claude,
      env,
      access: ACCESS,
    })
    expect(report).toEqual({ method: 'api-key', source: 'ANTHROPIC_API_KEY', delivered: true })
    // Only the yes or no crosses: no secret is in the report.
    for (const secret of [DELIVERED, COMPETING_KEY, COMPETING_TOKEN]) {
      expect(JSON.stringify(report)).not.toContain(secret)
    }
  })

  it("no credential: the harness's own login, with the competing keys stripped", async () => {
    const report = await readEffectiveAuth({
      agentKind: 'claude-code',
      executable: claude,
      env: sessionEnv(undefined).env,
    })
    expect(report).toMatchObject({
      method: 'subscription',
      identity: { email: 'own@example.invalid' },
    })
    expect(report.identity?.fingerprint).toMatch(/^[0-9a-f]{64}$/)
  })

  it.runIf(process.platform === 'linux')(
    'a key on a pipe: the probe gets a pipe of its own and the read counts as delivered (POD-7378)',
    async () => {
      const { env, pipe } = sessionEnv(ACCESS, 'linux')
      expect(pipe).toEqual({ variable: 'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR', contents: DELIVERED })
      // No variable holds a key: neither the delivered one nor the daemon's competing one.
      expect(env).not.toHaveProperty('ANTHROPIC_API_KEY')
      expect(env).not.toHaveProperty('ANTHROPIC_AUTH_TOKEN')
      const report = await readEffectiveAuth({
        agentKind: 'claude-code',
        executable: claude,
        env,
        access: ACCESS,
        pipe,
      })
      expect(report).toEqual({ method: 'api-key', source: 'ANTHROPIC_API_KEY', delivered: true })
      // Without the pipe the same probe has no key at all.
      expect(
        await readEffectiveAuth({
          agentKind: 'claude-code',
          executable: claude,
          env,
          access: ACCESS,
        }),
      ).toMatchObject({ method: 'subscription' })
    },
  )

  it('a harness without a status command, or one that fails, is unknown', async () => {
    expect(
      await readEffectiveAuth({ agentKind: 'shell', executable: claude, env: DAEMON_ENV }),
    ).toEqual({ method: 'unknown' })
    expect(
      await readEffectiveAuth({
        agentKind: 'claude-code',
        executable: join(dir, 'missing'),
        env: DAEMON_ENV,
      }),
    ).toEqual({ method: 'unknown' })
  })

  it('a Codex launch reports the method Codex gives', async () => {
    const codex = join(dir, 'codex')
    writeFileSync(codex, '#!/bin/sh\necho "Logged in using ChatGPT"\n')
    chmodSync(codex, 0o755)
    expect(
      await readEffectiveAuth({ agentKind: 'codex', executable: codex, env: DAEMON_ENV }),
    ).toEqual({ method: 'subscription' })
  })
})
