import type { AgentRuntimeState, SessionMeta, SessionMetaInput } from '@podium/model'
import { describe, expect, it } from 'vitest'
import {
  isUnstartedSession,
  rowErrorLine,
  rowHasWorkingSession,
  rowMotionPhase,
  rowMotionTiming,
  rowPendingDecision,
  rowStatusLine,
  rowWaitingCount,
  type UnifiedWorkRow,
} from './index'

const NOW = Date.parse('2026-07-06T12:00:00.000Z')

function sess(over: Partial<SessionMetaInput> = {}): SessionMeta {
  return {
    sessionId: `s-${Math.random().toString(36).slice(2, 8)}`,
    cwd: '/r/acme',
    lastActiveAt: new Date(NOW - 3_600_000).toISOString(),
    agentKind: 'claude-code',
    status: 'live',
    busy: false,
    archived: false,
    title: 'some title',
    ...over,
  } as unknown as SessionMeta
}

function agentState(over: Partial<AgentRuntimeState>): AgentRuntimeState {
  return {
    phase: 'unknown',
    since: new Date(NOW - 60_000).toISOString(),
    nativeSubagentCount: 0,
    ...over,
  } as AgentRuntimeState
}

const working = (over: Partial<AgentRuntimeState> = {}) =>
  sess({ agentState: agentState({ phase: 'working', ...over }) })
const waiting = (over: Partial<AgentRuntimeState> = {}) =>
  sess({ agentState: agentState({ phase: 'needs_user', need: { kind: 'question' }, ...over }) })
const done = (over: Partial<AgentRuntimeState> = {}) =>
  sess({ agentState: agentState({ phase: 'idle', idle: { kind: 'done' }, ...over }) })
const errored = (cls = 'overloaded', over: Partial<SessionMetaInput> = {}) =>
  sess({
    agentState: agentState({ phase: 'errored', error: { class: cls, retryable: false } }),
    ...over,
  })

const offered = () =>
  sess({
    offer: {
      message: 'Ready for your decision',
      actions: [{ label: 'Merge', prompt: 'Merge it' }],
      createdAt: new Date(NOW - 30_000).toISOString(),
    },
    agentState: agentState({ phase: 'idle', idle: { kind: 'done' } }),
  })
function issueRow(
  sessions: SessionMeta[],
  draft = false,
  issueOver: Record<string, unknown> = {},
): Extract<UnifiedWorkRow, { kind: 'issue' }> {
  return {
    kind: 'issue',
    issue: {
      id: 'i1',
      updatedAt: new Date(NOW).toISOString(),
      stage: 'in_progress',
      childCount: 0,
      childDoneCount: 0,
      draft,
      ...issueOver,
    },
    sessions,
    activityAt: NOW - 120_000,
  } as unknown as Extract<UnifiedWorkRow, { kind: 'issue' }>
}

