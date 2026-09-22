import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import type { AgentSessionHandle } from '../../driver.js'
import type { RuntimeEvent } from '../../events.js'
import type { PendingInteraction } from '../../interactions.js'
import { attachKindsForDriver, configureFieldsForDriver } from '../../configure-catalog.js'
import {
  type ClaudeSdkRuntime,
  type ClaudeSdkRuntimeHost,
  createClaudeSdkRuntime,
} from './runtime.js'
import type { ClaudeEngineHost } from './engine-host.js'
import { claudeEngineProcessKey, type ClaudeEngineFacts } from './engine-facts.js'
import { reportQueueAbandonment } from '../queue-report.js'
import type {
  ServerFamilyJournalEntry,
  ServerFamilyRuntime,
  ServerSessionFramePorts,
} from '../server-family.js'
import type { SessionDriverSlots } from '../session-slots.js'
import { createLogger } from '@podium/logger'
import type { AgentRuntimeState, ResumeRef, SessionId } from '@podium/model'
import {
  type DaemonMessage,
  isRuntimeFineEvent,
  type RuntimeHistoryPage,
  type RuntimeHistoryRange,
} from '@podium/protocol/daemon'

const log = createLogger('harness:claude-sdk-session')

/**
 * THE FAMILY'S KEY. The harness this session adapter serves — the one value
 * the adapter selects on. Centralized here (never restated per call site) so
 * the supervisor's wiring can read it as a value rather than naming it.
 */
export const claudeSdkHarnessKind = 'claude-code' as const
const publishedClaudeBindings = new WeakSet<AgentSessionHandle>()

export interface ClaudeSdkSessionLaunch {
  sessionId: SessionId
  cwd: string
  model?: string
  effort?: string
  env?: Readonly<Record<string, string>>
  initialPrompt?: string
  resume?: ResumeRef
}

export async function emitClaudeBinding(
  ports: Pick<ServerSessionFramePorts, 'send' | 'emitBind'>,
  input: {
    sessionId: SessionId
    cwd: string
    agentKind: typeof claudeSdkHarnessKind
  },
  handle: AgentSessionHandle,
): Promise<void> {
  publishedClaudeBindings.add(handle)
  ports.emitBind({
    sessionId: input.sessionId,
    cmd: 'Claude stream engine',
    cwd: input.cwd,
    agentKind: input.agentKind,
    driverId: handle.binding.driver,
    // POD-3087: what this driver's configure() can change, read off its own
    // declaration so no consumer has to keep a second copy of it.
    configureFields: [...configureFieldsForDriver(handle.binding.driver)],
    attachKinds: [...attachKindsForDriver(handle.binding.driver)],
  })
  ports.send({ type: 'agentState', sessionId: input.sessionId, state: await handle.state() })
  if (handle.binding.resume) {
    ports.send({
      type: 'sessionResumeRef',
      sessionId: input.sessionId,
      resume: handle.binding.resume,
      confidence: 'exact',
    })
  }
}

/** Publish a newly resumed handle only when its adapter did not already do so. */
export async function ensureClaudeBindingPublished(
  ports: Parameters<typeof emitClaudeBinding>[0],
  input: Parameters<typeof emitClaudeBinding>[1],
  handle: AgentSessionHandle,
): Promise<void> {
  if (publishedClaudeBindings.has(handle)) return
  await emitClaudeBinding(ports, input, handle)
}

/**
 * A SERVER FAMILY LIKE THE OTHERS (POD-4612). The supervisor composes this in
 * its server list beside codex, opencode and grok: one engine child under
 * podium-host per session, journalled, adopted and reaped through the same
 * generic arms. What it adds is {@link ServerFamilyRuntime.launchResumed} —
 * the Claude conversation outlives any engine, so a resume ref alone is enough
 * to continue it.
 */
