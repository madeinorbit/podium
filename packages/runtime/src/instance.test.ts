import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  applyInstanceRuntimeEnv,
  assertInstanceStateIdentity,
  DEFAULT_INSTANCE_ID,
  defaultInstancePorts,
  durableSessionLabel,
  ensureInstanceStateIdentity,
  instanceCommandName,
  instanceInstallDir,
  instanceServiceName,
  instanceStateDir,
  instanceUpdateTimerName,
  readInstanceStateIdentity,
  resolveInstanceId,
  selectInstance,
  validateInstanceId,
} from './instance'

const roots: string[] = []
const temp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'podium-instance-'))
  roots.push(dir)
  return dir
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('instance identity and selection', () => {
  it('keeps default implicit and validates service/path-safe names', () => {
    expect(resolveInstanceId({})).toBe(DEFAULT_INSTANCE_ID)
    expect(validateInstanceId('blue-2')).toBe('blue-2')
    for (const value of ['', 'Blue', '2blue', 'blue_x', 'a'.repeat(33)]) {
      expect(() => validateInstanceId(value)).toThrow(/invalid Podium instance id/)
    }
  })

  it('global --instance wins over env and is removed wherever it appears', () => {
    expect(selectInstance(['--instance', 'blue', 'status'], { PODIUM_INSTANCE: 'red' })).toEqual({
      instanceId: 'blue',
      argv: ['status'],
      explicit: true,
    })
    expect(selectInstance(['issue', 'ready', '--instance=green'], {})).toEqual({
      instanceId: 'green',
      argv: ['issue', 'ready'],
      explicit: true,
    })
    expect(() => selectInstance(['--instance', 'a', '--instance', 'b'], {})).toThrow(/once/)
  })
})

describe('instance namespaces', () => {
  it('preserves every legacy default name and uses disjoint named roots/names', () => {
    const env = { HOME: '/home/u' }
    expect(instanceStateDir('default', env)).toBe('/home/u/.podium')
    expect(instanceInstallDir('default', env)).toBe('/home/u/.local/share/podium')
    expect(instanceCommandName('default')).toBe('podium')
    expect(instanceServiceName('server', 'default')).toBe('podium-server.service')
    expect(instanceServiceName('update', 'default')).toBe('podium-update-user.service')
    expect(instanceUpdateTimerName('default')).toBe('podium-update-user.timer')
    expect(durableSessionLabel('s1', 'default')).toBe('podium-s1')

    expect(instanceStateDir('blue', env)).toBe('/home/u/.local/state/podium/blue')
    expect(instanceInstallDir('blue', env)).toBe('/home/u/.local/share/podium-instances/blue')
    expect(instanceCommandName('blue')).toBe('podium-blue')
    expect(instanceServiceName('daemon', 'blue')).toBe('podium-blue-daemon.service')
    expect(instanceUpdateTimerName('blue')).toBe('podium-blue-update.timer')
    expect(durableSessionLabel('s1', 'blue')).toBe('podium-blue-s1')
  })

  it('honors explicit state/XDG roots and gives named ids stable port triplets', () => {
    expect(instanceStateDir('blue', { PODIUM_STATE_DIR: '/srv/blue' })).toBe('/srv/blue')
    expect(instanceStateDir('blue', { HOME: '/h', XDG_STATE_HOME: '/state' })).toBe(
      '/state/podium/blue',
    )
    expect(defaultInstancePorts('default')).toEqual({
      server: 18787,
      hook: 45777,
      agentRelay: 45778,
    })
    expect(defaultInstancePorts('blue')).toEqual(defaultInstancePorts('blue'))
    expect(new Set(Object.values(defaultInstancePorts('blue'))).size).toBe(3)
    expect(defaultInstancePorts('blue')).not.toEqual(defaultInstancePorts('green'))
  })
})

describe('state ownership marker', () => {
  it('claims empty roots and rejects another selected instance', () => {
    const dir = join(temp(), 'state')
    expect(ensureInstanceStateIdentity({ instanceId: 'blue', dir })).toEqual({
      version: 1,
      instanceId: 'blue',
    })
    expect(readInstanceStateIdentity(dir)?.instanceId).toBe('blue')
    expect(() => assertInstanceStateIdentity('green', dir)).toThrow(/belongs to instance 'blue'/)
  })

  it('requires explicit adoption for a named non-empty unmarked root', () => {
    const dir = join(temp(), 'state')
    mkdirSync(dir)
    writeFileSync(join(dir, 'podium.db'), 'legacy')
    expect(() => ensureInstanceStateIdentity({ instanceId: 'blue', dir, env: {} })).toThrow(
      /refusing to adopt/,
    )
    expect(
      ensureInstanceStateIdentity({
        instanceId: 'blue',
        dir,
        env: { PODIUM_ADOPT_STATE: '1' },
      }).instanceId,
    ).toBe('blue')
  })

  it('marks legacy default state in place without an adoption flag', () => {
    const dir = join(temp(), 'state')
    mkdirSync(dir)
    writeFileSync(join(dir, 'config.json'), '{}')
    expect(ensureInstanceStateIdentity({ instanceId: 'default', dir, env: {} }).instanceId).toBe(
      'default',
    )
  })
})

it('named durable backend env is private unless explicitly overridden', () => {
  const dir = join(temp(), 'state')
  const env: NodeJS.ProcessEnv = {}
  applyInstanceRuntimeEnv('blue', env, dir)
  expect(env).toMatchObject({
    PODIUM_INSTANCE: 'blue',
    ABDUCO_SOCKET_DIR: join(dir, 'runtime', 'abduco'),
    TMUX_TMPDIR: join(dir, 'runtime', 'tmux'),
  })
  const shared: NodeJS.ProcessEnv = { ABDUCO_SOCKET_DIR: '/shared/a', TMUX_TMPDIR: '/shared/t' }
  applyInstanceRuntimeEnv('blue', shared, dir)
  expect(shared.ABDUCO_SOCKET_DIR).toBe('/shared/a')
  expect(shared.TMUX_TMPDIR).toBe('/shared/t')
})
