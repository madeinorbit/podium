import type { SessionId, IssueId, MachineId, TranscriptItem } from '@podium/model'
import type { LiveServerMessage } from '@podium/protocol'
import type { DaemonMessage } from '@podium/protocol/daemon'
import { harnessUsesPromptTitleFallback } from '../../harness-manifest'
import type { SessionsDaemonFrame } from '../../gateway/daemon-frame-routing'
import {
  isCommandWrapperText,
  isGenericClaudeTitle,
  isTransientTitle,
  makeTitleDebouncer,
  stripSpinnerFrame,
  titleFromPrompt,
} from '../../title-filter'
import type { SessionBindingReceipts } from './session-binding'
import type { Session, SessionDurableState } from './session'

export type SessionProjectionDaemonFrame = Extract<
  SessionsDaemonFrame,
  {
    type:
      | 'agentColor'
      | 'agentModel'
      | 'agentContext'
      | 'title'
      | 'sessionResumeRef'
      | 'sessionCwd'
      | 'sessionGitActivity'
      | 'transcriptDelta'
  }
>

export interface SessionDaemonProjectionPorts {
  sessions: ReadonlyMap<SessionId, Session>
  recordSessionGitActivity(
    sessionId: SessionId,
    input: { commits?: string[]; touched?: string[] },
  ): void
  binding: SessionBindingReceipts
  /** Persist a session whose durable half this pass did not change. */
  persist(session: Session): void
  /** Mutate the durable half as a DRAFT and persist it [POD-3330]. */
  write(session: Session, mutate: (draft: SessionDurableState) => void): void
  /** A draft for the sites that must ask "did this actually change?" before
   *  deciding to write at all. */
  draft(session: Session): SessionDurableState
  persistDraft(session: Session, draft: SessionDurableState): void
  broadcastSessions(): void
  broadcastToClients(message: LiveServerMessage): void
  transcriptDelta(sessionId: SessionId, items: TranscriptItem[], reset?: boolean): void
  adoptWorktree(
    issueId: IssueId,
    machineId: MachineId,
    message: Extract<DaemonMessage, { type: 'sessionCwd' }>,
  ): void
}

/** Applies daemon-observed metadata to the session projection and its module views. */
export class SessionDaemonProjection {
  private readonly titleDebouncers = new Map<string, ReturnType<typeof makeTitleDebouncer>>()

  constructor(private readonly ports: SessionDaemonProjectionPorts) {}

  disposeTitle(sessionId: SessionId): void {
    this.titleDebouncers.get(sessionId)?.dispose()
    this.titleDebouncers.delete(sessionId)
  }

  /** Route every title update through one deduplicating history. */
  private publishTitle(sessionId: SessionId, title: string): void {
    let debouncer = this.titleDebouncers.get(sessionId)
    if (!debouncer) {
      debouncer = makeTitleDebouncer((settled) => {
        this.ports.broadcastToClients({ type: 'sessionTitleChanged', sessionId, title: settled })
      })
      this.titleDebouncers.set(sessionId, debouncer)
    }
    debouncer.push(title)
  }

  handle(machineId: MachineId, message: SessionProjectionDaemonFrame): void {
    switch (message.type) {
      // The three sightings below all ASK before they write [POD-3330]: the
      // setter answers whether the value actually moved, and only then is there
      // anything to persist. The draft is where the answer is computed, so a
      // sighting that changes nothing leaves the live session untouched exactly
      // as it did before, and one that does is on the object only once its row
      // says so.
      case 'agentColor': {
        const session = this.ports.sessions.get(message.sessionId)
        if (!session) break
        const draft = this.ports.draft(session)
        if (session.setAgentColor(message.color, draft)) {
          this.ports.persistDraft(session, draft)
          this.ports.broadcastSessions()
        }
        break
      }
      case 'agentModel': {
        const session = this.ports.sessions.get(message.sessionId)
        if (!session) break
        const draft = this.ports.draft(session)
        if (session.setObservedModel(message.model, message.effort, draft)) {
          this.ports.persistDraft(session, draft)
          this.ports.broadcastSessions()
        }
        break
      }
      case 'agentContext': {
        const session = this.ports.sessions.get(message.sessionId)
        if (!session) break
        const draft = this.ports.draft(session)
        if (session.setContextUsagePercent(message.percent, draft)) {
          this.ports.persistDraft(session, draft)
          this.ports.broadcastSessions()
        }
        break
      }
      case 'title': {
        const session = this.ports.sessions.get(message.sessionId)
        if (!session || isCommandWrapperText(message.title)) break
        // Store the stable title rather than whichever spinner frame the PTY
        // happened to report last.
        const title = stripSpinnerFrame(message.title)
        if (isGenericClaudeTitle(title) && session.title && !isGenericClaudeTitle(session.title)) {
          break
        }
        if (!isTransientTitle(title)) {
          // `titleLocked` is live-only, so a reattached harness must restore it
          // even when the durable title already matches.
          if (!isGenericClaudeTitle(title)) session.titleLocked = true
          if (session.title !== title) {
            this.ports.write(session, (draft) => {
              session.setTitle(title, draft)
            })
          }
        }
        this.publishTitle(message.sessionId, title)
        break
      }
      case 'sessionResumeRef':
        this.ports.binding.observeResumeRef(machineId, message)
        break
      case 'sessionCwd': {
        const session = this.ports.sessions.get(message.sessionId)
        if (!session || session.machineId !== machineId) break
        if (message.cwd && session.cwd !== message.cwd) {
          const cwd = message.cwd
          this.ports.write(session, (draft) => {
            draft.cwd = cwd
          })
          this.ports.broadcastSessions()
        }
        if (message.cwd && session.issueId)
          this.ports.adoptWorktree(session.issueId, machineId, message)
        break
      }
      case 'sessionGitActivity':
        this.ports.recordSessionGitActivity(message.sessionId, {
          ...(message.commits ? { commits: message.commits } : {}),
          ...(message.touched ? { touched: message.touched } : {}),
        })
        break
      case 'transcriptDelta': {
        const session = this.ports.sessions.get(message.sessionId)
        if (
          session?.terminal.applyDelta(message.items, {
            ...(message.reset !== undefined ? { reset: message.reset } : {}),
            ...(message.tail !== undefined ? { tail: message.tail } : {}),
          })
        ) {
          // A PLAIN PERSIST, deliberately [POD-3330]: what moved is the LIVE
          // half — the terminal adopted the delta and, through its own
          // callback, promoted `transcriptAvailable` and the conversation
          // binding on the session itself. Nothing in this span assigned a
          // durable field, so the row restates what the live object already
          // says rather than carrying a write of its own.
          this.ports.persist(session)
          this.ports.broadcastSessions()
        }
        if (session) this.ports.transcriptDelta(message.sessionId, message.items, message.reset)
        if (session && harnessUsesPromptTitleFallback(session.agentKind) && !session.titleLocked) {
          const firstUser = session.terminal
            .transcriptItems()
            .find(
              (item) =>
                item.role === 'user' &&
                item.text.trim().length > 0 &&
                !isCommandWrapperText(item.text),
            )
          const title = firstUser ? titleFromPrompt(firstUser.text) : undefined
          if (title) {
            session.titleLocked = true
            this.ports.write(session, (draft) => {
              session.setTitle(title, draft)
            })
            this.publishTitle(message.sessionId, title)
          }
        }
        break
      }
    }
  }
}
