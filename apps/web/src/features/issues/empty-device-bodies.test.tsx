// @vitest-environment happy-dom
/**
 * POD-7544 — AN ISSUE'S BODY ON AN EMPTY DEVICE.
 *
 * The server holds an issue with a description, a brief, todos, artifacts,
 * deferred items and a state line, each its own record (group `body`). The
 * device holds only what a real start loads: the issue, none of its body.
 * Each screen is mounted on that device and must show the body it draws.
 *
 * Today only the flight deck asks for its root's body (POD-7088's hand-made
 * hold; `packages/client-graph/src/empty-device.test.ts` checks it). The
 * panel, the issue page and the reference miniview read the description
 * through `IssueModel.description` (or the stored row), which holds nothing,
 * fetches nothing and answers '' when the record is not on the device. Those
 * tests are `it.fails` until POD-7545 ("Body relations load on read") makes
 * the read the request; POD-7545 turns them into `it`. Each `it.fails` has
 * passing twins: one mounts the same screen and finds the task on it, so the
 * expected failure is the missing body and not a screen that did not mount;
 * one holds the body on the device by hand and finds it on the screen, so the
 * test turns green once a requester exists.
 */
import type { MemberRosterAnswer } from '@podium/client-graph/member-roster'
import { act, fireEvent, screen, within } from '@testing-library/react'
import type { ReactElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { DockHeaderSlotProvider } from '@/app/DockHeaderSlot'
import { OperatorFocusProvider } from '@/app/operator-focus'
import type { IssueViewModel } from '@/app/store'
import { RefMiniviewHost } from '@/components/RefMiniview'
import { ConfirmProvider } from '@/lib/hooks/use-confirm'
import { openMiniview } from '@/lib/ref-activation'
import {
  bodyOf,
  FULL_BODIES,
  mountOnEmptyDevice,
  putIssueWithBodies,
  requestKey,
} from '@/test-support/empty-device'
import type { CollectionServer } from '../../../../../packages/sync/src/conformance/collection-server'
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
/** The issue's own "one record" instance on the server. */
const ONE = { collection: 'issueProjection.one', args: { id: ID }, part: 'main' } as const
const REF = 'POD-1'
const TITLE = 'The task the server holds'

/** The server: one repo, and the issue with all six bodies. */
function world(server: CollectionServer): void {
  server.put('repo', 'repo-1', { id: 'repo-1', prefix: 'POD', name: 'synthetic' })
  putIssueWithBodies(server, ID, { seq: 1, title: TITLE })
}

const providers = (element: ReactElement): ReactElement => (
  <ConfirmProvider>
    <OperatorFocusProvider missionId={ID}>
      <DockHeaderSlotProvider value={null}>{element}</DockHeaderSlotProvider>
    </OperatorFocusProvider>
  </ConfirmProvider>
)

const mountPanel = () =>
  mountOnEmptyDevice(providers(<IssuePanelView cwd="/synthetic" issueId={ID as never} />), {
    world,
  })

const mountPage = (options: { members?: MemberRosterAnswer } = {}) =>
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

/** Two members: the instance is shared, and text edits name their revision. */
const SHARED: MemberRosterAnswer = {
  currentMemberId: 'mem_a',
  members: [
    { id: 'mem_a', displayName: 'Member A', role: 'admin' },
    { id: 'mem_b', displayName: 'Member B', role: 'member' },
  ],
}

async function mountMiniview() {
  const mounted = await mountOnEmptyDevice(providers(<RefMiniviewHost />), { world })
  act(() => openMiniview(REF, { x: 100, y: 100 }))
  await mounted.untilIdle()
  return mounted
}
const miniview = () => screen.getByRole('dialog')

/** What the screen asked the server for, for the failure message. */
const asked = (mounted: { requestedKeys(): readonly string[] }) =>
  `the screen asked for: ${JSON.stringify(mounted.requestedKeys())}`

describe('the right-dock issue panel', () => {
  it('mounts on the empty device and names the task', async () => {
    await mountPanel()
    expect(screen.getByTestId('dock-title').textContent).toBe(TITLE)
  })

  it('shows the description once something holds it on the device', async () => {
    const mounted = await mountPanel()
    await mounted.hold(bodyOf('issueDescription', ID))
    expect(screen.getByTestId('dock-description').textContent).toBe(FULL_BODIES.description)
  })

  // Test a. POD-7545 turns this into `it`.
  it.fails('shows the description', async () => {
    const mounted = await mountPanel()
    expect(screen.queryByTestId('dock-description')?.textContent, asked(mounted)).toBe(
      FULL_BODIES.description,
    )
  })
})

describe('the issue page', () => {
  it('mounts on the empty device and names the task', async () => {
    await mountPage()
    expect(within(screen.getByTestId('issue-page')).getByText(TITLE)).toBeTruthy()
  })

  it('shows the description and the brief once something holds them on the device', async () => {
    const mounted = await mountPage()
    await mounted.hold(bodyOf('issueDescription', ID))
    await mounted.hold(bodyOf('issueBrief', ID))
    expect(screen.getByTitle('Click to edit description').textContent).toBe(FULL_BODIES.description)
    expect(screen.getByTestId('issue-brief').textContent).toContain(FULL_BODIES.brief)
  })

  // Test b. POD-7545 turns this into `it`.
  it.fails('shows the description and the brief', async () => {
    const mounted = await mountPage()
    expect(screen.getByTitle('Click to edit description').textContent, asked(mounted)).toBe(
      FULL_BODIES.description,
    )
    expect(screen.queryByTestId('issue-brief')?.textContent, asked(mounted)).toContain(
      FULL_BODIES.brief,
    )
  })

  // Test e. The description editor opens on what the device holds
  // (IssueBody.tsx `defaultValue={draft ?? issue.description}`; the base of
  // IssuePage.tsx `setDescBase`), which is '' here. The save is a whole-text
  // replace (`issues.update` patch `{ description }`, applied as given by the
  // server's `store/issues.ts`), so a reader who adds a line to what looks
  // like an empty description replaces the text the server holds.
  // POD-7545 ("no write over an unloaded value") turns this into `it`.
  it.fails('opening the description editor and saving keeps the server text', async () => {
    const mounted = await mountPage()
    await saveAddedLine(mounted)
    expect(serverTextAfterSave(mounted), asked(mounted)).toContain(FULL_BODIES.description)
  })

  // Test e's evidence, run on today's code: what the save sends, alone and
  // on a shared instance. POD-7545 makes the editor refuse to open (or the
  // save refuse) on an unloaded description, and replaces these two tests.
  it('today, one member: the editor opens empty and the save replaces the server text', async () => {
    const mounted = await mountPage()
    const editor = await saveAddedLine(mounted)
    expect(editor.opened).toBe('')
    expect(mounted.commands.updateIssue).toHaveBeenCalledTimes(1)
    expect(mounted.commands.updateIssue).toHaveBeenCalledWith(ID, { description: ADDED })
    expect(serverTextAfterSave(mounted)).toBe(ADDED)
    // The server held the text all along, and the device never asked for it.
    expect(mounted.device.server.members(bodyOf('issueDescription', ID))).toHaveLength(1)
    expect(mounted.requestedKeys()).not.toContain(requestKey(bodyOf('issueDescription', ID)))
  })

  it('today, shared: the save names no revision, so nothing on the server refuses it', async () => {
    const mounted = await mountPage({ members: SHARED })
    const editor = await saveAddedLine(mounted)
    expect(editor.opened).toBe('')
    // A shared instance's edit is meant to name the revision it was cut from
    // (POD-6295, `saveIssueText`), so a stale draft is refused. The server's
    // issue record carries `revision`, but the device's issue row does not
    // (the pool's issue schema has no such field), so the base revision is
    // undefined and the edit goes out unchecked: a plain whole-text replace.
    expect(mounted.device.server.members(ONE)[0]?.value.revision).toBe(1)
    expect((mounted.pool.row('issue', ID) as { revision?: number }).revision).toBeUndefined()
    const saves = mounted.requests.filter((call) => call.path === 'issues.update.mutate')
    expect(saves).toEqual([
      { path: 'issues.update.mutate', input: { id: ID, patch: { description: ADDED } } },
    ])
    expect(mounted.commands.updateIssue).not.toHaveBeenCalled()
    expect(serverTextAfterSave(mounted)).toBe(ADDED)
  })
})

describe('the reference miniview', () => {
  it('mounts on the empty device and names the task', async () => {
    await mountMiniview()
    expect(miniview().textContent).toContain(TITLE)
  })

  // Test c. Two causes: nothing asks for the description, and the card reads
  // the stored issue row's `description` (`readRefTarget`), which the synced
  // issue record no longer carries (POD-6921), instead of the issue model. So
  // even a description held on the device does not reach the card. POD-7545
  // turns this into `it`.
  it.fails('shows the description', async () => {
    const mounted = await mountMiniview()
    expect(miniview().textContent, asked(mounted)).toContain(FULL_BODIES.description)
  })
})

const ADDED = 'A line the reader added.'

/** Open the description editor, add a line at its end, and leave it (the blur saves). */
async function saveAddedLine(mounted: Awaited<ReturnType<typeof mountPage>>) {
  fireEvent.click(screen.getByTitle('Click to edit description'))
  const textarea = screen.getByLabelText('Task description') as HTMLTextAreaElement
  const opened = textarea.value
  const typed = opened ? `${opened}\n${ADDED}` : ADDED
  fireEvent.change(textarea, { target: { value: typed } })
  fireEvent.blur(textarea)
  await mounted.untilIdle()
  return { opened }
}

/**
 * The description the server holds once the recorded saves are applied as
 * the server applies them: the patch's `description` replaces the text
 * (`apps/server/src/store/issues.ts`, `patch.description = input.description`).
 */
function serverTextAfterSave(mounted: Awaited<ReturnType<typeof mountPage>>): string {
  let text = mounted.device.server.members(bodyOf('issueDescription', ID))[0]?.value.text as string
  for (const [id, patch] of mounted.commands.updateIssue.mock.calls)
    if (id === ID && typeof patch.description === 'string') text = patch.description
  for (const call of mounted.requests) {
    if (call.path !== 'issues.update.mutate') continue
    const input = call.input as { id: string; patch: { description?: string } }
    if (input.id === ID && typeof input.patch.description === 'string')
      text = input.patch.description
  }
  return text
}
