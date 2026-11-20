/** Local APIs for the install requests and machine removal. Never used by repo removal. */
import { type HomeEditRecord, InstallLedger, type StoredHomeEdit } from '@podium/harness/inventory'
import { createLogger } from '@podium/logger'
import { type HomeEditUndoOutcome, nodeHomeEditPorts, undoHomeEdits } from './harness-home-edits.js'

const log = createLogger('daemon:home-edits')

/** "Show what Podium changed here", optionally limited to one harness. */
export function listHomeEditRecords(harness?: HomeEditRecord['harness']): StoredHomeEdit[] {
  const ledger = InstallLedger.open()
  try {
    return ledger.homeEdits(harness)
  } finally {
    ledger.close()
  }
}

/** "Remove Podium's changes" for one harness, called by the install requests. */
export async function removeHomeEditRecords(
  harness: HomeEditRecord['harness'],
): Promise<HomeEditUndoOutcome[]> {
  return undoRecords(harness)
}

/** Machine-uninstall hook. Call before removing the instance's state and ledger. */
export async function undoAllHomeEditRecords(): Promise<HomeEditUndoOutcome[]> {
  return undoRecords()
}

async function undoRecords(harness?: HomeEditRecord['harness']): Promise<HomeEditUndoOutcome[]> {
  const ledger = InstallLedger.open()
  try {
    return await undoHomeEdits(
      ledger,
      nodeHomeEditPorts((message, fields) => log.info(message, fields)),
      harness,
    )
  } finally {
    ledger.close()
  }
}
