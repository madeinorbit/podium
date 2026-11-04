/**
 * GENERIC SYNCED EDITS: THE DECLARATION (ADR 12 D3, POD-6391).
 *
 * Each synced record type that takes generic edits declares, ONCE:
 *
 *  - its fields, each with the ADR 1 matrix row it belongs to;
 *  - who may write each field (its ROLE, below);
 *  - its conflict rule (ADR 1: `exp-rev`, `single-writer` or `field-LWW`);
 *  - the fields the server fills in (labels, ADR 12 D4);
 *  - which of the three operations it offers, and the policy of each.
 *
 * From that one declaration come the three wire commands (`./contracts.ts`), the
 * server's field and conflict checks (`apps/server/src/modules/records`), and the
 * client's single edit API and overlay. There is no per-command display code and
 * no per-command handler for plain data.
 *
 * FIELD ROLES (ADR 12 D1's spec and status):
 *
 *  - `spec`: written by people and agents. The only role a patch may set.
 *  - `status`: observed by the server or the daemon (the Authority). Synced like
 *    any field, never written by a client; a client changes the outside world
 *    through an effect and the status follows.
 *  - `label`: filled in by the server inside the create, such as an issue's
 *    `seq` (the 6241 in POD-6241). Never identity, never client-written.
 *  - `key`: part of the record's identity or placement, set by a create and never
 *    edited (an issue's `repoPath`, the user and entity of a per-user row).
 *
 * A FIELD MAY CARRY ITS OWN CONFLICT RULE (POD-6403). The kind's rule is every
 * other field's. A plain field (an issue's title, its priority) is `field-LWW`:
 * the last writer wins per field, so an edit of one never conflicts with an edit
 * of another, and no revision is asked for. Only an edit that names an `exp-rev`
 * field must name the revision it was made against.
 *
 * AN EDIT MAY CLEAR a `spec` field whose wire cell is optional (`unset`), for
 * the cells where absent and `null` are two facts: a session's `snoozedUntil` is
 * `null` for "until the next message" and absent for no snooze at all.
 *
 * THE CONFLICT RULE IS STATED HERE AND HELD EQUAL TO THE MATRIX ON THE SERVER.
 * This package is not Authority-side, so it may not read `conflictRuleFor`
 * (`arbitration-direction.test.ts`). The declaration names the rule, every field
 * names its matrix row, and the server-side test holds each field's row rule
 * equal to the declared one. A client reading this file learns the rule's NAME
 * (to know whether it must send a revision), never an arbitration function.
 */

import type { MatrixRowId } from '@podium/model'
import type { MetadataEntityKind } from '@podium/protocol'
import type { z } from 'zod'
import type {
  AttributionPolicy,
  CommandPolicy,
  CreationOwnership,
  DeliveryPolicy,
  ErrorConsistency,
  RedactionPolicy,
  TransportTag,
  VisibilityClass,
} from '../contract'
import { type FreshRecord, freshProblems } from './fresh'

export type RecordFieldRole = 'spec' | 'status' | 'label' | 'key'

export interface RecordField<
  S extends z.ZodTypeAny = z.ZodTypeAny,
  R extends RecordFieldRole = RecordFieldRole,
> {
  /** Kept literal, so a client's patch type can be the kind's spec fields. */
  readonly role: R
  readonly schema: S
  /** The ADR 1 matrix row (field group) this field belongs to. */
  readonly row: MatrixRowId
  /** This field's ADR 1 rule, when it is not the kind's (POD-6403). */
  readonly conflict?: RecordConflict
  /** A create must carry it. Only `spec` and `key` fields can be required. */
  readonly required?: true
  /**
   * What a create that leaves this field out stores, in the field's own
   * spelling (an issue's `priority` is 2). The server's create applies it and
   * the creating device paints it, from this one value (`./fresh.ts`). Only a
   * `spec` or `key` field a create may leave out can have one.
   */
  readonly default?: z.input<S>
}