export interface DaemonClaudeSdkRuntime extends ClaudeSdkRuntime, ServerFamilyRuntime {
  launch(input: ClaudeSdkSessionLaunch): Promise<AgentSessionHandle>
  launchResumed(
    input: Omit<ClaudeSdkSessionLaunch, 'resume'>,
    resume: ResumeRef,
  ): Promise<AgentSessionHandle>
  /** Every session this runtime currently holds. */
  has(sessionId: SessionId): boolean
  /**
   * THE BINDING JOURNAL, so the reattach path can ask whether a session was
   * ours before it tries to adopt it. The ENTRY'S EXISTENCE is the statement
   * that this session was engine-driven.
   */
  journal: ClaudeEngineHost['journal']
  /**
   * Re-bind a session, from the journal alone after a daemon restart. The
   * engine re-attach itself stays lazy (first turn adopts the survivor, or
   * spawns fresh with `--resume` when nothing survived), so adopt never fails
   * for a missing engine — only for a missing journal. A session this daemon
   * still holds re-adopts its own core instead: never a second one.
   */
  adoptFromJournal(sessionId: SessionId): Promise<AgentSessionHandle | undefined>
  /** Uniform server-family shape: the supervisor composes families without
   *  naming them. Satisfied by the members below (describe/journalEntry/
   *  clearJournal) plus the spread runtime above. */
  readonly describe: string
  journalEntry(sessionId: SessionId): ServerFamilyJournalEntry | undefined
  clearJournal(sessionId: SessionId): void
  reportOomKill(sessionId: SessionId, scopeUnit?: string): void
}

/**
 * What a Claude SDK session adapter needs from whoever supervises it.
 *
 * The engine (stream-json protocol over the supervisor-held child) arrives
 * as `engine`; the frame stream, bind emission, timing and mail continuation
 * arrive as narrow ports; harness-shaped values arrive through `facts`. The
 * supervisor owns processes, disks and the wire — this adapter owns the
 * translation between the contract and the frames.
 */
export interface ClaudeSdkSessionDeps extends ServerSessionFramePorts {
  /** The supervisor's per-session driver slots (POD-4610): the family binds
   *  each session's handle into its entry and keeps no handle index of its own. */
  driverSlots: SessionDriverSlots
  facts: ClaudeEngineFacts
  engine: ClaudeEngineHost
  transcript: {
    readHistory(
      session: {
        sessionId: SessionId
        agentKind: typeof claudeSdkHarnessKind
        cwd: string
        resume?: ResumeRef
      },
      range: Omit<RuntimeHistoryRange, 'direction'> & {
        direction?: RuntimeHistoryRange['direction']
      },
    ): Promise<RuntimeHistoryPage>
    archiveTranscript(input: {
      agentKind: typeof claudeSdkHarnessKind
      cwd: string
      resumeValue: string
    }): Promise<{ path: string; relativeDir?: string }>
    readFileBytes(path: string): Promise<Uint8Array>
  }
}

