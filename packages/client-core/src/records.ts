/**
 * GENERIC SYNCED EDITS ON THE CLIENT (ADR 12 D3/D4, POD-6392).
 *
 * Apps get one way to write plain synced data:
 *
 *     records.create(kind, id, fields)
 *     records.edit(ref, patch, expectedRevision?)
 *     records.remove(ref, expectedRevision?)
 *
 * typed and checked from the kind's declaration in `@podium/commands/records`.
 * Each call is one outbox entry (`recordCreate`, `recordEdit`, `recordRemove`)
 * sent on `sync.submit` as `records.<kind>.<op>`. The entry's own input is the
 * optimistic value: `command-reducers.ts` paints it with ONE generic case and the
 * paint lives exactly as long as the entry, which retires by receipt or
 * provenance like every other write (ADR 12 D7). There is no per-kind display
 * code and no per-kind command.
 *
 * WHAT IS CHECKED HERE, BEFORE ANYTHING PAINTS. The input is parsed with the
 * command's own schema, so a value is stored and painted the way the server will
 * store it (a title is trimmed). A field that is not a `spec` field, a missing
 * revision on an `exp-rev` kind, and an op the kind does not offer are refused
 * at the call: they are caller bugs the server would refuse anyway, and a paint
 * that is certain to snap back helps nobody.
 */

import type * as Declarations from '@podium/commands/records'
import type {
  AGENT_PROFILE_RECORD,
  EFFECT_RECORD,
  INSTANCE_PREFERENCES_RECORD,
  ISSUE_RECORD,
  ISSUE_USER_STATE_RECORD,
  PIN_RECORD,
  RecordField,
  RecordOp,
  SESSION_RECORD,
  SESSION_USER_STATE_RECORD,
  SUBSCRIPTION_RECORD,
  SUPERAGENT_THREAD_RECORD,
  SyncedKindDeclaration,
  TAB_ORDER_RECORD,
  USER_LAYOUT_RECORD,
  USER_PREFERENCES_RECORD,
  USER_READ_POSITION_RECORD,
  WORKFLOW_BINDING_RECORD,
} from '@podium/commands/records'
import {
  type DeviceIdPrefix,
  mintDeviceId,
  parseIssueUserStateRowId,
  parseSessionUserStateRowId,
} from '@podium/model'
import { isPendingIssueSeq, PENDING_ISSUE_SEQ } from '@podium/protocol'
import type { z } from 'zod'

/**
 * THE DECLARATIONS LOAD WITH THE OUTBOX, NOT WITH THE PAGE (POD-6423).
 *
 * `@podium/commands/records` carries every kind's zod schemas and its command
 * policy, which a client needs only once there is a record write to check,
 * send or paint. There is none before the outbox is open: a queued write is
 * read from it, and a new one is written into it. So the module is imported
 * dynamically, and `openKernelEngineOutbox` awaits it beside the queue it
 * opens. Every synchronous reader below runs after that; one that runs before
 * it is a wiring bug, and throws saying so rather than painting nothing.
 *
 * The types are imported as types only, so they cost the page nothing.
 */
type RecordDeclarations = typeof Declarations

let declarations: RecordDeclarations | undefined
let loading: Promise<RecordDeclarations> | undefined

/** Load the record declarations, once. A failed fetch can be retried. */
export function loadRecordDeclarations(): Promise<RecordDeclarations> {
  loading ??= import('@podium/commands/records').then(
    (module) => {
      declarations = module
      return module
    },
    (error: unknown) => {
      loading = undefined
      throw error
    },
  )
  return loading
}

/** Whether {@link loadRecordDeclarations} has finished. */
export const recordDeclarationsLoaded = (): boolean => declarations !== undefined

/** The loaded declarations. Throws when nothing has loaded them yet. */
export function loadedRecordDeclarations(): RecordDeclarations {
  if (declarations === undefined) {
    throw new Error(
      'record declarations are not loaded: openKernelEngineOutbox loads them, ' +
        'or await loadRecordDeclarations() first',
    )
  }
  return declarations
}

/** Whether an issue row's number is still the creating device's placeholder
 *  (POD-6400): a reader shows it as pending until the server's row lands. */
export { PENDING_ISSUE_SEQ }
export const issueSeqPending = (row: { readonly seq: number }): boolean =>
  isPendingIssueSeq(row.seq)

