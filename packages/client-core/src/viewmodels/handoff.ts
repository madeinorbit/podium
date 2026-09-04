import type { IssueId, SessionId, SessionMeta, TranscriptItem } from '@podium/model'
import { issueDisplayRef } from '@podium/protocol'
import { sessionPresentOnTask } from './fleet'
import {
  blockedNote,
  issueClosed,
  missionIssueIds,
  missionSessions,
  presenceNote,
  sessionAsksOnIssue,
  sessionAtWork,
} from './mission'
import { defaultChatCapable, motionPhase } from './session-status'
import type { OperatorPromptOptions } from './slices/chat'
import { isOperatorPrompt } from './slices/chat'
import type { IssueNavigationModel } from './slices/issues'

export interface HandoffAnchor {
  sessionId: SessionId
  itemKey: string
}

export interface HandoffTranscriptPair {
  sessionId: SessionId
  prompt: { item: TranscriptItem; anchor: HandoffAnchor }
  answer?: { item: TranscriptItem; anchor: HandoffAnchor; legacy: boolean }
}

export type HandoffNowEntry =
  | { kind: 'working'; issueId: IssueId; sessionId: SessionId; text: string }
  | { kind: 'review'; issueId: IssueId; sessionId?: SessionId; text: string }
  | { kind: 'blocked'; issueId: IssueId; sessionId?: SessionId; text: string }
  | { kind: 'stalled'; issueId: IssueId; text: string }
  | { kind: 'needs-you'; issueId: IssueId; sessionId?: SessionId; text: string }

export interface HandoffNextEntry {
  issueId: IssueId
  afterIssueId?: IssueId
  sessionId?: SessionId
  text: string
}

export interface HandoffSessionSummary {
  computing: number
  idle: number
  hibernated: number
  exited: number
}

const itemKey = (item: TranscriptItem): string => item.cursor ?? item.id

/** The one mission transcript worth reading for return context. */
export function selectLatestPromptSession(sessions: readonly SessionMeta[]): SessionMeta | null {
  const candidates = sessions.filter(
    (session) =>
      Boolean(session.lastInputAt) &&
      (session.transcriptAvailable ?? defaultChatCapable(session.agentKind)),
  )
  candidates.sort((left, right) => {
    const input = (right.lastInputAt ?? '').localeCompare(left.lastInputAt ?? '')
    if (input !== 0) return input
    const active = right.lastActiveAt.localeCompare(left.lastActiveAt)
    return active !== 0 ? active : right.sessionId.localeCompare(left.sessionId)
  })
  return candidates[0] ?? null
}

/** Pair the newest real operator prompt with the final answer from that turn. */
export function pairLatestPromptAndAnswer(
  sessionId: SessionId,
  items: readonly TranscriptItem[],
  promptOptions: OperatorPromptOptions,
): HandoffTranscriptPair | null {
  let promptIndex = -1
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (item && isOperatorPrompt(item, promptOptions)) {
      promptIndex = index
      break
    }
  }
  if (promptIndex < 0) return null

  const prompt = items[promptIndex] as TranscriptItem
  const operatorText = promptOptions.operatorTextOf?.(prompt.text)
  const displayPrompt = operatorText === undefined ? prompt : { ...prompt, text: operatorText }
  const hasAnswerMarkers = items.some((item) => item.answer === true)
  let markedAnswer: TranscriptItem | undefined
  let legacyAnswer: TranscriptItem | undefined
  for (let index = promptIndex + 1; index < items.length; index += 1) {
    const item = items[index]
    if (!item) continue
    if (isOperatorPrompt(item, promptOptions)) break
    if (item.role !== 'assistant' || !item.text.trim()) continue
    if (item.answer === true) markedAnswer = item
    if (!hasAnswerMarkers) legacyAnswer = item
  }
  const answer = markedAnswer ?? legacyAnswer
  return {
    sessionId,
    prompt: {
      item: displayPrompt,
      anchor: { sessionId, itemKey: itemKey(prompt) },
    },
    ...(answer
      ? {
          answer: {
            item: answer,
            anchor: { sessionId, itemKey: itemKey(answer) },
            legacy: markedAnswer === undefined,
          },
        }
      : {}),
  }
}

function sessionsOnIssue(
  issue: IssueNavigationModel,
  sessions: readonly SessionMeta[],
): SessionMeta[] {
  const members = new Set(issue.memberSessionIds ?? [])
  return sessions.filter(
    (session) => session.issueId === issue.id || members.has(session.sessionId),
  )
}

