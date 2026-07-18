import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import {
  MAINTENANCE_PROTOCOL_VERSION,
  MAINTENANCE_SCHEMA_VERSION,
  MaintenanceCommandReply,
  MaintenanceHandshakeReply,
  MessageExpiryObservation,
  messageExpiryRunKey,
  type MaintenanceCommand,
  type MaintenanceHandshake,
  type MessageExpiryObservation as ExpiryObservation,
} from '@podium/protocol'
import { stateDir } from '@podium/runtime/config'
import { openDatabase, type SqlDatabase } from '@podium/runtime/sqlite'
import { runTimeBudgetedJob } from '@podium/runtime/time-budget'

const CANDIDATE_LIMIT = 100
const CANDIDATE_PAGE_SIZE = 25
const LEASE_RENEW_AHEAD_MS = 30_000
const DEFAULT_TICK_MS = 30_000

type ReadyLease = Extract<MaintenanceHandshakeReply, { status: 'ready' }>

export interface ExpiryReadInput {
  now: string
  waitImplicitCutoff: string
  limit: number
}

export interface JanitorDeps {
  generationId?: string
  now?: () => number
  handshake(request: MaintenanceHandshake): Promise<MaintenanceHandshakeReply>
  readExpiryCandidates(input: ExpiryReadInput): ExpiryObservation[] | Promise<ExpiryObservation[]>
  apply(request: MaintenanceCommand): Promise<MaintenanceCommandReply>
}

/** A protocol/schema mismatch is terminal until this binary is upgraded. */
export class MaintenanceCompatibilityError extends Error {
  constructor(
    readonly expectedProtocolVersion: number,
    readonly expectedSchemaVersion: string,
  ) {
    super(
      `janitor compatibility mismatch (server protocol=${expectedProtocolVersion}, schema=${expectedSchemaVersion})`,
    )
    this.name = 'MaintenanceCompatibilityError'
  }
}

/** One fenced janitor generation. Durable facts are read locally; all writes are commands. */
export class JanitorService {
  private readonly generationId: string
  private readonly now: () => number
  private lease: ReadyLease | undefined
  private tickFlight: Promise<void> | undefined

  constructor(private readonly deps: JanitorDeps) {
    this.generationId = deps.generationId ?? `janitor_${randomUUID()}`
    this.now = deps.now ?? Date.now
  }

  tick(): Promise<void> {
    if (this.tickFlight) return this.tickFlight
    const flight = this.runTick()
    this.tickFlight = flight
    const clear = () => {
      if (this.tickFlight === flight) this.tickFlight = undefined
    }
    void flight.then(clear, clear)
    return flight
  }

  private async runTick(): Promise<void> {
    if (!this.lease || Date.parse(this.lease.expiresAt) <= this.now() + LEASE_RENEW_AHEAD_MS) {
      const reply = await this.deps.handshake({
        protocolVersion: MAINTENANCE_PROTOCOL_VERSION,
        schemaVersion: MAINTENANCE_SCHEMA_VERSION,
        generationId: this.generationId,
      })
      if (reply.status === 'incompatible') {
        this.lease = undefined
        throw new MaintenanceCompatibilityError(
          reply.expectedProtocolVersion,
          reply.expectedSchemaVersion,
        )
      }
      if (reply.status === 'busy') {
        this.lease = undefined
        return
      }
      this.lease = reply
    }

    const lease = this.lease
    const nowMs = this.now()
    const candidates = await this.deps.readExpiryCandidates({
      now: new Date(nowMs).toISOString(),
      waitImplicitCutoff: new Date(nowMs - lease.messageWaitTtlMs).toISOString(),
      limit: CANDIDATE_LIMIT,
    })
    for (const observed of candidates) {
      const reply = await this.deps.apply({
        protocolVersion: MAINTENANCE_PROTOCOL_VERSION,
        schemaVersion: MAINTENANCE_SCHEMA_VERSION,
        jobKind: 'message-expiry',
        runKey: messageExpiryRunKey(observed),
        fencingToken: lease.fencingToken,
        observed,
      })
      if (reply.status !== 'stale') continue
      if (reply.reason === 'incompatible') {
        this.lease = undefined
        throw new MaintenanceCompatibilityError(
          MAINTENANCE_PROTOCOL_VERSION,
          MAINTENANCE_SCHEMA_VERSION,
        )
      }
      if (reply.reason === 'fenced' || reply.reason === 'lease-expired') {
        this.lease = undefined
        break
      }
    }
  }
}

