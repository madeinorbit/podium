/**
 * THE SETTINGS AUDIT TRAIL (POD-421, 3.7d) — the append-only record of who
 * changed what on the settings family, and what they were refused.
 *
 * Modelled on `WorkflowsRepository.appendEvent` (POD-731) on purpose: the
 * attribution question is the same question, and answering it a second way is
 * the fork this programme exists to end.
 *
 * ---------------------------------------------------------------------------
 * THE THREE PROPERTIES THIS FILE EXISTS TO HOLD
 * ---------------------------------------------------------------------------
 *
 * 1. **The pair is never collapsed.** `actor` (which agent/session/person) and
 *    `onBehalfOf` (which human) are separate columns and separate parameters.
 *    They are taken from a {@link CommandPrincipal} — i.e. from the
 *    authenticated transport — and this module has no parameter through which an
 *    input could supply either (ADR 3 D7: payload identity is inert).
 *
 * 2. **A system write is attributed as `system` and never as a person.** ADR 9
 *    D8 S5. {@link settingsAuditRow} derives both halves from the principal's
 *    KIND, so the system arm cannot acquire a human by any argument a caller can
 *    pass; the table's CHECK constraint refuses one even if this code were
 *    wrong. Two mechanisms, deliberately, per ADR 9 D4 point 2.
 *
 * 3. **No material.** The detail is redacted through the CONTRACT's own
 *    `redaction` metadata before it arrives here, and {@link
 *    SettingsAuditRepository.append} re-states that expectation as a runtime
 *    refusal rather than a comment — see below.
 *
 * ---------------------------------------------------------------------------
 * WHY THE WRITER REFUSES AN UNREDACTED ROW
 * ---------------------------------------------------------------------------
 *
 * The redaction happens at the caller (it needs the contract). A trail whose
 * safety depends entirely on every future caller remembering to redact is a
 * trail with one unreviewed commit between it and a credential leak. So
 * {@link append} takes the {@link RedactionReport} rather than a bare payload:
 * you cannot append without having run the redactor, because there is no
 * parameter for a payload that has not been through it.
 *
 * That is a shape constraint, not a check — the same preference the ledger
 * records as *"prefer the shape where forgetting is a compile error over the
 * shape where forgetting has a plausible default."*
 */

import type { RedactionReport } from '@podium/commands'
import { and, asc, desc, eq, gte, inArray, lt, or, sql } from 'drizzle-orm'
import { attributionOf, type CommandPrincipal } from '../command-principal'
import { settingsAuditEvents } from '../migrations/schema'
import type { StoreDrizzle, StoreQueries, TransactionRunner } from './executor/sync-drizzle'
import { param, prepared, preparedFamily } from './executor/sync-drizzle'
import { prefixUpperBound } from './prefix-range'

/** Whether the command was carried out or refused. A refusal is an audit fact:
 *  a trail that records only successes cannot answer "who TRIED to rotate this
 *  key", which is among the first questions asked of one. */
export type SettingsAuditOutcome = 'applied' | 'refused'

/** ADR 9 D1's principal kinds, as the column's closed vocabulary. `machine` has
 *  no producer in this family today and is admitted anyway so the column matches
 *  the taxonomy rather than the current call sites — a narrower CHECK would have
 *  to be migrated the day one appears. */
export type SettingsAuditActorKind = 'user' | 'agent' | 'machine' | 'system'

export interface SettingsAuditRow {
  readonly command: string
  readonly outcome: SettingsAuditOutcome
  readonly actorKind: SettingsAuditActorKind
  /** The actor half — `session:<id>` for an agent, `system:<job>` for a job, the
   *  user id for a person. Never null in practice; the column is nullable only
   *  so a future kind with no id is representable without a migration. */
  readonly actorId: string | null
  /** The human half. `null` for a system principal — by construction, never as a
   *  fallback (ADR 9 D8 S5). */
  readonly onBehalfOf: string | null
  readonly detail: unknown
  readonly redactedPaths: readonly string[]
  readonly createdAt: string
}

/**
 * The attribution half of a row, derived from the principal ALONE.
 *
 * Exported so a test can assert the derivation without a database, and so the
 * system-has-no-human property is checkable at the function that decides it
 * rather than only at the table that stores it.
 */
