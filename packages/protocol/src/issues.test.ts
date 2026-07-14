import { describe, expect, it } from 'vitest'
import { ISSUE_STAGES, IssueStage, IssueWire, RepoOp, ServerMessage } from './messages'

describe('issue protocol types', () => {
  it('has the five ordered stages', () => {
    expect(ISSUE_STAGES).toEqual(['backlog', 'planning', 'in_progress', 'review', 'done'])
    expect(IssueStage.parse('review')).toBe('review')
    expect(IssueStage.safeParse('verifying').success).toBe(false)
  })

  it('parses an IssueWire with derived members', () => {
    const wire = IssueWire.parse({
      id: 'iss_1',
      repoPath: '/r',
      seq: 1,
      title: 'X',
      description: '',
      stage: 'backlog',
      worktreePath: null,
      branch: null,
      parentBranch: 'main',
      defaultAgent: 'claude-code',
      defaultModel: 'auto',
      defaultEffort: 'auto',
      blockedBy: [],
      priority: 2,
      type: 'task',
      pinned: false,
      needsHuman: false,
      labels: [],
      deps: [],
      dependents: [],
      comments: [],
      ready: true,
      blocked: false,
      deferred: false,
      childCount: 0,
      childDoneCount: 0,
      createdAt: 't',
      updatedAt: 't',
      archived: false,
      sessions: [],
      sessionSummary: { total: 0, byPhase: {} },
    })
    expect(wire.stage).toBe('backlog')
    expect(wire.worktreePath).toBeNull()
  })

  it('accepts the additive node⇄hub fields (viaHub/upstreamStale/pendingSync)', () => {
    const base = {
      id: 'iss_1',
      repoPath: '/r',
      seq: 1,
      title: 'X',
      description: '',
      stage: 'backlog',
      worktreePath: null,
      branch: null,
      parentBranch: 'main',
      defaultAgent: 'claude-code',
      defaultModel: 'auto',
      defaultEffort: 'auto',
      blockedBy: [],
      priority: 2,
      type: 'task',
      pinned: false,
      needsHuman: false,
      labels: [],
      deps: [],
      dependents: [],
      comments: [],
      ready: true,
      blocked: false,
      deferred: false,
      childCount: 0,
      childDoneCount: 0,
      createdAt: 't',
      updatedAt: 't',
      archived: false,
      sessions: [],
      sessionSummary: { total: 0, byPhase: {} },
    }
    // Absent = a local issue (today's wire, byte-identical).
    const local = IssueWire.parse(base)
    expect(local.viaHub).toBeUndefined()
    expect(local.upstreamStale).toBeUndefined()
    expect(local.pendingSync).toBeUndefined()
    // Present = a hub-mirrored issue, possibly stale and/or with a queued edit.
    const mirrored = IssueWire.parse({
      ...base,
      viaHub: true,
      upstreamStale: true,
      pendingSync: true,
    })
    expect(mirrored.viaHub).toBe(true)
    expect(mirrored.upstreamStale).toBe(true)
    expect(mirrored.pendingSync).toBe(true)
  })

  // Unread state (issue #124): readAt + unread are additive, defaulted so pre-field
  // cached payloads still validate (readAt → null, unread → false).
  it('defaults readAt=null and unread=false for a pre-field IssueWire payload', () => {
    const base = {
      id: 'iss_1',
      repoPath: '/r',
      seq: 1,
      title: 'X',
      description: '',
      stage: 'backlog',
      worktreePath: null,
      branch: null,
      parentBranch: 'main',
      defaultAgent: 'claude-code',
      defaultModel: 'auto',
      defaultEffort: 'auto',
      blockedBy: [],
      priority: 2,
      type: 'task',
      pinned: false,
      needsHuman: false,
      labels: [],
      deps: [],
      dependents: [],
      comments: [],
      ready: true,
      blocked: false,
      deferred: false,
      childCount: 0,
      childDoneCount: 0,
      createdAt: 't',
      updatedAt: 't',
      archived: false,
      sessions: [],
      sessionSummary: { total: 0, byPhase: {} },
    }
    const parsed = IssueWire.parse(base)
    expect(parsed.readAt).toBeNull()
    expect(parsed.unread).toBe(false)
    // Present + malformed values both resolve to the documented shape.
    const present = IssueWire.parse({ ...base, readAt: '2026-06-03T00:00:00.000Z', unread: true })
    expect(present.readAt).toBe('2026-06-03T00:00:00.000Z')
    expect(present.unread).toBe(true)
    const malformed = IssueWire.parse({ ...base, readAt: 5, unread: 'nope' })
    expect(malformed.readAt).toBeNull()
    expect(malformed.unread).toBe(false)
  })

  // Issue colour [spec:SP-b4d1]: an additive optional slot NAME ('rose' … 'lime',
  // never a hex). Absent = no colour; an unknown value from a newer peer degrades
  // to unset instead of failing the whole issue.
  it('parses the optional colour slot and drops unknown values (issue #38)', () => {
    const base = {
      id: 'iss_1',
      repoPath: '/r',
      seq: 1,
      title: 'X',
      description: '',
      stage: 'backlog',
      worktreePath: null,
      branch: null,
      parentBranch: 'main',
      defaultAgent: 'claude-code',
      defaultModel: 'auto',
      defaultEffort: 'auto',
      blockedBy: [],
      priority: 2,
      type: 'task',
      pinned: false,
      needsHuman: false,
      labels: [],
      deps: [],
      dependents: [],
      ready: true,
      blocked: false,
      deferred: false,
      childCount: 0,
      childDoneCount: 0,
      createdAt: 't',
      updatedAt: 't',
      archived: false,
      sessions: [],
      sessionSummary: { total: 0, byPhase: {} },
    }
    expect(IssueWire.parse(base).color).toBeUndefined()
    expect(IssueWire.parse({ ...base, color: 'violet' }).color).toBe('violet')
    // Not a slot name — hexes and future/unknown slots degrade to unset.
    expect(IssueWire.parse({ ...base, color: '#8b5cf6' }).color).toBeUndefined()
    expect(IssueWire.parse({ ...base, color: 'amber' }).color).toBeUndefined()
  })

  // #175: comment bodies left the wire. `comments` is a deprecated optional
  // (old payloads/hubs may still send it); `commentCount` is the additive
  // replacement, also optional so pre-#175 payloads keep parsing (wire v1).
  it('parses an IssueWire without comments and with commentCount (#175)', () => {
    const base = {
      id: 'iss_1',
      repoPath: '/r',
      seq: 1,
      title: 'X',
      description: '',
      stage: 'backlog',
      worktreePath: null,
      branch: null,
      parentBranch: 'main',
      defaultAgent: 'claude-code',
      defaultModel: 'auto',
      defaultEffort: 'auto',
      blockedBy: [],
      priority: 2,
      type: 'task',
      pinned: false,
      needsHuman: false,
      labels: [],
      deps: [],
      dependents: [],
      ready: true,
      blocked: false,
      deferred: false,
      childCount: 0,
      childDoneCount: 0,
      createdAt: 't',
      updatedAt: 't',
      archived: false,
      sessions: [],
      sessionSummary: { total: 0, byPhase: {} },
    }
    // Current server shape: no comments array, a count instead.
    const counted = IssueWire.parse({ ...base, commentCount: 3 })
    expect(counted.commentCount).toBe(3)
    expect(counted.comments).toBeUndefined()
    // Pre-#175 payload: embedded comments, no count — still parses (leniency).
    const legacy = IssueWire.parse({
      ...base,
      comments: [{ id: 'cmt_1', author: 'me', body: 'hi', createdAt: 't' }],
    })
    expect(legacy.commentCount).toBeUndefined()
    expect(legacy.comments).toHaveLength(1)
    // Bare payload with neither field parses too.
    expect(() => IssueWire.parse(base)).not.toThrow()
  })

  it('accepts the new write RepoOps', () => {
    expect(RepoOp.parse('rebase')).toBe('rebase')
    expect(RepoOp.parse('mergeFfOnly')).toBe('mergeFfOnly')
    expect(RepoOp.parse('prCreate')).toBe('prCreate')
  })

  it('accepts the cleanup RepoOps (issue #71)', () => {
    expect(RepoOp.parse('worktreeRemove')).toBe('worktreeRemove')
    expect(RepoOp.parse('branchDelete')).toBe('branchDelete')
    expect(RepoOp.parse('isMergedInto')).toBe('isMergedInto')
  })

  it('round-trips issue broadcast messages', () => {
    const issue = IssueWire.parse({
      id: 'iss_1',
      repoPath: '/r',
      seq: 1,
      title: 'X',
      description: '',
      stage: 'planning',
      worktreePath: '/r/wt',
      branch: 'issue/1-x',
      parentBranch: 'main',
      defaultAgent: 'claude-code',
      defaultModel: 'auto',
      defaultEffort: 'auto',
      blockedBy: [],
      priority: 2,
      type: 'task',
      pinned: false,
      needsHuman: false,
      labels: [],
      deps: [],
      dependents: [],
      comments: [],
      ready: true,
      blocked: false,
      deferred: false,
      childCount: 0,
      childDoneCount: 0,
      createdAt: 't',
      updatedAt: 't',
      archived: false,
      sessions: [],
      sessionSummary: { total: 0, byPhase: {} },
    })
    expect(ServerMessage.parse({ type: 'issuesChanged', issues: [issue] }).type).toBe(
      'issuesChanged',
    )
    expect(ServerMessage.parse({ type: 'issueUpdated', issue }).type).toBe('issueUpdated')
  })
})