/** Read-only WAL candidate reader; never infers live session/runtime truth. */
export class MessageExpiryReader {
  constructor(private readonly db: SqlDatabase) {}

  async read(input: ExpiryReadInput): Promise<ExpiryObservation[]> {
    const candidates: ExpiryObservation[] = []
    let cursor: { createdAt: string; id: string } | undefined
    await runTimeBudgetedJob(() => {
      const remaining = input.limit - candidates.length
      if (remaining <= 0) return 'done'
      const pageSize = Math.min(CANDIDATE_PAGE_SIZE, remaining)
      const params: Array<string | number> = [input.now, input.waitImplicitCutoff]
      let after = ''
      if (cursor) {
        after = 'AND (created_at > ? OR (created_at = ? AND id > ?))'
        params.push(cursor.createdAt, cursor.createdAt, cursor.id)
      }
      params.push(pageSize)
      const rows = this.db
        .prepare(
          `SELECT id, status, lifecycle, created_at, expires_at
           FROM messages
           WHERE status = 'queued'
             AND (
               (expires_at IS NOT NULL AND expires_at <= ?)
               OR (expires_at IS NULL AND lifecycle = 'wait' AND created_at <= ?)
             )
             ${after}
           ORDER BY created_at ASC, id ASC
           LIMIT ?`,
        )
        .all(...params) as Record<string, unknown>[]
      for (const row of rows) {
        candidates.push(
          MessageExpiryObservation.parse({
            messageId: row.id,
            status: row.status,
            lifecycle: row.lifecycle,
            createdAt: row.created_at,
            expiresAt: row.expires_at,
          }),
        )
      }
      const last = rows.at(-1)
      if (!last || rows.length < pageSize || candidates.length >= input.limit) return 'done'
      cursor = { createdAt: last.created_at as string, id: last.id as string }
      return 'continue'
    })
    return candidates
  }
}

export interface MaintenanceHttpClient {
  handshake(request: MaintenanceHandshake): Promise<MaintenanceHandshakeReply>
  apply(request: MaintenanceCommand): Promise<MaintenanceCommandReply>
}

export function createMaintenanceHttpClient(
  serverUrl: string,
  token: string,
  fetchFn: typeof fetch = fetch,
): MaintenanceHttpClient {
  const base = serverUrl.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:').replace(/\/$/, '')
  const post = async (path: string, body: unknown): Promise<unknown> => {
    const response = await fetchFn(`${base}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    })
    const payload = await response.json()
    if (!response.ok) {
      throw new Error(`maintenance request failed (${response.status}): ${JSON.stringify(payload)}`)
    }
    return payload
  }
  return {
    handshake: async (request) =>
      MaintenanceHandshakeReply.parse(await post('/maintenance/handshake', request)),
    apply: async (request) =>
      MaintenanceCommandReply.parse(await post('/maintenance/command', request)),
  }
}

export interface JanitorHandle {
  service: JanitorService
  close(): void
}

export async function startJanitor(options: {
  serverUrl: string
  token: string
  dbPath?: string
  tickMs?: number
}): Promise<JanitorHandle> {
  const client = createMaintenanceHttpClient(options.serverUrl, options.token)
  const db = openDatabase(options.dbPath ?? join(stateDir(), 'podium.db'), { readOnly: true })
  db.exec('PRAGMA query_only = ON')
  db.exec('PRAGMA busy_timeout = 1000')
  const reader = new MessageExpiryReader(db)
  const service = new JanitorService({
    handshake: client.handshake,
    apply: client.apply,
    readExpiryCandidates: (input) => reader.read(input),
  })
  try {
    await service.tick()
  } catch (error) {
    if (error instanceof MaintenanceCompatibilityError) {
      db.close()
      throw error
    }
    console.warn('[podium:janitor] initial tick delayed:', error)
  }
  const timer = setInterval(() => {
    void service.tick().catch((error) => {
      if (error instanceof MaintenanceCompatibilityError) {
        console.error(`[podium:janitor] ${error.message}`)
        process.exit(78)
        return
      }
      console.warn('[podium:janitor] tick delayed:', error)
    })
  }, options.tickMs ?? DEFAULT_TICK_MS)
  timer.unref?.()
  return {
    service,
    close: () => {
      clearInterval(timer)
      db.close()
    },
  }
}
