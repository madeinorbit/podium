/** Policy/filesystem fixtures only; real legacy executables are exercised in the process proof. */
import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  type DesktopPayloadStartupRequest,
  prepareDesktopPayloadStartup,
} from './desktop-payload-startup'
import {
  acquireInstallationLease,
  type InstallationLease,
  registerInstallationStateRoot,
} from './installation-lease'
import { selfIdentityTriple } from './instance-guard'
import { createMachineCredential } from './machine-credential'
import {
  MachineUpdateExecutor,
  type MachineUpdatePhase,
  readMachineUpdateJournal,
} from './machine-update'
import { openDatabase } from './sqlite'
import { activatePreparedBundle } from './update-install'

const roots: string[] = []
const leases: InstallationLease[] = []
afterEach(() => {
  vi.unstubAllEnvs()
  for (const lease of leases.splice(0)) lease.release()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function write(path: string, value: string) {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, value)
}
function payload(dir: string, version: string) {
  write(join(dir, 'VERSION'), `${version}\n`)
  write(join(dir, 'podium-cli'), `unit fixture for ${version}`)
  write(join(dir, 'podium-host'), `host ${version}`)
  write(join(dir, 'podium'), `launcher ${version}`)
  write(join(dir, 'web/index.html'), `web ${version}`)
  write(join(dir, 'mobile/index.html'), `mobile ${version}`)
  write(join(dir, 'resources/nested/blob'), `complete resource ${version}`)
}
function hashes(dir: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      for (const [key, value] of Object.entries(hashes(path)))
        result[`${entry.name}/${key}`] = value
    } else result[entry.name] = createHash('sha256').update(readFileSync(path)).digest('hex')
  }
  return result
}
function fixture(installed = '0.2.0', candidate = '0.4.0-edge.1', mode = 'client') {
  const root = mkdtempSync(join(tmpdir(), 'podium-payload-startup-'))
  roots.push(root)
  const installDir = join(root, 'payload')
  const seed = join(root, 'signed-app/payload')
  const stateDir = join(root, 'state')
  payload(installDir, installed)
  payload(seed, candidate)
  write(
    join(stateDir, 'config.json'),
    JSON.stringify({
      mode,
      serverUrl: 'wss://example.invalid',
      updateChannel: 'edge',
      agentExecutionLockout: true,
    }),
  )
  write(
    join(stateDir, 'machine.json'),
    JSON.stringify({
      version: 1,
      machineId: 'retained-machine',
      importedFiles: {},
      role: { mode, consent: 'retained' },
    }),
  )
  createMachineCredential(stateDir)
  write(join(stateDir, 'data/retained.bin'), 'user data is not payload')
  const database = openDatabase(join(stateDir, 'podium.db'))
  database.exec(
    "CREATE TABLE retained_data (value TEXT); INSERT INTO retained_data VALUES ('preserve me')",
  )
  database.close()
  const lease = acquireInstallationLease(installDir, true)
  leases.push(lease)
  const request: DesktopPayloadStartupRequest = {
    seed,
    installDir,
    stateDir,
    channel: 'edge',
    releaseBuild: true,
    exclusive: true,
    appManaged: true,
  }
  const validate = vi.fn(async () => {})
  const run = (overrides: Parameters<typeof prepareDesktopPayloadStartup>[2] = {}) =>
    prepareDesktopPayloadStartup(request, lease, {
      inUse: async () => false,
      validate,
      fence: () => () => {},
      ...overrides,
    })
  return { root, request, lease, validate, run }
}
async function journal(
  state: string,
  phase: MachineUpdatePhase,
  previous = '0.1.0',
  target = '0.2.0',
  options: { held?: boolean; native?: boolean } = {},
) {
  const runtimeDir = join(state, 'runtime')
  const executor = new MachineUpdateExecutor({
    runtimeDir,
    report: () => {},
    adapter: {
      runningVersion: () => previous,
      runningDigest: () => 'exact-feed-digest',
      prepare: async () => ({ digest: 'exact-feed-digest' }),
      activate: async () => {},
      discard: async () => {},
      restart: async () => 'handover-pending',
    },
  })
  await executor.accept(
    {
      type: 'updateGrant',
      grantId: 'authorized',
      issuedAt: 1,
      target: {
        version: target,
        critical: false,
        artifacts: {},
        ...(options.native ? { native: { version: target, channel: 'edge' } } : {}),
      },
    },
    true,
  )
  const path = join(runtimeDir, 'machine-update.json')
  const value = JSON.parse(readFileSync(path, 'utf8'))
  Object.assign(value, {
    phase,
    previousVersion: previous,
    activationHeld: options.held ?? false,
    prepared: { digest: 'exact-feed-digest' },
  })
  writeFileSync(path, JSON.stringify(value))
  return path
}