/** Every kind that takes generic edits, by name, as a type. */
interface RecordKindTable {
  readonly issueProjection: typeof ISSUE_RECORD
  readonly sessionUserState: typeof SESSION_USER_STATE_RECORD
  // My read and tuck marks on an issue (POD-6404).
  readonly issueUserState: typeof ISSUE_USER_STATE_RECORD
  // One of my layout keys (POD-6404); its own pool record paints the edit.
  readonly userLayout: typeof USER_LAYOUT_RECORD
  // A human gate's decision on an effect record: an approval (POD-6674).
  readonly effect: typeof EFFECT_RECORD
  // The lifecycle as desired state (POD-6356): an edit paints `desired` on the
  // session row until its entry retires.
  readonly session: typeof SESSION_RECORD
  // My pins, tab orders and personal preferences (POD-6673): each its own row
  // in the pool, keyed by its feed id.
  readonly pin: typeof PIN_RECORD
  readonly tabOrder: typeof TAB_ORDER_RECORD
  readonly userPreferences: typeof USER_PREFERENCES_RECORD
  // How far I have read one event stream: a queued edit, merged to the max.
  readonly userReadPosition: typeof USER_READ_POSITION_RECORD
  // My superagent threads (POD-6675): title, archive, model and effort.
  readonly superagentThread: typeof SUPERAGENT_THREAD_RECORD
  // Agent profiles, trigger subscriptions and workflow bindings (POD-6676).
  readonly agentProfile: typeof AGENT_PROFILE_RECORD
  readonly subscription: typeof SUBSCRIPTION_RECORD
  readonly workflowBinding: typeof WORKFLOW_BINDING_RECORD
  // The instance settings (POD-6677): an admin's edits, leaf by leaf.
  readonly instancePreferences: typeof INSTANCE_PREFERENCES_RECORD
}

let kinds: RecordKindTable | undefined

/**
 * Every kind that takes generic edits, by name. `records.test.ts` holds this
 * table EQUAL to `SYNCED_KINDS`, so a kind declared there and not here (or the
 * reverse) fails a test rather than an edit.
 */
export function recordKinds(): RecordKindTable {
  if (kinds !== undefined) return kinds
  const d = loadedRecordDeclarations()
  kinds = {
    issueProjection: d.ISSUE_RECORD,
    sessionUserState: d.SESSION_USER_STATE_RECORD,
    issueUserState: d.ISSUE_USER_STATE_RECORD,
    userLayout: d.USER_LAYOUT_RECORD,
    session: d.SESSION_RECORD,
    pin: d.PIN_RECORD,
    tabOrder: d.TAB_ORDER_RECORD,
    userPreferences: d.USER_PREFERENCES_RECORD,
    userReadPosition: d.USER_READ_POSITION_RECORD,
    effect: d.EFFECT_RECORD,
    superagentThread: d.SUPERAGENT_THREAD_RECORD,
    agentProfile: d.AGENT_PROFILE_RECORD,
    subscription: d.SUBSCRIPTION_RECORD,
    workflowBinding: d.WORKFLOW_BINDING_RECORD,
    instancePreferences: d.INSTANCE_PREFERENCES_RECORD,
  } satisfies Record<string, SyncedKindDeclaration>
  return kinds
}

export type RecordKind = keyof RecordKindTable

type FieldsOf<K extends RecordKind> = RecordKindTable[K]['fields']
type ValueOf<F> = F extends RecordField<infer S> ? z.input<S> : never
type FieldsWithRole<K extends RecordKind, R extends string> = {
  [F in keyof FieldsOf<K>]: FieldsOf<K>[F] extends { readonly role: R } ? F : never
}[keyof FieldsOf<K>]

/**
 * A patch value that CLEARS its field (POD-6403): `edit(ref, { snoozedUntil:
 * UNSET })`. For the cells where absent and `null` are two facts. Only an
 * optional spec cell can be cleared; the entry carries it as `unset`.
 */
export const UNSET: unique symbol = Symbol('podium.records.unset')
export type Unset = typeof UNSET

/** What an edit may set: the kind's `spec` fields, or {@link UNSET} to clear one. */
export type RecordPatch<K extends RecordKind> = {
  readonly [F in FieldsWithRole<K, 'spec'>]?: ValueOf<FieldsOf<K>[F]> | Unset
}

/** What a create may carry: spec and key fields, and the kind's placement
 *  inputs (an issue's `repoPath`). The command's schema says which are required. */
