/**
 * THE ISSUE COMMANDS' RECEIPT DIGESTS (POD-7035).
 *
 * A receipt in `applied_mutations` holds its command's answer for a replay. Two
 * kinds of issue answer made that table the largest on the operator's database:
 *
 *  - the ISSUE REPORT most commands answer with (`setState`, `panelApply`,
 *    `update`, `close`, …). It carries the task's panel, 235 KB on one task, so
 *    every state paragraph stored the whole panel again;
 *  - the MAILBOX `mailInbox` answers with: every message of the issue, 344 KB a
 *    read on a busy coordinator.
 *
 * Above `RECEIPT_RESULT_INLINE_MAX` the ledger stores the digest below instead,
 * and a replay rebuilds the answer from it without running the command again:
 *
 *  - a report: the answer without its panel, and the issue's id. Every other
 *    field (and any the command added beside the report's) replays exactly as
 *    first answered; the panel is read as it is now, for the same caller,
 *    through the same private-field rule the answer went through. The panel was
 *    235 KB of a 237 KB answer.
 *  - a mailbox: its issue, the newest message's time, and the ids the read
 *    showed as unread. The replay reads the mailbox without consuming anything,
 *    keeps the messages up to that time, and marks unread exactly the ones the
 *    first answer did, which a second consuming read could no longer tell.
 *
 * Any other large answer has no digest here and is stored whole, as before.
 */

import type { ReceiptCompaction } from '@podium/sync'
import type { IssueMessageRow } from '../../store'
import type { IssueCommandCtx } from './command-ctx'
import { readMailInbox } from './registry'

type InboxRow = IssueMessageRow & { wasUnread: boolean }

/** A stored digest. Tagged, so a replay cannot read one kind as the other. */
export type IssueReceiptDigest =
  | { readonly report: { readonly panelOf: string; readonly rest: Record<string, unknown> } }
  | { readonly inbox: { readonly through: string; readonly unread: readonly string[] } }

/**
 * Whether `value` is an issue report: the answer `reports.get` builds. Checked
 * on the fields only a report has together, so an answer that merely carries an
 * `id` is never mistaken for one and re-read as a task.
 */
export function isIssueReport(value: unknown): value is { id: string; panel: unknown } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  return (
    typeof row.id === 'string' &&
    typeof row.seq === 'number' &&
    typeof row.repoId === 'string' &&
    typeof row.revision === 'number' &&
    typeof row.displayRef === 'string' &&
    'panel' in row
  )
}

function isInboxRows(value: unknown): value is InboxRow[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (row) =>
        row !== null &&
        typeof row === 'object' &&
        typeof (row as InboxRow).id === 'string' &&
        typeof (row as InboxRow).createdAt === 'string' &&
        typeof (row as InboxRow).wasUnread === 'boolean',
    )
  )
}

/** The digest of one issue command's answer, or `undefined` to store it whole. */
export function issueReceiptDigest(
  command: string,
  value: unknown,
): IssueReceiptDigest | undefined {
  if (command === 'mailInbox') {
    if (!isInboxRows(value)) return undefined
    let through = value[0]!.createdAt
    for (const row of value) if (row.createdAt > through) through = row.createdAt
    return {
      inbox: { through, unread: value.filter((row) => row.wasUnread).map((row) => row.id) },
    }
  }
  if (!isIssueReport(value)) return undefined
  const { panel: _panel, ...rest } = value as Record<string, unknown>
  return { report: { panelOf: value.id, rest } }
}

export interface IssueReceiptReplay {
  /** A command context for the replaying caller: the original's. */
  context(): IssueCommandCtx
  /** The caller's private-field rule, as the command's answer applied it. */
  visible<T>(value: T): Promise<T>
}

/** Rebuild an answer from its digest. Writes nothing. */
export async function replayIssueReceipt(
  digest: unknown,
  input: unknown,
  replay: IssueReceiptReplay,
): Promise<unknown> {
  const stored = digest as Partial<Record<'report' | 'inbox', unknown>>
  if (stored?.report !== undefined && typeof stored.report === 'object') {
    const { panelOf, rest } = stored.report as { panelOf: string; rest: Record<string, unknown> }
    const ctx = replay.context()
    const report = await ctx.reports.get(panelOf, ctx.issueReader())
    // The task is gone since: the answer it gave, without a panel to show.
    if (report === null) return rest
    return await replay.visible({ ...rest, panel: report.panel })
  }
  if (stored?.inbox !== undefined && typeof stored.inbox === 'object') {
    const { through, unread } = stored.inbox as { through: string; unread: string[] }
    const ref = (input as { id?: string } | undefined)?.id
    const rows = await readMailInbox(replay.context(), ref, { consume: false })
    const wasUnread = new Set(unread)
    return rows
      .filter((row) => row.createdAt <= through)
      .map((row) => ({ ...row, wasUnread: wasUnread.has(row.id) }))
  }
  throw new Error('an issue receipt digest of no known kind')
}

/** The compaction one issue command's call stores its receipt with. */
export function issueReceiptCompaction(
  command: string,
  input: unknown,
  replay: IssueReceiptReplay,
): ReceiptCompaction {
  return {
    digest: (value) => issueReceiptDigest(command, value),
    replay: async (digest) => await replayIssueReceipt(digest, input, replay),
  }
}