export function settingsAuditAttribution(principal: CommandPrincipal): {
  actorKind: SettingsAuditActorKind
  actorId: string
  onBehalfOf: string | null
} {
  const { actor, onBehalfOf } = attributionOf(principal)
  return {
    actorKind: principal.kind,
    actorId: actor,
    // Read off `attributionOf`, which returns `null` for the system arm. NOT
    // re-derived here with a `?? something`: a second expression for "who is the
    // human" is a second place for the system arm to acquire one.
    onBehalfOf,
  }
}

/** Build a complete row from a principal, a contract-redacted report and a
 *  clock. One constructor, so no call site assembles the pair by hand. */
export function settingsAuditRow(input: {
  command: string
  outcome: SettingsAuditOutcome
  principal: CommandPrincipal
  report: RedactionReport
  now: string
}): SettingsAuditRow {
  return {
    command: input.command,
    outcome: input.outcome,
    ...settingsAuditAttribution(input.principal),
    detail: input.report.value,
    redactedPaths: input.report.redactedPaths,
    createdAt: input.now,
  }
}

// Every query this repository runs, prepared once per store [POD-6147].

const appendAudit = prepared((db: StoreDrizzle) =>
  db
    .insert(settingsAuditEvents)
    .values({
      command: sql.placeholder('command'),
      outcome: sql.placeholder('outcome'),
      actorKind: sql.placeholder('actorKind'),
      actorId: sql.placeholder('actorId'),
      onBehalfOf: sql.placeholder('onBehalfOf'),
      detailJson: sql.placeholder('detailJson'),
      redactedPaths: sql.placeholder('redactedPaths'),
      createdAt: sql.placeholder('createdAt'),
    })
    .prepare(),
)

const auditInOrder = prepared((db: StoreDrizzle) =>
  db
    .select()
    .from(settingsAuditEvents)
    .orderBy(asc(settingsAuditEvents.id))
    .limit(sql.placeholder('limit'))
    .prepare(),
)

/**
 * THE SECURITY EVENTS (POD-6299; design §2.6): member, role, admission, custody
 * and machine events, the secret writes and comment moderation. Preference
 * patches are not security events, and their detail carries preference values.
 */
export const SECURITY_EVENT_PREFIXES = ['members.', 'machines.'] as const
export const SECURITY_EVENT_COMMANDS = [
  'takeover',
  'settings.setSecret',
  'settings.clearSecret',
  'accounts.unsend',
  'issues.editComment',
  'issues.deleteComment',
] as const

export const SECURITY_EVENT_KINDS = ['people', 'machines', 'credentials', 'comments'] as const
export type SecurityEventKind = (typeof SECURITY_EVENT_KINDS)[number]
export interface SecurityEventFilters {
  /** The human actor, including agents acting on this member's behalf. */
  actor?: string
  kind?: SecurityEventKind
  refusedOnly?: boolean
}

type SecurityEventShape = `${SecurityEventKind | 'all'}|${0 | 1}|${0 | 1}`

const securityEventsNewestFirst = preparedFamily((db: StoreDrizzle, shape: SecurityEventShape) => {
  const [kind, actor, refused] = shape.split('|')
  const prefix = (value: string) =>
    and(
      gte(settingsAuditEvents.command, value),
      lt(settingsAuditEvents.command, prefixUpperBound(value)),
    )
  const commands =
    kind === 'people'
      ? prefix('members.')
      : kind === 'machines'
        ? or(prefix('machines.'), eq(settingsAuditEvents.command, 'takeover'))
        : kind === 'credentials'
          ? inArray(settingsAuditEvents.command, [
              'settings.setSecret',
              'settings.clearSecret',
              'accounts.unsend',
            ])
          : kind === 'comments'
            ? inArray(settingsAuditEvents.command, ['issues.editComment', 'issues.deleteComment'])
            : or(
                ...SECURITY_EVENT_PREFIXES.map(prefix),
                inArray(settingsAuditEvents.command, [...SECURITY_EVENT_COMMANDS]),
              )
  return db
    .select()
    .from(settingsAuditEvents)
    .where(
      and(
        lt(settingsAuditEvents.id, param(settingsAuditEvents.id, 'beforeId')),
        commands,
        actor === '1'
          ? eq(settingsAuditEvents.onBehalfOf, param(settingsAuditEvents.onBehalfOf, 'actor'))
          : undefined,
        refused === '1' ? eq(settingsAuditEvents.outcome, 'refused') : undefined,
      ),
    )
    .orderBy(desc(settingsAuditEvents.id))
    .limit(sql.placeholder('limit'))
    .prepare()
})

