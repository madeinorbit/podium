import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asSessionId } from '@podium/model'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ABDUCO_SUN_PATH_MAX,
  abducoSocketDir,
  abducoSocketPathBytes,
  longestDurableLabelFor,
} from './abduco-socket.js'
import {
  applyInstanceRuntimeEnv,
  assertInstanceStateIdentity,
  DEFAULT_INSTANCE_ID,
  defaultInstancePorts,
  durableSessionLabel,
  ensureInstanceStateIdentity,
  instanceBuildSliceName,
  instanceCommandName,
  instanceInstallDir,
  instanceServiceName,
  instanceSessionSliceName,
  instanceStateDir,
  instanceTimerName,
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
/**
 * A SHORT temp root, for the cases about socket-path length (POD-2853).
 *
 * `temp()` above sits under a vitest run directory and is ~50 bytes before
 * anything is joined to it, which is over half of `sun_path`. A named
 * instance's abduco root is chosen by whether it FITS, so a long fixture makes
 * the chooser correctly reject it and fall to /tmp — and the test then reads as
 * a failure of the code rather than of its own fixture.
 */
const shortTemp = (): string => {
  const dir = mkdtempSync('/tmp/pod-rt-')
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
    expect(instanceServiceName('janitor', 'default')).toBe('podium-janitor.service')
    expect(instanceServiceName('update', 'default')).toBe('podium-update-user.service')
    expect(instanceUpdateTimerName('default')).toBe('podium-update-user.timer')
    expect(instanceTimerName('health', 'default')).toBe('podium-health.timer')
    expect(durableSessionLabel(asSessionId('s1'), 'default')).toBe('podium-s1')

    expect(instanceStateDir('blue', env)).toBe('/home/u/.local/state/podium/blue')
    expect(instanceInstallDir('blue', env)).toBe('/home/u/.local/share/podium-instances/blue')
    expect(instanceCommandName('blue')).toBe('podium-blue')
    expect(instanceServiceName('daemon', 'blue')).toBe('podium-blue-daemon.service')
    expect(instanceServiceName('janitor', 'blue')).toBe('podium-blue-janitor.service')
    expect(instanceUpdateTimerName('blue')).toBe('podium-blue-update.timer')
    expect(instanceTimerName('health', 'blue')).toBe('podium-blue-health.timer')
    expect(durableSessionLabel(asSessionId('s1'), 'blue')).toBe('podium-blue-s1')
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
  it('reads missing markers without a preflight existence check', () => {
    const dir = join(temp(), 'state')
    expect(readInstanceStateIdentity(dir)).toBeUndefined()
  })

  it('claims empty roots and rejects another selected instance', () => {
    const dir = join(temp(), 'state')
    expect(ensureInstanceStateIdentity({ instanceId: 'blue', dir })).toMatchObject({
      version: 2,
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
  const runtimeDir = shortTemp()
  const env: NodeJS.ProcessEnv = { XDG_RUNTIME_DIR: runtimeDir }
  applyInstanceRuntimeEnv('blue', env, dir)
  expect(env).toMatchObject({
    PODIUM_INSTANCE: 'blue',
    // The abduco root comes from the RUNTIME directory, not the state root
    // (POD-2853): a named instance's state root plus its instance-prefixed
    // label does not fit in a 108-byte `sun_path`, so pinning under the state
    // directory made every terminal spawn fail with "File name too long".
    ABDUCO_SOCKET_DIR: join(runtimeDir, 'podium-blue'),
    TMUX_TMPDIR: join(dir, 'runtime', 'tmux'),
  })
  const shared: NodeJS.ProcessEnv = { ABDUCO_SOCKET_DIR: '/shared/a', TMUX_TMPDIR: '/shared/t' }
  applyInstanceRuntimeEnv('blue', shared, dir)
  expect(shared.ABDUCO_SOCKET_DIR).toBe('/shared/a')
  expect(shared.TMUX_TMPDIR).toBe('/shared/t')
})

it('pins a named instance somewhere abduco can actually bind a socket', () => {
  // THE PROPERTY, not the path. The old pin was a perfectly reasonable-looking
  // directory that no session could ever use, and a test that only compared
  // strings would have passed against it in exactly the same way. This one
  // composes what abduco composes and measures it.
  const env: NodeJS.ProcessEnv = { XDG_RUNTIME_DIR: shortTemp() }
  applyInstanceRuntimeEnv('blue', env, join(temp(), 'state'))
  const composed = abducoSocketPathBytes(
    abducoSocketDir(env.ABDUCO_SOCKET_DIR ?? '', 'mgw'),
    longestDurableLabelFor('blue'),
    '@flatblock',
  )
  expect(composed).toBeLessThan(ABDUCO_SUN_PATH_MAX)
})

it('falls down the ladder rather than throwing when a root cannot be created', () => {
  // An XDG_RUNTIME_DIR that is not ours is an ordinary inherited-environment
  // accident, and it used to be harmless because the pin lived under the state
  // directory, which the daemon owns. It is not harmless now: an unhandled
  // mkdir would throw out of instance bootstrap, before the daemon has served
  // anything, and take down an instance over a socket directory.
  const root = shortTemp()
  const unusable = join(root, 'not-a-dir')
  writeFileSync(unusable, '') // a FILE where a directory is wanted — mkdir refuses
  const env: NodeJS.ProcessEnv = { XDG_RUNTIME_DIR: unusable, TMPDIR: join(root, 'tmp') }
  expect(() => applyInstanceRuntimeEnv('blue', env, join(temp(), 'state'))).not.toThrow()
  expect(env.ABDUCO_SOCKET_DIR).toBe(join(root, 'tmp', `podium-${process.getuid?.() ?? 0}`))
  expect(existsSync(env.ABDUCO_SOCKET_DIR ?? '')).toBe(true)
})

it('gives builds their own slice, a sibling of the sessions slice', () => {
  // systemd cuts a slice name at the last `-` to find its parent, so these two
  // names ARE the tree: both hang off podium[-<instance>].slice, and neither is
  // inside the other. A build inside the SESSIONS slice would still be bounded
  // and would still be wrong — the reclaim policy parks agents on that slice's
  // memory pressure, so every redeploy would read as agents starving.
  expect(instanceBuildSliceName('default')).toBe('podium-builds.slice')
  expect(instanceSessionSliceName('default')).toBe('podium-sessions.slice')
  expect(instanceBuildSliceName('blue')).toBe('podium-blue-builds.slice')
  expect(instanceSessionSliceName('blue')).toBe('podium-blue-sessions.slice')
})
