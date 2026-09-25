/**
 * POD-4586 (Hc1) + POD-4587 (Hc2) — the hand-rolled pool as a writable arm:
 * the round-three pool with the write layer attached.
 *
 * `writableHandPoolArm(transport)` is a `CheckableArm` for tests. It creates
 * the pool exactly as `handPoolArm` does, attaches `createHandWriteApi` over
 * it, re-applies the kernel outbox's pending entries at once (`bootstrap`,
 * W11: the arm never re-sends; the kernel replays its own queue under the
 * same mutation ids), and wires two streams:
 *
 * - the feed's issue rows into `handleRemote` so a server value landing on a
 *   pending field becomes the rewind target (W5/W8) — the tables themselves
 *   already hold it via `pool.apply`, so the log's passthrough for
 *   non-pending fields is ignored and no patch is ever applied twice (W12);
 * - the transport's receipts into `handleAccepted` / `reject` /
 *   `handleSuperseded` (L3b): the receipt alone repaints nothing (the echo
 *   still has to confirm, W7); a duplicate receipt is a no-op.
 *
 * The handle carries the live `pool` and the `write` api beside the
 * `CheckableArmHandle` (like `HandPoolHandle` carries `pool`).
 * `rebuildFromScratch` overlays the pending display onto the feed's server
 * rows before deriving, so a gate with pending edits outstanding compares the
 * live pending view with a pending rebuild — never with server truth.
 *
 * The arm sends through the given `WriteTransport` (tests pass a fake; the
 * demo will pass `createWriteTransport(runtime)` from L3b). It does not join
 * the harness roster: the roster's `overlaid` pool stays the phase-a/b
 * candidate until the phase-c gate moves to `truth` with arm-side edits.
 */

import type {
  CheckableArm,
  CheckableArmHandle,
  LocalsSource,
  RowSource,
} from '../../../../shared/src/arm'
import type { ReadFence } from '../../../../shared/src/instrument/reads'
import type { SliceIssue } from '../../../../shared/src/slice-types'
import type { RowRecord } from '../../../../shared/src/stats'
import type { WriteTransport } from '../../../../shared/src/write-contract'
import { type HandPoolHandle, handPoolArm } from '../arm'
import type { PoolLazyOptions } from '../pool'
import { rebuildSnapshot } from '../rebuild'
import { createHandWriteApi, type HandWriteApi } from './edit'

export interface WritableHandPoolHandle extends CheckableArmHandle {
  readonly pool: HandPoolHandle['pool']
  readonly write: HandWriteApi
}

function editableOf(value: SliceIssue): { title: string; stage: string; readAt: string | null } {
  return { title: value.title, stage: value.stage, readAt: (value.readAt ?? null) as string | null }
}

export function writableHandPoolArm(
  transport: WriteTransport,
  loader: Omit<PoolLazyOptions, 'load'> = {},
): CheckableArm {
  return {
    create(source: RowSource, locals: LocalsSource, reads?: ReadFence): WritableHandPoolHandle {
      const handle = handPoolArm.create(source, locals, reads, loader) as HandPoolHandle
      const write = createHandWriteApi(handle.pool, transport)
      // W11: pending edits survive a principal-preserving rebuild — the
      // outbox entries are re-applied from the queue before anything reads.
      write.bootstrap()
      const offRemote = source.subscribe((event) => {
        for (const row of event.rows) {
          if (row.kind !== 'issue' || row.value === undefined) continue
          write.handleRemote('issue', row.id, editableOf(row.value as SliceIssue))
        }
      })
      const offReceipts = transport.subscribe((event) => {
        if (event.type === 'accepted') write.handleAccepted(event.txId)
        else if (event.type === 'rejected')
          write.reject({ txId: event.txId, error: event.error })
        else write.handleSuperseded(event.txId)
      })
      // The optimism-aware rebuild: the feed's snapshot is server truth, so
      // the pending display is overlaid onto its issue rows before deriving.
      // Without it a gate with a pending edit outstanding would hold the live
      // pending view to server truth and fail on every such step.
      const pendingSource: RowSource = {
        ...source,
        snapshot: (kind: RowRecord['kind']): RowRecord[] => {
          const rows = source.snapshot(kind)
          if (kind !== 'issue') return rows
          return rows.map((record) => {
            if (record.value === undefined) return record
            const pending = write.pendingDisplay('issue', record.id) as
              | Partial<SliceIssue>
              | undefined
            if (pending === undefined) return record
            return { ...record, value: { ...record.value, ...pending } }
          })
        },
        ...(source.row === undefined
          ? {}
          : {
              row: ((kind: 'issue' | 'session', id: string) => {
                const value = source.row!(kind, id)
                if (kind !== 'issue' || value === undefined) return value
                const pending = write.pendingDisplay('issue', id) as
                  | Partial<SliceIssue>
                  | undefined
                return pending === undefined ? value : { ...value, ...pending }
              }) as RowSource['row'],
            }),
      }
      const originalDispose = handle.dispose.bind(handle)
      return {
        ...handle,
        pool: handle.pool,
        write,
        rebuildFromScratch: () =>
          rebuildSnapshot(pendingSource, locals, handle.pool.residentIssueIds()),
        dispose(): void {
          offRemote()
          offReceipts()
          write.dispose()
          originalDispose()
        },
      }
    },
  }
}
