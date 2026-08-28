import type { ControlMessage } from '@podium/protocol/daemon'
import type { ControlHandlers, DaemonContext } from './context'

const PROBE_TIMEOUT_MS = 15_000

export interface DevArtifactProbeOutcome {
  ok: boolean
  status?: number
  detail?: string
}

/**
 * Reach the exact artifact route without downloading the quarter-gigabyte
 * bundle. HEAD still proves this machine's resolver, route, authentication and
 * the artifact's presence; the publisher's route gives it GET-identical status
 * and headers without opening a response body.
 */
export async function probeDevArtifact(
  url: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<DevArtifactProbeOutcome> {
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), PROBE_TIMEOUT_MS)
  try {
    const response = await fetchImpl(url, { method: 'HEAD', signal: abort.signal })
    if (response.ok) return { ok: true, status: response.status }
    return {
      ok: false,
      status: response.status,
      detail: `artifact route answered HTTP ${response.status}`,
    }
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    }
  } finally {
    clearTimeout(timer)
  }
}

async function handleDevArtifactProbe(
  ctx: DaemonContext,
  msg: Extract<ControlMessage, { type: 'devArtifactProbeRequest' }>,
): Promise<void> {
  const outcome = await probeDevArtifact(msg.url)
  ctx.send({
    type: 'devArtifactProbeResult',
    requestId: msg.requestId,
    ok: outcome.ok,
    ...(outcome.status === undefined ? {} : { status: outcome.status }),
    ...(outcome.detail === undefined ? {} : { detail: outcome.detail }),
  })
}

export const updateHandlers: Pick<ControlHandlers, 'devArtifactProbeRequest'> = {
  devArtifactProbeRequest: (ctx, msg) => {
    void handleDevArtifactProbe(ctx, msg)
  },
}
