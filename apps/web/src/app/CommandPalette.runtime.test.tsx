import { referenceState } from '@podium/client-graph/diagnostics/reference-state'
import type { ClientRuntime } from '@podium/client-core/engine'
import { asClientPrincipal } from '@podium/client-core/principal'
import { StoreProvider, useStoreHandle } from '@podium/client-core/react'
import { commandLaunchViews } from '@podium/client-graph/command-launch-views'
import type { MobxPool } from '@podium/client-graph/pool'
import { asUserId } from '@podium/model/browser'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Profiler } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { ConfirmProvider } from '@/lib/hooks/use-confirm'
import { createSidebarFixture } from '../../test/sidebar-fixture'
import { CommandPalette } from './CommandPalette'
import { attachWorklistPool, useWorklistPool } from './store-worklist-pool'

let runtime: ClientRuntime
let pool: MobxPool | null
function Capture() {
  runtime = useStoreHandle() as ClientRuntime
  pool = useWorklistPool()
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
    referenceState(runtime).setPaletteOpen(true)
  })
  expect(await screen.findByRole('combobox')).toBeTruthy()
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

it('retains visited summaries, reads no closed changes and refreshes only the changed issue on reopen', async () => {
  const fixture = createSidebarFixture(12, Date.now(), false, 'palette-retention')
  const mounted = render(
    <StoreProvider
      principal={asClientPrincipal(asUserId('palette-retention'))}
      config={{ httpOrigin: 'http://offline.invalid', wsClientUrl: 'ws://offline.invalid' }}
      api={fixture.api}
      createReplicaFn={() => fixture.replica}
      attachRuntime={(runtime) => attachWorklistPool(runtime, (error) => { throw error })}
      networkEnabled={false}
      onFatalError={(message) => { throw new Error(message) }}
    >
      <ConfirmProvider>
        <Capture />
        <CommandPalette />
      </ConfirmProvider>
    </StoreProvider>,
  )
  await act(async () => { referenceState(runtime).setPaletteOpen(true) })
  expect(await screen.findByRole('combobox')).toBeTruthy()
  const row = vi.spyOn(pool!, 'row')
  const views = commandLaunchViews(pool!)
  // spyOn exposes the last base-entity overload; this source adds string kinds.
  const isSummary = (kind: string) => kind === 'commandIssue'
  const summaryReads = () => row.mock.calls.filter(([kind]) => isSummary(kind)).length

  await act(async () => { referenceState(runtime).setPaletteOpen(false) })
  expect(screen.queryByRole('combobox')).toBeNull()
  const builds = views.counts.issueBuilds
  row.mockClear()
  await act(async () => {
    fixture.patch('issueProjection', 'synthetic-11', { title: 'Updated parked palette task' })
  })
  expect(summaryReads()).toBe(0)
  expect(views.counts.issueBuilds).toBe(builds)

  await act(async () => { referenceState(runtime).setPaletteOpen(true) })
  expect(await screen.findByRole('combobox')).toBeTruthy()
  // The default groups cap their rows. A single letter searches local commands
  // without starting the remote search, and exposes the updated task.
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'U' } })
  expect(screen.getAllByRole('option').some((option) =>
    option.textContent?.includes('Updated parked palette task'),
  )).toBe(true)
  expect(summaryReads()).toBe(1)

  await act(async () => { referenceState(runtime).setPaletteOpen(false) })
  row.mockClear()
  await act(async () => { referenceState(runtime).setPaletteOpen(true) })
  expect(await screen.findByRole('combobox')).toBeTruthy()
  expect(summaryReads()).toBe(0)
  row.mockRestore()
  mounted.unmount()
})
