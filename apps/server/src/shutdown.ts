/**
 * Deterministic, fast server shutdown (POD-611).
 *
 * The old close path awaited ws.close() and then ran ALL persistence
 * (flushActivity, registry.dispose, store.close, …) inside the node:http
 * `server.close(cb)` CALLBACK. That callback waits for lingering keep-alive /
 * WebSocket-upgrade sockets to drain — they essentially never do — so the boot
 * kernel's close race timed out on nearly every stop and `proc.exit(0)` fired
 * WITHOUT persistence ever running (silent activity-timestamp loss), after
 * eating the full close timeout (4s+ per restart).
 *
 * New ordering, each stage isolated so socket behavior can never cost us state:
 *  1. Stop intake: hard-terminate WS clients (ws.close() terminates first —
 *     clients and the daemon reconnect with backoff, a hard close is expected).
 *     Awaited only up to a short grace so a pathological hang can't block 2.
 *  2. Persist: run every persistence step, in order, each in try/catch — one
 *     failure logs and continues, and no step depends on any socket draining.
 *  3. Force-close the network: server.close() stops accepting, then
 *     closeAllConnections() destroys lingering sockets so the close callback
 *     fires immediately (verified present + effective on Bun 1.3 and Node 18+).
 */
import type { Server } from 'node:http'

/** Named persistence step; the name is only used in failure logs. */
export type PersistStep = readonly [name: string, run: () => void]

export interface CloseServerDeps {
  /**
   * attachWebSockets handle close — synchronously terminates all WS clients,
   * then resolves once both WebSocketServers have closed.
   */
  closeWebSockets: () => Promise<void>
  /** The listening node:http server (closeAllConnections optional for older runtimes). */
  server: Pick<Server, 'close'> & { closeAllConnections?: () => void }
  /** Persistence steps, run in order after intake stops. */
  persist: readonly PersistStep[]
  /** Max wait for the WS close to settle before persisting anyway. Default 250ms. */
  wsCloseGraceMs?: number
  logError?: (msg: string) => void
}

export async function closeServerFast(deps: CloseServerDeps): Promise<void> {
  const logError = deps.logError ?? ((msg) => console.error(msg))
  const grace = deps.wsCloseGraceMs ?? 250

  // 1. Stop intake FIRST so no new writes race the store close below. The
  //    terminate() calls inside ws.close() run synchronously on invocation;
  //    the returned promise (detach handlers settled) is awaited only up to
  //    `grace` — persistence must run regardless of socket behavior.
  let wsClosed: Promise<void> = Promise.resolve()
  try {
    wsClosed = Promise.resolve(deps.closeWebSockets())
  } catch (err) {
    logError(`[podium:server] websocket close threw during shutdown: ${String(err)}`)
  }
  let graceTimer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    wsClosed.catch((err) => {
      logError(`[podium:server] websocket close failed during shutdown: ${String(err)}`)
    }),
    new Promise<void>((r) => {
      graceTimer = setTimeout(r, grace)
    }),
  ])
  if (graceTimer !== undefined) clearTimeout(graceTimer)

  // 2. Persist state — before waiting on ANY http socket, each step isolated
  //    so one failure can't skip the rest.
  for (const [name, run] of deps.persist) {
    try {
      run()
    } catch (err) {
      logError(`[podium:server] shutdown step '${name}' failed: ${String(err)}`)
    }
  }

  // 3. Force-close the network. close() alone would wait (potentially forever)
  //    for keep-alive sockets to drain; closeAllConnections() destroys them so
  //    the callback fires immediately. If a runtime ever lacks it, the boot
  //    kernel's closeTimeoutMs backstop still bounds the wait — with all state
  //    already persisted above.
  await new Promise<void>((resolve) => {
    deps.server.close(() => resolve())
    deps.server.closeAllConnections?.()
  })
}
