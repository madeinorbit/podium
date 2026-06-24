import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import type { PodiumSettings } from '@podium/core'
import type {
  FileAssetResultMessage,
  FileReadResultMessage,
  FileWriteResultMessage,
} from '@podium/protocol'
import {
  AgentKind,
  agentSupportsInitialPrompt,
  type AgentQuotaWire,
  type AgentRuntimeState,
  type ClientMessage,
  type ControlMessage,
  type ConversationDiagnosticWire,
  type ConversationSummaryWire,
  type DaemonMessage,
  type Geometry,
  type GitDiscoveryDiagnosticWire,
  type GitRepositoryWire,
  type HostMetricsWire,
  type RepoOp,
  type ResumeRef,
  type ServerMessage,
  type SessionMeta,
  type TranscriptItem,
  type UsageBucketWire,
  type WorkState,
} from '@podium/protocol'
import { AutoContinueController } from './auto-continue'
import { knownPathsFor } from './file-relay-policy'
import { IssueService } from './issues'
import {
  type AttentionNotice,
  attentionNotice,
  pushNtfy,
  pushTelegram,
  type TelegramConfig,
} from './notify'
import { type ClientConn, type Send, Session } from './session'
import { computePriorities } from './session-priority'
import { type PinKind, SessionStore } from './store'
import {
  isGenericClaudeTitle,
  isTransientTitle,
  makeTitleDebouncer,
  titleFromPrompt,
} from './title-filter'

const DEFAULT_GEOMETRY: Geometry = { cols: 80, rows: 24 }
const SCAN_TIMEOUT_MS = 10_000
const FILE_RPC_TIMEOUT_MS = 10_000

export interface ScanResult {
  conversations: ConversationSummaryWire[]
  diagnostics: ConversationDiagnosticWire[]
}

export interface ScanReposResult {
  repositories: GitRepositoryWire[]
  diagnostics: GitDiscoveryDiagnosticWire[]
}

/** The daemon's memoryBreakdownResult, minus wire plumbing (type/requestId). */
export type MemoryBreakdown = Omit<
  Extract<DaemonMessage, { type: 'memoryBreakdownResult' }>,
  'type' | 'requestId'
>

/** Outcome of a daemon-executed operation (git op / harness one-shot). */
export interface OpResult {
  ok: boolean
  output: string
}

interface NotificationPushers {
  ntfy(topic: string, notice: AttentionNotice): void
  telegram(config: TelegramConfig, notice: AttentionNotice): void
}

const DEFAULT_NOTIFICATION_PUSHERS: NotificationPushers = {
  ntfy: pushNtfy,
  telegram: pushTelegram,
}

/** Registry of all sessions + the single daemon link + all client connections. Routes by sessionId. */
export class SessionRegistry {
  private daemonSend: Send<ControlMessage> | undefined
  // Control messages produced before a daemon attaches (e.g. a starter session
  // created at boot, before the daemon ws finishes connecting) would otherwise be
  // dropped silently. Queue them here and flush in order once a daemon attaches.
  private readonly pendingToDaemon: ControlMessage[] = []
  private readonly sessions = new Map<string, Session>()
  private readonly clients = new Map<string, ClientConn>()
  /** Server-side issue tracker — constructed after loadFromStore() in the constructor. */
  readonly issues: IssueService
  /** Backend auto-continue loop; constructed in the constructor (see below). */
  private autoContinue!: AutoContinueController
  private readonly pendingScans = new Map<string, (r: ScanResult) => void>()
  private readonly pendingRepoScans = new Map<string, (r: ScanReposResult) => void>()
  private readonly pendingBreakdowns = new Map<string, (r: MemoryBreakdown | undefined) => void>()
  private readonly pendingRepoOps = new Map<string, (r: OpResult) => void>()
  private readonly pendingHarnessExecs = new Map<string, (r: OpResult) => void>()
  private readonly pendingUsage = new Map<
    string,
    (r: { hostname: string; buckets: UsageBucketWire[] }) => void
  >()
  private readonly pendingAgentQuota = new Map<
    string,
    (r: { hostname: string; agents: AgentQuotaWire[] }) => void
  >()
  private readonly pendingTranscriptReads = new Map<
    string,
    (r: { items: TranscriptItem[]; head?: string; tail?: string; hasMore: boolean }) => void
  >()
  private readonly pendingUploads = new Map<string, (r: { path: string; error?: string }) => void>()
  private readonly pendingFileReads = new Map<
    string,
    (r: Omit<FileReadResultMessage, 'type' | 'requestId'>) => void
  >()
  private readonly pendingFileAssets = new Map<
    string,
    (r: Omit<FileAssetResultMessage, 'type' | 'requestId'>) => void
  >()
  private readonly pendingFileWrites = new Map<
    string,
    (r: Omit<FileWriteResultMessage, 'type' | 'requestId'>) => void
  >()
  /**
   * In-progress composer/prompt text per session. The live value lives here (read
   * by attachClient to replay on connect); it is also debounced to the store so it
   * survives a server restart and a full web reload with no other client holding it
   * (issue #34). Hydrated from the store at boot in loadFromStore().
   */
  private draftBySession = new Map<string, string>()
  /** Per-session title debouncers — drop transient spinner titles, coalesce bursts. */
  private readonly titleDebouncers = new Map<string, ReturnType<typeof makeTitleDebouncer>>()
  // Pending debounced draft persists, keyed by sessionId — one timer per session
  // coalesces a burst of keystrokes into a single SQLite write.
  private readonly draftWriteTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private static readonly DRAFT_WRITE_DEBOUNCE_MS = 750
  private latestConversations: ConversationSummaryWire[] = []
  private latestConversationDiagnostics: ConversationDiagnosticWire[] = []
  // Last session-list payload broadcast to clients. broadcastSessions() fires on many
  // events (activity bumps, attach/detach, resume refs) that often don't change any
  // visible field; skipping a byte-identical re-broadcast avoids re-serializing the
  // whole list and fanning it out to every client for nothing (audit P1-8). Existing
  // clients already hold this state; a NEW client gets the current list via
  // attachClient, so the dedup can never leave a client stale.
  private lastSessionsBroadcast = ''
  // Latest health sample per daemon host, keyed by hostname — ready for several
  // machines even while the registry holds a single daemon socket.
  private readonly latestHostMetrics = new Map<string, HostMetricsWire>()
  private nextClientNum = 0
  // Shared by scan() ('r' prefix) and scanRepos() ('rr' prefix). Each scan
  // variant must use a distinct string prefix so ids never collide across the
  // separate pending maps.
  private nextRequestNum = 0
  // Last per-session output-relay priority pushed to the daemon. pushPriorities
  // diffs against this so only CHANGED sessions are re-sent (a viewState/attach
  // churn must not re-flood the daemon with the whole map every time).
  private readonly lastPriority = new Map<string, number>()

  constructor(
    private readonly store: SessionStore = new SessionStore(':memory:'),
    private readonly notificationPushers: NotificationPushers = DEFAULT_NOTIFICATION_PUSHERS,
  ) {
    this.loadFromStore()
    this.issues = new IssueService({
      store: this.store,
      listSessions: () => this.listSessions(),
      getSettings: () => this.store.getSettings(),
      spawnSession: (o) =>
        this.createSession({
          cwd: o.cwd,
          agentKind: o.agentKind as AgentKind,
          ...(o.initialPrompt ? { initialPrompt: o.initialPrompt } : {}),
        }),
      repoOp: (op, cwd, args) => this.repoOp(op, cwd, args),
      broadcast: (msg) => {
        for (const c of this.clients.values()) c.send(msg)
      },
    })
    this.autoContinue = new AutoContinueController({
      isEnabled: () => this.store.getSettings().autoContinue.enabled,
      sendContinue: (sessionId) => {
        this.continueSession({ sessionId })
      },
      getSession: (sessionId) => {
        // The controller re-arms off fresh agentState events, so overnight recovery
        // after a daemon reattach relies on reattach re-seeding agentState (seedBootState).
        const s = this.sessions.get(sessionId)
        if (!s) return undefined
        return { live: s.status === 'live' || s.status === 'starting', state: s.agentState }
      },
    })
  }

  /** The backing store — shared with services that persist their own tables (superagent). */
  get sessionStore(): SessionStore {
    return this.store
  }

  private persist(session: Session): void {
    this.store.upsertSession(session.toRow())
  }

