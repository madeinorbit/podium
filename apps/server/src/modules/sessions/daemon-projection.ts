import type { SessionId } from '@podium/model'
import type { DaemonMessage, LiveServerMessage } from '@podium/protocol'
import { harnessUsesPromptTitleFallback } from '../../harness-manifest'
import type { SessionsDaemonFrame } from '../../gateway/daemon-frame-routing'
import {
  isCommandWrapperText,
  isGenericClaudeTitle,
  isTransientTitle,
  makeTitleDebouncer,
  titleFromPrompt,
} from '../../title-filter'
import type { SessionBindingReceipts } from './session-binding'
import type { Session } from './session'

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
  persist(session: Session): void
  broadcastSessions(): void
  broadcastToClients(message: LiveServerMessage): void
  adoptWorktree(issueId: string, message: Extract<DaemonMessage, { type: 'sessionCwd' }>): void
}

/** Applies daemon-observed metadata to the session projection and its module views. */
export class SessionDaemonProjection {
  private readonly titleDebouncers = new Map<string, ReturnType<typeof makeTitleDebouncer>>()

  constructor(private readonly ports: SessionDaemonProjectionPorts) {}

  disposeTitle(sessionId: SessionId): void {
    this.titleDebouncers.get(sessionId)?.dispose()
    this.titleDebouncers.delete(sessionId)
  }

  handle(machineId: string, message: SessionProjectionDaemonFrame): void {
    switch (message.type) {
      case 'agentColor': {
        const session = this.ports.sessions.get(message.sessionId)
        if (session?.setAgentColor(message.color)) {
          this.ports.persist(session)
          this.ports.broadcastSessions()
        }
        break
      }
      case 'agentModel': {
        const session = this.ports.sessions.get(message.sessionId)
        if (session?.setObservedModel(message.model, message.effort)) {
          this.ports.persist(session)
          this.ports.broadcastSessions()
        }
        break
      }
      case 'agentContext': {
        const session = this.ports.sessions.get(message.sessionId)
        if (session?.setContextUsagePercent(message.percent)) {
          this.ports.persist(session)
          this.ports.broadcastSessions()
        }
        break
      }
      case 'title': {
        const session = this.ports.sessions.get(message.sessionId)
        if (!session || isCommandWrapperText(message.title)) break
        if (
          isGenericClaudeTitle(message.title) &&
          session.title &&
          !isGenericClaudeTitle(session.title)
        ) {
          break
        }
        if (!isTransientTitle(message.title)) {
          session.setTitle(message.title)
          if (!isGenericClaudeTitle(message.title)) session.titleLocked = true
          this.ports.persist(session)
        }
        if (!this.titleDebouncers.has(message.sessionId)) {
          const sessionId = message.sessionId
          this.titleDebouncers.set(
            sessionId,
            makeTitleDebouncer((title) => {
              this.ports.broadcastToClients({
                type: 'sessionTitleChanged',
                sessionId,
                title,
              })
            }),
          )
        }
        this.titleDebouncers.get(message.sessionId)?.push(message.title)
        break
      }
      case 'sessionResumeRef':
        this.ports.binding.observeResumeRef(machineId, message)
        break
      case 'sessionCwd': {
        const session = this.ports.sessions.get(message.sessionId)
        if (!session || session.machineId !== machineId) break
        if (message.cwd && session.cwd !== message.cwd) {
          session.cwd = message.cwd
          this.ports.persist(session)
          this.ports.broadcastSessions()
        }
        if (message.cwd && session.issueId) this.ports.adoptWorktree(session.issueId, message)
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
          this.ports.persist(session)
          this.ports.broadcastSessions()
        }
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
            session.setTitle(title)
            session.titleLocked = true
            this.ports.persist(session)
            this.ports.broadcastToClients({
              type: 'sessionTitleChanged',
              sessionId: message.sessionId,
              title,
            })
          }
        }
        break
      }
    }
  }
}
