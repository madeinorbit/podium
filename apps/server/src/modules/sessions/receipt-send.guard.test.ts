/**
 * THE W4 GUARD (POD-1761 W4, C5).
 *
 * Two invariants that are true today, cost nothing to keep, and would each fail
 * silently — a migration that regresses by ADDITION rather than by breakage is
 * exactly what a characterization suite cannot see, because every existing test
 * still passes while a new caller quietly reintroduces the old path.
 *
 * 1. THE LEGACY VERBS HAVE A CLOSED SET OF CALLERS. `sendText`, `queueText`,
 *    `interruptText` and `resumeAndSend` still exist and still work — they ARE
 *    the flag-off implementation, reached through `ReceiptSender` whenever a
 *    session has no driver behind it. What must not happen is a NEW caller
 *    reaching around the seam, because such a caller is invisible to the flag
 *    and would keep inferring delivery from queue depth forever.
 *
 * 2. THE DURABLE QUEUE NEVER CROSSES THE SOCKET. `queue` and `steer` complete on
 *    the server; nothing forwards them to a machine. This is what keeps W3's
 *    second review precondition satisfied: `host.authorizeAtDrain` has no daemon
 *    provider, so a forwarded driver-side queue would drain unauthorized.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { asSessionId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { ReceiptSender } from './receipt-send'

const SRC = join(import.meta.dirname, '..', '..')

const LEGACY_CALL = /\.(sendText|queueText|interruptText|resumeAndSend)\(/

/**
 * WHY AN ALLOWLIST OF FILES AND NOT OF LINES. A line-anchored exception rots on
 * the first unrelated edit above it and then gets "fixed" by widening, which is
 * how a guard becomes decoration. A file list is coarser but it is a RATCHET:
 * adding a legacy call to a file already on it is a code-review question, and
 * adding one anywhere else is a red test with this comment attached.
 */
const ALLOWED = new Map<string, string>([
  ['modules/sessions/inbox.ts', 'the legacy verbs themselves'],
  ['modules/sessions/receipt-send.ts', 'the seam’s own flag-off branch'],
  ['modules/sessions/session-wiring.ts', 'binds the verbs onto the service, and the durable-FIFO port'],
  ['modules/messages/service.ts', 'C1’s flag-off branch in injectAndMark / deliverBatch'],
  ['modules/superagent/answer-delivery.ts', 'C4’s flag-off branch for the answer text fallback'],
  ['modules/automations/service.ts', 'calls its own ports, which the composition root points at the seam'],
  ['gateway/ws-server.ts', 'a WebSocket frame write — a different sendText entirely'],
])

function* tsFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      yield* tsFiles(full)
    } else if (entry.endsWith('.ts') && !entry.includes('.test.')) {
      yield full
    }
  }
}

describe('W4 guard: the legacy send verbs have a closed set of callers (C5)', () => {
  it('finds no caller outside the allowlist', () => {
    const offenders: string[] = []
    for (const file of tsFiles(SRC)) {
      const rel = file.slice(SRC.length + 1)
      if (ALLOWED.has(rel)) continue
      const body = readFileSync(file, 'utf8')
      if (LEGACY_CALL.test(body)) offenders.push(rel)
    }
    // A NEW NAME HERE IS THE FINDING, not a nuisance. Route the caller through
    // `receiptSend` / `ReceiptSender.send`; add it to ALLOWED only if it is
    // genuinely another flag-off branch, and say which in the map's value.
    expect(offenders).toEqual([])
  })

  it('keeps every allowlist entry earning its place', () => {
    // A stale exception is worse than a missing one: it silently re-permits the
    // thing it was written to notice.
    const stale = [...ALLOWED.keys()].filter(
      (rel) => !LEGACY_CALL.test(readFileSync(join(SRC, rel), 'utf8')),
    )
    expect(stale).toEqual([])
  })
})

describe('W4 guard: the durable queue is never forwarded to a machine (C5)', () => {
  const sender = (onContract: boolean) => {
    const forwarded: string[] = []
    const enqueued: string[] = []
    const s = new ReceiptSender({
      legacy: {
        sendText: () => ({ ok: true }),
        queueText: () => ({ ok: true, queued: true }),
        interruptText: () => ({ ok: true }),
        resumeAndSend: () => ({ ok: true }),
      },
      contract: {
        send: async (input) => {
          forwarded.push(input.delivery)
          return { outcome: 'accepted', turnEpoch: 1, deliveredAs: 'when-ready', provenBy: 'hook', at: 'now' }
        },
      },
      queue: {
        enqueue: (input) => {
          enqueued.push(input.text)
          return { ok: true, position: 1 }
        },
      },
      onContract: () => onContract,
      liveWithEmptyQueue: () => false,
      systemPrincipal: () => ({
        kind: 'system',
        attribution: { actor: { kind: 'system', job: 'guard' }, onBehalfOf: null },
        principalRef: 'guard',
        delegation: null,
      }),
      now: () => 0,
    })
    return { s, forwarded, enqueued }
  }

  it('completes a queued send on the server and forwards nothing', () => {
    const { s, forwarded, enqueued } = sender(true)
    const r = s.send('queue', { sessionId: asSessionId('s1'), text: 'durable' })

    expect(r).toEqual({ ok: true, queued: true })
    expect(enqueued).toEqual(['durable'])
    // THE PRECONDITION. `authorizeAtDrain` has no daemon provider, so a queue
    // that reached the machine would drain unauthorized.
    expect(forwarded).toEqual([])
  })

  it('completes a parked wake on the server too — the resurrect the driver cannot do', () => {
    const { s, forwarded, enqueued } = sender(true)
    s.send('wake', { sessionId: asSessionId('s1'), text: 'wake up' })

    expect(enqueued).toEqual(['wake up'])
    expect(forwarded).toEqual([])
  })

  it('forwards only the live deliveries, and only those', () => {
    const { s, forwarded, enqueued } = sender(true)
    s.send('now', { sessionId: asSessionId('s1'), text: 'a' })
    s.send('interrupt', { sessionId: asSessionId('s1'), text: 'b' })

    expect(forwarded).toEqual(['when-ready', 'interrupt'])
    expect(enqueued).toEqual([])
  })

  it('touches neither path for a session with no driver behind it', () => {
    const { s, forwarded, enqueued } = sender(false)
    s.send('now', { sessionId: asSessionId('s1'), text: 'legacy' })
    s.send('queue', { sessionId: asSessionId('s1'), text: 'legacy' })

    // Flag off goes to the legacy verbs and nowhere near the contract — the
    // "zero diff" claim, as a test rather than an assurance.
    expect(forwarded).toEqual([])
    expect(enqueued).toEqual([])
  })
})
