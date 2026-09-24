/**
 * POD-4573 (Mc1) — the MobX pool as a writable arm: the round-three pool with
 * the Mc1 write layer attached.
 *
 * `writableMobxPoolArm(transport)` is a `CheckableArm` for tests. It creates
 * the pool exactly as `mobxPoolArm` does, attaches `createMobxWriteApi` over
 * it, and wires the feed's issue rows into `handleRemote` so a server value
 * landing on a pending field becomes the rewind target (W5/W8) — the tables
 * themselves already hold it via `pool.apply`, so the log's passthrough for
 * non-pending fields is ignored and no patch is ever applied twice (W12).
 * The handle carries the live `pool` and the `write` api beside the
 * `CheckableArmHandle` (like `MobxPoolHandle` carries `pool`).
 *
 * The arm sends through the given `WriteTransport` (tests pass a fake; the
 * demo will pass `createWriteTransport(runtime)` from L3b). It does not join
 * the harness roster: the roster's `overlaid` pool stays the phase-a/b
 * candidate until Mc2 wires echo/settle (c2).
 */

import type {
  CheckableArm,
  CheckableArmHandle,
  LocalsSource,
  RowSource,
} from '../../../../shared/src/arm'
import type { ReadFence } from '../../../../shared/src/instrument/reads'
import type { SliceIssue } from '../../../../shared/src/slice-types'
import type { WriteTransport } from '../../../../shared/src/write-contract'
import { type MobxPoolHandle, mobxPoolArm } from '../arm'
import { type PoolLazyOptions } from '../pool'
import { createMobxWriteApi, type MobxWriteApi } from './edit'

export interface WritableMobxPoolHandle extends CheckableArmHandle {
  readonly pool: MobxPoolHandle['pool']
  readonly write: MobxWriteApi
}

function editableOf(value: SliceIssue): { title: string; stage: string; readAt: string | null } {
  return { title: value.title, stage: value.stage, readAt: (value.readAt ?? null) as string | null }
}

export function writableMobxPoolArm(
  transport: WriteTransport,
  loader: Omit<PoolLazyOptions, 'load'> = {},
): CheckableArm {
  return {
    create(source: RowSource, locals: LocalsSource, reads?: ReadFence): WritableMobxPoolHandle {
      const handle = mobxPoolArm.create(source, locals, reads, loader) as MobxPoolHandle
      const write = createMobxWriteApi(handle.pool, transport)
      const off = source.subscribe((event) => {
        for (const row of event.rows) {
          if (row.kind !== 'issue' || row.value === undefined) continue
          write.handleRemote('issue', row.id, editableOf(row.value as SliceIssue))
        }
      })
      const originalDispose = handle.dispose.bind(handle)
      return {
        ...handle,
        pool: handle.pool,
        write,
        dispose(): void {
          off()
          write.dispose()
          originalDispose()
        },
      }
    },
  }
}
