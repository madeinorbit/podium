/**
 * Machines aggregate — owns the `machines` table (registered daemons and
 * their token hashes).
 */

import { createHash, timingSafeEqual } from 'node:crypto'
import {
  asUserId,
  Inventory,
  MachineComponent,
  type MachineId,
  UpdateChannel,
  type UpdateChannel as UpdateChannelValue,
  type UserId,
} from '@podium/model'
import type { PeerBuild } from '@podium/protocol'
import type { SqlDatabase } from '@podium/runtime/sqlite'
import { legacyHandle, type QueryClient, type StoreExecutor } from './executor'
import type { MachineRecord } from './types'

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

function toRecord(r: Record<string, unknown>): MachineRecord {
  const inventory = parseInventory(r.inventory_json)
  return {
    // SERIALIZATION EDGE: untyped from sqlite; the machine id re-enters its id space.
    id: r.id as MachineId,
    name: r.name as string,
    hostname: r.hostname as string,
    createdAt: r.created_at as string,
    lastSeenAt: r.last_seen_at as string,
    podiumManaged: r.podium_managed === undefined ? true : Boolean(r.podium_managed),
    // POD-1882: null is MEANINGFUL — no per-machine pin, so this machine follows
    // the fleet default. `catch(null)` keeps an unreadable value reading as "not
    // pinned" rather than inventing a channel for it.
    updateChannelOverride: UpdateChannel.nullable()
      .catch(null)
      .parse(r.update_channel_override ?? null) as UpdateChannelValue | null,
    ...(inventory !== undefined ? { inventory } : {}),
    // POD-1079: no `??` fallback. A row whose column is NULL reads back as
    // unowned, and unowned refuses `use` to everyone — substituting an owner
    // here would be the fail-open shape the nullable column exists to avoid.
    ownerUserId: r.owner_user_id ? asUserId(r.owner_user_id as string) : null,
    appVersion: (r.app_version as string | null | undefined) ?? null,
    wireSchemaDigest: (r.wire_schema_digest as string | null | undefined) ?? null,
    installKind: (r.install_kind as string | null | undefined) ?? null,
    deliveryCaps: parseCaps(r.delivery_caps_json as string | null),
    // A row written before the column existed reads NULL → false, which is the
    // truthful answer: a supervised daemon re-asserts the flag on every hello.
    supervised: r.supervised === 1 || r.supervised === true,
    buildReportedAt: (r.build_reported_at as string | null | undefined) ?? null,
    components: parseComponents(r.components_json),
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
  private readonly db: SqlDatabase

  constructor(executor: StoreExecutor<QueryClient>) {
    this.db = legacyHandle(executor)
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
  legacyMachineSentinelSites(): string[] {
    const sentinels = RETIRED_MACHINE_SENTINELS.map((v) => `'${v}'`).join(', ')
    const arms = MACHINE_ID_SITES.map((site) => {
      const [table, column] = site.split('.')
      return `SELECT '${site}' AS site WHERE EXISTS (SELECT 1 FROM "${table}" WHERE "${column}" IN (${sentinels}))`
    })
    const rows = this.db.prepare(arms.join('\nUNION ALL\n')).all() as { site: string }[]
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
  upsertMachine(m: {
    id: string
    name: string
    hostname: string
    tokenHash: string
    ownerUserId: UserId | null
    podiumManaged?: boolean
  }): void {
    const now = new Date().toISOString()
    this.db
      .prepare(
        `INSERT INTO machines (id, name, hostname, token_hash, created_at, last_seen_at, owner_user_id, podium_managed)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           hostname = excluded.hostname,
           token_hash = excluded.token_hash,
           last_seen_at = excluded.last_seen_at,
           owner_user_id = COALESCE(machines.owner_user_id, excluded.owner_user_id),
           podium_managed = excluded.podium_managed`,
      )
      .run(m.id, m.name, m.hostname, m.tokenHash, now, now, m.ownerUserId, m.podiumManaged ?? true)
  }

  listMachines(): MachineRecord[] {
    return (
      this.db
        .prepare(
          'SELECT id, name, hostname, created_at, last_seen_at, inventory_json, owner_user_id, app_version, wire_schema_digest, install_kind, delivery_caps_json, supervised, build_reported_at, podium_managed, update_channel_override, components_json FROM machines ORDER BY created_at ASC',
        )
        .all() as Record<string, unknown>[]
    ).map(toRecord)
  }

  getMachine(id: string): MachineRecord | undefined {
    const r = this.db
      .prepare(
        'SELECT id, name, hostname, created_at, last_seen_at, inventory_json, owner_user_id, app_version, wire_schema_digest, install_kind, delivery_caps_json, supervised, build_reported_at, podium_managed, update_channel_override, components_json FROM machines WHERE id = ?',
      )
      .get(id) as Record<string, unknown> | undefined
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
  addMachineComponent(id: string, component: MachineComponent): boolean {
    const row = this.db.prepare('SELECT components_json FROM machines WHERE id = ?').get(id) as
      | { components_json: string | null }
      | undefined
    if (!row) return false
    const current = parseComponents(row.components_json) ?? []
    if (current.includes(component)) return false
    const next = [...current, component]
    this.db
      .prepare('UPDATE machines SET components_json = ? WHERE id = ?')
      .run(JSON.stringify(next), id)
    return true
  }

  /** Persist a daemon-reported inventory (#222) as the raw JSON blob. */
  setMachineInventory(id: string, inventoryJson: string): void {
    this.db.prepare('UPDATE machines SET inventory_json = ? WHERE id = ?').run(inventoryJson, id)
  }

  /** Persist the daemon's advisory build report and the capabilities it offered. */
  setMachineBuild(id: string, build: PeerBuild, caps: string[], at: string): void {
    this.db
      .prepare(
        'UPDATE machines SET app_version = ?, wire_schema_digest = ?, install_kind = ?, delivery_caps_json = ?, supervised = ?, build_reported_at = ? WHERE id = ?',
      )
      .run(
        build.appVersion ?? null,
        build.wireSchemaDigest ?? null,
        build.installKind ?? null,
        JSON.stringify(caps),
        // Written on EVERY report, not only when true: a machine that stops
        // being desktop-supervised (the app uninstalled, a standalone daemon
        // installed in its place) must lose the exclusion on its next hello.
        build.supervised === true ? 1 : 0,
        at,
        id,
      )
  }

  /** Constant-time token comparison using sha-256 hex. */
  getMachineByToken(id: string, token: string): boolean {
    const row = this.db.prepare('SELECT token_hash FROM machines WHERE id = ?').get(id) as
      | { token_hash: string }
      | undefined
    if (!row) return false
    const a = Buffer.from(createHash('sha256').update(token).digest('hex'))
    const b = Buffer.from(row.token_hash)
    return a.length === b.length && timingSafeEqual(a, b)
  }

  /** Persist the operator-selected update authority for one managed machine.
   *  `null` clears the pin and returns the machine to the fleet default (POD-1882). */
  setUpdateChannel(id: string, channel: UpdateChannelValue | null): void {
    this.db.prepare('UPDATE machines SET update_channel_override = ? WHERE id = ?').run(channel, id)
  }

  renameMachine(id: string, name: string): void {
    this.db.prepare('UPDATE machines SET name = ? WHERE id = ?').run(name, id)
  }

  /**
   * Force-write the owner projection (POD-1114 / D19.4d). Unlike
   * {@link upsertMachine}'s `COALESCE`, this is the path that applies a ledger
   * owner transition: the ledger append is the commit point, and this method
   * projects it onto the row. `null` is quarantine (usable by nobody).
   */
  setMachineOwner(id: string, ownerUserId: UserId | null): void {
    this.db.prepare('UPDATE machines SET owner_user_id = ? WHERE id = ?').run(ownerUserId, id)
  }

  deleteMachine(id: string): void {
    this.db.prepare('DELETE FROM machines WHERE id = ?').run(id)
  }

  touchMachine(id: string, hostname: string): void {
    this.db
      .prepare('UPDATE machines SET last_seen_at = ?, hostname = ? WHERE id = ?')
      .run(new Date().toISOString(), hostname, id)
  }
}
