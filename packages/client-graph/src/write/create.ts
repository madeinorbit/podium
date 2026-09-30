import type { LocalsSource, RowSource } from '../shared/source'
import type { SliceIssue } from '../shared/slice-types'
import type { WriteTransport } from '../shared/write-contract'
import { createWorklistPool, type WorklistPoolHandle } from '../create'
import { type PoolLazyOptions } from '../pool'
import { createMobxWriteApi, type MobxWriteApi } from './edit'
import { PendingOverlay } from './overlay'

export interface WritableWorklistPoolHandle extends WorklistPoolHandle {
  readonly write: MobxWriteApi
}

function editableOf(value: SliceIssue): { title: string; stage: string; readAt: string | null } {
  return { title: value.title, stage: value.stage, readAt: (value.readAt ?? null) as string | null }
}

/** The caller supplies the existing outbox transport; no mutation owner is created here. */
export function createWritableWorklistPool(
  source: RowSource,
  locals: LocalsSource,
  transport: WriteTransport,
  loader: Omit<PoolLazyOptions, 'load'> = {},
): WritableWorklistPoolHandle {
  const overlay = new PendingOverlay()
  const handle = createWorklistPool(source, locals, loader, overlay)
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
    else if (event.type === 'rejected') write.reject({ txId: event.txId, error: event.error })
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
}
