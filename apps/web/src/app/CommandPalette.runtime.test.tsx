import { referenceState } from '../../../../tests/worklist/diagnostics/reference-state'
import type { ClientRuntime } from '@podium/client-core/engine'
import { asClientPrincipal } from '@podium/client-core/principal'
import { StoreProvider, useStoreHandle } from '@podium/client-core/react'
import { commandLaunchViews, createCommandPalette } from '@podium/client-graph/command-launch-views'
import type { MobxPool } from '@podium/client-graph/pool'
import { asIssueId, asSessionId, asUserId } from '@podium/model/browser'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Profiler } from 'react'
import { runInAction } from 'mobx'
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

it('settles palette renders and preserves hover when a row title changes', async () => {
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
  expect(screen.getAllByRole('option')[1]!.getAttribute('aria-selected')).toBe('true')
})

it('reads no closed changes and takes a fresh catalog on each reopen', async () => {
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
  expect(summaryReads()).toBe(12)

  await act(async () => { referenceState(runtime).setPaletteOpen(false) })
  row.mockClear()
  await act(async () => { referenceState(runtime).setPaletteOpen(true) })
  expect(await screen.findByRole('combobox')).toBeTruthy()
  expect(summaryReads()).toBe(12)
  row.mockRestore()
  mounted.unmount()
})

for (const scale of [1, 4]) it(`does not render or walk catalogs on an open palette heartbeat at ${scale}x`, async () => {
  const fixture = createSidebarFixture(12 * scale, Date.now(), false, `palette-heartbeat-${scale}`)
  let commits = 0
  const mounted = render(<StoreProvider principal={asClientPrincipal(asUserId(`palette-heartbeat-${scale}`))}
    config={{ httpOrigin: 'http://offline.invalid', wsClientUrl: 'ws://offline.invalid' }} api={fixture.api}
    createReplicaFn={() => fixture.replica} networkEnabled={false}
    attachRuntime={runtime => attachWorklistPool(runtime, error => { throw error })}
    onFatalError={error => { throw new Error(error) }}>
    <ConfirmProvider><Capture /><Profiler id="open-palette" onRender={() => { commits++ }}><CommandPalette /></Profiler></ConfirmProvider>
  </StoreProvider>)
  await act(async () => {
    fixture.patch('session', 'synthetic-session-0', { issueId: 'synthetic-11', archived: true, status: 'exited' })
    referenceState(runtime).setSelectedIssueId(asIssueId('synthetic-11'))
    referenceState(runtime).setPane('A', asSessionId('synthetic-session-11'))
    referenceState(runtime).setPaletteOpen(true)
  })
  expect(await screen.findByRole('combobox')).toBeTruthy()
  await act(async () => {})
  runInAction(() => {
    const picker = createCommandPalette(pool!)
    picker.open()
    const answer = picker.palette(), legacy = commandLaunchViews(pool!).palette()
    if (!answer || !legacy || typeof answer === 'symbol' || typeof legacy === 'symbol') throw new Error('Palette answer did not settle')
    expect(answer.selectedIssue?.memberSessionIds).toEqual(legacy.issues.find(issue => issue.id === 'synthetic-11')?.memberSessionIds)
    expect(answer.selectedIssue?.memberSessionIds).not.toContain('synthetic-session-0')
    picker.close()
  })
  // Eligibility changes remain live; measure a subsequent timestamp-only
  // heartbeat after the selected session's first unread transition settles.
  await act(async () => fixture.patch('session', 'synthetic-session-11', { lastActiveAt: new Date(Date.now() + 30000).toISOString() }))
  await act(async () => {})
  const before = commits, counts = { ...commandLaunchViews(pool!).counts }
  const order = screen.getAllByRole('option').map(row => row.textContent)
  await act(async () => fixture.patch('session', 'synthetic-session-11', { lastActiveAt: new Date(Date.now() + 60000).toISOString() }))
  expect(commits).toBe(before)
  expect(screen.getAllByRole('option').map(row => row.textContent)).toEqual(order)
  expect(commandLaunchViews(pool!).counts.catalogBuilds).toBe(counts.catalogBuilds)
  expect(commandLaunchViews(pool!).counts.issueBuilds).toBe(counts.issueBuilds)
  expect(commandLaunchViews(pool!).counts.usageQueries).toBe(counts.usageQueries)
  mounted.unmount()
})
