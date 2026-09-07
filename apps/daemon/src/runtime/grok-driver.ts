/** Daemon frame adapter for Grok's ACP RuntimeDriver. */
import {
  type AgentSessionHandle,
  attachKindsForDriver,
  configureFieldsForDriver,
  createGrokAcpRuntime,
  GROK_ACP_DRIVER_ID,
  type GrokAcpJournal,
  type GrokAcpRuntime,
  type GrokAcpRuntimeHost,
  type PendingInteraction,
  type RuntimeEvent,
} from '@podium/agent-runtime'
import { createLogger } from '@podium/logger'
import type { AgentRuntimeState, SessionId } from '@podium/model'
import { type DaemonMessage, isRuntimeFineEvent } from '@podium/protocol/daemon'
import { type AppliedGeometryRecord, bindFrame } from '../control/applied-geometry'
import { driverTiming } from './driver-timing'
import { grokAcpProcessKey } from './grok-acp-server.js'
import { reportQueueAbandonment } from './queue-abandonment'

const log = createLogger('daemon:grok-driver')

export interface GrokSessionLaunch {
  sessionId: SessionId
  cwd: string
  model?: string
  effort?: string
  env?: Readonly<Record<string, string>>
  initialPrompt?: string
}

export interface DaemonGrokRuntime extends GrokAcpRuntime {
  launch(input: GrokSessionLaunch): Promise<void>
  adoptFromJournal(sessionId: SessionId): Promise<AgentSessionHandle | undefined>
  journal: GrokAcpJournal
}

