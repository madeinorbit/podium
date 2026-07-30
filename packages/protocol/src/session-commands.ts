/**
 * PRESENCE-CLASS SESSION COMMAND CONTRACTS (POD-380, under POD-312).
 *
 * The pure-state session writes — rename · setArchived · markRead / markUnread ·
 * setWorkState · setIssueId · snoozes.set / snoozes.clear · pins.set ·
 * tabs.setOrder · drafts.set — as CONTRACTS: name, input schema, and the four
 * ADR 3 facets (policy · exposure · offline · redaction) plus the ADR 1 conflict
 * class. No handler code and no service imports: contracts are L1, handlers are
 * L3, and the join is the composition root's (POD-311 finding 1).
 *
 * ## The inventory is split by VISIBILITY CLASS, not by router
 *
 * docs/multi-user-readiness.md §3.1.1 and §3.3 cut this inventory in two, and the
 * cut does not follow today's tRPC routers:
 *
 *   PER-USER STATE (`policy.scope: 'self'`, keyed `(userId, entityId)`, NEVER
 *   shared, non-grantable): markRead · markUnread · snoozes.set · snoozes.clear ·
 *   pins.set · tabs.setOrder. Each principal writes its OWN row; the conflict
 *   class collapses to `single-writer` and ADR 1 D3's field-LWW carve-out shrinks.
 *
 *   SHARED SESSION STATE owned by the session's owner and governed by grants
 *   (`policy.scope: 'owner-or-grant'`, personal class — private to owner,
 *   shareable): rename · setArchived · setWorkState · setIssueId.
 *
 *   COMPOSER DRAFT — the deliberate exception §3.3 names. See {@link sessionDraft}.
 *
 * ## What is NOT re-decided here
 *
 * `offline` is read off POD-379's outbox oracle, which tags the covered set
 * must-not-change: the seven eligible writes are exactly what
 * `createEngineOutbox` enqueues today, and pins / tab order are its DELIBERATE
 * exclusions ("low offline value"). The brief calls this whole family
 * "offline-eligible"; the oracle is more specific and the oracle wins, because
 * widening the set is a product behaviour change, not a migration.
 */

import { z } from 'zod'
import type { CommandDef } from './commands'
import { defineCommands } from './commands'

/**
 * `mutationId` — carried on the input of every offline-eligible write because the
 * client Outbox stamps a stable one per entry and replays it verbatim.
 *
 * IT IS NOT THE HANDLER'S BUSINESS. POD-312 makes idempotency framework-owned: the
 * per-proc `withMutation(...)` wrapper is removed and the registry dedupes around
 * the handler. The field stays on the contract because it is part of the WIRE the
 * outbox already speaks; `max(128)` matches the router's shipped bound exactly.
 */
const mutationId = z.string().max(128).optional()

/** Work-state vocabulary, restated structurally: @podium/model owns the enum, and
 *  this leaf contract must not fork it — see the identity test in
 *  session-commands.test.ts, which asserts the two accept the same values. */
const workState = z.enum(['planning', 'implementing', 'testing', 'done', 'icebox'])

/** Pin kinds, as the shipped router validates them. */
const pinKind = z.enum(['panel', 'worktree', 'repo'])

// ---------------------------------------------------------------------------
// Shared session state — owner-or-grant
// ---------------------------------------------------------------------------

/**
 * The curated name slot. `nameSource` precedence ([spec:SP-eb60]) makes this the
 * contract where §3.1.3 A3's attribution PAIR bites hardest: "a human set this
 * name" must be decided from the ON-BEHALF-OF human of the transport principal,
 * not from "was this the operator cookie" — an agent acting for a human still
 * writes an agent-sourced name, and a human acting through any transport writes a
 * human-sourced one.
 */
const rename: CommandDef = {
  input: z.object({ sessionId: z.string(), name: z.string().max(120), mutationId }),
  action: 'write',
  policy: { resource: 'session', scope: 'owner-or-grant', action: 'write' },
  exposure: ['trpc'],
  offline: 'eligible',
  redaction: { fields: [], note: 'a session name is a label the owner chose to display' },
  conflict: 'field-LWW',
  decision:
    'nameSource is resolved from the principal’s on-behalf-of human (§3.1.3 A3), not from the transport being the operator cookie. Relay exposure stays OFF: POD-379 pins that presence writes have no agent path, and that absence is reproduced here as an explicit exposure decision rather than inherited from an allowlist.',
}

const setArchived: CommandDef = {
  input: z.object({ sessionId: z.string(), archived: z.boolean(), mutationId }),
  action: 'write',
  policy: { resource: 'session', scope: 'owner-or-grant', action: 'write' },
  exposure: ['trpc'],
  offline: 'eligible',
  redaction: { fields: [] },
  conflict: 'field-LWW',
}

const setWorkState: CommandDef = {
  input: z.object({ sessionId: z.string(), workState: workState.nullable(), mutationId }),
  action: 'write',
  policy: { resource: 'session', scope: 'owner-or-grant', action: 'write' },
  exposure: ['trpc'],
  offline: 'eligible',
  redaction: { fields: [] },
  conflict: 'field-LWW',
}

