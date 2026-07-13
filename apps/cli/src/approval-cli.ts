import type { ApprovalOp } from '@podium/protocol'
import { describeApprovalOp } from '@podium/protocol'

/**
 * Approval broker, CLI half [spec:SP-edbb] (#410). Inside a Podium-managed
 * agent session (PODIUM_ISSUE_RELAY set) management commands do not execute —
 * they file an approval request over the relay; the user approves/denies in
 * the web UI and the daemon executes. `podium approval status <id>` polls.
 */

interface RelayReply {
  ok: boolean
  result?: unknown
  error?: string
}

async function postRelay(
  endpoint: string,
  proc: 'request' | 'get',
  input: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
): Promise<unknown> {
  const res = await fetchImpl(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ router: 'approvals', proc, input }),
  })
  if (!res.ok) throw new Error(`relay HTTP ${res.status}`)
  const body = (await res.json()) as RelayReply
  if (!body.ok) throw new Error(body.error ?? 'relay failed')
  return body.result
}

/** File the approval request for a management op. Returns the text to print. */
export async function requestApproval(
  endpoint: string,
  op: ApprovalOp,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const r = (await postRelay(endpoint, 'request', { op }, fetchImpl)) as {
    id: string
    status: string
    message: string
  }
  return [
    `podium: "${describeApprovalOp(op)}" needs the operator's approval [${r.id}]`,
    r.message,
  ].join('\n')
}

/** `podium approval status <id>` — poll one request (agent sessions only). */
export async function approvalStatus(
  endpoint: string,
  id: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const w = (await postRelay(endpoint, 'get', { id }, fetchImpl)) as {
    id: string
    status: string
    resultText: string | null
  }
  return `${w.id}: ${w.status}${w.resultText ? ` — ${w.resultText}` : ''}`
}
