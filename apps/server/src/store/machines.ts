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
import { and, asc, eq, isNull, sql } from 'drizzle-orm'
import { machines, grants } from '../migrations/schema'
import { GrantsRepository } from './grants'
import type { StoreDrizzle, StoreQueries, TransactionRunner } from './executor/sync-drizzle'
import { currentTransaction } from './executor/sync-drizzle'
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
  'approval_requests.machine_id',
  'conversation_segment_incarnations.machine_id',
  'conversation_segments.machine_id',
  'conversations.machine_id',
  'execution_profiles.machine_id',
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
    return currentTransaction() ?? this.rootDb
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
    const sentinels = RETIRED_MACHINE_SENTINELS.map((v) => `'${v}'`).join(', ')
    const arms = MACHINE_ID_SITES.map((site) => {
      const [table, column] = site.split('.')
      return `SELECT '${site}' AS site WHERE EXISTS (SELECT 1 FROM "${table}" WHERE "${column}" IN (${sentinels}))`
    })
    // CONSTANT-IDENTIFIER STATEMENT POD-3404 — a WHOLE statement, which rule 1 allows only behind the
    // search port and which this is not. Converted in the most literal form
    // pending the rule: the identifiers are the `MACHINE_ID_SITES` source
    // constant, never user input, and `machines-sentinel-scan.test.ts` derives
    // the same set from the schema and fails if a table grows a machine column
    // without appearing there. One statement rather than fourteen is the
    // method's own documented choice about round trips, not an accident.
    const statement = arms.join('\nUNION ALL\n')
    const rows = await this.db.all<{ site: string }>(sql.raw(statement)) // CONSTANT-IDENTIFIER STATEMENT POD-3404
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
      const result = await this.committed.write(async () => (this.db
        .insert(machines)
        .values({
          // EXTERNAL INPUT BRAND DECODE: daemon enrollment supplies its proposed
          // id as a string; the repository is the write boundary that brands it.
          id: m.id as MachineId,
          name: m.name,
          hostname: m.hostname,
          tokenHash: m.tokenHash,
          createdAt: now,
          lastSeenAt: now,
          podiumManaged: m.podiumManaged ?? true,
          serviceAssignmentJson: JSON.stringify(m.assignment ?? { server: false, agentExecution: false }),
          assignmentEvidenceJson: JSON.stringify(m.assignmentEvidence ?? { version: 1, source: 'enrollment', requestId: m.id }),
        }))
        .onConflictDoUpdate({
          target: machines.id,
          setWhere: and(isNull(machines.revokedAt), eq(machines.credentialKind, 'bearer-hash'), isNull(machines.publicKey)),
          set: {
            name: m.name,
            hostname: m.hostname,
            tokenHash: m.tokenHash,
            lastSeenAt: now,
            podiumManaged: m.podiumManaged ?? true,
          },
        }).returning().all(), 'upsert')
      if (result.changes === 1 && m.ownerUserId && await this.custodian(m.id) === null) await this.setMachineOwner(m.id, m.ownerUserId)
    })
  }

  async listMachines(): Promise<MachineRecord[]> {
    return (await this.db
      .select(MACHINE_COLUMNS)
      .from(machines)
      .orderBy(asc(machines.createdAt))
      .all())
      .map(machineRecordFromRow)
  }

  async getMachine(id: string): Promise<MachineRecord | undefined> {
    const r = await this.db
      .select(MACHINE_COLUMNS)
      .from(machines)
      .where(eq(machines.id, id as MachineId))
      .get()
    if (!r) return undefined
    return machineRecordFromRow(r)
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
    await this.committed.write(async () => this.db.update(machines)
      .set({ availabilityJson: JSON.stringify(value) })
      .where(and(eq(machines.id, id as MachineId), isNull(machines.revokedAt))).returning().all(), 'upsert')
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
    const document = sql`coalesce(${machines.harnessVersionsJson}, '{}')`
    const previousFirst = sql`json_extract(${document}, ${`${path}.firstSeen`})`
    const previousLast = sql`json_extract(${document}, ${`${path}.lastSeen`})`
    await this.committed.write(
      async () =>
        this.db
          .update(machines)
          .set({
            harnessVersionsJson: sql`json_set(${document}, ${path}, json_object(
        'harness', ${report.harness},
        'version', case when ${previousLast} > ${report.probedAt}
          then json_extract(${document}, ${`${path}.version`}) else ${report.version} end,
        'firstSeen', min(coalesce(${previousFirst}, ${report.probedAt}), ${report.probedAt}),
        'lastSeen', max(coalesce(${previousLast}, ${report.probedAt}), ${report.probedAt})
      ))`,
          })
          .where(and(eq(machines.id, id), isNull(machines.revokedAt)))
          .returning()
          .all(),
      'upsert',
    )
  }

  /** Persist a daemon-reported inventory (#222) as the raw JSON blob. */
  async setMachineInventory(id: string, inventoryJson: string): Promise<void> {
    await this.committed.write(async () => this.db
      .update(machines)
      .set({ inventoryJson })
      .where(and(eq(machines.id, id as MachineId), isNull(machines.revokedAt))).returning().all(), 'upsert')
  }

  /** Persist a compatibility-path build report. */
  async setMachineBuild(
    id: string,
    build: PeerBuild,
    caps: string[],
    at: string,
    source?: MachinePresenceSource,
  ): Promise<void> {
    await this.committed.write(async () => this.db
      .update(machines)
      .set({
        appVersion: build.appVersion ?? null,
        wireSchemaDigest: build.wireSchemaDigest ?? null,
        installKind: build.installKind ?? null,
        deliveryCapsJson: JSON.stringify(caps),
        // COALESCE, not a plain write: a report without a source must LEAVE the
        // recorded presence alone rather than clearing it.
        presenceSource: sql`COALESCE(${source ?? null}, ${machines.presenceSource})`,
        buildReportedAt: at,
      })
      .where(and(eq(machines.id, id as MachineId), isNull(machines.revokedAt))).returning().all(), 'upsert')
  }

  /** One supervisor report atomically owns presence, build and service truth. */
  async setSupervisorPresence(
    id: string,
    build: PeerBuild,
    caps: string[],
    services: MachineServiceReport,
    at: string,
  ): Promise<void> {
    await this.committed.write(async () => this.db
      .update(machines)
      .set({
        appVersion: build.appVersion ?? null,
        wireSchemaDigest: build.wireSchemaDigest ?? null,
        installKind: build.installKind ?? null,
        deliveryCapsJson: JSON.stringify(caps),
        presenceSource: 'supervisor',
        serviceReportJson: JSON.stringify(services),
        buildReportedAt: at,
        lastSeenAt: at,
      })
      .where(and(eq(machines.id, id as MachineId), isNull(machines.revokedAt))).returning().all(), 'upsert')
  }

  async setServiceAssignment(id: string, assignment: MachineServiceAssignment, evidence: z.infer<typeof AssignmentEvidence> = { version: 1, source: 'assignment', requestId: id }): Promise<void> {
    MachineServiceAssignment.parse(assignment)
    AssignmentEvidence.parse(evidence)
    await this.committed.write(async () => this.db
      .update(machines)
      .set({ serviceAssignmentJson: JSON.stringify(assignment), assignmentEvidenceJson: JSON.stringify(evidence) })
      .where(and(eq(machines.id, id as MachineId), isNull(machines.revokedAt))).returning().all(), 'upsert')
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
    await this.committed.write(async () => this.db
      .update(machines)
      .set({ presenceSource: source })
      .where(and(eq(machines.id, id as MachineId), isNull(machines.revokedAt))).returning().all(), 'upsert')
  }

  /** Constant-time token comparison using sha-256 hex. */
  async getMachineByToken(id: string, token: string): Promise<boolean> {
    const row = await this.db
      .select({ tokenHash: machines.tokenHash, revokedAt: machines.revokedAt, kind: machines.credentialKind, publicKey: machines.publicKey })
      .from(machines)
      .where(and(eq(machines.id, id as MachineId), isNull(machines.revokedAt)))
      .get()
    if (!row || row.revokedAt !== null || row.kind !== 'bearer-hash' || row.publicKey !== null || !row.tokenHash) return false
    const a = Buffer.from(createHash('sha256').update(token).digest('hex'))
    const b = Buffer.from(row.tokenHash)
    return a.length === b.length && timingSafeEqual(a, b)
  }

  /** The stored discriminator is authoritative; never attempt another credential kind. */
  async verifyMachineSignature(id: MachineId, transcript: string, signature: string): Promise<boolean> {
    const row = await this.db.select().from(machines).where(eq(machines.id, id)).get()
    return !!row && row.revokedAt === null && row.credentialKind === 'ed25519'
      && row.tokenHash === '' && row.publicKey !== null
      && verifyWithMachineKey(row.publicKey, transcript, signature)
  }

  /** New-key possession permits a lost-ack retry; replacement itself is a CAS.
   * The wire public key is the key id, so an id cannot be rebound to other bytes. */
  async rotateCredential(id: MachineId, rotation: MachineCredentialRotation, transcript: string): Promise<boolean> {
    if (rotation.newKeyId !== rotation.newPublicKey
      || !verifyWithMachineKey(rotation.newPublicKey, transcript, rotation.newSignature)) return false
    const row = await this.db.select().from(machines).where(eq(machines.id, id)).get()
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
    const result = await this.committed.write(async () => this.db.update(machines)
      .set({ credentialKind: 'ed25519', tokenHash: '', publicKey: rotation.newPublicKey })
      .where(and(eq(machines.id, id), isNull(machines.revokedAt), isNull(machines.supersededBy),
        eq(machines.credentialKind, row.credentialKind), eq(machines.tokenHash, row.tokenHash),
        row.publicKey === null ? isNull(machines.publicKey) : eq(machines.publicKey, row.publicKey)))
      .returning().all(), 'upsert')
    // A simultaneous retry of the same intent may have won the CAS.
    return result.changes === 1 || await this.verifyMachineSignature(id, transcript, rotation.newSignature)
  }

  /** Persist the operator-selected update authority for one managed machine.
   *  `null` clears the pin and returns the machine to the fleet default (POD-1882). */
  async setUpdateChannel(id: string, channel: UpdateChannelValue | null): Promise<void> {
    await this.committed.write(async () => this.db
      .update(machines)
      .set({ updateChannelOverride: channel })
      .where(and(eq(machines.id, id as MachineId), isNull(machines.revokedAt))).returning().all(), 'upsert')
  }

  async renameMachine(id: string, name: string): Promise<void> {
    await this.committed.write(async () => this.db
      .update(machines)
      .set({ name })
      .where(and(eq(machines.id, id as MachineId), isNull(machines.revokedAt))).returning().all(), 'upsert')
  }

  /** Custody is queried from its sole manage edge; never inferred from a row. */
  async custodian(id: string): Promise<UserId | null> {
    const edge = await this.db.select({ grantee: grants.grantee }).from(grants)
      .where(and(eq(grants.resourceKind, 'machine'), eq(grants.resourceId, id), eq(grants.verb, 'manage'), eq(grants.custody, true))).get()
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
    const row = await this.db.select().from(machines).where(eq(machines.id, id)).get()
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
      const result = await this.committed.write(async () => replaceRevokedAt === undefined
        ? this.db.insert(machines).values({ ...enrollment, createdAt: now, lastSeenAt: now })
          .onConflictDoNothing().returning().all()
        : this.db.update(machines).set({ ...enrollment, revokedAt: null, availabilityJson: null, lastSeenAt: now,
            inventoryJson: null, harnessVersionsJson: null, serviceReportJson: null,
            appVersion: null, wireSchemaDigest: null, deliveryCapsJson: null,
            presenceSource: null, buildReportedAt: null })
          .where(and(eq(machines.id, m.id), eq(machines.revokedAt, replaceRevokedAt), isNull(machines.supersededBy), sql`CASE WHEN ${machines.credentialKind} = 'ed25519' THEN ${machines.publicKey} ELSE ${machines.tokenHash} END = ${replaceIncarnation ?? ''}`))
          .returning().all(), 'upsert')
      if (result.changes === 1) {
        await this.grantRepository.removeAllForResource('machine', m.id)
        if (ownerUserId) await this.setMachineOwner(m.id, ownerUserId)
      }
      return result.changes === 1
    })
  }

  /** Supersession is terminal, including for previously issued replacement codes. */
  async supersedeMachine(id: MachineId, replacementId: MachineId): Promise<void> {
    await this.committed.write(async () => this.db.update(machines)
      .set({ supersededBy: replacementId,
        revokedAt: sql`COALESCE(${machines.revokedAt}, ${new Date().toISOString()})`, availabilityJson: null })
      .where(eq(machines.id, id)).returning().all(), 'upsert')
  }

  /** Retain identity and attribution while permanently refusing this credential. */
  async revokeMachine(id: MachineId): Promise<void> {
    await this.committed.write(async () => this.db
      .update(machines)
      .set({ revokedAt: sql`COALESCE(${machines.revokedAt}, ${new Date().toISOString()})`, availabilityJson: null })
      .where(eq(machines.id, id)).returning().all(), 'upsert')
  }

  async deleteMachine(id: string): Promise<void> {
    await this.committed.write(async () => this.db
      .delete(machines)
      .where(eq(machines.id, id as MachineId)).returning().all(), 'delete')
  }

  async touchMachine(id: string, hostname: string): Promise<void> {
    await this.committed.write(async () => this.db
      .update(machines)
      .set({ lastSeenAt: new Date().toISOString(), hostname })
      .where(and(eq(machines.id, id as MachineId), isNull(machines.revokedAt))).returning().all(), 'upsert')
  }
}
