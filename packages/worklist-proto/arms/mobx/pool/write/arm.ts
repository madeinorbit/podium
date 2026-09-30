/** Prototype mounting adapter over the product write lifecycle. */
import {
  createWritableWorklistPool,
  type WritableWorklistPoolHandle,
} from '@podium/client-graph/write/create'
import type { PoolLazyOptions } from '@podium/client-graph/pool'
import type { LocalsSource, RowSource } from '@podium/client-graph/shared/source'
import type { WriteTransport } from '@podium/client-graph/shared/write-contract'
import { mountMobxPool, type MobxPoolHandle } from '../arm'
import type { MobxWriteApi } from '@podium/client-graph/write/edit'

export interface WritableMobxPoolHandle extends MobxPoolHandle {
  readonly write: MobxWriteApi
}

export function writableMobxPoolArm(
  transport: WriteTransport,
  loader: Omit<PoolLazyOptions, 'load'> = {},
): { create(source: RowSource, locals: LocalsSource): WritableMobxPoolHandle } {
  return {
    create(source, locals): WritableMobxPoolHandle {
      const handle: WritableWorklistPoolHandle = createWritableWorklistPool(
        source,
        locals,
        transport,
        loader,
      )
      return { ...mountMobxPool(handle), write: handle.write }
    },
  }
}
