/**
 * The install ledger (POD-7268, design §7): publishing moves current and
 * previous together under the install lock; the lock is a lease row two
 * programs share; a lost or damaged database is rebuilt from the release
 * folders; a newer schema is refused untouched.
 */
import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { SessionId } from '@podium/model'
import { openDatabase } from '@podium/runtime/sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  INSTALL_LEDGER_SCHEMA_VERSION,
  InstallLedger,
  type InstallLedgerOptions,
  InstallLedgerTooNewError,
  type InstallLock,
  InstallLockLostError,
} from './install-ledger'
import { type InstallReceipt, releaseFolderName, writeInstallReceipt } from './install-receipt'

let root: string
let harnessesDir: string
let clock: number
const open: InstallLedger[] = []

function openLedger(options: Partial<InstallLedgerOptions> = {}): InstallLedger {
  const ledger = InstallLedger.open({
    harnessesDir,
    now: () => new Date(clock),
    pid: 4242,
    hostname: 'box',
    isProcessAlive: () => true,
    ...options,
  })
  open.push(ledger)
  return ledger
}

function lockOf(ledger: InstallLedger, label = 'test'): InstallLock {
  const result = ledger.acquireInstallLock({ label, autoRenew: false })
  if (!result.acquired) throw new Error('lock not acquired')
  return result.lock
}

function receipt(kind: InstallReceipt['harness'], version: string): InstallReceipt {
  return {
    format: 1,
    harness: kind,
    version,
    executable: 'bin/tool',
    integrity: { kind: 'sha256', digest: 'a'.repeat(64), publishedAt: '2026-11-01T00:00:00.000Z' },
    source: `https://downloads.example.com/${kind}/${version}/tool`,
    installedAt: '2026-11-02T00:00:00.000Z',
  }
}

/** Make a published release folder on disk, as the install mechanism would. */
function makeRelease(
  kind: InstallReceipt['harness'],
  number: number,
  version: string,
  valid = true,
): string {
  const dir = join(harnessesDir, kind, releaseFolderName(number, version))
  mkdirSync(join(dir, 'bin'), { recursive: true })
  writeFileSync(join(dir, 'bin', 'tool'), '#!/bin/sh\n')
  if (valid) writeInstallReceipt(dir, receipt(kind, version))
  return dir
}

/** Allocate a number, put the release folder in place, publish it: the install mechanism's steps 5 and 6. */
function installNew(
  ledger: InstallLedger,
  kind: InstallReceipt['harness'],
  version: string,
  lock: InstallLock,
) {
  const number = ledger.allocateReleaseNumber(kind, lock)
  makeRelease(kind, number, version)
  return ledger.publishRelease(kind, number, lock)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'install-ledger-'))
  harnessesDir = join(root, 'harnesses')
  clock = Date.parse('2026-11-20T12:00:00.000Z')
})

afterEach(() => {
  for (const ledger of open.splice(0)) {
    try {
      ledger.close()
    } catch {}
  }
  rmSync(root, { recursive: true, force: true })
})

