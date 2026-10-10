import type { KeyedListChange } from '@podium/client-core/engine'
import type { MobxPool } from '@podium/client-graph/pool'
import { headerEntities } from '@podium/client-graph/header-entities'
import { attachSettingsSource as attachSource, type SettingsOwner } from '@podium/client-graph/settings-source'
import { runInAction } from 'mobx'

/** Provider-free settings fixtures publish the same discovery rows through
 * the shared repository source that the real provider already attaches. */
export function attachSettingsSource(pool: MobxPool, owner: SettingsOwner, followMachines = true): void {
  attachSource(pool, owner, followMachines)
  pool.sources.view('test.settings.repositories', () => {
    const publish = (change?: KeyedListChange) => runInAction(() => {
      const headers = headerEntities(pool)
      const ids = change ? [...change.ids] : owner.listIds('repos')
      headers.apply(ids.map(id => ({ kind: 'repository' as const, id, value: owner.listRow('repos', id) })))
      if (!change || change.order) headers.order('repository', owner.listIds('repos'))
    })
    publish()
    const stop = owner.onList('repos', publish)
    return { dispose: stop }
  })
}