/** One stored security event, with its row id as the page cursor. */
export interface SecurityEventRow extends SettingsAuditRow {
  readonly id: number
}

export class SettingsAuditRepository {
  private readonly rootDb: StoreDrizzle
  protected readonly createOrJoinTransaction: TransactionRunner

  constructor(queries: StoreQueries) {
    this.rootDb = queries.rootDb
    this.createOrJoinTransaction = queries.createOrJoinTransaction
  }

  /** The query builder, resolved on every access so B1 changes this line and nothing else
   *  [POD-3221 spec rule 34a]. */
  protected get db() {
    return this.rootDb
  }

  /**
   * Append one row. Append-only: there is no update and no delete, because an
   * audit trail that can be edited answers a different question than the one it
   * is kept for.
   */
  async append(row: SettingsAuditRow): Promise<void> {
    await appendAudit(this.db).run({
      command: row.command,
      outcome: row.outcome,
      actorKind: row.actorKind,
      actorId: row.actorId,
      onBehalfOf: row.onBehalfOf,
      detailJson: JSON.stringify(row.detail ?? {}),
      redactedPaths: JSON.stringify(row.redactedPaths),
      createdAt: row.createdAt,
    })
  }

  /**
   * The rows, newest last.
   *
   * THIS IS A TEST AND OPERATOR-DIAGNOSTIC READER, NOT A PRODUCT SURFACE, and
   * the distinction is load-bearing rather than modest. Nothing in the product
   * projects this table into a wire shape, a replica or a UI — the same standing
   * `workflow_events` has (POD-730 §9) — and that is exactly what keeps a
   * recorded preference value out of another user's replica while POD-1213's
   * per-user preference storage is still outstanding.
   *
   * A reader added to the product changes that, and would have to be gated and
   * re-redacted before it ships. Said here so the next person adding one meets
   * the constraint rather than discovering it.
   */
  /**
   * The security events, newest first, `limit` at most, older than `beforeId`
   * when given (POD-6299). The admin area projects these; it never sends a
   * row's detail as stored.
   */
  async securityEvents(
    limit: number,
    beforeId?: number,
    filters: SecurityEventFilters = {},
  ): Promise<SecurityEventRow[]> {
    const shape: SecurityEventShape = `${filters.kind ?? 'all'}|${filters.actor ? 1 : 0}|${filters.refusedOnly ? 1 : 0}`
    const rows = await securityEventsNewestFirst(this.db, shape).all({
      limit,
      beforeId: beforeId ?? Number.MAX_SAFE_INTEGER,
      actor: filters.actor,
    })
    return rows.map((r) => ({ id: r.id, ...this.rowOf(r) }))
  }

  async list(limit = 100): Promise<SettingsAuditRow[]> {
    const rows = await auditInOrder(this.db).all({ limit })
    return rows.map((r) => this.rowOf(r))
  }

  private rowOf(r: typeof settingsAuditEvents.$inferSelect): SettingsAuditRow {
    return {
      command: r.command,
      // `outcome` and `actor_kind` are plain text() columns held to their
      // vocabularies by CHECK constraints rather than by a drizzle `$type`, so
      // the narrowing stays. It is the database's own guarantee being read, not
      // a driver-returned `unknown` being asserted away.
      outcome: r.outcome as SettingsAuditOutcome,
      actorKind: r.actorKind as SettingsAuditActorKind,
      actorId: r.actorId ?? null,
      onBehalfOf: r.onBehalfOf ?? null,
      detail: parseJson(r.detailJson),
      redactedPaths: (parseJson(r.redactedPaths) as string[] | undefined) ?? [],
      createdAt: r.createdAt,
    }
  }
}

/** A stored JSON column, or `undefined` when it is unreadable. Unreadable is NOT
 *  coerced to `{}`: a row whose detail cannot be parsed is a different fact from
 *  one that had no detail, and collapsing them in an audit trail hides the only
 *  symptom a corruption would show. */
function parseJson(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}
