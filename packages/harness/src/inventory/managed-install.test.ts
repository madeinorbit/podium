/**
 * The managed-install mechanism (POD-7269, docs/design/harness-managed-installs.md
 * §5.4 to §5.6): one release into a fresh folder, checked from outside the
 * adapter, published in the ledger, and every failure leaving the current
 * release in place. Driven through a fake adapter against a local fake vendor.
 */
import { type ChildProcess, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { SessionId } from '@podium/model'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AGENT_MANIFESTS } from '../registry.js'
import { InstallLedger } from './install-ledger.js'
import { readInstallReceipt, writeInstallReceipt } from './install-receipt.js'
import {
  applyVendorOrigins,
  housekeepReleases,
  type InstallProgress,
  type InstallReleaseOptions,
  type InstallStep,
  installRelease,
  managedInstallEnv,
  printsVersion,
  VENDOR_ORIGINS_ENV,
  vendorOriginsFromEnv,
} from './managed-install.js'
import {
  type FakeAdapterObservation,
  type FakeRelease,
  FakeVendorHost,
  fakeTarget,
} from './managed-install.test-support.js'

const KIND = 'claude-code' as const

let root: string
let harnessesDir: string
let vendor: FakeVendorHost
let ledger: InstallLedger

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'podium-managed-install-'))
  harnessesDir = join(root, 'harnesses')
  vendor = await new FakeVendorHost([{ version: '1.0.0' }]).start()
  ledger = InstallLedger.open({ harnessesDir })
})

afterEach(async () => {
  ledger.close()
  await vendor.stop()
  rmSync(root, { recursive: true, force: true })
})

const commandEnv = () => ({
  PATH: process.env.PATH ?? '/usr/bin:/bin',
  HOME: join(root, 'machine-home'),
})

function install(overrides: Partial<InstallReleaseOptions> = {}) {
  return installRelease(KIND, {
    ledger,
    commandEnv: commandEnv(),
    vendorOrigins: vendor.origins,
    target: fakeTarget(),
    probeTimeoutMs: 10_000,
    ...overrides,
  })
}

async function publish(release: FakeRelease) {
  vendor.publish(release)
  return install()
}

function kindEntries(): string[] {
  try {
    return readdirSync(join(harnessesDir, KIND)).sort()
  } catch {
    return []
  }
}

/** Names, modes, link targets and bytes of every entry under `dir`. */
function treeDigest(dir: string): string {
  const hash = createHash('sha256')
  const walk = (path: string, rel: string) => {
    const stat = lstatSync(path)
    hash.update(`${rel}\0${stat.mode}\0`)
    if (stat.isSymbolicLink()) hash.update(readlinkSync(path))
    else if (stat.isDirectory())
      for (const name of readdirSync(path).sort()) walk(join(path, name), `${rel}/${name}`)
    else hash.update(readFileSync(path))
  }
  walk(dir, '.')
  return hash.digest('hex')
}

