/**
 * THE INVENTORY'S READ OF THE INSTALL LEDGER (POD-7270).
 *
 * docs/design/harness-managed-installs.md §6.1 and §7: "the daemon reads it on
 * every inventory wave, then reads the current folder's receipt for the
 * executable. That is how an install made by the CLI becomes visible without a
 * restart." One read opens the ledger, takes each managed harness's row and
 * the receipts of its current and previous release folders, and closes it
 * again, so nothing is held between waves and a write by the CLI is seen by
 * the next one.
 *
 * A machine Podium never installed on has neither a ledger nor release
 * folders, and the read creates neither: it reports nothing managed.
 */
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { BUILTIN_HARNESS_KINDS } from '@podium/model'
import type {
  ManagedHarnessRecord,
  ManagedInstallsRead,
  ManagedInstallsReader,
  ManagedReleaseCandidate,
} from './build-inventory.js'
import { InstallLedger, type InstallLedgerOptions, LEDGER_FILE } from './install-ledger.js'
import type { ReleaseFolder } from './install-receipt.js'
import { finishPendingRemovals } from './managed-remove.js'

const NOTHING_MANAGED: ManagedInstallsRead = Object.freeze({ harnesses: new Map() })

/**
 * Read what the ledger in `harnessesDir` says is managed. Throws what opening
 * the ledger throws (a newer schema, permissions); the inventory treats that
 * as nothing managed for the wave.
 */
export function readManagedInstalls(
  harnessesDir: string,
  options: Omit<InstallLedgerOptions, 'harnessesDir'> = {},
): ManagedInstallsRead {
  if (!holdsAnything(harnessesDir)) return NOTHING_MANAGED
  finishPendingRemovals(harnessesDir)
  const ledger = InstallLedger.open({ ...options, harnessesDir })
  try {
    const harnesses = new Map<ManagedHarnessRecord['kind'], ManagedHarnessRecord>()
    const holder = ledger.installLockHolder()
    for (const row of ledger.list()) {
      const current = row.current == null ? undefined : ledger.releaseFolder(row.kind, row.current)
      const previous =
        row.previous == null ? undefined : ledger.releaseFolder(row.kind, row.previous)
      const currentCandidate = candidate(current)
      const previousCandidate = candidate(previous)
      const record: ManagedHarnessRecord = {
        kind: row.kind,
        ...(currentCandidate ? { current: currentCandidate } : {}),
        ...(previousCandidate ? { previous: previousCandidate } : {}),
        ...(row.current != null && !currentCandidate
          ? {
              currentMissing: {
                release: row.current,
                ...(current?.version ? { version: current.version } : {}),
              },
            }
          : {}),
        paused: row.paused,
        ...(row.vendorUpdated ? { vendorUpdated: true } : {}),
        ...(!row.removingAt &&
        holder &&
        (holder.label.startsWith(`install ${row.kind}`) ||
          holder.label.startsWith(`update ${row.kind}`))
          ? { installing: { ...(row.lastCheck?.ok ? { version: row.lastCheck.latest } : {}) } }
          : {}),
        ...(row.removingAt ? { removingAt: row.removingAt } : {}),
        ...(row.lastCheck ? { lastCheck: row.lastCheck } : {}),
        ...(row.lastInstallError ? { lastInstallError: row.lastInstallError } : {}),
        ...(row.failingSince ? { failingSince: row.failingSince } : {}),
      }
      harnesses.set(row.kind, Object.freeze(record))
    }
    const rebuilt = ledger.rebuilt()
    return Object.freeze({
      harnesses,
      ...(rebuilt ? { rebuilt: { at: rebuilt.at, reason: rebuilt.reason } } : {}),
    })
  } finally {
    ledger.close()
  }
}

/** A reader over one harnesses folder, for {@link BuildInventoryOptions.managedInstalls}. */
export function managedInstallsReader(harnessesDir: string): ManagedInstallsReader {
  return () => readManagedInstalls(harnessesDir)
}

function candidate(folder: ReleaseFolder | undefined): ManagedReleaseCandidate | undefined {
  if (!folder?.receipt) return undefined
  return Object.freeze({
    release: folder.number,
    version: folder.receipt.version,
    executable: join(folder.dir, folder.receipt.executable),
    ...(folder.receipt.updater === 'cannot-stop' ? { vendorUpdated: true } : {}),
  })
}

/**
 * Whether there is a ledger or a harness's release folder to read. Opening
 * the ledger creates it, and a missing one with folders beside it is rebuilt
 * from them; with neither there is nothing Podium installed here.
 */
function holdsAnything(harnessesDir: string): boolean {
  if (existsSync(join(harnessesDir, LEDGER_FILE))) return true
  let names: string[]
  try {
    names = readdirSync(harnessesDir)
  } catch {
    return false
  }
  return names.some((name) => (BUILTIN_HARNESS_KINDS as readonly string[]).includes(name))
}
