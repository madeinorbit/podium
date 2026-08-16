/** Daemon frame adapter for Grok's ACP RuntimeDriver. */
import {
  type AgentSessionHandle,
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
import type { DaemonMessage } from '@podium/protocol'
import { grokAcpProcessKey } from './grok-acp-server.js'

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
  host: GrokAcpRuntimeHost
}): DaemonGrokRuntime {
  const runtime = createGrokAcpRuntime(deps.host)
  const live = new Set<SessionId>()

  function translate(sessionId: SessionId, event: RuntimeEvent): void {
    deps.send({ type: 'runtimeEvent', sessionId, event })
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
        live.delete(sessionId)
        deps.send({ type: 'agentExit', sessionId, code: event.ev.code ?? 0 })
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
    has: (sessionId) => live.has(sessionId),
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
        live.add(sessionId)
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
      live.add(input.sessionId)
      pump(input.sessionId)
      reportResumeRef(input.sessionId, handle)
      deps.send({
        type: 'bind',
        sessionId: input.sessionId,
        cmd: `grok agent stdio (${handle.binding.driver})`,
        cwd: input.cwd,
        agentKind: 'grok',
        geometry: { cols: 120, rows: 40 },
        runtimeContract: true,
      })
      deps.send({
        type: 'agentState',
        sessionId: input.sessionId,
        state: await handle.state(),
      })
    },
  }
}