export function createClaudeSdkSessionRuntime(
  deps: ClaudeSdkSessionDeps,
): DaemonClaudeSdkRuntime {
  let runtime!: DaemonClaudeSdkRuntime
  const host: ClaudeSdkRuntimeHost = {
    mintSessionId: () => randomUUID() as SessionId,
    mintResumeValue: randomUUID,
    now: () => new Date().toISOString(),
    startTurn: (input) => deps.engine.startTurn(input),
    readTranscript: ({ sessionId, workdir, resumeValue, range }) =>
      deps.transcript.readHistory(
        {
          sessionId,
          agentKind: claudeSdkHarnessKind,
          cwd: workdir,
          resume: { kind: 'claude-session', value: resumeValue },
        },
        range,
      ),
    async readArchive({ workdir, resumeValue }) {
      try {
        const located = await deps.transcript.archiveTranscript({
          agentKind: claudeSdkHarnessKind,
          cwd: workdir,
          resumeValue,
        })
        return {
          path: basename(located.path),
          bytes: await deps.transcript.readFileBytes(located.path),
        }
      } catch {
        return undefined
      }
    },
    reportObservedConfiguration: ({ sessionId, model, effort }) =>
      deps.send({
        type: 'agentModel',
        sessionId,
        model,
        ...(effort ? { effort } : {}),
      }),
    onQueueAbandoned: reportQueueAbandonment('claude-sdk', deps.send),
    stopEngine: (sessionId, retire) => deps.engine.stopEngine(sessionId, retire),
    releaseEngines: () => deps.engine.releaseEngines(),
  }

  const contractRuntime = createClaudeSdkRuntime(host, deps.driverSlots)

  function sendState(sessionId: SessionId): void {
    void runtime
      .handleFor(sessionId)
      ?.state()
      .then((state: AgentRuntimeState) => deps.send({ type: 'agentState', sessionId, state }))
      .catch(() => {})
  }

  function translate(sessionId: SessionId, event: RuntimeEvent): void {
    const timingHandle = runtime.handleFor(sessionId)
    if (timingHandle) deps.traceRuntimeEvent(timingHandle.binding, event)
    deps.send(
      isRuntimeFineEvent(event)
        ? { type: 'runtimeFineEvent', sessionId, event }
        : { type: 'runtimeEvent', sessionId, event },
    )
    switch (event.t) {
      case 'item':
        if (event.item.kind === 'complete') {
          deps.send({ type: 'transcriptDelta', sessionId, items: [event.item.item] })
        }
        return
      case 'state':
        sendState(sessionId)
        return
      case 'turn':
        if (event.provenance === 'live' && event.ev.ev === 'started') sendState(sessionId)
        return
      case 'interaction':
        if (event.ev.ev === 'asked') {
          const interaction: PendingInteraction = event.ev.interaction
          deps.send({ type: 'runtimeInteractionAsked', sessionId, interaction })
        }
        return
      case 'process':
        if (event.ev.ev === 'exited') {
          deps.send({ type: 'agentExit', sessionId, code: event.ev.code ?? 0 })
        }
        return
      default:
        return
    }
  }

  function pump(sessionId: SessionId): void {
    const handle = runtime.handleFor(sessionId)
    if (!handle) return
    void (async () => {
      try {
        const boundary = deps.startMailContinuation(
          handle,
          () => runtime.handleFor(sessionId) === handle,
        )
        for await (const event of handle.events('bootstrap')) {
          translate(sessionId, event)
          boundary(event)
        }
      } catch (error) {
        log.warn('Claude SDK runtime event stream ended', { error, sessionId })
      }
    })()
  }

  /** Tell the server the harness-native id this session resumes from, so a
   *  handoff or a later resume does not have to re-derive it. */
  function reportResumeRef(sessionId: SessionId, handle: AgentSessionHandle): void {
    const resume = handle.binding.resume
    if (!resume) return
    deps.send({ type: 'sessionResumeRef', sessionId, resume, confidence: 'exact' })
  }

  function launchSpec(input: {
    cwd: string
    model?: string
    effort?: string
    env?: Readonly<Record<string, string>>
    initialPrompt?: string
  }): Parameters<ClaudeSdkRuntime['createWithId']>[1] {
    return {
      harness: claudeSdkHarnessKind,
      selection: {
        auth: 'unknown',
        platform: process.platform,
        available: ['claude-sdk'],
        preference: 'claude-sdk',
      },
      workdir: input.cwd,
      model: {
        ...(input.model && input.model !== 'auto' ? { model: input.model } : {}),
        ...(input.effort && input.effort !== 'auto' ? { effort: input.effort } : {}),
      },
      instructions: { supported: false, reason: 'spawn supplied no hidden instruction channel' },
      mcpServers: { supported: false, reason: 'spawn supplied no inline MCP configuration' },
      ...(input.env ? { env: input.env } : {}),
      ...(input.initialPrompt ? { initialPrompt: input.initialPrompt } : {}),
    }
  }

  runtime = {
    ...contractRuntime,
    describe: `${deps.facts.command} --input-format stream-json (streaming engine)`,
    journal: deps.engine.journal,
    journalEntry(sessionId) {
      const entry = deps.engine.journal.read(sessionId)
      if (entry) {
        return {
          workdir: entry.workdir,
          process: entry.process,
          bindingVersion: entry.bindingVersion,
          resume: { kind: 'claude-session', value: entry.claudeSessionId },
        }
      }
      /**
       * HELD BUT NOT YET JOURNALLED. The engine starts lazily and the journal
       * is written once the CLI names its session, so a live session that has
       * not run a turn has no entry — and every generic arm asks this method
       * whether the session is ours. Answering from the live binding keeps a
       * zero-turn session reattachable on a server reconnect, which the
       * bespoke arm this replaced did from its handle (POD-4612).
       */
      const live = contractRuntime.handleFor(sessionId)
      if (!live) return undefined
      return {
        workdir: live.binding.workdir,
        process: live.binding.process,
        bindingVersion: live.binding.bindingVersion,
        ...(live.binding.resume ? { resume: live.binding.resume } : {}),
      }
    },
    clearJournal(sessionId) {
      deps.engine.journal.clear(sessionId)
    },
    reportOomKill(sessionId, scopeUnit) {
      contractRuntime.processEvent(sessionId, { ev: 'oomKilled', ...(scopeUnit ? { scopeUnit } : {}) })
    },

    /**
     * STRAIGHT FROM THE RUNTIME'S HANDLE MAP, never a parallel Set (POD-2249):
     * the Set this pattern replaced survived the lifecycle verbs, so a parked
     * session's bind fact kept routing verbs onto a contract path answering
     * `not_running`.
     */
    has: (sessionId) => contractRuntime.handleFor(sessionId) !== undefined,

    async adoptFromJournal(sessionId) {
      // SAME-DAEMON FIRST. A reconnect re-sends reattach for sessions this
      // daemon still holds; the exact identity is the live core, so adoption
      // bumps its binding rather than resuming a second core beside it.
      const live = contractRuntime.handleFor(sessionId)
      if (live) {
        const handle = await contractRuntime.adopt(live.binding)
        reportResumeRef(sessionId, handle)
        return handle
      }
      const entry = deps.engine.journal.read(sessionId)
      // No entry is "not mine" — every terminal session reaches reattach paths
      // too, and answering anything else would hijack a PTY session's
      // reattach. The process key is derived independently (never trusted
      // from the journal) before a fresh channel may serve the native
      // session it names.
      if (!entry) return undefined
      if (entry.sessionId !== sessionId) return undefined
      if (entry.process.key !== claudeEngineProcessKey(deps.facts, sessionId)) return undefined
      // The engine re-attach stays LAZY: resume the contract core now (the
      // journal carries the facts the next turn's spawn needs), and the first
      // turn adopts the surviving engine — or spawns fresh with `--resume`
      // when nothing survived. Adopt therefore never fails for a missing
      // engine, only for a missing journal.
      const handle = await contractRuntime.resumeWithId(
        sessionId,
        { kind: 'claude-session', value: entry.claudeSessionId },
        {
          ...launchSpec({
            cwd: entry.workdir,
            ...(entry.model ? { model: entry.model } : {}),
            ...(entry.effort ? { effort: entry.effort } : {}),
            ...(entry.env ? { env: entry.env } : {}),
          }),
          // The journal carries what the next turn's engine spawn reads: the
          // instruction text (one entry, attributed to the adopt) and the raw
          // MCP config. Absent = the launch-time unsupported, honestly so.
          instructions: entry.instructions
            ? {
                supported: true,
                value: {
                  instructions: [{ source: 'journal-adopt', content: entry.instructions }],
                  reprimeOnCompaction: false,
                },
              }
            : { supported: false, reason: 'adopt carries no instruction channel' },
          mcpServers: entry.mcpConfig
            ? { supported: true, value: { transport: 'inline', config: entry.mcpConfig } }
            : { supported: false, reason: 'adopt carries no inline MCP configuration' },
        },
      )
      pump(sessionId)
      reportResumeRef(sessionId, handle)
      return handle
    },

    async launchResumed(input, resume) {
      return runtime.launch({ ...input, resume })
    },

    async launch(input) {
      const handle = input.resume
        ? await contractRuntime.resumeWithId(input.sessionId, input.resume, launchSpec(input))
        : await contractRuntime.createWithId(input.sessionId, launchSpec(input))
      pump(input.sessionId)
      deps.sessionReady(handle.binding)
      // THE BIND IS BARE (POD-3290). A stream engine has no terminal of any
      // kind, so nothing here reports a size — instead of the `120x40` that
      // used to go out as a report, the server keeps W unknown until a
      // viewer asks.
      await emitClaudeBinding(
        deps,
        {
          sessionId: input.sessionId,
          cwd: input.cwd,
          agentKind: claudeSdkHarnessKind,
        },
        handle,
      )
      return handle
    },
  }
  return runtime
}
