/**
 * POD-785 MEASUREMENT — what actually fills the client outbox, and what it costs.
 *
 * The coordinator's brief is explicit: measure before you bound. A bound chosen
 * without knowing what the queue CONTAINS is a guess, and a wrong bound is worse
 * than none because it discards user work at a threshold nobody validated.
 *
 * Run: `bun docs/internal/pod-785-evidence/measure-outbox-growth.ts`
 *
 * This drives the REAL kernel `Outbox` (packages/sync/src/outbox/outbox.ts) over
 * the real in-memory store double — not a model of it — so the numbers below are
 * the code's behaviour rather than a description of it.
 */

import { Outbox } from '../../../packages/sync/src/outbox/outbox'
import type { EnqueueRequest } from '../../../packages/sync/src/outbox/outbox'
import type { OutboxSubmitOutcome } from '../../../packages/sync/src/outbox/ports'
import type { OutboxAttribution, OutboxCommand, OutboxRecord } from '../../../packages/sync/src/outbox/records'
import {
  InMemoryOutboxStore,
  ManualClock,
  ScriptedAuthority,
  sequentialMutationIds,
} from '../../../packages/sync/src/outbox/test-doubles'

const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000
const ADA: OutboxAttribution = { actor: { kind: 'user', userId: 'u-ada' }, onBehalfOf: 'u-ada' }

/** The live web wiring's constant — packages/client-core/src/engine/kernel-outbox.ts:171. */
const CLIENT_PARTITION = 'client-outbox'

const cmd = (name: string): OutboxCommand => ({ name, version: 1, delivery: 'offline-eligible' })

const applied: OutboxSubmitOutcome = { kind: 'applied' }
const denied: OutboxSubmitOutcome = { kind: 'rejected', refusal: { kind: 'unauthorized' } }

async function open(
  respond: (envelope: { command: string; input: unknown }) => OutboxSubmitOutcome = () => applied,
): Promise<{ outbox: Outbox; store: InMemoryOutboxStore; clock: ManualClock }> {
  const store = new InMemoryOutboxStore()
  const clock = new ManualClock()
  const outbox = await Outbox.open({
    store,
    // `OutboxEnvelope.command` is a STRING (ports.ts:32), not the OutboxCommand.
    // An earlier draft of this script read `.command.name` here, got `undefined`,
    // matched nothing, and answered `applied` to everything — so section A
    // reported NO wedge against code that wedges. The assertion in measureWedge()
    // exists so that failure mode cannot recur silently.
    submit: new ScriptedAuthority((envelope) =>
      respond({ command: envelope.command, input: envelope.input }),
    ),
    principal: 'u-ada',
    now: clock.now,
    maxAgeMs: MAX_AGE_MS,
    newMutationId: sequentialMutationIds('m'),
    onStoreUnreadable: () => {},
  })
  return { outbox, store, clock }
}

const readReceipt = (issue: string, partitionKey: string): EnqueueRequest => ({
  command: cmd('issues.markRead'),
  input: { issueId: issue, readAt: '2026-07-17T09:14:22.101Z' },
  attribution: ADA,
  partitionKey,
})

const line = (s = '') => console.log(s)
const rule = (t: string) => {
  line()
  line(`── ${t} ${'─'.repeat(Math.max(0, 68 - t.length))}`)
}

