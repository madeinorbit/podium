import type { ApprovalOp, ApprovalStatus, ApprovalWire } from '@podium/protocol'
import { describeApprovalOp } from '@podium/protocol'

/**
 * Approval broker, CLI half [spec:SP-edbb] (#410). Inside a Podium-managed
 * agent session (PODIUM_ISSUE_RELAY set) management commands do not execute —
 * they file an approval request over the relay and BLOCK until the operator
 * decides, exactly like any permission prompt: approved → the daemon runs the
 * op and this command prints its real output and exits 0; denied/failed → it
 * prints why and exits non-zero. The agent learns the answer by the command
 * simply finishing, so `podium update && podium status` means what it says.
 *
 * The wait is bounded: an agent must never hang forever on a human who stepped
 * away. On timeout the request stays valid (deciding it later still executes
 * it) and the outcome reaches the agent later as issue mail.
 */

/** How long the CLI blocks on a decision before giving up (the request lives on). */
export const APPROVAL_WAIT_MS = 10 * 60 * 1000
const POLL_INTERVAL_MS = 1500

const TERMINAL: ReadonlySet<ApprovalStatus> = new Set<ApprovalStatus>([
  'denied',
  'succeeded',
  'failed',
])

export interface ApprovalOutcome {
  text: string
  exitCode: number
}

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

/** Render a terminal (or timed-out) request as CLI output + exit code. */
export function renderOutcome(w: ApprovalWire, timedOut = false): ApprovalOutcome {
  const what = describeApprovalOp(w.op)
  if (timedOut) {
    return {
      text: `podium: still awaiting approval for "${what}" [${w.id}] — giving up after ${Math.round(
        APPROVAL_WAIT_MS / 60000,
      )} minutes. The request is still live: it runs if the operator approves it, and you will be told the outcome. Poll with \`podium approval status ${w.id}\`.`,
      exitCode: 75, // EX_TEMPFAIL — retryable, distinct from a denial
    }
  }
  switch (w.status) {
    case 'succeeded':
      return { text: w.resultText?.trim() || `podium: ${what} — done.`, exitCode: 0 }
    case 'denied':
      return { text: `podium: the operator denied "${what}" [${w.id}].`, exitCode: 1 }
    case 'failed':
      return {
        text: `podium: "${what}" was approved but failed — ${w.resultText ?? 'no output'}`,
        exitCode: 1,
      }
    default:
      // 'pending'/'executing' never reach here (the caller loops on TERMINAL).
      return { text: `podium: ${what} is ${w.status} [${w.id}]`, exitCode: 75 }
  }
}

/**
 * File the approval request for a management op and BLOCK until it is decided.
 * `announce` prints the "waiting for approval" line as soon as the request is
 * filed, so an agent (and anyone tailing the pane) sees why the command hangs.
 */
export async function requestApproval(
  endpoint: string,
  op: ApprovalOp,
  opts: {
    fetchImpl?: typeof fetch
    announce?: (line: string) => void
    sleep?: (ms: number) => Promise<void>
    now?: () => number
    waitMs?: number
  } = {},
): Promise<ApprovalOutcome> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const announce = opts.announce ?? ((l: string) => console.log(l))
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))
  const now = opts.now ?? (() => Date.now())
  const waitMs = opts.waitMs ?? APPROVAL_WAIT_MS

  const filed = (await postRelay(endpoint, 'request', { op }, fetchImpl)) as {
    id: string
    status: ApprovalStatus
  }
  announce(
    `podium: "${describeApprovalOp(op)}" needs the operator's approval [${filed.id}] — waiting for a decision in the Podium UI…`,
  )

  const deadline = now() + waitMs
  let latest = (await postRelay(endpoint, 'get', { id: filed.id }, fetchImpl)) as ApprovalWire
  while (!TERMINAL.has(latest.status)) {
    if (now() >= deadline) return renderOutcome(latest, true)
    await sleep(POLL_INTERVAL_MS)
    latest = (await postRelay(endpoint, 'get', { id: filed.id }, fetchImpl)) as ApprovalWire
  }
  return renderOutcome(latest)
}

/** `podium approval status <id>` — read one request without blocking. */
export async function approvalStatus(
  endpoint: string,
  id: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const w = (await postRelay(endpoint, 'get', { id }, fetchImpl)) as ApprovalWire
  return `${w.id}: ${w.status}${w.resultText ? ` — ${w.resultText}` : ''}`
}