const field =
  <R extends RecordFieldRole>(role: R) =>
  <S extends z.ZodTypeAny>(
    schema: S,
    row: MatrixRowId,
    opts: { required?: true; default?: z.input<S>; conflict?: RecordConflict } = {},
  ): RecordField<S, R> => ({ role, schema, row, ...opts })

/** People and agents write it. */
export const spec = field('spec')
/** The server or daemon writes it; clients never do. */
export const status = field('status')
/** The server fills it in inside the create. */
export const label = field('label')
/** Set by a create, never edited. */
export const key = field('key')

/** The ADR 1 rules a generic edit can apply. `cmd`, `append` and `op-stream`
 *  rows have their own command rule and are not plain data. */
export type RecordConflict = 'exp-rev' | 'single-writer' | 'field-LWW'
export const RECORD_CONFLICTS: readonly RecordConflict[] = ['exp-rev', 'single-writer', 'field-LWW']

export type RecordOp = 'create' | 'edit' | 'remove'
export const RECORD_OPS: readonly RecordOp[] = ['create', 'edit', 'remove']

/** One operation the kind offers, with the ADR 3 cells that differ per op. */
export interface RecordOpPolicy {
  readonly policy: CommandPolicy
  readonly note: string
}

export interface SyncedKindDeclaration<
  K extends MetadataEntityKind = MetadataEntityKind,
  F extends Record<string, RecordField> = Record<string, RecordField>,
> {
  /** The feed's entity kind. */
  readonly kind: K
  /** What a person calls one ("issue"), for messages. */
  readonly title: string
  /** The feed's value schema for this kind; every declared field is one of its keys. */
  readonly wire: z.ZodObject<z.ZodRawShape>
  /** An existing record's id, as the feed names it (an edit's or a remove's ref). */
  readonly ref: z.ZodTypeAny
  /** A NEW id, minted on the device (ADR 12 D4). Required iff the kind offers create. */
  readonly newId?: z.ZodTypeAny
  readonly conflict: RecordConflict
  /**
   * The kind's SPEC REVISION field, when it has one (POD-6399): a `status` field
   * that every accepted edit moves by exactly one, so a client paints an edit
   * made against revision r as revision r + 1 until it is confirmed, and reads
   * "the server has not answered this yet" as revision ahead of its observed one.
   */
  readonly revisionField?: string
  readonly fields: F
  /**
   * What a create needs to PLACE the record that is not a field of it, such as
   * the repo path an issue is filed in (the record carries the server-resolved
   * `repoId`). Required at create; never edited, never on the wire.
   */
  readonly placement?: Readonly<Record<string, z.ZodTypeAny>>
  /** The operations this kind offers. An absent op is not served. */
  readonly ops: Partial<Record<RecordOp, RecordOpPolicy>>
  readonly visibility: VisibilityClass
  readonly exposure: readonly TransportTag[]
  readonly delivery: DeliveryPolicy
  readonly redaction: RedactionPolicy
  readonly attribution: AttributionPolicy
  readonly errorConsistency: ErrorConsistency
  /** What a create mints and who owns it. Required iff the kind offers create. */
  readonly creates?: CreationOwnership
  /**
   * What a NEW record looks like before the server has answered: every wire
   * cell a create does not carry, either a constant the server stores
   * (`cells`) or a cell the server assigns that the device paints as pending
   * (`pending`). Required iff the kind offers create; with it, a create paints
   * a whole row at once (`./fresh.ts`).
   */
  readonly fresh?: FreshRecord
}

/** Declare a kind, checked where it is written: a declaration that could never
 *  serve a command fails at import, not at the first edit. */
export function defineSyncedKind<
  const K extends MetadataEntityKind,
  const F extends Record<string, RecordField>,
