// @vitest-environment happy-dom
import * as values from '@podium/client-core/values'
import type { ClientRuntime } from '@podium/client-core/engine'
import { asClientPrincipal } from '@podium/client-core/principal'
import { StoreProvider, useStoreHandle } from '@podium/client-core/react'
import type { MobxPool } from '@podium/client-graph'
import { asIssueId, asUserId } from '@podium/model/browser'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { useEffect } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { StatusStrip } from '../src/app/StatusStrip'
import { attachWorklistPool, useWorklistPool } from '../src/app/store-worklist-pool'
import { HeaderSessionLabel } from '../src/features/machines/HeaderSessionLabel'
import { createHeaderFixture } from './header-fixture'

const unrelated = vi.hoisted(() => ({ renders: 0 }))
vi.mock('../src/app/StatusPerformanceStats', () => ({ StatusPerformanceStats: () => {
  unrelated.renders++
  return null
} }))
vi.mock('../src/features/mobile-handoff/MobileHandoffChip', () => ({ MobileHandoffChip: () => null }))
vi.mock('../src/features/updates/updates-panel-context', () => ({ useUpdates: () => ({ indicator: 'none' }) }))
vi.mock('../src/features/machines/ConnectionIndicator', () => ({
  ConnectionIndicator: () => null, useStableConnection: () => ({ visible: false }),
}))
afterEach(() => { cleanup(); vi.restoreAllMocks() })

it('renewal prepares zero displayed labels and a selected title updates only its header leaf', async () => {
  localStorage.clear()
  sessionStorage.clear()
  window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener() {}, removeEventListener() {} })
  const fixture = createHeaderFixture(3, 3)
  const failures: string[] = []
  let pool: MobxPool | null = null, runtime: ClientRuntime | undefined
  function Header() {
    const current = useWorklistPool(), owner = useStoreHandle() as ClientRuntime
    useEffect(() => { pool = current; runtime = owner }, [current, owner])
    return <><StatusStrip /><HeaderSessionLabel id="synthetic-session-0" /><HeaderSessionLabel id="synthetic-session-1" /></>
  }
  const view = render(<StoreProvider
    principal={asClientPrincipal(asUserId('header-leaves-proof'))}
    config={{ httpOrigin: 'http://offline.invalid', wsClientUrl: 'ws://offline.invalid' }}
    api={fixture.api} createReplicaFn={() => fixture.newReplica()} networkEnabled={false}
    onFatalError={error => failures.push(error)}
    attachRuntime={owner => {
      fixture.bindHub(owner.hub)
      fixture.publishMachines()
      fixture.publishMetrics(0)
      return attachWorklistPool(owner, error => failures.push(error.message))
    }}
  ><Header /></StoreProvider>)
  await waitFor(() => expect(pool).not.toBeNull())
  const observedAt = Date.now()
  await act(async () => {
    runtime!.access.setSelectedIssueId(asIssueId('synthetic-0'))
    fixture.idle()
    for (const id of ['synthetic-session-0', 'synthetic-session-1']) fixture.patch('session', id, {
      status: 'live', name: id, lastActiveAt: new Date(observedAt).toISOString(),
      agentState: { phase: 'working', since: new Date(observedAt).toISOString() },
    })
  })
  await waitFor(() => expect(view.getByTestId('status-strip-working').textContent).toBe('2 agents working'))
  fireEvent.click(view.getByTestId('status-strip-working'))
  await waitFor(() => expect(view.getByTestId('status-strip-roster')).toBeTruthy())
  const sessions = ['synthetic-session-0', 'synthetic-session-1'].map(id => pool!.sessionObject(id))
  const reads = sessions.map(session => vi.spyOn(session, 'storedField'))
  const shellRenders = unrelated.renders
  const issue = pool!.model('issue', 'synthetic-0')!
  const issueReads = vi.spyOn(issue, 'storedField')
  const labelPreparations = vi.spyOn(values, 'panelLabel')
  await act(async () => {
    fixture.patch('session', 'synthetic-session-0', {
      lastActiveAt: new Date(observedAt + 1000).toISOString(),
      agentState: { phase: 'working', since: new Date(observedAt).toISOString(),
        stateObservedAt: new Date(observedAt + 1000).toISOString() },
    })
  })
  // Scalar companions may check the changed record's fields, but no display
  // label is formatted and no sibling is read when those scalars are unchanged.
  expect(labelPreparations).not.toHaveBeenCalled()
  expect(reads[1]!.mock.calls).toEqual([])
  expect(issueReads.mock.calls).toEqual([])
  expect(unrelated.renders).toBe(shellRenders)
  await act(async () => fixture.patch('issue', 'synthetic-0', { title: 'Selected title changed' }))
  expect(view.container.querySelector('.status-strip-issue')?.getAttribute('title')).toBe('Selected title changed')
  expect(view.container.querySelector('.status-strip-issue-title')?.textContent).toBe('Selected title changed')
  expect(labelPreparations).not.toHaveBeenCalled()
  expect(unrelated.renders).toBe(shellRenders)
  await act(async () => fixture.patch('session', 'synthetic-session-1', { title: 'Own session changed', name: 'Own roster name' }))
  expect(view.container.textContent).toContain('Own session changed')
  expect(view.getByTestId('status-strip-roster').textContent).toContain('Own roster name')
  expect(reads[0]!.mock.calls.filter(([field]) => ['title', 'name', 'agentKind'].includes(field))).toEqual([])
  expect(failures).toEqual([])
}, 30000)
