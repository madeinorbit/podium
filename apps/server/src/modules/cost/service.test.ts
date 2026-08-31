/**
 * The cost read path, against the shapes the real corpus has (POD-1858).
 *
 * Three of the fixtures below are the three rollup shapes the design draws, and
 * they exist because a single "parent plus children" case hides both failures
 * that matter: a task that outspent all its children, and a task whose whole
 * figure IS its children.
 */

import type { IssueId, MachineId, SessionId, UsageSourceWire } from '@podium/model'
import { beforeEach, describe, expect, it } from 'vitest'
import { SessionStore } from '../../store'
import type { IssueRow, SessionRow } from '../../store/types'
import { CostService } from './service'

let store: SessionStore
let service: CostService
let machineId: MachineId

const CLAUDE_DIR = '/home/u/.claude/projects/-repo'

beforeEach(() => {
  store = new SessionStore(':memory:')
  service = new CostService(store)
  machineId = store.hostMachineId
})

// ── fixtures ────────────────────────────────────────────────────────────────

let seq = 0

function issue(over: Partial<IssueRow> = {}): IssueRow {
  seq += 1
  const row: IssueRow = {
    id: `iss_${seq}` as IssueId,
    ownerUserId: 'user:sole' as IssueRow['ownerUserId'],
    visibility: 'personal',
    createdByActor: 'user:sole',
    createdByOnBehalfOf: null,
    repoPath: '/repo',
    seq,
    title: `Issue ${seq}`,
    description: '',
    stage: 'in_progress',
    worktreePath: null,
    branch: null,
    parentBranch: 'main',
    defaultAgent: 'claude-code',
    defaultModel: 'auto',
    defaultEffort: 'auto',
    priority: 2,
    type: 'task',
    blockedBy: [],
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...over,
  } as IssueRow
  store.issues.upsertIssue(row)
  return row
}

function session(over: Partial<SessionRow> = {}): SessionRow {
  seq += 1
  const row: SessionRow = {
    id: `ses_${seq}` as SessionId,
    ownerUserId: 'user:sole' as SessionRow['ownerUserId'],
    agentKind: 'claude-code',
    cwd: '/repo',
    title: `Session ${seq}`,
    name: null,
    originKind: 'spawn',
    conversationId: null,
    resumeKind: 'claude-code',
    resumeValue: `native-${seq}`,
    status: 'hibernated',
    exitCode: null,
    durableLabel: `d${seq}`,
    createdAt: '2026-08-01T00:00:00.000Z',
    lastActiveAt: '2026-08-01T00:00:00.000Z',
    lastOutputAt: null,
    lastInputAt: null,
    lastResumedAt: null,
    archived: false,
    workState: null,
    machineId,
    ...over,
  }
  store.sessions.upsertSession(row)
  return row
}

/** A transcript on disk, indexed the way the conversation registry indexes one. */
function transcript(nativeId: string, opts: { parentNativeId?: string } = {}): string {
  const path = opts.parentNativeId
    ? `${CLAUDE_DIR}/${opts.parentNativeId}/subagents/${nativeId}.jsonl`
    : `${CLAUDE_DIR}/${nativeId}.jsonl`
  const parentPodiumId = opts.parentNativeId
    ? store.conversations.registry.podiumId(machineId, opts.parentNativeId)
    : undefined
  store.conversations.registry.ensure({
    machineId,
    nativeId,
    providerId: 'claude-code',
    path,
    ...(parentPodiumId ? { parentPodiumId } : {}),
  })
  return path
}

function source(path: string, over: Partial<UsageSourceWire> = {}): UsageSourceWire {
  const base: UsageSourceWire = {
    path,
    harness: 'claude-code',
    scannedBytes: 4_096,
    firstTsMs: Date.parse('2026-08-20T10:00:00.000Z'),
    lastTsMs: Date.parse('2026-08-20T12:00:00.000Z'),
    models: [
      {
        model: 'claude-opus-5',
        inputTokens: 1_000,
        outputTokens: 500,
        cacheReadTokens: 100_000,
        cacheCreationTokens: 2_000,
        cacheCreation1hTokens: 0,
        messages: 10,
      },
    ],
    windowModels: [],
    ...over,
  }
  // A fixture transcript is inside the window unless a test says otherwise.
  return { ...base, windowModels: over.windowModels ?? base.models }
}

/** The window every fixture harvest is taken over. */
const SINCE = Date.parse('2026-08-18T00:00:00.000Z')

const ingest = (sources: UsageSourceWire[], sinceMs = SINCE): number =>
  service.ingest(sources, sinceMs)

const tokensOf = (models: { inputTokens: number; outputTokens: number }[]) =>
  models.reduce((n, m) => n + m.inputTokens + m.outputTokens, 0)

// ── attribution ─────────────────────────────────────────────────────────────

