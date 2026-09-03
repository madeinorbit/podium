import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asMachineId, FIRST_ADMIN_USER_ID, type MachineId } from '@podium/model'
import { afterEach, describe, expect, it } from 'vitest'
import { type DaemonHandle, startDaemon } from '../apps/daemon/src/daemon'
import { noJanitorWorkerForTests } from '../apps/server/src/janitor-host'
import { type ServerHandle, startServer } from '../apps/server/src/server'

const DONOR_ID = asMachineId('00000000-0000-4000-8000-000000001708')
const TARGET_ID = asMachineId('00000000-0000-4000-8000-000000001709')
const ENVIRONMENT_KEYS = [
  'PODIUM_STATE_DIR',
  'PODIUM_INSTANCE',
  'PODIUM_HOST',
  'PODIUM_AGENT_HOME',
  'CODEX_HOME',
  'CLAUDE_CONFIG_DIR',
] as const

function installClaudeFixture(home: string, loggedIn: boolean): void {
  const bin = join(home, '.local', 'bin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(
    join(bin, 'claude'),
    [
      '#!/bin/sh',
      'if [ "$1" = "auth" ] && [ "$2" = "status" ]; then',
      '  if [ -s "$HOME/.claude/.credentials.json" ]; then',
      `    printf '%s\\n' '{"loggedIn":true,"email":"propagation@example.test"}'`,
      '    exit 0',
      '  fi',
      `  printf '%s\\n' '{"loggedIn":false}'`,
      '  exit 1',
      'fi',
      `printf '%s\\n' 'claude 2.1.222'`,
      '',
    ].join('\n'),
    { mode: 0o755 },
  )
  if (!loggedIn) return
  mkdirSync(join(home, '.claude'), { recursive: true })
  writeFileSync(
    join(home, '.claude', '.credentials.json'),
    JSON.stringify({
      claudeAiOauth: {
        accessToken: 'donor-access',
        refreshToken: 'donor-refresh',
        expiresAt: 200,
      },
    }),
  )
  writeFileSync(
    join(home, '.claude.json'),
    JSON.stringify({
      hasCompletedOnboarding: true,
      oauthAccount: { emailAddress: 'propagation@example.test' },
    }),
  )
}

