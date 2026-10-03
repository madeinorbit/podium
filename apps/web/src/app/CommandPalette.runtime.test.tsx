import type { ClientRuntime } from '@podium/client-core/engine'
import { asClientPrincipal } from '@podium/client-core/principal'
import { StoreProvider, useStoreHandle } from '@podium/client-core/react'
import { asUserId } from '@podium/model/browser'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Profiler } from 'react'
import { afterEach, expect, it } from 'vitest'
import { ConfirmProvider } from '@/lib/hooks/use-confirm'
import { createSidebarFixture } from '../../test/sidebar-fixture'
import { CommandPalette } from './CommandPalette'
import { attachWorklistPool } from './store-worklist-pool'

let runtime: ClientRuntime
function Capture() {
  runtime = useStoreHandle() as ClientRuntime
  return null
}

afterEach(cleanup)

it('settles palette renders and preserves hover until the commands change', async () => {
  const fixture = createSidebarFixture(12, Date.now(), false, 'palette-runtime')
  let commits = 0
  render(
    <StoreProvider
      principal={asClientPrincipal(asUserId('palette-runtime'))}
      config={{ httpOrigin: 'http://offline.invalid', wsClientUrl: 'ws://offline.invalid' }}
      api={fixture.api}
      createReplicaFn={() => fixture.replica}
      attachRuntime={(runtime) =>
        attachWorklistPool(runtime, (error) => {
          throw error
        })
      }
      networkEnabled={false}
      onFatalError={(message) => {
        throw new Error(message)
      }}
    >
      <ConfirmProvider>
        <Capture />
        <Profiler
          id="palette"
          onRender={() => {
            // Fail a synchronous render loop before it can starve the test timeout.
            if (++commits > 25) throw new Error('Command palette renders did not settle')
          }}
        >
          <CommandPalette />
        </Profiler>
      </ConfirmProvider>
    </StoreProvider>,
  )
  await act(async () => {
    runtime.getSnapshot().setPaletteOpen(true)
  })
  expect(screen.getByRole('combobox')).toBeTruthy()
  const rows = screen.getAllByRole('option')
  expect(rows.length).toBeGreaterThan(1)
  fireEvent.mouseMove(rows[1]!)
  expect(rows[1]!.getAttribute('aria-selected')).toBe('true')
  expect(rows[0]!.getAttribute('aria-selected')).toBe('false')

  await act(async () => {
    fixture.patch('issueProjection', 'synthetic-11', { title: 'Updated palette task' })
  })
  expect(screen.getAllByRole('option')[0]!.getAttribute('aria-selected')).toBe('true')
})
