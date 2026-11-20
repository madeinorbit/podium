/**
 * A LARGE ISSUE ANSWER IS STORED AS A DIGEST AND REPLAYED WHOLE (POD-7035).
 *
 * On the operator's database one task's panel made every issue command's
 * receipt 237 KB, and each `mailInbox` stored the whole mailbox (344 KB). These
 * drive the real write entry point: the receipt holds the digest, the replay
 * runs nothing and answers what the first call answered.
 */

import type { IssueId } from '@podium/model'
import type { SqlDatabase } from '@podium/runtime/sqlite'
import { RECEIPT_RESULT_INLINE_MAX } from '@podium/sync'
import { afterEach, describe, expect, it } from 'vitest'
import { disposeOracles, makeOracle, type Oracle } from '../sessions/oracle-support'
import { appliedReply, envelope, submit } from '../sync-write/outbox-test-support'
import { isIssueReport, issueReceiptDigest } from './receipt-digest'

afterEach(() => disposeOracles())

async function issue(o: Oracle): Promise<IssueId> {
  if (!(await o.store.repos.listRepoPaths()).includes('/p')) {
    await o.store.repos.addRepo('/p', o.machineId)
  }
  return (await o.call.issues.create({ repoPath: '/p', title: 'digest', startNow: false })).id
}

/** One call through the write entry point, under `mutationId`; its answer. */
async function call(
  o: Oracle,
  command: string,
  input: unknown,
  mutationId: string,
): Promise<unknown> {
  return appliedReply(await submit(o, envelope(command, input, mutationId))).result
}

/** The stored receipt of the newest call of `proc`. */
function storedResult(o: Oracle, proc: string): string {
  const db = (o.store as unknown as { db: SqlDatabase }).db
  const row = db
    .prepare(
      'SELECT result FROM applied_mutations WHERE proc = ? ORDER BY applied_at DESC, rowid DESC LIMIT 1',
    )
    .get(proc) as { result: string } | undefined
  if (!row) throw new Error(`no receipt for ${proc}`)
  return row.result
}

describe('issue receipts (POD-7035)', () => {
  it('stores an issue report without its panel, and a replay answers the same report', async () => {
    const o = await makeOracle()
    const id = await issue(o)
    for (let i = 0; i < 3; i += 1) {
      await o.call.issues.panelApply({ id, op: 'todo-add', text: `${i} ${'x'.repeat(2_000)}` })
    }

    const first = await call(o, 'issues.setState', { id, text: 'first' }, 'm-state')
    expect(JSON.stringify(first).length).toBeGreaterThan(RECEIPT_RESULT_INLINE_MAX)
    const stored = storedResult(o, 'issues.setState')
    expect(stored.length).toBeLessThan(RECEIPT_RESULT_INLINE_MAX)
    expect(stored).not.toContain('x'.repeat(100))
    expect(JSON.parse(stored)).toMatchObject({ $receiptDigest: { report: { panelOf: id } } })

    const again = await call(o, 'issues.setState', { id, text: 'second' }, 'm-state')
    expect(again).toEqual(first)
    // The replay ran nothing: the state is still the first call's.
    expect((await o.call.issues.get({ id }))?.activityNotes).toBe('first')
  })

  it('replays the panel as it is now and every other field as first answered', async () => {
    const o = await makeOracle()
    const id = await issue(o)
    for (let i = 0; i < 3; i += 1) {
      await o.call.issues.panelApply({ id, op: 'todo-add', text: `${i} ${'x'.repeat(2_000)}` })
    }
    const first = (await call(o, 'issues.setState', { id, text: 'first' }, 'm-state')) as Record<
      string,
      unknown
    >
    await o.call.issues.setState({ id, text: 'later' })
    await o.call.issues.panelApply({ id, op: 'todo-add', text: 'added since' })

    const again = (await call(o, 'issues.setState', { id, text: 'x' }, 'm-state')) as {
      activityNotes?: string
      panel: unknown
    }
    expect(again.activityNotes).toBe('first')
    expect(JSON.stringify(again.panel)).toContain('added since')
    expect({ ...again, panel: undefined }).toEqual({ ...first, panel: undefined })
  })

  it('stores a mailbox as its newest time and unread ids, and replays it with the same unread marks', async () => {
    const o = await makeOracle()
    const id = await issue(o)
    for (let i = 0; i < 4; i += 1) {
      await o.call.issues.mailSend({ id, body: `${i} ${'m'.repeat(1_500)}` })
    }

    type Row = { id: string; body: string; wasUnread: boolean }
    const first = (await call(o, 'issues.mailInbox', { id }, 'm-inbox')) as Row[]
    expect(JSON.stringify(first).length).toBeGreaterThan(RECEIPT_RESULT_INLINE_MAX)
    const stored = storedResult(o, 'issues.mailInbox')
    expect(stored.length).toBeLessThan(1_000)
    expect(JSON.parse(stored)).toMatchObject({ $receiptDigest: { inbox: {} } })

    // Mail that arrives after the first read is not part of its answer.
    await o.call.issues.mailSend({ id, body: 'after the read' })
    const again = (await call(o, 'issues.mailInbox', { id }, 'm-inbox')) as Row[]
    expect(again.map((row) => ({ id: row.id, wasUnread: row.wasUnread }))).toEqual(
      first.map((row) => ({ id: row.id, wasUnread: row.wasUnread })),
    )
    expect(again.map((row) => row.body)).toEqual(first.map((row) => row.body))
  })
})

describe('what has a digest', () => {
  it('a report only on the fields a report has together', () => {
    const report = { id: 'iss_1', seq: 1, repoId: 'r', revision: 2, displayRef: 'P-1', panel: {} }
    expect(isIssueReport(report)).toBe(true)
    expect(isIssueReport({ ...report, panel: undefined, seq: '1' })).toBe(false)
    expect(isIssueReport({ id: 'iss_1', ok: true })).toBe(false)
    expect(issueReceiptDigest('setState', { ...report, ok: true })).toEqual({
      report: {
        panelOf: 'iss_1',
        rest: { id: 'iss_1', seq: 1, repoId: 'r', revision: 2, displayRef: 'P-1', ok: true },
      },
    })
    expect(issueReceiptDigest('setState', [report])).toBeUndefined()
    expect(issueReceiptDigest('mailInbox', [])).toBeUndefined()
  })
})