export type RecordCreateFields<K extends RecordKind> = {
  readonly [F in FieldsWithRole<K, 'spec' | 'key'>]?: ValueOf<FieldsOf<K>[F]>
} & Readonly<Record<string, unknown>>

/** An existing record, as the feed names it. */
export interface RecordRef<K extends RecordKind = RecordKind> {
  readonly kind: K
  readonly id: string
}

/** The outbox inputs. `kind` picks the declaration; the rest is the command's
 *  input as the server parses it. */
export interface RecordCreateEntry {
  readonly kind: RecordKind
  readonly id: string
  readonly fields: Readonly<Record<string, unknown>>
}
export interface RecordEditEntry {
  readonly kind: RecordKind
  readonly id: string
  readonly patch: Readonly<Record<string, unknown>>
  /** Optional spec cells this edit makes absent (POD-6403). */
  readonly unset?: readonly string[]
  readonly expectedRevision?: number
}
export interface RecordRemoveEntry {
  readonly kind: RecordKind
  readonly id: string
  readonly expectedRevision?: number
}

/** The outbox kind behind each op. */
export const RECORD_OUTBOX_KINDS = {
  create: 'recordCreate',
  edit: 'recordEdit',
  remove: 'recordRemove',
} as const satisfies Record<RecordOp, string>

export type RecordOutboxKind = (typeof RECORD_OUTBOX_KINDS)[RecordOp]

const OP_OF: Readonly<Record<RecordOutboxKind, RecordOp>> = {
  recordCreate: 'create',
  recordEdit: 'edit',
  recordRemove: 'remove',
}

export const isRecordOutboxKind = (kind: string): kind is RecordOutboxKind => kind in OP_OF

export const recordOpOf = (kind: RecordOutboxKind): RecordOp => OP_OF[kind]

export function recordDeclaration(kind: string): SyncedKindDeclaration | undefined {
  const table = recordKinds()
  return Object.hasOwn(table, kind) ? table[kind as RecordKind] : undefined
}

/** The wire command one queued record write is sent as. */
export const recordWireCommand = (kind: RecordOutboxKind, recordKind: string): string =>
  loadedRecordDeclarations().recordCommandName(recordKind as RecordKind, OP_OF[kind])

/** Every wire command a record write can be sent as, with its outbox kind. */
export function recordWireCommands(): ReadonlyArray<readonly [string, RecordOutboxKind]> {
  const { recordCommandName } = loadedRecordDeclarations()
  const out: (readonly [string, RecordOutboxKind])[] = []
  for (const d of Object.values(recordKinds()) as SyncedKindDeclaration[]) {
    for (const op of Object.keys(d.ops) as RecordOp[]) {
      out.push([recordCommandName(d.kind, op), RECORD_OUTBOX_KINDS[op]])
    }
  }
  return out
}

let wireKinds: ReadonlyMap<string, RecordOutboxKind> | undefined

/** The outbox kind a `records.<kind>.<op>` wire command is queued as, or
 *  `undefined` for any other name. Read once the declarations are loaded. */
export function recordOutboxKindOfCommand(name: string): RecordOutboxKind | undefined {
  if (!name.startsWith('records.')) return undefined
  wireKinds ??= new Map(recordWireCommands())
  return wireKinds.get(name)
}

/** The command's input as the server parses it: the entry without its `kind`. */
export function recordWireInput(input: object): Record<string, unknown> {
  const { kind: _kind, ...rest } = input as Record<string, unknown>
  return rest
}

/**
 * WHERE A KIND'S ROW LIVES IN THE POOL: the overlay target and the target's row
 * id for a record id. Addressing, not display: a per-user row's feed id names
 * its user and entity, and the pool keys that row by the entity alone. `null`
 * marks a kind submitted directly, with no queued overlay.
 */
