import {
  type AgentRuntimeState,
  type AgentSession,
  type AgentStateEvent,
  type AgentStateProvider,
  type HarnessAdapter,
  type HarnessObservation,
  type HarnessObserveInput,
  type HarnessObserverHost,
  harnessAdapterFor,
  initialAgentState,
  reduceAgentState,
} from '@podium/agent-bridge'
import type { AgentKind, ControlMessage, DaemonMessage, TranscriptItem } from '@podium/protocol'
import { recordToItemsForKind, type TranscriptTailer, tailTranscript } from '@podium/transcript'
import { countTail, timeTask } from './loop-attribution'
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
  /** Persist and replay an exact process-derived Codex P→T binding until acked. */
  onExactCodexBinding?: (sessionId: string, nativeId: string) => Promise<void>
  /** Paces each tail's FIRST backfill read (the expensive part of a reattach
   *  burst) — narrow concurrency, and held until the burst's bridge wiring has
   *  settled (POD-612). Omitted (tests) = seeds run immediately. */
  tailSeedGate?: (fn: () => Promise<void>) => Promise<void>
}

/** The reattach message's recorded-path evidence; spawns don't carry one. */
export function pathHintOf(msg: SpawnControl | ReattachControl): string | undefined {
  return 'pathHint' in msg ? msg.pathHint : undefined
}

export type SessionObservers = ReturnType<typeof createSessionObservers>

/**
 * All per-session observation state the daemon holds: agent-state trackers
 * (hook/observer events folded by the reducer), live transcript tails, and one
 * harness observation per session. The host is GENERIC (#249): everything
 * per-agent — what to watch, when a session id is known, which file to tail,
 * the hook re-pin policy — lives in the harness adapter's `observer`; this
 * factory owns the maps and the wire, so spawn, reattach, headless bind, hook
 * ingest, kill and dispose all mutate the SAME registry.
 */
