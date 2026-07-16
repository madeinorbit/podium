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
import type { IssueWire } from '@podium/protocol'

function issue(partial: Partial<IssueWire> & Pick<IssueWire, 'id' | 'seq' | 'title'>): IssueWire {
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
    blockedBy: [],
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
    unread: false,
    origin: 'human',
    audience: 'human',
    draft: false,
    sessions: [],
    sessionSummary: { total: 0, byPhase: {} },
    ...partial,
  }
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
      id: 'a',
      seq: 1,
      displayRef: 'POD-1',
      title: 'Done one',
      stage: 'done',
      updatedAt: '2026-07-16T12:00:00.000Z',
    }),
    issue({
      id: 'b',
      seq: 2,
      displayRef: 'POD-2',
      title: 'In flight',
      stage: 'in_progress',
      updatedAt: '2026-07-15T12:00:00.000Z',
    }),
    issue({
      id: 'c',
      seq: 3,
      displayRef: 'POD-3',
      title: 'Internal',
      stage: 'in_progress',
      audience: 'agent',
    }),
    issue({
      id: 'd',
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
    const withSessions = issue({
      id: 'e',
      seq: 5,
      title: 'Epic',
      sessions: [
        {
          sessionId: 'old',
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
          origin: 'local',
          archived: false,
          readAt: null,
          unread: false,
        },
        {
          sessionId: 'live',
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
          origin: 'local',
          archived: false,
          readAt: null,
          unread: false,
        },
      ],
      sessionSummary: { total: 2, byPhase: {} },
    })
    expect(pickIssueSession(withSessions)?.sessionId).toBe('live')
  })
})