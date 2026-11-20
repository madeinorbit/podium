import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asSessionId } from '@podium/model'
import { openDatabase } from '@podium/runtime/sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { InstallLedger } from './install-ledger'
import { writeInstallReceipt } from './install-receipt'
import { readManagedInstalls } from './managed-installs'
import { finishPendingRemovals, removeManagedInstall } from './managed-remove'

let root: string
let dir: string
const sessionId = asSessionId('running-session')
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'harness-remove-'))
  dir = join(root, 'harnesses')
})
afterEach(() => rmSync(root, { recursive: true, force: true }))
function seed(running: boolean) {
  const release = join(dir, 'codex', '1-0.171.0')
  mkdirSync(release, { recursive: true })
  writeFileSync(join(release, 'codex'), 'binary')
  writeInstallReceipt(release, {
    format: 1,
    harness: 'codex',
    version: '0.171.0',
    executable: 'codex',
    source: 'https://vendor.example/release',
    integrity: { kind: 'none', reason: 'test fixture' },
    installedAt: '2026-11-20T00:00:00Z',
  })
  // Opening rebuilds the current release from the receipt.
  const ledger = InstallLedger.open({ harnessesDir: dir })
  try {
    if (running)
      ledger.recordSessionInstall({
        sessionId,
        kind: 'codex',
        executable: join(release, 'codex'),
        version: '0.171.0',
        provenance: 'managed',
        release: 1,
      })
  } finally {
    ledger.close()
  }
  for (const home of ['podium/codex', 'cred_signin/codex']) {
    const path = join(root, 'homes', home)
    mkdirSync(path, { recursive: true })
    writeFileSync(join(path, 'keep'), 'settings and conversations')
  }
  return release
}

describe('managed removal', () => {
  it('deletes releases and install records, leaving Podium and sign-in homes intact', () => {
    const release = seed(false)
    expect(removeManagedInstall('codex', dir)).toEqual({ outcome: 'removed', pendingSessions: 0 })
    expect(existsSync(release)).toBe(false)
    expect(readManagedInstalls(dir).harnesses.has('codex')).toBe(false)
    expect(existsSync(join(root, 'homes/podium/codex/keep'))).toBe(true)
    expect(existsSync(join(root, 'homes/cred_signin/codex/keep'))).toBe(true)
  })
  it('retains a running release across reopen, refuses new starts, and finishes after the last exit', () => {
    const release = seed(true)
    expect(removeManagedInstall('codex', dir)).toEqual({
      outcome: 'removal-pending',
      pendingSessions: 1,
    })
    expect(existsSync(release)).toBe(true)
    const ledger = InstallLedger.open({ harnessesDir: dir })
    try {
      expect(ledger.get('codex')?.removingAt).toBeDefined()
      expect(() =>
        ledger.recordSessionInstall({
          sessionId: asSessionId('new-session'),
          kind: 'codex',
          executable: join(release, 'codex'),
          version: '0.171.0',
          provenance: 'managed',
          release: 1,
        }),
      ).toThrow('being removed')
      ledger.removeSessionInstall(sessionId)
    } finally {
      ledger.close()
    }
    finishPendingRemovals(dir)
    expect(existsSync(release)).toBe(false)
    expect(readManagedInstalls(dir).harnesses.size).toBe(0)
    const removed = InstallLedger.open({ harnessesDir: dir })
    try {
      expect(() =>
        removed.recordSessionInstall({
          sessionId,
          kind: 'codex',
          executable: join(release, 'codex'),
          version: '0.171.0',
          provenance: 'managed',
          release: 1,
        }),
      ).toThrow('being removed')
    } finally {
      removed.close()
    }
  })
})

it('migrates the first ledger schema without losing an explicit request', () => {
  const ledger = InstallLedger.open({ harnessesDir: dir })
  ledger.requestInstall('codex', 'machine-setup')
  const session = {
    sessionId,
    kind: 'codex' as const,
    executable: '/person/codex',
    version: '0.171.0',
    provenance: 'external' as const,
    release: null,
  }
  ledger.recordSessionInstall(session)
  ledger.recordHomeEdit({
    harness: 'codex',
    file: '/person/.codex/rules/podium.rules',
    edit: { kind: 'owned-file', sha256: 'a'.repeat(64) },
    prior: { absent: true },
    serves: 'podium-cli',
    appliedAt: '2026-11-20T00:00:00Z',
  })
  const edits = ledger.homeEdits('codex')
  const path = ledger.path
  ledger.close()
  const legacy = openDatabase(path)
  try {
    legacy.exec('ALTER TABLE managed_install DROP COLUMN removing_at')
    legacy.exec("UPDATE meta SET value = '1' WHERE key = 'schema_version'")
  } finally {
    legacy.close()
  }
  const upgraded = InstallLedger.open({ harnessesDir: dir })
  try {
    expect(upgraded.get('codex')?.requested.by).toBe('machine-setup')
    expect(upgraded.get('codex')?.removingAt).toBeUndefined()
    expect(upgraded.rebuilt()).toBeUndefined()
    expect(upgraded.sessionInstall(sessionId)).toEqual(session)
    expect(upgraded.homeEdits('codex')).toEqual(edits)
  } finally {
    upgraded.close()
  }
})
