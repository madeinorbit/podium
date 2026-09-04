import { requestParentTopology, signalParentTopology } from '@podium/runtime/parent-control'

export interface TargetLifecycleDeps {
  requestTopology?: typeof requestParentTopology
}

export interface TargetRetirementDeps extends TargetLifecycleDeps {
  signalTopology?: typeof signalParentTopology
  /** Injected by tests; production uses a short response-flush delay. */
  schedule?: (callback: () => void, delayMs: number) => void
  flushDelayMs?: number
}

/**
 * Start and prove the new server role without relinquishing the target daemon process. The caller
 * still needs this daemon to send the promotion result and to answer an idempotent retry if that
 * result is lost.
 */
export async function restartAsServer(
  _input: { transferId: string },
  deps: TargetLifecycleDeps = {},
): Promise<void> {
  const reconcile = deps.requestTopology ?? requestParentTopology
  await reconcile({ children: ['server', 'daemon'], health: 'server' })
  // Deliberately retain this daemon after local serving proof. A timer cannot prove that the
  // promote reply reached the source; retaining the control channel makes a lost reply retryable.
  // Promotion disarms managed resurrection, and an explicit post-ack seam retires this process.
}

/**
 * Context callback for the promoted-proof acknowledgement handler. Only that explicit ack may
 * schedule daemon retirement. The short delay is not a delivery guess: acknowledgement already
 * happened, and the delay exists solely to let its response bytes leave this process before the
 * detached retirement worker stops it.
 */
export function retireTargetDaemonAfterAcknowledgement(deps: TargetRetirementDeps = {}): void {
  const signal = deps.signalTopology ?? signalParentTopology
  const schedule = deps.schedule ?? ((callback, delayMs) => void setTimeout(callback, delayMs))
  schedule(() => {
    const posted = signal({ children: ['server'], health: 'none' })
    if (!posted.ok)
      console.error('podium: target daemon remains live because no parent supervisor is registered')
  }, deps.flushDelayMs ?? 50)
}