export function createSessionObservers(deps: SessionObserversDeps) {
  const { send } = deps
  const trackers = new Map<string, { provider: AgentStateProvider; state: AgentRuntimeState }>()
  // Live structured-transcript tails, keyed by Podium session id. Adapters point
  // the tail at their harness's live file (claude via hook payloads and the
  // resume-transcript bootstrap; grok/codex/cursor once their observer learns
  // the harness session id), so reattached chat gets history before new activity.
  const tails = new Map<string, TranscriptTailer>()
  // One live observation per session — the adapter-owned watch over the
  // harness's native session store (state observers, tail bootstrap, and for
  // codex the hook re-pin policy). The adapter rides along so the hook ingest
  // can resolve the session's resumeKind and record mapper without per-agent
  // branches.
  const observations = new Map<
    string,
    { adapter: HarnessAdapter; observation: HarnessObservation }
  >()

  // Live-tail SEED window (POD-613): the first read only refills the server's
  // gap-bridging per-session buffer (chat-capability flag, first-prompt title
  // fallback, knownPaths file-read hints) — clients page real history off disk
  // via the cursor read source (transcriptRead), which is untouched. Sized to
  // match the 2000-item window the already-held reattach re-seed reads
  // (control/session.ts readSlice limit), so the two boot paths stay in step.
  const TAIL_SEED_WINDOW_BYTES = 2 * 1024 * 1024
  const TAIL_SEED_MAX_ITEMS = 2000

  const ensureTranscriptTail = (
    sessionId: string,
    path: string,
    recordToItems: (record: unknown) => TranscriptItem[],
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
          // The per-batch delta publish (encode + ws send + dirty-mark) is
          // synchronous loop work — timed so a chatty transcript shows up in
          // the stall attribution.
          timeTask(`tailBatch(${items.length})`, () => {
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
          })
        },
        {
          recordToItems,
          // The agent's `/color` accent rides the same transcript tail.
          onColor: (color) => send({ type: 'agentColor', sessionId, color }),
          ...(deps.tailSeedGate ? { seedGate: deps.tailSeedGate } : {}),
          initialWindowBytes: TAIL_SEED_WINDOW_BYTES,
          maxInitialItems: TAIL_SEED_MAX_ITEMS,
        },
      ),
    )
  }
  const stopTranscriptTail = (sessionId: string): void => {
    tails.get(sessionId)?.stop()
    tails.delete(sessionId)
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

  // The daemon services an adapter's observation drives, closed over one
  // session. Every per-agent difference is behind these five callbacks.
  const hostFor = (sessionId: string, adapter: HarnessAdapter): HarnessObserverHost => ({
    tailFile: (path) => ensureTranscriptTail(sessionId, path, recordToItemsForKind(adapter.kind)),
    // Recording a resume ref marks the session resumable (→ hibernate button);
    // the first transcript frame marks it chat-capable (→ chat switcher + BTW
    // button). The kind comes off the adapter — never a literal.
    onResumeValue: (value, confidence) => {
      if (adapter.kind === 'codex' && confidence === 'exact' && deps.onExactCodexBinding) {
        void deps
          .onExactCodexBinding(sessionId, value)
          .catch((err) =>
            console.warn(`[podium] codex identity receipt failed for ${sessionId}:`, err),
          )
        return
      }
      send({
        type: 'sessionResumeRef',
        sessionId,
        resume: { kind: adapter.resumeKind, value },
        ...(confidence ? { confidence } : {}),
      })
    },
    onTitle: (title) => send({ type: 'title', sessionId, title }),
    onStateEvents: (events) => applyAgentStateEvents(sessionId, events),
    onTranscriptItems: (items, reset) => {
      if (items.length === 0 && !reset) return
      // Items arrive already cursor-stamped by the observer (opencode:
      // stampOpencodeItems), so the live delta carries the same cursors the
      // on-demand read produces.
      const tail = items.at(-1)?.cursor
      send({
        type: 'transcriptDelta',
        sessionId,
        items,
        ...(reset ? { reset: true } : {}),
        ...(tail ? { tail } : {}),
      })
    },
  })

  const stopObservation = (sessionId: string): void => {
    observations.get(sessionId)?.observation.stop()
    observations.delete(sessionId)
  }
  const startObservation = (
    sessionId: string,
    adapter: HarnessAdapter,
    input: HarnessObserveInput,
  ): void => {
    stopObservation(sessionId)
    observations.set(sessionId, {
      adapter,
      observation: adapter.observer(input, hostFor(sessionId, adapter)),
    })
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

  // (Re)build the per-session observers a fresh daemon must stand up right after
  // wiring the PTY bridge: the agent-state tracker, the adapter's observation
  // (harness state observer and/or resume transcript tail), and a seeded phase.
  // Spawn AND reattach both call this so the two paths can't silently diverge —
  // that drift left idle survivors shown 'working' with an empty chat after a
  // redeploy. 'shell' (and unknown kinds) have no adapter → no observation.
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
    const adapter = harnessAdapterFor(msg.agentKind)
    if (adapter) {
      const pathHint = pathHintOf(msg)
      startObservation(msg.sessionId, adapter, {
        cwd: msg.cwd,
        podiumSessionId: msg.sessionId,
        ...(msg.resume?.value ? { resumeValue: msg.resume.value } : {}),
        ...(deps.homeDir ? { homeDir: deps.homeDir } : {}),
        ...(init.startedAtMs !== undefined ? { startedAtMs: init.startedAtMs } : {}),
        // Reattach carries the session's original spawn time — the codex
        // lazy-rollout discovery floor (see HarnessObserveInput.createdAtMs).
        ...('createdAtMs' in msg && msg.createdAtMs !== undefined
          ? { createdAtMs: msg.createdAtMs }
          : {}),
        // Reattach carries the server's recorded segment path — evidence beats
        // cwd derivation after a worktree move (conversation registry §3.3).
        ...(pathHint ? { pathHint } : {}),
      })
    }
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

  /** Stand up the per-kind transcript observation for a headless session — the
   *  same setup initSessionObservers does on reattach, minus the PTY and state
   *  tracker (headless sessions have no hook channel; observations that emit
   *  state events no-op without a tracker). No discovery floor: the harness
   *  session id is always known here, so observers pin rather than discover. */
  const bindHeadlessSession = (
    sessionId: string,
    agentKind: AgentKind,
    cwd: string,
    resumeValue: string,
  ): void => {
    const adapter = harnessAdapterFor(agentKind)
    if (!adapter) throw new Error(`agent kind ${agentKind} has no headless transcript binding`)
    startObservation(sessionId, adapter, {
      cwd,
      resumeValue,
      ...(deps.homeDir ? { homeDir: deps.homeDir } : {}),
    })
  }

  // The shared hook ingest's onPayload: Claude AND Codex (≥0.142 native hooks)
  // both post here with the same core shape (session_id + transcript_path +
  // hook_event_name). The session's live observation carries its adapter, so
  // the routing is generic: the adapter names the resume kind and the record
  // mapper, and `bindHookThread` (codex) owns the re-pin policy.
  const onHookPayload = (sessionId: string, payload: unknown): void => {
    const tracker = trackers.get(sessionId)
    if (!tracker) return
    // A tracker implies an adapter (the provider comes off the adapter) and the
    // two registries are populated/cleared together, so `bound` is always set
    // when the tracker is; guard anyway rather than assume.
    const bound = observations.get(sessionId)
    if (!bound) return
    // Every hook payload carries transcript_path — the authoritative pointer
    // to the live JSONL (resumes roll into a fresh file; this follows).
    const fields = payload as Record<string, unknown> | null
    const transcriptPath = fields?.transcript_path
    if (typeof transcriptPath === 'string' && transcriptPath) {
      ensureTranscriptTail(sessionId, transcriptPath, recordToItemsForKind(bound.adapter.kind))
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
        resume: { kind: bound.adapter.resumeKind, value: harnessSessionId },
        confidence: 'exact',
        ...(bound.adapter.kind === 'codex' ? { ackRequested: true } : {}),
      })
      // Adapter-owned re-pin policy (codex): the hook names the thread this
      // pane REALLY runs; the observation re-pins only when its binding
      // disagrees. No-op for hook-less-repin harnesses (claude).
      bound.observation.bindHookThread?.(harnessSessionId)
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
    stopObservation(sessionId)
    stopTranscriptTail(sessionId)
  }

  const stopAllTails = (): void => {
    for (const id of [...tails.keys()]) stopTranscriptTail(id)
  }

  /** Stop every observation + tracker (daemon dispose). Tails are stopped
   *  separately by close() — matching the pre-split shutdown order. */
  const disposeObservers = (): void => {
    for (const id of [...observations.keys()]) stopObservation(id)
    trackers.clear()
  }

  return {
    initSessionObservers,
    bindHeadlessSession,
    onHookPayload,
    trackedState,
    clearSession,
    stopAllTails,
    disposeObservers,
    /** The live observation's adapter — how sessionId-scoped services (browser-
     *  open classification) reach harness-specific behavior. */
    adapterFor: (sessionId: string): HarnessAdapter | undefined =>
      observations.get(sessionId)?.adapter,
  }
}