describe('installRelease: the seven steps', () => {
  it('publishes a numbered folder with a valid receipt, moves current and previous, and asks for a reprobe', async () => {
    const reprobe = vi.fn()
    const first = await install({ reprobe })
    expect(first).toMatchObject({
      outcome: 'installed',
      number: 1,
      version: '1.0.0',
      previous: null,
    })
    expect(reprobe).toHaveBeenCalledTimes(1)

    const second = await publish({ version: '1.1.0' })
    expect(second).toMatchObject({ outcome: 'installed', number: 2, version: '1.1.0', previous: 1 })
    if (second.outcome !== 'installed') throw new Error('not installed')

    const read = readInstallReceipt(second.dir)
    expect(read).toMatchObject({
      ok: true,
      receipt: {
        harness: KIND,
        version: '1.1.0',
        executable: 'bin/fake-harness',
        integrity: { kind: 'sha256' },
        source: 'https://downloads.fake-harness.invalid/releases/1.1.0/fake-harness',
      },
    })
    expect(second.executable).toBe(join(harnessesDir, KIND, '2-1.1.0', 'bin', 'fake-harness'))
    expect(ledger.get(KIND)).toMatchObject({ current: 2, previous: 1 })
    expect(ledger.get(KIND)?.lastCheck).toMatchObject({ ok: true, latest: '1.1.0' })
    expect(kindEntries()).toEqual(['1-1.0.0', '2-1.1.0'])
    expect(ledger.installLockHolder()).toBeUndefined()
  })

  it('keeps two releases on disk: a third install sweeps the one that is neither current nor previous', async () => {
    await install()
    await publish({ version: '1.1.0' })
    const third = await publish({ version: '1.2.0' })
    expect(third).toMatchObject({ outcome: 'installed', number: 3, swept: ['1-1.0.0'] })
    expect(kindEntries()).toEqual(['2-1.1.0', '3-1.2.0'])
  })

  it('installs the same version again as a new folder (a repair)', async () => {
    await install()
    const repair = await install({ release: { version: '1.0.0' } })
    expect(repair).toMatchObject({ outcome: 'installed', number: 2, previous: 1 })
    expect(kindEntries()).toEqual(['1-1.0.0', '2-1.0.0'])
  })

  it('never writes a published folder after its rename', async () => {
    await install()
    const published = join(harnessesDir, KIND, '1-1.0.0')
    const before = treeDigest(published)
    await publish({ version: '1.1.0' })
    await publish({ version: '1.0.0', behaviour: 'exit' })
    expect(treeDigest(published)).toBe(before)
  })

  it("keeps the vendor installer's profile edits, links and config inside the release's own home", async () => {
    const result = await install()
    if (result.outcome !== 'installed') throw new Error('not installed')
    const home = join(result.dir, 'home')
    expect(readFileSync(join(home, '.bashrc'), 'utf8')).toContain('.local/bin')
    expect(readFileSync(join(home, '.fake-harness', 'config'), 'utf8')).toBe('channel=stable\n')
    expect(lstatSync(join(home, '.local', 'bin', 'fake-harness')).isSymbolicLink()).toBe(true)
  })

  it('answers busy and changes nothing while another program holds the install lock', async () => {
    await install()
    const other = InstallLedger.open({ harnessesDir })
    const held = other.acquireInstallLock({ label: 'podium machine setup', autoRenew: false })
    try {
      const result = await publish({ version: '1.1.0' })
      expect(result).toMatchObject({ outcome: 'busy', holder: { label: 'podium machine setup' } })
      expect(ledger.get(KIND)).toMatchObject({ current: 1 })
      expect(kindEntries()).toEqual(['1-1.0.0'])
    } finally {
      if (held.acquired) held.lock.release()
      other.close()
    }
  })
})

