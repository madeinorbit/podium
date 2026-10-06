/**
 * POD-4548 (L1c) — the reference pending log of the round-three write contract
 * (rules W4–W10, `docs/plans/pod-4545-round-three-write-contract.md`): each
 * edit is recorded with the values it replaced (`prior`), and a rejection
 * rewinds to them.
 *
 * POD-5432 moved it here from `@podium/client-graph/shared/write-contract`:
 * the product pool rolls back by rebase and stores no prior value
 * (`write/transactions.ts`). The hand-rolled arm, the write oracle and
 * `write-contract.test.ts` still run this log, so it lives with them.
 */

import {
  type Coverage,
  type EditPatch,
  FIELD_COVERAGE,
  type FieldValues,
  type Receipt,
  type Rejection,
  type Superseded,
  type TxId,
  type WritableKind,
  WriteContractError,
  wallClockNow,
} from '@podium/client-graph/shared/write-contract'

/** One optimistic transaction (W1). Immutable once appended. */
export interface Edit<K extends WritableKind = WritableKind> {
  readonly txId: TxId
  readonly kind: K
  readonly id: string
  readonly patch: EditPatch<K>
  /**
   * Per patched field, the value the OBJECT showed at edit time — which may be
   * an older pending value, not server truth. Required for every patched key;
   * `append` throws otherwise. The rewind target is derived from it and
   * refreshed by later server values (W5).
   */
  readonly prior: FieldValues<K>
  /**
   * The arm's row identity before the edit (its immutable row object, or its
   * row view), handed back when a rewind restores exactly the pre-edit state
   * so a commit-counting harness sees the original object again (W6). Opaque
   * to the log. Omit it when the arm's row identity does not change on edit.
   */
  readonly priorIdentity?: unknown
}

/** What the arm must do after one log operation. */
export interface LogOutcome<K extends WritableKind = WritableKind> {
  readonly kind: K
  readonly id: string
  /**
   * Editable fields whose DISPLAYED value is now this. Write exactly these onto
   * the object in one action. May repeat the current value (a remote pass-through
   * the log cannot compare); an arm that counts commits skips equal writes.
   * Empty means nothing to write.
   */
  readonly changes: FieldValues<K>
  /** Transactions that left the log in this call, in log order. */
  readonly left: readonly TxId[]
  /**
   * Set when this call emptied the row's log and no server row landed on it
   * since its first pending edit, so every editable field is back to what it
   * was before that edit (W6): this is that edit's `priorIdentity`. The arm
   * reinstates it instead of building a new row.
   */
  readonly restoreIdentity?: unknown
}

/**
 * The pending transaction log (W4–W10). In memory only: durability is the
 * kernel outbox's job, and bootstrap rebuilds this log from it (W11).
 *
 * The DISPLAY RULE every method preserves: the object shows, per field, the
 * value of the NEWEST pending edit on that field, else the last server value.
 */
export interface PendingLog {
  /** Record an edit already applied to the object (W1). Throws on a reused
   *  txId, a patched field with no `prior`, or an empty patch. `base` overrides
   *  the server value a `stamp` field is judged against — used on bootstrap,
   *  where the kernel kept the enqueue-time value (W11). */
  append<K extends WritableKind>(edit: Edit<K>, opts?: { base?: FieldValues<K> }): void
  /** The Authority applied it (W7). Unknown or already-settled txId → null. */
  settle(receipt: Receipt): LogOutcome | null
  /** Rewind (W5). Unknown txId (never seen, already settled, already rejected) → null. */
  reject(rejection: Rejection): LogOutcome | null
  /** Collapsed away by the outbox (W9). Unknown txId → null. */
  supersede(superseded: Superseded): LogOutcome | null
  /**
   * A server row arrived for (kind, id): `values` are its editable fields.
   * Non-pending fields pass through into `changes`; pending fields keep the
   * local value and update the rewind target (W8). Also where echoes are seen.
   */
  remote<K extends WritableKind>(kind: K, id: string, values: FieldValues<K>): LogOutcome<K>
  /** Receipted edits whose echo never arrived within the TTL leave the log and
   *  the object takes the server value (W10). */
  expire(): LogOutcome[]
  /** Pending edits for one object, oldest first. */
  pendingFor<K extends WritableKind>(kind: K, id: string): readonly Edit<K>[]
  /** Pending edits in the whole log. */
  readonly size: number
}

