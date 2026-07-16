import { resolveCursorBin, resolveOpencodeBin } from '@podium/agent-bridge'
import type { ControlMessage, HeadlessTurnEvent } from '@podium/protocol'
import { acknowledgeDurableHeadlessTurn, runDurableHeadlessTurn } from '../durable-headless.js'
import {
  HeadlessTurnError,
  type HeadlessTurnHandle,
  type HeadlessTurnSpec,
  runHeadlessTurn,
} from '../headless-drivers.js'
import type { ControlHandlers, DaemonContext } from './context'
import { agentRelayEnv } from './session'

// ---- Headless harness sessions (concierge unification, Phase A) ----
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
        ...agentRelayEnv(msg.sessionId, ctx.agentRelayEndpointFor(msg.sessionId), ctx.instanceId),
        ...(ctx.homeDir ? { HOME: ctx.homeDir } : {}),
      },
      durableLabel: ctx.durableLabelFor(msg.sessionId),
    }
    const emit = (event: HeadlessTurnEvent) =>
      ctx.send({
        type: 'headlessTurnEvent',
        requestId: msg.requestId,
        sessionId: msg.sessionId,
        event,
      })
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
    try {
      ctx.observers.bindHeadlessSession(msg.sessionId, msg.agent, msg.cwd, msg.sessionUuid)
    } catch {
      // The durable turn still owns the native transcript; completion retries.
    }
  }
  wireTurnResult(ctx, msg, handle)
}

function wireTurnResult(
  ctx: DaemonContext,
  msg: Extract<ControlMessage, { type: 'headlessTurnRequest' }>,
  handle: HeadlessTurnHandle,
): void {
  void handle.done
    .then(({ harnessSessionId, output }) => {
      // First turn: start the transcript tail immediately so streaming-to-chat
      // works from turn 1 without waiting for a bind round-trip.
      if (!msg.resumeValue) {
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
      if (!msg.resumeValue && harnessSessionId) {
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