>(declaration: SyncedKindDeclaration<K, F>): SyncedKindDeclaration<K, F> {
  const problems = declarationProblems(declaration)
  if (problems.length > 0) {
    throw new Error(`synced kind ${declaration.kind}: ${problems.join('; ')}`)
  }
  return declaration
}

export function declarationProblems(d: SyncedKindDeclaration): string[] {
  const out: string[] = []
  const wireKeys = new Set(Object.keys(d.wire.shape))
  for (const [name, f] of Object.entries(d.fields)) {
    if (!wireKeys.has(name)) out.push(`field ${name} is not on the ${d.kind} wire schema`)
    if (f.conflict !== undefined && !RECORD_CONFLICTS.includes(f.conflict)) {
      out.push(`field ${name}'s conflict ${f.conflict} is not a rule generic edits apply`)
    }
    if (f.required && f.role !== 'spec' && f.role !== 'key') {
      out.push(`field ${name} is required but a ${f.role} field is never client-written`)
    }
    if ('default' in f) {
      if (f.role !== 'spec' && f.role !== 'key') {
        out.push(`field ${name} has a default but a ${f.role} field is the server's`)
      } else if (f.required) {
        out.push(`field ${name} is required and has a default`)
      } else if (!f.schema.safeParse(f.default).success) {
        out.push(`field ${name}'s default does not parse as the field`)
      }
    }
  }
  for (const name of Object.keys(d.placement ?? {})) {
    if (name in d.fields) out.push(`placement ${name} is also a field`)
    if (d.ops.create === undefined) out.push(`placement ${name} without a create`)
  }
  if (d.revisionField !== undefined && d.fields[d.revisionField]?.role !== 'status') {
    out.push(`revisionField ${d.revisionField} is not a status field`)
  }
  if (!RECORD_CONFLICTS.includes(d.conflict)) {
    out.push(`conflict ${d.conflict} is not a rule generic edits apply`)
  }
  if (d.ops.create !== undefined) {
    if (d.newId === undefined) out.push('offers create without a device id shape (ADR 12 D4)')
    if (d.creates === undefined || d.creates.creates.length === 0) {
      out.push('offers create without declaring what it creates')
    }
    out.push(...freshProblems(d))
  } else if (d.fresh !== undefined) {
    out.push('declares a fresh record without a create')
  }
  if (d.ops.edit !== undefined && specFields(d).length === 0) {
    out.push('offers edit with no spec field to edit')
  }
  if (Object.keys(d.ops).length === 0) out.push('offers no operation')
  return out
}

/** The fields a patch may set. */
export const specFields = (d: SyncedKindDeclaration): string[] =>
  Object.entries(d.fields)
    .filter(([, f]) => f.role === 'spec')
    .map(([name]) => name)

/** One field's ADR 1 rule: its own, else the kind's (POD-6403). */
export const fieldConflict = (d: SyncedKindDeclaration, name: string): RecordConflict =>
  d.fields[name]?.conflict ?? d.conflict

/** Whether an edit naming these fields (set or cleared) must name the revision
 *  it was made against: iff one of them is `exp-rev`. */
export const editNeedsRevision = (d: SyncedKindDeclaration, names: Iterable<string>): boolean => {
  for (const name of names) if (fieldConflict(d, name) === 'exp-rev') return true
  return false
}

/** The fields an edit may clear: spec fields whose wire cell may be absent. */
export const unsettableFields = (d: SyncedKindDeclaration): string[] =>
  specFields(d).filter((name) => d.wire.shape[name]?.isOptional() === true)

/** The fields a create may carry: spec and key. Labels are the server's. */
export const createFields = (d: SyncedKindDeclaration): string[] =>
  Object.entries(d.fields)
    .filter(([, f]) => f.role === 'spec' || f.role === 'key')
    .map(([name]) => name)

/** The wire name of one operation on one kind. */
export const recordCommandName = (kind: MetadataEntityKind, op: RecordOp): string =>
  `records.${kind}.${op}`
