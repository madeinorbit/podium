import { issueAgentKind, modelName } from '@podium/client-core/agent-models'
import type { SessionView } from '@podium/client-core/session-values'
import {
  type IssueNavigationModel,
  readoutModel,
  sessionDisplayName,
} from '@podium/client-core/values'
import { here } from '@podium/client-graph/lookup'
import type { FullDeckTask } from '@podium/client-graph/mission-full-deck'
import type { SessionModel } from '@podium/client-graph/models'
import { TASK_WORD_LABEL, type TaskWord } from '@podium/model/browser'
import type { WorkMenuActionId } from '../lib/work-menu'

/** One accepted task on the deck (board DeckLarge). */
export type DeckTaskRowProps = {
  task: FullDeckTask
  indent: number
  first: boolean
  onPress: () => void
  onLongPress: () => void
  /** iOS: the row's long-press acts as a native context menu (else `onLongPress`). */
  menu?: {
    issue: IssueNavigationModel
    onAction: (action: WorkMenuActionId) => void
    onStatus: (value: string) => void
  }
}

/** An agent seated on a task, inset under it (board DeckLarge). */
export type DeckAgentRowProps = {
  task: FullDeckTask
  sessionId: string
  indent: number
  current: boolean
  onPress: () => void
}

/** One of the root's seats: the coordinator first (board DeckSheet). */
export type DeckSeatRowProps = {
  task: FullDeckTask
  sessionId: string
  first: boolean
  current: boolean
  onPress: () => void
}

/** A phase as the heading of its group of tasks. */
export type DeckPhaseHeadingProps = { phase: FullDeckTask }

/** The task's word, with the unmet-dependency count on a blocked one. */
export function taskWordText(word: TaskWord, blockers: number): string {
  return word === 'blocked' && blockers > 0
    ? `${TASK_WORD_LABEL.blocked} · ${blockers}`
    : TASK_WORD_LABEL[word]
}

/** The coordinator seat reads "Coordinator"; everyone else by their name. */
export function seatName(task: FullDeckTask, sessionId: string, session: SessionModel): string {
  if (task.seat(sessionId) === 'coordinator') return 'Coordinator'
  return sessionDisplayName(session as unknown as SessionView)
}

export function sessionModelLabel(session: SessionModel): string | null {
  const view = here(session.row) as unknown as SessionView | undefined
  if (!view) return null
  const kind = issueAgentKind(view.agentKind)
  const model = readoutModel(view)
  return kind && model ? modelName(kind, model) : null
}