  private loadFromStore(): void {
    // Restore persisted composer drafts so attachClient can replay them to the
    // first client to connect after a server restart (issue #34).
    for (const [sessionId, text] of Object.entries(this.store.loadDrafts())) {
      this.draftBySession.set(sessionId, text)
    }
    const draftTimes = this.store.loadDraftTimes()
    const snoozes = this.store.listSnoozes()
    for (const r of this.store.loadSessions()) {
      const kind = AgentKind.safeParse(r.agentKind)
      if (!kind.success) {
        console.warn(
          `[podium] skipping persisted session ${r.id}: invalid agentKind ${JSON.stringify(r.agentKind)}`,
        )
        continue
      }
      // Layer 3: a previously live/starting session may still be running in its tmux
      // server. Reload it as 'reconnecting' so attachDaemon can re-bind it; exited stays
      // exited, hibernated stays hibernated.
      const reloadStatus =
        r.status === 'live' || r.status === 'starting' ? 'reconnecting' : r.status
      const exitCode = r.status === 'exited' ? r.exitCode : null
      if (r.originKind === 'resume' && !r.conversationId) {
        console.warn(`[podium] persisted resume session ${r.id} has no conversationId`)
      }
      const session = new Session({
        sessionId: r.id,
        agentKind: kind.data,
        cwd: r.cwd,
        title: r.title,
        origin:
          r.originKind === 'resume'
            ? { kind: 'resume', conversationId: r.conversationId ?? '' }
            : { kind: 'spawn' },
        createdAt: r.createdAt,
        geometry: { ...DEFAULT_GEOMETRY },
        toDaemon: this.toDaemon,
        onActivity: () => {
          // Shell busy transitions advance lastActiveAt (their only activity signal);
          // persist so that recency is durable across a restart, then rebroadcast.
          this.persist(session)
          this.broadcastSessions()
        },
        durableLabel: r.durableLabel,
        lastActiveAt: r.lastActiveAt,
        status: reloadStatus,
        exitCode: exitCode ?? undefined,
        ...(r.name ? { name: r.name } : {}),
        archived: r.archived,
        ...(Session.parseWorkState(r.workState)
          ? { workState: Session.parseWorkState(r.workState) }
          : {}),
        ...(r.resumeKind && r.resumeValue
          ? { resume: { kind: r.resumeKind, value: r.resumeValue } }
          : {}),
      })
      this.sessions.set(r.id, session)
      if (r.id in snoozes) session.snoozedUntil = snoozes[r.id]
      if (r.id in draftTimes) session.draftUpdatedAt = draftTimes[r.id]
      if (r.status !== reloadStatus) this.persist(session)
    }
  }

  attachDaemon(send: Send<ControlMessage>): void {
    this.daemonSend = send
    // Flush control messages buffered while no daemon was attached (e.g. a boot
    // session's spawn produced before the daemon ws connected).
    if (this.pendingToDaemon.length > 0) {
      for (const m of this.pendingToDaemon.splice(0)) send(m)
    }
    // A freshly-(re)connected daemon knows no session's relay priority. Clear the
    // delta cache so every current session re-sends as a change, then push the full
    // map — otherwise a daemon restart would leave the scheduler at its default
    // until the next viewState/attach happened to flip a session.
    this.lastPriority.clear()
    this.pushPriorities()
    // Re-bind survivor sessions: ask the daemon to reattach to their live durable
    // host. 'reconnecting' = was live/starting at boot. 'exited' (not archived) is
    // also probed because a row can be wrongly 'exited': its attach client died on
    // a daemon restart while the master + agent survived in their scope (pre-fix
    // orphans, or any residual race). The daemon reattaches a live master (→ a
    // bind → markLive) or replies reattachFailed (→ it stays exited). The durable
    // host, not the persisted row, is the source of truth for liveness.
    // Most-recently-used first: the daemon gates its spawn fan-out, so the order we
    // send in decides who reattaches soonest. Prioritise the sessions the user most
    // likely has open. lastActiveAt is an ISO string, so a reverse lexical sort is
    // newest-first.
    const probes = [...this.sessions.values()]
      .filter((s) => s.status === 'reconnecting' || (s.status === 'exited' && !s.archived))
      .sort((a, b) => (b.lastActiveAt ?? '').localeCompare(a.lastActiveAt ?? ''))
    for (const s of probes) {
      this.toDaemon({
        type: 'reattach',
        sessionId: s.sessionId,
        durableLabel: s.durableLabel,
        agentKind: s.agentKind,
        cwd: s.cwd,
        geometry: s.geometry,
        ...(s.resume ? { resume: s.resume } : {}),
      })
    }
  }
  detachDaemon(): void {
    this.daemonSend = undefined
    // The daemon that held these sessions' PTY bridges is gone (daemon restart/crash;
    // durable masters survive in their own scopes). Drop live/starting sessions to
    // 'reconnecting' so the next daemon to attach re-binds them — attachDaemon only
    // probes 'reconnecting'/'exited'. Without this a daemon-only restart leaves
    // sessions 'live' but unattached: the server never re-asks and they orphan until
    // a server restart. (In the old single-process world the daemon never restarted
    // alone, so this gap couldn't surface.)
    let changed = false
    for (const s of this.sessions.values()) {
      if (s.markReconnecting()) changed = true
    }
    if (changed) this.broadcastSessions()
    // The daemon's host samples are only as live as its socket — drop them so a
    // dead machine's numbers never linger as truth.
    if (this.latestHostMetrics.size > 0) {
      this.latestHostMetrics.clear()
      this.broadcastHostMetrics()
    }
  }
  private readonly toDaemon: Send<ControlMessage> = (msg) => {
    if (this.daemonSend) this.daemonSend(msg)
    else this.pendingToDaemon.push(msg)
  }

  /**
   * Recompute per-session output-relay priority across every client and push the
   * deltas to the daemon. computePriorities re-iterates its `clients` argument
   * ONCE PER SESSION, so a single-use iterator (this.clients.values()) would
   * exhaust after the first session and read every later session as tier 3 —
   * materialize it to an array. Only CHANGED sessions are sent (diffed against
   * lastPriority) so a viewState/attach churn never re-floods the whole map.
   */
  private pushPriorities(): void {
    const priorities = computePriorities([...this.clients.values()], this.sessions.keys())
    for (const [sessionId, priority] of priorities) {
      if (this.lastPriority.get(sessionId) === priority) continue
      this.lastPriority.set(sessionId, priority)
      this.toDaemon({ type: 'sessionPriority', sessionId, priority })
    }
  }

  // ---- tRPC control plane ----
  listSessions(): SessionMeta[] {
    return [...this.sessions.values()].map((s) => s.toMeta())
  }

  listPins() {
    return this.store.listPins()
  }

  setPin(kind: PinKind, id: string, pinned: boolean) {
    this.store.setPin(kind, id, pinned)
  }

  listSnoozes() {
    return this.store.listSnoozes()
  }

  setSnooze({ sessionId, until }: { sessionId: string; until: string | null }): void {
    this.store.setSnooze(sessionId, until)
    const session = this.sessions.get(sessionId)
    if (session) session.snoozedUntil = until
    this.broadcastSessions()
  }

  clearSnooze(sessionId: string): void {
    this.store.clearSnooze(sessionId)
    const session = this.sessions.get(sessionId)
    if (session) session.clearSnooze()
    this.broadcastSessions()
  }

  /** Phases that put a session in the sidebar's attention bucket — mirrors the
   *  web's attentionGroup 'needsYou' branch. Used to clear a snooze when the
   *  agent moves on. */
  private static isAttentionPhase(s: AgentRuntimeState | undefined): boolean {
    const phase = s?.phase
    if (phase === 'needs_user' || phase === 'errored') return true
    if (phase === 'idle') return !!s?.idle && s.idle.kind !== 'done'
    return false
  }

  listTabOrders() {
    return this.store.listTabOrders()
  }

  setTabOrder(worktree: string, sessionIds: string[]) {
    this.store.setTabOrder(worktree, sessionIds)
  }

  getSettings(): PodiumSettings {
    return this.store.getSettings()
  }

  setSettings(settings: PodiumSettings): PodiumSettings {
    const wasEnabled = this.store.getSettings().autoContinue.enabled
    this.store.setSettings(settings)
    const nowEnabled = settings.autoContinue.enabled
    if (nowEnabled !== wasEnabled) {
      const ids = nowEnabled
        ? [...this.sessions.values()]
            .filter(
              (s) =>
                (s.status === 'live' || s.status === 'starting') &&
                s.agentState?.phase === 'errored' &&
                s.agentState.error?.retryable === true,
            )
            .map((s) => s.sessionId)
        : []
      this.autoContinue.onSettingsChanged(nowEnabled, ids)
    }
    return settings
  }

