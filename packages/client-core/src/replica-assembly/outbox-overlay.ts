/**
 * THE REPLICA'S OVERLAY PORT, OVER THE CLIENT OUTBOX (ADR 12, POD-6277).
 *
 * The Replica reports what each commit proves it holds (`RetirementEvidence`):
 * the provenance on the rows it applied and the cursor it certifies. The outbox
 * decides what that covers (`Outbox.confirm`). This port is the translation
 * between the two, because the replica may not import the outbox.
 *
 * It ONLY RETIRES (plan Decision 3). `pending()` is empty and `reduce()` has no
 * reducer: nothing reads `replica.overlay()` or `replica.read()`. The layout
 * controller and the pool paint from the outbox's own entries, which is what
 * keeps a write on screen until this port retires it.
 *
 * Leaf module: it imports nothing from the engine, so the engine's outbox
 * adapter can build it without an import cycle.
 */

import type { MutationId } from '@podium/model'
import type { ConfirmationEvidence, Outbox } from '@podium/sync/outbox'
import type {
  OptimisticOverlayPort,
  RetirementEvidence,
  RetirementIntent,
} from '@podium/sync/replica'

/**
 * The mutation ids one commit's provenance names, in feed order. A change row
 * carries `mutationId` from the sync entry point; `causationId` is the same id
 * for a command's direct writes, and the only one some older writers stamp.
 *
 * The cast: `MutationId` is a compile-time brand and these ids came over the wire
 * as plain strings. There is no run-time check a brand could be given.
 */
function confirmedIds(matches: readonly RetirementIntent[]): readonly MutationId[] {
  const ids: string[] = []
  for (const match of matches) {
    const id = match.mutationId ?? match.causationId
    if (id !== undefined) ids.push(id)
  }
  return ids as unknown as readonly MutationId[]
}

/** The Replica's report of one commit, as the outbox's evidence. */
export function confirmationEvidence(evidence: RetirementEvidence): ConfirmationEvidence {
  return {
    confirmed: confirmedIds(evidence.matches),
    through: evidence.through,
    install: evidence.install,
  }
}

export interface OutboxOverlayOptions {
  /**
   * Entries left the queue in a commit that has now landed. Retiring an entry
   * that was still queued or in flight frees its partition but starts no drain
   * (POD-6275), so the integrator drains here.
   */
  readonly onRetired?: (ids: readonly MutationId[]) => void
}

export function outboxOverlayPort(
  outbox: Outbox,
  options: OutboxOverlayOptions = {},
): OptimisticOverlayPort {
  return {
    pending: () => [],
    reduce: () => ({ kind: 'no-reducer' }),
    // Both halves are the outbox's own coverage rule, so they cannot disagree:
    // `covers` decides from memory whether the Replica opens a unit of work at
    // all, and `retire` does the retiring inside it.
    covers: (evidence) => outbox.isConfirmable(confirmationEvidence(evidence)),
    // Awaited by the Replica inside `SyncUnitOfWork.transact`'s body, so the
    // retirement lands in the same transaction as the rows and the cursor
    // (ADR 2 D10), or not at all.
    retire: async (evidence, span) => {
      const retired = await outbox.confirm(confirmationEvidence(evidence), span)
      if (retired.length === 0 || options.onRetired === undefined) return
      const onRetired = options.onRetired
      if (span === undefined) onRetired(retired)
      else span.onCommit(() => onRetired(retired))
    },
  }
}
