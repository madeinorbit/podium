import { randomUUID } from 'node:crypto'
import { basename, join } from 'node:path'
import {
  type AgentSessionHandle,
  type ClaudeSdkRuntime,
  type ClaudeSdkRuntimeHost,
  createClaudeSdkRuntime,
  type PendingInteraction,
  type RuntimeEvent,
} from '@podium/agent-runtime'
import { createLogger } from '@podium/logger'
import type { AccountId, AgentRuntimeState, Geometry, ResumeRef, SessionId } from '@podium/model'
import { type DaemonMessage, isRuntimeFineEvent } from '@podium/protocol/daemon'
import { runClaudeSdkChildTurn } from '../claude-sdk-client'
import type { HeadlessTurnSpec } from '../headless-drivers'
import { reportQueueAbandonment } from './queue-abandonment'
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
  resume?: ResumeRef
}

export async function emitClaudeBinding(
  send: (message: DaemonMessage) => void,
  input: {
    sessionId: SessionId
    cwd: string
    agentKind: 'claude-code'
    geometry: Geometry
  },
  handle: AgentSessionHandle,
): Promise<void> {
  send({
    type: 'bind',
    sessionId: input.sessionId,
    cmd: 'Claude Agent SDK (embedded)',
    cwd: input.cwd,
    agentKind: input.agentKind,
    geometry: input.geometry,
    runtimeContract: true,
    driverId: handle.binding.driver,
  })
  send({ type: 'agentState', sessionId: input.sessionId, state: await handle.state() })
  if (handle.binding.resume) {
    send({
      type: 'sessionResumeRef',
      sessionId: input.sessionId,
      resume: handle.binding.resume,
      confidence: 'exact',
    })
  }
}

export interface DaemonClaudeSdkRuntime extends ClaudeSdkRuntime {
  launch(input: ClaudeSdkSessionLaunch): Promise<AgentSessionHandle>
}

/**
 * THE HOME THE SDK CHILD MUST RUN IN, and why it is a parameter at all.
 *
 * `readTranscript` below resolves this session's JSONL under the daemon's
 * `ctx.homeDir` — the named instance's agent home. The child writes that file
 * under its own `HOME`, and nothing in the spawn frame's `env` (server-resolved
 * managed credentials) names one, so the child kept the DAEMON's `HOME`: the
 * operator account home. Reader and writer then addressed two different files
 * and every `sessions.read` answered `items: []` for a conversation that had
 * really happened — prompt and answer included, not one item type (POD-3057).
 *
 * The same split, reached by a different road, is POD-3059 on the durable
 * headless path; the instance home is authoritative there for the reasons that
 * issue records, and this path is the one it did not travel. `claude-code`
 * declares no `instanceHome` state selector, so for this harness `HOME` alone
 * decides where the record lands — which is also why aligning it closes the
 * credential-isolation leak POD-2247 names: a child left on the daemon's `HOME`
 * reads and writes the operator's real auth files from inside an instance that
 * is supposed to be isolated.
 *
 * Absent on the DEFAULT instance, where the daemon has no agent home of its own
 * and reader and child already agree on the ambient one.
 */
export function createDaemonClaudeSdkRuntime(deps: {
  send(msg: DaemonMessage): void
  host: TerminalRuntimeHost
  /** `ctx.homeDir` — the named instance's agent home, when there is one. */
  homeDir?: string
}): DaemonClaudeSdkRuntime {
  /**
   * The instance-owned overlay, layered LAST so it outranks the spawn frame's
   * env. `CLAUDE_CONFIG_DIR` rides along because the CLI honours it over `HOME`
   * for its config root while the reader knows only `HOME`: pinning it to this
   * home's own `.claude` keeps a value inherited from the daemon's environment
   * from re-opening the split the `HOME` line just closed.
   */
  const instanceEnv = deps.homeDir
    ? { HOME: deps.homeDir, CLAUDE_CONFIG_DIR: join(deps.homeDir, '.claude') }
    : undefined
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
        ...(input.spec.env || instanceEnv ? { env: { ...input.spec.env, ...instanceEnv } } : {}),
      }
      const child = runClaudeSdkChildTurn(
        spec,
        (event) => {
          if (event.kind === 'partial-text') {
            input.onPartialText(event.text, event.itemHint)
          }
        },
        {
          onPermission: input.onPermission,
          onToolCall: input.onToolCall,
          onToolResult: input.onToolResult,
        },
      )
      return {
        done: child.done.then((outcome) => ({
          resumeValue: outcome.harnessSessionId,
          output: outcome.output,
        })),
        interrupt: child.interrupt,
        // The acknowledged form, kept separate from `interrupt` above so
        // teardown keeps its fire-and-forget poke and the operator's stop gets
        // the provider's actual answer.
        requestInterrupt: child.requestInterrupt,
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
    onQueueAbandoned: reportQueueAbandonment('claude-sdk', deps.send),
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

  runtime = {
    ...contractRuntime,
    async launch(input) {
      const spec = {
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
      } satisfies Parameters<ClaudeSdkRuntime['createWithId']>[1]
      const handle = input.resume
        ? await contractRuntime.resumeWithId(input.sessionId, input.resume, spec)
        : await contractRuntime.createWithId(input.sessionId, spec)
      pump(input.sessionId)
      await emitClaudeBinding(
        deps.send,
        {
          sessionId: input.sessionId,
          cwd: input.cwd,
          agentKind: 'claude-code',
          geometry: { cols: 120, rows: 40 },
        },
        handle,
      )
      return handle
    },
  }
  return runtime
}