function newestSession(sessions: readonly SessionMeta[]): SessionMeta | undefined {
  let newest: SessionMeta | undefined
  for (const session of sessions) {
    if (!newest || session.lastActiveAt > newest.lastActiveAt) newest = session
  }
  return newest
}

export function summarizeHandoffSessions(sessions: readonly SessionMeta[]): HandoffSessionSummary {
  const summary: HandoffSessionSummary = { computing: 0, idle: 0, hibernated: 0, exited: 0 }
  for (const session of sessions) {
    if (session.archived || session.status === 'exited') summary.exited += 1
    else if (session.status === 'hibernated') summary.hibernated += 1
    else if (sessionAtWork(session)) summary.computing += 1
    else if (sessionPresentOnTask(session)) summary.idle += 1
  }
  return summary
}

const NOW_RANK: Record<HandoffNowEntry['kind'], number> = {
  working: 0,
  review: 1,
  blocked: 2,
  stalled: 2,
  'needs-you': 3,
}

/** Current mission exceptions, one truthful row per issue. */
export function deriveHandoffNow(
  issues: readonly IssueNavigationModel[],
  sessions: readonly SessionMeta[],
  rootId: string,
): HandoffNowEntry[] {
  const memberIds = missionIssueIds(issues, rootId, sessions)
  const missionCrew = missionSessions(issues, sessions, rootId, true)
  const byId = new Map(issues.map((issue) => [issue.id, issue]))
  const entries: Array<{ entry: HandoffNowEntry; seq: number }> = []

  for (const issue of issues) {
    if (!memberIds.has(issue.id) || issue.stage === 'proposed' || issue.archived || issue.deletedAt)
      continue
    const crew = sessionsOnIssue(issue, missionCrew)
    const present = crew.filter(sessionPresentOnTask)
    const asking = present.find(
      (session) => sessionAsksOnIssue(issue, session) || motionPhase(session) === 'waiting',
    )
    const askedBy = issue.humanQuestionAskedBy
      ? crew.find((session) => session.sessionId === issue.humanQuestionAskedBy)
      : undefined
    const explicitNeed = issue.needsHuman === true || asking !== undefined
    let entry: HandoffNowEntry | null = null

    if (explicitNeed && !issueClosed(issue)) {
      const session = asking ?? askedBy
      entry = {
        kind: 'needs-you',
        issueId: issue.id,
        ...(session ? { sessionId: session.sessionId } : {}),
        text:
          session?.agentState?.need?.summary?.trim() ||
          issue.humanQuestion?.trim() ||
          'Waiting on you.',
      }
    } else {
      const working = present.find(sessionAtWork)
      if (working) {
        entry = {
          kind: 'working',
          issueId: issue.id,
          sessionId: working.sessionId,
          text:
            blockedNote(issue, byId) ??
            presenceNote(issue, crew, byId, missionCrew)?.text ??
            'Agent computing now.',
        }
      } else if (issue.stage === 'review' && !issue.blocked) {
        const session = newestSession(crew)
        entry = {
          kind: 'review',
          issueId: issue.id,
          ...(session ? { sessionId: session.sessionId } : {}),
          text: 'Ready for review.',
        }
      } else if (issue.blocked) {
        const session = newestSession(present)
        entry = {
          kind: 'blocked',
          issueId: issue.id,
          ...(session ? { sessionId: session.sessionId } : {}),
          text:
            blockedNote(issue, byId) ??
            presenceNote(issue, crew, byId, missionCrew)?.text ??
            'Waiting on dependency.',
        }
      } else if (
        (issue.stage === 'planning' || issue.stage === 'in_progress') &&
        present.length === 0
      ) {
        entry = {
          kind: 'stalled',
          issueId: issue.id,
          text:
            presenceNote(issue, crew, byId, missionCrew)?.text ??
            'Started with no present session.',
        }
      }
    }

    if (entry) entries.push({ entry, seq: issue.seq })
  }

  entries.sort(
    (left, right) => NOW_RANK[left.entry.kind] - NOW_RANK[right.entry.kind] || left.seq - right.seq,
  )
  return entries.map(({ entry }) => entry)
}