/**
 * Move (or clear) a session's explicit issue attachment. Shared state, not
 * per-user: which issue a session belongs to is a fact about the session that
 * every viewer must agree on, and attaching is a NAMING POINT (it allocates a ref
 * letter). Confirmed as POD-380's rather than the issue family's: the issue-side
 * commands (`issues.addSession` / `attachSession`) write the ISSUE's membership,
 * while this writes the SESSION's `refIssueId` and mints its ref letter — a
 * different row, a different owner, and no issue command covers it.
 */
const setIssueId: CommandDef = {
  input: z.object({ sessionId: z.string(), issueId: z.string().nullable(), mutationId }),
  action: 'write',
  policy: { resource: 'session', scope: 'owner-or-grant', action: 'write' },
  exposure: ['trpc'],
  offline: 'direct-only',
  redaction: { fields: [] },
  conflict: 'field-LWW',
  decision:
    'direct-only, matching POD-379’s outbox oracle: setIssueId is NOT in createEngineOutbox’s covered set. Making it offline-eligible would let a queued attach mint a ref letter hours later against an issue that has since moved.',
}

// ---------------------------------------------------------------------------
// Per-user state — self-scoped, keyed (userId, entityId), non-grantable
// ---------------------------------------------------------------------------

/** Per-user read state. `policy.scope: 'self'` is what makes "one user setting
 *  another user's readAt" unrepresentable rather than merely unimplemented. */
const markRead: CommandDef = {
  input: z.object({ sessionId: z.string(), mutationId }),
  action: 'write',
  policy: { resource: 'per-user-state', scope: 'self', action: 'write' },
  exposure: ['trpc'],
  offline: 'eligible',
  redaction: { fields: [] },
  conflict: 'single-writer',
}

const markUnread: CommandDef = { ...markRead }

const snoozeSet: CommandDef = {
  input: z.object({ sessionId: z.string(), until: z.string().nullable(), mutationId }),
  action: 'write',
  policy: { resource: 'per-user-state', scope: 'self', action: 'write' },
  exposure: ['trpc'],
  offline: 'eligible',
  redaction: { fields: [] },
  conflict: 'single-writer',
}

const snoozeClear: CommandDef = {
  input: z.object({ sessionId: z.string(), mutationId }),
  action: 'write',
  policy: { resource: 'per-user-state', scope: 'self', action: 'write' },
  exposure: ['trpc'],
  offline: 'eligible',
  redaction: { fields: [] },
  conflict: 'single-writer',
}

const pinSet: CommandDef = {
  input: z.object({ kind: pinKind, id: z.string(), pinned: z.boolean(), mutationId }),
  action: 'write',
  policy: { resource: 'per-user-state', scope: 'self', action: 'write' },
  exposure: ['trpc'],
  offline: 'direct-only',
  redaction: { fields: [] },
  conflict: 'single-writer',
  decision:
    'direct-only: POD-379’s outbox oracle tags pins as a DELIBERATE offline exclusion (low offline value), must-not-change.',
}

const tabsSetOrder: CommandDef = {
  input: z.object({ worktree: z.string(), sessionIds: z.array(z.string()), mutationId }),
  action: 'write',
  policy: { resource: 'per-user-state', scope: 'self', action: 'write' },
  exposure: ['trpc'],
  offline: 'direct-only',
  redaction: { fields: [] },
  conflict: 'single-writer',
  decision:
    'direct-only: same POD-379 oracle row as pins (low offline value), must-not-change. Note the shipped behaviour an empty sessionIds array DELETES the saved order — preserved by the handler, not by this schema.',
}

// ---------------------------------------------------------------------------
// The composer draft — §3.3's deliberate exception
// ---------------------------------------------------------------------------

