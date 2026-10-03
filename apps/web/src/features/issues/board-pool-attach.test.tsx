// @vitest-environment happy-dom
import type { PodiumClientApi } from '@podium/client-core/api'
import { issueBoardStats } from '@podium/client-core/perf'
import { asClientPrincipal } from '@podium/client-core/principal'
import { StoreProvider } from '@podium/client-core/react'
import { createKernelReplica, createSideCache, memoryStorage } from '@podium/client-core/replica'
import { asUserId } from '@podium/model/browser'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it('attaches a real pool after the pending board render without legacy derivations or React errors', async () => {
  history.replaceState(null, '', '/?mobxBoard=1&mobxSidebar=0')
  const { attachWorklistPool, useWorklistPool } = await import('@/app/store-worklist-pool')
  const { EMPTY_BOARD, useBoardBase, useBoardData } = await import('./board-pool-data')
  const { DEFAULT_DISPLAY } = await import('./issues-display')
  const replica = createKernelReplica({
    cache: { readCursor: () => null, readEntities: () => [], read: () => undefined, durability: () => 'durable' },
    side: createSideCache({ storage: memoryStorage(), enumerateKeys: () => [] }),
  })
  const container = document.createElement('div')
  const root = createRoot(container)
  const errors: unknown[] = []
  const error = vi.spyOn(console, 'error').mockImplementation((...args) => errors.push(args))
  let sawPending = false
  function Probe() {
    const pool = useWorklistPool()
    const base = useBoardBase()
    const data = useBoardData({ display: DEFAULT_DISPLAY, filter: {}, expanded: [], isMobile: false, openIssueId: base.openIssueId, now: 0 }, base)
    sawPending ||= pool === null
    return <span>{pool && data !== EMPTY_BOARD ? 'ready' : 'pending'}</span>
  }
  issueBoardStats.enable(); issueBoardStats.reset()
  try {
    await act(async () => {
      root.render(<StoreProvider
        principal={asClientPrincipal(asUserId('board-attach'))}
        config={{ httpOrigin: 'http://offline.invalid', wsClientUrl: 'ws://offline.invalid' }}
        api={{} as PodiumClientApi} createReplicaFn={() => replica} networkEnabled={false}
        attachRuntime={(runtime) => attachWorklistPool(runtime, (cause) => errors.push(cause))}
        onFatalError={(message) => { throw new Error(message) }}
      ><Probe /></StoreProvider>)
    })
    await vi.waitFor(async () => {
      await act(async () => { await new Promise((done) => setTimeout(done, 0)) })
      expect(container.textContent).toBe('ready')
    })
    expect(sawPending).toBe(true)
    expect(issueBoardStats.read()['legacy.board'] ?? 0).toBe(0)
    expect(errors).toEqual([])
  } finally {
    act(() => root.unmount())
    error.mockRestore(); issueBoardStats.disable(); history.replaceState(null, '', '/')
  }
})
