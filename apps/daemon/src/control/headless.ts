import { resolveCursorBin, resolveOpencodeBin } from '@podium/harness'
import type { ControlMessage, HeadlessTurnEvent } from '@podium/protocol'
import { acknowledgeDurableHeadlessTurn, runDurableHeadlessTurn } from '../durable-headless.js'
import {
  HeadlessTurnError,
  type HeadlessTurnHandle,
  type HeadlessTurnSpec,
  runHeadlessTurn,
} from '../headless-drivers.js'
import type { ControlHandlers, DaemonContext } from './context'
import { sessionRelayEnv } from './session'

// ---- Headless harness sessions (concierge unification, Phase A) ----
function recordHeadlessAllocation(
  ctx: DaemonContext,
  input: {
    sessionId: Extract<ControlMessage, { type: 'headlessTurnRequest' }>['sessionId']
    transitionId: string
    attemptId: string
    nativeKind: string
    value: string
  },
): void {
  void ctx.sessionBinding
    .transition({
      event: 'headless-allocation',
      observedAt: new Date().toISOString(),
      ...input,
    })
    .catch((error) =>
      console.warn(`[podium] headless allocation transition failed for ${input.sessionId}:`, error),
    )
}

// One live turn per session (ctx.runningHeadlessTurns); concurrent sends on a
// thread are rejected so two writers can never race the same harness session.

function runHeadlessTurnRequest(
  ctx: DaemonContext,
  msg: Extract<ControlMessage, { type: 'headlessTurnRequest' }>,
): void {
  const existing = ctx.runningHeadlessTurns.get(msg.sessionId)
  if (existing?.turnId === msg.turnId) {
    wireTurnResult(ctx, msg, existing)
    return
  }
  if (existing) {
    ctx.send({
      type: 'headlessTurnResult',
      requestId: msg.requestId,
      ok: false,
      error: 'turn already running',
    })
    return
  }
  let handle: HeadlessTurnHandle
  let firstTurnBound = false
  const bindFirstTurn = (harnessSessionId: string): void => {
    if (msg.resumeValue || firstTurnBound) return
    firstTurnBound = true
    recordHeadlessAllocation(ctx, {
      sessionId: msg.sessionId,
      transitionId: `headless:${msg.turnId}:${harnessSessionId}`,
      attemptId: msg.turnId,
      nativeKind: msg.agent,
      value: harnessSessionId,
    })
    try {
      ctx.observers.bindHeadlessSession(msg.sessionId, msg.agent, msg.cwd, harnessSessionId)
    } catch {
      // The terminal result retries the binding after completion.
      firstTurnBound = false
    }
  }
  try {
    const spec: HeadlessTurnSpec = {
      agent: msg.agent,
      cwd: msg.cwd,
      prompt: msg.prompt,
      ...(msg.contextPrompt ? { contextPrompt: msg.contextPrompt } : {}),
      ...(msg.model ? { model: msg.model } : {}),
      ...(msg.effort ? { effort: msg.effort } : {}),
      ...(msg.systemPrompt ? { systemPrompt: msg.systemPrompt } : {}),
      ...(msg.mcpConfig ? { mcpConfig: msg.mcpConfig } : {}),
      ...(msg.allowedTools ? { allowedTools: msg.allowedTools } : {}),
      ...(msg.permissionMode ? { permissionMode: msg.permissionMode } : {}),
      ...(msg.resumeValue ? { resumeValue: msg.resumeValue } : {}),
      ...(msg.sessionUuid ? { sessionUuid: msg.sessionUuid } : {}),
      ...(msg.timeoutMs ? { timeoutMs: msg.timeoutMs } : {}),
      env: {
        // A headless turn is always a harness (HarnessKind = AgentKind minus 'shell'),
        // so it takes the agent-identity relay [POD-1375].
        ...sessionRelayEnv(
          msg.sessionId,
          ctx.agentRelayEndpointFor(msg.sessionId),
          ctx.instanceId,
          msg.agent,
        ),
        ...(ctx.homeDir ? { HOME: ctx.homeDir } : {}),
      },
      durableLabel: ctx.durableLabelFor(msg.sessionId),
    }
    const emit = (event: HeadlessTurnEvent) => {
      if (event.kind === 'status' && event.harnessSessionId) {
        bindFirstTurn(event.harnessSessionId)
      }
      ctx.send({
        type: 'headlessTurnEvent',
        requestId: msg.requestId,
        sessionId: msg.sessionId,
        event,
      })
    }
    handle =
      ctx.backend === 'abduco'
        ? runDurableHeadlessTurn(msg.turnId, msg.sessionId, spec, emit, {
            opencode: resolveOpencodeBin,
            cursor: resolveCursorBin,
          })
        : runHeadlessTurn(spec, emit, {
            opencode: resolveOpencodeBin,
            cursor: resolveCursorBin,
          })
  } catch (err) {
    ctx.send({
      type: 'headlessTurnResult',
      requestId: msg.requestId,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    })
    return
  }
  handle.turnId = msg.turnId
  ctx.runningHeadlessTurns.set(msg.sessionId, handle)
  if (!msg.resumeValue && msg.sessionUuid) {
    bindFirstTurn(msg.sessionUuid)
  }
  wireTurnResult(ctx, msg, handle, () => firstTurnBound)
}

