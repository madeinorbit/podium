import type { DaemonMessage } from '@podium/protocol'

export interface IssueRelayRequest {
  sessionId: string
  router: string
  proc: string
  input?: unknown
  outsideScope?: boolean
}

export interface IssueRelayResult {
  ok: boolean
  result?: unknown
  error?: string
}

export interface IssueRelayHub {
  relay(req: IssueRelayRequest): Promise<IssueRelayResult>
  onResult(msg: { requestId: string; ok: boolean; result?: unknown; error?: string }): void
  pendingCount(): number
}

/** Correlates daemon-initiated issue-relay requests with the server's results. Mirrors the
 *  server's daemonRequest pattern, but here the DAEMON initiates. Resolve-once, timeout-safe. */
export function createIssueRelayHub(
  send: (msg: DaemonMessage) => void,
  opts?: { timeoutMs?: number },
): IssueRelayHub {
  const timeoutMs = opts?.timeoutMs ?? 30_000
  const pending = new Map<string, (r: IssueRelayResult) => void>()
  let seq = 0
  return {
    relay(req) {
      const requestId = `ir${seq++}`
      return new Promise<IssueRelayResult>((resolve) => {
        const timer = setTimeout(() => {
          if (pending.delete(requestId)) resolve({ ok: false, error: 'issue relay timed out' })
        }, timeoutMs)
        timer.unref?.()
        pending.set(requestId, (r) => {
          clearTimeout(timer)
          resolve(r)
        })
        send({
          type: 'issueRelayRequest',
          requestId,
          sessionId: req.sessionId,
          router: req.router,
          proc: req.proc,
          ...(req.input !== undefined ? { input: req.input } : {}),
          ...(req.outsideScope ? { outsideScope: true } : {}),
        })
      })
    },
    onResult(msg) {
      const resolve = pending.get(msg.requestId)
      if (!resolve) return // unknown / duplicate / late — ignore
      pending.delete(msg.requestId)
      resolve({
        ok: msg.ok,
        ...(msg.result !== undefined ? { result: msg.result } : {}),
        ...(msg.error !== undefined ? { error: msg.error } : {}),
      })
    },
    pendingCount: () => pending.size,
  }
}
