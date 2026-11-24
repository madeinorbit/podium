// @vitest-environment happy-dom
/**
 * POD-7544 — AN ISSUE'S BODY ON AN EMPTY DEVICE.
 *
 * The server holds an issue with a description, a brief, todos, artifacts,
 * deferred items and a state line, each its own record (group `body`). The
 * device holds only what a real start loads: the issue, none of its body.
 * Each screen is mounted on that device and must show the body it draws.
 *
 * The panel, the issue page and the reference miniview read the description
 * (and the brief) through `IssueModel`: the field's read holds the body record
 * and loads it, and answers LOADING until it is here (POD-7545, "Body
 * relations load on read"). Until then a section shows its quiet loading
 * state, offline "Not available offline", and the description editor does not
 * open. Each screen also has its twins from POD-7544: one mounts the screen
 * and finds the task on it, one holds the body by hand.
 */

import { createChatContextReader } from '@podium/client-graph/chat-context'
import { LOADING } from '@podium/client-graph/loading'
import type { MemberRosterAnswer } from '@podium/client-graph/member-roster'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import type { ReactElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest'
import { DockHeaderSlotProvider } from '@/app/DockHeaderSlot'
import { OperatorFocusProvider } from '@/app/operator-focus'
import type { IssueViewModel, IssueWithBodies } from '@/app/store'
import { RefMiniviewHost } from '@/components/RefMiniview'
import { ItemAttachments } from '@/features/chat/ChatUploadThumb'
import { ArtifactsTab } from '@/features/files/ArtifactsTab'
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
import { issuePageCommands } from './issue-page-commands'

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

let warn: MockInstance<typeof console.warn>
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  const misuse = warn.mock.calls.filter(([message]) =>
    String(message).includes('Body read misuse:'),
  )
  warn.mockRestore()
  expect(misuse, 'the page, panel and miniview must not read bodies for a list').toEqual([])
})

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

const mountPanel = (options: { offline?: boolean } = {}) =>
  mountOnEmptyDevice(providers(<IssuePanelView cwd="/synthetic" issueId={ID as never} />), {
    world,
    ...options,
  })

const mountPage = (
  options: {
    members?: MemberRosterAnswer
    answer?: (path: string, input: unknown) => unknown
    offline?: boolean
  } = {},
) =>
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

async function mountMiniview(options: { offline?: boolean } = {}) {
  const mounted = await mountOnEmptyDevice(providers(<RefMiniviewHost />), { world, ...options })
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

  // Test a.
  it('shows the description', async () => {
    const mounted = await mountPanel()
    expect(screen.queryByTestId('dock-description')?.textContent, asked(mounted)).toBe(
      FULL_BODIES.description,
    )
    expect(mounted.requestedKeys()).toContain(requestKey(bodyOf('issueDescription', ID)))
  })

  it('offline, says the description is not available offline, and shows it once back', async () => {
    const mounted = await mountPanel({ offline: true })
    expect(screen.queryByTestId('dock-description')).toBeNull()
    expect(screen.getAllByText('Not available offline').length).toBeGreaterThan(0)
    mounted.online()
    await mounted.untilIdle()
    expect(screen.getByTestId('dock-description').textContent).toBe(FULL_BODIES.description)
  })
})