function wireTurnResult(
  ctx: DaemonContext,
  msg: Extract<ControlMessage, { type: 'headlessTurnRequest' }>,
  handle: HeadlessTurnHandle,
  isFirstTurnBound: () => boolean = () => false,
): void {
  void handle.done
    .then(({ harnessSessionId, output }) => {
      // First turn: start the transcript tail immediately so streaming-to-chat
      // works from turn 1 without waiting for a bind round-trip.
      if (!msg.resumeValue && !isFirstTurnBound()) {
        recordHeadlessAllocation(ctx, {
          sessionId: msg.sessionId,
          transitionId: `headless:${msg.turnId}:${harnessSessionId}`,
          attemptId: msg.turnId,
          nativeKind: msg.agent,
          value: harnessSessionId,
        })
        try {
          ctx.observers.bindHeadlessSession(msg.sessionId, msg.agent, msg.cwd, harnessSessionId)
        } catch {
          // tail setup is best-effort here; a later headlessBind can retry
        }
      }
      ctx.send({
        type: 'headlessTurnResult',
        requestId: msg.requestId,
        ok: true,
        harnessSessionId,
        output,
      })
    })
    .catch((err) => {
      // A turn can fail AFTER the harness minted its session (interrupt, tool
      // crash, error_during_execution). The conversation exists — report its id
      // and bind the tail anyway, or the thread is orphaned and the next turn
      // silently starts over in a new conversation.
      const harnessSessionId = err instanceof HeadlessTurnError ? err.harnessSessionId : undefined
      if (!msg.resumeValue && harnessSessionId && !isFirstTurnBound()) {
        recordHeadlessAllocation(ctx, {
          sessionId: msg.sessionId,
          transitionId: `headless:${msg.turnId}:${harnessSessionId}`,
          attemptId: msg.turnId,
          nativeKind: msg.agent,
          value: harnessSessionId,
        })
        try {
          ctx.observers.bindHeadlessSession(msg.sessionId, msg.agent, msg.cwd, harnessSessionId)
        } catch {
          // tail setup is best-effort; a later headlessBind can retry
        }
      }
      ctx.send({
        type: 'headlessTurnResult',
        requestId: msg.requestId,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        ...(harnessSessionId ? { harnessSessionId } : {}),
      })
    })
    .finally(() => {
      if (ctx.runningHeadlessTurns.get(msg.sessionId) === handle) {
        ctx.runningHeadlessTurns.delete(msg.sessionId)
      }
    })
}

export const headlessHandlers: Pick<
  ControlHandlers,
  'headlessTurnRequest' | 'headlessInterrupt' | 'headlessTurnAck' | 'headlessBind'
> = {
  headlessTurnRequest: runHeadlessTurnRequest,
  headlessInterrupt: (ctx, msg) => {
    ctx.runningHeadlessTurns.get(msg.sessionId)?.interrupt()
  },
  headlessTurnAck: (_ctx, msg) => acknowledgeDurableHeadlessTurn(msg.turnId),
  headlessBind: (ctx, msg) => {
    try {
      recordHeadlessAllocation(ctx, {
        sessionId: msg.sessionId,
        transitionId: `headless-bind:${msg.requestId}`,
        attemptId: ctx.durableLabelFor(msg.sessionId),
        nativeKind: msg.agentKind,
        value: msg.resumeValue,
      })
      ctx.observers.bindHeadlessSession(msg.sessionId, msg.agentKind, msg.cwd, msg.resumeValue)
      ctx.send({ type: 'headlessBindResult', requestId: msg.requestId, ok: true })
    } catch (err) {
      ctx.send({
        type: 'headlessBindResult',
        requestId: msg.requestId,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  },
}