describe('rowMotionPhase — aggregate row phase (#41)', () => {
  it('waiting dominates working; finished turns only make closed tasks done', () => {
    expect(rowMotionPhase(issueRow([working(), waiting()]))).toBe('waiting')
    expect(rowMotionPhase(issueRow([working(), done()]))).toBe('working')
    const parkedFinishedTurn = { ...done(), status: 'hibernated' as const }
    expect(rowMotionPhase(issueRow([parkedFinishedTurn], false, { stage: 'in_progress' }))).toBe(
      'queued',
    )
    expect(rowMotionPhase(issueRow([done(), done()], false, { stage: 'done' }))).toBe('done')
  })

  it('finished branch delta becomes ready-to-merge attention until it lands', () => {
    const closedAt = new Date(NOW - 3_600_000).toISOString()
    const row = issueRow([done()], false, {
      stage: 'done',
      branch: 'issue/1-reviewable',
      closedAt,
      gitState: {
        updatedAt: new Date(NOW).toISOString(),
        branch: 'issue/1-reviewable',
        shared: false,
        ahead: 2,
        dirtyFiles: 0,
      },
    })
    expect(rowMotionPhase(row)).toBe('waiting')
    expect(rowWaitingCount(row)).toBe(1)
    expect(rowStatusLine(row, NOW)).toBe('ready to merge · 2')
    expect(rowMotionTiming(row)).toMatchObject({ phase: 'waiting', sinceMs: NOW - 3_600_000 })

    const landed = issueRow([done()], false, {
      ...row.issue,
      gitState: { ...row.issue.gitState, merged: true },
    })
    expect(rowMotionPhase(landed)).toBe('done')
    const empty = issueRow([done()], false, {
      ...row.issue,
      gitState: { ...row.issue.gitState, ahead: 0 },
    })
    expect(rowMotionPhase(empty)).toBe('done')
  })

  // POD-279: a review queue is not one undifferentiated "needs you" — most of
  // it is a branch waiting to land, and the row must say which.
  describe('pending decision on a review-stage issue', () => {
    const reviewIssue = (over: Record<string, unknown> = {}) => ({
      stage: 'review',
      branch: 'issue/9-reviewable',
      gitState: {
        updatedAt: new Date(NOW).toISOString(),
        branch: 'issue/9-reviewable',
        shared: false,
        ahead: 3,
        dirtyFiles: 0,
      },
      ...over,
    })

    it('reads "ready to merge" with its commit count when the branch has unlanded work', () => {
      const row = issueRow([done()], false, reviewIssue())
      expect(rowPendingDecision(row)).toBe('merge')
      expect(rowMotionPhase(row)).toBe('waiting')
      expect(rowWaitingCount(row)).toBe(1)
      expect(rowStatusLine(row, NOW)).toBe('ready to merge · 3')
    })

    it('reads "needs review" when there is nothing to land', () => {
      // A design/doc/artifact deliverable, and work already merged: both are a
      // review decision, neither is a merge.
      for (const git of [
        undefined,
        { ...reviewIssue().gitState, merged: true },
        { ...reviewIssue().gitState, ahead: 0 },
      ]) {
        const row = issueRow([done()], false, reviewIssue({ gitState: git }))
        expect(rowPendingDecision(row)).toBe('review')
        expect(rowStatusLine(row, NOW)).toBe('needs review')
      }
    })

    it('survives a consumed offer — the decision is derived from stage + git, not the offer', () => {
      // An offer is eaten by any user turn into that session; a merge queue
      // that depended on it would silently empty itself (cf. POD-118).
      const row = issueRow([done()], false, reviewIssue())
      expect(row.sessions.every((s) => s.offer === undefined)).toBe(true)
      expect(rowStatusLine(row, NOW)).toBe('ready to merge · 3')
    })

    it('goes quiet while the agent is running again', () => {
      // Sent back / follow-up turn: the decision returns when the turn settles.
      const row = issueRow([working()], false, reviewIssue())
      expect(rowPendingDecision(row)).toBeNull()
      expect(rowMotionPhase(row)).toBe('working')
      expect(rowStatusLine(row, NOW)).toBe('review')
    })

    it('leaves pre-review stages alone', () => {
      for (const stage of ['backlog', 'planning', 'in_progress']) {
        expect(rowPendingDecision(issueRow([done()], false, reviewIssue({ stage })))).toBeNull()
      }
    })

    // POD-1280: the badge said 2 where the row named ONE ask. A review-stage
    // issue counts its own decision, and the agent prime tells that same agent
    // to post an offer when it moves the issue to `review` — so the offer's
    // needs-you counted the identical decision a second time.
    describe('an offer that IS the review ask counts once', () => {
      it('does not double the count when the agent offered its review verdict', () => {
        const row = issueRow([offered()], false, reviewIssue())
        expect(rowPendingDecision(row)).toBe('merge')
        expect(rowMotionPhase(row)).toBe('waiting')
        expect(rowWaitingCount(row)).toBe(1)
      })

      it('still counts a real need on top — a verdict does not answer a question', () => {
        // Offer AND an unanswered question: two separate things to do.
        const asking = sess({
          offer: {
            message: 'Ready for your decision',
            actions: [{ label: 'Merge', prompt: 'Merge it' }],
            createdAt: new Date(NOW - 30_000).toISOString(),
          },
          agentState: agentState({ phase: 'needs_user', need: { kind: 'question' } }),
        })
        expect(rowWaitingCount(issueRow([asking], false, reviewIssue()))).toBe(2)
      })

      it('leaves an offer alone when the issue itself is not asking anything', () => {
        // Nothing else counts this ask, so the offer is the whole of the count.
        expect(rowWaitingCount(issueRow([offered()], false, { stage: 'in_progress' }))).toBe(1)
      })

      it('dedupes at the issue that owns the session, not just the visible row', () => {
        // The parent rolls up the child's sessions; the decision is the child's.
        const child = issueRow([offered()], false, reviewIssue({ id: 'child' }))
        const parent = {
          ...issueRow([], false, { id: 'parent', stage: 'in_progress' }),
          startedByChildren: [child],
          aggregateSessions: child.sessions,
        } as unknown as Extract<UnifiedWorkRow, { kind: 'issue' }>
        expect(rowWaitingCount(parent)).toBe(1)
      })
    })

    // POD-1193: `review` is a stage an agent sets on ITSELF, and the row prints
    // it as an ask aimed at the operator. When the agent then hopped to a
    // spin-off, nobody is waiting on that verdict — and the sidebar has no
    // control that could ever clear it, so the amber was permanent.
    describe('the work carried on somewhere else', () => {
      const continued = (over: Record<string, unknown> = {}) => ({
        ...issueRow([], false, reviewIssue({ gitState: undefined, ...over })),
        continuation: 'continued · POD-1192',
      })

      it('withdraws the ask and says where the work went instead', () => {
        const row = continued()
        expect(rowPendingDecision(row)).toBeNull()
        expect(rowMotionPhase(row)).not.toBe('waiting')
        expect(rowWaitingCount(row)).toBe(0)
        expect(rowStatusLine(row, NOW)).toBe('continued · POD-1192')
      })

      it('never cancels a MERGE — unlanded commits stay unlanded', () => {
        // That decision has a control that ends it, and where its author went
        // has no bearing on whether the commits reached the parent branch.
        const row = { ...continued({ gitState: reviewIssue().gitState }) }
        expect(rowPendingDecision(row)).toBe('merge')
        expect(rowStatusLine(row, NOW)).toBe('ready to merge · 3')
      })

      it('does not outrank a live agent on the branch', () => {
        // Agent activity is a separate signal. The task still says where its
        // work went.
        const row = { ...continued(), sessions: [working()] }
        expect(rowStatusLine(row, NOW)).toBe('continued · POD-1192')
      })
    })
  })

  it('idle-ready or empty rows read queued (dimmed stillness)', () => {
    expect(rowMotionPhase(issueRow([sess()]))).toBe('queued')
    expect(rowMotionPhase(issueRow([]))).toBe('queued')
  })
})