// POD-1163 deliberately keeps agent todos off both human issue screens. The
// shared panel still loads its todo records; body-relations.test.ts checks
// their values and lifetime on an empty device.
describe.each([
  ['issue panel', mountPanel, 'dock-artifacts', 'dock-deferred', 'dock-current-update-body'],
  ['issue page', mountPage, 'issue-artifacts', 'issue-deferred', undefined],
] as const)('remaining bodies on the %s', (_name, mount, artifactsId, deferredId, stateId) => {
  it('loads artifacts, deferred items and the state line from their own records', async () => {
    const mounted = await mount()
    expect(screen.getByTestId(artifactsId).textContent).toContain(FULL_BODIES.artifacts[0]?.title)
    expect(screen.getByTestId(deferredId).textContent).toContain(FULL_BODIES.deferred[0])
    expect(
      stateId
        ? screen.getByTestId(stateId).textContent
        : screen.getByText(FULL_BODIES.stateLine).textContent,
    ).toBe(FULL_BODIES.stateLine)
    expect(mounted.pool.issueObject(ID).panelTodos).toMatchObject(FULL_BODIES.todos)
    for (const kind of [
      'issuePanelTodo',
      'issuePanelArtifact',
      'issuePanelDeferred',
      'issuePanelState',
    ])
      expect(mounted.requestedKeys()).toContain(requestKey(bodyOf(kind, ID)))
  })

  it('offline, shows pending bodies instead of hiding them and fills them when back online', async () => {
    const mounted = await mount({ offline: true })
    expect(
      screen.getByRole('status', {
        name: 'The issue panel is not available offline',
      }),
    ).toBeTruthy()
    expect(
      screen.getByRole('status', { name: 'The state line is not available offline' }),
    ).toBeTruthy()
    expect(screen.queryByTestId(artifactsId)).toBeNull()
    expect(screen.queryByTestId(deferredId)).toBeNull()
    mounted.online()
    await mounted.untilIdle()
    expect(screen.getByTestId(artifactsId).textContent).toContain(FULL_BODIES.artifacts[0]?.title)
    expect(screen.getByTestId(deferredId).textContent).toContain(FULL_BODIES.deferred[0])
    expect(screen.getByText(FULL_BODIES.stateLine)).toBeTruthy()
  })
})

it.each([
  ['issue panel', <IssuePanelView key="panel" cwd="/synthetic" issueId={ID as never} />],
  [
    'issue page',
    <IssuePage
      key="page"
      issue={{ id: ID } as IssueViewModel}
      orderedIds={[ID as never]}
      onBack={() => {}}
      onNavigate={() => {}}
    />,
  ],
] as const)('%s shows quiet loading until the bodies arrive', async (_name, element) => {
  const mounted = await mountOnEmptyDevice(<div />, { world })
  act(() => mounted.view.rerender(providers(element)))
  expect(
    screen.getByRole('status', { name: 'Loading the issue panel' }).getAttribute('aria-busy'),
  ).toBe('true')
  expect(
    screen.getByRole('status', { name: 'Loading the state line' }).getAttribute('aria-busy'),
  ).toBe('true')
  await mounted.untilIdle()
  expect(screen.queryByRole('status', { name: 'Loading the issue panel' })).toBeNull()
  expect(screen.getByText(FULL_BODIES.stateLine)).toBeTruthy()
})

it('the Artifacts tab loads its list and does not show its empty state while offline', async () => {
  const mounted = await mountOnEmptyDevice(<ArtifactsTab issueId={ID} />, { world, offline: true })
  expect(
    screen.getByRole('status', { name: 'The artifact list is not available offline' }),
  ).toBeTruthy()
  expect(screen.queryByText(/No artifacts yet/)).toBeNull()
  mounted.online()
  await mounted.untilIdle()
  expect(screen.getByText(FULL_BODIES.artifacts[0]?.title ?? '')).toBeTruthy()
})

