// @vitest-environment happy-dom
/**
 * POD-7579 — THE ISSUE PAGE AND THE DOCK PANEL WHILE AN ISSUE'S SESSIONS ARE
 * ON THEIR WAY, ON AN EMPTY DEVICE.
 *
 * The page's rosters wait for the issue's sessions (`session.ofIssue`), its
 * sub-issues for its tree. The chrome must not: the header (Back, crumbs, the
 * actions menu) and the status strip draw at once, offline too, reading the
 * pending sessions as "no live readout yet". A sub-task row's "show in deck"
 * always moves the shell, with or without a session to put on screen. And the
 * sections that go from LOADING to loaded keep their hook order.
 */

import { fireEvent, screen } from '@testing-library/react'
import type { ReactElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest'
import { DockHeaderSlotProvider } from '@/app/DockHeaderSlot'
import { OperatorFocusProvider } from '@/app/operator-focus'
import type { IssueViewModel } from '@/app/store'
import { ConfirmProvider } from '@/lib/hooks/use-confirm'
import { mountOnEmptyDevice, putIssueWithBodies } from '@/test-support/empty-device'
import {
  type CollectionServer,
  session,
} from '../../../../../packages/sync/src/conformance/collection-server'
import { IssuePage } from './IssuePage'
import { IssuePanelView } from './IssuePanelView'

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
vi.mock('@/features/chat/use-chat-context', () => ({
  useChatReferenceMachines: () => [],
  useChatRepositoryKey: () => '',
}))

const ID = 'i1'
const CHILD = 'c1'
const OLD = '2020-01-01T00:00:00.000Z'

/** One repo, the issue with an agent that ended long ago, and an open sub-task with another. */
function world(server: CollectionServer): void {
  server.put('repo', 'repo-1', { id: 'repo-1', prefix: 'POD', name: 'synthetic' })
  putIssueWithBodies(server, ID, { seq: 1, title: 'The parent task' })
  putIssueWithBodies(server, CHILD, {
    seq: 2,
    title: 'The open sub-task',
    parentId: ID,
    stage: 'in_progress',
  })
  for (const [id, issueId] of [
    ['past', ID],
    ['child-past', CHILD],
  ] as const)
    server.put(
      'session',
      id,
      session(id, { status: 'exited', lastActiveAt: OLD, issueId }) as Record<string, unknown>,
    )
}

const providers = (element: ReactElement): ReactElement => (
  <ConfirmProvider>
    <OperatorFocusProvider missionId={ID}>
      <DockHeaderSlotProvider value={null}>{element}</DockHeaderSlotProvider>
    </OperatorFocusProvider>
  </ConfirmProvider>
)

const mountPanel = (options: { offline?: boolean } = {}) =>
  mountOnEmptyDevice(providers(<IssuePanelView cwd="/synthetic" issueId={ID as never} />), {
    world,
    ...options,
  })

const mountPage = (options: { offline?: boolean } = {}) =>
  mountOnEmptyDevice(
    providers(
      <IssuePage
        issue={{ id: ID } as IssueViewModel}
        orderedIds={[ID as never]}
        onBack={() => {}}
        onNavigate={() => {}}
      />,
    ),
    { world, ...options },
  )

let errors: MockInstance<typeof console.error>
beforeEach(() => {
  errors = vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  const hookErrors = errors.mock.calls.filter(([message]) =>
    /Rendered (more|fewer) hooks|change in the order of Hooks/.test(String(message)),
  )
  errors.mockRestore()
  expect(hookErrors, 'a section that goes from LOADING to loaded keeps its hooks').toEqual([])
})

describe('while the issue sessions are on their way', () => {
  it('the issue page draws its header, Back and actions offline', async () => {
    const mounted = await mountPage({ offline: true })
    expect(
      mounted.device.holds({ collection: 'session.ofIssue', args: { issueId: ID }, part: 'main' }),
    ).toBe(false)
    expect(screen.getByTitle('Back')).toBeTruthy()
    expect(screen.getByTitle('More actions')).toBeTruthy()
  })

  it('the dock panel draws its status strip offline, then keeps it once the sessions arrive', async () => {
    const mounted = await mountPanel({ offline: true })
    expect(screen.getByLabelText('More issue actions')).toBeTruthy()
    mounted.online()
    await mounted.untilIdle()
    expect(mounted.requestedKeys()).toContain(`session.ofIssue{"issueId":"${ID}"}`)
    expect(screen.getByLabelText('More issue actions')).toBeTruthy()
  })
})

describe('show in deck from a sub-task row', () => {
  it('moves the shell even before the sub-task has a session to show', async () => {
    const mounted = await mountPanel()
    fireEvent.click(screen.getByTestId('dock-subtasks-toggle'))
    const row = screen
      .getAllByTestId('dock-link-row')
      .find((each) => each.textContent?.includes('The open sub-task'))
    expect(row, 'the open sub-task row').toBeTruthy()
    fireEvent.click(row!)
    expect(mounted.commands.setSelectedIssueId).toHaveBeenCalledWith(ID)
    expect(mounted.commands.setView).toHaveBeenCalledWith('workspace')
    // Its row reads open seats behind the tree, never its whole history.
    expect(mounted.requestedKeys()).not.toContain(`session.ofIssue{"issueId":"${CHILD}"}`)
  })
})
