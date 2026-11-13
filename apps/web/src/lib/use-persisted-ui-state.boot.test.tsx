import { createSideCache, memoryStorage } from '@podium/client-core/replica'
import {
  createRoutedUiState,
  ISSUES_DISPLAY_KEY,
  type ReplicatedUiStatePort,
} from '@podium/client-core/ui-state'
import { readSharedIssuesDisplay } from '@podium/client-core/values'
import type { MobxPool } from '@podium/client-graph/pool'
import { attachPreferenceSource } from '@podium/client-graph/preference-source'
import { act, renderHook } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { installMobxWarnTrap } from '../../../../tests/worklist/harness/src/mobx-trap'

const mounted = vi.hoisted(() => ({ pool: undefined as MobxPool | undefined }))

vi.mock('@/app/store-worklist-pool', async () => {
  const { createPoolProjection } = await import('@podium/client-graph/runtime-pool')
  const { useEffect, useMemo, useSyncExternalStore } = await import('react')
  return {
    useWorklistPoolProjection<T>(read: (pool: MobxPool) => T): T {
      const pool = mounted.pool
      if (!pool) throw new Error('preference boot fixture has no pool')
      const view = useMemo(() => createPoolProjection(pool, read), [pool, read])
      useEffect(() => () => view.dispose(), [view])
      return useSyncExternalStore(view.subscribe, () => view.getSnapshot())
    },
  }
})

import { usePersistedUiValue } from './use-persisted-ui-state'

installMobxWarnTrap({ errors: true })

it('desktop paints saved ordering on its first render through the shared preference source', async () => {
  const { MobxPool } = await import('@podium/client-graph/pool')
  const side = createSideCache({ storage: memoryStorage(), enumerateKeys: () => [] })
  const values = new Map<string, unknown>([['issues.display', { ordering: 'updated' }]])
  const listeners = new Set<(keys: ReadonlySet<string>) => void>()
  const replicated: ReplicatedUiStatePort = {
    get: (key) => values.get(key),
    set: (key, value) => {
      values.set(key, value)
      for (const notify of listeners) notify(new Set([key]))
    },
    clear: (key) => {
      values.delete(key)
    },
    hydrate: async () => {},
    subscribe: (notify) => {
      listeners.add(notify)
      return () => {
        listeners.delete(notify)
      }
    },
  }
  const ui = createRoutedUiState({ local: side.uiState(), replicated })
  const get = vi.spyOn(ui, 'get')
  const notify = vi.fn()
  const off = ui.subscribe(notify)
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
  attachPreferenceSource(pool, ui)
  mounted.pool = pool
  const frames: string[] = []
  const { result, unmount } = renderHook(() => {
    const display = usePersistedUiValue(ISSUES_DISPLAY_KEY, readSharedIssuesDisplay)
    frames.push(display.ordering)
    return display
  })
  try {
    expect(frames).toEqual(['updated'])
    expect(get).not.toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalled()
    await act(async () => {
      await Promise.resolve()
    })
    expect(frames).toEqual(['updated'])
    expect(get).toHaveBeenCalledExactlyOnceWith(ISSUES_DISPLAY_KEY)
    // The existing owner and subscription still deliver subsequent changes.
    await act(async () => {
      replicated.set('issues.display', { ordering: 'created' })
    })
    expect(result.current.ordering).toBe('created')
  } finally {
    unmount()
    mounted.pool = undefined
    off()
    pool.dispose()
    side.dispose()
  }
})