describe('rowWaitingCount — the amber pill / rail badge number', () => {
  it('counts exactly the waiting member sessions', () => {
    expect(rowWaitingCount(issueRow([waiting(), waiting(), working(), done()]))).toBe(2)
    expect(rowWaitingCount(issueRow([working()]))).toBe(0)
  })
  it('counts a completed session with a pending offer as waiting', () => {
    expect(rowWaitingCount(issueRow([offered()]))).toBe(1)
  })

  it('ignores a stale offer once the issue is closed (POD-290)', () => {
    expect(
      rowWaitingCount(
        issueRow([offered()], false, {
          stage: 'done',
          closedReason: 'done',
          closedAt: '2026-07-23T09:00:00.000Z',
        }),
      ),
    ).toBe(0)
  })
})

describe('rowStatusLine — task status, separate from agent activity', () => {
  it('keeps agent activity out of a leaf task status', () => {
    expect(rowStatusLine(issueRow([waiting()]), NOW)).toBe('in progress')
    expect(rowStatusLine(issueRow([waiting(), done()]), NOW)).toBe('in progress')
    const row = issueRow([waiting(), working(), done()])
    expect(rowMotionPhase(row)).toBe('waiting')
    expect(rowHasWorkingSession(row)).toBe(true)
    expect(rowStatusLine(row, NOW)).toBe('in progress')
    expect(rowStatusLine(issueRow([offered(), working()]), NOW)).toBe('in progress')
    expect(rowHasWorkingSession(issueRow([waiting(), done()]))).toBe(false)
  })

  it('keeps an offer as attention without replacing the task stage', () => {
    expect(rowStatusLine(issueRow([offered()]), NOW)).toBe('in progress')
    expect(rowMotionTiming(issueRow([offered()]))).toMatchObject({
      phase: 'waiting',
      sinceMs: NOW - 30_000,
    })
  })

  it('reads the leaf task stage regardless of the agent turn state', () => {
    expect(rowStatusLine(issueRow([working()]), NOW)).toBe('in progress')
    expect(rowStatusLine(issueRow([done()], false, { stage: 'in_progress' }), NOW)).toBe(
      'in progress',
    )
    expect(rowStatusLine(issueRow([done()], false, { stage: 'done' }), NOW)).toBe('done')
    expect(rowMotionPhase(issueRow([sess()]))).toBe('queued')
    expect(rowStatusLine(issueRow([sess()]), NOW)).toBe('in progress')
    expect(rowStatusLine(issueRow([working(), working()]), NOW)).toBe('in progress')
  })

  it('derives a container task status from its child-task rollup', () => {
    const container = (progress: {
      total: number
      done: number
      run: number
      review: number
      stall: number
      block: number
      wait: number
    }) => ({
      ...issueRow([done()], false, { stage: 'in_progress', childCount: progress.total }),
      missionRollup: { progress, fromChildren: true },
    })
    expect(
      rowStatusLine(
        container({ total: 3, done: 1, run: 1, review: 0, stall: 0, block: 0, wait: 1 }),
        NOW,
      ),
    ).toBe('1/3 subtasks done · 1 underway')
    expect(
      rowStatusLine(
        container({ total: 2, done: 0, run: 0, review: 0, stall: 0, block: 1, wait: 1 }),
        NOW,
      ),
    ).toBe('0/2 subtasks done · 1 blocked')
    expect(
      rowStatusLine(
        container({ total: 2, done: 2, run: 0, review: 0, stall: 0, block: 0, wait: 0 }),
        NOW,
      ),
    ).toBe('2/2 subtasks done')
  })

  // POD-1601 — the case the whole change is for. An agent that moved its issue
  // to `review` and then died on the next turn satisfied BOTH readings, and the
  // row printed the stage's: `needs review`, a verdict nobody is waiting for,
  // over a corpse it never mentioned.
  describe('an agent that stopped on an error', () => {
    const reviewIssue = { stage: 'review', branch: 'issue/9-reviewable' }

    it('keeps the task decision as status while exposing the agent error separately', () => {
      const row = issueRow([errored()], false, reviewIssue)
      expect(rowPendingDecision(row)).toBe('review')
      expect(rowErrorLine(row)).toBe('agent overloaded')
      expect(rowStatusLine(row, NOW)).toBe('needs review')
    })

    it('beats a merge decision too', () => {
      const row = issueRow([errored()], false, {
        ...reviewIssue,
        gitState: {
          updatedAt: new Date(NOW).toISOString(),
          branch: 'issue/9-reviewable',
          shared: false,
          ahead: 3,
          dirtyFiles: 0,
        },
      })
      expect(rowPendingDecision(row)).toBe('merge')
      expect(rowStatusLine(row, NOW)).toBe('ready to merge · 3')
    })

    // `unknown` is the harness admitting it could not classify the failure, and
    // an unmapped class is one nobody has written words for yet. Neither may
    // reach the row as a raw token.
    it.each([
      ['unknown'],
      ['error'],
      ['max_output_tokens_typo'],
    ])('falls back to a plain sentence for the %s class', (cls) => {
      expect(rowErrorLine(issueRow([errored(cls)]))).toBe('agent errored')
      expect(rowStatusLine(issueRow([errored(cls)]), NOW)).toBe('in progress')
    })

    // The row's line-2 grammar is lower case throughout — it sits beside
    // `needs answer` and `ready to merge`, not at the head of a sentence.
    it('keeps the row grammar lower case', () => {
      expect(rowErrorLine(issueRow([errored('rate_limit')]))).toBe('rate limited')
      expect(rowErrorLine(issueRow([errored('max_output_tokens')]))).toBe('hit the output limit')
    })

    it('does not let a live teammate replace the task stage either', () => {
      expect(rowStatusLine(issueRow([errored(), working()]), NOW)).toBe('in progress')
    })

    it('says nothing once the task is closed', () => {
      const row = issueRow([errored()], false, { stage: 'done' })
      expect(rowErrorLine(row)).toBeNull()
    })

    it('is silent about a session that is no longer on the task', () => {
      expect(rowErrorLine(issueRow([errored('overloaded', { archived: true })]))).toBeNull()
    })
  })

  it('a draft vessel with only unstarted sessions reads "awaiting first prompt", not "idle"', () => {
    const fresh = sess({ title: '✳ Claude Code' })
    expect(rowStatusLine(issueRow([fresh], true), NOW)).toBe('awaiting first prompt')
    expect(rowStatusLine(issueRow([fresh]), NOW)).toBe('in progress')
    expect(rowStatusLine(issueRow([sess()], true), NOW)).toBe('in progress')
  })
})

