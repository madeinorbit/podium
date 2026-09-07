import { createLogger } from '@podium/logger'
import type { UpdateChannel } from '@podium/model'
import { isTerminalOperationState, type UpdateTarget } from '@podium/protocol'
import type { OperationRow } from '../operations/store'
import type { UpdateReconciler } from './reconciler'
import type { UpdatesService } from './service'

const log = createLogger('server:updates')

/** Only state transitions carry lifecycle effects; ordinary row writes still announce. */
export function updateOperationObserver(
  updatesService: UpdatesService,
  reconciler: () => UpdateReconciler | undefined,
) {
  return async (row: OperationRow, previousState: string | undefined): Promise<void> => {
    if (row.kind !== 'update' || previousState === row.state) return
    if (!isTerminalOperationState(row.state)) {
      // An operation is live, so whatever background convergence did before
      // it started is that operation's story to tell now (§3.6).
      reconciler()?.onOperationStarted()
      return
    }
    // THE CONSENT DIES WITH THE OPERATION THAT HELD IT (POD-2169, §3.2).
    //
    // FIRST of everything here, and that ordering is the fix rather than a
    // tidiness. It was written because `releaseInFlightGrants` read
    // `fleet()`, which continues an authorized wave from inside the read, so
    // withdrawing second let the cleanup itself grant the next machine —
    // after a cancel, the very thing the cancel was for. POD-2180 took that
    // capability off the cleanup path (it reads the projection now), which
    // makes this ordering belt AND braces rather than the only brace: the
    // sweep below and `publishNextTargets` both run while this consent is
    // either alive or dead, and dead is the answer for all of them.
    const details = row.operation?.details
    const channel = details?.channel as UpdateChannel | undefined
    const target = details?.target as UpdateTarget | undefined
    log.info('update operation settled', {
      operationId: row.id,
      channel,
      approvedVersion: channel ? (await updatesService.approvedTarget(channel))?.version : undefined,
      previousState,
      state: row.state,
    })
    updatesService.withdrawAuthorization()
    // A version that arrived mid-update waits for the group to be free, and
    // this is the moment it becomes free — whatever the outcome was. It
    // re-creates the OFFER, never an operation (§3.2).
    updatesService.publishNextTargets()
    // POD-2101: the deadline that used to end a silent grant aged inside a
    // `fleet()` read. The operation owns that authority now, so the moment
    // it stops waiting is the moment those grants stop being believed. A
    // `done` operation has nothing in flight to end — and if a late machine
    // is still converging, it is converging successfully.
    if (row.state !== 'done') {
      updatesService.releaseInFlightGrants(
        row.state === 'canceled'
          ? 'The update was canceled while this machine was updating.'
          : undefined,
      )
    }
    // …and the same moment is when background convergence may resume. It
    // sweeps whoever is still behind, which is also how a FAILED operation
    // cleans up after itself without a human pressing Try again (§3.6).
    // AFTER the release above, so the sweep sees machines whose grants have
    // just stopped being believed rather than refusing them as in-flight.
    if (channel && target) reconciler()?.onOperationSettled(channel, target, row.state)
  }
}