export const RECORD_HOMES: {
  readonly [K in RecordKind]: {
    readonly target:
      | 'issueProjections'
      | 'sessionUserStates'
      | 'issueUserStates'
      | 'sessions'
      | 'pins'
      | 'tabOrders'
      | 'userPreferences'
      | 'userLayouts'
      | 'userReadPositions'
      | 'effects'
      | 'superagentThreads'
      | 'subscriptions'
      | 'instancePreferences'
    readonly row: (id: string) => string
  } | null
} = {
  issueProjection: { target: 'issueProjections', row: (id) => id },
  sessionUserState: {
    target: 'sessionUserStates',
    row: (id) => parseSessionUserStateRowId(id).sessionId,
  },
  issueUserState: {
    target: 'issueUserStates',
    row: (id) => parseIssueUserStateRowId(id).entityId,
  },
  session: { target: 'sessions', row: (id) => id },
  effect: { target: 'effects', row: (id) => id },
  userLayout: { target: 'userLayouts', row: (id) => id },
  // Standalone per-user rows (POD-6673): the pool keys each by its feed id.
  pin: { target: 'pins', row: (id) => id },
  tabOrder: { target: 'tabOrders', row: (id) => id },
  userPreferences: { target: 'userPreferences', row: (id) => id },
  userReadPosition: { target: 'userReadPositions', row: (id) => id },
  // POD-6675: a superagent thread, keyed by its feed id.
  superagentThread: { target: 'superagentThreads', row: (id) => id },
  // POD-6676: a subscription's toggle and removal paint on its pool row, keyed
  // by its feed id. A profile and a binding are answered now (`submitNow`), so
  // nothing queues or paints for them.
  subscription: { target: 'subscriptions', row: (id) => id },
  agentProfile: null,
  workflowBinding: null,
  // POD-6677: the one instance settings record, keyed by its feed id.
  instancePreferences: { target: 'instancePreferences', row: (id) => id },
}

/** A new id's prefix per kind that offers create. `records.test.ts` mints one
 *  and holds it to the declaration's own `newId` shape. */
const NEW_ID_PREFIX: Partial<Record<RecordKind, DeviceIdPrefix>> = {
  issueProjection: 'iss_',
  // An agent profile's id (POD-6676); the CLI mints it the same way.
  agentProfile: 'agp_',
}

/** A caller's mistake the server would refuse: refused before anything paints. */
export class RecordInputError extends Error {
  override readonly name = 'RecordInputError'
}

function declarationFor(kind: RecordKind, op: RecordOp): SyncedKindDeclaration {
  const d = recordDeclaration(kind)
  if (d === undefined) throw new RecordInputError(`${kind} takes no generic edits`)
  if (d.ops[op] === undefined) throw new RecordInputError(`${kind} does not offer ${op}`)
  return d
}

function parsed<T>(schema: z.ZodTypeAny, value: unknown, what: string): T {
  const result = schema.safeParse(value)
  if (!result.success) throw new RecordInputError(`${what}: ${result.error.message}`)
  return result.data as T
}

/** An edit naming an exp-rev field, or a remove of an exp-rev kind, must name
 *  the revision it was made against. A plain field's last writer wins. */
function requireRevision(
  d: SyncedKindDeclaration,
  expectedRevision: number | undefined,
  fields?: readonly string[],
): void {
  const { editNeedsRevision } = loadedRecordDeclarations()
  const needed = fields === undefined ? d.conflict === 'exp-rev' : editNeedsRevision(d, fields)
  if (needed && expectedRevision === undefined) {
    throw new RecordInputError(
      `${d.kind}: ${fields?.join(', ') ?? 'a remove'} is exp-rev: name the revision this write was made against`,
    )
  }
}

/** A new id for a kind, minted on this device (ADR 12 D4). */
export function newRecordId(kind: RecordKind): string {
  const d = declarationFor(kind, 'create')
  const prefix = NEW_ID_PREFIX[kind]
  if (prefix === undefined) throw new RecordInputError(`${d.kind} has no device id prefix`)
  return mintDeviceId(prefix)
}

export function recordCreateEntry<K extends RecordKind>(
  kind: K,
  id: string,
  fields: RecordCreateFields<K>,
): RecordCreateEntry {
  const d = declarationFor(kind, 'create')
  const { recordCommandName, recordCreateInput } = loadedRecordDeclarations()
  const input = parsed<{ id: string; fields: Record<string, unknown> }>(
    recordCreateInput(d),
    { id, fields },
    recordCommandName(kind, 'create'),
  )
  return { kind, id: input.id, fields: input.fields }
}