/**
 * THE COMPOSER DRAFT, and the fork resolved on it.
 *
 * Today the draft is a debounced WHOLE-BODY write: last writer wins over the
 * entire text. docs/multi-user-readiness.md §3.3 names this as the first place a
 * documented decision becomes a data-loss bug, and §4 reserves the `op-stream`
 * conflict class for it — a per-document ordered op stream SEQUENCED BY THE
 * AUTHORITY, where the Replica still never arbitrates because it applies an
 * ordering someone else decided.
 *
 * DECISION (POD-380): keep the draft in the SHARED-SURFACE class, as §3.3
 * classifies it, and RESERVE `op-stream` on this contract without building op
 * transport. The per-user alternative (each person keeps their own draft on a
 * shared session) is cheaper and would make the conflict vanish, but §3.3 calls
 * it a deviation, and the product evidence agrees with the doc: the draft already
 * FANS OUT to every other attached client and deliberately does not echo to its
 * author (POD-379 pins both). A draft that fans out is a shared surface being
 * co-watched; making it per-user would delete a shipped collaboration behaviour,
 * which is a product decision and not a migration's to take.
 *
 * THIS IS THE COMMAND HALF OF A RESERVATION THAT ALREADY EXISTS. POD-365 reserved
 * the DOCUMENT half in `@podium/model`'s `OpStreamDocument` (`{value, revision?,
 * opsTail?}`) and listed `session.composerDraft` in `OP_STREAM_MEMBERS`. This
 * contract must not fork that vocabulary, so it borrows its names:
 *
 *  1. `baseRevision` — the document `revision` the edit was composed against
 *     (`OpStreamDocument.revision`, not a second numbering). Absent means
 *     "unconditional", exactly today's whole-body write, so nothing breaks; present
 *     means the Authority may reject or rebase (POD-316). An op needs no new
 *     envelope field: an op IS a `{baseRevision, edit}` pair.
 *  2. `edit` is a UNION whose only member today is `{kind: 'replace', text}`. Adding
 *     `{kind: 'splice', at, remove, insert}` later is an ADDITIVE variant on an
 *     existing discriminated union — the shape POD-300's wire rules already permit —
 *     rather than a new field on a flat payload. A `replace` supplies the document's
 *     materialized `value`; a splice would append to its `opsTail`.
 *  3. The materialized value travels with the document. ADR 2 D5's retention proof
 *     depends on the bootstrap snapshot being POSITIVE STATE, so ops are only safe
 *     to head-prune if they compact into a materialized snapshot. `replace` carries
 *     the whole materialized text, which is why POD-365 made `value` the required
 *     member and the tail the additive one.
 *
 * WHAT THE RESERVATION DOES NOT DO: it does not make concurrent editing safe. A
 * `replace` still overwrites. The shipped shape must not let one writer's text
 * silently overwrite another's, and `baseRevision` is what makes that enforceable —
 * a stale `baseRevision` is a REJECTION the author can see, not a silent clobber.
 * The handler therefore rejects a stale `baseRevision` rather than ignoring it,
 * which is the smallest thing that keeps the promise without building op transport.
 * It also discharges D10's named interim defect against the composer draft: before
 * session sharing ships, the draft must either move to `op-stream` or be gated to a
 * single writer, and a rejected stale revision IS that gate.
 */
const sessionDraft: CommandDef = {
  input: z.object({
    sessionId: z.string(),
    /** The `OpStreamDocument.revision` this edit was composed against. Absent ⇒
     *  unconditional (today's behaviour); present ⇒ the Authority may reject. */
    baseRevision: z.number().int().nonnegative().optional(),
    /** ADDITIVE union — `splice` joins it when op-stream is built. */
    edit: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('replace'), text: z.string() }),
    ]),
    mutationId,
  }),
  action: 'write',
  policy: { resource: 'session', scope: 'owner-or-grant', action: 'write' },
  // `ws` — the draft's live path is the debounced WebSocket edit, not a tRPC call.
  exposure: ['ws'],
  offline: 'direct-only',
  redaction: {
    fields: ['edit'],
    note: 'a draft is unsent user-authored prose. It is persisted (that is the feature) but must never be logged or copied into an error message.',
  },
  conflict: 'op-stream',
  decision:
    'RESERVED, not built (§4), composing POD-365’s OpStreamDocument vocabulary rather than a second one. Shared-surface class per §3.3, not per-user. baseRevision + a discriminated edit union make the op-stream promotion additive; a stale baseRevision is REJECTED, never silently applied, so no writer’s text is clobbered without the author being told — which is also ADR 1 Am1 D10’s required single-writer gate for the draft.',
}

// ---------------------------------------------------------------------------
// The tables
// ---------------------------------------------------------------------------

/** `sessions.*` presence-class writes. */
export const sessionPresenceCommands = defineCommands('sessions', {
  rename,
  setArchived,
  markRead,
  markUnread,
  setWorkState,
  setIssueId,
  setDraft: sessionDraft,
})

/** `snoozes.*` — its own tRPC router today, per-user state by class. */
export const snoozeCommands = defineCommands('snoozes', {
  set: snoozeSet,
  clear: snoozeClear,
})

/** `pins.*` — per-user state; NOT offline-eligible. */
export const pinCommands = defineCommands('pins', { set: pinSet })

/** `tabs.*` — per-user state; NOT offline-eligible. */
export const tabCommands = defineCommands('tabs', { setOrder: tabsSetOrder })

/**
 * THE canonical presence-class contract list, dotted wire names — one place a
 * gate, an audit or a transport can ask "is this proc migrated?".
 */
export const PRESENCE_COMMAND_TABLES = [
  sessionPresenceCommands,
  snoozeCommands,
  pinCommands,
  tabCommands,
] as const

/** Every `namespace.key` in the presence class. */
export function presenceCommandNames(): string[] {
  return PRESENCE_COMMAND_TABLES.flatMap((table) =>
    Object.keys(table.defs).map((key) => `${table.namespace}.${key}`),
  )
}

/** Look one contract up by its dotted name; undefined when unmigrated. */
export function presenceCommand(name: string): CommandDef | undefined {
  for (const table of PRESENCE_COMMAND_TABLES) {
    const [namespace, key] = [table.namespace, name.slice(table.namespace.length + 1)]
    if (name.startsWith(`${namespace}.`) && Object.hasOwn(table.defs, key)) {
      return (table.defs as Record<string, CommandDef>)[key]
    }
  }
  return undefined
}
