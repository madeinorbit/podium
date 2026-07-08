import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  type AgentRuntimeState,
  type AgentSession,
  type AgentStateEvent,
  type AgentStateProvider,
  type CursorStateObserver,
  claudeProjectSlug,
  cursorSessionPaths,
  type GrokStateObserver,
  grokSessionPaths,
  initialAgentState,
  locateClaudeSessionFile,
  type OpencodeStateObserver,
  observeCodexState,
  observeCursorState,
  observeGrokState,
  observeOpencodeState,
  reduceAgentState,
  resolveFileChain,
} from '@podium/agent-bridge'
import type {
  AgentKind,
  ControlMessage,
  DaemonMessage,
  HarnessAgent,
  TranscriptItem,
} from '@podium/protocol'
import {
  codexRecordToItems,
  cursorRecordToItems,
  grokRecordToItems,
  type TranscriptTailer,
  tailTranscript,
} from '@podium/transcript'
import { countTail } from './loop-attribution'
import type { SessionCwdTracker } from './worktree-resolve'

export type SpawnControl = Extract<ControlMessage, { type: 'spawn' }>
export type ReattachControl = Extract<ControlMessage, { type: 'reattach' }>

export interface SessionObserverInit {
  /** Wait for the first PTY frame before seeding boot state (fresh spawn — the
   *  CLI isn't up yet); reattach seeds immediately (survivor is at its prompt). */
  seedOnFrame: boolean
  /** Freshness floor for spawn-time session discovery (grok/codex/opencode/cursor);
   *  omitted on reattach so discovery has no floor. */
  startedAtMs?: number
}

export interface SessionObserversDeps {
  send(msg: DaemonMessage): void
  /** Discovery homeDir override (tests / isolated HOME). */
  homeDir?: string | undefined
  /** A live transcript tail appended — mark the file dirty for the active index refresh. */
  onTranscriptDirty(path: string): void
  /** The hook payload's live cwd — feeds the session cwd tracker. */
  cwdTracker: Pick<SessionCwdTracker, 'onHookCwd'>
}

/** The reattach message's recorded-path evidence; spawns don't carry one. */
export function pathHintOf(msg: SpawnControl | ReattachControl): string | undefined {
  return 'pathHint' in msg ? msg.pathHint : undefined
}

export type SessionObservers = ReturnType<typeof createSessionObservers>

/**
 * All per-session observation state the daemon holds: agent-state trackers
 * (hook/observer events folded by the reducer), live transcript tails, and the
 * per-harness state observers (grok/codex/opencode/cursor). One factory owns the
 * maps so spawn, reattach, headless bind, hook ingest, kill and dispose all
 * mutate the SAME registry — the pre-#195 closure soup, made explicit.
 */
