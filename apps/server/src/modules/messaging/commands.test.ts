import type { SessionMeta } from '@podium/model'
import { describe, expect, it } from 'vitest'
import {
  buildIssuesMessage,
  formatActiveIssues,
  formatIssues,
  formatReadyIssues,
  formatRecentIssues,
  issueCallbackData,
  parseIssueCallbackData,
  parseSlashCommand,
  pickIssueSession,
} from './commands'
import { asIssueId, asSessionId, type IssueWire, type IssueWireInput } from '@podium/model'

function issue(partial: Partial<IssueWireInput> & Pick<IssueWire, 'id' | 'seq' | 'title'>): IssueWire {
  return {
    repoPath: '/p',
    description: '',
    stage: 'backlog',
    worktreePath: null,
    branch: null,
    parentBranch: '',
    defaultAgent: 'claude-code',
    defaultModel: 'auto',
    defaultEffort: 'auto',
    blockedByNotes: [],
    priority: 2,
    type: 'task',
    pinned: false,
    needsHuman: false,
    labels: [],
    deps: [],
    dependents: [],
    ready: false,
    blocked: false,
    deferred: false,
    childCount: 0,
    childDoneCount: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    archived: false,
    readAt: null,
    origin: 'human',
    audience: 'human',
    draft: false,
    ...partial,
  } as unknown as IssueWire
}

describe('parseSlashCommand', () => {
  it('parses known commands with optional bot suffix and args', () => {
    expect(parseSlashCommand('/help')).toEqual({ command: 'help', args: [] })
    expect(parseSlashCommand('/issues@PodiumBot active')).toEqual({
      command: 'issues',
      args: ['active'],
    })
    expect(parseSlashCommand('/STOP')).toEqual({ command: 'stop', args: [] })
  })

  it('returns null for plain text or unknown slash commands', () => {
    expect(parseSlashCommand('hello')).toBeNull()
    expect(parseSlashCommand('/model opus')).toBeNull()
    expect(parseSlashCommand('/')).toBeNull()
  })
})

describe('issue formatters', () => {
  const issues = [
    issue({
      id: asIssueId('a'),
      seq: 1,
      displayRef: 'POD-1',
      title: 'Done one',
      stage: 'done',
      updatedAt: '2026-07-16T12:00:00.000Z',
    }),
    issue({
      id: asIssueId('b'),
      seq: 2,
      displayRef: 'POD-2',
      title: 'In flight',
      stage: 'in_progress',
      updatedAt: '2026-07-15T12:00:00.000Z',
    }),
    issue({
      id: asIssueId('c'),
      seq: 3,
      displayRef: 'POD-3',
      title: 'Internal',
      stage: 'in_progress',
      audience: 'agent',
    }),
    issue({
      id: asIssueId('d'),
      seq: 4,
      displayRef: 'POD-4',
      title: 'Ready task',
      stage: 'backlog',
      ready: true,
      updatedAt: '2026-07-14T12:00:00.000Z',
    }),
  ]

  it('lists active open board issues with in_progress first', () => {
    const text = formatActiveIssues(issues)
    expect(text).toContain('POD-2 In flight (in progress)')
    expect(text).not.toContain('POD-1')
    expect(text).not.toContain('Internal')
  })

  it('lists recent issues including done', () => {
    const text = formatRecentIssues(issues)
    expect(text).toContain('POD-1')
    expect(text).toContain('Recent issues')
  })

  it('lists ready issues only', () => {
    const text = formatReadyIssues(issues)
    expect(text).toContain('POD-4 Ready task')
    expect(text).not.toContain('POD-2')
  })

  it('dispatches formatIssues by mode', () => {
    expect(formatIssues(issues, 'active')).toContain('Active issues')
    expect(formatIssues(issues, 'recent')).toContain('Recent issues')
    expect(formatIssues(issues, 'bogus')).toContain('Usage:')
  })

  it('builds one inline button per listed issue', () => {
    const built = buildIssuesMessage(issues, 'active')
    expect(built.text).toContain('POD-2')
    expect(built.buttons).toEqual([
      [{ label: 'POD-2 In flight', data: issueCallbackData('b') }],
      [{ label: 'POD-4 Ready task', data: issueCallbackData('d') }],
    ])
  })

  it('round-trips issue callback data', () => {
    expect(parseIssueCallbackData(issueCallbackData('iss_abc'))).toBe('iss_abc')
    expect(parseIssueCallbackData('nope')).toBeUndefined()
  })

  it('picks the live session for btw wiring', () => {
    // `sessions` left `IssueWire` with the POD-797 embed removal, and
    // `pickIssueSession` already takes the HELD list as its own argument — so the
    // fixture states the two separately instead of nesting one inside the other.
    const withSessions = issue({ id: asIssueId('e'), seq: 5, title: 'Epic' })
    const held = [
        {
          sessionId: asSessionId('old'),
          issueId: asIssueId('e'),
          agentKind: 'grok',
          title: 'old',
          cwd: '/p',
          status: 'exited',
          controllerId: null,
          geometry: { cols: 80, rows: 24 },
          epoch: 0,
          clientCount: 0,
          createdAt: '2026-01-01T00:00:00.000Z',
          lastActiveAt: '2026-07-10T00:00:00.000Z',
          origin: { kind: 'spawn' },
          archived: false,
          readAt: null,
          unread: false,
        },
        {
          sessionId: asSessionId('live'),
          issueId: asIssueId('e'),
          agentKind: 'grok',
          title: 'live',
          cwd: '/p',
          status: 'live',
          controllerId: null,
          geometry: { cols: 80, rows: 24 },
          epoch: 0,
          clientCount: 0,
          createdAt: '2026-01-01T00:00:00.000Z',
          lastActiveAt: '2026-07-16T00:00:00.000Z',
          origin: { kind: 'spawn' },
          archived: false,
          readAt: null,
          unread: false,
        },
    ] as SessionMeta[]
    // The held-session list is now a SEPARATE argument: membership moved off the
    // embedded array, so the caller supplies the sessions it holds.
    expect(pickIssueSession(withSessions, held)?.sessionId).toBe('live')
  })
})