export function createDaemonGrokRuntime(deps: {
  send(msg: DaemonMessage): void
  /**
   * THIS DAEMON'S APPLIED-SIZE RECORD (POD-3290), read by `bindFrame` below and
   * written by nothing in this file. A server-family session has no terminal at
   * launch, so the record is empty and the bind is bare — which is the point:
   * the `geometry: { cols: 120, rows: 40 }` that stood in this frame described a
   * client nobody had opened, and the server took it for a report.
   *
   * Optional because a host can be built without a daemon behind it; absent
   * reads as "applied nothing", which is the same bare bind.
   */
  appliedGeometry?: AppliedGeometryRecord

  host: GrokAcpRuntimeHost
}): DaemonGrokRuntime {
  const runtime = createGrokAcpRuntime({
    ...deps.host,
    // A queue this driver loses becomes a durable server-side receipt
    // correction, so the port is wired HERE, next to `send` (POD-2297).
    onQueueAbandoned: reportQueueAbandonment('grok', deps.send),
  })

  function translate(sessionId: SessionId, event: RuntimeEvent): void {
    const timingHandle = runtime.handleFor(sessionId)
    if (timingHandle) driverTiming.runtimeEvent(timingHandle.binding, event)
    if (isRuntimeFineEvent(event)) {
      deps.send({ type: 'runtimeFineEvent', sessionId, event })
    } else {
      deps.send({ type: 'runtimeEvent', sessionId, event })
    }
    switch (event.t) {
      case 'item':
        if (event.item.kind === 'complete') {
          deps.send({ type: 'transcriptDelta', sessionId, items: [event.item.item] })
        }
        return
      case 'state':
        void runtime
          .handleFor(sessionId)
          ?.state()
          .then((state: AgentRuntimeState) => {
            deps.send({ type: 'agentState', sessionId, state })
          })
          .catch(() => undefined)
        return
      case 'interaction': {
        if (event.ev.ev !== 'asked') return
        const interaction: PendingInteraction = event.ev.interaction
        deps.send({ type: 'runtimeInteractionAsked', sessionId, interaction })
        return
      }
      case 'process':
        if (event.ev.ev !== 'exited') return
        // Preserve the runtime envelope's process generation. A resumed Grok
        // child reuses the Podium session id, so the server needs this fence to
        // reject a duplicated exit from the handle that recovery replaced.
        deps.send({
          type: 'agentExit',
          sessionId,
          code: event.ev.code ?? 0,
          observerGeneration: event.observerGeneration,
        })
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
        for await (const event of handle.events('bootstrap')) translate(sessionId, event)
      } catch (err) {
        log.warn('Grok runtime event stream ended', { err, sessionId })
      }
    })()
  }

  function reportResumeRef(sessionId: SessionId, handle: AgentSessionHandle): void {
    if (!handle.binding.resume) return
    deps.send({
      type: 'sessionResumeRef',
      sessionId,
      resume: handle.binding.resume,
      confidence: 'exact',
    })
  }

  return {
    ...runtime,
    // STRAIGHT FROM THE RUNTIME'S HANDLE MAP, never a parallel Set (POD-2249;
    // the same repair `opencode-driver.ts` documents at its own `has`): the Set
    // this replaced survived the lifecycle verbs, so a parked session's bind
    // fact kept routing verbs onto a contract path answering `not_running`.
    has: (sessionId) => runtime.has(sessionId),
    journal: deps.host.journal,

    async adoptFromJournal(sessionId) {
      const entry = deps.host.journal.read(sessionId)
      if (!entry) return undefined
      const processKey = grokAcpProcessKey(sessionId)
      // The journal is evidence, not authority for identity. Its path is keyed
      // by the requested Podium session, while its payload can be stale or
      // replaced; derive the expected key independently and refuse a payload
      // for any other logical incarnation before launching a new child.
      if (entry.sessionId !== sessionId || entry.process.key !== processKey) return undefined
      try {
        const handle = await runtime.driver.adopt({
          sessionId,
          driver: GROK_ACP_DRIVER_ID,
          family: 'server',
          harness: 'grok',
          workdir: entry.workdir,
          resume: { kind: 'grok-session', value: entry.grokSessionId },
          process: { key: processKey },
          bindingVersion: entry.bindingVersion,
        })
        pump(sessionId)
        reportResumeRef(sessionId, handle)
        return handle
      } catch {
        return undefined
      }
    },

    async launch(input) {
      const handle = await runtime.createWithId(input.sessionId, {
        harness: 'grok',
        selection: {
          auth: 'subscription',
          platform: process.platform,
          available: [GROK_ACP_DRIVER_ID],
          preference: GROK_ACP_DRIVER_ID,
        },
        workdir: input.cwd,
        model: {
          ...(input.model && input.model !== 'auto' ? { model: input.model } : {}),
          ...(input.effort && input.effort !== 'auto' ? { effort: input.effort } : {}),
        },
        // ACP's session/new surface has no instruction or MCP declaration in
        // the probed Grok build. User config remains authoritative.
        instructions: {
          supported: false,
          reason: 'Grok ACP exposes no session-scoped instruction field',
        },
        mcpServers: {
          supported: false,
          reason: 'Grok ACP session/new accepts an empty mcpServers list only',
        },
        ...(input.env ? { env: input.env } : {}),
        ...(input.initialPrompt ? { initialPrompt: input.initialPrompt } : {}),
      })
      pump(input.sessionId)
      reportResumeRef(input.sessionId, handle)
      driverTiming.sessionReady(handle.binding)
      // NO GEOMETRY (POD-3290). A stdio ACP engine has no terminal of any kind,
      // so the `{ cols: 120, rows: 40 }` that stood here was a size nothing in
      // the system had ever applied. The one bind builder reads this daemon's
      // applied-size record, which for this launch is empty.
      deps.send(
        bindFrame(deps.appliedGeometry, {
          sessionId: input.sessionId,
          cmd: `grok agent stdio (${handle.binding.driver})`,
          cwd: input.cwd,
          agentKind: 'grok',
          runtimeContract: true,
          driverId: handle.binding.driver,
          // POD-3087: what this driver's configure() can change. Grok's answer is
          // `permissionMode` alone — it never sends a model — and reporting that
          // precisely is the case this field exists for.
          configureFields: [...configureFieldsForDriver(handle.binding.driver)],
          attachKinds: [...attachKindsForDriver(handle.binding.driver)],
        }),
      )
      deps.send({
        type: 'agentState',
        sessionId: input.sessionId,
        state: await handle.state(),
      })
    },
  }
}