describe('installRelease: failures (§5.6)', () => {
  const ENOSPC = () => {
    throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' })
  }

  type Case = {
    name: string
    release?: FakeRelease
    options?: () => Partial<InstallReleaseOptions>
    outcome: 'check-failed' | 'failed'
    rejected: boolean
    step?: string
    error: RegExp
  }
  const cases: Case[] = [
    {
      name: 'vendor unreachable',
      options: () => ({
        vendorOrigins: { 'https://downloads.fake-harness.invalid': 'http://127.0.0.1:1' },
      }),
      outcome: 'check-failed',
      rejected: false,
      error: /./,
    },
    {
      name: 'checksum mismatch',
      release: { version: '1.1.0', badChecksum: true },
      outcome: 'failed',
      rejected: false,
      step: 'install',
      error: /checksum verification FAILED/,
    },
    {
      name: 'adapter throws (vendor installer fails)',
      release: { version: '1.1.0', installerFails: true },
      outcome: 'failed',
      rejected: false,
      step: 'install',
      error: /unsupported platform/,
    },
    {
      name: '--version exits non-zero',
      release: { version: '1.1.0', behaviour: 'exit' },
      outcome: 'failed',
      rejected: true,
      step: 'verify',
      error: /does not run \(exit\)/,
    },
    {
      name: 'the binary cannot be executed',
      release: { version: '1.1.0', behaviour: 'not-executable' },
      outcome: 'failed',
      rejected: true,
      step: 'verify',
      error: /does not run \(exec-error\)/,
    },
    {
      name: '--version times out',
      release: { version: '1.1.0', behaviour: 'hang' },
      options: () => ({ probeTimeoutMs: 300 }),
      outcome: 'failed',
      rejected: true,
      step: 'verify',
      error: /does not run \(timeout\)/,
    },
    {
      name: 'prints another version',
      release: { version: '1.1.0', behaviour: 'wrong-version' },
      outcome: 'failed',
      rejected: true,
      step: 'verify',
      error: /reports another version: fake-harness 0\.0\.1/,
    },
    {
      name: 'below the minimum',
      release: { version: '1.1.0' },
      options: () => ({
        target: fakeTarget({
          versionPolicy: { minimum: { major: 2, minor: 0 }, verifiedThrough: '2.0.0' },
        }),
      }),
      outcome: 'failed',
      rejected: true,
      step: 'verify',
      error: /below the minimum/,
    },
    {
      name: 'write error',
      release: { version: '1.1.0' },
      options: () => ({ beforeStep: (step) => (step === 'receipt' ? ENOSPC() : undefined) }),
      outcome: 'failed',
      rejected: false,
      step: 'receipt',
      error: /ENOSPC/,
    },
    {
      name: 'the ledger publish fails',
      release: { version: '1.1.0' },
      options: () => ({
        beforeStep: (step) => {
          if (step === 'publish') throw new Error('database is locked')
        },
      }),
      outcome: 'failed',
      rejected: false,
      step: 'publish',
      error: /database is locked/,
    },
  ]

  it.each(
    cases,
  )('$name: current stays, leftovers are swept, rejected only for a bad binary', async (c) => {
    const first = await install()
    expect(first.outcome).toBe('installed')
    if (c.release) vendor.publish(c.release)
    const result = await install(c.options?.() ?? {})

    expect(result.outcome).toBe(c.outcome)
    if (result.outcome === 'failed') {
      expect(result.step).toBe(c.step)
      expect(result.rejected).toBe(c.rejected)
      expect(result.error).toMatch(c.error)
      expect(ledger.get(KIND)?.lastInstallError).toMatchObject({ version: '1.1.0' })
    }
    if (result.outcome === 'check-failed') {
      expect(result.error).toMatch(c.error)
      expect(ledger.get(KIND)?.lastCheck).toMatchObject({ ok: false })
    }
    expect(ledger.get(KIND)).toMatchObject({ current: 1, previous: null })
    expect(ledger.get(KIND)?.failingSince).toBeDefined()
    expect(ledger.rejectedReleases(KIND).map((r) => r.version)).toEqual(c.rejected ? ['1.1.0'] : [])
    expect(kindEntries()).toEqual(['1-1.0.0'])
    expect(ledger.installLockHolder()).toBeUndefined()
  })

  it('a later good release installs after a rejected one, and ends the failing run', async () => {
    await install()
    await publish({ version: '1.1.0', behaviour: 'exit' })
    const next = await publish({ version: '1.2.0' })
    expect(next).toMatchObject({ outcome: 'installed', number: 2, previous: 1 })
    expect(ledger.get(KIND)?.failingSince).toBeUndefined()
    expect(ledger.rejectedReleases(KIND).map((r) => r.version)).toEqual(['1.1.0'])
  })

  it('rejects a release whose identity probe runs and answers as another program', async () => {
    await install()
    vendor.publish({ version: '1.1.0' })
    const result = await install({
      target: {
        ...fakeTarget(),
        identityProbe: { args: ['--about'], accepts: (output) => output.includes('Other Harness') },
      },
    })
    expect(result).toMatchObject({ outcome: 'failed', step: 'verify', rejected: true })
    if (result.outcome === 'failed') expect(result.error).toMatch(/identity probe refused it/)
    expect(ledger.rejectedReleases(KIND).map((r) => r.version)).toEqual(['1.1.0'])
    expect(ledger.get(KIND)).toMatchObject({ current: 1 })
    expect(kindEntries()).toEqual(['1-1.0.0'])
  })

  it('treats an identity probe that exits with an error as transient, not a rejection', async () => {
    await install()
    vendor.publish({ version: '1.1.0', behaviour: 'identity-exit' })
    const result = await install({
      target: { ...fakeTarget(), identityProbe: { args: ['--about'], accepts: () => true } },
    })
    expect(result).toMatchObject({ outcome: 'failed', step: 'verify', rejected: false })
    if (result.outcome === 'failed') expect(result.error).toMatch(/identity probe failed \(exit\)/)
    expect(ledger.rejectedReleases(KIND)).toEqual([])
    expect(ledger.get(KIND)).toMatchObject({ current: 1 })
    expect(ledger.get(KIND)?.lastInstallError).toMatchObject({ version: '1.1.0' })
    expect(kindEntries()).toEqual(['1-1.0.0'])
  })

  it('refuses an executable outside the release folder without rejecting the version', async () => {
    await install()
    vendor.publish({ version: '1.1.0' })
    const escaping = fakeTarget()
    const real = escaping.install
    const result = await install({
      target: {
        ...escaping,
        install: {
          latest: real.latest,
          install: async (release, dir, ports) => ({
            ...(await real.install(release, dir, ports)),
            executable: '../../outside',
          }),
        },
      },
    })
    expect(result).toMatchObject({ outcome: 'failed', step: 'verify', rejected: false })
    expect(kindEntries()).toEqual(['1-1.0.0'])
  })
})