describe('chat upload thumbnails on an empty device', () => {
  const sessionId = 'chat-session' as never
  const uploadWorld = (server: CollectionServer) => {
    world(server)
    server.put('session', sessionId, {
      sessionId,
      issueId: ID,
      cwd: '/synthetic',
      status: 'running',
      archived: false,
      createdAt: '2026-11-17T12:00:00.000Z',
      lastActiveAt: '2026-11-17T12:00:00.000Z',
    })
    server.put('issuePanelArtifact', 'saved-upload', {
      id: 'saved-upload',
      issueId: ID,
      position: 1,
      path: 'uploaded.png',
      addedAt: '2026-11-17T12:00:00.000Z',
      artifactId: 'artifact-upload',
      chatUploadId: 'att-1',
    })
  }

  it.each([
    false,
    true,
  ])('shows a saved upload thumbnail after its body loads (offline: %s)', async (offline) => {
    const mounted = await mountOnEmptyDevice(<div />, { world: uploadWorld, offline })
    const reader = createChatContextReader(mounted.pool)
    mounted.pool.sources.register(['chatContextReader'], { read: () => reader, dispose() {} })
    act(() =>
      mounted.view.rerender(
        <ItemAttachments
          sessionId={sessionId}
          attachments={[{ id: 'att-1', filename: 'uploaded.png', kind: 'image' }]}
          tags={[]}
          httpOrigin="http://device.invalid"
          onOpenImage={() => {}}
        />,
      ),
    )
    expect(
      screen.getByRole('status', {
        name: offline ? 'The chat upload is not available offline' : 'Loading the chat upload',
      }),
    ).toBeTruthy()
    expect(screen.queryByRole('img')).toBeNull()
    if (offline) mounted.online()
    await mounted.untilIdle()
    expect(screen.getByRole('img').getAttribute('src')).toContain('artifact-upload')
    expect(mounted.requestedKeys()).toContain(requestKey(bodyOf('issuePanelArtifact', ID)))
    expect(mounted.requestedKeys()).not.toContain(requestKey(bodyOf('issuePanelTodo', ID)))
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

  // Test b.
  it('shows the description and the brief', async () => {
    const mounted = await mountPage()
    expect(screen.getByTitle('Click to edit description').textContent, asked(mounted)).toBe(
      FULL_BODIES.description,
    )
    expect(screen.queryByTestId('issue-brief')?.textContent, asked(mounted)).toContain(
      FULL_BODIES.brief,
    )
  })

  // Test e. The description editor opens on the text the server holds (the
  // read loaded it), so a reader who adds a line keeps what was there.
  it('opening the description editor and saving keeps the server text', async () => {
    const mounted = await mountPage()
    const editor = await saveAddedLine(mounted)
    expect(editor.opened).toBe(FULL_BODIES.description)
    expect(serverTextAfterSave(mounted), asked(mounted)).toContain(FULL_BODIES.description)
    // The body stays held through the save: no loading line after it.
    await mounted.untilIdle()
    expect(screen.queryByTestId('issue-description-pending')).toBeNull()
  })

  // POD-7545 "no write over an unloaded value": offline the description is
  // LOADING, so there is nothing to click into and the save command refuses,
  // handing the reader's text back.
  it('while the description is loading, the editor does not open and the save refuses', async () => {
    const mounted = await mountPage({ offline: true })
    expect(screen.queryByTitle('Click to edit description')).toBeNull()
    expect(screen.queryByText('Add a description…')).toBeNull()
    expect(
      within(screen.getByTestId('issue-description-pending')).getByText('Not available offline'),
    ).toBeTruthy()
    expect(screen.queryByLabelText('Task description')).toBeNull()

    const issue = mounted.pool.issueObject(ID)
    expect(issue.description).toBe(LOADING)
    const updateIssue = vi.fn(async () => undefined)
    const run = vi.fn(async (work: () => Promise<unknown>) => work())
    const commands = issuePageCommands({
      issue: issue as unknown as IssueWithBodies,
      updateIssue,
      run,
      trpc: {} as never,
    } as unknown as Parameters<typeof issuePageCommands>[0])
    const done = vi.fn()
    commands.commitText('description', ADDED, { text: '', revision: 1 }, done)
    expect(done).toHaveBeenCalledWith({ failed: ADDED })
    expect(updateIssue).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
    expect(mounted.requests.filter((call) => call.path === 'issues.update.mutate')).toEqual([])
    expect(serverTextAfterSave(mounted)).toBe(FULL_BODIES.description)

    // Back online the text arrives, and the editor opens on it.
    mounted.online()
    await mounted.untilIdle()
    expect(screen.getByTitle('Click to edit description').textContent).toBe(FULL_BODIES.description)
  })
})

/**
 * POD-7556 — A TEXT SAVE NAMES ITS REVISION (test e, extended).
 *
 * The device's issue row carries the server's revision, and every title and
 * description save names the revision its editor opened on, alone or shared.
 * A server that moved on refuses it; the editor keeps the reader's text,
 * shows the other writer's, and saving again is a deliberate overwrite.
 */
describe('the issue page: a text save names the revision it was cut from', () => {
  /** The server's issue: its text, its revision, and its refusal of a stale save. */
  function serverIssue() {
    const issue = { revision: 1, title: TITLE, description: FULL_BODIES.description as string }
    const answer = (path: string, input: unknown): unknown => {
      if (path === 'issues.get.query') return { id: ID, ...issue }
      if (path !== 'issues.update.mutate') return undefined
      const { patch, expectedRevision } = input as {
        patch: { title?: string; description?: string }
        expectedRevision?: number
      }
      if (expectedRevision !== undefined && expectedRevision !== issue.revision)
        throw Object.assign(new Error('stale'), { data: { code: 'CONFLICT', httpStatus: 409 } })
      Object.assign(issue, patch, { revision: issue.revision + 1 })
      return { ...issue }
    }
    return { issue, answer }
  }

  /** The page with the description on the device, as a reader who opened it has it. */
  async function openPage(
    answer: (path: string, input: unknown) => unknown,
    members?: MemberRosterAnswer,
  ) {
    const mounted = await mountPage({ answer, ...(members ? { members } : {}) })
    await mounted.hold(bodyOf('issueDescription', ID))
    return mounted
  }

  const saves = (mounted: { requests: readonly { path: string; input: unknown }[] }) =>
    mounted.requests
      .filter((call) => call.path === 'issues.update.mutate')
      .map((call) => call.input)

  it('the device holds the server revision on its issue row', async () => {
    const mounted = await openPage(serverIssue().answer)
    expect(mounted.device.server.members(ONE)[0]?.value.revision).toBe(1)
    expect((mounted.pool.row('issue', ID) as { revision?: number }).revision).toBe(1)
  })

  it.each([
    ['one member', undefined],
    ['shared', SHARED],
  ] as const)('%s: a description save names the revision', async (_name, members) => {
    const server = serverIssue()
    const mounted = await openPage(server.answer, members)
    const editor = await saveAddedLine(mounted)
    expect(editor.opened).toBe(FULL_BODIES.description)
    await waitFor(() => expect(saves(mounted)).toHaveLength(1))
    expect(saves(mounted)).toEqual([
      {
        id: ID,
        patch: { description: `${FULL_BODIES.description}\n${ADDED}` },
        expectedRevision: 1,
      },
    ])
    expect(server.issue.description).toBe(`${FULL_BODIES.description}\n${ADDED}`)
    expect(mounted.commands.updateIssue).not.toHaveBeenCalled()
    await mounted.untilIdle()
    expect(screen.queryByTestId('issue-description-pending')).toBeNull()
  })

  it('a title save names the revision', async () => {
    const server = serverIssue()
    const mounted = await openPage(server.answer)
    fireEvent.click(screen.getByTitle('Click to edit title'))
    const input = screen.getByLabelText('Task title') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'A sharper title' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(server.issue.title).toBe('A sharper title'))
    expect(saves(mounted)).toEqual([
      { id: ID, patch: { title: 'A sharper title' }, expectedRevision: 1 },
    ])
  })

  it('another writer’s newer description is refused, not replaced: the editor keeps mine and shows theirs', async () => {
    const server = serverIssue()
    const mounted = await openPage(server.answer)
    // Someone else's edit the device has not received yet.
    Object.assign(server.issue, { description: 'Their rewrite.', revision: 2 })
    await saveAddedLine(mounted)
    const mine = `${FULL_BODIES.description}\n${ADDED}`
    const notice = await screen.findByTestId('description-conflict')
    expect(server.issue.description).toBe('Their rewrite.')
    expect(screen.getByTestId('description-conflict-theirs').textContent).toBe('Their rewrite.')
    expect(notice.textContent).toContain('revision 2')
    expect((screen.getByLabelText('Task description') as HTMLTextAreaElement).value).toBe(mine)
    // Saving mine now is a deliberate overwrite of the revision I was shown.
    fireEvent.click(screen.getByTestId('description-conflict-save-mine'))
    await waitFor(() => expect(server.issue.description).toBe(mine))
    expect(saves(mounted).at(-1)).toEqual({
      id: ID,
      patch: { description: mine },
      expectedRevision: 2,
    })
    expect(server.issue.description).toBe(mine)
    expect(screen.queryByTestId('description-conflict')).toBeNull()
  })

  it('keeping theirs drops my draft and saves nothing', async () => {
    const server = serverIssue()
    const mounted = await openPage(server.answer)
    Object.assign(server.issue, { description: 'Their rewrite.', revision: 2 })
    await saveAddedLine(mounted)
    fireEvent.click(await screen.findByTestId('description-conflict-keep-theirs'))
    await mounted.untilIdle()
    expect(saves(mounted)).toHaveLength(1)
    expect(server.issue.description).toBe('Their rewrite.')
    expect(screen.queryByLabelText('Task description')).toBeNull()
  })

  it('a revision only another field moved: the save lands on top', async () => {
    const server = serverIssue()
    const mounted = await openPage(server.answer)
    // A label or stage change: the revision moved, the text did not.
    server.issue.revision = 2
    await saveAddedLine(mounted)
    await waitFor(() => expect(saves(mounted)).toHaveLength(2))
    expect(
      saves(mounted).map((save) => (save as { expectedRevision?: number }).expectedRevision),
    ).toEqual([1, 2])
    expect(server.issue.description).toBe(`${FULL_BODIES.description}\n${ADDED}`)
    expect(screen.queryByTestId('description-conflict')).toBeNull()
  })

  it('a title another writer changed is refused, not replaced', async () => {
    const server = serverIssue()
    const mounted = await openPage(server.answer)
    Object.assign(server.issue, { title: 'Their title', revision: 2 })
    fireEvent.click(screen.getByTitle('Click to edit title'))
    const input = screen.getByLabelText('Task title') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'My title' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    const theirs = await screen.findByTestId('title-conflict-theirs')
    expect(server.issue.title).toBe('Their title')
    expect(theirs.textContent).toBe('Their title')
    expect((screen.getByLabelText('Task title') as HTMLInputElement).value).toBe('My title')
  })

  it('with no server answer, the save is queued, still naming the revision', async () => {
    const mounted = await openPage((path) => {
      if (path === 'issues.update.mutate') throw new TypeError('Failed to fetch')
      return undefined
    })
    await saveAddedLine(mounted)
    await waitFor(() => expect(mounted.commands.updateIssue).toHaveBeenCalled())
    expect(mounted.commands.updateIssue).toHaveBeenCalledWith(
      ID,
      { description: `${FULL_BODIES.description}\n${ADDED}` },
      { expectedRevision: 1 },
    )
    expect(screen.queryByTestId('description-conflict')).toBeNull()
  })
})

describe('the reference miniview', () => {
  it('mounts on the empty device and names the task', async () => {
    await mountMiniview()
    expect(miniview().textContent).toContain(TITLE)
  })

  // Test c. The card reads the description through the issue model
  // (`readRefTarget`), not the stored row, which holds only a painted value.
  it('shows the description', async () => {
    const mounted = await mountMiniview()
    expect(miniview().textContent, asked(mounted)).toContain(FULL_BODIES.description)
  })

  it('offline, says the description is not available offline', async () => {
    await mountMiniview({ offline: true })
    expect(miniview().textContent).toContain(TITLE)
    expect(within(miniview()).getByText('Not available offline')).toBeTruthy()
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
