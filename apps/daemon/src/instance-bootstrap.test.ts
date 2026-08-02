import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { bootstrapDaemonInstance } from './instance-bootstrap'

const roots: string[] = []
const savedEnv = { ...process.env }

afterEach(() => {
  for (const key of ['PODIUM_INSTANCE', 'PODIUM_STATE_DIR', 'ABDUCO_SOCKET_DIR', 'TMUX_TMPDIR']) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('bootstrapDaemonInstance', () => {
  it('preserves instance identity as a deployment partition and scopes durable runtime paths', () => {
    const root = mkdtempSync(join(tmpdir(), 'podium-daemon-instance-'))
    roots.push(root)
    process.env.PODIUM_INSTANCE = 'blue'
    process.env.PODIUM_STATE_DIR = root
    delete process.env.ABDUCO_SOCKET_DIR
    delete process.env.TMUX_TMPDIR

    const boot = bootstrapDaemonInstance()

    expect(boot).toMatchObject({
      instanceId: 'blue',
      runtimeDir: join(root, 'runtime'),
      settingsDir: join(root, 'hooks'),
      hookSocketPath: join(root, 'runtime', 'codex-hooks.sock'),
    })
    expect(JSON.parse(readFileSync(join(root, 'instance.json'), 'utf8'))).toEqual({
      version: 1,
      instanceId: 'blue',
    })
    expect(process.env.ABDUCO_SOCKET_DIR).toBe(join(root, 'runtime', 'abduco'))
    expect(process.env.TMUX_TMPDIR).toBe(join(root, 'runtime', 'tmux'))
  })

  it('does not create a Unix hook socket path on Windows', () => {
    const root = mkdtempSync(join(tmpdir(), 'podium-daemon-instance-'))
    roots.push(root)
    process.env.PODIUM_INSTANCE = 'default'
    process.env.PODIUM_STATE_DIR = root
    expect(bootstrapDaemonInstance({ platform: 'win32' }).hookSocketPath).toBeUndefined()
  })
})
