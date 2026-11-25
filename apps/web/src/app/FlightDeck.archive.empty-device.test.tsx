// @vitest-environment happy-dom
/**
 * POD-7580 — THE FLIGHT DECK'S ARCHIVE ON AN EMPTY DEVICE.
 *
 * A closed deck holds no history. Opened, the archive holds one instance for
 * the whole tree (`issueProjection.treeArchive`). While it is on its way the
 * section says it is loading; when the server refuses it, it says it is not
 * available. Neither throws out of the section.
 */

import { fireEvent, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { OperatorFocusProvider } from '@/app/operator-focus'
import { DockIssueProvider } from '@/features/issues/dock-issue'
import { ConfirmProvider } from '@/lib/hooks/use-confirm'
import { mountOnEmptyDevice } from '@/test-support/empty-device'
import { attachMissionTestPreferences } from '../../../../packages/client-graph/src/mission-screen.test.fixture'
import {
  closedValue,
  ISSUE,
  issueValue,
} from '../../../../packages/client-graph/src/test-support/device.test.fixture'
import { refuseCollections } from '../../../../packages/client-graph/src/test-support/empty-device.test.fixture'
import {
  type CollectionServer,
  session,
} from '../../../../packages/sync/src/conformance/collection-server'
import { FlightDeck } from './FlightDeck'

vi.mock(
  '@/app/store-worklist-pool',
  async () => (await import('@/test-support/empty-device')).emptyDevicePoolHooks,
)
vi.mock('@podium/client-core/react', async (original) =>
  (await import('@/test-support/empty-device')).emptyDeviceCoreHooks(
    await original<typeof import('@podium/client-core/react')>(),
  ),
)
vi.mock('@/lib/use-feature', () => ({ useFeature: () => false }))
vi.mock('@/lib/use-model-catalog', () => ({
  useModelCatalog: () => ({}),
  useModelCatalogState: () => ({ catalog: {}, status: 'unavailable' }),
}))
// The cost chip reads the request client, which this device does not answer.
vi.mock('./MissionCostChip', () => ({ MissionCostChip: () => null }))
vi.mock('@/features/chat/use-chat-context', () => ({
  useChatReferenceMachines: () => [],
  useChatRepositoryKey: () => '',
}))

const RECENT = '2026-11-17T12:00:00.000Z'
const OLD = '2020-01-01T00:00:00.000Z'
const ARCHIVE = 'issueProjection.treeArchive{"root":"top"}'

/** An open root with a closed sub-issue, each with an archived agent the policy never brought. */
function world(server: CollectionServer): void {
  server.put(ISSUE, 'top', issueValue('top', { updatedAt: RECENT, deps: [] }))
  server.put(
    ISSUE,
    'old',
    closedValue('old', { seq: 90, updatedAt: OLD, deps: [], parentId: 'top' }),
  )
  for (const [id, issueId] of [
    ['past-top', 'top'],
    ['past-old', 'old'],
  ] as const)
    server.put(
      'session',
      id,
      session(id, {
        issueId,
        status: 'exited',
        archived: true,
        lastActiveAt: OLD,
        title: `Agent ${id}`,
        cwd: '/synthetic',
      }) as Record<string, unknown>,
    )
}

async function mountDeck(refuse: boolean) {
  const mounted = await mountOnEmptyDevice(
    <ConfirmProvider>
      <OperatorFocusProvider missionId="top">
        <DockIssueProvider>
          <FlightDeck onCollapse={() => {}} />
        </DockIssueProvider>
      </OperatorFocusProvider>
    </ConfirmProvider>,
    {
      selectedIssueId: 'top',
      world: (server) => {
        world(server)
        if (refuse)
          refuseCollections(server, (each) => each.collection === 'issueProjection.treeArchive')
      },
    },
  )
  attachMissionTestPreferences(mounted.pool)
  await mounted.untilIdle()
  return mounted
}

describe("the deck's archive on an empty device", () => {
  it('closed, it asks for no history; opened, one instance, then its sessions', async () => {
    const mounted = await mountDeck(false)
    const toggle = await screen.findByTestId('flight-archived-toggle')
    expect(toggle.textContent).toBe('Archived sessions')
    expect(mounted.requestedKeys()).not.toContain(ARCHIVE)
    fireEvent.click(toggle)
    // On its way: the section draws a loading line, not a throw.
    expect(screen.getByTestId('flight-archived')).toBeTruthy()
    await mounted.untilIdle()
    expect(mounted.requestedKeys().filter((key) => key === ARCHIVE)).toHaveLength(1)
    expect(screen.getByTestId('flight-archived-toggle').textContent).toBe('Hide archived')
    expect(screen.queryByText('Not available')).toBeNull()
  })

  it('refused, the open archive says it is not available, asked once', async () => {
    const mounted = await mountDeck(true)
    fireEvent.click(await screen.findByTestId('flight-archived-toggle'))
    await mounted.untilIdle()
    expect(screen.getByLabelText('Archived sessions: not available')).toBeTruthy()
    expect(mounted.requestedKeys().filter((key) => key === ARCHIVE)).toHaveLength(1)
  })
})
