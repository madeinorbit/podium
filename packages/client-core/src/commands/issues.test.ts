import type { IssueProjection } from '@podium/model'
import { asIssueId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { emptyWorkspace, openTab } from '../values'
import { harness, sessionId, myIssue } from './commands.test.fixture'
describe('engine action ownership boundary', () => {
  it('queues an offer dismissal through the Outbox, carrying the offer it names', async () => {
    const h = harness()

    await h.actions.dismissOffer(sessionId, '2026-08-06T12:00:00.000Z')

    // `offline: 'eligible'` by contract since POD-1110: "none of these" survives
    // an offline gap like every other row edit. The stamp rides the entry, so a
    // late replay meets the server's guard and is refused rather than clearing
    // whatever offer is standing by then.
    expect(h.queued).toEqual([
      {
        kind: 'dismissOffer',
        input: { sessionId, offerCreatedAt: '2026-08-06T12:00:00.000Z' },
      },
    ])
    // No second write: the queued entry IS the dismissal, not a mirror of one.
    expect(h.dismissOffer).not.toHaveBeenCalled()
  })
})

describe('tucking the task on screen leaves it (POD-2293)', () => {
  const issue = (id: string, parentId?: string) =>
    ({
      id: asIssueId(id),
      ...(parentId ? { parentId: asIssueId(parentId) } : {}),
    }) as unknown as IssueProjection
  const seeded = (selected = 'root') => {
    const h = harness()
    h.seed({
      issueProjections: [issue('root'), issue('child', 'root'), issue('other')],
      selectedIssueId: asIssueId(selected),
      selectedWorktree: '/wt',
      workspaces: {
        'mission:root': openTab(emptyWorkspace('mission:root'), 's-a', { permanent: true }),
      },
    })
    return { h, workspaces: h.state().workspaces }
  }

  it('enqueues the tuck, then clears only the task and keeps the view, worktree and tabs', async () => {
    const { h, workspaces } = seeded()

    await h.actions.setIssueTucked('root', true)

    // The tuck is a record edit of my own row (POD-6404).
    expect(h.queued.at(-1)).toMatchObject(myIssue('root', { tuckedAt: expect.any(String) }))
    expect(h.state().selectedIssueId).toBeNull()
    // The worktree stays: clearing it would hand over to the worktree fallback.
    expect(h.state().selectedWorktree).toBe('/wt')
    expect(h.navigated.at(-1)).toMatchObject({ view: 'issues' })
    expect(h.state().workspaces).toBe(workspaces)
  })

  it('leaves a sub-task on screen when its mission root is tucked', async () => {
    const { h } = seeded('child')

    await h.actions.setIssueTucked('root', true)

    expect(h.state().selectedIssueId).toBeNull()
  })

  it.each([
    ['a sub-task of the mission on screen', 'child', true],
    ['another task', 'other', true],
    ['the task on screen being brought back', 'root', false],
  ])('stays put when tucking %s', async (_case, id, tucked) => {
    const { h } = seeded()

    await h.actions.setIssueTucked(id, tucked)

    expect(h.state().selectedIssueId).toBe('root')
    expect(h.navigated).toEqual([])
  })
})
