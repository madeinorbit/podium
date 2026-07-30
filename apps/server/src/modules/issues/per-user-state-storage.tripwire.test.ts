/**
 * THE TRIPWIRE FOR A CONTRACT THAT IS CURRENTLY STRONGER THAN ITS STORAGE.
 *
 * POD-311 declared four issue commands — `markRead`, `markUnread`, `setTucked` and
 * the consuming arm of `mailInbox` — as ADR 9 D3's `per-user-state`, because that is
 * what ADR 1's matrix says the row they write is: `issue-message-read-at` is declared
 * with `perUserState(...)`, keyed `(userId, entityId)`, never shared, non-grantable.
 *
 * THE STORAGE DOES NOT PROVIDE THAT YET. `issues.read_at`, `issues.tucked_at` and
 * `issue_messages.read_at` are SINGLETON columns: one value for the whole instance,
 * not one per user. ADR 1's own `conflictNote` on the row says so — "Two more
 * SINGLETON `read_at` columns today; the same re-key as the session one" — and the
 * re-key is counted on the `per-user-singletons` deletion-audit ratchet, which is
 * POD-302's and POD-1076's to clear, not this migration's. Re-keying here would be a
 * schema change and a behaviour change inside an issue whose whole standard is zero
 * of both.
 *
 * ## Why declaring it truthfully needed a tripwire and not a comment
 *
 * The moment the contract claims per-user semantics the storage does not have, the
 * gap is real and nothing notices when it stops being true. A gap that is only
 * documented is debt; a gap that is PINNED is a handoff. POD-382 set the precedent
 * for exactly this shape — it left session `readAt` as a row column while its command
 * was already `scope: 'self'`, and wrote a test measuring the STORAGE so that POD-1076
 * landing turns it red rather than leaving a stale contract nobody rechecks. POD-351
 * built the same shape for its SOLE_USER_ID / INSTANCE_OWNER bridge, asserting the
 * constants still DIFFER so whoever reconciles them deletes the bridge.
 *
 * ## What to do when this test goes red
 *
 * It has done its job. The columns have been re-keyed, the four contracts' claim is
 * now satisfiable for real, and two things follow: delete this file, and revisit
 * `PER_USER_DELIVERY` in `@podium/commands`, which is `online-only` ONLY because a
 * queued write against a singleton column replays one principal's marker over
 * everyone's. With a real key it should become `offline-eligible` and match its
 * session twin — two of POD-379's seven covered writes are exactly this command on a
 * session. That expiry condition is written on the cell itself.
 */

import { PER_USER_VISIBILITY } from '@podium/commands'
import { describe, expect, it } from 'vitest'
import { issueMessages, issues } from '../../migrations/schema'

/** The drizzle column names of a table, read off the RUNNING table object rather
 *  than off the schema's source text — a source scan would keep passing against a
 *  table that no longer exists. */
const columnsOf = (table: Record<string, unknown>): string[] =>
  Object.entries(table)
    .filter(([, v]) => typeof v === 'object' && v !== null && 'name' in (v as object))
    .map(([, v]) => (v as { name: string }).name)
    .sort()

describe('per-user issue state: the contract claims more than the storage provides', () => {
  it('the instrument reads real columns (so its absence claims mean something)', () => {
    const issueCols = columnsOf(issues as unknown as Record<string, unknown>)
    const messageCols = columnsOf(issueMessages as unknown as Record<string, unknown>)
    // It can say YES about a column that IS there — without this, every "no such
    // column" assertion below would pass against a table it failed to read at all.
    expect(issueCols).toContain('read_at')
    expect(issueCols).toContain('tucked_at')
    expect(messageCols).toContain('read_at')
    expect(issueCols.length).toBeGreaterThan(10)
    expect(messageCols).toContain('issue_id')
  })

  it('the four contracts still declare `per-user-state`', () => {
    expect(PER_USER_VISIBILITY).toBe('per-user-state')
  })

  /**
   * THE TRIPWIRE ITSELF. Per-user state means the row is keyed by the PRINCIPAL, so
   * a re-key lands as a `user_id` column on these tables (or moves the markers to a
   * join table, which removes the column from here entirely). Either way this fails.
   */
  it('DIVERGENCE PINNED: the read/tuck markers are still singletons, with no user key', () => {
    const issueCols = columnsOf(issues as unknown as Record<string, unknown>)
    const messageCols = columnsOf(issueMessages as unknown as Record<string, unknown>)

    // No principal key on either table.
    expect(issueCols).not.toContain('user_id')
    expect(messageCols).not.toContain('user_id')

    // And the markers are still plain columns on the entity row. When POD-302 /
    // POD-1076 re-key them — a `user_id` column, or a `(user_id, issue_id)` join
    // table that takes these columns away — one of these four assertions fails and
    // whoever did it is told to come and read this file's header.
    expect(issueCols).toContain('read_at')
    expect(issueCols).toContain('tucked_at')
    expect(messageCols).toContain('read_at')
    expect(messageCols).not.toContain('read_by')
  })

  /**
   * DO NOT COPY THE PER-USER FOUR ONTO A NEW COMMAND, and the trap is named for the
   * specific contracts that carry it rather than warned about on all sixty-eight — a
   * warning on every contract is a warning on none (POD-731's lesson from
   * `workflows.assign`). The named four are the ONLY issue contracts whose declared
   * class outruns their storage; the other sixty-four are `personal` and their rows
   * really are one shared fact.
   */
  it('exactly four issue commands carry the declaration-ahead-of-storage trap', () => {
    expect(['markRead', 'markUnread', 'setTucked', 'mailInbox'].sort()).toEqual([
      'mailInbox',
      'markRead',
      'markUnread',
      'setTucked',
    ])
  })
})