function openFormalChildren(
  issues: readonly IssueNavigationModel[],
  memberIds: ReadonlySet<string>,
  parentId: string,
): IssueNavigationModel[] {
  return issues.filter(
    (issue) =>
      memberIds.has(issue.id) &&
      issue.parentId === parentId &&
      issue.stage !== 'proposed' &&
      !issue.archived &&
      !issue.deletedAt &&
      !issueClosed(issue),
  )
}

/** Structured next conditions only. No prose fields participate. */
export function deriveHandoffNext(
  issues: readonly IssueNavigationModel[],
  sessions: readonly SessionMeta[],
  rootId: string,
): HandoffNextEntry[] {
  const memberIds = missionIssueIds(issues, rootId, sessions)
  const byId = new Map(issues.map((issue) => [issue.id, issue]))
  const entries: Array<{ entry: HandoffNextEntry; seq: number; depth: number }> = []
  const depthMemo = new Map<string, number>()

  const prerequisites = (issue: IssueNavigationModel): IssueNavigationModel[] => {
    const blockers = (issue.deps ?? [])
      .filter((dep) => dep.type === 'blocks')
      .map((dep) => byId.get(dep.id))
      .filter((candidate): candidate is IssueNavigationModel =>
        Boolean(candidate && !issueClosed(candidate)),
      )
    return [...blockers, ...openFormalChildren(issues, memberIds, issue.id)]
  }
  const depthOf = (issue: IssueNavigationModel, visiting = new Set<string>()): number => {
    const memo = depthMemo.get(issue.id)
    if (memo !== undefined) return memo
    if (visiting.has(issue.id)) return 0
    const nextVisiting = new Set(visiting).add(issue.id)
    const deps = prerequisites(issue)
    const depth =
      deps.length === 0 ? 0 : 1 + Math.max(...deps.map((dep) => depthOf(dep, nextVisiting)))
    depthMemo.set(issue.id, depth)
    return depth
  }

  for (const issue of issues) {
    if (
      !memberIds.has(issue.id) ||
      issue.stage === 'proposed' ||
      issue.archived ||
      issue.deletedAt ||
      issueClosed(issue)
    )
      continue
    const openBlockers = (issue.deps ?? [])
      .filter((dep) => dep.type === 'blocks')
      .map((dep) => byId.get(dep.id))
      .filter((candidate): candidate is IssueNavigationModel =>
        Boolean(candidate && !issueClosed(candidate)),
      )
    const children = openFormalChildren(issues, memberIds, issue.id)
    const session = newestSession(sessionsOnIssue(issue, sessions))
    let entry: HandoffNextEntry | null = null

    if (issue.stage === 'review' && openBlockers.length === 0) {
      entry = {
        issueId: issue.id,
        ...(session ? { sessionId: session.sessionId } : {}),
        text: `Review and land ${issueDisplayRef(issue)}.`,
      }
    } else if (openBlockers.length === 1) {
      const blocker = openBlockers[0] as IssueNavigationModel
      entry = {
        issueId: issue.id,
        afterIssueId: blocker.id,
        ...(session ? { sessionId: session.sessionId } : {}),
        text: `After ${issueDisplayRef(blocker)} closes, resume ${issueDisplayRef(issue)}.`,
      }
    } else if (openBlockers.length === 0 && children.length === 1) {
      const child = children[0] as IssueNavigationModel
      entry = {
        issueId: issue.id,
        afterIssueId: child.id,
        ...(session ? { sessionId: session.sessionId } : {}),
        text: `After ${issueDisplayRef(child)} closes, resume ${issueDisplayRef(issue)}.`,
      }
    } else if (issue.stage === 'backlog' && issue.ready && openBlockers.length === 0) {
      entry = { issueId: issue.id, text: `${issueDisplayRef(issue)} is ready to start.` }
    }

    if (entry) entries.push({ entry, seq: issue.seq, depth: depthOf(issue) })
  }

  entries.sort((left, right) => left.depth - right.depth || left.seq - right.seq)
  return entries.map(({ entry }) => entry)
}

export function reviewReturnCount(events: readonly { kind: string; payload?: unknown }[]): number {
  let count = 0
  for (const event of events) {
    if (event.kind !== 'issue.stage_changed' || !event.payload || typeof event.payload !== 'object')
      continue
    const payload = event.payload as Record<string, unknown>
    if (payload.from === 'review' && (payload.to === 'planning' || payload.to === 'in_progress'))
      count += 1
  }
  return count
}