describe('attribution', () => {
  it('resolves a transcript to its session and issue in one pass', () => {
    const task = issue()
    const ses = session({ issueId: task.id })
    const path = transcript(ses.resumeValue as string)

    expect(ingest([source(path)])).toBe(1)

    const cost = service.task(task.id)
    expect(cost.state).toBe('costed')
    expect(cost.own.sessionCount).toBe(1)
    expect(cost.own.messages).toBe(10)
    expect(cost.sessions[0]).toMatchObject({ sessionId: ses.id, title: ses.title })
  })

  // The subagent hop. On the real machine these files carried $85 of Claude
  // spend in one 7-day window, and none of it has a session row of its own.
  it('attributes a delegate transcript to the session that spawned it', () => {
    const task = issue()
    const ses = session({ issueId: task.id })
    const parentNativeId = ses.resumeValue as string
    transcript(parentNativeId)
    const child = transcript('agent-abc123', { parentNativeId })

    ingest([source(child)])

    const cost = service.task(task.id)
    expect(cost.own.messages).toBe(10)
    expect(cost.own.sessionCount).toBe(1)
  })

  it('drops a transcript that maps to no conversation at all', () => {
    const task = issue()
    session({ issueId: task.id })
    expect(ingest([source(`${CLAUDE_DIR}/nobody-indexed-this.jsonl`)])).toBe(0)
    expect(store.transcriptCosts.countAll()).toBe(0)
  })

  it('re-ingesting the same walk overwrites rather than accumulating', () => {
    const task = issue()
    const ses = session({ issueId: task.id })
    const path = transcript(ses.resumeValue as string)

    ingest([source(path)])
    ingest([source(path)])
    ingest([source(path)])

    expect(store.transcriptCosts.countAll()).toBe(1)
    expect(service.task(task.id).own.messages).toBe(10)
  })

  it('keeps a session whose transcript is not linked to any issue out of every task', () => {
    const task = issue()
    const orphan = session({ issueId: null })
    const path = transcript(orphan.resumeValue as string)
    ingest([source(path)])
    expect(service.task(task.id).state).toBe('no-sessions')
    expect(service.tasks()).toEqual([])
  })
})

// ── rollup ──────────────────────────────────────────────────────────────────

describe('rollup', () => {
  /** Give `task` one costed session worth `messages` replies. */
  const cost = (taskId: IssueId, messages: number): void => {
    const ses = session({ issueId: taskId })
    const path = transcript(ses.resumeValue as string)
    ingest([
      source(path, {
        models: [
          {
            model: 'claude-opus-5',
            inputTokens: messages * 100,
            outputTokens: messages * 10,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            cacheCreation1hTokens: 0,
            messages,
          },
        ],
      }),
    ])
  }

  // POD-1402's shape: the epic lead outspent all 32 children put together.
  it('returns own and rollup separately when the parent spent most of it', () => {
    const epic = issue()
    cost(epic.id, 100)
    for (let i = 0; i < 3; i += 1) cost(issue({ parentId: epic.id }).id, 10)

    const result = service.task(epic.id)
    expect(result.own.messages).toBe(100)
    expect(result.rollup.messages).toBe(130)
    expect(result.descendantCount).toBe(3)
  })

  // POD-1484's shape: no sessions of its own. Showing own cost renders it free.
  it('rolls up a parent that has no sessions of its own', () => {
    const epic = issue()
    const child = issue({ parentId: epic.id })
    cost(child.id, 40)

    const result = service.task(epic.id)
    expect(result.own).toMatchObject({ messages: 0, sessionCount: 0, models: [] })
    expect(result.rollup.messages).toBe(40)
    expect(result.state).toBe('costed')
  })

  // POD-1574's shape: no children, so own === rollup and no split is drawn.
  it('leaves own equal to rollup for a task with no children', () => {
    const solo = issue()
    cost(solo.id, 25)
    const result = service.task(solo.id)
    expect(result.own.messages).toBe(25)
    expect(result.rollup.messages).toBe(25)
    expect(result.descendantCount).toBe(0)
  })

  it('reaches grandchildren, and counts every descendant whether it cost anything or not', () => {
    const epic = issue()
    const mid = issue({ parentId: epic.id })
    const leaf = issue({ parentId: mid.id })
    issue({ parentId: mid.id }) // a descendant with no sessions at all
    cost(leaf.id, 7)

    const result = service.task(epic.id)
    expect(result.rollup.messages).toBe(7)
    expect(result.descendantCount).toBe(3)
  })
})

// ── the cold states and the marks ───────────────────────────────────────────