export function createSessionObservers(deps: SessionObserversDeps) {
  const { send } = deps
  const trackers = new Map<string, { provider: AgentStateProvider; state: AgentRuntimeState }>()
  // Live structured-transcript tails, keyed by Podium session id. Claude tails
  // the path reported by hook payloads; Grok tails its session chat_history.jsonl
  // once the observer learns the harness session id. Resume paths are derivable
  // for both harnesses, so reattached chat gets history before new activity.
  const tails = new Map<string, TranscriptTailer>()
  const grokStateObservers = new Map<string, GrokStateObserver>()
  // Codex state arrives on TWO channels: native hooks (codex ≥0.142, fast +
  // authoritative, the only source for PermissionRequest) POSTed to the shared
  // ingest, and the rollout observer below (binding, titles, and the fallback
  // for codex builds/sessions without hooks). These maps let the hook path pin
  // the observer to the thread the hook payload names without restarting a
  // correctly-bound observer on every POST.
  const codexStateObservers = new Map<string, { stop(): void }>()
  const codexBoundThreads = new Map<string, string>()
  const codexObserverCwds = new Map<string, string>()
  const opencodeStateObservers = new Map<string, OpencodeStateObserver>()
  const cursorStateObservers = new Map<string, CursorStateObserver>()

  const ensureTranscriptTail = (
    sessionId: string,
    path: string,
    recordToItems?: (record: unknown) => TranscriptItem[],
  ): void => {
    const existing = tails.get(sessionId)
    if (existing?.path === path) return
    existing?.stop()
    tails.set(
      sessionId,
      tailTranscript(
        path,
        (items, meta) => {
          if (items.length === 0 && !meta.reset) return
          countTail()
          send({
            type: 'transcriptDelta',
            sessionId,
            items,
            ...(meta.tail ? { tail: meta.tail } : {}),
            ...(meta.reset ? { reset: true } : {}),
          })
          // The tail fired because this transcript file was appended to — mark it
          // dirty so the worker re-summarizes JUST it (coalesced, ~1s) and keeps the
          // search index near-real-time, instead of waiting for the periodic scan.
          deps.onTranscriptDirty(path)
        },
        {
          ...(recordToItems ? { recordToItems } : {}),
          // The agent's `/color` accent rides the same transcript tail.
          onColor: (color) => send({ type: 'agentColor', sessionId, color }),
        },
      ),
    )
  }
  const stopTranscriptTail = (sessionId: string): void => {
    tails.get(sessionId)?.stop()
    tails.delete(sessionId)
  }
  const stopGrokStateObserver = (sessionId: string): void => {
    grokStateObservers.get(sessionId)?.stop()
    grokStateObservers.delete(sessionId)
  }
  const stopCodexStateObserver = (sessionId: string): void => {
    codexStateObservers.get(sessionId)?.stop()
    codexStateObservers.delete(sessionId)
    codexBoundThreads.delete(sessionId)
    codexObserverCwds.delete(sessionId)
  }
  const stopOpencodeStateObserver = (sessionId: string): void => {
    opencodeStateObservers.get(sessionId)?.stop()
    opencodeStateObservers.delete(sessionId)
  }
  const stopCursorStateObserver = (sessionId: string): void => {
    cursorStateObservers.get(sessionId)?.stop()
    cursorStateObservers.delete(sessionId)
  }
  const applyAgentStateEvents = (sessionId: string, events: AgentStateEvent[]): void => {
    const tracker = trackers.get(sessionId)
    if (!tracker) return
    for (const event of events) {
      const next = reduceAgentState(tracker.state, event, new Date().toISOString())
      if (next === tracker.state) continue
      tracker.state = next
      send({ type: 'agentState', sessionId, state: next })
    }
  }
  const startGrokStateObserver = (
    sessionId: string,
    cwd: string,
    resumeValue: string | undefined,
    // On a fresh spawn, pass the actual spawn timestamp so discovery skips older
    // sibling sessions in the same cwd. On reattach, pass undefined → observeGrokState
    // defaults watermarkMs to 0 (no floor), so the latest-by-activity session
    // is found even if it predates this daemon process start.
    startedAtMs?: number,
  ): void => {
    stopGrokStateObserver(sessionId)
    grokStateObservers.set(
      sessionId,
      observeGrokState({
        cwd,
        ...(resumeValue ? { resumeValue } : {}),
        ...(deps.homeDir ? { homeDir: deps.homeDir } : {}),
        ...(startedAtMs !== undefined ? { startedAtMs } : {}),
        onSession: (grokSessionId) => {
          send({
            type: 'sessionResumeRef',
            sessionId,
            resume: { kind: 'grok-session', value: grokSessionId },
          })
          tailGrokTranscript(sessionId, cwd, grokSessionId)
        },
        onEvents: (events) => applyAgentStateEvents(sessionId, events),
      }),
    )
  }
  // Eagerly tail a claude-code session's resume transcript — the JSONL the harness
  // is already writing. The chat view then has history before the first hook fires.
  // Essential on reattach: a fresh daemon's tails map is empty and an idle survivor
  // fires no hook to register one, so chat would stay blank while the PTY scrollback
  // (native view) still shows the whole conversation.
  const tailResumeTranscript = (
    sessionId: string,
    cwd: string,
    resumeValue: string,
    pathHint?: string,
  ): void => {
    // Honor a discovery homeDir override (tests / isolated HOME) so the live tail
    // reads the SAME location the on-demand read source does — otherwise a daemon
    // run against an isolated home would tail the real ~/.claude and find nothing.
    const home = deps.homeDir ?? homedir()
    void (async () => {
      // Locate, don't derive: after a worktree move the file lives in the ORIGINAL
      // cwd's bucket (docs/spec/conversation-registry.md §3.3). Fall back to the
      // derived path when nothing exists yet — a fresh resume creates the file a
      // moment later and the tailer waits on it.
      const located = await locateClaudeSessionFile({
        cwd,
        resumeValue,
        ...(pathHint ? { pathHint } : {}),
        homeDir: home,
      })
      ensureTranscriptTail(
        sessionId,
        located ??
          join(home, '.claude', 'projects', claudeProjectSlug(cwd), `${resumeValue}.jsonl`),
      )
    })()
  }
  // Start a claude-code session's transcript tail. With a resume ref we know the
  // exact file (derivable path). WITHOUT one — a fresh spawn that hasn't yet
  // reported a session id, or a reattach where the server never learned the resume
  // value — discover the newest .jsonl in the cwd bucket and tail that, so chat has
  // history from the start instead of waiting for the first hook (and so an idle
  // survivor that fires no hook still gets a tail). Hooks remain a fast-path: when
  // a hook lands, its transcript_path re-points ensureTranscriptTail at the live
  // file (the discovered one is the same file in the common case).
  const startClaudeTranscriptTail = (
    sessionId: string,
    cwd: string,
    resumeValue?: string,
    pathHint?: string,
  ): void => {
    if (resumeValue) {
      tailResumeTranscript(sessionId, cwd, resumeValue, pathHint)
      return
    }
    void (async () => {
      const chain = await resolveFileChain({
        agentKind: 'claude-code',
        cwd,
        ...(deps.homeDir ? { homeDir: deps.homeDir } : {}),
      })
      const newest = chain.at(-1)
      if (newest) ensureTranscriptTail(sessionId, newest.path)
    })()
  }
  const tailGrokTranscript = (sessionId: string, cwd: string, grokConversationId: string): void => {
    ensureTranscriptTail(
      sessionId,
      grokSessionPaths({
        cwd,
        sessionId: grokConversationId,
        ...(deps.homeDir ? { homeDir: deps.homeDir } : {}),
      }).chatHistoryPath,
      grokRecordToItems,
    )
  }
  const tailCodexTranscript = (sessionId: string, rolloutPath: string): void => {
    // Codex's rollout file carries both the conversation and state — the same
    // path the observer found feeds the chat tail.
    ensureTranscriptTail(sessionId, rolloutPath, codexRecordToItems)
  }
  const tailCursorTranscript = (sessionId: string, cwd: string, chatId: string): void => {
    ensureTranscriptTail(
      sessionId,
      cursorSessionPaths({
        cwd,
        chatId,
        ...(deps.homeDir ? { homeDir: deps.homeDir } : {}),
      }).transcriptPath,
      cursorRecordToItems,
    )
  }
  const startCursorStateObserver = (
    sessionId: string,
    cwd: string,
    resumeValue: string | undefined,
    startedAtMs = Date.now(),
  ): void => {
    stopCursorStateObserver(sessionId)
    cursorStateObservers.set(
      sessionId,
      observeCursorState({
        cwd,
        ...(resumeValue ? { resumeValue } : {}),
        ...(deps.homeDir ? { homeDir: deps.homeDir } : {}),
        startedAtMs,
        onSession: (chatId) => {
          send({
            type: 'sessionResumeRef',
            sessionId,
            resume: { kind: 'cursor-chat', value: chatId },
          })
          tailCursorTranscript(sessionId, cwd, chatId)
        },
        onEvents: (events) => applyAgentStateEvents(sessionId, events),
      }),
    )
  }
  const startOpencodeStateObserver = (
    sessionId: string,
    cwd: string,
    resumeValue: string | undefined,
    startedAtMs = Date.now(),
  ): void => {
    stopOpencodeStateObserver(sessionId)
    opencodeStateObservers.set(
      sessionId,
      observeOpencodeState({
        cwd,
        ...(resumeValue ? { resumeValue } : {}),
        ...(deps.homeDir ? { homeDir: deps.homeDir } : {}),
        startedAtMs,
        onSession: (opencodeSessionId) => {
          send({
            type: 'sessionResumeRef',
            sessionId,
            resume: { kind: 'opencode-session', value: opencodeSessionId },
          })
        },
        onEvents: (events) => applyAgentStateEvents(sessionId, events),
        onTranscriptItems: (items, reset) => {
          if (items.length === 0 && !reset) return
          // Items are already cursor-stamped (stampOpencodeItems) by the observer,
          // so the live delta carries the same cursors the on-demand read produces.
          const tail = items.at(-1)?.cursor
          send({
            type: 'transcriptDelta',
            sessionId,
            items,
            ...(reset ? { reset: true } : {}),
            ...(tail ? { tail } : {}),
          })
        },
      }),
    )
  }
  const startCodexStateObserver = (
    sessionId: string,
    cwd: string,
    // A reattach/resume passes the session's known codex-thread id so the observer
    // pins its OWN rollout instead of re-discovering by cwd+mtime (which collapses
    // sibling sessions in the same repo onto the newest rollout). A fresh spawn
    // passes undefined → discovery scoped by startedAtMs.
    resumeValue: string | undefined,
    startedAtMs?: number,
  ): void => {
    stopCodexStateObserver(sessionId)
    codexObserverCwds.set(sessionId, cwd)
    codexStateObservers.set(
      sessionId,
      observeCodexState({
        cwd,
        ...(resumeValue ? { resumeValue } : {}),
        ...(deps.homeDir ? { homeDir: deps.homeDir } : {}),
        ...(startedAtMs !== undefined ? { startedAtMs } : {}),
        onSession: (rolloutId, rolloutPath) => {
          codexBoundThreads.set(sessionId, rolloutId)
          // Recording a resume ref marks the session resumable (→ hibernate
          // button); the first transcript frame marks it chat-capable (→ chat
          // switcher + BTW button).
          send({
            type: 'sessionResumeRef',
            sessionId,
            resume: { kind: 'codex-thread', value: rolloutId },
          })
          tailCodexTranscript(sessionId, rolloutPath)
        },
        // Codex's OSC terminal title is just the cwd basename (suppressed in
        // wireBridge); the observer derives a real title from the thread instead.
        onTitle: (title) => send({ type: 'title', sessionId, title }),
        onEvents: (events) => applyAgentStateEvents(sessionId, events),
      }),
    )
  }

  // Seed agent state for a session whose CLI is already running but hasn't fired a
  // hook yet. Claude Code emits no SessionStart at interactive boot, so both a
  // fresh spawn and a post-restart reattach would otherwise sit at phase 'unknown'
  // — which the home board reads as 'working', flagging an idle survivor as active.
  // bootEvents reports idle (a resume value classifies the live transcript for a
  // richer verdict). Guarded on phase still 'unknown' so a real hook that already
  // landed always wins; best-effort, hooks remain authoritative.
  const seedBootState = async (
    sessionId: string,
    provider: AgentStateProvider,
    cwd: string,
    resumeValue?: string,
    pathHint?: string,
  ): Promise<void> => {
    if (!provider.bootEvents) return
    let events: AgentStateEvent[]
    try {
      events = await provider.bootEvents({
        cwd,
        ...(resumeValue ? { resumeValue } : {}),
        ...(pathHint ? { pathHint } : {}),
      })
    } catch {
      return
    }
    const tracker = trackers.get(sessionId)
    if (!tracker) return
    for (const event of events) {
      if (tracker.state.phase !== 'unknown') return
      const next = reduceAgentState(tracker.state, event, new Date().toISOString())
      if (next === tracker.state) continue
      tracker.state = next
      send({ type: 'agentState', sessionId, state: next })
    }
  }

  // Per-harness observer wiring — the daemon-side half of the #158 adapter
  // registry (the closures live here, next to the observers they start). The
  // exhaustive Record makes a new harness kind a type error until it declares
  // its observer binding.
  const sessionObserverBindings: Record<
    HarnessAgent,
    (msg: SpawnControl | ReattachControl, init: SessionObserverInit) => void
  > = {
    grok: (msg, init) => {
      startGrokStateObserver(msg.sessionId, msg.cwd, msg.resume?.value, init.startedAtMs)
    },
    codex: (msg, init) => {
      // Codex creates its rollout lazily (often at the first prompt), so a
      // reattached observer must still be able to discover by cwd — floored at
      // the session's original spawn time so it can't latch onto an older
      // sibling's rollout. Spawn passes its own start; reattach the persisted one.
      const codexFloor = init.startedAtMs ?? ('createdAtMs' in msg ? msg.createdAtMs : undefined)
      startCodexStateObserver(msg.sessionId, msg.cwd, msg.resume?.value, codexFloor)
    },
    opencode: (msg, init) => {
      startOpencodeStateObserver(msg.sessionId, msg.cwd, msg.resume?.value, init.startedAtMs)
    },
    cursor: (msg, init) => {
      startCursorStateObserver(msg.sessionId, msg.cwd, msg.resume?.value, init.startedAtMs)
      if (msg.resume) tailCursorTranscript(msg.sessionId, msg.cwd, msg.resume.value)
    },
    'claude-code': (msg) => {
      // Ungated: start the tail even without a resume ref (discover the newest
      // file in the cwd bucket). A hook later re-points the tail if needed.
      // Reattach carries the server's recorded segment path — evidence beats
      // cwd derivation after a worktree move (conversation registry §3.3).
      startClaudeTranscriptTail(msg.sessionId, msg.cwd, msg.resume?.value, pathHintOf(msg))
    },
  }

  // (Re)build the per-session observers a fresh daemon must stand up right after
  // wiring the PTY bridge: the agent-state tracker, the harness state observer
  // (Grok has no hook channel), the resume transcript tail (Claude chat history
  // before the first hook), and a seeded phase. Spawn AND reattach both call this
  // so the two paths can't silently diverge — that drift left idle survivors shown
  // 'working' with an empty chat after a redeploy.
  const initSessionObservers = (
    msg: SpawnControl | ReattachControl,
    session: AgentSession,
    provider: AgentStateProvider | undefined,
    init: SessionObserverInit,
  ): void => {
    if (provider) {
      trackers.set(msg.sessionId, {
        provider,
        state: initialAgentState(new Date().toISOString()),
      })
    }
    // Registry lookup; 'shell' has no binding (no transcript, no observers).
    const bindObservers = (
      sessionObserverBindings as Partial<
        Record<AgentKind, (typeof sessionObserverBindings)[HarnessAgent]>
      >
    )[msg.agentKind]
    bindObservers?.(msg, init)
    if (provider?.bootEvents) {
      // const capture so the narrowing survives into the onFrame closure.
      const bootProvider = provider
      const seed = (): void => {
        void seedBootState(msg.sessionId, bootProvider, msg.cwd, msg.resume?.value, pathHintOf(msg))
      }
      if (init.seedOnFrame) {
        const offFirstFrame = session.onFrame(() => {
          offFirstFrame()
          seed()
        })
      } else {
        seed()
      }
    }
  }

  /** Stand up the per-kind transcript observers/tails for a headless session —
   *  the same setup initSessionObservers does on reattach, minus the PTY and
   *  state tracker (headless sessions have no hook channel; observers that call
   *  applyAgentStateEvents no-op without a tracker). Same registry contract as
   *  the session observer table above (exhaustive over HarnessAgent). */
  const headlessBindings: Record<
    HarnessAgent,
    (sessionId: string, cwd: string, resumeValue: string) => void
  > = {
    'claude-code': (sessionId, cwd, resumeValue) => {
      startClaudeTranscriptTail(sessionId, cwd, resumeValue)
    },
    codex: (sessionId, cwd, resumeValue) => {
      // The observer pins the rollout by thread id and re-resolves the tailed
      // path (resume may mint a new rollout file).
      startCodexStateObserver(sessionId, cwd, resumeValue)
    },
    grok: (sessionId, cwd, resumeValue) => {
      startGrokStateObserver(sessionId, cwd, resumeValue)
    },
    opencode: (sessionId, cwd, resumeValue) => {
      startOpencodeStateObserver(sessionId, cwd, resumeValue)
    },
    cursor: (sessionId, cwd, resumeValue) => {
      startCursorStateObserver(sessionId, cwd, resumeValue)
      tailCursorTranscript(sessionId, cwd, resumeValue)
    },
  }

  const bindHeadlessSession = (
    sessionId: string,
    agentKind: AgentKind,
    cwd: string,
    resumeValue: string,
  ): void => {
    const bind = (
      headlessBindings as Partial<Record<AgentKind, (typeof headlessBindings)[HarnessAgent]>>
    )[agentKind]
    if (!bind) throw new Error(`agent kind ${agentKind} has no headless transcript binding`)
    bind(sessionId, cwd, resumeValue)
  }

  // The shared hook ingest's onPayload: Claude AND Codex (≥0.142 native hooks)
  // both post here with the same core shape (session_id + transcript_path +
  // hook_event_name); route per harness and feed the state tracker.
  const onHookPayload = (sessionId: string, payload: unknown): void => {
    const tracker = trackers.get(sessionId)
    if (!tracker) return
    const isCodex = codexObserverCwds.has(sessionId)
    // Every hook payload carries transcript_path — the authoritative pointer
    // to the live JSONL (resumes roll into a fresh file; this follows).
    const fields = payload as Record<string, unknown> | null
    const transcriptPath = fields?.transcript_path
    if (typeof transcriptPath === 'string' && transcriptPath) {
      if (isCodex) ensureTranscriptTail(sessionId, transcriptPath, codexRecordToItems)
      else ensureTranscriptTail(sessionId, transcriptPath)
    }
    // The hook payload's session_id is the harness's own conversation id — the
    // authoritative resume ref (don't reverse-engineer it from the filename,
    // which couples us to the harness's on-disk layout). Lets the server
    // hibernate a fresh spawn and resume it later.
    const harnessSessionId = fields?.session_id
    if (typeof harnessSessionId === 'string' && harnessSessionId) {
      send({
        type: 'sessionResumeRef',
        sessionId,
        resume: { kind: isCodex ? 'codex-thread' : 'claude-session', value: harnessSessionId },
      })
      // Deterministic binding: the hook names the thread this pane REALLY runs,
      // ending any discovery ambiguity (lazy rollout creation, cwd siblings, a
      // mid-session /new rolling to a fresh thread). Re-pin the observer only
      // when its binding disagrees — every later POST is a cheap map hit.
      if (isCodex && codexBoundThreads.get(sessionId) !== harnessSessionId) {
        const cwd =
          codexObserverCwds.get(sessionId) ?? (typeof fields?.cwd === 'string' ? fields.cwd : '')
        startCodexStateObserver(sessionId, cwd, harnessSessionId)
        codexBoundThreads.set(sessionId, harnessSessionId)
      }
    }
    // The agent's live working directory — follows EnterWorktree and `cd`. The
    // tracker resolves it to the containing worktree root and tells the server
    // only when THAT changes, so the sidebar re-groups on real worktree moves
    // but not on subdirectory cds within the same checkout.
    const hookCwd = fields?.cwd
    if (typeof hookCwd === 'string' && hookCwd) {
      void deps.cwdTracker.onHookCwd(sessionId, hookCwd)
    }
    void tracker.provider
      .translate(payload)
      .then((events) => applyAgentStateEvents(sessionId, events))
      .catch((err) => console.warn(`[podium] hook translate failed for ${sessionId}:`, err))
  }

  /** Current tracked agent state, if the session has a live tracker. */
  const trackedState = (sessionId: string): AgentRuntimeState | undefined =>
    trackers.get(sessionId)?.state

  /** Tear down every observer + tail + tracker one session holds (exit/kill path). */
  const clearSession = (sessionId: string): void => {
    trackers.delete(sessionId)
    stopGrokStateObserver(sessionId)
    stopCodexStateObserver(sessionId)
    stopOpencodeStateObserver(sessionId)
    stopCursorStateObserver(sessionId)
    stopTranscriptTail(sessionId)
  }

  const stopAllTails = (): void => {
    for (const id of [...tails.keys()]) stopTranscriptTail(id)
  }

  /** Stop every observer + tracker (daemon dispose). Tails are stopped separately
   *  by close() — matching the pre-split shutdown order. */
  const disposeObservers = (): void => {
    for (const id of [...grokStateObservers.keys()]) stopGrokStateObserver(id)
    for (const id of [...codexStateObservers.keys()]) stopCodexStateObserver(id)
    for (const id of [...opencodeStateObservers.keys()]) stopOpencodeStateObserver(id)
    for (const id of [...cursorStateObservers.keys()]) stopCursorStateObserver(id)
    trackers.clear()
  }

  return {
    ensureTranscriptTail,
    stopTranscriptTail,
    startClaudeTranscriptTail,
    initSessionObservers,
    bindHeadlessSession,
    onHookPayload,
    trackedState,
    clearSession,
    stopAllTails,
    disposeObservers,
  }
}
