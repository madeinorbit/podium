import type { IssueViewModel } from '@podium/client-core/replica'
import type { SessionView, SessionViewInput } from '@podium/client-core/session-values'
import { blockingCloseConcerns, issueCloseConcerns } from '@podium/client-core/values'
import { asIssueId, asSessionId } from '@podium/model'
import { describe, expect, it, vi } from 'vitest'
import type { MobileTrpc } from '../client/trpc'
import { issueCommands } from './issue-detail'

// ---------------------------------------------------------------------------
// The close guard's fork (POD-1129). The FACTS are tested where they live, in
// `client-core`'s `issue-close.test.ts`; what matters here is that this is the
// surface that decides between guarding and closing, and that it never closes
// silently over something the derivation raised.
// ---------------------------------------------------------------------------

const issue = (partial: Partial<IssueViewModel> = {}): IssueViewModel =>
  ({
    id: asIssueId('task'),
    repoPath: '/src/podium',
    seq: 1,
    priority: 2,
    stage: 'in_progress',
    title: 'A task',
    description: '',
    labels: [],
    deps: [],
    dependents: [],
    needsHuman: false,
    childCount: 0,
    childDoneCount: 0,
    parentBranch: 'main',
    archived: false,
    ...partial,
  }) as IssueViewModel

const session = (partial: Partial<SessionViewInput> = {}): SessionView =>
  ({
    sessionId: asSessionId('s'),
    issueId: asIssueId('task'),
    agentKind: 'codex',
    title: 'Agent',
    cwd: '/r/wt',
    status: 'live',
    controllerId: null,
    geometry: { cols: 80, rows: 24 },
    epoch: 0,
    clientCount: 1,
    createdAt: '2026-07-22T10:00:00.000Z',
    lastActiveAt: '2026-07-22T10:00:00.000Z',
    origin: { kind: 'spawn' },
    archived: false,
    readAt: null,
    unread: false,
    ...partial,
  }) as SessionView

function harness(
  over: { issue?: IssueViewModel; sessions?: SessionView[]; guarded?: boolean } = {},
) {
  const closeIssue = vi.fn(async () => ({}))
  const updateIssue = vi.fn(async () => ({}))
  const requestClose = vi.fn()
  const commands = issueCommands({
    trpc: {} as MobileTrpc,
    issue: over.issue ?? issue(),
    hasCloseBlockers: (id) => blockingCloseConcerns(issueCloseConcerns(over.issue ?? issue(),
      (over.sessions ?? []).filter(row => row.issueId === id))).length > 0,
    run: async (fn) => {
      await fn()
    },
    actions: { closeIssue, updateIssue } as never,
    ...(over.guarded === false ? {} : { requestClose }),
  })
  return { commands, closeIssue, updateIssue, requestClose }
}

const dirty = {
  updatedAt: '2026-07-23T10:00:00.000Z',
  branch: 'issue/1129',
  shared: false,
  dirtyFiles: 3,
  dirtyOwn: 3,
}

describe('selectStatus close guard', () => {
  it('closes on the press when the derivation found nothing at stake', async () => {
    const { commands, closeIssue, requestClose } = harness()

    commands.selectStatus('close:done')
    await vi.waitFor(() => expect(closeIssue).toHaveBeenCalledWith('task', 'done'))
    expect(requestClose).not.toHaveBeenCalled()
  })

  it('hands the close to the host when there is something to say', () => {
    const { commands, closeIssue, requestClose } = harness({ issue: issue({ gitState: dirty }) })

    commands.selectStatus('close:done')
    expect(requestClose).toHaveBeenCalledWith('done')
    expect(closeIssue).not.toHaveBeenCalled()
  })

  it('carries the ENDING to the guard, so the sheet can name the one it is confirming', () => {
    const { commands, requestClose } = harness({ issue: issue({ gitState: dirty }) })

    commands.selectStatus('close:wontfix')
    // The legacy spelling canonicalizes on the way in (POD-1074); the guard is
    // told what will actually be recorded, not what the menu row said.
    expect(requestClose).toHaveBeenCalledWith('cancelled')
  })

  it('counts only sessions attached to THIS task', () => {
    // The phone's whole membership rule is `session.issueId`, and it is the one
    // thing this layer contributes to the derivation — so both directions.
    const offer = { message: 'Pick one', actions: [], createdAt: 'now' }
    const mine = harness({ sessions: [session({ sessionId: asSessionId('mine'), offer })] })
    mine.commands.selectStatus('close:done')
    expect(mine.requestClose).toHaveBeenCalledWith('done')

    const theirs = harness({
      sessions: [
        session({ sessionId: asSessionId('other'), issueId: asIssueId('somewhere-else'), offer }),
      ],
    })
    theirs.commands.selectStatus('close:done')
    expect(theirs.requestClose).not.toHaveBeenCalled()
  })

  it('closes directly for a host with no sheet mounted, rather than dropping the press', async () => {
    // The desktop runner's posture: `requestClose` is optional, and a host that
    // cannot raise the guard must still be able to close.
    const { commands, closeIssue } = harness({ issue: issue({ gitState: dirty }), guarded: false })

    commands.selectStatus('close:done')
    await vi.waitFor(() => expect(closeIssue).toHaveBeenCalledWith('task', 'done'))
  })

  it('leaves a stage change alone — the guard belongs to closing', () => {
    const { commands, updateIssue, requestClose } = harness({ issue: issue({ gitState: dirty }) })

    commands.selectStatus('stage:review')
    expect(updateIssue).toHaveBeenCalledWith('task', { stage: 'review' })
    expect(requestClose).not.toHaveBeenCalled()
  })

  it('closeNow skips the guard, because the host has already shown it', async () => {
    const { commands, closeIssue, requestClose } = harness({ issue: issue({ gitState: dirty }) })

    commands.closeNow('done')
    await vi.waitFor(() => expect(closeIssue).toHaveBeenCalledWith('task', 'done'))
    expect(requestClose).not.toHaveBeenCalled()
  })
})
