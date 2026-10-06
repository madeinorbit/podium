/**
 * POD-4586 (Hc1) + POD-4587 (Hc2) + POD-4933 — the hand-rolled pool with the
 * write layer attached, product entry.
 *
 * Product-only: it creates the pool exactly as `handPoolArm` does, attaches
 * `createHandWriteApi` over it, re-applies the kernel outbox's pending entries
 * at once (`bootstrap`, W11), and wires the feed's issue rows into
 * `handleRemote` plus the transport's receipts. The harness owns the settling
 * snapshot, the drain hooks and the optimism-aware rebuild
 * (`harness/src/adapters/hand-pool.ts`).
 *
 * The handle carries the live `pool` and the `write` api beside the product
 * mounts. It does not join the harness roster.
 */

import type { LocalsSource, RowSource } from '../../../../shared/src/arm'
import type { ReadFence } from '../../../../shared/src/instrument/reads'
import type { SliceIssue } from '@podium/client-graph/shared/slice-types'
import type { WriteTransport } from '@podium/client-graph/shared/write-contract'
import { type HandPoolHandle, handPoolArm } from '../arm'
import type { PoolLazyOptions } from '../pool'
import { createHandWriteApi, type HandWriteApi } from './edit'

export interface WritableHandPoolHandle extends HandPoolHandle {
  readonly write: HandWriteApi
}

function editableOf(value: SliceIssue): { title: string; stage: string; readAt: string | null } {
  return { title: value.title, stage: value.stage, readAt: (value.readAt ?? null) as string | null }
}

export function writableHandPoolArm(
  transport: WriteTransport,
  loader: Omit<PoolLazyOptions, 'load'> = {},
): {
  create(source: RowSource, locals: LocalsSource, reads?: ReadFence): WritableHandPoolHandle
} {
  return {
    create(source: RowSource, locals: LocalsSource, reads?: ReadFence): WritableHandPoolHandle {
      const handle = handPoolArm.create(source, locals, reads, loader)
      const write = createHandWriteApi(handle.pool, transport)
      // W11: pending edits survive a principal-preserving rebuild — the
      // outbox entries are re-applied from the queue before anything reads,
      // from the feed source so priors agree with the rebuild exactly.
      write.bootstrap(source)
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
      const originalDispose = handle.dispose.bind(handle)
      return {
        ...handle,
        pool: handle.pool,
        write,
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
