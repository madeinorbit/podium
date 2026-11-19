import { expect, it } from 'vitest'
import { session } from '../../sync/src/conformance/collection-server'
import { instanceKey } from '../../sync/src/replica/cache-state'
import { closedValue, ISSUE, issueValue, openDevice } from './test-support/device.test.fixture'
import { openScreen, phoneMissionReaders } from './test-support/screens.test.fixture'

it.each([
  false,
  true,
])('a phone mission releases its holds on close (selected row read: %s)', async (readSelected) => {
  const device = await openDevice({
    world: (server) => {
      server.put(ISSUE, 'R', issueValue('R', { stage: 'in_progress', title: 'Mission R' }))
      // Nested tasks keep their worklist filing observed even after the
      // mission closes. M15, M25 and M35 check M5's archive/delete state.
      for (let n = 1; n <= 40; n += 1) {
        const parentId = n <= 10 ? 'R' : `M${((n - 11) % 10) + 1}`
        server.put(ISSUE, `M${n}`, closedValue(`M${n}`, { parentId }))
        server.put(
          'session',
          `S-M${n}-0`,
          session(`S-M${n}-0`, { issueId: `M${n}`, status: 'ended', cwd: '/synthetic' }),
        )
      }
    },
  })
  let opened: Awaited<ReturnType<typeof openScreen>> | undefined
  try {
    expect(device.replica.heldForTest()).toEqual([])
    opened = await openScreen(device, 'phoneMission', () => {
      const readers = phoneMissionReaders(device, 'M5')
      return {
        ...readers,
        loading() {
          // A selected-row display can hold the lookup alongside navigation.
          // Filing must not inherit that demand even when stubs resolve the root.
          if (readSelected) void device.pool.row('issue', 'M5')
          return readers.loading()
        },
      }
    })
    expect(opened.ready).toBe(true)
    expect(device.replica.heldForTest()).not.toEqual([])
    if (readSelected)
      expect(device.replica.heldForTest()).toContain(
        instanceKey({ collection: 'issueProjection.one', args: { id: 'M5' }, part: 'main' }),
      )
    opened.close()
    expect(device.replica.heldForTest()).toEqual([])
  } finally {
    opened?.close()
    device.dispose()
  }
})