async function waitUntil(
  label: string,
  predicate: () => boolean,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for ' + label)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

function claudeLoginState(server: ServerHandle, machineId: string): string | undefined {
  return server.registry.sessionStore.machines
    .getMachine(machineId)
    ?.inventory?.agents.find((agent) => agent.kind === 'claude-code')?.login.state
}

function preserveEnvironment(root: string): () => void {
  const previous = new Map<string, string | undefined>()
  for (const key of ENVIRONMENT_KEYS) previous.set(key, process.env[key])
  process.env.PODIUM_STATE_DIR = join(root, 'state')
  process.env.PODIUM_INSTANCE = 'default'
  process.env.PODIUM_HOST = '127.0.0.1'
  delete process.env.PODIUM_AGENT_HOME
  delete process.env.CODEX_HOME
  delete process.env.CLAUDE_CONFIG_DIR
  return () => {
    for (const key of ENVIRONMENT_KEYS) {
      const value = previous.get(key)
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

describe('real daemon-to-daemon login propagation', () => {
  let root: string | undefined

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true })
    root = undefined
  })

  it('models Claude 2.1.222 version and auth status from fixture credentials', () => {
    root = mkdtempSync(join(tmpdir(), 'podium-login-propagation-'))
    const loggedInHome = join(root, 'logged-in-home')
    const loggedOutHome = join(root, 'logged-out-home')
    mkdirSync(loggedInHome)
    mkdirSync(loggedOutHome)
    installClaudeFixture(loggedInHome, true)
    installClaudeFixture(loggedOutHome, false)

    const runFixture = (home: string, args: string[]) =>
      spawnSync(join(home, '.local', 'bin', 'claude'), args, {
        encoding: 'utf8',
        env: { ...process.env, HOME: home },
      })

    expect(runFixture(loggedInHome, ['--version'])).toMatchObject({
      status: 0,
      stdout: 'claude 2.1.222\n',
      stderr: '',
    })
    expect(runFixture(loggedInHome, ['auth', 'status'])).toMatchObject({
      status: 0,
      stdout: '{"loggedIn":true,"email":"propagation@example.test"}\n',
      stderr: '',
    })
    expect(runFixture(loggedOutHome, ['auth', 'status'])).toMatchObject({
      status: 1,
      stdout: '{"loggedIn":false}\n',
      stderr: '',
    })
  })

  it('copies a logged-in native file across two authenticated daemons and preserves a later local login', async () => {
    root = mkdtempSync(join(tmpdir(), 'podium-login-propagation-'))
    const restoreEnvironment = preserveEnvironment(root)
    let server: ServerHandle | undefined
    const daemons: DaemonHandle[] = []
    try {
      const donorHome = join(root, 'donor-home')
      const targetHome = join(root, 'target-home')
      mkdirSync(donorHome)
      mkdirSync(targetHome)
      installClaudeFixture(donorHome, true)
      installClaudeFixture(targetHome, false)

      server = await startServer({
        janitorWorkerForTests: noJanitorWorkerForTests,
        host: '127.0.0.1',
        port: 0,
      })
      const serverUrl = 'ws://127.0.0.1:' + server.port
      const startFixtureDaemon = async (
        machineId: MachineId,
        homeDir: string,
        label: string,
      ): Promise<DaemonHandle> =>
        startDaemon({
          serverUrl,
          pairCode: server?.registry.modules.machines.mintPairingCode({
            ownerUserId: FIRST_ADMIN_USER_ID,
          }),
          machineId,
          identityDir: join(root as string, label + '-identity'),
          backend: 'none',
          discovery: {
            background: false,
            cachePath: join(root as string, label + '-discovery.db'),
            homeDir,
          },
          metrics: { background: false },
          hooks: {
            port: 0,
            settingsDir: join(root as string, label + '-hooks'),
          },
          agentRelay: { port: 0 },
        })

      daemons.push(await startFixtureDaemon(DONOR_ID, donorHome, 'donor'))
      daemons.push(await startFixtureDaemon(TARGET_ID, targetHome, 'target'))

      await waitUntil('both daemon inventories', () => {
        return (
          daemons.every((daemon) => daemon.connected) &&
          server?.registry.modules.machines.hasDaemon(DONOR_ID) === true &&
          server?.registry.modules.machines.hasDaemon(TARGET_ID) === true &&
          claudeLoginState(server, DONOR_ID) === 'in' &&
          claudeLoginState(server, TARGET_ID) === 'out'
        )
      })

      await expect(
        server.registry.modules.loginPropagation.propagate({
          targetMachineId: TARGET_ID,
          agentKind: 'claude-code',
          principalUserId: FIRST_ADMIN_USER_ID,
        }),
      ).resolves.toMatchObject({
        status: 'propagated',
        donorMachineId: DONOR_ID,
      })

      const targetCredentialPath = join(targetHome, '.claude', '.credentials.json')
      expect(existsSync(targetCredentialPath)).toBe(true)
      expect(readFileSync(targetCredentialPath, 'utf8')).toBe(
        readFileSync(join(donorHome, '.claude', '.credentials.json'), 'utf8'),
      )
      expect(JSON.stringify(server.registry.sessionStore.secrets.presence())).not.toContain(
        'donor-access',
      )

      const localCredential = JSON.stringify({
        claudeAiOauth: {
          accessToken: 'local-access',
          refreshToken: 'local-refresh',
          expiresAt: 300,
        },
      })
      writeFileSync(targetCredentialPath, localCredential)

      await expect(
        server.registry.modules.loginPropagation.propagate({
          targetMachineId: TARGET_ID,
          agentKind: 'claude-code',
          principalUserId: FIRST_ADMIN_USER_ID,
          force: true,
        }),
      ).resolves.toMatchObject({ status: 'failed' })
      expect(readFileSync(targetCredentialPath, 'utf8')).toBe(localCredential)
    } finally {
      for (const daemon of daemons.reverse()) await daemon.close()
      await server?.close()
      restoreEnvironment()
    }
  }, 60_000)
})