describe('states', () => {
  it('reads a task with no sessions as no-sessions, never a zero figure', () => {
    const task = issue()
    const result = service.task(task.id)
    expect(result.state).toBe('no-sessions')
    expect(result.rollup).toMatchObject({ models: [], messages: 0, sessionCount: 0 })
  })

  it('reads a session with no transcript on disk as not-recorded', () => {
    const task = issue()
    session({ issueId: task.id }) // no registry row: nothing to read
    expect(service.task(task.id).state).toBe('not-recorded')
  })

  it('reads an unread transcript as pending, not as not-recorded', () => {
    const task = issue()
    const ses = session({ issueId: task.id })
    transcript(ses.resumeValue as string) // indexed, never ingested
    expect(service.task(task.id).state).toBe('pending')
  })

  it('marks a running task provisional', () => {
    const task = issue()
    const ses = session({ issueId: task.id, status: 'live' })
    ingest([source(transcript(ses.resumeValue as string))])
    expect(service.task(task.id).provisional).toBe(true)
  })

  it('marks a Codex task a floor and an all-Claude task not', () => {
    const claudeTask = issue()
    const claudeSes = session({ issueId: claudeTask.id })
    ingest([source(transcript(claudeSes.resumeValue as string))])
    expect(service.task(claudeTask.id)).toMatchObject({
      floor: 'none',
      harnesses: ['claude-code'],
    })

    const codexTask = issue()
    const codexSes = session({ issueId: codexTask.id, agentKind: 'codex' })
    ingest([source(transcript(codexSes.resumeValue as string), { harness: 'codex' })])
    expect(service.task(codexTask.id)).toMatchObject({ floor: 'partial', harnesses: ['codex'] })
  })

  it('marks a mixed task a floor and names both harnesses', () => {
    const task = issue()
    const a = session({ issueId: task.id })
    const b = session({ issueId: task.id, agentKind: 'codex' })
    ingest([
      source(transcript(a.resumeValue as string)),
      source(transcript(b.resumeValue as string), { harness: 'codex' }),
    ])
    expect(service.task(task.id)).toMatchObject({
      floor: 'partial',
      harnesses: ['claude-code', 'codex'],
    })
  })
})

// ── the sheet's table ───────────────────────────────────────────────────────

describe('tasks()', () => {
  // Attributing an ALL-TIME per-task figure against the host's 7-DAY total is
  // how a sheet ends up claiming 123% attributed — measured, on this machine.
  it('reports the window and all-time folds separately', () => {
    const task = issue()
    const ses = session({ issueId: task.id })
    ingest([
      source(transcript(ses.resumeValue as string), {
        windowModels: [
          {
            model: 'claude-opus-5',
            inputTokens: 100,
            outputTokens: 50,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            cacheCreation1hTokens: 0,
            messages: 2,
          },
        ],
      }),
    ])
    const [row] = service.tasks()
    expect(row?.messages).toBe(10)
    expect(row?.windowMessages).toBe(2)
  })

  it('reads a row from an older harvest as nothing in the current window', () => {
    const stale = issue()
    const staleSes = session({ issueId: stale.id })
    ingest([source(transcript(staleSes.resumeValue as string))], SINCE - 7 * 24 * 3_600_000)

    const fresh = issue()
    const freshSes = session({ issueId: fresh.id })
    ingest([source(transcript(freshSes.resumeValue as string))])

    const rows = service.tasks()
    const staleRow = rows.find((r) => r.issueId === stale.id)
    const freshRow = rows.find((r) => r.issueId === fresh.id)
    // Both still carry their all-time figure; only the fresh one is in-window.
    expect(staleRow?.messages).toBe(10)
    expect(staleRow?.windowMessages).toBe(0)
    expect(freshRow?.windowMessages).toBe(10)
  })

  it('lists own cost per task, so a parent does not double-count its children', () => {
    const epic = issue()
    const child = issue({ parentId: epic.id })
    for (const target of [epic, child]) {
      const ses = session({ issueId: target.id })
      ingest([source(transcript(ses.resumeValue as string))])
    }
    const rows = service.tasks()
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.messages === 10)).toBe(true)
    expect(rows.map((r) => r.seq).sort()).toEqual([epic.seq, child.seq].sort())
  })
})

// ── the performance contract ────────────────────────────────────────────────

describe('the task-detail path never walks the disk', () => {
  /**
   * Measured before this work: a live scan is 856ms for ONE task and 69.9s for
   * all of them. The read below cannot do either, and this is how you can tell:
   * every stored path points at a file that DOES NOT EXIST, and the figure comes
   * back in full anyway. A read that consulted a transcript would return the
   * cold state instead — or throw.
   */
  it('answers in full from stored rows when no transcript file exists', () => {
    const task = issue()
    const ses = session({ issueId: task.id })
    const path = transcript(ses.resumeValue as string)
    ingest([source(path)])

    expect(existsOnDisk(path)).toBe(false)
    const result = service.task(task.id)
    expect(result.state).toBe('costed')
    expect(tokensOf(result.own.models)).toBe(1_500)
  })

  it('stays flat as the corpus grows — 400 transcripts across 200 tasks', () => {
    const epic = issue()
    for (let i = 0; i < 200; i += 1) {
      const child = issue({ parentId: epic.id })
      for (let t = 0; t < 2; t += 1) {
        const ses = session({ issueId: child.id })
        ingest([source(transcript(ses.resumeValue as string))])
      }
    }
    const started = performance.now()
    const result = service.task(epic.id)
    const elapsedMs = performance.now() - started

    expect(result.rollup.sessionCount).toBe(400)
    expect(result.descendantCount).toBe(200)
    // Two orders of magnitude under the 856ms ONE task used to cost.
    expect(elapsedMs).toBeLessThan(250)
  })
})

function existsOnDisk(path: string): boolean {
  try {
    // biome-ignore lint/correctness/noNodejsModules: a test asserting the read
    // path does not touch disk has to be the one thing that does.
    return require('node:fs').existsSync(path) as boolean
  } catch {
    return false
  }
}
