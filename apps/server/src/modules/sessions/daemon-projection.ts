import type { SessionId, IssueId, MachineId, TranscriptItem } from '@podium/model'
import type { LiveServerMessage } from '@podium/protocol'
import { compareProviderCursor } from '@podium/harness/metadata'
import type { RuntimeEvent, SessionMetadataChange, SessionMetadataObservation, SessionSnapshot } from '@podium/protocol/daemon'
import type { DaemonMessage } from '@podium/protocol/daemon'
import { harnessCapabilitiesFor, harnessUsesPromptTitleFallback } from '../../harness-manifest'
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
  persist(session: Session): Promise<void>
  /** Mutate the durable half as a DRAFT and persist it [POD-3330]. */
  write(session: Session, mutate: (draft: SessionDurableState) => void): Promise<void>
  /** A draft for the sites that must ask "did this actually change?" before
   *  deciding to write at all. */
  draft(session: Session): SessionDurableState
  persistDraft(session: Session, draft: SessionDurableState): Promise<void>
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

  private readonly metadataSeen = new Map<SessionId, Map<string, SessionMetadataObservation>>()
  private readonly metadataQueue = new Map<SessionId, Promise<void>>()

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

  /** Called only after causal admission. Compatibility frames share the same
   * setters and title history, so a dual-delivered sighting is idempotent. */
  async metadata(sessionId: SessionId, change: SessionMetadataChange): Promise<void> {
    const session = this.ports.sessions.get(sessionId)
    if (!session) return
    switch (change.kind) {
      case 'title':
        if (change.source === 'osc' && harnessCapabilitiesFor(session.agentKind)?.oscTitle === false) return
        return this.handle(session.machineId, { type: 'title', sessionId, title: change.title, source: change.source })
      case 'model':
        return this.handle(session.machineId, { type: 'agentModel', sessionId, model: change.model, effort: change.effort })
      case 'color':
        return this.handle(session.machineId, { type: 'agentColor', sessionId, color: change.color })
      case 'context':
        return this.handle(session.machineId, { type: 'agentContext', sessionId, percent: change.percent })
    }
  }

  async runtimeEvent(sessionId: SessionId, event: RuntimeEvent): Promise<void> {
    if (event.t !== 'metadata') return
    const previous = this.metadataQueue.get(sessionId) ?? Promise.resolve()
    const completion = previous.catch(() => {}).then(async () => {
      const seen = this.metadataSeen.get(sessionId) ?? new Map<string, SessionMetadataObservation>()
      const prior = seen.get(event.change.kind)
      if (prior) {
        if (event.observerGeneration < prior.observerGeneration) return
        if (event.observerGeneration === prior.observerGeneration) {
          const before = prior.cursor.components.seq
          const next = event.cursor.components.seq
          // Metadata of one kind is sparse: native segment rotations may have
          // been admitted between its sightings. The runtime stream sequence
          // orders those values even when neither cursor is a direct successor.
          if (before !== undefined && next !== undefined) {
            if (next <= before) return
          } else if (compareProviderCursor(prior.cursor, event.cursor) !== 'after') return
        }
      }
      await this.metadata(sessionId, event.change)
      seen.set(event.change.kind, event)
      this.metadataSeen.set(sessionId, seen)
    })
    this.metadataQueue.set(sessionId, completion)
    try { await completion } finally {
      if (this.metadataQueue.get(sessionId) === completion) this.metadataQueue.delete(sessionId)
    }
  }

  async metadataSnapshot(sessionId: SessionId, snapshot: SessionSnapshot): Promise<void> {
    if (snapshot.binding.sessionId !== sessionId) return
    // Each value keeps its own original envelope, not the snapshot request time.
    // The same per-kind fence handles snapshots racing newer live observations.
    for (const observation of snapshot.metadata ?? []) await this.runtimeEvent(sessionId, observation)
    if (snapshot.title !== undefined && !snapshot.metadata?.some((event) => event.change.kind === 'title')) {
      await this.runtimeEvent(sessionId, {
        t: 'metadata', change: { kind: 'title', source: 'native', title: snapshot.title },
        at: snapshot.at, cursor: snapshot.cursor, observerGeneration: snapshot.observerGeneration,
        turnEpoch: snapshot.turnEpoch, provenance: 'bootstrap',
      })
    }
  }

  async promptTitle(sessionId: SessionId): Promise<void> {
    const session = this.ports.sessions.get(sessionId)
    if (!session || !harnessUsesPromptTitleFallback(session.agentKind) || session.titleLocked) return
    const firstUser = session.terminal.transcriptItems().find(
      (item) => item.role === 'user' && item.text.trim().length > 0 && !isCommandWrapperText(item.text),
    )
    const title = firstUser ? titleFromPrompt(firstUser.text) : undefined
    if (!title) return
    await this.ports.write(session, (draft) => { session.setTitle(title, draft) })
    session.titleLocked = true
    this.publishTitle(sessionId, title)
  }

  async handle(machineId: MachineId, message: SessionProjectionDaemonFrame): Promise<void> {
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
          const result: Promise<void> = this.ports.persistDraft(session, draft)
          await result
          this.ports.broadcastSessions()
        }
        break
      }
      case 'agentModel': {
        const session = this.ports.sessions.get(message.sessionId)
        if (!session) break
        const draft = this.ports.draft(session)
        if (session.setObservedModel(message.model, message.effort, draft)) {
          const result: Promise<void> = this.ports.persistDraft(session, draft)
          await result
          this.ports.broadcastSessions()
        }
        break
      }
      case 'agentContext': {
        const session = this.ports.sessions.get(message.sessionId)
        if (!session) break
        const draft = this.ports.draft(session)
        if (session.setContextUsagePercent(message.percent, draft)) {
          const result: Promise<void> = this.ports.persistDraft(session, draft)
          await result
          this.ports.broadcastSessions()
        }
        break
      }
      case 'title': {
        const session = this.ports.sessions.get(message.sessionId)
        if (!session || isCommandWrapperText(message.title)) break
        if (message.source === 'osc' && harnessCapabilitiesFor(session.agentKind)?.oscTitle === false) break
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
            const result: Promise<void> = this.ports.write(session, (draft) => {
              session.setTitle(title, draft)
            })
            await result
          }
        }
        this.publishTitle(message.sessionId, title)
        break
      }
      case 'sessionResumeRef':
        await this.ports.binding.observeResumeRef(machineId, message)
        break
      case 'sessionCwd': {
        const session = this.ports.sessions.get(message.sessionId)
        if (!session || session.machineId !== machineId) break
        // Contract-owned sessions project cwd through the runtime workspace
        // port, not this legacy frame. The daemon sends both (tap + legacy);
        // ignoring the legacy here is what keeps the projection single-writer
        // while plain shell/login sessions keep their existing path.
        if (session.runtimeContract) break
        if (message.cwd && session.cwd !== message.cwd) {
          const cwd = message.cwd
          const result: Promise<void> = this.ports.write(session, (draft) => {
            draft.cwd = cwd
          })
          await result
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
          const result: Promise<void> = this.ports.persist(session)
          await result
          this.ports.broadcastSessions()
        }
        if (session) this.ports.transcriptDelta(message.sessionId, message.items, message.reset)
        await this.promptTitle(message.sessionId)
        break
      }
    }
  }
}
