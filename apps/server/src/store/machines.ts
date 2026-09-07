/**
 * Machines aggregate — owns the `machines` table (registered daemons and
 * their token hashes).
 */

import { createHash, timingSafeEqual } from 'node:crypto'
import {
  Inventory,
  MachineComponent,
  MachinePresenceSource,
  MachineServiceAssignment,
  MachineServiceReport,
  type MachineId,
  UpdateChannel,
  type UpdateChannel as UpdateChannelValue,
  type UserId,
} from '@podium/model'
import type { PeerBuild } from '@podium/protocol'
import { asc, eq, sql } from 'drizzle-orm'
import { machines } from '../migrations/schema'
import type { StoreQueries, StoreDrizzle, TransactionRunner } from './executor/sync-drizzle'
import { currentTransaction } from './executor/sync-drizzle'
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

function parseAssignment(raw: unknown): MachineServiceAssignment {
  if (typeof raw === 'string') {
    try {
      const parsed = MachineServiceAssignment.safeParse(JSON.parse(raw))
      if (parsed.success) return parsed.data
    } catch {}
  }
  return { server: false, agentExecution: true }
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
 * Defensive parse of a stored components blob (POD-2700).
 *
 * Distinguishes the three answers the column can hold, and never invents the
 * permissive one: NULL / absent → `null` (not recorded, refuses nothing); a
 * valid array → itself, unknown members dropped so a downgrade from a future
 * server that added a component reads the ones it knows; UNPARSEABLE → `null`
 * rather than `[]`, because a corrupt blob is a thing we do not know, and
 * answering "runs nothing" would blank the machine out of every picker on the
 * strength of a JSON error.
 */
function parseComponents(raw: unknown): MachineComponent[] | null {
  if (typeof raw !== 'string' || raw.length === 0) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return null
    return parsed.filter((c): c is MachineComponent => MachineComponent.safeParse(c).success)
  } catch {
    return null
  }
}

/**
 * WHAT STILL NEEDS MAPPING [spec §6 rules 3, 4 and 6].
 *
 * Drizzle returns the schema's TypeScript names, the `MachineId` and `UserId`
 * brands, and the two `integer({ mode: 'boolean' })` columns as booleans, so the
 * per-column decode this file used to carry is gone. What remains is defensive
 * PARSING of three text blobs and two nullability decisions, and every one of
 * them is a decision the file already documents rather than a driver artefact —
 * see `parseInventory`, `parseCaps`, `parseComponents` and the comments below.
 */
type MachineSelect = Pick<
  typeof machines.$inferSelect,
  | 'id'
  | 'name'
  | 'hostname'
  | 'createdAt'
  | 'lastSeenAt'
  | 'inventoryJson'
  | 'ownerUserId'
  | 'appVersion'
  | 'wireSchemaDigest'
  | 'installKind'
  | 'deliveryCapsJson'
  | 'presenceSource'
  | 'serviceAssignmentJson'
  | 'serviceReportJson'
  | 'buildReportedAt'
  | 'podiumManaged'
  | 'updateChannelOverride'
  | 'componentsJson'
>

/** The columns every machine read projects — the same list, spelled once. */
const MACHINE_COLUMNS = {
  id: machines.id,
  name: machines.name,
  hostname: machines.hostname,
  createdAt: machines.createdAt,
  lastSeenAt: machines.lastSeenAt,
  inventoryJson: machines.inventoryJson,
  ownerUserId: machines.ownerUserId,
  appVersion: machines.appVersion,
  wireSchemaDigest: machines.wireSchemaDigest,
  installKind: machines.installKind,
  deliveryCapsJson: machines.deliveryCapsJson,
  presenceSource: machines.presenceSource,
  serviceAssignmentJson: machines.serviceAssignmentJson,
  serviceReportJson: machines.serviceReportJson,
  buildReportedAt: machines.buildReportedAt,
  podiumManaged: machines.podiumManaged,
  updateChannelOverride: machines.updateChannelOverride,
  componentsJson: machines.componentsJson,
}