/** What an arm exposes for writing. */
export interface WriteApi {
  /** The ONE write method (W1). Synchronous: the paint has happened when it
   *  returns; the outcome arrives later through the log. Throws
   *  {@link WriteContractError} before any state change when the patch is not
   *  one slice command, or the object is not resident. */
  edit<K extends WritableKind>(kind: K, id: string, patch: EditPatch<K>): TxId
  /** Surfaces each rejection AFTER its rewind has been applied (W5). The
   *  user-facing toast and the dead-letter recovery stay the kernel's. */
  onRejected(
    listener: (rejection: Rejection & { readonly kind: WritableKind; readonly id: string }) => void,
  ): () => void
}

/** Same value, same reason as the kernel's `AWAITING_TRUTH_TTL_MS` (overlay.ts):
 *  bounding a lost echo beats masking another writer forever. Pinned equal in
 *  the test. */
export const ECHO_TTL_MS = 60_000

type Value = string | null

interface Slot {
  readonly field: string
  readonly value: Value
  readonly coverage: Coverage
  /** Server value at append (or the kernel's enqueue-time value on bootstrap). */
  readonly appendBase: Value
  /** Server value when the receipt arrived; a later equal value is stale. */
  ackBase: Value | undefined
  confirmed: boolean
  overtaken: boolean
}

interface Entry {
  readonly edit: Edit
  readonly slots: Map<string, Slot>
  ackedAt: number | undefined
}

interface Row {
  readonly kind: WritableKind
  readonly id: string
  /** Oldest first. */
  entries: Entry[]
  /** Last server value per field that has a pending edit (the rewind target). */
  readonly server: Map<string, Value>
  /** Server rows seen since this row's log opened (its first pending edit). */
  remoteCount: number
  /** `priorIdentity` of the edit that opened the row's log (W6). */
  readonly openIdentity: unknown
}

const EMPTY: readonly Edit[] = Object.freeze([])

function covers(slot: Slot, v: Value): boolean {
  return slot.coverage === 'exact' ? Object.is(v, slot.value) : v !== null && v !== slot.appendBase
}

