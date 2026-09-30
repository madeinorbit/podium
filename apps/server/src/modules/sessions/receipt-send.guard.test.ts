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
 * 2. EVERY AGENT SEND IS ONE DURABLE ROW (POD-4795). The seam has no way to
 *    reach a machine around the server's queue: `now`, `queue`, `wake` and
 *    `interrupt` each store one row under the sender's ids, `interrupt` as the
 *    row's delivery mode, and staged files on the row. The inbox's drain is
 *    what forwards rows, authorized at drain time — `host.authorizeAtDrain`
 *    has no daemon provider, so a turn sent around the queue would reach the
 *    agent unauthorized and without the id the daemon dedupes by.
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
  [
    'modules/sessions/session-wiring.ts',
    'binds the verbs onto the service, and the durable-FIFO port',
  ],
  ['modules/messages/service.ts', 'C1’s flag-off branch in injectAndMark / deliverBatch'],
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

describe('W4 guard: every agent send is one durable row (C5, POD-4795)', () => {
  const attachment = {
    id: 'att-1',
    path: '/state/uploads/s1/att-1.png',
    filename: 'shot.png',
    mediaType: 'image/png',
    kind: 'image' as const,
  }
  const sender = (onContract: boolean, reasons: { archive?: string } = {}) => {
    const rows: Record<string, unknown>[] = []
    const legacy: string[] = []
    const s = new ReceiptSender({
      legacy: {
        sendText: async () => {
          legacy.push('now')
          return { ok: true }
        },
        queueText: async () => {
          legacy.push('queue')
          return { ok: true, queued: true }
        },
        interruptText: async () => {
          legacy.push('interrupt')
          return { ok: true }
        },
        resumeAndSend: async () => {
          legacy.push('wake')
          return { ok: true }
        },
      },
      queue: {
        enqueue: async (input) => {
          rows.push(input as unknown as Record<string, unknown>)
          return { ok: true, position: rows.length }
        },
      },
      onContract: () => onContract,
      archiveReason: () => reasons.archive,
      systemPrincipal: () => ({
        kind: 'system',
        attribution: { actor: { kind: 'system', job: 'guard' }, onBehalfOf: null },
        principalRef: 'guard',
        delegation: null,
      }),
      now: () => 0,
    })
    return { s, rows, legacy }
  }

  it('stores every via as one row, and only interrupt as an interrupt', async () => {
    const { s, rows, legacy } = sender(true)
    for (const via of ['now', 'queue', 'wake', 'interrupt'] as const) {
      expect(await s.send(via, { sessionId: asSessionId('s1'), text: via })).toEqual({
        ok: true,
        queued: true,
        position: rows.length,
      })
    }
    expect(rows.map((row) => [row.text, row.delivery])).toEqual([
      ['now', 'when-ready'],
      ['queue', 'when-ready'],
      ['wake', 'when-ready'],
      ['interrupt', 'interrupt'],
    ])
    expect(legacy).toEqual([])
  })

  it('answers with the queue’s own receipt, at once', async () => {
    const { s } = sender(true)
    const receipts: string[] = []
    await s.send(
      'interrupt',
      { sessionId: asSessionId('s1'), text: 'stop and do this' },
      (receipt) => {
        receipts.push(receipt.outcome)
      },
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(receipts).toEqual(['queued'])
  })

  it.each([
    false,
    true,
  ])('refuses an archived session before the contract=%s send seam', async (onContract) => {
    const { s, rows, legacy } = sender(onContract, { archive: 'session is archived' })
    for (const via of ['now', 'queue', 'interrupt', 'wake'] as const) {
      expect(await s.send(via, { sessionId: asSessionId('s1'), text: 'do not revive' })).toEqual({
        ok: false,
        reason: 'session is archived',
      })
    }
    expect(rows).toEqual([])
    expect(legacy).toEqual([])
  })

  it.each([
    'now',
    'queue',
    'interrupt',
  ] as const)('stores staged refs on the %s row with the text', async (via) => {
    const { s, rows } = sender(true)
    expect(
      await s.send(via, {
        sessionId: asSessionId('s1'),
        text: 'describe it',
        attachments: [attachment],
      }),
    ).toMatchObject({ ok: true, queued: true })
    expect(rows).toEqual([
      expect.objectContaining({ text: 'describe it', attachments: [attachment] }),
    ])
  })

  it('refuses a staged ref on the off-contract arm instead of dropping it into legacy text', async () => {
    const receipts: string[] = []
    const offContract = sender(false)
    expect(
      await offContract.s.send(
        'now',
        { sessionId: asSessionId('s1'), text: 'describe it', attachments: [attachment] },
        (receipt) =>
          receipts.push(receipt.outcome === 'refused' ? receipt.refusal.reason : receipt.outcome),
      ),
    ).toEqual({ ok: false, reason: 'this agent cannot accept file attachments' })
    expect(offContract.rows).toEqual([])
    expect(offContract.legacy).toEqual([])
    expect(receipts).toEqual(['unsupported'])
  })

  it('rejects a forged filesystem ref before it reaches either send implementation', async () => {
    const receipts: string[] = []
    const live = sender(true)
    expect(
      await live.s.send(
        'interrupt',
        {
          sessionId: asSessionId('s1'),
          text: 'exfiltrate this',
          attachments: [
            {
              id: 'id_rsa',
              path: '/home/victim/.ssh/id_rsa',
              filename: 'id_rsa',
              mediaType: 'application/octet-stream',
              kind: 'file',
            },
          ],
        },
        (receipt) =>
          receipts.push(receipt.outcome === 'refused' ? receipt.refusal.reason : receipt.outcome),
      ),
    ).toEqual({
      ok: false,
      reason: 'file attachment reference was not staged for this session',
    })
    expect(live.rows).toEqual([])
    expect(receipts).toEqual(['staging_failed'])
  })

  it('carries the idempotency key and the ledger id into the durable row', async () => {
    // REGRESSION. The port originally carried neither, and nothing about a send
    // would have looked wrong: a dropped `mutationId` turns every steward or
    // automation retry from a no-op into a duplicate turn, and a dropped
    // `sourceMessageId` leaves the row invisible to the ledger that must confirm
    // it, uncancellable, and re-pushed by the next sweep. Both failures surface
    // far from the cause, as duplicated or stuck work.
    const { s, rows } = sender(true)
    for (const via of ['queue', 'interrupt'] as const) {
      await s.send(via, {
        sessionId: asSessionId('s1'),
        text: 'nudge',
        mutationId: `fact-key-${via}` as never,
        sourceMessageId: `msg-${via}`,
      })
    }
    expect(rows).toEqual([
      expect.objectContaining({ mutationId: 'fact-key-queue', sourceMessageId: 'msg-queue' }),
      expect.objectContaining({
        mutationId: 'fact-key-interrupt',
        sourceMessageId: 'msg-interrupt',
      }),
    ])
  })

  it('touches no row for a session with no driver behind it', async () => {
    const { s, rows, legacy } = sender(false)
    await s.send('now', { sessionId: asSessionId('s1'), text: 'legacy' })
    await s.send('interrupt', { sessionId: asSessionId('s1'), text: 'legacy' })
    // Shells go to the legacy verbs and nowhere near the durable contract rows.
    expect(rows).toEqual([])
    expect(legacy).toEqual(['now', 'interrupt'])
  })
})
