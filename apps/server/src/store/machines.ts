import type { MachineCredentialRotation } from '@podium/protocol'
import { z } from 'zod'
import { CommittedRows } from './committed-rows'
/**
 * Machines aggregate — owns the `machines` table (registered daemons and
 * their token hashes).
 */

import { createHash, timingSafeEqual } from 'node:crypto'
import {
  Inventory,
  MachineComponent,
  MachineHarnessVersion,
  type MachineId,
  MachinePresenceSource,
  MachineServiceAssignment,
  MachineServiceReport,
  UpdateChannel,
  type UpdateChannel as UpdateChannelValue,
  type UserId,
} from '@podium/model'
import type { PeerBuild } from '@podium/protocol'
import { and, asc, eq, isNull, type SQL, sql } from 'drizzle-orm'
import { machines, grants } from '../migrations/schema'
import { GrantsRepository } from './grants'
import type { StoreDrizzle, StoreQueries, TransactionRunner } from './executor/sync-drizzle'
import { executeRaw, inListOf, inListSize, inListValues, param, prepared, preparedFamily } from './executor/sync-drizzle'
import { verifyWithMachineKey } from '@podium/runtime/machine-credential'
import type { MachineRecord } from './types'

/** RETAINED EXTERNAL-INPUT BRAND CASTS: daemon enrollment and compatibility
 * lookup methods accept machine ids as strings. Their write/query casts decode
 * inputs; selected machine ids and owners flow from the schema. */
/** Defensive parse of a stored inventory blob → undefined on any failure. Goes
 *  through the zod schema (not a bare cast) so schema defaults are applied — a
 *  blob persisted before `tools` existed reads back with `tools: []` (#214). */
function parseInventory(json: unknown): Inventory | undefined {
  if (typeof json !== 'string' || json.length === 0) return undefined
  try {
    const parsed = Inventory.safeParse(JSON.parse(json))
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}

function parseCaps(raw: string | null): string[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((c): c is string => typeof c === 'string') : []
  } catch {
    return []
  }
}

export const AssignmentEvidence = z.object({
  version: z.literal(1), source: z.string().min(1), requestId: z.string().min(1),
})
export const MachineAvailability = z.object({
  epoch: z.string().min(1), server: z.boolean(), daemon: z.boolean(), supervisor: z.boolean(),
})
function parseStored<T>(schema: z.ZodType<T>, raw: unknown): T | null {
  if (typeof raw !== 'string') return null
  try { const result = schema.safeParse(JSON.parse(raw)); return result.success ? result.data : null }
  catch { return null }
}
export function assignmentComponents(assignment: MachineServiceAssignment): MachineComponent[] {
  return [...(assignment.server ? ['server' as const] : []), ...(assignment.agentExecution ? ['daemon' as const] : [])]
}

function parseAssignment(raw: unknown): MachineServiceAssignment {
  if (typeof raw === 'string') {
    try {
      const parsed = MachineServiceAssignment.safeParse(JSON.parse(raw))
      if (parsed.success) return parsed.data
    } catch {}
  }
  return { server: false, agentExecution: false }
}