describe('cold-start bundled payload source', () => {
  for (const mode of ['all-in-one', 'server', 'daemon', 'client', 'supervisor']) {
    it(`replaces the whole older payload and preserves every state byte for ${mode}`, async () => {
      const { request, run } = fixture('0.2.0', '0.4.0-edge.1', mode)
      const before = hashes(request.stateDir)
      const seed = hashes(request.seed)
      expect(await run()).toEqual({ outcome: 'replaced', from: '0.2.0', version: '0.4.0-edge.1' })
      expect(hashes(request.installDir)).toEqual(seed)
      expect(readFileSync(join(`${request.installDir}.old`, 'VERSION'), 'utf8').trim()).toBe(
        '0.2.0',
      )
      expect(hashes(request.stateDir)).toEqual(before)
      expect(hashes(request.seed)).toEqual(seed)
      expect(existsSync(join(request.stateDir, 'runtime/machine-update.json'))).toBe(false)
      expect(await run()).toMatchObject({ outcome: 'preserved' })
    })
  }

  it('requests the unchanged normal seed path when payload is missing', async () => {
    const { request, run, validate } = fixture()
    rmSync(request.installDir, { recursive: true })
    write(join(request.stateDir, 'config.json'), JSON.stringify({ updateChannel: 'dev' }))
    expect(await run()).toEqual({ outcome: 'seed' })
    expect(validate).not.toHaveBeenCalled()
    expect(existsSync(request.installDir)).toBe(false)
  })

  it.each([
    ['0.4.0-edge.1', '0.4.0-edge.1'],
    ['0.4.0-edge.1+feed', '0.4.0-edge.1+seed'],
    ['0.5.0', '0.4.0-edge.1'],
    ['0.4.0-dev.1+new', '0.4.0-edge.99'],
    ['dev+source', '0.4.0-edge.1'],
    ['0.2.0-debug.1', '0.4.0-edge.1'],
    ['0.2.0', 'dev+source'],
  ])('preserves %s with bundled %s, regardless of digest differences', async (installed, candidate) => {
    const { request, run, validate } = fixture(installed, candidate)
    write(join(request.installDir, 'ARTIFACT.sha256'), 'feed bytes')
    write(join(request.seed, 'ARTIFACT.sha256'), 'different signed seed bytes')
    const before = hashes(request.installDir)
    expect(await run()).toMatchObject({ outcome: 'preserved' })
    expect(hashes(request.installDir)).toEqual(before)
    expect(validate).not.toHaveBeenCalled()
  })

  it('does not let a debug shell replace an installed release', async () => {
    const { request, run } = fixture()
    request.releaseBuild = false
    expect(await run()).toMatchObject({
      outcome: 'preserved',
      reason: expect.stringContaining('debug'),
    })
  })

  it.each([
    'darwin',
    'win32',
  ] as const)('bounds %s fallback to normal app-owned payloads', async (platform) => {
    const { request, run } = fixture()
    request.appManaged = false
    expect(await run({ platform })).toMatchObject({
      outcome: 'deferred',
      reason: expect.stringContaining('custom payload'),
    })
    request.appManaged = true
    expect(await run({ platform })).toMatchObject({ outcome: 'replaced' })
  })

  it('defers an incomplete legacy ownership scan without changing bytes', async () => {
    const { request, run } = fixture()
    const before = hashes(request.installDir)
    expect(
      await run({
        inUse: async () => {
          throw new Error('incomplete')
        },
      }),
    ).toMatchObject({ outcome: 'deferred' })
    expect(hashes(request.installDir)).toEqual(before)
  })

  it.each([
    'stable',
    'dev',
  ])('honors configured %s channel over an edge bundle', async (channel) => {
    const { request, run } = fixture()
    write(join(request.stateDir, 'config.json'), JSON.stringify({ updateChannel: channel }))
    expect(await run()).toMatchObject({
      outcome: 'deferred',
      reason: expect.stringContaining('channel'),
    })
  })

  it('honors the environment channel and explicit local feed without contacting them', async () => {
    const { request, run } = fixture()
    vi.stubEnv('PODIUM_UPDATE_CHANNEL', 'dev')
    expect(await run()).toMatchObject({ outcome: 'deferred' })
    vi.unstubAllEnvs()
    write(
      join(request.stateDir, 'config.json'),
      JSON.stringify({ updateFeed: 'https://explicit.invalid' }),
    )
    expect(await run()).toMatchObject({
      outcome: 'deferred',
      reason: expect.stringContaining('feed'),
    })
  })

  it.each([
    'accepted',
    'downloading',
    'prepared',
    'activating',
    'restarting',
    'stuck',
  ] as const)('leaves the exact %s journal and prepared bytes untouched', async (phase) => {
    const { request, run } = fixture()
    const path = await journal(request.stateDir, phase, '0.2.0', '0.6.0-dev.1')
    const before = hashes(request.stateDir)
    const payloadBefore = hashes(request.installDir)
    expect(await run()).toMatchObject({ outcome: 'deferred' })
    expect(hashes(request.stateDir)).toEqual(before)
    expect(hashes(request.installDir)).toEqual(payloadBefore)
    expect(JSON.parse(readFileSync(path, 'utf8')).grant.target.version).toBe('0.6.0-dev.1')
  })

  it('preserves held preparation, orphan staging and interrupted activation independently of journal paths', async () => {
    const { request, run } = fixture()
    const path = await journal(request.stateDir, 'prepared', '0.2.0', '0.6.0', { held: true })
    const bytes = readFileSync(path)
    expect(await run()).toMatchObject({ outcome: 'deferred' })
    expect(readFileSync(path)).toEqual(bytes)
    rmSync(path)
    write(join(`${request.installDir}.prepared`, 'headless/VERSION'), '0.6.0')
    const prepared = hashes(`${request.installDir}.prepared`)
    expect(await run()).toMatchObject({ outcome: 'deferred' })
    expect(hashes(`${request.installDir}.prepared`)).toEqual(prepared)
    rmSync(`${request.installDir}.prepared`, { recursive: true })
    cpSync(request.installDir, `${request.installDir}.old`, { recursive: true })
    rmSync(request.installDir, { recursive: true })
    expect(await run()).toMatchObject({ outcome: 'deferred' })
    expect(existsSync(request.installDir)).toBe(false)
  })

  it('defers an unfinished native self-update until another eligible cold start', async () => {
    const { request, run } = fixture()
    const path = await journal(request.stateDir, 'restarting', '0.1.0', '0.2.0', { native: true })
    expect(
      readMachineUpdateJournal(join(request.stateDir, 'runtime'))?.grant.target.native,
    ).toBeDefined()
    const bytes = readFileSync(path)
    expect(await run()).toMatchObject({ outcome: 'deferred' })
    expect(readFileSync(path)).toEqual(bytes)
    const value = JSON.parse(bytes.toString())
    value.phase = 'current'
    writeFileSync(path, JSON.stringify(value))
    expect(await run()).toMatchObject({ outcome: 'replaced' })
  })

  it('distinguishes historical forward success from an intentional completed downgrade', async () => {
    const { request, run } = fixture()
    const path = await journal(request.stateDir, 'current')
    const bytes = readFileSync(path)
    expect(await run()).toMatchObject({ outcome: 'replaced' })
    expect(readFileSync(path)).toEqual(bytes)
    rmSync(`${request.installDir}.old`, { recursive: true })
    payload(request.installDir, '0.2.0')
    await journal(request.stateDir, 'current', '0.5.0', '0.2.0')
    expect(await run()).toMatchObject({
      outcome: 'deferred',
      reason: expect.stringContaining('target'),
    })
  })

  it('does not turn a completed same-version repair into a permanent pin', async () => {
    const { request, run } = fixture()
    await journal(request.stateDir, 'current', '0.2.0', '0.2.0')
    expect(await run()).toMatchObject({ outcome: 'replaced' })
  })

  it('leaves a held exact artifact for the ordinary executor to activate and confirm', async () => {
    const { request, run } = fixture()
    const staged = `${request.installDir}.prepared`
    const runtimeDir = join(request.stateDir, 'runtime')
    let running = '0.2.0'
    let digest = 'old-runtime'
    const restart = vi.fn(async () => 'handover-pending' as const)
    const executor = new MachineUpdateExecutor({
      runtimeDir,
      report: () => {},
      adapter: {
        runningVersion: () => running,
        runningDigest: () => digest,
        prepare: async () => {
          payload(join(staged, 'headless'), '0.3.0')
          write(join(staged, 'headless/ARTIFACT.sha256'), 'authorized-feed-digest')
          return { digest: 'authorized-feed-digest' }
        },
        activate: async () => {
          activatePreparedBundle(join(staged, 'headless'), request.installDir)
          rmSync(staged, { recursive: true, force: true })
        },
        discard: async () => {
          rmSync(staged, { recursive: true, force: true })
        },
        restart,
      },
    })
    await executor.accept(
      {
        type: 'updateGrant',
        grantId: 'held-exact',
        issuedAt: 1,
        target: { version: '0.3.0', critical: false, artifacts: {} },
      },
      true,
      true,
    )
    const prepared = hashes(staged)
    const authority = readFileSync(join(runtimeDir, 'machine-update.json'))
    expect(await run()).toMatchObject({ outcome: 'deferred' })
    expect(hashes(staged)).toEqual(prepared)
    expect(readFileSync(join(runtimeDir, 'machine-update.json'))).toEqual(authority)
    await executor.activate('held-exact')
    await vi.waitFor(() => expect(restart).toHaveBeenCalledOnce())
    expect(readFileSync(join(request.installDir, 'VERSION'), 'utf8').trim()).toBe('0.3.0')
    expect(executor.snapshot()?.grant.grantId).toBe('held-exact')
    running = '0.3.0'
    digest = 'authorized-feed-digest'
    await executor.confirmBoot(true)
    expect(executor.snapshot()?.phase).toBe('current')
  })

  it('allows a completed predecessor only with exact installed artifact and current health provenance', async () => {
    const { request, run } = fixture()
    cpSync(request.installDir, `${request.installDir}.old`, { recursive: true })
    expect(await run()).toMatchObject({ outcome: 'deferred' })
    await journal(request.stateDir, 'current')
    const journalPath = join(request.stateDir, 'runtime/machine-update.json')
    const noReceipt = JSON.parse(readFileSync(journalPath, 'utf8'))
    delete noReceipt.prepared
    writeFileSync(journalPath, JSON.stringify(noReceipt))
    expect(await run()).toMatchObject({ outcome: 'deferred' })
    await journal(request.stateDir, 'current')
    write(join(request.installDir, 'ARTIFACT.sha256'), 'wrong-digest')
    expect(await run()).toMatchObject({ outcome: 'deferred' })
    write(join(request.installDir, 'ARTIFACT.sha256'), 'exact-feed-digest')
    expect(await run()).toMatchObject({ outcome: 'replaced' })
    expect(existsSync(join(request.installDir, 'ARTIFACT.sha256'))).toBe(false)
  })

  it('checks unfinished work in a reused second state root sharing the payload', async () => {
    const { request, root, lease, run } = fixture()
    const second = join(root, 'second-instance')
    registerInstallationStateRoot(lease, second)
    const path = await journal(second, 'downloading')
    const bytes = readFileSync(path)
    expect(await run()).toMatchObject({ outcome: 'deferred' })
    expect(readFileSync(path)).toEqual(bytes)
    expect(existsSync(`${request.installDir}.old`)).toBe(false)
  })

  it('respects live run records but recognizes dead and PID-reused records', async () => {
    const { request, run } = fixture()
    const identity = selfIdentityTriple()
    const path = join(request.stateDir, 'run/parent.pid')
    write(
      path,
      JSON.stringify({
        pid: identity.pid,
        bootId: identity.bootId,
        procStartTime: identity.startTime,
      }),
    )
    expect(await run()).toMatchObject({ outcome: 'deferred' })
    write(path, JSON.stringify({ pid: identity.pid, bootId: 'different-boot', procStartTime: '1' }))
    expect(await run()).toMatchObject({ outcome: 'replaced' })
  })

  it('never treats corrupt identity, key, journal or payload as evidence of an older valid install', async () => {
    for (const name of ['machine.json', 'machine.key', 'runtime/machine-update.json']) {
      const { request, run } = fixture()
      write(join(request.stateDir, name), '{ private-corrupt-state')
      const before = hashes(request.stateDir)
      const result = await run()
      expect(result).toMatchObject({ outcome: 'failed' })
      expect(JSON.stringify(result)).not.toContain('private-corrupt-state')
      expect(hashes(request.stateDir)).toEqual(before)
      expect(readFileSync(join(request.installDir, 'VERSION'), 'utf8').trim()).toBe('0.2.0')
    }
    const { request, run } = fixture()
    rmSync(join(request.installDir, 'VERSION'))
    expect(await run()).toMatchObject({ outcome: 'preserved' })
  })

  it.each([
    'preparing',
    'staged',
    'commit-uncertain',
    'committing',
  ])('defers unfinished transfer %s', async (state) => {
    const { request, run } = fixture()
    write(
      join(request.stateDir, '.server-transfer/journal.json'),
      JSON.stringify({ formatVersion: 1, state }),
    )
    expect(await run()).toMatchObject({ outcome: 'deferred' })
  })

  it('defers target promotion until acknowledgment and preserves schema failures', async () => {
    const { request, run } = fixture()
    const path = join(
      request.stateDir,
      '.server-transfer/12345678-1234-1234-1234-123456789abc/state.json',
    )
    write(path, JSON.stringify({ state: 'promoted', acknowledged: false }))
    expect(await run()).toMatchObject({ outcome: 'deferred' })
    write(path, JSON.stringify({ state: 'promoted', acknowledged: true }))
    write(join(request.stateDir, 'podium.db'), 'damaged database')
    expect(await run()).toMatchObject({
      outcome: 'deferred',
      reason: expect.stringContaining('schema'),
    })
  })

  it('retains the original on staged validation and activation rename failure', async () => {
    const { request, run } = fixture()
    const before = hashes(request.installDir)
    expect(
      await run({
        validate: async (path) => {
          if (path.endsWith('.prepared/headless')) throw new Error('staged bytes invalid')
        },
      }),
    ).toMatchObject({ outcome: 'failed' })
    expect(hashes(request.installDir)).toEqual(before)
    expect(
      await run({
        activate: (replacement, install) => {
          rmSync(replacement, { recursive: true })
          activatePreparedBundle(replacement, install)
        },
      }),
    ).toMatchObject({ outcome: 'failed' })
    expect(hashes(request.installDir)).toEqual(before)
    expect(existsSync(`${request.installDir}.prepared`)).toBe(false)
  })

  it('does not replace if a legacy owner appears while preparing', async () => {
    const { request, run } = fixture()
    let checks = 0
    const before = hashes(request.installDir)
    expect(await run({ inUse: async () => ++checks > 1 })).toMatchObject({ outcome: 'deferred' })
    expect(hashes(request.installDir)).toEqual(before)
    expect(existsSync(`${request.installDir}.prepared`)).toBe(false)
  })
})
