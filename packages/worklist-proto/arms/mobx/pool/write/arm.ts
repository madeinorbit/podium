/**
 * POD-4573 (Mc1) + POD-4574 (Mc2) + POD-4760 — the MobX pool with the write
 * layer attached, product entry.
 *
 * Product-only: it creates the pool exactly as `mobxPoolArm` does, attaches
 * `createMobxWriteApi` over it, re-applies the kernel outbox's pending entries
 * at once (`bootstrap`, W11), and wires the feed's issue rows into
 * `handleRemote` plus the transport's receipts. The harness owns the settling
 * snapshot, the drain hooks and the optimism-aware rebuild
 * (`harness/src/adapters/mobx-pool.ts`).
 *
 * The handle carries the live `pool` and the `write` api beside the product
 * mounts. It does not join the harness roster.
 */

import type { LocalsSource, RowSource } from '../../../../shared/src/arm'
import type { ReadFence } from '../../../../shared/src/instrument/reads'
import type { SliceIssue } from '../../../../shared/src/slice-types'
import type { WriteTransport } from '../../../../shared/src/write-contract'
import { type MobxPoolHandle, mobxPoolArm } from '../arm'
import { type PoolLazyOptions } from '../pool'
import { createMobxWriteApi, type MobxWriteApi } from './edit'
import { PendingOverlay } from './overlay'

export interface WritableMobxPoolHandle extends MobxPoolHandle {
  readonly write: MobxWriteApi
}

function editableOf(value: SliceIssue): { title: string; stage: string; readAt: string | null } {
  return { title: value.title, stage: value.stage, readAt: (value.readAt ?? null) as string | null }
}

export function writableMobxPoolArm(
  transport: WriteTransport,
  loader: Omit<PoolLazyOptions, 'load'> = {},
): {
  create(source: RowSource, locals: LocalsSource, reads?: ReadFence): WritableMobxPoolHandle
} {
  return {
    create(source: RowSource, locals: LocalsSource, reads?: ReadFence): WritableMobxPoolHandle {
      const overlay = new PendingOverlay()
      const handle = mobxPoolArm.create(source, locals, reads, loader, overlay)
      const write = createMobxWriteApi(handle.pool, overlay, transport)
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
