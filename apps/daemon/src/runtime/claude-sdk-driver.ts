import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import {
  type AgentSessionHandle,
  createClaudeSdkRuntime,
  type ClaudeSdkRuntime,
  type ClaudeSdkRuntimeHost,
  type PendingInteraction,
  type RuntimeEvent,
} from '@podium/agent-runtime'
import { createLogger } from '@podium/logger'
import type { AccountId, AgentRuntimeState, SessionId } from '@podium/model'
import { type DaemonMessage, isRuntimeFineEvent } from '@podium/protocol/daemon'
import { runClaudeSdkChildTurn } from '../claude-sdk-client'
import type { HeadlessTurnSpec } from '../headless-drivers'
import type { TerminalRuntimeHost } from './terminal-driver'

const log = createLogger('daemon:claude-sdk-runtime')
const ZERO_DIGEST = '0'.repeat(64)

export interface ClaudeSdkSessionLaunch {
  sessionId: SessionId
  cwd: string
  model?: string
  effort?: string
  env?: Readonly<Record<string, string>>
  initialPrompt?: string
}

export interface DaemonClaudeSdkRuntime extends ClaudeSdkRuntime {
  launch(input: ClaudeSdkSessionLaunch): Promise<void>
}

export function createDaemonClaudeSdkRuntime(deps: {
  send(msg: DaemonMessage): void
  host: TerminalRuntimeHost
}): DaemonClaudeSdkRuntime {
  let runtime!: DaemonClaudeSdkRuntime
  const host: ClaudeSdkRuntimeHost = {
    mintSessionId: () => randomUUID() as SessionId,
    mintResumeValue: randomUUID,
    now: () => new Date().toISOString(),
    startTurn(input) {
      const instructions = input.spec.instructions.supported
        ? input.spec.instructions.value.instructions.map((entry) => entry.content).join('\n\n')
        : undefined
      const mcpConfig =
        input.spec.mcpServers.supported && input.spec.mcpServers.value.transport === 'inline'
          ? input.spec.mcpServers.value.config
          : undefined
      const model =
        input.turn.overrides?.supported && input.turn.overrides.value.model
          ? input.turn.overrides.value.model
          : input.spec.model.model
      const effort =
        input.turn.overrides?.supported && input.turn.overrides.value.effort
          ? input.turn.overrides.value.effort
          : input.spec.model.effort
      const spec: HeadlessTurnSpec = {
        agent: 'claude-code',
        accountId: (input.spec.principal ?? 'operator-owned') as AccountId,
        requestDigest: ZERO_DIGEST,
        cwd: input.spec.workdir,
        prompt: input.turn.text,
        ...(input.newConversation
          ? { sessionUuid: input.resumeValue }
          : { resumeValue: input.resumeValue }),
        structuredPermissions: true,
        ...(model && model !== 'auto' ? { model } : {}),
        ...(effort && effort !== 'auto' ? { effort } : {}),
        ...(instructions ? { systemPrompt: instructions } : {}),
        ...(mcpConfig ? { mcpConfig } : {}),
        ...(input.spec.env ? { env: { ...input.spec.env } } : {}),
      }
      const child = runClaudeSdkChildTurn(
        spec,
        (event) => {
          if (event.kind === 'partial-text') {
            input.onPartialText(event.text, event.itemHint)
          }
        },
        { onPermission: input.onPermission },
      )
      return {
        done: child.done.then((outcome) => ({
          resumeValue: outcome.harnessSessionId,
          output: outcome.output,
        })),
        interrupt: child.interrupt,
        answerPermission(interactionId, answer) {
          if (!child.answerPermission) throw new Error('SDK child has no permission answer channel')
          child.answerPermission(interactionId, answer)
        },
        dispose: child.dispose,
      }
    },
    readTranscript: ({ sessionId, workdir, resumeValue, limit }) =>
      deps.host.readTranscript(
        {
          sessionId,
          agentKind: 'claude-code',
          cwd: workdir,
          resume: { kind: 'claude-session', value: resumeValue },
        },
        { limit },
      ),
    async readArchive({ workdir, resumeValue }) {
      try {
        const located = await deps.host.archiveTranscript({
          agentKind: 'claude-code',
          cwd: workdir,
          resumeValue,
        })
        return { path: basename(located.path), bytes: await deps.host.readFileBytes(located.path) }
      } catch {
        return undefined
      }
    },
  }

  const contractRuntime = createClaudeSdkRuntime(host)

  function sendState(sessionId: SessionId): void {
    void runtime
      .handleFor(sessionId)
      ?.state()
      .then((state: AgentRuntimeState) => deps.send({ type: 'agentState', sessionId, state }))
      .catch(() => {})
  }

  function translate(sessionId: SessionId, event: RuntimeEvent): void {
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
        for await (const event of handle.events('bootstrap')) translate(sessionId, event)
      } catch (error) {
        log.warn('Claude SDK runtime event stream ended', { error, sessionId })
      }
    })()
  }

  function reportResumeRef(sessionId: SessionId, handle: AgentSessionHandle): void {
    if (handle.binding.resume) {
      deps.send({
        type: 'sessionResumeRef',
        sessionId,
        resume: handle.binding.resume,
        confidence: 'exact',
      })
    }
  }

  runtime = {
    ...contractRuntime,
    async launch(input) {
      const handle = await contractRuntime.createWithId(input.sessionId, {
        harness: 'claude-code',
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
      })
      pump(input.sessionId)
      deps.send({
        type: 'bind',
        sessionId: input.sessionId,
        cmd: 'Claude Agent SDK (embedded)',
        cwd: input.cwd,
        agentKind: 'claude-code',
        geometry: { cols: 120, rows: 40 },
        runtimeContract: true,
        driverId: handle.binding.driver,
      })
      deps.send({ type: 'agentState', sessionId: input.sessionId, state: await handle.state() })
      reportResumeRef(input.sessionId, handle)
    },
  }
  return runtime
}
