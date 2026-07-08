import { resolveCursorBin, resolveOpencodeBin } from '@podium/agent-bridge'
import type { ControlMessage } from '@podium/protocol'
import { type HeadlessTurnHandle, runHeadlessTurn } from '../headless-drivers.js'
import type { ControlHandlers, DaemonContext } from './context'

// ---- Headless harness sessions (concierge unification, Phase A) ----
// One live turn per session (ctx.runningHeadlessTurns); concurrent sends on a
// thread are rejected so two writers can never race the same harness session.

function runHeadlessTurnRequest(
  ctx: DaemonContext,
  msg: Extract<ControlMessage, { type: 'headlessTurnRequest' }>,
): void {
  if (ctx.runningHeadlessTurns.has(msg.sessionId)) {
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
    handle = runHeadlessTurn(
      {
        agent: msg.agent,
        cwd: msg.cwd,
        prompt: msg.prompt,
        ...(msg.model ? { model: msg.model } : {}),
        ...(msg.effort ? { effort: msg.effort } : {}),
        ...(msg.systemPrompt ? { systemPrompt: msg.systemPrompt } : {}),
        ...(msg.mcpConfig ? { mcpConfig: msg.mcpConfig } : {}),
        ...(msg.allowedTools ? { allowedTools: msg.allowedTools } : {}),
        ...(msg.permissionMode ? { permissionMode: msg.permissionMode } : {}),
        ...(msg.resumeValue ? { resumeValue: msg.resumeValue } : {}),
        ...(msg.sessionUuid ? { sessionUuid: msg.sessionUuid } : {}),
        ...(msg.timeoutMs ? { timeoutMs: msg.timeoutMs } : {}),
      },
      (event) =>
        ctx.send({
          type: 'headlessTurnEvent',
          requestId: msg.requestId,
          sessionId: msg.sessionId,
          event,
        }),
      { opencode: resolveOpencodeBin, cursor: resolveCursorBin },
    )
  } catch (err) {
    ctx.send({
      type: 'headlessTurnResult',
      requestId: msg.requestId,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    })
    return
  }
  ctx.runningHeadlessTurns.set(msg.sessionId, handle)
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
    .catch((err) =>
      ctx.send({
        type: 'headlessTurnResult',
        requestId: msg.requestId,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      }),
    )
    .finally(() => ctx.runningHeadlessTurns.delete(msg.sessionId))
}

export const headlessHandlers: Pick<
  ControlHandlers,
  'headlessTurnRequest' | 'headlessInterrupt' | 'headlessBind'
> = {
  headlessTurnRequest: runHeadlessTurnRequest,
  headlessInterrupt: (ctx, msg) => {
    ctx.runningHeadlessTurns.get(msg.sessionId)?.interrupt()
  },
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