function toRecord(r: MachineSelect): MachineRecord {
  const inventory = parseInventory(r.inventoryJson)
  return {
    id: r.id,
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
    // POD-1079: no `??` fallback. A row whose column is NULL reads back as
    // unowned, and unowned refuses `use` to everyone — substituting an owner
    // here would be the fail-open shape the nullable column exists to avoid.
    ownerUserId: r.ownerUserId ?? null,
    appVersion: r.appVersion,
    wireSchemaDigest: r.wireSchemaDigest,
    installKind: r.installKind,
    deliveryCaps: parseCaps(r.deliveryCapsJson),
    presenceSource: parsePresenceSource(r.presenceSource),
    serviceAssignment: parseAssignment(r.serviceAssignmentJson),
    serviceReport: parseServiceReport(r.serviceReportJson),
    buildReportedAt: r.buildReportedAt,
    components: parseComponents(r.componentsJson),
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
  private readonly rootDb: StoreDrizzle
  protected readonly createOrJoinTransaction: TransactionRunner

  constructor(queries: StoreQueries) {
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

  /**
   * Register or refresh a machine row.
   *
   * `ownerUserId` is REQUIRED at the type level (POD-1079) — every caller must
   * say who a machine belongs to, and `null` is the way to say "nobody", which
   * refuses `use` to everyone rather than admitting everyone. An optional field
   * would let a new pairing path forget, and forgetting would read as unowned
   * only by luck.
   *
   * ON CONFLICT KEEPS AN OWNER THAT ALREADY EXISTS (`COALESCE`). A returning
   * daemon's `hello`, a boot-time `ensureHostMachine` and a re-pair all run
   * through here, and none of them is an ownership TRANSFER: letting the latest
   * writer win would make re-pairing a silent take-over of somebody else's
   * machine. It fills a NULL, so a row written before this column existed
   * acquires an owner the first time its owner touches it.
   */
  async upsertMachine(m: {
    id: string
    name: string
    hostname: string
    tokenHash: string
    ownerUserId: UserId | null
    podiumManaged?: boolean
  }): Promise<void> {
    const now = new Date().toISOString()
    ;await (this.db
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
        ownerUserId: m.ownerUserId,
        podiumManaged: m.podiumManaged ?? true,
      }))
      .onConflictDoUpdate({
        target: machines.id,
        set: {
          name: m.name,
          hostname: m.hostname,
          tokenHash: m.tokenHash,
          lastSeenAt: now,
          // KEEPS AN OWNER THAT ALREADY EXISTS. `sql` fragment because the value
          // is the EXISTING column, which `set` has no other way to name: a
          // returning hello, a boot ensureHostMachine and a re-pair all land
          // here and none of them is an ownership transfer.
          ownerUserId: sql`COALESCE(${machines.ownerUserId}, ${m.ownerUserId})`,
          podiumManaged: m.podiumManaged ?? true,
        },
      })
      .run()
  }

  async listMachines(): Promise<MachineRecord[]> {
    return (await this.db
      .select(MACHINE_COLUMNS)
      .from(machines)
      .orderBy(asc(machines.createdAt))
      .all())
      .map(toRecord)
  }

  async getMachine(id: string): Promise<MachineRecord | undefined> {
    const r = await this.db
      .select(MACHINE_COLUMNS)
      .from(machines)
      .where(eq(machines.id, id as MachineId))
      .get()
    if (!r) return undefined
    return toRecord(r)
  }

  /**
   * ADD one durable component to a machine, idempotently (POD-2700).
   *
   * ADDITIVE, and read-modify-write on purpose. The two writers answer different
   * questions and neither knows the other's answer: the server stamps `server`
   * on its own host row at boot, and a daemon handshake stamps `daemon` — on the
   * SAME row when the coordinator also runs a daemon, which is the ordinary
   * single-box install. A last-writer-wins `SET` would make the host machine
   * flip between "server" and "daemon" depending on boot order, and a
   * repo-hosting box would lose its repo capability every time the server
   * restarted. Removal is not an operation here: components die with the machine
   * row (§1.3 — revoke is the retirement path, not a per-component TTL).
   *
   * Returns whether the row actually changed, so the caller can skip a broadcast
   * on the overwhelmingly common no-op (every hello re-stamps `daemon`).
   */
  async addMachineComponent(id: string, component: MachineComponent): Promise<boolean> {
    const row = await this.db
      .select({ componentsJson: machines.componentsJson })
      .from(machines)
      .where(eq(machines.id, id as MachineId))
      .get()
    if (!row) return false
    const current = parseComponents(row.componentsJson) ?? []
    if (current.includes(component)) return false
    const next = [...current, component]
    await this.db
      .update(machines)
      .set({ componentsJson: JSON.stringify(next) })
      .where(eq(machines.id, id as MachineId))
      .run()
    return true
  }

  /** Persist a daemon-reported inventory (#222) as the raw JSON blob. */
  async setMachineInventory(id: string, inventoryJson: string): Promise<void> {
    await this.db
      .update(machines)
      .set({ inventoryJson })
      .where(eq(machines.id, id as MachineId))
      .run()
  }

  /** Persist a compatibility-path build report. */
  async setMachineBuild(
    id: string,
    build: PeerBuild,
    caps: string[],
    at: string,
    source?: MachinePresenceSource,
  ): Promise<void> {
    await this.db
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
      .where(eq(machines.id, id as MachineId))
      .run()
  }

  /** One supervisor report atomically owns presence, build and service truth. */
  async setSupervisorPresence(
    id: string,
    build: PeerBuild,
    caps: string[],
    services: MachineServiceReport,
    at: string,
  ): Promise<void> {
    await this.db
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
      .where(eq(machines.id, id as MachineId))
      .run()
  }

  async setServiceAssignment(id: string, assignment: MachineServiceAssignment): Promise<void> {
    await this.db
      .update(machines)
      .set({ serviceAssignmentJson: JSON.stringify(assignment) })
      .where(eq(machines.id, id as MachineId))
      .run()
  }

  async setPresenceSource(id: string, source: MachinePresenceSource): Promise<void> {
    await this.db
      .update(machines)
      .set({ presenceSource: source })
      .where(eq(machines.id, id as MachineId))
      .run()
  }

  /** Constant-time token comparison using sha-256 hex. */
  async getMachineByToken(id: string, token: string): Promise<boolean> {
    const row = await this.db
      .select({ tokenHash: machines.tokenHash })
      .from(machines)
      .where(eq(machines.id, id as MachineId))
      .get()
    if (!row) return false
    const a = Buffer.from(createHash('sha256').update(token).digest('hex'))
    const b = Buffer.from(row.tokenHash)
    return a.length === b.length && timingSafeEqual(a, b)
  }

  /** Persist the operator-selected update authority for one managed machine.
   *  `null` clears the pin and returns the machine to the fleet default (POD-1882). */
  async setUpdateChannel(id: string, channel: UpdateChannelValue | null): Promise<void> {
    await this.db
      .update(machines)
      .set({ updateChannelOverride: channel })
      .where(eq(machines.id, id as MachineId))
      .run()
  }

  async renameMachine(id: string, name: string): Promise<void> {
    await this.db
      .update(machines)
      .set({ name })
      .where(eq(machines.id, id as MachineId))
      .run()
  }

  /**
   * Force-write the owner projection (POD-1114 / D19.4d). Unlike
   * {@link upsertMachine}'s `COALESCE`, this is the path that applies a ledger
   * owner transition: the ledger append is the commit point, and this method
   * projects it onto the row. `null` is quarantine (usable by nobody).
   */
  async setMachineOwner(id: string, ownerUserId: UserId | null): Promise<void> {
    await this.db
      .update(machines)
      .set({ ownerUserId })
      .where(eq(machines.id, id as MachineId))
      .run()
  }

  async deleteMachine(id: string): Promise<void> {
    await this.db
      .delete(machines)
      .where(eq(machines.id, id as MachineId))
      .run()
  }

  async touchMachine(id: string, hostname: string): Promise<void> {
    await this.db
      .update(machines)
      .set({ lastSeenAt: new Date().toISOString(), hostname })
      .where(eq(machines.id, id as MachineId))
      .run()
  }
}