describe('a fresh ledger', () => {
  it('creates ledger.db under harnesses/, records its schema and is not marked rebuilt', () => {
    const ledger = openLedger()
    expect(ledger.path).toBe(join(harnessesDir, 'ledger.db'))
    expect(existsSync(ledger.path)).toBe(true)
    expect(ledger.list()).toEqual([])
    expect(ledger.rebuilt()).toBeUndefined()
    ledger.close()
    open.length = 0
    const db = openDatabase(join(harnessesDir, 'ledger.db'))
    expect(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({
      value: String(INSTALL_LEDGER_SCHEMA_VERSION),
    })
    db.close()
  })

  it('lives in the state folder of its own instance, so two instances never share one', () => {
    const saved = process.env.PODIUM_STATE_DIR
    try {
      process.env.PODIUM_STATE_DIR = join(root, 'instance-a')
      const a = InstallLedger.open()
      open.push(a)
      process.env.PODIUM_STATE_DIR = join(root, 'instance-b')
      const b = InstallLedger.open()
      open.push(b)
      expect(a.path).toBe(join(root, 'instance-a', 'harnesses', 'ledger.db'))
      expect(b.path).toBe(join(root, 'instance-b', 'harnesses', 'ledger.db'))
      a.requestInstall('codex', 'person')
      expect(b.get('codex')).toBeUndefined()
      expect(a.acquireInstallLock({ label: 'a', autoRenew: false }).acquired).toBe(true)
      expect(b.acquireInstallLock({ label: 'b', autoRenew: false }).acquired).toBe(true)
    } finally {
      if (saved === undefined) delete process.env.PODIUM_STATE_DIR
      else process.env.PODIUM_STATE_DIR = saved
    }
  })

  it('keeps its rows across a reopen', () => {
    const first = openLedger()
    first.requestInstall('codex', 'machine-setup')
    first.close()
    open.length = 0
    expect(openLedger().get('codex')).toMatchObject({ kind: 'codex', current: null, nextNumber: 1 })
  })
})

describe('managed installs', () => {
  it('moves update ownership with the current release, including going back', () => {
    const ledger = openLedger()
    ledger.requestInstall('cursor', 'person')
    const lock = lockOf(ledger)
    const number = ledger.allocateReleaseNumber('cursor', lock)
    const dir = makeRelease('cursor', number, '2026.11.19-f005e9d')
    writeInstallReceipt(dir, { ...receipt('cursor', '2026.11.19-f005e9d'), updater: 'cannot-stop' })
    expect(ledger.publishRelease('cursor', number, lock).vendorUpdated).toBe(true)
    expect(installNew(ledger, 'cursor', '2026.11.20-f005e9d', lock).vendorUpdated).toBe(false)
    expect(ledger.revertToPrevious('cursor', lock, 'test').row.vendorUpdated).toBe(true)
  })

  it('requestInstall creates the row once and keeps the first request', () => {
    const ledger = openLedger()
    const row = ledger.requestInstall('claude-code', 'machine-setup')
    expect(row).toEqual({
      kind: 'claude-code',
      nextNumber: 1,
      current: null,
      previous: null,
      paused: false,
      vendorUpdated: false,
      requested: { by: 'machine-setup', at: '2026-11-20T12:00:00.000Z' },
    })
    clock += 1000
    expect(ledger.requestInstall('claude-code', 'person').requested.by).toBe('machine-setup')
  })

  it('publishing moves current to previous and the new release to current', () => {
    const ledger = openLedger()
    ledger.requestInstall('claude-code', 'person')
    const lock = lockOf(ledger)
    expect(installNew(ledger, 'claude-code', '2.1.300', lock)).toMatchObject({
      current: 1,
      previous: null,
    })
    expect(installNew(ledger, 'claude-code', '2.1.311', lock)).toMatchObject({
      current: 2,
      previous: 1,
    })
    expect(installNew(ledger, 'claude-code', '2.1.318', lock)).toMatchObject({
      current: 3,
      previous: 2,
      nextNumber: 4,
    })
    expect(ledger.currentRelease('claude-code')?.receipt?.version).toBe('2.1.318')
  })

  it('a publish that fails inside its transaction leaves the earlier current and previous', () => {
    const ledger = openLedger()
    ledger.requestInstall('codex', 'person')
    const lock = lockOf(ledger)
    installNew(ledger, 'codex', '0.166.0', lock)
    installNew(ledger, 'codex', '0.167.0', lock)
    // Make the publishing UPDATE itself fail, after it has run, from a second connection.
    const other = openDatabase(join(harnessesDir, 'ledger.db'))
    other.exec(
      `CREATE TRIGGER fail_publish AFTER UPDATE OF current ON managed_install
       BEGIN SELECT RAISE(ABORT, 'disk gave out'); END`,
    )
    other.close()
    const number = ledger.allocateReleaseNumber('codex', lock)
    makeRelease('codex', number, '0.167.2')
    expect(() => ledger.publishRelease('codex', number, lock)).toThrow('disk gave out')
    expect(ledger.get('codex')).toMatchObject({ current: 2, previous: 1 })
  })

  it('refuses to publish a number whose folder is missing or has no valid receipt', () => {
    const ledger = openLedger()
    ledger.requestInstall('codex', 'person')
    const lock = lockOf(ledger)
    const missing = ledger.allocateReleaseNumber('codex', lock)
    expect(() => ledger.publishRelease('codex', missing, lock)).toThrow('no such folder')
    const unsigned = ledger.allocateReleaseNumber('codex', lock)
    makeRelease('codex', unsigned, '0.167.2', false)
    expect(() => ledger.publishRelease('codex', unsigned, lock)).toThrow('no readable receipt.json')
    expect(ledger.get('codex')?.current).toBeNull()
  })

  it('refuses to publish a number that was never allocated or is already current', () => {
    const ledger = openLedger()
    ledger.requestInstall('codex', 'person')
    const lock = lockOf(ledger)
    expect(() => ledger.publishRelease('codex', 1, lock)).toThrow('never allocated')
    installNew(ledger, 'codex', '0.167.2', lock)
    expect(() => ledger.publishRelease('codex', 1, lock)).toThrow('already current')
  })

  it('never allocates a number a folder on disk already has', () => {
    makeRelease('codex', 7, '0.160.0', false)
    const ledger = openLedger()
    ledger.requestInstall('codex', 'person')
    expect(ledger.allocateReleaseNumber('codex', lockOf(ledger))).toBe(8)
  })

  it('refuses publishing for a harness it does not manage', () => {
    const ledger = openLedger()
    const lock = lockOf(ledger)
    expect(() => ledger.allocateReleaseNumber('grok', lock)).toThrow('not a managed install')
  })

  it('refuses to publish once the lock was taken over, and moves nothing', () => {
    const daemon = openLedger({ pid: 1 })
    daemon.requestInstall('claude-code', 'person')
    const lock = lockOf(daemon, 'daemon')
    const number = daemon.allocateReleaseNumber('claude-code', lock)
    clock += 120_000 // the lease ran out
    const cli = openLedger({ pid: 2 })
    const taken = cli.acquireInstallLock({ label: 'cli', autoRenew: false })
    expect(taken).toMatchObject({
      acquired: true,
      tookOver: { because: 'expired', from: { pid: 1 } },
    })
    expect(() => daemon.publishRelease('claude-code', number, lock)).toThrow(InstallLockLostError)
    expect(daemon.get('claude-code')?.current).toBeNull()
    expect(lock.renew()).toBe(false)
    expect(lock.held()).toBe(false)
  })

  it('pausing is recorded', () => {
    const ledger = openLedger()
    ledger.requestInstall('grok', 'person')
    ledger.setPaused('grok', true)
    expect(ledger.get('grok')?.paused).toBe(true)
    ledger.setPaused('grok', false)
    expect(ledger.get('grok')?.paused).toBe(false)
  })

  it('failingSince opens at the first failure, survives later failures and closes on success', () => {
    const ledger = openLedger()
    ledger.requestInstall('codex', 'person')
    ledger.recordCheck('codex', { ok: false, error: 'vendor unreachable' })
    const opened = '2026-11-20T12:00:00.000Z'
    expect(ledger.get('codex')).toMatchObject({
      failingSince: opened,
      lastCheck: { at: opened, ok: false, error: 'vendor unreachable' },
    })

    clock += 6 * 3_600_000
    ledger.recordCheck('codex', { ok: true, latest: '0.167.2', nothingToInstall: false })
    ledger.recordInstallFailure('codex', { version: '0.167.2', error: 'checksum mismatch' })
    const later = ledger.get('codex')
    expect(later?.failingSince).toBe(opened)
    expect(later?.lastCheck).toEqual({
      at: '2026-11-20T18:00:00.000Z',
      ok: true,
      latest: '0.167.2',
    })
    expect(later?.lastInstallError).toEqual({
      at: '2026-11-20T18:00:00.000Z',
      version: '0.167.2',
      error: 'checksum mismatch',
    })

    const lock = lockOf(ledger)
    installNew(ledger, 'codex', '0.167.2', lock)
    const published = ledger.get('codex')
    expect(published?.failingSince).toBeUndefined()
    expect(published?.lastInstallError).toBeUndefined()

    ledger.recordInstallFailure('codex', { version: '0.168.0', error: 'disk full' })
    expect(ledger.get('codex')?.failingSince).toBe('2026-11-20T18:00:00.000Z')
    ledger.recordCheck('codex', { ok: true, latest: '0.167.2', nothingToInstall: true })
    expect(ledger.get('codex')?.failingSince).toBeUndefined()
  })
})

describe('the install lock', () => {
  it('admits one owner at a time across two programs on the same file', () => {
    const daemon = openLedger({ pid: 100 })
    const cli = openLedger({ pid: 200 })
    const held = daemon.acquireInstallLock({ label: 'daemon', autoRenew: false })
    expect(held.acquired).toBe(true)
    const refused = cli.acquireInstallLock({ label: 'podium machine setup', autoRenew: false })
    expect(refused).toMatchObject({
      acquired: false,
      holder: { pid: 100, label: 'daemon', hostname: 'box' },
    })
    expect(cli.installLockHolder()).toMatchObject({ pid: 100 })
    if (held.acquired) held.lock.release()
    expect(cli.installLockHolder()).toBeUndefined()
    expect(
      cli.acquireInstallLock({ label: 'podium machine setup', autoRenew: false }).acquired,
    ).toBe(true)
  })

  it('renewal keeps the lease past its first expiry', () => {
    const daemon = openLedger({ pid: 100 })
    const cli = openLedger({ pid: 200 })
    const lock = lockOf(daemon)
    for (let step = 0; step < 5; step++) {
      clock += 30_000
      expect(lock.renew()).toBe(true)
    }
    expect(cli.acquireInstallLock({ label: 'cli', autoRenew: false }).acquired).toBe(false)
    expect(lock.held()).toBe(true)
  })

  it('renews on its own timer while held', async () => {
    clock = Date.now()
    const ledger = openLedger({ now: () => new Date() })
    const result = ledger.acquireInstallLock({ label: 'daemon', leaseMs: 300 })
    if (!result.acquired) throw new Error('not acquired')
    const firstExpiry = result.lock.holder.expiresAtMs
    await new Promise((resolve) => setTimeout(resolve, 450))
    expect(result.lock.held()).toBe(true)
    expect(result.lock.holder.expiresAtMs).toBeGreaterThan(firstExpiry)
    result.lock.release()
  })

  it('is taken over when its owner process on this host is gone', () => {
    const exited = spawnSync(process.execPath, ['-e', '0'])
    const deadPid = exited.pid as number
    const crashed = openLedger({ pid: deadPid, isProcessAlive: undefined })
    lockOf(crashed, 'crashed installer')
    const cli = openLedger({ pid: process.pid, isProcessAlive: undefined })
    const result = cli.acquireInstallLock({ label: 'cli', autoRenew: false })
    expect(result).toMatchObject({
      acquired: true,
      tookOver: { because: 'owner-gone', from: { pid: deadPid } },
    })
  })

  it('refuses a second process while the holder lives, takes over once it is killed, and leaves no lock file', async () => {
    mkdirSync(harnessesDir, { recursive: true })
    const script = join(root, 'hold-lock.mjs')
    writeFileSync(
      script,
      `import { InstallLedger } from ${JSON.stringify(resolve(import.meta.dirname, 'install-ledger.ts'))}
const ledger = InstallLedger.open({ harnessesDir: process.argv[2] })
const result = ledger.acquireInstallLock({ label: 'child installer' })
console.log(JSON.stringify({ acquired: result.acquired }))
setInterval(() => {}, 1000)
`,
    )
    const child: ChildProcess = spawn(
      process.execPath,
      ['--conditions=@podium/source', script, harnessesDir],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
    try {
      const line = await new Promise<string>((done, fail) => {
        let out = ''
        let err = ''
        child.stdout?.on('data', (chunk) => {
          out += String(chunk)
          if (out.includes('\n')) done(out.trim())
        })
        child.stderr?.on('data', (chunk) => {
          err += String(chunk)
        })
        child.on('exit', (code) => fail(new Error(`child exited ${code}: ${err}`)))
      })
      expect(JSON.parse(line)).toEqual({ acquired: true })

      clock = Date.now()
      const parent = openLedger({
        pid: process.pid,
        isProcessAlive: undefined,
        hostname: undefined,
        now: undefined,
      })
      const refused = parent.acquireInstallLock({ label: 'parent', autoRenew: false })
      expect(refused).toMatchObject({
        acquired: false,
        holder: { pid: child.pid, label: 'child installer' },
      })

      const exited = new Promise((done) => child.once('exit', done))
      child.kill('SIGKILL')
      await exited
      const taken = parent.acquireInstallLock({ label: 'parent', autoRenew: false })
      expect(taken).toMatchObject({
        acquired: true,
        tookOver: { because: 'owner-gone', from: { pid: child.pid } },
      })
      const files = readdirSync(harnessesDir).filter((name) => !name.startsWith('ledger.db'))
      expect(files).toEqual([])
    } finally {
      child.kill('SIGKILL')
    }
  }, 30_000)

  it('is not taken over from a live owner on another host before expiry', () => {
    const other = openLedger({ pid: 1, hostname: 'elsewhere' })
    lockOf(other)
    const here = openLedger({ pid: 2, isProcessAlive: () => false })
    expect(here.acquireInstallLock({ label: 'cli', autoRenew: false }).acquired).toBe(false)
  })

  it('refuses a second lease to the same process', () => {
    const ledger = openLedger()
    lockOf(ledger)
    expect(ledger.acquireInstallLock({ label: 'again', autoRenew: false }).acquired).toBe(false)
  })

  it('is released when the ledger closes', () => {
    const daemon = openLedger({ pid: 1 })
    lockOf(daemon)
    daemon.close()
    open.splice(open.indexOf(daemon), 1)
    expect(openLedger({ pid: 2 }).installLockHolder()).toBeUndefined()
  })
})

describe('rejected releases, sessions and home edits', () => {
  it('records rejected versions per harness', () => {
    const ledger = openLedger()
    ledger.rejectRelease('codex', '0.168.0', 'prints 0.167.9 for --version')
    expect(ledger.isRejected('codex', '0.168.0')).toBe(true)
    expect(ledger.isRejected('claude-code', '0.168.0')).toBe(false)
    expect(ledger.rejectedReleases('codex')).toEqual([
      {
        kind: 'codex',
        version: '0.168.0',
        reason: 'prints 0.167.9 for --version',
        at: '2026-11-20T12:00:00.000Z',
      },
    ])
  })

  it('records and removes the install each running session uses', () => {
    const ledger = openLedger()
    ledger.requestInstall('claude-code', 'person')
    const sessionId = 'ses_1' as SessionId
    ledger.recordSessionInstall({
      sessionId,
      kind: 'claude-code',
      executable: join(harnessesDir, 'claude-code', '7-2.1.311', 'claude'),
      version: '2.1.311',
      provenance: 'managed',
      release: 7,
    })
    ledger.recordSessionInstall({
      sessionId: 'ses_2' as SessionId,
      kind: 'codex',
      executable: '/usr/local/bin/codex',
      version: '0.167.2',
      provenance: 'external',
      release: null,
    })
    expect(ledger.sessionInstall(sessionId)).toMatchObject({ provenance: 'managed', release: 7 })
    expect(ledger.sessionInstalls('codex')).toHaveLength(1)
    ledger.removeSessionInstall(sessionId)
    expect(ledger.sessionInstall(sessionId)).toBeUndefined()
    expect(ledger.sessionInstalls()).toHaveLength(1)
  })

  it('drops every session row not in the live set', () => {
    const ledger = openLedger()
    for (const id of ['ses_a', 'ses_b', 'ses_c']) {
      ledger.recordSessionInstall({
        sessionId: id as SessionId,
        kind: 'codex',
        executable: '/usr/local/bin/codex',
        version: '0.167.2',
        provenance: 'external',
        release: null,
      })
    }
    expect(ledger.retainSessionInstalls(['ses_b' as SessionId, 'ses_gone' as SessionId])).toEqual([
      'ses_a',
      'ses_c',
    ])
    expect(ledger.sessionInstalls().map((row) => row.sessionId)).toEqual(['ses_b'])
    expect(ledger.retainSessionInstalls([])).toEqual(['ses_b'])
  })

  it('keeps the value from before the first write when the same edit is recorded again', () => {
    const ledger = openLedger()
    const file = join(root, 'claude.json')
    const first = ledger.recordHomeEdit({
      harness: 'claude-code',
      file,
      edit: {
        kind: 'json-key',
        path: ['projects', '/repo', 'hasTrustDialogAccepted'],
        value: true,
      },
      prior: { absent: true },
      serves: 'workspace-trust',
      appliedAt: '2026-11-20T12:00:00.000Z',
    })
    const second = ledger.recordHomeEdit({
      harness: 'claude-code',
      file,
      edit: {
        kind: 'json-key',
        path: ['projects', '/repo', 'hasTrustDialogAccepted'],
        value: true,
      },
      prior: { value: true },
      serves: 'workspace-trust',
      appliedAt: '2026-11-21T12:00:00.000Z',
    })
    expect(second.id).toBe(first.id)
    expect(second.prior).toEqual({ absent: true })
    expect(second.appliedAt).toBe('2026-11-21T12:00:00.000Z')
    ledger.recordHomeEdit({
      harness: 'codex',
      file: join(root, 'rules', 'podium.rules'),
      edit: { kind: 'owned-file', sha256: 'b'.repeat(64) },
      prior: { absent: true },
      serves: 'podium-cli',
      appliedAt: '2026-11-20T12:00:00.000Z',
    })
    expect(ledger.homeEdits()).toHaveLength(2)
    expect(ledger.homeEdits('claude-code')).toHaveLength(1)
    ledger.removeHomeEdit(first.id)
    expect(ledger.homeEdits('claude-code')).toEqual([])
  })
})

describe('rebuilding from the release folders', () => {
  it('a missing database is rebuilt: highest valid receipt is current, the next valid one previous', () => {
    makeRelease('claude-code', 5, '2.1.300')
    makeRelease('claude-code', 7, '2.1.311')
    makeRelease('claude-code', 8, '2.1.318', false) // crashed before its receipt
    makeRelease('codex', 3, '0.167.2')
    mkdirSync(join(harnessesDir, 'claude-code', '.staging-4f2a'))
    const ledger = openLedger()
    expect(ledger.get('claude-code')).toMatchObject({
      current: 7,
      previous: 5,
      nextNumber: 9,
      requested: { by: 'ledger-rebuild', at: '2026-11-02T00:00:00.000Z' },
    })
    expect(ledger.get('codex')).toMatchObject({ current: 3, previous: null, nextNumber: 4 })
    expect(ledger.currentRelease('claude-code')?.receipt?.version).toBe('2.1.311')
    expect(ledger.rebuilt()).toEqual({
      at: '2026-11-20T12:00:00.000Z',
      reason: 'missing',
      restored: ['claude-code', 'codex'],
    })
  })

  it('the rebuilt flag survives a reopen until the machine has reported it', () => {
    makeRelease('codex', 1, '0.167.2')
    openLedger().close()
    open.length = 0
    const reopened = openLedger()
    expect(reopened.rebuilt()?.reason).toBe('missing')
    reopened.clearRebuilt()
    expect(reopened.rebuilt()).toBeUndefined()
  })

  it('skips a receipt that names another version, another harness or a missing executable', () => {
    makeRelease('codex', 1, '0.160.0')
    const wrongVersion = makeRelease('codex', 2, '0.161.0', false)
    writeInstallReceipt(wrongVersion, receipt('codex', '0.999.0'))
    const wrongHarness = makeRelease('codex', 3, '0.162.0', false)
    writeInstallReceipt(wrongHarness, receipt('grok', '0.162.0'))
    const noBinary = makeRelease('codex', 4, '0.163.0')
    rmSync(join(noBinary, 'bin', 'tool'))
    expect(openLedger().get('codex')).toMatchObject({ current: 1, previous: null, nextNumber: 5 })
  })

  it('a damaged database is set aside and rebuilt, and its stale WAL is not replayed', () => {
    makeRelease('grok', 2, '1.0.0')
    mkdirSync(harnessesDir, { recursive: true })
    const path = join(harnessesDir, 'ledger.db')
    writeFileSync(
      path,
      'this is not a sqlite database, it was overwritten by something else entirely',
    )
    writeFileSync(`${path}-wal`, 'stale wal')
    const ledger = openLedger()
    const rebuild = ledger.rebuilt()
    expect(rebuild).toMatchObject({ reason: 'damaged', restored: ['grok'] })
    expect(rebuild?.setAside).toBe(`${path}.damaged-2026-11-20T12-00-00-000Z`)
    expect(readFileSync(rebuild?.setAside as string, 'utf8')).toContain('not a sqlite database')
    // The stale WAL never reaches the new file: SQLite drops it on opening the damaged one,
    // and anything left beside it is moved with it.
    const besideNew = existsSync(`${path}-wal`) ? readFileSync(`${path}-wal`, 'utf8') : ''
    expect(besideNew).not.toContain('stale wal')
    expect(ledger.get('grok')).toMatchObject({ current: 2 })
  })

  it.each([
    2,
    INSTALL_LEDGER_SCHEMA_VERSION,
  ])('a schema %s database with its tables gone is damaged, not silently reinitialized over', (version) => {
    openLedger().close()
    open.length = 0
    const db = openDatabase(join(harnessesDir, 'ledger.db'))
    db.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(String(version))
    db.exec('DROP TABLE managed_install')
    db.close()
    const ledger = openLedger()
    expect(ledger.rebuilt()).toMatchObject({
      reason: 'damaged',
      detail: 'tables missing: managed_install',
    })
    expect(readdirSync(harnessesDir).some((name) => name.startsWith('ledger.db.damaged-'))).toBe(
      true,
    )
  })

  it('with no database and no release folders, nothing is marked rebuilt', () => {
    mkdirSync(join(harnessesDir, 'codex', '.staging-1'), { recursive: true })
    expect(openLedger().rebuilt()).toBeUndefined()
  })
})

describe('schema version', () => {
  it.each([1, 2])('migrates schema %s without changing existing install state', (version) => {
    const original = openLedger()
    original.requestInstall('cursor', 'person')
    original.setPaused('cursor', true)
    const lock = lockOf(original)
    const published = installNew(original, 'cursor', '2026.11.19-f005e9d', lock)
    lock.release()
    original.close()
    open.length = 0
    const db = openDatabase(join(harnessesDir, 'ledger.db'))
    db.exec('ALTER TABLE managed_install DROP COLUMN vendor_updated')
    if (version === 1) db.exec('ALTER TABLE managed_install DROP COLUMN removing_at')
    db.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(String(version))
    db.close()
    expect(openLedger().get('cursor')).toEqual(published)
  })

  it('refuses a database from a newer version and leaves the file as it was', () => {
    openLedger().close()
    open.length = 0
    const path = join(harnessesDir, 'ledger.db')
    const db = openDatabase(path)
    db.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(
      String(INSTALL_LEDGER_SCHEMA_VERSION + 1),
    )
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    db.exec('PRAGMA journal_mode = DELETE')
    db.close()
    const before = readFileSync(path)
    expect(() => openLedger()).toThrow(InstallLedgerTooNewError)
    expect(() => openLedger()).toThrow(
      new RegExp(
        `newer version of Podium .*schema ${INSTALL_LEDGER_SCHEMA_VERSION + 1}; this build reads up to ${INSTALL_LEDGER_SCHEMA_VERSION}`,
      ),
    )
    expect(readFileSync(path).equals(before)).toBe(true)
    expect(readdirSync(harnessesDir).filter((name) => name.startsWith('ledger.db'))).toEqual([
      'ledger.db',
    ])
  })
})
