import type { IssueId, MachineId, MutationId, SessionId, WorkState } from '@podium/model'
import type { PodiumClientApi } from '../api'
import type { SessionEndResult, SessionResurrectionResult } from '../engine/types'
import type {
  IssueWorkAction,
  LaunchSessionArgs,
  SessionAnswer,
  SpawnDraftAgentArgs,
  SpawnIssueAgentArgs,
  StartIssueSession,
  TaskSpawnOutcome,
} from '../spawn-agent'

export interface SessionsCommands<_TApi extends PodiumClientApi = PodiumClientApi> {
  /** Start a new agent optimistically (#119): mints client ids, paints a
   *  'starting' session + its draft-issue vessel INSTANTLY (an overlay over the
   *  server rows), then fires `sessions.create` in the background reusing those
   *  ids so the broadcast reconciles by id — and rolls the optimistic rows back
   *  if the create never lands. Returns the ids synchronously so the caller
   *  navigates without waiting on the round-trip. */
  spawnDraftAgent: (args: SpawnDraftAgentArgs) => {
    sessionId: SessionId
    issueId: IssueId
    settled: Promise<boolean>
  }
  /** Start a session in a folder, joining the panel's task when it has one
   *  (POD-6523): a `session.launch` effect record under a session id minted
   *  here, painted from that record (and its queued create) until the row
   *  lands. Returns the id synchronously so the caller opens its panel. */
  launch: (args: LaunchSessionArgs) => {
    sessionId: SessionId
    settled: Promise<boolean>
  }
  /** Start a named task optimistically, including its first chat turn. */
  spawnIssueAgent: (args: SpawnIssueAgentArgs) => {
    sessionId: SessionId
    issueId: IssueId
    mutationId: MutationId
    settled: Promise<boolean>
    outcome: Promise<TaskSpawnOutcome>
    /** True once the task was filed as a proposal (no agent comes). */
    proposed: Promise<boolean>
  }
  killSession: (sessionId: SessionId) => Promise<void>
  /** Nudge an errored agent to retry ("continue⏎" into its PTY). */
  continueSession: (sessionId: SessionId) => Promise<void>
  hibernate: (sessionId: SessionId) => Promise<void>
  /** Clean end [spec:SP-9904]: stop the process and free the issue worktree,
   *  KEEPING the branch, the transcript and the session row, so Resume can
   *  rebuild the checkout from the branch. The middle of the lifecycle between
   *  hibernate (which keeps the worktree) and kill (which tombstones the row) —
   *  and until POD-1077 the only surface that could reach it was the CLI.
   *
   *  Refuses rather than throws on a dirty/conflicted tree; the refusal is
   *  returned so the caller can offer `force`. */
  stop: (sessionId: SessionId, opts?: { force?: boolean }) => Promise<SessionEndResult>
  /**
   * Stop the turn the person saw (POD-6397): a `session.interrupt` effect
   * record naming that turn (`turn`: the session's `agentState.turnStartedAt`)
   * and the send it retracts if it has not reached the agent. Resolves once the
   * record is durably queued, with its id; the session model reads its progress
   * (`interrupting`, `interruptStuck`) from the record, on every device.
   */
  interrupt: (sessionId: SessionId, args: { turn?: string; messageId?: string }) => Promise<string>
  /**
   * Change a running session's model or effort (POD-6523): a
   * `session.configure` effect record with the patch. Resolves once it is
   * durably queued, with its id; the session model reads its progress and the
   * driver's answer (`configureChange`) from the record, on every device.
   */
  configure: (sessionId: SessionId, patch: { model?: string; effort?: string }) => Promise<string>
  /**
   * Move a session to another machine (POD-6422): a `session.handoff` effect
   * record. Resolves once it is durably queued, with its id; the session model
   * reads its progress (`handoff`, `handingOffTo`) from the record, on every
   * device, and the caller that says how it ended waits for it (`awaitEffect`).
   */
  handoff: (sessionId: SessionId, machineId: MachineId) => Promise<string>
  resume: (sessionId: SessionId) => Promise<SessionResurrectionResult>
  /**
   * Answer a session's question (POD-6415): a `session.answer` effect record,
   * created at once (never queued; an answer is online-only). Resolves with its
   * id once the server holds it; how the delivery went is the record's
   * `result`, which a caller waits for (`awaitAnswer`).
   */
  answer: (sessionId: SessionId, answer: SessionAnswer) => Promise<string>
  archive: (sessionId: SessionId, archived: boolean) => Promise<void>
  /**
   * Start a session on an existing issue (POD-6526): its first, with its
   * worktree (`issue.begin`), or one more agent or a shell
   * (`issue.addSession`), as an effect record under a session id minted here.
   * The session is painted on the issue from its queued create and then from
   * its record (also while the machine is offline) until the row lands; a
   * failure is told once on this device. Returns synchronously.
   */
  startIssueSession: StartIssueSession
  /**
   * Stop, clean up, ship or refresh the assistant of an issue (POD-6526): its
   * `issue.stop`, `issue.cleanup`, `issue.ship` or `issue.assistant` effect
   * record. Resolves once it is durably queued, with its id; the issue model
   * reads its progress (`workAction`) from the record, on every device, and a
   * caller that says how it ended waits for it (`awaitEffect`).
   */
  issueAction: (
    issueId: IssueId,
    action: IssueWorkAction,
    opts?: { force?: boolean },
  ) => Promise<string>
  /** "Ask superagent (BTW)": open the dock and attach this session's transcript
   *  to the next turn (POD-1069). See {@link attachedSessionId}. */
  startBtw: (sessionId: SessionId) => Promise<void>
  /** Take an ended effect record off the feed (`effects.dismiss`). */
  dismissEffect: (id: string) => Promise<void>
  rename: (sessionId: SessionId, name: string) => Promise<void>
  /** Mark a session read. Automatic receipts pass the observed activity;
   * explicit gestures omit it to acknowledge current server activity. Outboxed. */
  markRead: (sessionId: SessionId, readAt?: string) => Promise<void>
  /** Mark a session UNREAD again (issue #138, email-style inverse of markSessionRead):
   *  stamp readAt = null so derived `unread` flips back to true. Optimistic + outboxed. */
  markUnread: (sessionId: SessionId) => Promise<void>
  setWorkState: (sessionId: SessionId, workState: WorkState | null) => Promise<void>
  /** Snooze a session out of the attention surface. `until` = null → until next
   *  message; ISO string → timed. Orthogonal to agent state. */
  snooze: (sessionId: SessionId, until: string | null) => Promise<void>
  /** Un-snooze a session (return it to the normal attention flow). */
  clearSnooze: (sessionId: SessionId) => Promise<void>
  /** Per-session chat composer draft, shared across every view of that session
   *  (chat panes, split view) and preserved across chat/native mode switches.
   *  The native PTY input line is opaque bytes we can't read back, so this is the
   *  one input state we *can* synchronize. */
  setSessionDraft: (sessionId: SessionId, text: string) => void
}
