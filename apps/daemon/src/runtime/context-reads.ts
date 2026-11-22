import {
  admitContextReadResult,
  type ContextReadResult,
  contextReadFailure,
  type RuntimeContextReadRequestMessage,
  SessionContextReadInput,
} from '@podium/protocol/daemon'
import type { ControlHandlers, DaemonContext } from '../control/context'

/** Active reads only, scoped to the daemon lifetime. Completed answers are not
 * cached and no session, process, extension or watch is created here. */
const active = new WeakMap<
  DaemonContext,
  Map<string, { sessionId: string; abort: AbortController }>
>()
const MAX_ACTIVE_READS = 64

async function read(
  ctx: DaemonContext,
  msg: RuntimeContextReadRequestMessage,
  signal: AbortSignal,
): Promise<ContextReadResult> {
  const request = msg.read
  const fail = (status: Parameters<typeof contextReadFailure>[1], code: string, message: string) =>
    contextReadFailure(request, status, code, message)
  const handle = ctx.agentRuntime?.handleFor(msg.sessionId)
  if (!handle) return fail('unavailable', 'not-running', 'No live context session is bound')
  if (handle.binding.sessionId !== msg.sessionId)
    return fail('refused', 'wrong-session', 'Context handle names another session')
  const capability = ctx.agentRuntime?.capabilitiesFor(msg.sessionId)?.context
  if (
    !handle.context ||
    !capability?.supported ||
    (request.intent === 'breakdown' && capability.value.detail !== 'on-demand')
  )
    return fail(
      'unsupported',
      'unsupported',
      'This bound driver does not support the requested context read',
    )
  const binding = () =>
    JSON.stringify([
      handle.binding.bindingVersion,
      handle.binding.driver,
      handle.binding.harness,
      handle.binding.resume?.kind,
      handle.binding.resume?.value,
      handle.binding.process.key,
    ])
  const capturedBinding = binding()
  const currentHandle = () =>
    ctx.agentRuntime?.handleFor(msg.sessionId) === handle && binding() === capturedBinding
  if (
    request.intent === 'breakdown' &&
    handle.binding.bindingVersion !== request.sample.bindingVersion
  )
    return fail(
      'superseded',
      'binding-changed',
      'The requested context binding is no longer current',
    )
  if (signal.aborted) return fail('cancelled', 'cancelled', 'Context read cancelled')
  if (!(await handle.health()).alive || !currentHandle())
    return fail('unavailable', 'not-running', 'The native context session is no longer running')
  signal.throwIfAborted()
  if (request.intent === 'summary') {
    const result = await handle.context.summary({ timeoutMs: request.timeoutMs, signal })
    if (!currentHandle())
      return fail('superseded', 'binding-changed', 'The context binding changed')
    signal.throwIfAborted()
    return admitContextReadResult(request, { intent: 'summary', result })
  }
  // Never snapshot here: a snapshot can replay/refresh native telemetry.
  // context.detail owns cached sample/model admission before and after its IO.
  signal.throwIfAborted()
  const result = await handle.context.detail({ ...request, signal })
  signal.throwIfAborted()
  if (!currentHandle()) return fail('superseded', 'binding-changed', 'The context binding changed')
  return admitContextReadResult(request, { intent: 'breakdown', result })
}

export const contextReadHandlers: Pick<
  ControlHandlers,
  'runtimeContextReadRequest' | 'runtimeContextReadCancel'
> = {
  runtimeContextReadCancel: (ctx, msg) => {
    const pending = active.get(ctx)?.get(msg.requestId)
    if (pending?.sessionId === msg.sessionId) pending.abort.abort()
  },
  runtimeContextReadRequest: (ctx, msg) => {
    const answer = (result: ContextReadResult) =>
      ctx.send({
        type: 'runtimeContextReadResult',
        requestId: msg.requestId,
        sessionId: msg.sessionId,
        result,
      })
    let pending = active.get(ctx)
    if (!pending) {
      pending = new Map()
      active.set(ctx, pending)
    }
    if (pending.has(msg.requestId)) return
    if (!SessionContextReadInput.safeParse(msg).success || pending.size >= MAX_ACTIVE_READS) {
      answer(
        contextReadFailure(
          msg.read,
          'refused',
          'request-bounds',
          'Context read exceeds the request budget',
        ),
      )
      return
    }
    const abort = new AbortController()
    pending.set(msg.requestId, { sessionId: msg.sessionId, abort })
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      abort.abort()
    }, msg.read.timeoutMs)
    const cancelled = () =>
      contextReadFailure(
        msg.read,
        timedOut ? 'unavailable' : 'cancelled',
        timedOut ? 'timed-out' : 'cancelled',
        timedOut ? 'Context read timed out' : 'Context read cancelled',
      )
    let stopAbort: () => void = () => {}
    const aborted = new Promise<ContextReadResult>((resolve) => {
      stopAbort = () => resolve(cancelled())
      abort.signal.addEventListener('abort', stopAbort, { once: true })
    })
    void Promise.race([read(ctx, msg, abort.signal), aborted])
      .catch(() =>
        abort.signal.aborted
          ? cancelled()
          : contextReadFailure(
              msg.read,
              'unavailable',
              'read-failed',
              'Context read did not complete',
            ),
      )
      .then(answer)
      .finally(() => {
        clearTimeout(timer)
        abort.signal.removeEventListener('abort', stopAbort)
        pending.delete(msg.requestId)
      })
  },
}