// ───────────────────────────────────────────────────────────────────────────
// A. THE WEDGE. One partition for the whole client queue means one parked entry
//    stops every drain, for every unrelated target, forever.
// ───────────────────────────────────────────────────────────────────────────
async function measureWedge(): Promise<void> {
  rule('A. single-partition wedge (the live web wiring)')

  // A write the Authority definitively refuses — e.g. a share was revoked, so
  // ADR 3 D8's live delegation check denies it PERMANENTLY.
  const { outbox } = await open((e) => (e.command === 'sessions.rename' ? denied : applied))

  await outbox.enqueue({
    command: cmd('sessions.rename'),
    input: { sessionId: 's-revoked', title: 'renamed offline' },
    attribution: ADA,
    partitionKey: CLIENT_PARTITION,
  })
  await outbox.drain()

  const parked = outbox.deadLetters().length
  // The instrument must be able to say NO: if the refusal did not actually park
  // an entry, there is no wedge to measure and every number below is a lie.
  if (parked !== 1) {
    throw new Error(
      `measurement precondition failed: expected 1 dead-lettered entry to wedge the partition, got ${parked}`,
    )
  }
  // Now the user keeps reading issues, which is what the app does constantly.
  for (let i = 0; i < 500; i++) {
    await outbox.enqueue(readReceipt(`POD-${i}`, CLIENT_PARTITION))
  }
  await outbox.drain()
  await outbox.drain()
  await outbox.drain()

  line(`dead-lettered at head:            ${parked}`)
  line(`read receipts enqueued behind it: 500`)
  line(`still pending after 3 drains:     ${outbox.pending().length}`)
  line(`delivered:                        ${500 - outbox.pending().length}`)
  line()
  line('  → The queue is WEDGED. Nothing drains while one entry is parked,')
  line('    because every client write shares one partitionKey and D12 stops a')
  line('    partition at its first unresolved entry (outbox.ts:517-521).')

  // The same workload, keyed per target the way the kernel's own conformance
  // harness does (packages/sync/src/conformance/harness.ts:240).
  const perTarget = await open((e) => (e.command === 'sessions.rename' ? denied : applied))
  await perTarget.outbox.enqueue({
    command: cmd('sessions.rename'),
    input: { sessionId: 's-revoked', title: 'renamed offline' },
    attribution: ADA,
    partitionKey: 'session:s-revoked',
  })
  await perTarget.outbox.drain()
  for (let i = 0; i < 500; i++) {
    await perTarget.outbox.enqueue(readReceipt(`POD-${i}`, `issue:POD-${i}`))
  }
  await perTarget.outbox.drain()

  line()
  line(`per-target partitions, same workload:`)
  line(`  still pending after 1 drain:    ${perTarget.outbox.pending().length}`)
  line(`  dead letters:                   ${perTarget.outbox.deadLetters().length}`)
  line('  → Only the revoked session is stuck. Every unrelated write lands.')
}

// ───────────────────────────────────────────────────────────────────────────
// B. WHAT AN ENTRY COSTS. Durable bytes per record, by command kind.
// ───────────────────────────────────────────────────────────────────────────
async function measureBytes(): Promise<void> {
  rule('B. durable bytes per entry, by command')

  // Representative inputs for the 16 enqueueable contracts (wiring.ts:124-149).
  const samples: Array<{ kind: string; name: string; input: unknown }> = [
    { kind: 'issueMarkRead', name: 'issues.markRead', input: { issueId: 'iss_0f3c9a1b-4d2e-4c8a-9f11-7b6d5e4a3c22', readAt: '2026-07-17T09:14:22.101Z' } },
    { kind: 'issueMarkUnread', name: 'issues.markUnread', input: { issueId: 'iss_0f3c9a1b-4d2e-4c8a-9f11-7b6d5e4a3c22' } },
    { kind: 'sessionMarkRead', name: 'sessions.markRead', input: { sessionId: 'sess_8c2b7f60-1a5d-4e93-b0c7-2f9a4d6e8b31', readAt: '2026-07-17T09:14:22.101Z' } },
    { kind: 'issueSetTucked', name: 'issues.setTucked', input: { issueId: 'iss_0f3c9a1b-4d2e-4c8a-9f11-7b6d5e4a3c22', tucked: true } },
    { kind: 'rename', name: 'sessions.rename', input: { sessionId: 'sess_8c2b7f60-1a5d-4e93-b0c7-2f9a4d6e8b31', title: 'Outbox capacity + retention' } },
    { kind: 'snoozeSet', name: 'snoozes.set', input: { sessionId: 'sess_8c2b7f60-1a5d-4e93-b0c7-2f9a4d6e8b31', until: '2026-07-18T09:00:00.000Z' } },
    { kind: 'tabSetOrder', name: 'tabs.setOrder', input: { order: Array.from({ length: 12 }, (_, i) => `tab_${i}_9a4d6e8b31c7`) } },
    { kind: 'resumeAndSend', name: 'sessions.resumeAndSend', input: { sessionId: 'sess_8c2b7f60-1a5d-4e93-b0c7-2f9a4d6e8b31', text: 'please rerun the failing lane and paste the first 40 lines of output' } },
  ]

  const rows: Array<{ kind: string; bytes: number }> = []
  for (const s of samples) {
    const { outbox, store } = await open()
    await outbox.enqueue({
      command: cmd(s.name),
      input: s.input,
      attribution: ADA,
      partitionKey: CLIENT_PARTITION,
    })
    const record = store.durable()[0] as OutboxRecord
    rows.push({ kind: s.kind, bytes: new TextEncoder().encode(JSON.stringify(record)).length })
  }

  const width = Math.max(...rows.map((r) => r.kind.length))
  for (const r of rows) line(`  ${r.kind.padEnd(width)}  ${String(r.bytes).padStart(4)} B`)

  const receipt = rows.find((r) => r.kind === 'issueMarkRead')!.bytes
  line()
  line(`  median entry ≈ ${rows.map((r) => r.bytes).sort((a, b) => a - b)[Math.floor(rows.length / 2)]} B; a read receipt is ${receipt} B`)
  line()
  line(`  entries to fill the OLD localStorage ceiling (~5 MB, and note the`)
  line(`  blob is UTF-16 in most engines so the effective budget is ~2.5 M chars):`)
  line(`    at ${receipt} B/entry → ~${Math.round(5 * 1024 * 1024 / receipt).toLocaleString()} read receipts`)
  line(`  → reachable in normal use once the queue never drains. That is the`)
  line(`    2026-07-17 incident: markIssueRead named as the trigger.`)
}