export function createPendingLog(opts: { now?: () => number; ttlMs?: number } = {}): PendingLog {
  const now = opts.now ?? wallClockNow
  const ttlMs = opts.ttlMs ?? ECHO_TTL_MS
  const rows = new Map<string, Row>()
  const byTx = new Map<string, { row: Row; entry: Entry }>()
  const keyOf = (kind: string, id: string): string => `${kind}\u0000${id}`

  const onField = (row: Row, field: string): Entry[] =>
    row.entries.filter((e) => e.slots.has(field))

  /** W4: newest pending value on the field, else the last server value. */
  const display = (row: Row, field: string): Value => {
    for (let i = row.entries.length - 1; i >= 0; i--) {
      const slot = row.entries[i]!.slots.get(field)
      if (slot) return slot.value
    }
    return row.server.get(field) ?? null
  }

  /** Remove entries, report display changes, drop tracking that ended. */
  const removeEntries = (
    row: Row,
    gone: readonly Entry[],
    changes: Record<string, Value>,
  ): TxId[] => {
    if (gone.length === 0) return []
    const fields = new Set<string>()
    for (const e of gone) for (const f of e.slots.keys()) fields.add(f)
    const before = new Map([...fields].map((f) => [f, display(row, f)] as const))
    const goneSet = new Set(gone)
    row.entries = row.entries.filter((e) => !goneSet.has(e))
    for (const e of gone) byTx.delete(e.edit.txId)
    for (const f of fields) {
      const after = display(row, f)
      if (!Object.is(after, before.get(f))) changes[f] = after
      if (onField(row, f).length === 0) row.server.delete(f)
    }
    return gone.map((e) => e.edit.txId)
  }

  const resolved = (e: Entry): boolean =>
    [...e.slots.values()].every((s) => s.confirmed || s.overtaken)

  const finish = (row: Row, gone: readonly Entry[], changes: Record<string, Value>): LogOutcome => {
    // W6: identity comes back only when the row's log empties and no server
    // row touched it since the log opened. Then every editable field shows the
    // first edit's prior again, so the object is the one before that edit.
    const left = removeEntries(row, gone, changes)
    let restoreIdentity: unknown
    if (row.entries.length === 0) {
      rows.delete(keyOf(row.kind, row.id))
      if (left.length > 0 && row.remoteCount === 0) restoreIdentity = row.openIdentity
    }
    return {
      kind: row.kind,
      id: row.id,
      changes: changes as FieldValues<WritableKind>,
      left,
      ...(restoreIdentity !== undefined ? { restoreIdentity } : {}),
    }
  }

  const drop = (txId: TxId): LogOutcome | null => {
    const hit = byTx.get(txId)
    if (!hit) return null
    return finish(hit.row, [hit.entry], {})
  }

  return {
    append(edit, appendOpts) {
      if (byTx.has(edit.txId)) throw new WriteContractError(`txId ${edit.txId} already in the log`)
      if (!(edit.kind in FIELD_COVERAGE))
        throw new WriteContractError(`no editable fields on ${String(edit.kind)}`)
      const patch = edit.patch as Record<string, Value | undefined>
      const prior = edit.prior as Record<string, Value | undefined>
      const fields = Object.keys(patch).filter((f) => patch[f] !== undefined)
      if (fields.length === 0) throw new WriteContractError('empty patch')
      const key = keyOf(edit.kind, edit.id)
      const row: Row = rows.get(key) ?? {
        kind: edit.kind,
        id: edit.id,
        entries: [],
        server: new Map(),
        remoteCount: 0,
        openIdentity: edit.priorIdentity,
      }
      const coverage = FIELD_COVERAGE[edit.kind] as Record<string, Coverage | undefined>
      const base = (appendOpts?.base ?? {}) as Record<string, Value | undefined>
      const slots = new Map<string, Slot>()
      for (const f of fields) {
        const c = coverage[f]
        if (c === undefined) throw new WriteContractError(`field ${f} is not editable`)
        if (!(f in prior) || prior[f] === undefined)
          throw new WriteContractError(`edit ${edit.txId} has no prior for ${f}`)
        // Nothing pending on f means the object shows server truth, so the
        // prior IS the server value (W4). Otherwise the server value is tracked.
        if (!row.server.has(f)) row.server.set(f, prior[f]!)
        slots.set(f, {
          field: f,
          value: patch[f]!,
          coverage: c,
          appendBase: base[f] !== undefined ? base[f]! : row.server.get(f)!,
          ackBase: undefined,
          confirmed: false,
          overtaken: false,
        })
      }
      const entry: Entry = { edit, slots, ackedAt: undefined }
      row.entries.push(entry)
      rows.set(key, row)
      byTx.set(edit.txId, { row, entry })
    },

    settle({ txId }) {
      const hit = byTx.get(txId)
      if (!hit || hit.entry.ackedAt !== undefined) return null
      const { row, entry } = hit
      entry.ackedAt = now()
      for (const slot of entry.slots.values()) slot.ackBase = row.server.get(slot.field) ?? null
      return finish(row, resolved(entry) ? [entry] : [], {})
    },

    reject({ txId }) {
      return drop(txId)
    },

    supersede({ txId }) {
      return drop(txId)
    },

    remote(kind, id, values) {
      const vals = values as Record<string, Value | undefined>
      const row = rows.get(keyOf(kind, id))
      const changes: Record<string, Value> = {}
      if (!row) {
        for (const [f, v] of Object.entries(vals)) if (v !== undefined) changes[f] = v
        return { kind, id, changes: changes as FieldValues<typeof kind>, left: [] }
      }
      row.remoteCount++
      for (const [f, v] of Object.entries(vals)) {
        if (v === undefined) continue
        const stack = onField(row, f)
        if (stack.length === 0) {
          changes[f] = v // W8: a non-pending field takes the remote value
          continue
        }
        row.server.set(f, v) // W5: the rewind target follows server truth
        // W7: the oldest unconfirmed edit this value echoes is confirmed, and
        // so is everything older on the field (one partition, FIFO).
        const hit = stack.findIndex((e) => !e.slots.get(f)!.confirmed && covers(e.slots.get(f)!, v))
        if (hit >= 0) {
          for (let i = 0; i <= hit; i++) stack[i]!.slots.get(f)!.confirmed = true
          continue
        }
        // W8: after its receipt, a value that is neither this edit's echo nor
        // the value seen at receipt is a later write: server wins the field.
        for (const e of stack) {
          const slot = e.slots.get(f)!
          if (e.ackedAt !== undefined && !slot.confirmed && !Object.is(v, slot.ackBase))
            slot.overtaken = true
        }
      }
      const gone = row.entries.filter((e) => e.ackedAt !== undefined && resolved(e))
      return finish(row, gone, changes) as LogOutcome<typeof kind>
    },

    expire() {
      const t = now()
      const out: LogOutcome[] = []
      for (const row of [...rows.values()]) {
        const gone = row.entries.filter((e) => e.ackedAt !== undefined && t - e.ackedAt >= ttlMs)
        if (gone.length > 0) out.push(finish(row, gone, {}))
      }
      return out
    },

    pendingFor(kind, id) {
      const row = rows.get(keyOf(kind, id))
      return row
        ? (row.entries.map((e) => e.edit) as Edit<typeof kind>[])
        : (EMPTY as readonly Edit<typeof kind>[])
    },

    get size() {
      return byTx.size
    },
  }
}