  /** Agent kind may be omitted — the settings default decides ('auto' = Claude Code).
   *  `initialPrompt` hands the fresh session a first prompt: for argv-capable agents
   *  (claude/codex/grok) it rides the launch command (`claude "<prompt>"`, race-free);
   *  for the rest it's seeded into the composer draft so the text still appears. */
  createSession(input: {
    agentKind?: AgentKind
    cwd: string
    title?: string
    initialPrompt?: string
  }): {
    sessionId: string
  } {
    const defaults = this.store.getSettings().sessionDefaults
    // Resolve the agent down to a concrete AgentKind. `agentKind` may be absent,
    // or carry a non-AgentKind sentinel like 'auto' (the issue start-flow casts
    // the issue's `defaultAgent` — which defaults to the 'auto' settings choice —
    // `as AgentKind` at the boundary). 'auto' is NOT a valid AgentKind: persisting
    // or broadcasting it fails the sessionsChanged zod-parse and silently wipes
    // the whole session list on every client. safeParse anything that isn't a real
    // kind back to the configured default (itself resolved out of 'auto').
    const requested = AgentKind.safeParse(input.agentKind)
    const agentKind = requested.success
      ? requested.data
      : defaults.agent === 'auto'
        ? 'claude-code'
        : defaults.agent
    const prompt = input.initialPrompt?.trim() ? input.initialPrompt : undefined
    // argv delivery is race-free (the CLI reads the prompt at startup); only
    // argv-capable agents get it that way. Others fall through to a draft seed.
    const useArgv = prompt !== undefined && agentSupportsInitialPrompt(agentKind)
    const spawned = this.spawn({
      agentKind,
      cwd: input.cwd,
      ...(input.title !== undefined ? { title: input.title } : {}),
      origin: { kind: 'spawn' },
      ...(useArgv ? { initialPrompt: prompt } : {}),
    })
    if (prompt !== undefined && !useArgv) {
      this.setSessionDraft({ sessionId: spawned.sessionId, text: prompt })
    }
    return spawned
  }

  resumeSession(input: {
    agentKind: AgentKind
    cwd: string
    resume: ResumeRef
    conversationId: string
    title?: string
  }): { sessionId: string } {
    return this.spawn({
      agentKind: input.agentKind,
      cwd: input.cwd,
      title: input.title,
      origin: { kind: 'resume', conversationId: input.conversationId },
      resume: input.resume,
    })
  }

  /**
   * The overview "Continue" button: nudge an errored agent to retry by typing
   * `continue⏎` into its PTY. Guarded to the errored phase so a stray click
   * can't inject text into a healthy prompt.
   */
  continueSession({ sessionId }: { sessionId: string }): { ok: boolean } {
    const session = this.sessions.get(sessionId)
    if (!session) return { ok: false }
    // Status gate as well as phase: a session can read 'errored' while its
    // process is already gone (hibernated/exited), where typing 'continue' would
    // vanish into a dead PTY yet still report ok. Only a running session can retry.
    if (session.status !== 'live' && session.status !== 'starting') return { ok: false }
    if (session.agentState?.phase !== 'errored') return { ok: false }
    this.toDaemon({
      type: 'input',
      sessionId,
      data: Buffer.from('continue\r').toString('base64'),
    })
    return { ok: true }
  }

  /**
   * Chat-view send: type a message into the agent's input as if pasted. Multi-line
   * text goes bracketed so the harness treats it as one block instead of
   * submitting at each newline; a trailing CR submits.
   */
  sendText({ sessionId, text }: { sessionId: string; text: string }): { ok: boolean } {
    const session = this.sessions.get(sessionId)
    if (!session || (session.status !== 'live' && session.status !== 'starting')) {
      return { ok: false }
    }
    // A submitted message re-engages the session — drop any snooze so it returns
    // to the normal attention flow (covers chat send + resumeAndSend paths).
    if (session.snoozedUntil !== undefined) this.clearSnooze(sessionId)
    const send = (data: string) =>
      this.toDaemon({ type: 'input', sessionId, data: Buffer.from(data).toString('base64') })
    // Bracketed paste so the harness takes the message as one input block, then the
    // submitting CR as its OWN write. A CR in the same chunk as the text (or right
    // after the paste-end marker) gets absorbed by some TUIs — the message lands in
    // the input but never submits. That bit single-line sends too (the plain
    // `${text}\r` path), which is the "types into native but doesn't submit" bug, so
    // both line counts now go through the same paste-then-submit sequence.
    send(`\x1b[200~${text}\x1b[201~`)
    send('\r')
    return { ok: true }
  }

  /**
   * Chat-view answer to a live AskUserQuestion prompt. The chat card sends the
   * 1-based option index (per question) and we type the matching digit(s) into
   * the agent's PTY to drive its native multiple-choice selector — the native
   * terminal is unmounted in chat mode, so this is the only path to the prompt.
   *
   * Claude Code's AskUserQuestion menu commits a single-select choice the instant
   * the option's number key is pressed (no Enter), and accepts comma-separated
   * numbers + Enter for multi-select. We send raw digits here (NOT bracketed
   * paste like `sendText`, which would land them as message text rather than
   * menu keystrokes). See the chat card for the option→digit mapping.
   *
   * `choices` is one entry per question being answered, each carrying the
   * question's 1-based option indices (one for single-select, ≥1 for multi).
   * NEEDS IN-BROWSER VERIFICATION against a real Claude prompt — the exact
   * key sequence the TUI expects is documented-but-unconfirmed here.
   */
  answerAskUserQuestion({
    sessionId,
    choices,
  }: {
    sessionId: string
    choices: { optionIndices: number[] }[]
  }): { ok: boolean } {
    const session = this.sessions.get(sessionId)
    if (!session || (session.status !== 'live' && session.status !== 'starting')) {
      return { ok: false }
    }
    const send = (data: string) =>
      this.toDaemon({ type: 'input', sessionId, data: Buffer.from(data).toString('base64') })
    for (const choice of choices) {
      const digits = choice.optionIndices.filter((n) => Number.isInteger(n) && n >= 1 && n <= 9)
      if (digits.length === 0) continue
      if (digits.length === 1) {
        // Single-select: the number key alone commits the choice and advances to
        // the next question (no Enter). A multi-question payload chains naturally.
        send(String(digits[0]))
      } else {
        // Multi-select: comma-separated indices, then Enter to confirm the set.
        send(`${digits.join(',')}\r`)
      }
    }
    return { ok: true }
  }

  setSessionDraft(input: { sessionId: string; text: string }, fromClientId?: string): void {
    if (input.text) this.draftBySession.set(input.sessionId, input.text)
    else this.draftBySession.delete(input.sessionId)
    // Mirror the draft's last-edit time onto the session so the sidebar can show
    // DRAFT and lift it in the attention ordering. The DRAFT tag / lift only
    // appears or disappears when a draft starts or is cleared, so rebroadcast the
    // session list on that PRESENCE change only — never per keystroke.
    const session = this.sessions.get(input.sessionId)
    const presenceChanged = session && (session.draftUpdatedAt !== undefined) !== !!input.text
    if (session) session.draftUpdatedAt = input.text ? new Date().toISOString() : undefined
    // Keep the existing live cross-client sync: push to every OTHER client (the
    // directional guard skips the originator so its own keystrokes don't echo back).
    for (const c of this.clients.values()) {
      if (c.id === fromClientId) continue
      c.send({ type: 'sessionDraftChanged', sessionId: input.sessionId, text: input.text })
    }
    this.persistDraft(input.sessionId, input.text)
    if (presenceChanged) this.broadcastSessions()
  }

  /**
   * Debounced draft persistence. Keystrokes coalesce per session into one SQLite
   * write after a short idle gap, so typing never hammers the synchronous DB.
   * An empty draft (the composer cleared on send) is flushed immediately and any
   * pending timer cancelled, so a stale draft can't outlive the message that was
   * sent — even if the server restarts in the debounce window.
   */
  private persistDraft(sessionId: string, text: string): void {
    const existing = this.draftWriteTimers.get(sessionId)
    if (existing) {
      clearTimeout(existing)
      this.draftWriteTimers.delete(sessionId)
    }
    if (!text) {
      this.writeDraft(sessionId, '')
      return
    }
    const timer = setTimeout(() => {
      this.draftWriteTimers.delete(sessionId)
      // Write the latest value rather than the captured one: a write that lands
      // after further edits (or a kill) should reflect the current in-memory state.
      this.writeDraft(sessionId, this.draftBySession.get(sessionId) ?? '')
    }, SessionRegistry.DRAFT_WRITE_DEBOUNCE_MS)
    timer.unref?.()
    this.draftWriteTimers.set(sessionId, timer)
  }