function parseServiceReport(raw: unknown): MachineServiceReport | null {
  if (typeof raw !== 'string') return null
  try {
    const parsed = MachineServiceReport.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

function parsePresenceSource(raw: unknown): MachinePresenceSource | null {
  const parsed = MachinePresenceSource.safeParse(raw)
  return parsed.success ? parsed.data : null
}

/**
 * WHAT STILL NEEDS MAPPING [spec §6 rules 3, 4 and 6].
 *
 * Drizzle returns the schema's TypeScript names, the `MachineId` and `UserId`
 * brands, and the two `integer({ mode: 'boolean' })` columns as booleans, so the
 * per-column decode this file used to carry is gone. What remains is defensive
 * PARSING of three text blobs and two nullability decisions, and every one of
 * them is a decision the file already documents rather than a driver artefact —
 * see `parseInventory`, `parseCaps`, `parseAssignment` and the comments below.
 */
type MachineSelect = Pick<
  typeof machines.$inferSelect,
  | 'id'
  | 'revokedAt'
  | 'supersededBy'
  | 'name'
  | 'hostname'
  | 'createdAt'
  | 'lastSeenAt'
  | 'inventoryJson'
  | 'harnessVersionsJson'
  | 'appVersion'
  | 'wireSchemaDigest'
  | 'installKind'
  | 'deliveryCapsJson'
  | 'presenceSource'
  | 'serviceAssignmentJson'
  | 'assignmentEvidenceJson'
  | 'availabilityJson'
  | 'serviceReportJson'
  | 'buildReportedAt'
  | 'podiumManaged'
  | 'updateChannelOverride'
  | 'componentsJson'
>

/** The columns every machine read projects — the same list, spelled once. */
const MACHINE_COLUMNS = {
  revokedAt: machines.revokedAt,
  supersededBy: machines.supersededBy,
  id: machines.id,
  name: machines.name,
  hostname: machines.hostname,
  createdAt: machines.createdAt,
  lastSeenAt: machines.lastSeenAt,
  inventoryJson: machines.inventoryJson,
  harnessVersionsJson: machines.harnessVersionsJson,
  appVersion: machines.appVersion,
  wireSchemaDigest: machines.wireSchemaDigest,
  installKind: machines.installKind,
  deliveryCapsJson: machines.deliveryCapsJson,
  presenceSource: machines.presenceSource,
  serviceAssignmentJson: machines.serviceAssignmentJson,
  assignmentEvidenceJson: machines.assignmentEvidenceJson,
  availabilityJson: machines.availabilityJson,
  serviceReportJson: machines.serviceReportJson,
  buildReportedAt: machines.buildReportedAt,
  podiumManaged: machines.podiumManaged,
  updateChannelOverride: machines.updateChannelOverride,
  componentsJson: machines.componentsJson,
}

export function machineRecordFromRow(r: MachineSelect): MachineRecord {
  const inventory = parseInventory(r.inventoryJson)
  return {
    id: r.id,
    revokedAt: r.revokedAt,
    supersededBy: r.supersededBy,
    harnessVersions: r.harnessVersionsJson
      ? Object.values(JSON.parse(r.harnessVersionsJson)).map((row) =>
          MachineHarnessVersion.parse(row),
        )
      : [],
    name: r.name,
    hostname: r.hostname,
    createdAt: r.createdAt,
    lastSeenAt: r.lastSeenAt,
    podiumManaged: r.podiumManaged,
    // POD-1882: null is MEANINGFUL — no per-machine pin, so this machine follows
    // the fleet default. `catch(null)` keeps an unreadable value reading as "not
    // pinned" rather than inventing a channel for it.
    updateChannelOverride: UpdateChannel.nullable()
      .catch(null)
      .parse(r.updateChannelOverride) as UpdateChannelValue | null,
    ...(inventory !== undefined ? { inventory } : {}),
    appVersion: r.appVersion,
    wireSchemaDigest: r.wireSchemaDigest,
    installKind: r.installKind,
    deliveryCaps: parseCaps(r.deliveryCapsJson),
    presenceSource: parsePresenceSource(r.presenceSource),
    serviceAssignment: parseAssignment(r.serviceAssignmentJson),
    assignmentEvidence: parseStored(AssignmentEvidence, r.assignmentEvidenceJson),
    availability: parseStored(MachineAvailability, r.availabilityJson),
    serviceReport: parseServiceReport(r.serviceReportJson),
    buildReportedAt: r.buildReportedAt,
    components: assignmentComponents(parseAssignment(r.serviceAssignmentJson)),
  }
}

/**
 * EVERY `(table, column)` IN THE SCHEMA THAT STORES A MACHINE ID, written out
 * rather than discovered.
 *
 * The one-time upgrade this replaces (POD-318) asked `sqlite_master` and
 * `PRAGMA table_info` which tables carried a machine column, because a
 * hand-written list of "sessions, repos, conversations" had already shipped
 * once and had already been wrong. The list is safe to write down HERE only
 * because it is no longer a memory: `machines-sentinel-scan.test.ts` derives
 * the same set from `migrations/schema.ts` and fails if a table grows a
 * machine column without appearing below.
 */
/**
 * THE RETIRED MACHINE SENTINELS, SPELLED ONCE IN LIVE CODE (POD-318).
 *
 * `'local'` was a `machines` row's literal id and `'__local__'` was the column
 * default three tables carried; the `MachineId` validator in `@podium/model`
 * refuses both, so no writer can produce either. This is the only other place
 * they are named, and the `local-placeholders` audit counter is what keeps that
 * true — the boot refusal's message reads them from here rather than repeating
 * them.
 */
export const RETIRED_MACHINE_SENTINELS = ['local', '__local__'] as const

export const MACHINE_ID_SITES: readonly string[] = [
  'agent_profiles.machine_id',
  'approval_requests.machine_id',
  'conversation_segment_incarnations.machine_id',
  'conversation_segments.machine_id',
  'conversations.machine_id',
  'issues.machine_id',
  'machines.id',
  'repos.machine_id',
  'sessions.machine_id',
  'ship_attempts.machine_id',
  'ship_orders.machine_id',
  'ship_train_manifests.machine_id',
  'ship_train_members.machine_id',
  'transcript_costs.machine_id',
]

// Every query this repository runs, prepared once per store [POD-6147].

const liveMachineById = (): SQL | undefined =>
  and(eq(machines.id, param(machines.id, 'id')), isNull(machines.revokedAt))

/** The sentinel scan is one constant statement over constant identifiers (see the method). */
const legacySentinelScan = prepared((db: StoreDrizzle) => {
  const sentinels = RETIRED_MACHINE_SENTINELS.map((v) => `'${v}'`).join(', ')
  const arms = MACHINE_ID_SITES.map((site) => {
    const [table, column] = site.split('.')
    return `SELECT '${site}' AS site WHERE EXISTS (SELECT 1 FROM "${table}" WHERE "${column}" IN (${sentinels}))`
  })
  const statement = arms.join('\nUNION ALL\n')
  return db.all<{ site: string }>(sql.raw(statement)) // CONSTANT-IDENTIFIER STATEMENT POD-3404
})

const upsertEnrolledMachine = prepared((db: StoreDrizzle) =>
  db
    .insert(machines)
    .values({
      id: sql.placeholder('id'),
      name: sql.placeholder('name'),
      hostname: sql.placeholder('hostname'),
      tokenHash: sql.placeholder('tokenHash'),
      createdAt: sql.placeholder('now'),
      lastSeenAt: sql.placeholder('now'),
      podiumManaged: sql.placeholder('podiumManaged'),
      serviceAssignmentJson: sql.placeholder('serviceAssignmentJson'),
      assignmentEvidenceJson: sql.placeholder('assignmentEvidenceJson'),
    })
    .onConflictDoUpdate({
      target: machines.id,
      setWhere: and(isNull(machines.revokedAt), eq(machines.credentialKind, 'bearer-hash'), isNull(machines.publicKey)),
      set: {
        name: sql.placeholder('name'),
        hostname: sql.placeholder('hostname'),
        tokenHash: sql.placeholder('tokenHash'),
        lastSeenAt: sql.placeholder('now'),
        podiumManaged: sql.placeholder('podiumManaged'),
      },
    })
    .returning()
    .prepare(),
)

const machinesByCreation = prepared((db: StoreDrizzle) =>
  db.select(MACHINE_COLUMNS).from(machines).orderBy(asc(machines.createdAt)).prepare(),
)

const machineById = prepared((db: StoreDrizzle) =>
  db.select(MACHINE_COLUMNS).from(machines).where(eq(machines.id, param(machines.id, 'id'))).prepare(),
)

const machinesByIds = preparedFamily((db: StoreDrizzle, size: number) =>
  db.select(MACHINE_COLUMNS).from(machines).where(inListOf(machines.id, size)).prepare(),
)

const machineRowById = prepared((db: StoreDrizzle) =>
  db.select().from(machines).where(eq(machines.id, param(machines.id, 'id'))).prepare(),
)

const setAvailabilityOf = prepared((db: StoreDrizzle) =>
  db.update(machines)
    .set({ availabilityJson: sql.placeholder('availabilityJson') })
    .where(liveMachineById()).returning().prepare(),
)

const recordHarnessVersionOf = prepared((db: StoreDrizzle) => {
  const path = sql.placeholder('path')
  const harness = sql.placeholder('harness')
  const version = sql.placeholder('version')
  const probedAt = sql.placeholder('probedAt')
  const document = sql`coalesce(${machines.harnessVersionsJson}, '{}')`
  const previousFirst = sql`json_extract(${document}, ${sql.placeholder('firstSeenPath')})`
  const previousLast = sql`json_extract(${document}, ${sql.placeholder('lastSeenPath')})`
  return db
    .update(machines)
    .set({
      harnessVersionsJson: sql`json_set(${document}, ${path}, json_object(
        'harness', ${harness},
        'version', case when ${previousLast} > ${probedAt}
          then json_extract(${document}, ${sql.placeholder('versionPath')}) else ${version} end,
        'firstSeen', min(coalesce(${previousFirst}, ${probedAt}), ${probedAt}),
        'lastSeen', max(coalesce(${previousLast}, ${probedAt}), ${probedAt})
      ))`,
    })
    .where(liveMachineById())
    .returning()
    .prepare()
})

const setInventoryOf = prepared((db: StoreDrizzle) =>
  db
    .update(machines)
    .set({ inventoryJson: sql.placeholder('inventoryJson') })
    .where(liveMachineById()).returning().prepare(),
)

const setBuildOf = prepared((db: StoreDrizzle) =>
  db
    .update(machines)
    .set({
      appVersion: sql.placeholder('appVersion'),
      wireSchemaDigest: sql.placeholder('wireSchemaDigest'),
      installKind: sql.placeholder('installKind'),
      deliveryCapsJson: sql.placeholder('deliveryCapsJson'),
      // COALESCE, not a plain write: a report without a source must LEAVE the
      // recorded presence alone rather than clearing it.
      presenceSource: sql`COALESCE(${sql.placeholder('source')}, ${machines.presenceSource})`,
      buildReportedAt: sql.placeholder('at'),
    })
    .where(liveMachineById()).returning().prepare(),
)

const setSupervisorPresenceOf = prepared((db: StoreDrizzle) =>
  db
    .update(machines)
    .set({
      appVersion: sql.placeholder('appVersion'),
      wireSchemaDigest: sql.placeholder('wireSchemaDigest'),
      installKind: sql.placeholder('installKind'),
      deliveryCapsJson: sql.placeholder('deliveryCapsJson'),
      presenceSource: 'supervisor',
      serviceReportJson: sql.placeholder('serviceReportJson'),
      buildReportedAt: sql.placeholder('at'),
      lastSeenAt: sql.placeholder('at'),
    })
    .where(liveMachineById()).returning().prepare(),
)

const setServiceAssignmentOf = prepared((db: StoreDrizzle) =>
  db
    .update(machines)
    .set({
      serviceAssignmentJson: sql.placeholder('serviceAssignmentJson'),
      assignmentEvidenceJson: sql.placeholder('assignmentEvidenceJson'),
    })
    .where(liveMachineById()).returning().prepare(),
)

const setPresenceSourceOf = prepared((db: StoreDrizzle) =>
  db
    .update(machines)
    .set({ presenceSource: sql.placeholder('presenceSource') })
    .where(liveMachineById()).returning().prepare(),
)

const tokenFactsOf = prepared((db: StoreDrizzle) =>
  db
    .select({ tokenHash: machines.tokenHash, revokedAt: machines.revokedAt, kind: machines.credentialKind, publicKey: machines.publicKey })
    .from(machines)
    .where(liveMachineById())
    .prepare(),
)

/** The rotation CAS names the previous public key, or its absence: two shapes. */
const rotateCredentialOf = preparedFamily((db: StoreDrizzle, previousKey: 'null' | 'key') =>
  db.update(machines)
    .set({ credentialKind: 'ed25519', tokenHash: '', publicKey: sql.placeholder('newPublicKey') })
    .where(and(eq(machines.id, param(machines.id, 'id')), isNull(machines.revokedAt), isNull(machines.supersededBy),
      eq(machines.credentialKind, param(machines.credentialKind, 'credentialKind')),
      eq(machines.tokenHash, param(machines.tokenHash, 'tokenHash')),
      previousKey === 'null' ? isNull(machines.publicKey) : eq(machines.publicKey, param(machines.publicKey, 'publicKey'))))
    .returning().prepare(),
)

const adoptHostCredentialOf = prepared((db: StoreDrizzle) =>
  db.update(machines)
    .set({ credentialKind: 'ed25519', tokenHash: '', publicKey: sql.placeholder('publicKey'),
      serviceAssignmentJson: sql.placeholder('serviceAssignmentJson'), assignmentEvidenceJson: sql.placeholder('assignmentEvidenceJson') })
    .where(and(eq(machines.id, param(machines.id, 'id')), isNull(machines.revokedAt), isNull(machines.supersededBy),
      eq(machines.credentialKind, 'bearer-hash'), eq(machines.tokenHash, param(machines.tokenHash, 'tokenHash')), isNull(machines.publicKey)))
    .returning().prepare(),
)

const setUpdateChannelOf = prepared((db: StoreDrizzle) =>
  db
    .update(machines)
    .set({ updateChannelOverride: sql.placeholder('channel') })
    .where(liveMachineById()).returning().prepare(),
)

const renameMachineOf = prepared((db: StoreDrizzle) =>
  db
    .update(machines)
    .set({ name: sql.placeholder('name') })
    .where(liveMachineById()).returning().prepare(),
)

const custodianOf = prepared((db: StoreDrizzle) =>
  db.select({ grantee: grants.grantee }).from(grants)
    .where(and(eq(grants.resourceKind, 'machine'), eq(grants.resourceId, param(grants.resourceId, 'id')), eq(grants.verb, 'manage'), eq(grants.custody, true)))
    .prepare(),
)

const enrollmentPlaceholders = {
  id: sql.placeholder('id'),
  name: sql.placeholder('name'),
  hostname: sql.placeholder('hostname'),
  tokenHash: sql.placeholder('tokenHash'),
  podiumManaged: sql.placeholder('podiumManaged'),
  credentialKind: sql.placeholder('credentialKind'),
  publicKey: sql.placeholder('publicKey'),
  serviceAssignmentJson: sql.placeholder('serviceAssignmentJson'),
  assignmentEvidenceJson: sql.placeholder('assignmentEvidenceJson'),
}

const insertEnrollment = prepared((db: StoreDrizzle) =>
  db.insert(machines)
    .values({ ...enrollmentPlaceholders, createdAt: sql.placeholder('now'), lastSeenAt: sql.placeholder('now') })
    .onConflictDoNothing().returning().prepare(),
)

const replaceRevokedEnrollment = prepared((db: StoreDrizzle) =>
  db.update(machines).set({ ...enrollmentPlaceholders, revokedAt: null, availabilityJson: null, lastSeenAt: sql.placeholder('now'),
      inventoryJson: null, harnessVersionsJson: null, serviceReportJson: null,
      appVersion: null, wireSchemaDigest: null, deliveryCapsJson: null,
      presenceSource: null, buildReportedAt: null })
    .where(and(eq(machines.id, param(machines.id, 'id')), eq(machines.revokedAt, param(machines.revokedAt, 'replaceRevokedAt')), isNull(machines.supersededBy), sql`CASE WHEN ${machines.credentialKind} = 'ed25519' THEN ${machines.publicKey} ELSE ${machines.tokenHash} END = ${sql.placeholder('replaceIncarnation')}`))
    .returning().prepare(),
)

const supersedeMachineOf = prepared((db: StoreDrizzle) =>
  db.update(machines)
    .set({ supersededBy: sql.placeholder('replacementId'),
      revokedAt: sql`COALESCE(${machines.revokedAt}, ${sql.placeholder('now')})`, availabilityJson: null })
    .where(eq(machines.id, param(machines.id, 'id'))).returning().prepare(),
)

const revokeMachineOf = prepared((db: StoreDrizzle) =>
  db
    .update(machines)
    .set({ revokedAt: sql`COALESCE(${machines.revokedAt}, ${sql.placeholder('now')})`, availabilityJson: null })
    .where(eq(machines.id, param(machines.id, 'id'))).returning().prepare(),
)

const deleteMachineOf = prepared((db: StoreDrizzle) =>
  db
    .delete(machines)
    .where(eq(machines.id, param(machines.id, 'id'))).returning().prepare(),
)

const touchMachineOf = prepared((db: StoreDrizzle) =>
  db
    .update(machines)
    .set({ lastSeenAt: sql.placeholder('now'), hostname: sql.placeholder('hostname') })
    .where(liveMachineById()).returning().prepare(),
)

export class MachinesRepository {
  readonly committed: CommittedRows<typeof machines.$inferSelect>

  private readonly rootDb: StoreDrizzle
  protected readonly createOrJoinTransaction: TransactionRunner

  constructor(queries: StoreQueries, private readonly grantRepository = new GrantsRepository(queries)) {
    this.committed = new CommittedRows(queries.createOrJoinTransaction, 'machines')
    this.rootDb = queries.rootDb
    this.createOrJoinTransaction = queries.createOrJoinTransaction
  }

  /**
   * The query builder every method below reads through [spec rules 34, 34a].
   *
   * A GETTER, not a field assigned in the constructor: rule 35 makes transaction
   * routing ambient, so this has to resolve the ENCLOSING transaction on every
   * access, and a field frozen at construction never could. B1 changes this one
   * line; no call site moves.
   */
  protected get db() {
    return this.rootDb
  }

  /**
   * WHERE A RETIRED MACHINE SENTINEL IS STILL STORED — empty on every database
   * a supported install can be holding.
   *
   * This is the residue half of POD-318's one-time boot upgrade, kept after the
   * rewrite itself was retired (POD-3246). The rewrite folded `'local'` and
   * `'__local__'` rows onto the host's minted id; it could go because no
   * released binary ever wrote either value — the sentinels died on 2026-08-02
   * and the first release of any kind is v0.1.0-edge.1 on 2026-08-17 — so a
   * database that has ever been opened by a shipped Podium cannot contain one.
   *
   * The CHECK stays because the alternative to finding out is not finding out.
   * A database that somehow still carries a sentinel is one where the fleet
   * answers to a UUID while rows name a machine that does not exist, and that
   * is precisely how the placeholder era stranded people's sessions. The facade
   * refuses to boot on a non-empty answer rather than serving mixed identities.
   *
   * ONE STATEMENT, not one per table: each arm is an `EXISTS` that stops at the
   * first offending row, and a remote driver pays one round trip for the whole
   * scan instead of fourteen.
   */
  async legacyMachineSentinelSites(): Promise<string[]> {
    // CONSTANT-IDENTIFIER STATEMENT POD-3404 — a WHOLE statement, which rule 1 allows only behind the
    // search port and which this is not. Converted in the most literal form
    // pending the rule: the identifiers are the `MACHINE_ID_SITES` source
    // constant, never user input, and `machines-sentinel-scan.test.ts` derives
    // the same set from the schema and fails if a table grows a machine column
    // without appearing there. One statement rather than fourteen is the
    // method's own documented choice about round trips, not an accident.
    // The statement is built once, in `legacySentinelScan`.
    const rows = await executeRaw(legacySentinelScan(this.db))
    return rows.map((r) => r.site)
  }

  /** Legacy enrollment input names the personal grantee explicitly. Refreshing
   * an existing custodian never transfers custody. */
  async upsertMachine(m: {
    id: string
    name: string
    hostname: string
    tokenHash: string
    ownerUserId: UserId | null
    podiumManaged?: boolean
    assignment?: MachineServiceAssignment
    assignmentEvidence?: z.infer<typeof AssignmentEvidence>
  }): Promise<void> {
    await this.createOrJoinTransaction(async () => {
      const now = new Date().toISOString()
      const result = await this.committed.write(async () => await upsertEnrolledMachine(this.db).all({
        // EXTERNAL INPUT BRAND DECODE: daemon enrollment supplies its proposed
        // id as a string; the repository is the write boundary that brands it.
        id: m.id as MachineId,
        name: m.name,
        hostname: m.hostname,
        tokenHash: m.tokenHash,
        now,
        podiumManaged: m.podiumManaged ?? true,
        serviceAssignmentJson: JSON.stringify(m.assignment ?? { server: false, agentExecution: false }),
        assignmentEvidenceJson: JSON.stringify(m.assignmentEvidence ?? { version: 1, source: 'enrollment', requestId: m.id }),
      }), 'upsert')
      if (result.changes === 1 && m.ownerUserId && await this.custodian(m.id) === null) await this.setMachineOwner(m.id, m.ownerUserId)
    })
  }

  async listMachines(): Promise<MachineRecord[]> {
    return (await machinesByCreation(this.db).all()).map(machineRecordFromRow)
  }

  async getMachine(id: string): Promise<MachineRecord | undefined> {
    const r = await machineById(this.db).get({ id: id as MachineId })
    if (!r) return undefined
    return machineRecordFromRow(r)
  }

  /** {@link getMachine} for many ids in one query per 500; a missing id is absent. */
  async getMachines(ids: readonly string[]): Promise<Map<string, MachineRecord>> {
    const out = new Map<string, MachineRecord>()
    const unique = [...new Set(ids)]
    for (let i = 0; i < unique.length; i += 500) {
      const chunk = unique.slice(i, i + 500)
      const size = inListSize(chunk.length)
      for (const row of await machinesByIds(this.db, size).all(inListValues(chunk, size))) {
        const record = machineRecordFromRow(row)
        out.set(record.id, record)
      }
    }
    return out
  }

  /** Explicit assignment add/remove; attachment never calls this transition. */
  async addMachineComponent(id: string, component: MachineComponent): Promise<boolean> {
    const row = await this.getMachine(id)
    if (!row || row.revokedAt || row.components?.includes(component)) return false
    await this.setServiceAssignment(id, { ...row.serviceAssignment,
      ...(component === 'server' ? { server: true } : { agentExecution: true }),
    }, { version: 1, source: 'assignment-add', requestId: `${id}:${component}:add` })
    return true
  }

  async setAvailability(id: string, availability: z.infer<typeof MachineAvailability>): Promise<void> {
    const value = MachineAvailability.parse(availability)
    await this.committed.write(async () => await setAvailabilityOf(this.db)
      .all({ id: id as MachineId, availabilityJson: JSON.stringify(value) }), 'upsert')
  }

  /** One atomic replacement per harness; delayed reports cannot roll back the latest version. */
  async recordHarnessVersion(
    id: MachineId,
    report: {
      harness: string
      version: string
      probedAt: string
    },
  ): Promise<void> {
    const path = `$."${report.harness}"`
    await this.committed.write(
      async () =>
        await recordHarnessVersionOf(this.db).all({
          id,
          path,
          firstSeenPath: `${path}.firstSeen`,
          lastSeenPath: `${path}.lastSeen`,
          versionPath: `${path}.version`,
          harness: report.harness,
          version: report.version,
          probedAt: report.probedAt,
        }),
      'upsert',
    )
  }

  /** Persist a daemon-reported inventory (#222) as the raw JSON blob. */
  async setMachineInventory(id: string, inventoryJson: string): Promise<void> {
    await this.committed.write(async () => await setInventoryOf(this.db)
      .all({ id: id as MachineId, inventoryJson }), 'upsert')
  }

  /** Persist a compatibility-path build report. */
  async setMachineBuild(
    id: string,
    build: PeerBuild,
    caps: string[],
    at: string,
    source?: MachinePresenceSource,
  ): Promise<void> {
    await this.committed.write(async () => await setBuildOf(this.db).all({
      id: id as MachineId,
      appVersion: build.appVersion ?? null,
      wireSchemaDigest: build.wireSchemaDigest ?? null,
      installKind: build.installKind ?? null,
      deliveryCapsJson: JSON.stringify(caps),
      source: source ?? null,
      at,
    }), 'upsert')
  }

  /** One supervisor report atomically owns presence, build and service truth. */
  async setSupervisorPresence(
    id: string,
    build: PeerBuild,
    caps: string[],
    services: MachineServiceReport,
    at: string,
  ): Promise<void> {
    await this.committed.write(async () => await setSupervisorPresenceOf(this.db).all({
      id: id as MachineId,
      appVersion: build.appVersion ?? null,
      wireSchemaDigest: build.wireSchemaDigest ?? null,
      installKind: build.installKind ?? null,
      deliveryCapsJson: JSON.stringify(caps),
      serviceReportJson: JSON.stringify(services),
      at,
    }), 'upsert')
  }

  async setServiceAssignment(id: string, assignment: MachineServiceAssignment, evidence: z.infer<typeof AssignmentEvidence> = { version: 1, source: 'assignment', requestId: id }): Promise<void> {
    MachineServiceAssignment.parse(assignment)
    AssignmentEvidence.parse(evidence)
    await this.committed.write(async () => await setServiceAssignmentOf(this.db).all({
      id: id as MachineId,
      serviceAssignmentJson: JSON.stringify(assignment),
      assignmentEvidenceJson: JSON.stringify(evidence),
    }), 'upsert')
  }

  /** The server-bit guard and replacement share a transaction with transfer. */
  async replaceExecutionAssignment(id: string, assignment: MachineServiceAssignment,
    evidence: z.infer<typeof AssignmentEvidence>): Promise<'updated' | 'missing' | 'server-transfer-required'> {
    return this.createOrJoinTransaction(async () => {
      const row = await this.getMachine(id)
      if (!row || row.revokedAt) return 'missing'
      if (row.serviceAssignment.server !== assignment.server) return 'server-transfer-required'
      await this.setServiceAssignment(id, assignment, evidence)
      return 'updated'
    })
  }

  /** Move only the server bit. S5 moves the caller out of boot provisioning. */
  async transferServerAssignment(sourceId: string, targetId: string, requestId: string): Promise<void> {
    await this.createOrJoinTransaction(async () => {
      const source = await this.getMachine(sourceId)
      const target = await this.getMachine(targetId)
      if (!source || source.revokedAt || !target || target.revokedAt) throw new Error('server transfer requires both enrolled machines')
      const evidence = { version: 1 as const, source: 'server-transfer', requestId }
      await this.setServiceAssignment(sourceId, { ...source.serviceAssignment, server: false }, evidence)
      await this.setServiceAssignment(targetId, { ...target.serviceAssignment, server: true }, evidence)
    })
  }

  async setPresenceSource(id: string, source: MachinePresenceSource): Promise<void> {
    await this.committed.write(async () => await setPresenceSourceOf(this.db)
      .all({ id: id as MachineId, presenceSource: source }), 'upsert')
  }

  /** Constant-time token comparison using sha-256 hex. */
  async getMachineByToken(id: string, token: string): Promise<boolean> {
    const row = await tokenFactsOf(this.db).get({ id: id as MachineId })
    if (!row || row.revokedAt !== null || row.kind !== 'bearer-hash' || row.publicKey !== null || !row.tokenHash) return false
    const a = Buffer.from(createHash('sha256').update(token).digest('hex'))
    const b = Buffer.from(row.tokenHash)
    return a.length === b.length && timingSafeEqual(a, b)
  }

  /** The stored discriminator is authoritative; never attempt another credential kind. */
  async verifyMachineSignature(id: MachineId, transcript: string, signature: string): Promise<boolean> {
    const row = await machineRowById(this.db).get({ id })
    return !!row && row.revokedAt === null && row.credentialKind === 'ed25519'
      && row.tokenHash === '' && row.publicKey !== null
      && verifyWithMachineKey(row.publicKey, transcript, signature)
  }

  /** New-key possession permits a lost-ack retry; replacement itself is a CAS.
   * The wire public key is the key id, so an id cannot be rebound to other bytes. */
  async rotateCredential(id: MachineId, rotation: MachineCredentialRotation, transcript: string): Promise<boolean> {
    if (rotation.newKeyId !== rotation.newPublicKey
      || !verifyWithMachineKey(rotation.newPublicKey, transcript, rotation.newSignature)) return false
    const row = await machineRowById(this.db).get({ id })
    if (!row || row.revokedAt !== null || row.supersededBy !== null) return false
    if (row.credentialKind === 'ed25519' && row.tokenHash === '' && row.publicKey === rotation.newPublicKey) return true
    const previous = rotation.previous
    if (previous.kind === 'ed25519') {
      if (row.credentialKind !== 'ed25519' || row.tokenHash !== '' || row.publicKey !== previous.publicKey
        || !verifyWithMachineKey(previous.publicKey, transcript, previous.signature)) return false
    } else {
      if (row.credentialKind !== 'bearer-hash' || row.publicKey !== null || !row.tokenHash) return false
      const hash = Buffer.from(createHash('sha256').update(previous.token).digest('hex'))
      const expected = Buffer.from(row.tokenHash)
      if (hash.length !== expected.length || !timingSafeEqual(hash, expected)) return false
    }
    const result = await this.committed.write(async () =>
      await rotateCredentialOf(this.db, row.publicKey === null ? 'null' : 'key').all({
        id,
        newPublicKey: rotation.newPublicKey,
        credentialKind: row.credentialKind,
        tokenHash: row.tokenHash,
        ...(row.publicKey === null ? {} : { publicKey: row.publicKey }),
      }), 'upsert')
    // A simultaneous retry of the same intent may have won the CAS.
    return result.changes === 1 || await this.verifyMachineSignature(id, transcript, rotation.newSignature)
  }

  /**
   * Re-key the server host's own pre-enrollment row (POD-5931).
   *
   * Releases before setup enrollment authenticated the host's local daemon with the
   * same-host bootstrap secret and stored its row as `bearer-hash`. That secret is no
   * longer a machine credential, so an upgraded host would otherwise keep a row nothing
   * can authenticate as. The caller has already proved the id is THIS host's (it comes
   * from the server's own state dir); this CAS only ever moves a live, unsuperseded
   * bearer row onto a key, never one that already carries a key. Retrying with the
   * same key after a lost acknowledgement answers true.
   */
  async adoptLegacyHostCredential(id: MachineId, publicKey: string,
    assignment: MachineServiceAssignment, evidence: z.infer<typeof AssignmentEvidence>): Promise<boolean> {
    MachineServiceAssignment.parse(assignment)
    AssignmentEvidence.parse(evidence)
    const row = await machineRowById(this.db).get({ id })
    if (!row || row.revokedAt !== null || row.supersededBy !== null) return false
    if (row.credentialKind === 'ed25519') return row.tokenHash === '' && row.publicKey === publicKey
    if (row.credentialKind !== 'bearer-hash' || row.publicKey !== null) return false
    const result = await this.committed.write(async () => await adoptHostCredentialOf(this.db).all({
      id,
      publicKey,
      serviceAssignmentJson: JSON.stringify(assignment),
      assignmentEvidenceJson: JSON.stringify(evidence),
      tokenHash: row.tokenHash,
    }), 'upsert')
    return result.changes === 1
  }

  /** Persist the operator-selected update authority for one managed machine.
   *  `null` clears the pin and returns the machine to the fleet default (POD-1882). */
  async setUpdateChannel(id: string, channel: UpdateChannelValue | null): Promise<void> {
    await this.committed.write(async () => await setUpdateChannelOf(this.db)
      .all({ id: id as MachineId, channel }), 'upsert')
  }

  async renameMachine(id: string, name: string): Promise<void> {
    await this.committed.write(async () => await renameMachineOf(this.db)
      .all({ id: id as MachineId, name }), 'upsert')
  }

  /** Custody is queried from its sole manage edge; never inferred from a row. */
  async custodian(id: string): Promise<UserId | null> {
    const edge = await custodianOf(this.db).get({ id })
    return edge ? edge.grantee as UserId : null
  }

  /** Change personal custody and its rights in the same transaction. Existing
   * shares remain records; without a custody edge they confer no machine access. */
  async setMachineOwner(id: string, grantee: UserId | null): Promise<void> {
    await this.createOrJoinTransaction(async () => {
      const machine = await this.getMachine(id)
      if (!machine || machine.revokedAt) return
      const previous = await this.custodian(id)
      if (previous === grantee) return
      if (previous) {
        await this.grantRepository.remove('machine', id, previous, 'use')
        await this.grantRepository.remove('machine', id, previous, 'manage')
      }
      if (grantee) {
        for (const verb of ['use', 'manage'] as const) await this.grantRepository.upsert({
          resourceKind: 'machine', resourceId: id, grantee, verb, custody: verb === 'manage',
          owner: grantee, visibility: 'owned-compute', createdAt: new Date().toISOString(),
          actorKind: 'user', actorId: grantee, onBehalfOf: grantee,
        })
      }
    })
  }

  /** Internal credential identity used to scope a replacement code; never projected. */
  async credentialIncarnation(id: MachineId): Promise<string | undefined> {
    const row = await machineRowById(this.db).get({ id })
    if (!row) return undefined
    return row.credentialKind === 'ed25519' && row.tokenHash === '' ? row.publicKey ?? undefined
      : row.credentialKind === 'bearer-hash' && row.publicKey === null ? row.tokenHash : undefined
  }

  /** One winner: ordinary enrollment cannot overwrite an existing identity. */
  async enrollMachine(m: {
    id: MachineId; name: string; hostname: string; tokenHash: string;
    credentialKind?: 'bearer-hash' | 'ed25519'; publicKey?: string | null;
    ownerUserId: UserId | null; podiumManaged: boolean;
    assignment: MachineServiceAssignment; assignmentEvidence: z.infer<typeof AssignmentEvidence>;
  }, replaceRevokedAt?: string, replaceIncarnation?: string): Promise<boolean> {
    const now = new Date().toISOString()
    return this.createOrJoinTransaction(async () => {
      const { assignment, assignmentEvidence, ownerUserId, ...identity } = m
      const enrollment = { ...identity, credentialKind: identity.credentialKind ?? 'bearer-hash' as const, publicKey: identity.publicKey ?? null, serviceAssignmentJson: JSON.stringify(MachineServiceAssignment.parse(assignment)), assignmentEvidenceJson: JSON.stringify(AssignmentEvidence.parse(assignmentEvidence)) }
      const values = {
        id: enrollment.id,
        name: enrollment.name,
        hostname: enrollment.hostname,
        tokenHash: enrollment.tokenHash,
        podiumManaged: enrollment.podiumManaged,
        credentialKind: enrollment.credentialKind,
        publicKey: enrollment.publicKey,
        serviceAssignmentJson: enrollment.serviceAssignmentJson,
        assignmentEvidenceJson: enrollment.assignmentEvidenceJson,
        now,
      }
      const result = await this.committed.write(async () => replaceRevokedAt === undefined
        ? await insertEnrollment(this.db).all(values)
        : await replaceRevokedEnrollment(this.db).all({
            ...values,
            replaceRevokedAt,
            replaceIncarnation: replaceIncarnation ?? '',
          }), 'upsert')
      if (result.changes === 1) {
        await this.grantRepository.removeAllForResource('machine', m.id)
        if (ownerUserId) await this.setMachineOwner(m.id, ownerUserId)
      }
      return result.changes === 1
    })
  }

  /** Supersession is terminal, including for previously issued replacement codes. */
  async supersedeMachine(id: MachineId, replacementId: MachineId): Promise<void> {
    await this.committed.write(async () => await supersedeMachineOf(this.db)
      .all({ id, replacementId, now: new Date().toISOString() }), 'upsert')
  }

  /** Retain identity and attribution while permanently refusing this credential. */
  async revokeMachine(id: MachineId): Promise<void> {
    await this.committed.write(async () => await revokeMachineOf(this.db)
      .all({ id, now: new Date().toISOString() }), 'upsert')
  }

  async deleteMachine(id: string): Promise<void> {
    await this.committed.write(async () => await deleteMachineOf(this.db)
      .all({ id: id as MachineId }), 'delete')
  }

  async touchMachine(id: string, hostname: string): Promise<void> {
    await this.committed.write(async () => await touchMachineOf(this.db)
      .all({ id: id as MachineId, now: new Date().toISOString(), hostname }), 'upsert')
  }
}
