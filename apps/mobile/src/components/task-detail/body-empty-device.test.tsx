import type { IssueWithBodies } from '@podium/client-core/replica'
import { LOADING } from '@podium/client-graph/loading'
import type { MobxPool } from '@podium/client-graph/pool'
import {
  BODY_KINDS,
  type EmptyDevice,
  FULL_BODIES,
  openEmptyDevice,
  putIssueWithBodies,
  refuseCollections,
} from '@podium/client-graph/test-support/empty-device.test.fixture'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ pool: null as MobxPool | null }))
vi.mock('../../client/mobile-pool', () => ({ useMobilePool: () => state.pool }))
vi.mock('../../client/hooks', () => ({ useHttpOrigin: () => 'https://example.com' }))
vi.mock('../../client/use-issue-model', () => ({
  useIssueModel: (id: string) => state.pool?.issueObject(id),
}))
vi.mock('../../client/server-profile-context', () => ({
  useOptionalServerProfile: () => null,
  useServerProfile: () => ({ bearer: null, config: {} }),
}))
vi.mock('../../client/ServerProfileGate', () => ({ useServerProfile: () => ({ bearer: null }) }))
vi.mock('expo-haptics', () => ({
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium', Soft: 'soft' },
  impactAsync: vi.fn(),
}))
vi.mock('../Icon', () => ({ Icon: () => null }))
vi.mock('../ArtifactViewer', () => ({ ArtifactViewer: () => null }))
vi.mock('./PromptSheet', () => ({ PromptSheet: () => null }))
// Markdown layout is orthogonal; the real sections still read the shared model.
vi.mock('../RichMarkdown', () => ({
  RichMarkdown: ({ text }: { text: string }) => <p>{text}</p>,
  RichMarkdownPreview: ({ text }: { text: string }) => <p>{text}</p>,
}))

const { IssueDescription, IssueDescriptionPreview, IssueBrief } = await import('./IssueBody')
const { TaskSummary, ArtifactStrip } = await import('./TaskOverview')
const { IssueAgentPanel } = await import('./IssueAgentPanel')
const { OfferArtifactStrip } = await import('../OfferArtifactStrip')
const { issueCommands } = await import('../../lib/issue-detail')
const { chatUploadUrl } = await import('../../client/chat-uploads')
const { ChatUploadPending } = await import('../ChatUploadPending')

const devices: EmptyDevice[] = []
afterEach(() => {
  cleanup()
  for (const device of devices.splice(0)) device.dispose()
  state.pool = null
})

async function fixture(options: { refuse?: readonly string[] } = {}) {
  const device = await openEmptyDevice({
    world: (server) => {
      putIssueWithBodies(server, 'i1')
      const refused = options.refuse ?? []
      if (refused.length > 0)
        refuseCollections(server, (instance) => refused.includes(instance.collection))
    },
  })
  devices.push(device)
  state.pool = device.pool
  const issue = device.pool.issueObject('i1') as unknown as IssueWithBodies
  const updateIssue = vi.fn(async () => {})
  const commands = issueCommands({
    issue,
    trpc: {} as never,
    actions: { updateIssue } as never,
    hasCloseBlockers: () => false,
    run: async (fn) => {
      await fn()
    },
  })
  return { device, issue, commands, updateIssue }
}

function BodySections({
  issue,
  commands,
}: Pick<Awaited<ReturnType<typeof fixture>>, 'issue' | 'commands'>) {
  return (
    <>
      <IssueDescriptionPreview issue={issue} commands={commands} busy={false} />
      <IssueBrief issue={issue} />
      <TaskSummary
        issue={issue}
        lead={undefined}
        offer={null}
        onAccept={async () => {}}
        onComment={() => {}}
        onOpenSession={() => {}}
      />
      <ArtifactStrip issue={issue}>
        <IssueAgentPanel issue={issue} only="artifacts" />
      </ArtifactStrip>
      <IssueAgentPanel issue={issue} only="deferred" />
      <OfferArtifactStrip
        issue={issue}
        offer={{ message: 'Review', createdAt: 'stamp', actions: [], artifacts: ['proof.html'] }}
      />
    </>
  )
}

