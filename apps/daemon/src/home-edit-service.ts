/** Local APIs for the install requests and machine removal. Never used by repo removal. */
import type { HarnessContext, InstrumentationHookFile } from '@podium/harness'
import { type HomeEditRecord, InstallLedger, type StoredHomeEdit } from '@podium/harness/inventory'
import { createLogger } from '@podium/logger'
import { isBuiltinHarnessKind } from '@podium/model'
import {
  type HomeEditUndoOutcome,
  nodeHomeEditPorts,
  recordHookFile,
  undoHomeEdits,
} from './harness-home-edits.js'

const log = createLogger('daemon:home-edits')

/** "Show what Podium changed here", optionally limited to one harness. */
export function listHomeEditRecords(
  harness?: HomeEditRecord['harness'],
  harnessesDir?: string,
): StoredHomeEdit[] {
  const ledger = InstallLedger.open(harnessesDir ? { harnessesDir } : {})
  try {
    return ledger.homeEdits(harness)
  } finally {
    ledger.close()
  }
}

/** "Remove Podium's changes" for one harness, called by the install requests. */
export async function removeHomeEditRecords(
  harness: HomeEditRecord['harness'],
  harnessesDir?: string,
): Promise<HomeEditUndoOutcome[]> {
  return undoRecords(harness, harnessesDir)
}

/** Machine-uninstall hook. Call before removing the instance's state and ledger. */
export async function undoAllHomeEditRecords(): Promise<HomeEditUndoOutcome[]> {
  return undoRecords()
}

async function undoRecords(
  harness?: HomeEditRecord['harness'],
  harnessesDir?: string,
): Promise<HomeEditUndoOutcome[]> {
  const ledger = InstallLedger.open(harnessesDir ? { harnessesDir } : {})
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

/**
 * Record the hook file a terminal instrumentation install keeps Podium's
 * handlers in, when it is in the person's own folder (POD-7388). A file in a
 * Podium home goes with the home. Never throws: a launch does not wait on
 * the ledger, and the next launch records again.
 */
export async function recordInstrumentationHookFile(
  harness: string,
  context: Pick<HarnessContext, 'harnessHome'>,
  hookFile: InstrumentationHookFile | undefined,
  harnessesDir?: string,
): Promise<void> {
  if (!hookFile || context.harnessHome || !isBuiltinHarnessKind(harness)) return
  try {
    const ledger = InstallLedger.open(harnessesDir ? { harnessesDir } : {})
    try {
      await recordHookFile(
        harness,
        hookFile,
        nodeHomeEditPorts((message, fields) => log.info(message, fields)),
        ledger,
      )
    } finally {
      ledger.close()
    }
  } catch (err) {
    log.warn('could not record Podium’s hook file', {
      harness,
      file: hookFile.file,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