// ───────────────────────────────────────────────────────────────────────────
// C. COLLAPSE YIELD. How much of a wedged read-heavy queue is redundant?
// ───────────────────────────────────────────────────────────────────────────
async function measureCollapseYield(): Promise<void> {
  rule('C. how much of a wedged queue is SUPERSEDED (safely collapsible)')

  // A plausible browsing session against a wedged queue: the user revisits a
  // working set of issues repeatedly, marking each read every time they open it.
  const WORKING_SET = 60
  const VISITS = 900
  const { outbox } = await open(() => applied)
  await outbox.enqueue({
    command: cmd('sessions.rename'),
    input: { sessionId: 's-revoked', title: 'x' },
    attribution: ADA,
    partitionKey: CLIENT_PARTITION,
  })

  let seed = 12345
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
  const receipts: string[] = []
  for (let i = 0; i < VISITS; i++) receipts.push(`POD-${Math.floor(rand() * WORKING_SET)}`)
  for (const issue of receipts) await outbox.enqueue(readReceipt(issue, CLIENT_PARTITION))

  const queued = outbox.pending().filter((r) => r.command.name === 'issues.markRead')
  // Superseded = every read receipt for a target that has a LATER queued read
  // receipt for the same target. Only the newest carries any information.
  const lastIndexFor = new Map<string, number>()
  queued.forEach((r, i) => lastIndexFor.set((r.input as { issueId: string }).issueId, i))
  const superseded = queued.filter(
    (r, i) => lastIndexFor.get((r.input as { issueId: string }).issueId) !== i,
  )

  line(`  distinct issues in working set:  ${WORKING_SET}`)
  line(`  read receipts queued:            ${queued.length}`)
  line(`  superseded by a later receipt:   ${superseded.length}  (${((superseded.length / queued.length) * 100).toFixed(1)}%)`)
  line(`  irreducible (newest per target): ${queued.length - superseded.length}`)
  line()
  line(`  → Collapsing superseded same-target receipts bounds this class of`)
  line(`    growth by the size of the WORKING SET, not by time spent offline.`)
  line(`    Nothing a user typed is touched: a superseded read receipt is`)
  line(`    fully subsumed by the later one the same user authored.`)
}

// ───────────────────────────────────────────────────────────────────────────
// D. THE TOMBSTONE LEAK. reissue() never removes the record it cancels.
// ───────────────────────────────────────────────────────────────────────────
async function measureTombstones(): Promise<void> {
  rule('D. cancelled-record leak on every retry/edit (outbox.ts:972-977)')

  const { outbox, store } = await open(() => denied)
  await outbox.enqueue({
    command: cmd('sessions.rename'),
    input: { sessionId: 's-1', title: 'first' },
    attribution: ADA,
    partitionKey: CLIENT_PARTITION,
  })
  await outbox.drain()

  let live = outbox.deadLetters()[0]!.mutationId
  for (let i = 0; i < 25; i++) {
    const next = await outbox.edit(live, { input: { sessionId: 's-1', title: `edit ${i}` } })
    await outbox.drain()
    live = next.mutationId
  }

  const rows = store.durable()
  const cancelled = rows.filter((r) => r.state === 'cancelled')
  line(`  user edits of ONE failing write: 25`)
  line(`  rows in the durable store:       ${rows.length}`)
  line(`  of which state=cancelled:        ${cancelled.length}`)
  line(`  bytes held by tombstones:        ${new TextEncoder().encode(JSON.stringify(cancelled)).length} B`)
  line()
  line(`  → Every retry-with-new-id and every edit leaves a permanent`)
  line(`    'cancelled' row carrying the full input. Nothing ever removes it:`)
  line(`    purgeCancelled() has exactly one caller (kernel-outbox.ts:199-203,`)
  line(`    the user's discard button) and reissue() does not use it.`)
  line(`    This is pure garbage — the user's intent lives on under the new id.`)
}

async function main(): Promise<void> {
  line('POD-785 — client outbox growth measurement')
  line('driving packages/sync/src/outbox/outbox.ts directly')
  await measureWedge()
  await measureBytes()
  await measureCollapseYield()
  await measureTombstones()
  line()
}

await main()
