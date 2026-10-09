import type { IssueViewModel } from '@podium/client-core/replica'
import type { SessionView, SessionViewInput } from '@podium/client-core/session-values'
import { blockingCloseConcerns, issueCloseConcerns } from '@podium/client-core/values'
import { asIssueId, asSessionId } from '@podium/model'
import { describe, expect, it, vi } from 'vitest'
import type { MobileTrpc } from '../client/trpc'
import { issueCommands } from './issue-detail'

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