export function recordEditEntry<K extends RecordKind>(
  ref: RecordRef<K>,
  patch: RecordPatch<K>,
  expectedRevision?: number,
): RecordEditEntry {
  const d = declarationFor(ref.kind, 'edit')
  const { recordCommandName, recordEditInput, specFields, unsettableFields } =
    loadedRecordDeclarations()
  const writable = new Set(specFields(d))
  const named = Object.entries(patch as Record<string, unknown>).filter(([, v]) => v !== undefined)
  const forbidden = named.map(([name]) => name).filter((name) => !writable.has(name))
  if (forbidden.length > 0) {
    throw new RecordInputError(`${d.kind}: ${forbidden.join(', ')} is not a field a client writes`)
  }
  const unset = named.filter(([, v]) => v === UNSET).map(([name]) => name)
  const clearable = new Set(unsettableFields(d))
  const fixed = unset.filter((name) => !clearable.has(name))
  if (fixed.length > 0) {
    throw new RecordInputError(`${d.kind}: ${fixed.join(', ')} cannot be cleared, only set`)
  }
  const set = Object.fromEntries(named.filter(([, v]) => v !== UNSET))
  requireRevision(
    d,
    expectedRevision,
    named.map(([name]) => name),
  )
  const input = parsed<{
    id: string
    patch: Record<string, unknown>
    unset?: string[]
    expectedRevision?: number
  }>(
    recordEditInput(d),
    {
      id: ref.id,
      patch: set,
      ...(unset.length === 0 ? {} : { unset }),
      ...(expectedRevision === undefined ? {} : { expectedRevision }),
    },
    recordCommandName(ref.kind, 'edit'),
  )
  return {
    kind: ref.kind,
    id: input.id,
    patch: input.patch,
    ...(input.unset === undefined ? {} : { unset: input.unset }),
    ...(input.expectedRevision === undefined ? {} : { expectedRevision: input.expectedRevision }),
  }
}

export function recordRemoveEntry<K extends RecordKind>(
  ref: RecordRef<K>,
  expectedRevision?: number,
): RecordRemoveEntry {
  const d = declarationFor(ref.kind, 'remove')
  const { recordCommandName, recordRemoveInput } = loadedRecordDeclarations()
  requireRevision(d, expectedRevision)
  const input = parsed<{ id: string; expectedRevision?: number }>(
    recordRemoveInput(d),
    { id: ref.id, ...(expectedRevision === undefined ? {} : { expectedRevision }) },
    recordCommandName(ref.kind, 'remove'),
  )
  return {
    kind: ref.kind,
    id: input.id,
    ...(input.expectedRevision === undefined ? {} : { expectedRevision: input.expectedRevision }),
  }
}

/** The one generic write API apps get (on the store as `records`). Each call
 *  paints at once and settles when the outbox entry is durable. */
export interface RecordsApi {
  create<K extends RecordKind>(kind: K, id: string, fields: RecordCreateFields<K>): Promise<void>
  edit<K extends RecordKind>(
    ref: RecordRef<K>,
    patch: RecordPatch<K>,
    expectedRevision?: number,
  ): Promise<void>
  remove<K extends RecordKind>(ref: RecordRef<K>, expectedRevision?: number): Promise<void>
  /** A new id for `kind`, minted on this device. */
  newId(kind: RecordKind): string
}

/** The outbox input each record kind carries. */
export interface RecordOutboxInputs {
  recordCreate: RecordCreateEntry
  recordEdit: RecordEditEntry
  recordRemove: RecordRemoveEntry
}

/** Build the API over the outbox's single write path. An input the declaration
 *  refuses rejects the call's promise, and nothing paints. */
export function createRecordsApi(
  write: (kind: RecordOutboxKind, input: RecordOutboxInputs[RecordOutboxKind]) => Promise<void>,
): RecordsApi {
  // Loaded by the outbox's open before any of these can run, so a call builds
  // and writes its entry synchronously exactly as before: the load is awaited
  // only by a caller wired without that outbox.
  return {
    create: async (kind, id, fields) => {
      if (!recordDeclarationsLoaded()) await loadRecordDeclarations()
      await write('recordCreate', recordCreateEntry(kind, id, fields))
    },
    edit: async (ref, patch, expectedRevision) => {
      if (!recordDeclarationsLoaded()) await loadRecordDeclarations()
      await write('recordEdit', recordEditEntry(ref, patch, expectedRevision))
    },
    remove: async (ref, expectedRevision) => {
      if (!recordDeclarationsLoaded()) await loadRecordDeclarations()
      await write('recordRemove', recordRemoveEntry(ref, expectedRevision))
    },
    newId: newRecordId,
  }
}