describe('installRelease: a crash at a step', () => {
  async function crashAt(step: 'rename' | 'publish'): Promise<void> {
    const script = join(root, 'crash.mjs')
    writeFileSync(
      script,
      `import { installRelease } from ${JSON.stringify(resolve(import.meta.dirname, 'managed-install.ts'))}
import { fakeTarget } from ${JSON.stringify(resolve(import.meta.dirname, 'managed-install.test-support.ts'))}
const [harnessesDir, origins, step, path] = process.argv.slice(2)
await installRelease('claude-code', {
  harnessesDir,
  commandEnv: { PATH: path, HOME: harnessesDir },
  vendorOrigins: JSON.parse(origins),
  target: fakeTarget(),
  beforeStep: (at) => { if (at === step) process.kill(process.pid, 'SIGKILL') },
})
console.log('survived')
`,
    )
    const child: ChildProcess = spawn(
      process.execPath,
      [
        '--conditions=@podium/source',
        script,
        harnessesDir,
        JSON.stringify(vendor.origins),
        step,
        process.env.PATH ?? '/usr/bin:/bin',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let output = ''
    child.stdout?.on('data', (chunk) => {
      output += String(chunk)
    })
    child.stderr?.on('data', (chunk) => {
      output += String(chunk)
    })
    const signal = await new Promise<NodeJS.Signals | null>((done) =>
      child.on('exit', (_code, sig) => done(sig)),
    )
    expect(signal, output).toBe('SIGKILL')
  }

  it.each([
    ['rename', /^\.staging-/],
    ['publish', /^2-1\.1\.0$/],
  ] as const)('crash before %s: nothing is published, and housekeeping sweeps the leftover', async (step, leftover) => {
    await install()
    ledger.close()
    vendor.publish({ version: '1.1.0' })
    await crashAt(step)
    ledger = InstallLedger.open({ harnessesDir })

    expect(ledger.get(KIND)).toMatchObject({ current: 1, previous: null })
    const left = kindEntries().filter((name) => name !== '1-1.0.0')
    expect(left).toHaveLength(1)
    expect(left[0]).toMatch(leftover)

    // The dead installer's lease is taken over, and its leftover deleted.
    const swept = housekeepReleases(KIND, { ledger })
    expect(swept).toMatchObject({ outcome: 'swept', removed: left })
    expect(kindEntries()).toEqual(['1-1.0.0'])
    expect(ledger.rejectedReleases(KIND)).toEqual([])
  })
})

describe('installRelease: progress, cancel and retry (POD-7471)', () => {
  it('reports each phase once, in order, and the download bytes against the size the vendor named', async () => {
    vendor.publish({ version: '1.1.0', padBytes: 512 * 1024 })
    const seen: InstallProgress[] = []
    const result = await install({ onProgress: (progress) => seen.push({ ...progress }) })
    if (result.outcome !== 'installed') throw new Error(`not installed: ${result.outcome}`)

    expect(seen.filter((p) => p.receivedBytes === undefined).map((p) => p.phase)).toEqual([
      'download',
      'verify',
      'setup',
    ])
    const size = statSync(result.executable).size
    const binary = seen.filter((p) => p.totalBytes === size)
    expect(binary.length).toBeGreaterThan(2)
    expect(binary.every((p) => p.phase === 'download')).toBe(true)
    const received = binary.map((p) => p.receivedBytes ?? -1)
    expect(received).toEqual([...received].sort((a, b) => a - b))
    expect(received.at(0)).toBe(0)
    expect(received.at(-1)).toBe(size)
    // Every byte report comes before the outside checks start.
    const verifyAt = seen.findIndex((p) => p.phase === 'verify')
    expect(seen.slice(verifyAt).some((p) => p.receivedBytes !== undefined)).toBe(false)
  })

  it('a cancel mid-download of a first install leaves no ledger row, no folder and no rejection', async () => {
    vendor.publish({ version: '1.0.0', stallAfterBytes: 16 })
    const abort = new AbortController()
    const result = await install({
      signal: abort.signal,
      onProgress: (progress) => {
        if ((progress.receivedBytes ?? 0) > 0) abort.abort()
      },
    })

    expect(result).toEqual({ outcome: 'cancelled', kind: KIND, swept: expect.any(Array) })
    expect(ledger.get(KIND)).toBeUndefined()
    expect(existsSync(join(harnessesDir, KIND))).toBe(false)
    expect(ledger.rejectedReleases(KIND)).toEqual([])
    expect(ledger.installLockHolder()).toBeUndefined()
  })

  it('a cancel before the vendor answers changes nothing and records no failed check', async () => {
    const abort = new AbortController()
    abort.abort()
    expect((await install({ signal: abort.signal })).outcome).toBe('cancelled')
    expect(ledger.get(KIND)).toBeUndefined()
  })

  it.each([
    'install',
    'verify',
    'receipt',
    'rename',
    'publish',
  ] as const satisfies readonly InstallStep[])('a cancel before %s of an update keeps the current release as it was', async (step) => {
    await install()
    const before = ledger.get(KIND)
    vendor.publish({ version: '1.1.0' })
    const abort = new AbortController()
    const result = await install({
      signal: abort.signal,
      beforeStep: (at) => {
        if (at === step) abort.abort()
      },
    })

    expect(result.outcome).toBe('cancelled')
    expect(ledger.get(KIND)).toMatchObject({ current: 1, previous: null })
    expect(ledger.get(KIND)?.lastInstallError).toEqual(before?.lastInstallError)
    expect(ledger.get(KIND)?.failingSince).toBeUndefined()
    expect(ledger.rejectedReleases(KIND)).toEqual([])
    expect(kindEntries()).toEqual(['1-1.0.0'])
    expect(ledger.installLockHolder()).toBeUndefined()
  })

  it('a cancel that comes after the publish is too late: the release is installed', async () => {
    const abort = new AbortController()
    const result = await install({ signal: abort.signal, reprobe: () => abort.abort() })
    expect(result).toMatchObject({ outcome: 'installed', number: 1 })
    expect(ledger.get(KIND)).toMatchObject({ current: 1 })
  })

  it('a retry after a transient failure of the first install installs', async () => {
    vendor.publish({ version: '1.0.0', badChecksum: true })
    expect(await install()).toMatchObject({ outcome: 'failed', rejected: false })
    expect(ledger.get(KIND)).toMatchObject({
      current: null,
      lastInstallError: { version: '1.0.0' },
    })

    vendor.publish({ version: '1.0.0' })
    expect(await install()).toMatchObject({ outcome: 'installed', version: '1.0.0', number: 1 })
    expect(ledger.get(KIND)?.failingSince).toBeUndefined()
  })

  it('a retry never brings a rejected release back; it installs the next one the vendor publishes', async () => {
    vendor.publish({ version: '1.0.0', behaviour: 'exit' })
    expect(await install()).toMatchObject({ outcome: 'failed', rejected: true })
    const fetchesBefore = vendor.requests.filter((path) => path.endsWith('/fake-harness')).length

    const retry = await install()
    expect(retry).toMatchObject({ outcome: 'not-installable', kind: KIND, version: '1.0.0' })
    if (retry.outcome !== 'not-installable') throw new Error('unreachable')
    expect(retry.error).toMatch(/no newer release/)
    expect(ledger.get(KIND)?.lastInstallError?.error).toBe(retry.error)
    expect(ledger.get(KIND)).toMatchObject({ current: null })
    expect(vendor.requests.filter((path) => path.endsWith('/fake-harness'))).toHaveLength(
      fetchesBefore,
    )
    expect(kindEntries()).toEqual([])

    vendor.publish({ version: '1.1.0' })
    expect(await install()).toMatchObject({ outcome: 'installed', version: '1.1.0' })
    expect(ledger.rejectedReleases(KIND).map((row) => row.version)).toEqual(['1.0.0'])
  })
})

describe('housekeeping (§5.5)', () => {
  function release(number: number, version: string): string {
    const dir = join(harnessesDir, KIND, `${number}-${version}`)
    mkdirSync(join(dir, 'bin'), { recursive: true })
    writeFileSync(join(dir, 'bin', 'fake-harness'), '#!/bin/sh\n', { mode: 0o755 })
    writeInstallReceipt(dir, {
      format: 1,
      harness: KIND,
      version,
      executable: 'bin/fake-harness',
      integrity: { kind: 'none', reason: 'test' },
      source: 'https://downloads.fake-harness.invalid/releases',
      installedAt: new Date().toISOString(),
    })
    return dir
  }

  it('keeps current, previous and every release a session names, and deletes everything else', () => {
    ledger.requestInstall(KIND, 'person')
    for (let n = 1; n <= 5; n += 1) release(n, `1.${n}.0`)
    const lock = ledger.acquireInstallLock({ label: 'test', autoRenew: false })
    if (!lock.acquired) throw new Error('no lock')
    ledger.allocateReleaseNumber(KIND, lock.lock)
    ledger.publishRelease(KIND, 2, lock.lock)
    ledger.publishRelease(KIND, 4, lock.lock)
    lock.lock.release()
    ledger.recordSessionInstall({
      sessionId: 'ses_running' as SessionId,
      kind: KIND,
      executable: join(harnessesDir, KIND, '1-1.1.0', 'bin', 'fake-harness'),
      version: '1.1.0',
      provenance: 'managed',
      release: 1,
    })
    ledger.recordSessionInstall({
      sessionId: 'ses_external' as SessionId,
      kind: KIND,
      executable: '/usr/local/bin/claude',
      version: '2.0.0',
      provenance: 'external',
      release: null,
    })
    mkdirSync(join(harnessesDir, KIND, '.staging-0a1b2c', 'home'), { recursive: true })
    writeFileSync(join(harnessesDir, KIND, 'stray.txt'), 'x')
    mkdirSync(join(harnessesDir, KIND, 'not-a-release'))

    const result = housekeepReleases(KIND, { ledger })
    expect(result).toEqual({
      outcome: 'swept',
      removed: ['.staging-0a1b2c', '3-1.3.0', '5-1.5.0', 'not-a-release', 'stray.txt'],
    })
    expect(kindEntries()).toEqual(['1-1.1.0', '2-1.2.0', '4-1.4.0'])
    expect(readdirSync(harnessesDir)).toContain('ledger.db')
  })

  it('does not run while an install holds the lock', () => {
    mkdirSync(join(harnessesDir, KIND, '.staging-busy'), { recursive: true })
    const other = InstallLedger.open({ harnessesDir })
    const held = other.acquireInstallLock({ label: 'daemon', autoRenew: false })
    try {
      expect(housekeepReleases(KIND, { ledger })).toMatchObject({ outcome: 'busy' })
      expect(kindEntries()).toEqual(['.staging-busy'])
    } finally {
      if (held.acquired) held.lock.release()
      other.close()
    }
  })
})

describe('ports: environment and vendor hosts', () => {
  it.each([
    '--version',
    '--about',
  ])('contains %s startup writes and removes probe state before publishing', async (writingProbe) => {
    const machine = {
      ...commandEnv(),
      CODEX_HOME: join(root, 'person-codex'),
      XDG_CONFIG_HOME: join(root, 'person-config'),
      OPENAI_API_KEY: 'foreign-key',
      MACHINE_SENTINEL: 'kept',
    }
    for (const path of [machine.HOME, machine.CODEX_HOME, machine.XDG_CONFIG_HOME]) {
      mkdirSync(path, { recursive: true })
      writeFileSync(join(path, 'sentinel'), 'personal state\n')
    }
    const before = [machine.HOME, machine.CODEX_HOME, machine.XDG_CONFIG_HOME].map(treeDigest)
    const target = fakeTarget()
    let identityOutput = ''
    let staging = ''
    const result = await install({
      commandEnv: machine,
      target: {
        ...target,
        install: {
          latest: target.install.latest,
          async install(release, dir, ports) {
            staging = dir
            const installed = await target.install.install(release, dir, ports)
            writeFileSync(
              join(dir, installed.executable),
              [
                '#!/bin/sh',
                `if [ "$1" = "${writingProbe}" ]; then echo probe-write > "$HOME/probe-side-effect"; fi`,
                'printf "HOME=%s\\nCODEX_HOME=%s\\nXDG_CONFIG_HOME=%s\\nOPENAI_API_KEY=%s\\nMACHINE_SENTINEL=%s\\n" "$HOME" "$CODEX_HOME" "$XDG_CONFIG_HOME" "$OPENAI_API_KEY" "$MACHINE_SENTINEL"',
                'echo "fake-harness 1.0.0"',
                '',
              ].join('\n'),
            )
            return installed
          },
        },
        identityProbe: {
          args: ['--about'],
          accepts(output) {
            identityOutput = output
            return output.includes('fake-harness')
          },
        },
      },
    })
    expect(result.outcome).toBe('installed')
    expect([machine.HOME, machine.CODEX_HOME, machine.XDG_CONFIG_HOME].map(treeDigest)).toEqual(
      before,
    )
    expect(identityOutput).toContain(`HOME=${join(staging, '.probe-home')}\n`)
    expect(identityOutput).toContain('CODEX_HOME=\nXDG_CONFIG_HOME=\nOPENAI_API_KEY=\n')
    expect(identityOutput).toContain('MACHINE_SENTINEL=kept\n')
    if (result.outcome === 'installed') expect(readdirSync(result.dir)).not.toContain('.probe-home')
  })

  it('hands the adapter no foreign credential from any manifest, and nothing from the daemon process', async () => {
    const credentials = Object.values(AGENT_MANIFESTS).flatMap(
      (m) => m.inventory.foreignCredentialEnv,
    )
    expect(credentials.length).toBeGreaterThan(0)
    const machine: Record<string, string> = { ...commandEnv(), MACHINE_ONLY: 'kept' }
    for (const name of credentials) machine[name] = 'secret'
    process.env.PODIUM_DAEMON_ONLY_PROBE = 'daemon'
    const observed: FakeAdapterObservation = {}
    try {
      const result = await install({ commandEnv: machine, target: fakeTarget({ observed }) })
      expect(result.outcome).toBe('installed')
    } finally {
      delete process.env.PODIUM_DAEMON_ONLY_PROBE
    }
    for (const env of [observed.checkEnv, observed.installEnv, observed.installerEnv]) {
      expect(env).toBeDefined()
      for (const name of credentials) expect(env, name).not.toHaveProperty(name)
      expect(env).not.toHaveProperty('PODIUM_DAEMON_ONLY_PROBE')
      expect(env).toHaveProperty('MACHINE_ONLY', 'kept')
    }
    expect(observed.home).toBe(join(observed.dir as string, 'home'))
    expect(observed.installerEnv?.HOME).toBe(observed.home)
    expect(observed.installEnv?.HOME).toBe(machine.HOME)
    expect(managedInstallEnv({ ANTHROPIC_API_KEY: 'x', PATH: '/bin' })).toEqual({ PATH: '/bin' })
  })

  it('points every harness folder variable of the installer at its own home', async () => {
    const observed: FakeAdapterObservation = {}
    const machine = {
      ...commandEnv(),
      CODEX_HOME: '/person/.codex',
      CLAUDE_CONFIG_DIR: '/person/.claude',
      XDG_CONFIG_HOME: '/person/.config',
    }
    await install({ commandEnv: machine, target: fakeTarget({ observed }) })
    expect(observed.installerEnv).not.toHaveProperty('CODEX_HOME')
    expect(observed.installerEnv).not.toHaveProperty('CLAUDE_CONFIG_DIR')
    expect(observed.installerEnv).not.toHaveProperty('XDG_CONFIG_HOME')
    expect(observed.installEnv).toHaveProperty('CODEX_HOME', '/person/.codex')
  })

  it('moves a vendor host by URL prefix, at a path boundary only, longest prefix first', () => {
    const origins = {
      'https://downloads.example.invalid': 'http://127.0.0.1:9000',
      'https://downloads.example.invalid/beta': 'http://127.0.0.1:9001/b',
    }
    expect(applyVendorOrigins('https://downloads.example.invalid/x/y?z', origins)).toBe(
      'http://127.0.0.1:9000/x/y?z',
    )
    expect(applyVendorOrigins('https://downloads.example.invalid/beta/1', origins)).toBe(
      'http://127.0.0.1:9001/b/1',
    )
    expect(applyVendorOrigins('https://downloads.example.invalid.evil/x', origins)).toBe(
      'https://downloads.example.invalid.evil/x',
    )
    expect(applyVendorOrigins('https://other.invalid/x', origins)).toBe('https://other.invalid/x')
  })

  it(`reads the vendor-host map from ${VENDOR_ORIGINS_ENV}, and refuses a malformed one`, () => {
    expect(vendorOriginsFromEnv({})).toEqual({})
    expect(
      vendorOriginsFromEnv({
        [VENDOR_ORIGINS_ENV]: JSON.stringify({ 'https://a.invalid/': 'http://127.0.0.1:1/' }),
      }),
    ).toEqual({ 'https://a.invalid': 'http://127.0.0.1:1' })
    expect(() => vendorOriginsFromEnv({ [VENDOR_ORIGINS_ENV]: 'nope' })).toThrow('not JSON')
    expect(() => vendorOriginsFromEnv({ [VENDOR_ORIGINS_ENV]: '["x"]' })).toThrow('JSON object')
  })

  it('matches the printed version as a whole token', () => {
    expect(printsVersion('2.1.311 (Claude Code)', '2.1.311')).toBe(true)
    expect(printsVersion('codex-cli v0.167.2', '0.167.2')).toBe(true)
    expect(printsVersion('2.1.3110 (Claude Code)', '2.1.311')).toBe(false)
    expect(printsVersion('', '1.0.0')).toBe(false)
  })
})