it('task overview, brief and evidence show loading before their actual server content', async () => {
  const f = await fixture()
  render(<BodySections {...f} />)
  expect(screen.getAllByText('Loading…').length).toBeGreaterThanOrEqual(6)
  expect(screen.queryByText('Add a description…')).toBeNull()
  expect(screen.queryByText('No agent yet. Add a comment or @mention an agent.')).toBeNull()
  expect(screen.queryByRole('textbox')).toBeNull()
  await act(() => f.device.untilIdle())
  expect(screen.queryByText('Loading…')).toBeNull()
  expect(screen.getByText(FULL_BODIES.description)).toBeTruthy()
  expect(screen.getByText(FULL_BODIES.stateLine)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Brief' }))
  expect(screen.getByText(FULL_BODIES.brief)).toBeTruthy()
  expect(screen.getByText(FULL_BODIES.deferred[0]!)).toBeTruthy()
  expect(screen.getAllByText(FULL_BODIES.artifacts[0]!.title).length).toBeGreaterThan(0)
  expect(screen.queryByText(FULL_BODIES.todos[0]!.text)).toBeNull()
  const bodies = f.device
    .requested()
    .filter((instance) => BODY_KINDS.some((kind) => instance.collection === `${kind}.ofIssue`))
  expect(bodies.map((instance) => instance.collection).sort()).toEqual(
    BODY_KINDS.map((kind) => `${kind}.ofIssue`).sort(),
  )
  expect(bodies.every((instance) => instance.args?.issueId === 'i1')).toBe(true)
})

it('offline first reads show availability, then content when the phone reconnects', async () => {
  const f = await fixture()
  f.device.offline()
  render(<BodySections {...f} />)
  await act(() => f.device.untilIdle())
  expect(screen.getAllByText('Not available offline').length).toBeGreaterThanOrEqual(6)
  expect(screen.queryByText('Loading…')).toBeNull()
  expect(screen.queryByRole('textbox')).toBeNull()
  expect(screen.queryByText('Add a description…')).toBeNull()
  f.commands.commitDescription('Unsafe replacement')
  expect(f.updateIssue).not.toHaveBeenCalled()
  await act(async () => {
    f.device.online()
    await f.device.untilIdle()
  })
  expect(screen.getByText(FULL_BODIES.description)).toBeTruthy()
  expect(screen.getByText(FULL_BODIES.stateLine)).toBeTruthy()
  expect(screen.queryByText('Not available offline')).toBeNull()
})

it('the description editor cannot start or save until the full text arrives', async () => {
  const f = await fixture()
  render(<IssueDescription issue={f.issue} commands={f.commands} busy={false} />)
  expect(f.issue.description).toBe(LOADING)
  expect(screen.queryByRole('button', { name: 'Task description' })).toBeNull()
  f.commands.commitDescription('Unsafe replacement')
  f.commands.update({ description: 'Unsafe replacement' })
  expect(f.updateIssue).not.toHaveBeenCalled()
  await act(() => f.device.untilIdle())
  fireEvent.click(screen.getByRole('button', { name: 'Task description' }))
  expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe(FULL_BODIES.description)
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Safe replacement' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  expect(f.updateIssue).toHaveBeenCalledWith('i1', { description: 'Safe replacement' })
})

it.each([
  false,
  true,
])('chat uploads preserve the unanswered body until its stored URL arrives, offline=%s', async (offline) => {
  const device = await openEmptyDevice({
    world(server) {
      putIssueWithBodies(server, 'i1')
      server.put('session', 'chat', {
        sessionId: 'chat',
        issueId: 'i1',
        agentKind: 'codex',
        status: 'live',
        cwd: '/synthetic',
        createdAt: '2026-11-17T12:00:00.000Z',
        lastActiveAt: '2026-11-17T12:00:00.000Z',
      })
      server.put('issuePanelArtifact', 'uploaded-photo', {
        id: 'uploaded-photo',
        issueId: 'i1',
        position: 1,
        path: 'photo.png',
        addedAt: '2026-11-17T12:00:00.000Z',
        chatUploadId: 'upload-id',
        artifactId: 'stored-photo',
      })
    },
  })
  devices.push(device)
  if (offline) device.offline()
  const read = () => chatUploadUrl(device.pool, 'chat', 'upload-id', 'https://example.com')
  const opened = device.observe(() => null, read)
  expect(read()).toBe(LOADING)
  await act(() => device.untilIdle())
  if (offline) {
    expect(device.pool.collections.reading(read())).toBe('offline')
    device.online()
    await act(() => device.untilIdle())
  }
  expect(read()).toBe('https://example.com/files/artifact/i1/stored-photo/photo.png')
  opened.close()
})

it('a description and brief the server refused say not available, never loading or empty (POD-7595)', async () => {
  const f = await fixture({ refuse: ['issueDescription.ofIssue', 'issueBrief.ofIssue'] })
  render(
    <>
      <IssueDescriptionPreview issue={f.issue} commands={f.commands} busy={false} />
      <IssueBrief issue={f.issue} />
    </>,
  )
  await act(() => f.device.untilIdle())
  expect(screen.getByLabelText('Description: Not available')).toBeTruthy()
  expect(screen.getByLabelText('Brief: Not available')).toBeTruthy()
  expect(screen.queryByText('Loading…')).toBeNull()
  expect(screen.queryByText('Add a description…')).toBeNull()
  expect(screen.queryByRole('textbox')).toBeNull()
  f.commands.commitDescription('Unsafe replacement')
  expect(f.updateIssue).not.toHaveBeenCalled()
  // Asked once, not again on every render.
  await act(() => f.device.untilIdle())
  expect(
    f.device.requestedKeys().filter((key) => key === 'issueDescription.ofIssue{"issueId":"i1"}'),
  ).toHaveLength(1)
})

it('a refused stored chat upload says not available and only holds its artifact body', async () => {
  const device = await openEmptyDevice({
    world(server) {
      putIssueWithBodies(server, 'i1')
      server.put('session', 'chat', {
        sessionId: 'chat',
        issueId: 'i1',
        agentKind: 'codex',
        status: 'live',
        cwd: '/synthetic',
        createdAt: '2026-11-17T12:00:00.000Z',
        lastActiveAt: '2026-11-17T12:00:00.000Z',
      })
      refuseCollections(server, (instance) => instance.collection === 'issuePanelArtifact.ofIssue')
    },
  })
  devices.push(device)
  state.pool = device.pool
  const read = () => chatUploadUrl(device.pool, 'chat', 'upload-id', 'https://example.com')
  const opened = device.observe(() => null, read)
  try {
    render(<ChatUploadPending sessionId="chat" label="photo.png" />)
    expect(screen.getByLabelText('photo.png: Loading…')).toBeTruthy()
    await act(() => device.untilIdle())
    expect(read()).toBe(LOADING)
    expect(screen.getByLabelText('photo.png: Not available')).toBeTruthy()
    expect(screen.queryByText('Loading…')).toBeNull()
    await act(() => device.untilIdle())
    expect(device.requestedKeys()).toEqual(['issuePanelArtifact.ofIssue{"issueId":"i1"}'])
  } finally {
    opened.close()
  }
})

it.each([
  ['issuePanelState.ofIssue', ['Current update']],
  ['issuePanelTodo.ofIssue', ['Artifacts', 'deferred', 'Offer artifacts']],
  ['issuePanelArtifact.ofIssue', ['Artifacts', 'deferred', 'Offer artifacts']],
  ['issuePanelDeferred.ofIssue', ['Artifacts', 'deferred', 'Offer artifacts']],
] as const)('a refused %s shows not available without retrying', async (collection, labels) => {
  const f = await fixture({ refuse: [collection] })
  const view = render(<BodySections {...f} />)
  await act(() => f.device.untilIdle())
  for (const label of labels) {
    const pending = screen.getByLabelText(`${label}: Not available`)
    expect(pending.getAttribute('aria-busy')).toBe('false')
  }
  expect(screen.queryByText('Loading…')).toBeNull()
  expect(screen.getByText(FULL_BODIES.description)).toBeTruthy()
  expect(screen.queryByText('No status posted yet.')).toBeNull()
  view.rerender(<BodySections {...f} />)
  await act(() => f.device.untilIdle())
  expect(
    f.device.requested().filter((instance) => instance.collection === collection),
  ).toHaveLength(1)
})
