/** Removing binaries never removes a home or a vendor sign-in. */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { BuiltinHarnessKind } from '@podium/model'
import {
  defaultHarnessesDir,
  InstallLedger,
  type InstallLock,
  LEDGER_FILE,
} from './install-ledger.js'
import { sweepReleaseFolders } from './managed-install.js'

export interface RemoveManagedResult {
  outcome: 'removed' | 'removal-pending' | 'not-managed' | 'busy'
  pendingSessions: number
}

function finish(
  ledger: InstallLedger,
  kind: BuiltinHarnessKind,
  lock: InstallLock,
): RemoveManagedResult {
  const pendingSessions = ledger
    .sessionInstalls(kind)
    .filter((row) => row.provenance === 'managed').length
  sweepReleaseFolders(ledger, kind, lock)
  if (pendingSessions) return { outcome: 'removal-pending', pendingSessions }
  ledger.finishRemoval(kind, lock)
  return { outcome: 'removed', pendingSessions: 0 }
}

export function removeManagedInstall(
  kind: BuiltinHarnessKind,
  harnessesDir = defaultHarnessesDir(),
): RemoveManagedResult {
  if (!existsSync(join(harnessesDir, LEDGER_FILE)))
    return { outcome: 'not-managed', pendingSessions: 0 }
  const ledger = InstallLedger.open({ harnessesDir })
  try {
    if (!ledger.get(kind)) return { outcome: 'not-managed', pendingSessions: 0 }
    const acquired = ledger.acquireInstallLock({ label: `remove ${kind}` })
    if (!acquired.acquired) return { outcome: 'busy', pendingSessions: 0 }
    try {
      ledger.requestRemoval(kind, acquired.lock)
      return finish(ledger, kind, acquired.lock)
    } finally {
      acquired.lock.release()
    }
  } finally {
    ledger.close()
  }
}

/** Retried after a process exits and on inventory waves, including after daemon restart. */
export function finishPendingRemovals(harnessesDir = defaultHarnessesDir()): void {
  if (!existsSync(join(harnessesDir, LEDGER_FILE))) return
  const ledger = InstallLedger.open({ harnessesDir })
  try {
    const pending = ledger.list().filter((row) => row.removingAt)
    if (!pending.length) return
    const acquired = ledger.acquireInstallLock({ label: 'finish harness removals' })
    if (!acquired.acquired) return
    try {
      for (const row of pending) finish(ledger, row.kind, acquired.lock)
    } finally {
      acquired.lock.release()
    }
  } finally {
    ledger.close()
  }
}
