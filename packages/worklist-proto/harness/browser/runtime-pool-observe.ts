import { sidebarView } from '@podium/client-graph/worklist/sidebar'
/** Fixture-only observer, loaded after the product attachment is ready.
 * MobX is a dependency of this harness, not of the legacy web entry. */
import { autorun } from 'mobx'
import type { MobxPool } from '@podium/client-graph'

export function observePool(pool: MobxPool, id: string): () => void {
  return autorun(() => {
    void sidebarView(pool).sections()
    void sidebarView(pool).row(id)
  })
}
