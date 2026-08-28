import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { INSTANCE_UUID_PATTERN, instanceSocketRuntimeDir } from '@podium/runtime/instance'
import { bootstrapDaemonInstance } from './instance-bootstrap'

const roots: string[] = []
const savedEnv = { ...process.env }

afterEach(() => {
  for (const key of [
    'PODIUM_INSTANCE',
    'PODIUM_INSTANCE_UUID',
    'PODIUM_SESSION_ID',
    'PODIUM_STATE_DIR',
    'ABDUCO_SOCKET_DIR',
    'TMUX_TMPDIR',
  ]) {
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
    const socketDir = instanceSocketRuntimeDir('blue', root)

    expect(boot).toMatchObject({
      instanceId: 'blue',
      runtimeDir: join(root, 'runtime'),
      settingsDir: join(root, 'hooks'),
      hookSocketPath: join(root, 'runtime', 'codex-hooks.sock'),
    })
    // THE MARKER IS V2 NOW (`feat(runtime): an instance uuid that a reaper can
    // attribute by`). `instanceId` still names the deployment partition and is
    // still what every path, port and slice name derives from — that is the fact
    // this case is about, and it is unchanged. What v2 adds beside it is a
    // MINTED `instanceUuid`, the ownership token a process census needs to ask
    // "is this stray job mine?" without attributing by name prefix.
    expect(boot.instanceUuid).toBe(process.env.PODIUM_INSTANCE_UUID)
    expect(process.env.PODIUM_SESSION_ID).toBeUndefined()
    boot.releaseGuards()
    //
    // Asserted as an exact key set, not a `toMatchObject`: a marker that grew a
    // third field would be a third identity nobody decided on, and this is the
    // only bootstrap test that reads the file back.
    const marker = JSON.parse(readFileSync(join(root, 'instance.json'), 'utf8'))
    expect(Object.keys(marker).sort()).toEqual(['instanceId', 'instanceUuid', 'version'])
    expect(marker.version).toBe(2)
    expect(marker.instanceId).toBe('blue')
    expect(marker.instanceUuid).toMatch(INSTANCE_UUID_PATTERN)
    expect(process.env.ABDUCO_SOCKET_DIR).toBe(socketDir)
    expect(process.env.TMUX_TMPDIR).toBe(socketDir)
  })

  it('does not create a Unix hook socket path on Windows', () => {
    const root = mkdtempSync(join(tmpdir(), 'podium-daemon-instance-'))
    roots.push(root)
    process.env.PODIUM_INSTANCE = 'default'
    process.env.PODIUM_STATE_DIR = root
    expect(bootstrapDaemonInstance({ platform: 'win32' }).hookSocketPath).toBeUndefined()
  })

  it('acquires one root/UUID owner and refuses a second daemon', () => {
    const root = mkdtempSync(join(tmpdir(), 'podium-daemon-guards-'))
    roots.push(root)
    process.env.PODIUM_INSTANCE = 'blue'
    process.env.PODIUM_STATE_DIR = root
    let pid = 101
    const io = {
      pidAlive: () => true,
      bootId: () => 'boot-1',
      startTime: (candidate: number) => (candidate === 101 ? '100' : '200'),
      now: () => 1,
      selfPid: () => pid,
    }
    const guardDir = join(root, 'guards')
    const first = bootstrapDaemonInstance({ acquireGuards: true, guardDir, guardIo: io })
    pid = 202
    expect(() => bootstrapDaemonInstance({ acquireGuards: true, guardDir, guardIo: io })).toThrow(
      /already holds the state root|already live on instance uuid/,
    )

    first.releaseGuards()
    const second = bootstrapDaemonInstance({ acquireGuards: true, guardDir, guardIo: io })
    expect(second.instanceUuid).toBe(first.instanceUuid)
    second.releaseGuards()
  })

  it('moves an overlong Codex hook socket to the bounded instance runtime root', () => {
    const base = mkdtempSync(join(tmpdir(), 'podium-daemon-instance-'))
    roots.push(base)
    const root = join(base, 'x'.repeat(90))
    process.env.PODIUM_INSTANCE = 'blue'
    process.env.PODIUM_STATE_DIR = root
    delete process.env.ABDUCO_SOCKET_DIR
    delete process.env.TMUX_TMPDIR

    expect(bootstrapDaemonInstance().hookSocketPath).toBe(
      join(instanceSocketRuntimeDir('blue', root), 'codex-hooks.sock'),
    )
  })

  it('refuses an explicit overlong hook path with the instance and Linux limit', () => {
    const root = mkdtempSync(join(tmpdir(), 'podium-daemon-instance-'))
    roots.push(root)
    process.env.PODIUM_INSTANCE = 'blue'
    process.env.PODIUM_STATE_DIR = root
    expect(() =>
      bootstrapDaemonInstance({ socketPath: `/tmp/${'x'.repeat(104)}` }),
    ).toThrow(/instance 'blue'.*108 bytes.*107 pathname bytes/)
  })
})