  private writeDraft(sessionId: string, text: string): void {
    try {
      this.store.setDraft(sessionId, text)
    } catch (e) {
      console.warn(`[podium] failed to persist draft for ${sessionId}:`, e)
    }
  }

  /**
   * Deliver text once the session is actually up. The superagent's start_agent
   * tool needs this: createSession returns immediately, but the CLI isn't ready
   * to receive input until it binds. Polls for 'live' and gives up if the spawn
   * fails (status 'exited') — better than a fixed timer that fires into a dead
   * PTY or before the prompt is drawn.
   */
  sendTextWhenReady(sessionId: string, text: string, timeoutMs = 25_000): void {
    const deadline = Date.now() + timeoutMs
    const tick = (): void => {
      const session = this.sessions.get(sessionId)
      if (!session || session.status === 'exited') return // gone — drop it
      if (session.status === 'live') {
        this.sendText({ sessionId, text })
        return
      }
      if (Date.now() >= deadline) return
      const t = setTimeout(tick, 500)
      t.unref?.()
    }
    const t = setTimeout(tick, 500)
    t.unref?.()
  }

  /** Set (or clear with '') the user-facing session name. */
  renameSession({ sessionId, name }: { sessionId: string; name: string }): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    session.name = name.trim()
    this.persist(session)
    this.broadcastSessions()
  }

  setArchived({ sessionId, archived }: { sessionId: string; archived: boolean }): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    session.archived = archived
    this.persist(session)
    this.broadcastSessions()
  }

  setWorkState({ sessionId, workState }: { sessionId: string; workState: WorkState | null }): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    session.workState = workState ?? undefined
    this.persist(session)
    this.broadcastSessions()
  }

  /**
   * Park a live session: kill its process (and durable host) but keep the row,
   * its transcript, and the resume ref. One click brings it back. Returns false
   * when the session can't come back later (no resume ref) — we refuse rather
   * than silently turn "hibernate" into "kill".
   */
  hibernateSession({ sessionId }: { sessionId: string }): { ok: boolean; reason?: string } {
    const session = this.sessions.get(sessionId)
    if (!session) return { ok: false, reason: 'unknown session' }
    if (session.status !== 'live') return { ok: false, reason: 'not running' }
    if (!session.resume) {
      return { ok: false, reason: 'no resume ref yet — the agent has not reported one' }
    }
    // Never park an agent mid-work: hibernation kills the process, and a
    // working/compacting agent would lose its in-flight turn. Auto-hibernation
    // already filters to idle/ended; enforcing it here makes the primitive (and
    // the manual hibernate button) safe regardless of caller.
    const phase = session.agentState?.phase
    if (phase === 'working' || phase === 'compacting') {
      return { ok: false, reason: 'agent is working — let it reach idle first' }
    }
    session.status = 'hibernated'
    this.autoContinue.onSessionGone(sessionId)
    this.persist(session)
    this.toDaemon({ type: 'kill', sessionId })
    this.broadcastSessions()
    return { ok: true }
  }

  /**
   * Chat-compose path for a parked session: if it's live, just send; if it's
   * hibernated/exited (process gone, conversation intact), wake it first and
   * deliver the text once the resumed CLI is ready to receive it. Lets the chat
   * composer accept a message on a sleeping agent instead of refusing input —
   * the message itself becomes the reason to wake.
   */
  resumeAndSend({ sessionId, text }: { sessionId: string; text: string }): {
    ok: boolean
    reason?: string
  } {
    const session = this.sessions.get(sessionId)
    if (!session) return { ok: false, reason: 'unknown session' }
    if (session.status === 'live' || session.status === 'starting') {
      return this.sendText({ sessionId, text })
    }
    if (session.status === 'hibernated' || session.status === 'exited') {
      const woke = this.resurrectSession({ sessionId })
      if (!woke.ok) return woke
      this.sendTextWhenReady(sessionId, text)
      return { ok: true }
    }
    return { ok: false, reason: 'session cannot accept input' }
  }

  /** Wake a hibernated session: respawn under the same id with its resume ref. */
  resurrectSession({ sessionId }: { sessionId: string }): { ok: boolean; reason?: string } {
    const session = this.sessions.get(sessionId)
    if (!session) return { ok: false, reason: 'unknown session' }
    // Hibernated (parked on purpose) and exited (process died or was killed
    // externally) are the same situation here: no process, but the row and the
    // resume ref are intact — both come back with one spawn.
    if (session.status !== 'hibernated' && session.status !== 'exited') {
      return { ok: false, reason: 'process still running' }
    }
    // A shell has no conversation to lose — a fresh spawn in the same cwd IS
    // full recovery, so it never needs a resume ref. Agents do: respawning one
    // without its ref would silently discard the conversation.
    if (session.agentKind !== 'shell' && !session.resume) {
      return { ok: false, reason: 'no resume ref' }
    }
    session.status = 'starting'
    session.exitCode = undefined
    this.persist(session)
    this.toDaemon({
      type: 'spawn',
      sessionId,
      agentKind: session.agentKind,
      cwd: session.cwd,
      ...(session.resume ? { resume: session.resume } : {}),
      geometry: session.geometry,
      ...this.modelDefaults(session.agentKind),
    })
    this.broadcastSessions()
    return { ok: true }
  }

  // At most one hibernation per cooldown window — memory readings need time to
  // reflect the previous kill before deciding to take down another agent.
  //
  // Single-daemon assumption: the registry holds one daemon socket, so every
  // session runs on the host these samples describe, and the cooldown is global
  // because there's one memory budget. When multi-daemon lands, sessions will
  // need a host id (none exists today) so candidate selection and the cooldown
  // can be scoped per host — building that attribution now would be speculative.
  private lastAutoHibernateMs = 0
  private maybeAutoHibernate(sample: HostMetricsWire): void {
    const cfg = this.store.getSettings().hibernation
    if (!cfg.enabled) return
    const m = sample.memory
    if (m.totalBytes <= 0) return
    const usedPct = ((m.totalBytes - m.availableBytes) / m.totalBytes) * 100
    if (usedPct < cfg.memoryPct) return
    const now = Date.now()
    if (now - this.lastAutoHibernateMs < 60_000) return
    const idleCutoff = now - cfg.idleMinutes * 60_000
    // A foreground turn can end (phase → idle) while a background agent or
    // `&`-spawned task keeps running — and a running agent paints its TUI, so
    // recent PTY output is the giveaway. Require the PTY to have been quiet for a
    // full minute before parking, so we never hibernate work that's still going.
    const OUTPUT_QUIET_MS = 60_000
    const candidates = [...this.sessions.values()]
      .filter(
        (s) =>
          s.status === 'live' &&
          s.resume !== undefined &&
          // Only agents that are demonstrably done/idle. needs_user keeps its
          // pending question; working agents are obviously off-limits.
          (s.agentState?.phase === 'idle' || s.agentState?.phase === 'ended') &&
          Date.parse(s.lastActiveAt) <= idleCutoff &&
          now - s.lastOutputMs >= OUTPUT_QUIET_MS,
      )
      .sort((a, b) => a.lastActiveAt.localeCompare(b.lastActiveAt))
    const target = candidates[0]
    if (!target) return
    this.lastAutoHibernateMs = now
    console.info(
      `[podium] memory ${usedPct.toFixed(0)}% on ${sample.hostname} ≥ ${cfg.memoryPct}% — hibernating idle session ${target.sessionId}`,
    )
    this.hibernateSession({ sessionId: target.sessionId })
  }

  killSession(input: { sessionId: string }): void {
    this.toDaemon({ type: 'kill', sessionId: input.sessionId })
    this.autoContinue.onSessionGone(input.sessionId)
    this.sessions.get(input.sessionId)?.detachAll()
    this.sessions.delete(input.sessionId)
    this.draftBySession.delete(input.sessionId)
    this.titleDebouncers.get(input.sessionId)?.dispose()
    this.titleDebouncers.delete(input.sessionId)
    // Cancel any pending debounced draft write before deleteSession removes the
    // row, so a late timer can't resurrect a draft for a now-dead session.
    const draftTimer = this.draftWriteTimers.get(input.sessionId)
    if (draftTimer) {
      clearTimeout(draftTimer)
      this.draftWriteTimers.delete(input.sessionId)
    }
    this.store.deleteSession(input.sessionId)
    for (const c of this.clients.values()) c.attached.delete(input.sessionId)
    this.broadcastSessions()
  }

  /**
   * Shared request/response plumbing for daemon round-trips: mint a prefixed
   * requestId, register a resolver keyed by it, send the control message, and
   * resolve a fallback on timeout. Every `*Result` daemon message looks its
   * resolver up in the matching pending map. One place to get unref/cleanup
   * right instead of six near-identical copies.
   */
  private daemonRequest<T>(
    pending: Map<string, (r: T) => void>,
    prefix: string,
    timeoutMs: number,
    onTimeout: () => T,
    buildMsg: (requestId: string) => ControlMessage,
  ): Promise<T> {
    const requestId = `${prefix}${this.nextRequestNum++}`
    return new Promise<T>((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(requestId)
        resolve(onTimeout())
      }, timeoutMs)
      timer.unref?.()
      pending.set(requestId, (r) => {
        clearTimeout(timer)
        resolve(r)
      })
      this.toDaemon(buildMsg(requestId))
    })
  }

  scan(): Promise<ScanResult> {
    return this.daemonRequest(
      this.pendingScans,
      'r',
      SCAN_TIMEOUT_MS,
      () => ({
        conversations: [],
        diagnostics: [{ severity: 'error', message: 'discovery scan timed out' }],
      }),
      (requestId) => ({ type: 'scanRequest', requestId }),
    )
  }

  scanRepos(
    roots: string[],
    opts: { includeHome?: boolean; maxDepth?: number } = {},
  ): Promise<ScanReposResult> {
    return this.daemonRequest(
      this.pendingRepoScans,
      'rr',
      SCAN_TIMEOUT_MS,
      () => ({
        repositories: [],
        diagnostics: [{ severity: 'error', path: '', message: 'repos scan timed out' }],
      }),
      (requestId) => ({
        type: 'scanReposRequest',
        requestId,
        roots,
        ...(opts.includeHome === undefined ? {} : { includeHome: opts.includeHome }),
        ...(opts.maxDepth === undefined ? {} : { maxDepth: opts.maxDepth }),
      }),
    )
  }

  /** Token-usage buckets from the daemon's transcript harvest (empty on timeout). */
  usage(sinceMs?: number): Promise<{ hostname: string; buckets: UsageBucketWire[] }> {
    return this.daemonRequest(
      this.pendingUsage,
      'us',
      20_000,
      () => ({ hostname: '', buckets: [] }),
      (requestId) => ({
        type: 'usageRequest',
        requestId,
        ...(sinceMs !== undefined ? { sinceMs } : {}),
      }),
    )
  }

  /** Per-agent plan-quota (5h/weekly windows), read live read-only on the daemon
   *  host. Empty agents on timeout. Distinct from `usage` (token-cost analytics). */
  agentQuota(refresh?: boolean): Promise<{ hostname: string; agents: AgentQuotaWire[] }> {
    return this.daemonRequest(
      this.pendingAgentQuota,
      'aq',
      20_000,
      () => ({ hostname: '', agents: [] }),
      (requestId) => ({
        type: 'agentQuotaRequest',
        requestId,
        ...(refresh !== undefined ? { refresh } : {}),
      }),
    )
  }

  /** Allowlisted git op on a dev machine (superagent tools). */
  repoOp(op: RepoOp, cwd: string, args?: Record<string, string>): Promise<OpResult> {
    return this.daemonRequest(
      this.pendingRepoOps,
      'ro',
      35_000,
      () => ({ ok: false, output: 'no daemon answered the git request in time' }),
      (requestId) => ({ type: 'repoOpRequest', requestId, op, cwd, ...(args ? { args } : {}) }),
    )
  }

  /** One-shot `claude -p` / `codex exec` / `grok -p` on a dev machine. */
  harnessExec(input: {
    agent: 'claude-code' | 'codex' | 'grok' | 'opencode' | 'cursor'
    model?: string
    prompt: string
    cwd?: string
    systemPrompt?: string
    mcpConfig?: string
    allowedTools?: string[]
  }): Promise<OpResult> {
    return this.daemonRequest(
      this.pendingHarnessExecs,
      'hx',
      250_000,
      () => ({ ok: false, output: 'harness run timed out' }),
      (requestId) => ({
        type: 'harnessExecRequest',
        requestId,
        agent: input.agent,
        prompt: input.prompt,
        ...(input.model && input.model !== 'auto' ? { model: input.model } : {}),
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(input.systemPrompt ? { systemPrompt: input.systemPrompt } : {}),
        ...(input.mcpConfig ? { mcpConfig: input.mcpConfig } : {}),
        ...(input.allowedTools ? { allowedTools: input.allowedTools } : {}),
      }),
    )
  }

  /**
   * Route an image upload to the owning daemon. The daemon writes the decoded
   * base64 bytes to ~/.podium/uploads/<sessionId>/<id>.<ext> and returns the
   * absolute path. Resolves with that path so the caller can insert it into a
   * prompt — Claude Code reads images by path.
   */
  uploadImage(input: {
    sessionId: string
    filename: string
    mimeType: string
    dataBase64: string
  }): Promise<{ path: string; error?: string }> {
    return this.daemonRequest(
      this.pendingUploads,
      'iu',
      30_000,
      () => ({ path: '' }),
      (requestId) => ({
        type: 'imageUploadRequest',
        requestId,
        sessionId: input.sessionId,
        filename: input.filename,
        mimeType: input.mimeType,
        dataBase64: input.dataBase64,
      }),
    )
  }

  /** Ask the daemon who owns the used memory. Resolves undefined when no daemon answers in time. */
  memoryBreakdown(roots: string[]): Promise<MemoryBreakdown | undefined> {
    return this.daemonRequest<MemoryBreakdown | undefined>(
      this.pendingBreakdowns,
      'mb',
      SCAN_TIMEOUT_MS,
      () => undefined,
      (requestId) => ({ type: 'memoryBreakdownRequest', requestId, roots }),
    )
  }

  private spawn(input: {
    agentKind: AgentKind
    cwd: string
    title?: string
    origin: SessionMeta['origin']
    resume?: ResumeRef
    initialPrompt?: string
  }): { sessionId: string } {
    const sessionId = randomUUID()
    const session = new Session({
      sessionId,
      agentKind: input.agentKind,
      cwd: input.cwd,
      title: input.title || basename(input.cwd) || input.cwd,
      origin: input.origin,
      createdAt: new Date().toISOString(),
      geometry: { ...DEFAULT_GEOMETRY },
      toDaemon: this.toDaemon,
      onActivity: () => {
        // Shell busy transitions advance lastActiveAt (their only activity signal);
        // persist so that recency is durable across a restart, then rebroadcast.
        this.persist(session)
        this.broadcastSessions()
      },
      durableLabel: `podium-${sessionId}`,
      ...(input.resume ? { resume: input.resume } : {}),
    })
    this.sessions.set(sessionId, session)
    this.persist(session)
    this.toDaemon({
      type: 'spawn',
      sessionId,
      agentKind: input.agentKind,
      cwd: input.cwd,
      ...(input.resume ? { resume: input.resume } : {}),
      ...(input.initialPrompt ? { initialPrompt: input.initialPrompt } : {}),
      geometry: { ...DEFAULT_GEOMETRY },
      ...this.modelDefaults(input.agentKind),
    })
    this.broadcastSessions()
    return { sessionId }
  }

  /**
   * Settings-driven model flags for a spawn message; 'auto' means no override.
   * Shared by every spawn path (fresh spawn AND resurrect) so a resumed session
   * keeps the configured model instead of silently dropping to the CLI default.
   */
  private modelDefaults(agentKind: AgentKind): { model?: string; subagentModel?: string } {
    const defaults = this.store.getSettings().sessionDefaults
    const model = defaults.model !== 'auto' ? defaults.model : undefined
    const subagentModel = defaults.subagentModel !== 'auto' ? defaults.subagentModel : undefined
    return {
      ...(model !== undefined && agentKind !== 'shell' ? { model } : {}),
      ...(subagentModel !== undefined && agentKind === 'claude-code' ? { subagentModel } : {}),
    }
  }

  // ---- ws data plane: clients ----
  attachClient(send: Send<ServerMessage>): string {
    const id = `c${this.nextClientNum++}`
    this.clients.set(id, {
      id,
      send,
      viewport: { ...DEFAULT_GEOMETRY },
      attached: new Set(),
      transcriptSubs: new Set(),
      // Fail-safe toward notifying: a client counts as NOT watching until it
      // tells us otherwise (every browser client sends `presence` right after
      // connecting). Defaulting to visible:true let one stale/non-browser client
      // silently suppress all mobile push forever.
      visible: false,
      // View-state defaults to "renders nothing, focuses nothing" until the client
      // sends its first `viewState`. A session reads as unwatched (tier 3) until then.
      viewVisible: new Set(),
      focused: null,
    })
    send({ type: 'welcome', clientId: id })
    send({ type: 'sessionsChanged', sessions: this.listSessions() })
    send(this.safeIssuesMessage())
    for (const [sessionId, text] of this.draftBySession) {
      send({ type: 'sessionDraftChanged', sessionId, text })
    }
    send({
      type: 'conversationsChanged',
      conversations: this.latestConversations,
      diagnostics: this.latestConversationDiagnostics,
    })
    if (this.latestHostMetrics.size > 0) send(this.hostMetricsMessage())
    return id
  }

  detachClient(id: string): void {
    const client = this.clients.get(id)
    if (!client) return
    for (const sessionId of client.attached) this.sessions.get(sessionId)?.detachClient(id)
    // Transcript subscriptions are independent of PTY attachment — sweep just the ones
    // THIS client made (audit P2-18), not every session on the host (the old full scan
    // was O(sessions) on every disconnect, and O(clients×sessions) in a reconnect storm).
    for (const sessionId of client.transcriptSubs)
      this.sessions.get(sessionId)?.unsubscribeTranscript(id)
    this.clients.delete(id)
    // A gone client no longer attaches/views/focuses anything — recompute so the
    // sessions it was watching can drop priority (and the daemon stops relaying
    // them live).
    this.pushPriorities()
    this.broadcastSessions()
  }

  /**
   * Reconnect reclaim: a freshly connected client (`next`) presents the id of its
   * previous socket (`priorId`). Move that stale client's controller roles onto
   * `next`, then evict it. Roles are transferred BEFORE eviction so detachClient's
   * "reassign to some other attached client" fallback doesn't hand control to a
   * third party (or drop it) in the window before `next` re-sends its attaches.
   * The client's own `attach` messages (which follow `hello`) then re-establish
   * PTY membership and resume the output stream.
   */
  private reclaimClient(priorId: string, next: ClientConn): void {
    const prior = this.clients.get(priorId)
    if (!prior || prior.id === next.id) return
    for (const sessionId of prior.attached) {
      this.sessions.get(sessionId)?.reassignController(priorId, next.id)
    }
    this.detachClient(priorId)
  }

  onClientMessage(id: string, msg: ClientMessage): void {
    const client = this.clients.get(id)
    if (!client) return
    switch (msg.type) {
      case 'hello':
        client.viewport = { cols: msg.viewport.cols, rows: msg.viewport.rows }
        // Reconnect identity. A client re-presents the id it was given on its
        // previous socket. Hand that now-stale client's controller roles to this
        // one and evict it, so a dropped or half-open socket doesn't strand the
        // user as a muted spectator of their own sessions (controller-gated input)
        // until the old connection's TCP finally times out. Single-user trust
        // model: a clientId is an identity hint, not a capability to guard.
        if (msg.clientId && msg.clientId !== id) this.reclaimClient(msg.clientId, client)
        break
      case 'attach': {
        const session = this.sessions.get(msg.sessionId)
        if (!session) return
        client.attached.add(msg.sessionId)
        session.attachClient(client, msg.sinceSeq)
        this.broadcastSessions()
        this.pushPriorities()
        break
      }
      case 'detach':
        client.attached.delete(msg.sessionId)
        this.sessions.get(msg.sessionId)?.detachClient(id)
        this.broadcastSessions()
        this.pushPriorities()
        break
      case 'input':
        this.sessions.get(msg.sessionId)?.handleInput(id, msg.data)
        break
      case 'resize':
        this.sessions.get(msg.sessionId)?.handleResize(id, msg.cols, msg.rows)
        break
      case 'requestControl':
        this.sessions.get(msg.sessionId)?.requestControl(id)
        this.broadcastSessions()
        break
      case 'redrawRequest':
        this.sessions.get(msg.sessionId)?.redraw()
        break
      case 'transcriptSubscribe':
        client.transcriptSubs.add(msg.sessionId)
        this.sessions.get(msg.sessionId)?.subscribeTranscript(client, msg.since)
        break
      case 'transcriptUnsubscribe':
        client.transcriptSubs.delete(msg.sessionId)
        this.sessions.get(msg.sessionId)?.unsubscribeTranscript(id)
        break
      case 'presence':
        client.visible = msg.visible
        break
      case 'viewState':
        client.viewVisible = new Set(msg.visible)
        client.focused = msg.focused
        this.pushPriorities()
        break
      case 'setSessionDraft':
        this.setSessionDraft(msg, id)
        break
      case 'ping':
        client.send({ type: 'pong' })
        break
    }
  }

  // ---- ws data plane: daemon ----
  onDaemonMessage(msg: DaemonMessage): void {
    switch (msg.type) {
      case 'bind': {
        this.sessions.get(msg.sessionId)?.markLive(msg.cmd, msg.geometry)
        const s = this.sessions.get(msg.sessionId)
        if (s) this.persist(s)
        this.broadcastSessions()
        break
      }
      case 'agentFrame':
        // The bridge's msg.seq is ignored — the Session assigns its own monotonic
        // seq so the client cursor stays stable across daemon reattaches.
        this.sessions.get(msg.sessionId)?.onFrame(msg.data)
        break
      case 'agentFrameBatch': {
        // The daemon coalesced several PTY frames for a lower-priority session into
        // one batch. Unpack back into per-frame onFrame so each still gets its own
        // server seq + outputFrame broadcast (clients are unchanged by coalescing).
        const session = this.sessions.get(msg.sessionId)
        if (session) for (const data of msg.frames) session.onFrame(data)
        break
      }
      case 'agentExit': {
        this.sessions.get(msg.sessionId)?.onExit(msg.code)
        this.autoContinue.onSessionGone(msg.sessionId)
        // Free the lingering per-session title debouncer when the process ends (audit
        // P1-12) — previously only killSession did, so every exited-but-not-killed
        // session leaked its debouncer closure. The row stays (resurrectable); a new
        // debouncer is created lazily if it ever emits a title again. Drafts are kept
        // (resurrect/chat needs them).
        this.titleDebouncers.get(msg.sessionId)?.dispose()
        this.titleDebouncers.delete(msg.sessionId)
        const s = this.sessions.get(msg.sessionId)
        if (s) this.persist(s)
        this.broadcastSessions()
        this.issues.onSessionActivity(msg.sessionId)
        break
      }
      case 'spawnError': {
        this.sessions.get(msg.sessionId)?.markSpawnError(msg.message)
        const s = this.sessions.get(msg.sessionId)
        if (s) this.persist(s)
        this.broadcastSessions()
        break
      }
      case 'reattachFailed': {
        const s = this.sessions.get(msg.sessionId)
        // Skip rows already exited: those are the boot-time probes of dead 'exited'
        // sessions (see attachDaemon). Re-running onExit there would re-broadcast a
        // redundant agentExit and churn the row on every restart. A 'reconnecting'
        // survivor that fails to reattach is a real death — mark it exited.
        if (s && s.status !== 'exited') {
          s.onExit(-1) // the durable host is gone; the agent died with it
          this.autoContinue.onSessionGone(s.sessionId) // cancel any armed retry promptly, not at the next backoff tick
          this.persist(s)
        }
        this.broadcastSessions()
        break
      }
      case 'agentState': {
        const session = this.sessions.get(msg.sessionId)
        if (!session) break
        const prev = session.agentState
        session.setAgentState(msg.state)
        this.autoContinue.onStateChange(msg.sessionId, msg.state)
        // Persist so the advanced recency (lastActiveAt) is durable across a server
        // restart — otherwise the row keeps its stale last-persisted time and the
        // ordering jumps backward on every redeploy until events re-arrive.
        this.persist(session)
        // A dedicated per-session message — not broadcastSessions(). Hook events
        // fire often (TodoWrite mutations, turn boundaries, across all sessions);
        // re-serializing and fanning out the whole session list each time is
        // O(sessions × clients). Late joiners still get state via listSessions().
        const update: ServerMessage = {
          type: 'sessionAgentStateChanged',
          sessionId: msg.sessionId,
          state: msg.state,
        }
        for (const c of this.clients.values()) c.send(update)
        this.issues.onSessionActivity(msg.sessionId)
        this.notifyAttention(session, prev, msg.state)
        if (
          session.snoozedUntil !== undefined &&
          SessionRegistry.isAttentionPhase(prev) &&
          !SessionRegistry.isAttentionPhase(msg.state)
        ) {
          this.clearSnooze(msg.sessionId)
        }
        break
      }
      case 'agentColor': {
        const session = this.sessions.get(msg.sessionId)
        if (!session) break
        // Identity colour changes rarely (only on /color), so a full session
        // rebroadcast is fine — no need for a dedicated per-session message.
        if (session.setAgentColor(msg.color)) this.broadcastSessions()
        break
      }
      case 'title': {
        const session = this.sessions.get(msg.sessionId)
        if (!session) break
        // Claude Code's OSC title sits at the generic "Claude Code" placeholder for
        // a while after start. Don't let it overwrite a real title we already have
        // (its own later summary, or the first-prompt fallback below) — that's the
        // "stuck on Claude Code" regression.
        if (
          isGenericClaudeTitle(msg.title) &&
          session.title &&
          !isGenericClaudeTitle(session.title)
        ) {
          break
        }
        // Apply the title to the in-memory session + persist immediately so that
        // write-through tests and late-joining clients always see the current title,
        // even during a rapid burst of transient spinner frames.
        if (!isTransientTitle(msg.title)) {
          session.setTitle(msg.title)
          // A non-generic agent title (Claude's own summary) is the real thing —
          // lock it so the first-prompt fallback won't fire/override.
          if (!isGenericClaudeTitle(msg.title)) session.titleLocked = true
          this.persist(session)
        }
        // The client broadcast is debounced: spinner/braille frames arrive at
        // frame-rate; coalescing them prevents UI flapping and excessive network
        // traffic. The debouncer only broadcasts stable (non-transient) titles.
        // Leading-edge: the debouncer emits on first non-transient title so a single
        // title push still broadcasts synchronously (test-friendly), then coalesces
        // subsequent rapid changes on the trailing edge.
        if (!this.titleDebouncers.has(msg.sessionId)) {
          const sid = msg.sessionId
          this.titleDebouncers.set(
            sid,
            makeTitleDebouncer((stableTitle) => {
              // A dedicated per-session message — not broadcastSessions(). Agents emit
              // titles at spinner frame-rate; rebroadcasting the whole list each time
              // would be wasteful, and late-joining clients still get the title via
              // listSessions() on attach.
              const update: ServerMessage = {
                type: 'sessionTitleChanged',
                sessionId: sid,
                title: stableTitle,
              }
              for (const c of this.clients.values()) c.send(update)
            }),
          )
        }
        this.titleDebouncers.get(msg.sessionId)!.push(msg.title)
        break
      }
      case 'scanResult': {
        this.latestConversations = msg.conversations
        this.latestConversationDiagnostics = msg.diagnostics
        this.indexConversations(msg.conversations, msg.removed ?? [])
        this.broadcastConversations()
        const resolve = this.pendingScans.get(msg.requestId)
        if (resolve) {
          this.pendingScans.delete(msg.requestId)
          resolve({ conversations: msg.conversations, diagnostics: msg.diagnostics })
        }
        break
      }
      case 'conversationsChanged': {
        this.latestConversations = msg.conversations
        this.latestConversationDiagnostics = msg.diagnostics
        this.indexConversations(msg.conversations, msg.removed ?? [])
        this.broadcastConversations()
        break
      }
      case 'scanReposResult': {
        const resolve = this.pendingRepoScans.get(msg.requestId)
        if (resolve) {
          this.pendingRepoScans.delete(msg.requestId)
          resolve({ repositories: msg.repositories, diagnostics: msg.diagnostics })
        }
        break
      }
      case 'hostMetrics': {
        const { type: _type, ...sample } = msg
        this.latestHostMetrics.set(msg.hostname, sample)
        this.broadcastHostMetrics()
        this.maybeAutoHibernate(sample)
        break
      }
      case 'sessionResumeRef': {
        const session = this.sessions.get(msg.sessionId)
        if (!session) break
        if (session.resume?.value !== msg.resume.value) {
          session.resume = msg.resume
          this.persist(session)
          // A resume ref makes the session resumable (→ hibernate button). Push the
          // updated meta so already-connected clients see it live, rather than only
          // when a coincident transcriptAppend happens to broadcast or on reconnect.
          this.broadcastSessions()
        }
        break
      }
      case 'transcriptDelta': {
        const session = this.sessions.get(msg.sessionId)
        if (
          session?.applyDelta(msg.items, {
            ...(msg.reset !== undefined ? { reset: msg.reset } : {}),
            ...(msg.tail !== undefined ? { tail: msg.tail } : {}),
          })
        ) {
          // First transcript for this session → its chat capability flipped on;
          // push the updated meta so clients can offer the chat toggle.
          this.broadcastSessions()
        }
        // Fast title for Claude: until a real title is locked in (its own summary,
        // or this fallback), name the session from the first user prompt so it
        // doesn't sit on the cwd/"Claude Code" placeholder for the long stretch
        // before Claude generates its own title.
        if (session && session.agentKind === 'claude-code' && !session.titleLocked) {
          const firstUser = session
            .transcriptItems()
            .find((it) => it.role === 'user' && it.text.trim().length > 0)
          const derived = firstUser ? titleFromPrompt(firstUser.text) : undefined
          if (derived) {
            session.setTitle(derived)
            session.titleLocked = true
            this.persist(session)
            const update: ServerMessage = {
              type: 'sessionTitleChanged',
              sessionId: msg.sessionId,
              title: derived,
            }
            for (const c of this.clients.values()) c.send(update)
          }
        }
        break
      }
      case 'repoOpResult': {
        const resolve = this.pendingRepoOps.get(msg.requestId)
        if (resolve) {
          this.pendingRepoOps.delete(msg.requestId)
          resolve({ ok: msg.ok, output: msg.output })
        }
        break
      }
      case 'harnessExecResult': {
        const resolve = this.pendingHarnessExecs.get(msg.requestId)
        if (resolve) {
          this.pendingHarnessExecs.delete(msg.requestId)
          resolve({ ok: msg.ok, output: msg.output })
        }
        break
      }
      case 'usageResult': {
        const resolve = this.pendingUsage.get(msg.requestId)
        if (resolve) {
          this.pendingUsage.delete(msg.requestId)
          resolve({ hostname: msg.hostname, buckets: msg.buckets })
        }
        break
      }
      case 'agentQuotaResult': {
        const resolve = this.pendingAgentQuota.get(msg.requestId)
        if (resolve) {
          this.pendingAgentQuota.delete(msg.requestId)
          resolve({ hostname: msg.hostname, agents: msg.agents })
        }
        break
      }
      case 'transcriptReadResult': {
        const resolve = this.pendingTranscriptReads.get(msg.requestId)
        if (resolve) {
          this.pendingTranscriptReads.delete(msg.requestId)
          resolve({
            items: msg.items,
            ...(msg.head !== undefined ? { head: msg.head } : {}),
            ...(msg.tail !== undefined ? { tail: msg.tail } : {}),
            hasMore: msg.hasMore,
          })
        }
        break
      }
      case 'imageUploadResult': {
        const resolve = this.pendingUploads.get(msg.requestId)
        if (resolve) {
          this.pendingUploads.delete(msg.requestId)
          resolve({ path: msg.path, ...(msg.error !== undefined ? { error: msg.error } : {}) })
        }
        break
      }
      case 'memoryBreakdownResult': {
        const resolve = this.pendingBreakdowns.get(msg.requestId)
        if (resolve) {
          this.pendingBreakdowns.delete(msg.requestId)
          const { type: _type, requestId: _requestId, ...breakdown } = msg
          resolve(breakdown)
        }
        break
      }
      case 'fileReadResult': {
        const resolve = this.pendingFileReads.get(msg.requestId)
        if (resolve) {
          this.pendingFileReads.delete(msg.requestId)
          const { type: _t, requestId: _r, ...payload } = msg
          resolve(payload)
        }
        break
      }
      case 'fileWriteResult': {
        const resolve = this.pendingFileWrites.get(msg.requestId)
        if (resolve) {
          this.pendingFileWrites.delete(msg.requestId)
          const { type: _t, requestId: _r, ...payload } = msg
          resolve(payload)
        }
        break
      }
      case 'fileAssetResult': {
        const resolve = this.pendingFileAssets.get(msg.requestId)
        if (resolve) {
          this.pendingFileAssets.delete(msg.requestId)
          const { type: _t, requestId: _r, ...payload } = msg
          resolve(payload)
        }
        break
      }
    }
  }

  /** Every discovery push lands in the durable index — search sees machines' full history. */
  private indexConversations(
    conversations: ConversationSummaryWire[],
    removed: string[] = [],
  ): void {
    this.store.upsertConversations(
      conversations.map((c) => ({
        id: c.id,
        agentKind: c.agentKind,
        providerId: c.providerId,
        ...(c.title !== undefined ? { title: c.title } : {}),
        ...(c.projectPath !== undefined ? { projectPath: c.projectPath } : {}),
        ...(c.resume ? { resumeKind: c.resume.kind, resumeValue: c.resume.value } : {}),
        ...(c.createdAt !== undefined ? { createdAt: c.createdAt } : {}),
        ...(c.updatedAt !== undefined ? { updatedAt: c.updatedAt } : {}),
        ...(c.messageCount !== undefined ? { messageCount: c.messageCount } : {}),
      })),
    )
    if (removed.length) this.store.deleteConversations(removed)
  }

  searchConversations(opts: { query?: string; projectPath?: string; limit?: number }) {
    return this.store.searchConversations(opts)
  }

  transcriptFor(sessionId: string) {
    return this.sessions.get(sessionId)?.transcriptItems() ?? []
  }

  /**
   * Transcript for the chat view — a pure daemon round-trip; disk is the source of
   * truth. Reads the requested window of `limit` items relative to `anchor` (a
   * cursor) in `direction` ('before' = older, 'after' = newer; no anchor = the
   * latest window). The daemon resolves the on-disk transcript from the session's
   * agentKind/cwd/resume and serves the slice — so a LIVE session with an empty
   * recent-delta cache (e.g. right after a server restart) still loads its history
   * straight off disk, instead of the old short-circuit that returned an empty
   * buffer. Resolves an empty, hasMore:false page when the session is unknown or no
   * daemon answers.
   */
  readTranscript(input: {
    sessionId: string
    anchor?: string
    direction: 'before' | 'after'
    limit: number
  }): Promise<{ items: TranscriptItem[]; head?: string; tail?: string; hasMore: boolean }> {
    const session = this.sessions.get(input.sessionId)
    if (!session) return Promise.resolve({ items: [], hasMore: false })
    return this.daemonRequest<{
      items: TranscriptItem[]
      head?: string
      tail?: string
      hasMore: boolean
    }>(
      this.pendingTranscriptReads,
      'tr',
      SCAN_TIMEOUT_MS,
      () => ({ items: [], hasMore: false }),
      (requestId) => ({
        type: 'transcriptRead',
        requestId,
        sessionId: input.sessionId,
        agentKind: session.agentKind,
        cwd: session.cwd,
        ...(session.resume ? { resume: session.resume } : {}),
        ...(input.anchor ? { anchor: input.anchor } : {}),
        direction: input.direction,
        limit: input.limit,
      }),
    )
  }

  readFile({
    sessionId,
    path,
  }: {
    sessionId: string
    path: string
  }): Promise<Omit<FileReadResultMessage, 'type' | 'requestId'>> {
    const session = this.sessions.get(sessionId)
    if (!session) return Promise.resolve({ ok: false, path, error: 'no session' })
    const knownPath = knownPathsFor(session.transcriptItems()).has(path)
    return this.daemonRequest(
      this.pendingFileReads,
      'fr',
      FILE_RPC_TIMEOUT_MS,
      () => ({ ok: false, path, error: 'timeout' }),
      (requestId) => ({ type: 'fileReadRequest', requestId, cwd: session.cwd, path, knownPath }),
    )
  }

  readAsset({
    sessionId,
    path,
  }: {
    sessionId: string
    path: string
  }): Promise<Omit<FileAssetResultMessage, 'type' | 'requestId'>> {
    const session = this.sessions.get(sessionId)
    if (!session) return Promise.resolve({ ok: false, path, error: 'no session' })
    const knownPath = knownPathsFor(session.transcriptItems()).has(path)
    return this.daemonRequest(
      this.pendingFileAssets,
      'fa',
      FILE_RPC_TIMEOUT_MS,
      () => ({ ok: false, path, error: 'timeout' }),
      (requestId) => ({ type: 'fileAssetRequest', requestId, cwd: session.cwd, path, knownPath }),
    )
  }

  writeFile({
    sessionId,
    path,
    content,
    baseHash,
  }: {
    sessionId: string
    path: string
    content: string
    baseHash?: string
  }): Promise<Omit<FileWriteResultMessage, 'type' | 'requestId'>> {
    const session = this.sessions.get(sessionId)
    if (!session) return Promise.resolve({ ok: false, error: 'no session' })
    return this.daemonRequest(
      this.pendingFileWrites,
      'fw',
      FILE_RPC_TIMEOUT_MS,
      () => ({ ok: false, error: 'timeout' }),
      (requestId) => ({
        type: 'fileWriteRequest',
        requestId,
        cwd: session.cwd,
        path,
        content,
        ...(baseHash ? { baseHash } : {}),
      }),
    )
  }

  setConversationMeta(input: { id: string; name?: string; summary?: string }): void {
    this.store.setConversationMeta(input.id, input)
  }

  /**
   * Smart-routed attention notifications. Web clients always get the event
   * (each shows it only while hidden); the mobile push (ntfy) fires only when
   * NO Podium window is visible anywhere — if you're looking at a desktop, the
   * phone stays quiet.
   */
  private notifyAttention(
    session: Session,
    prev: AgentRuntimeState | undefined,
    next: AgentRuntimeState,
  ): void {
    const settings = this.store.getSettings().notifications
    const name = session.name || session.title || session.cwd.split('/').pop() || 'agent'
    const notice = attentionNotice(name, prev, next)
    if (!notice) return
    if (settings.web) {
      const event: ServerMessage = {
        type: 'attentionEvent',
        sessionId: session.sessionId,
        title: notice.title,
        body: notice.body,
      }
      for (const c of this.clients.values()) c.send(event)
    }
    const telegram = {
      botToken: settings.telegramBotToken,
      chatId: settings.telegramChatId,
    }
    const telegramEnabled = telegram.botToken.trim() !== '' && telegram.chatId.trim() !== ''
    if (settings.ntfyTopic || telegramEnabled) {
      const someoneWatching = [...this.clients.values()].some((c) => c.visible)
      if (!someoneWatching) {
        if (settings.ntfyTopic) this.notificationPushers.ntfy(settings.ntfyTopic, notice)
        if (telegramEnabled) this.notificationPushers.telegram(telegram, notice)
      }
    }
  }

  private broadcastSessions(): void {
    const sessions = this.listSessions()
    // Skip a byte-identical re-broadcast (audit P1-8) — every existing client already
    // holds this exact list, and a new client gets it via attachClient, so re-sending
    // it changes nothing and just burns CPU + bandwidth across all clients.
    const key = JSON.stringify(sessions)
    if (key === this.lastSessionsBroadcast) return
    this.lastSessionsBroadcast = key
    const msg: ServerMessage = { type: 'sessionsChanged', sessions }
    for (const c of this.clients.values()) c.send(msg)
    // Session changes also change issues' DERIVED member data (sessions/summary),
    // so keep issue clients live. Build the payload ONCE: allWire() is
    // O(issues × sessions), so calling it per-client would be a hot-path perf bug
    // (mirrors the sessionsMsg hoist above). sessionsChanged was already sent above,
    // so even if the issues build fails it can't take the session list down with it.
    const issuesMsg = this.safeIssuesMessage()
    for (const c of this.clients.values()) c.send(issuesMsg)
  }

  /**
   * Build the `issuesChanged` payload, degrading to an empty list if the DERIVED
   * build throws (e.g. a poison issue row whose member sessions fail to serialize).
   * An issues-layer throw must never abort an attach, a broadcast, or the daemon
   * handler that triggered it. `this.issues?` also guards construction-time calls
   * (broadcastSessions can run via loadFromStore before `this.issues` is set).
   */
  private safeIssuesMessage(): ServerMessage {
    try {
      return { type: 'issuesChanged', issues: this.issues?.allWire() ?? [] }
    } catch (err) {
      console.warn('[podium] issues payload build failed — broadcasting empty issues list', err)
      return { type: 'issuesChanged', issues: [] }
    }
  }

  private broadcastConversations(): void {
    const msg: ServerMessage = {
      type: 'conversationsChanged',
      conversations: this.latestConversations,
      diagnostics: this.latestConversationDiagnostics,
    }
    for (const c of this.clients.values()) c.send(msg)
  }

  private hostMetricsMessage(): ServerMessage {
    return { type: 'hostMetricsChanged', hosts: [...this.latestHostMetrics.values()] }
  }

  private broadcastHostMetrics(): void {
    const msg = this.hostMetricsMessage()
    for (const c of this.clients.values()) c.send(msg)
  }
}