describe('isUnstartedSession — blank-vessel detection', () => {
  it('boot-noise titles (harness name, cwd basename, empty) with no user name are unstarted', () => {
    expect(isUnstartedSession(sess({ title: '✳ Claude Code' }))).toBe(true)
    expect(isUnstartedSession(sess({ title: 'Claude' }))).toBe(true)
    expect(isUnstartedSession(sess({ title: '' }))).toBe(true)
    expect(isUnstartedSession(sess({ title: 'acme', agentKind: 'codex' }))).toBe(true)
  })

  it('a user-set name or a real title means the session has started', () => {
    expect(isUnstartedSession(sess({ title: '✳ Claude Code', name: 'My task' }))).toBe(false)
    expect(isUnstartedSession(sess({ title: '✳ Fix login popup' }))).toBe(false)
  })
})

describe('rowMotionTiming — the line-2 timer inputs', () => {
  it('working rows count from the EARLIEST working start, carrying its base total', () => {
    const early = working({ since: new Date(NOW - 300_000).toISOString(), workingMsTotal: 42_000 })
    const late = working({ since: new Date(NOW - 60_000).toISOString() })
    const t = rowMotionTiming(issueRow([late, early]))
    expect(t.phase).toBe('working')
    expect(t.sinceMs).toBe(NOW - 300_000)
    expect(t.baseMs).toBe(42_000)
  })

  it('waiting rows freeze at the longest wait', () => {
    const shortWait = waiting({ since: new Date(NOW - 60_000).toISOString() })
    const longWait = waiting({ since: new Date(NOW - 7_200_000).toISOString() })
    const t = rowMotionTiming(issueRow([shortWait, longWait, working()]))
    expect(t.phase).toBe('waiting')
    expect(t.sinceMs).toBe(NOW - 7_200_000)
  })

  it('done rows sum every member total for the ∑ stamp; totals absent → none', () => {
    const a = done({ workingMsTotal: 30_000 })
    const b = done({ workingMsTotal: 12_000 })
    expect(rowMotionTiming(issueRow([a, b], false, { stage: 'done' })).totalMs).toBe(42_000)
    expect(rowMotionTiming(issueRow([done()], false, { stage: 'done' })).totalMs).toBeUndefined()
  })

  it('queued rows fall back to the row activity stamp', () => {
    const t = rowMotionTiming(issueRow([sess()]))
    expect(t.phase).toBe('queued')
    expect(t.sinceMs).toBe(NOW - 120_000)
  })
})
