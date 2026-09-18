import { createHash } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { readAppliedMigrations } from './migration-ledger'
import { UpdateGrantMessage, type UpdateStatusMessage, type UpdateTarget } from '@podium/protocol'
import { z } from 'zod'
import { UpdateGateError, type UpdateFailure } from './update-failure'

/** Pins the installed update across parent/server process boundaries. */
export const MACHINE_UPDATE_GRANT_ENV = 'PODIUM_MACHINE_UPDATE_GRANT'

export const MachineUpdatePhase = z.enum([
  'accepted',
  'downloading',
  'prepared',
  'activating',
  'restarting',
  'current',
  'rejected',
  'stuck',
  'canceled',
])
export type MachineUpdatePhase = z.infer<typeof MachineUpdatePhase>
const PreparedUpdate = z.object({
  digest: z.string(),
  releaseHadMigrations: z.boolean().optional(),
})
export type PreparedUpdate = z.infer<typeof PreparedUpdate>
// Admission identities are chosen by authenticated transports, not by grant fields.
// Keep retired coordinators: returning to an endpoint must not forget its stale fence.
const AuthorityHistory = z.object({
  watermarks: z.record(z.number().int().nonnegative()),
  // Format-1 journals predate authenticated provenance. Their unknown watermark
  // remains a floor for every previously unseen source; never guess from IDs.
  legacyFloor: z.number().int().nonnegative().optional(),
})
export type MachineUpdateAuthority =
  | { kind: 'local' }
  | { kind: 'coordinator'; serverUrl: string; isCurrent(): boolean }

function authorityDomain(authority?: MachineUpdateAuthority): string {
  if (!authority) return 'legacy'
  if (authority.kind === 'local') return 'local'
  if (!authority.isCurrent())
    throw new Error('unauthorized-target: coordinating connection is no longer current')
  const endpoint = new URL(authority.serverUrl)
  if (!['ws:', 'wss:'].includes(endpoint.protocol) || endpoint.username || endpoint.password)
    throw new Error('unauthorized-target: invalid coordinating endpoint')
  endpoint.hash = ''
  endpoint.pathname = endpoint.pathname.replace(/\/+$/, '')
  return `coordinator:${updateFingerprint(endpoint.href)}`
}

export const AppliedUpdateMigration = z.object({
  id: z.string().min(1),
  appliedAt: z.number().finite(),
})
export type AppliedUpdateMigration = z.infer<typeof AppliedUpdateMigration>
const MigrationReceipt = z.object({
  grantId: z.string(),
  appliedMigrations: z.array(AppliedUpdateMigration),
  // A durable intent closes the SQLite-commit / receipt-write crash window.
  pending: z
    .object({
      dbPath: z.string(),
      ids: z.array(z.string()),
      startedAt: z.number().finite(),
    })
    .optional(),
})

const Journal = z.object({
  format: z.literal(1),
  grant: UpdateGrantMessage,
  fingerprint: z.string(),
  previousVersion: z.string(),
  phase: MachineUpdatePhase,
  prepared: PreparedUpdate.optional(),
  appliedMigrations: z.array(AppliedUpdateMigration).default([]),
  detail: z.string().optional(),
  reasonCode: z.string().optional(),
  reportedVersion: z.string().optional(),
  percent: z.number().optional(),
  updatedAt: z.number(),
  completed: z.record(
    z.object({ fingerprint: z.string(), phase: MachineUpdatePhase, detail: z.string().optional(), reasonCode: z.string().optional(), reportedAt: z.number().optional(), version: z.string().optional() }),
  ),
  activationHeld: z.boolean().default(false),
  authority: z.number(),
  authorityHistory: AuthorityHistory.optional(),
  restarts: z.number().default(0),
})
export type MachineUpdateJournal = z.infer<typeof Journal>
const terminal = (phase: MachineUpdatePhase) =>
  ['current', 'rejected', 'stuck', 'canceled'].includes(phase)
const committed = (phase: MachineUpdatePhase) => ['activating', 'restarting'].includes(phase)

export type UpdateFingerprintInput =
  | string
  | UpdateTarget
  | UpdateGrantMessage
  | { target: UpdateTarget; repair: boolean }

/** Stable identity includes URLs, signatures, schema and trust, not just VERSION. */
export function updateFingerprint(value: UpdateFingerprintInput): string {
  const canonical = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(canonical)
    if (input && typeof input === 'object')
      return Object.fromEntries(
        Object.entries(input)
          .filter(([, v]) => v !== undefined)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => [k, canonical(v)]),
      )
    return input
  }
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex')
}
export function machineUpdateJournalPath(runtimeDir: string): string {
  return join(runtimeDir, 'machine-update.json')
}
export function readMachineUpdateJournal(runtimeDir: string): MachineUpdateJournal | undefined {
  const path = machineUpdateJournalPath(runtimeDir)
  if (!existsSync(path)) return undefined
  // Corrupt durable authority must fail closed, never become an empty history.
  const journal = Journal.parse(JSON.parse(readFileSync(path, 'utf8')))
  journal.appliedMigrations = appliedMigrationsForJournal(runtimeDir, journal)
  return journal
}

/**
 * Server writer and parent reader share <state>/runtime/machine-update-migrations/<sha256(grantId)>.json.
 * Separate from machine-update.json so the server cannot overwrite executor transitions.
 * Hashing keeps opaque grant IDs (including path separators) inside the runtime directory.
 */
export function machineUpdateMigrationsPath(runtimeDir: string, grantId: string): string {
  return join(runtimeDir, 'machine-update-migrations', createHash('sha256').update(grantId).digest('hex') + '.json')
}
function readMigrationReceipt(
  runtimeDir: string,
  grantId: string,
): z.infer<typeof MigrationReceipt> {
  const path = machineUpdateMigrationsPath(runtimeDir, grantId)
  if (!existsSync(path)) return { grantId, appliedMigrations: [] }
  const receipt = MigrationReceipt.parse(JSON.parse(readFileSync(path, 'utf8')))
  if (receipt.grantId !== grantId) throw new Error('migration receipt grant mismatch')
  return receipt
}
export function readAppliedUpdateMigrations(
  runtimeDir: string,
  grantId: string,
): AppliedUpdateMigration[] {
  const receipt = readMigrationReceipt(runtimeDir, grantId)
  const applied = new Map(receipt.appliedMigrations.map((entry) => [entry.id, entry]))
  if (receipt.pending) {
    // SQLite's committed ledger is the execution witness if the server died
    // between COMMIT and receipt publication. Never infer application from intent.
    const names = readAppliedMigrations(receipt.pending.dbPath)
    if (names === undefined) throw new Error('migration receipt database is missing')
    for (const id of receipt.pending.ids) {
      if (names.includes(id) && !applied.has(id))
        applied.set(id, { id, appliedAt: receipt.pending.startedAt })
    }
  }
  return [...applied.values()]
}

/** Brackets the migrator's transaction; call the returned function with only committed IDs. */
export function beginMachineUpdateMigrations(
  runtimeDir: string,
  grantId: string,
  dbPath: string,
  ids: string[],
  now = Date.now(),
): (appliedIds: string[]) => void {
  const appliedMigrations = readAppliedUpdateMigrations(runtimeDir, grantId)
  const path = machineUpdateMigrationsPath(runtimeDir, grantId)
  persistJson(path, { grantId, appliedMigrations, pending: { dbPath, ids, startedAt: now } })
  return (appliedIds) => {
    const applied = new Map(appliedMigrations.map((entry) => [entry.id, entry]))
    for (const id of appliedIds) {
      if (!applied.has(id)) applied.set(id, { id, appliedAt: Date.now() })
    }
    persistJson(path, { grantId, appliedMigrations: [...applied.values()] })
  }
}
function appliedMigrationsForJournal(
  runtimeDir: string,
  journal: MachineUpdateJournal,
): AppliedUpdateMigration[] {
  // The executor's checkpoint is a second durable copy of acknowledged receipts.
  // Preserve it even if a receipt file is subsequently lost; both belong to this grant.
  return [
    ...new Map(
      [
        ...readAppliedUpdateMigrations(runtimeDir, journal.grant.grantId),
        ...journal.appliedMigrations,
      ].map((entry) => [entry.id, entry]),
    ).values(),
  ]
}
function persist(runtimeDir: string, value: MachineUpdateJournal): void {
  persistJson(machineUpdateJournalPath(runtimeDir), value)
}
function persistJson(path: string, value: unknown): void {
  const runtimeDir = dirname(path)
  mkdirSync(runtimeDir, { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.tmp`
  const fd = openSync(temporary, 'w', 0o600)
  try {
    writeFileSync(fd, JSON.stringify(value))
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(temporary, path)
  // Windows does not expose directory handles through Node's openSync.
  if (process.platform === 'win32') return
  const directory = openSync(runtimeDir, 'r')
  try {
    fsyncSync(directory)
  } finally {
    closeSync(directory)
  }
}

/** The plain-service guard calls this only after the candidate exited and the
 * retained bundle was restored. Supervisor journals retain their own owner. */
export function recordLegacyMachineRollback(
  runtimeDir: string,
  grantId: string,
  detail: string,
): void {
  const journal = readMachineUpdateJournal(runtimeDir)
  if (!journal || journal.grant.grantId !== grantId || !committed(journal.phase)) return
  persist(runtimeDir, {
    ...journal,
    phase: 'stuck',
    detail,
    percent: undefined,
    updatedAt: Date.now(),
    completed: {
      ...journal.completed,
      [grantId]: { fingerprint: journal.fingerprint, phase: 'stuck', detail },
    },
  })
}

export interface MachineUpdateAdapter {
  select?(grant: UpdateGrantMessage): void
  /** Running process identity, captured at boot; never read VERSION after a swap. */
  runningVersion(): string
  runningDigest?(): string | undefined
  prepare(
    grant: UpdateGrantMessage,
    signal: AbortSignal,
    progress: (percent?: number) => void,
  ): Promise<PreparedUpdate>
  activate(grant: UpdateGrantMessage, prepared: PreparedUpdate): Promise<void>
  discard(): Promise<void>
  /** Completes only after real successor health, or exits the outgoing supervisor. */
  restart(grant: UpdateGrantMessage, prepared: PreparedUpdate): Promise<void | 'handover-pending'>
  /** Reconcile an interrupted atomic activation before children start. */
  recoverActivation?(grant: UpdateGrantMessage, prepared: PreparedUpdate): Promise<void>
}

/** Sole machine-local state machine. Connections and roles only forward commands/status. */
export class MachineUpdateExecutor {
  private journal: MachineUpdateJournal | undefined
  private unsolicited: UpdateStatusMessage | undefined
  private refusedGrants = new Map<string, UpdateStatusMessage>()
  private active: Promise<void> | undefined
  private abort: AbortController | undefined
  private admission: Promise<void> = Promise.resolve()
  constructor(
    private readonly deps: {
      runtimeDir: string
      adapter: MachineUpdateAdapter
      report(status: UpdateStatusMessage): void
      now?: () => number
      log?(phase: string, fields: Record<string, unknown>): void
    },
  ) {
    this.journal = readMachineUpdateJournal(deps.runtimeDir)
    if (this.journal) deps.adapter.select?.(this.journal.grant)
  }
  snapshot(): MachineUpdateJournal | undefined {
    if (!this.journal) return undefined
    return structuredClone({
      ...this.journal,
      appliedMigrations: appliedMigrationsForJournal(this.deps.runtimeDir, this.journal),
    })
  }
  private status(journal: MachineUpdateJournal): UpdateStatusMessage {
    const phase = journal.phase
    return {
      type: 'updateStatus',
      grantId: journal.grant.grantId,
      targetVersion: journal.grant.target.version,
      version: journal.reportedVersion ?? this.deps.adapter.runningVersion(),
      reasonCode: journal.reasonCode,
      reportedAt: journal.updatedAt,
      state:
        phase === 'current'
          ? 'current'
          : phase === 'stuck'
            ? 'stuck'
            : phase === 'rejected' || phase === 'canceled'
              ? 'rejected'
              : phase === 'activating' || phase === 'restarting'
                ? 'restarting'
                : 'downloading',
      phaseDetail: phase,
      ...(journal.detail ? { detail: journal.detail } : {}),
      ...(journal.percent !== undefined ? { percent: journal.percent } : {}),
    }
  }
  replay(): void {
    if (this.journal) this.deps.report(this.status(this.journal))
    for (const status of this.refusedGrants.values()) this.deps.report(status)
    if (this.unsolicited) this.deps.report(this.unsolicited)
  }
  /** Parent outcomes share the durable journal and reconnect replay with grants. */
  reportFailure(failure: UpdateFailure, version?: string): void {
    this.unsolicited = undefined
    if (this.journal) {
      if (this.journal.phase === 'stuck' && this.journal.reasonCode === failure.reasonCode && this.journal.detail === failure.detail) return
      this.transition('stuck', { ...failure, reportedVersion: version ?? this.deps.adapter.runningVersion() })
    }
    else {
      this.unsolicited = {
        type: 'updateStatus', state: 'stuck',
        version: version ?? this.deps.adapter.runningVersion(),
        ...failure, reportedAt: this.deps.now?.() ?? Date.now(),
      }
      this.replay()
    }
  }
  reportDaemonRefusal(reason?: string): void {
    if (this.journal && !terminal(this.journal.phase)) return
    if (!reason) {
      if (this.unsolicited?.reasonCode === 'daemon-refused') this.unsolicited = undefined
      return
    }
    const detail = `Daemon refused: ${reason}.`
    if (this.unsolicited?.detail === detail) return
    this.unsolicited = {
      type: 'updateStatus', state: 'current', version: this.deps.adapter.runningVersion(),
      reasonCode: 'daemon-refused', detail, reportedAt: this.deps.now?.() ?? Date.now(),
    }
    this.replay()
  }
  reportGrantRefusal(grant: UpdateGrantMessage, error: unknown): void {
    this.refusedGrants.set(grant.grantId, {
      type: 'updateStatus', grantId: grant.grantId, targetVersion: grant.target.version,
      version: this.deps.adapter.runningVersion(), state: 'rejected',
      reasonCode: 'grant-refused', detail: String(error), reportedAt: this.deps.now?.() ?? Date.now(),
    })
    this.replay()
  }
  private transition(phase: MachineUpdatePhase, patch: Partial<MachineUpdateJournal> = {}): void {
    if (!this.journal) throw new Error('no accepted update')
    this.journal = {
      ...this.journal,
      percent: undefined,
      ...patch,
      phase,
      updatedAt: this.deps.now?.() ?? Date.now(),
    }
    if (terminal(phase))
      this.journal.completed[this.journal.grant.grantId] = {
        fingerprint: this.journal.fingerprint,
        phase,
        reasonCode: this.journal.reasonCode,
        reportedAt: this.journal.updatedAt,
        version: this.journal.reportedVersion ?? this.deps.adapter.runningVersion(),
        ...(this.journal.detail ? { detail: this.journal.detail } : {}),
      }
    this.journal.appliedMigrations = appliedMigrationsForJournal(this.deps.runtimeDir, this.journal)
    persist(this.deps.runtimeDir, this.journal)
    this.deps.log?.(phase, {
      grantId: this.journal.grant.grantId,
      targetVersion: this.journal.grant.target.version,
      ...patch,
    })
    this.replay()
  }
  private async acquireAdmission(): Promise<() => void> {
    const previous = this.admission
    let release!: () => void
    this.admission = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    return release
  }
  async accept(
    raw: UpdateGrantMessage,
    waitForCompletion = true,
    holdActivation = false,
    authority?: MachineUpdateAuthority,
  ): Promise<void> {
    const release = await this.acquireAdmission()
    try {
      const domain = authorityDomain(authority)
      const grant = UpdateGrantMessage.parse(raw)
      const fingerprint = updateFingerprint({ target: grant.target, repair: grant.repair === true })
      const prior = this.journal
      if (prior?.grant.grantId === grant.grantId) {
        if (prior.fingerprint !== fingerprint)
          throw new Error('grant-id-conflict: exact target changed')
        this.replay()
        return waitForCompletion ? this.active : undefined
      }
      const completed = prior?.completed[grant.grantId]
      if (completed) {
        if (completed.fingerprint !== fingerprint)
          throw new Error('grant-id-conflict: exact target changed')
        this.deps.report({
          type: 'updateStatus',
          grantId: grant.grantId,
          targetVersion: grant.target.version,
          version: completed.version ?? this.deps.adapter.runningVersion(),
          state:
            completed.phase === 'current'
              ? 'current'
              : completed.phase === 'stuck'
                ? 'stuck'
                : 'rejected',
          phaseDetail: completed.phase,
          detail: completed.detail,
          reasonCode: completed.reasonCode,
          reportedAt: completed.reportedAt,
        })
        return
      }
      if (grant.issuedAt === undefined)
        throw new Error('unauthorized-target: supervisor requires dated exact authorization')
      const history: z.infer<typeof AuthorityHistory> = structuredClone(prior?.authorityHistory ?? {
        watermarks: {},
        ...(prior ? { legacyFloor: prior.authority } : {}),
      })
      const floor = domain === 'legacy'
        ? prior?.authority
        : Math.max(history.watermarks[domain] ?? -1, history.legacyFloor ?? -1)
      if (floor !== undefined && grant.issuedAt <= floor)
        throw new Error('stale-authorization: target predates accepted source authority')
      if (prior && (committed(prior.phase) || (this.active && terminal(prior.phase))))
        throw new Error('update-committed: activation must settle before another grant')
      if (prior && !terminal(prior.phase)) {
        await this.cancelAccepted(prior.grant.grantId)
        await this.active
      }
      // Cancellation can await I/O. A coordinator transferred away while queued
      // must not gain fresh authority after that await.
      authorityDomain(authority)
      history.watermarks[domain] = grant.issuedAt
      if (domain === 'legacy') history.legacyFloor = grant.issuedAt
      this.deps.adapter.select?.(grant)
      this.unsolicited = undefined
      this.refusedGrants.clear()
      this.journal = {
        format: 1,
        grant,
        fingerprint,
        previousVersion: this.deps.adapter.runningVersion(),
        phase: 'accepted',
        appliedMigrations: [],
        updatedAt: this.deps.now?.() ?? Date.now(),
        activationHeld: holdActivation,
        // Preserve the old reader's global fence when rolling back binaries.
        authority: Math.max(prior?.authority ?? 0, grant.issuedAt),
        authorityHistory: history,
        restarts: 0,
        completed: this.journal?.completed ?? {},
      }
      this.transition('accepted')
      const done = this.run()
      return waitForCompletion ? done : undefined
    } finally {
      release()
    }
  }
  async activate(grantId: string): Promise<void> {
    const release = await this.acquireAdmission()
    try {
      if (!this.journal || this.journal.grant.grantId !== grantId)
        throw new Error('activation grant does not match accepted authority')
      if (committed(this.journal.phase) || this.journal.phase === 'current') {
        this.replay()
        return
      }
      if (this.journal.phase !== 'prepared')
        throw new Error('activation requires a prepared exact target')
      this.transition('prepared', { activationHeld: false })
      void this.run()
    } finally {
      release()
    }
  }
  async cancel(grantId: string): Promise<boolean> {
    const release = await this.acquireAdmission()
    try {
      return await this.cancelAccepted(grantId)
    } finally {
      release()
    }
  }
  private async cancelAccepted(grantId: string): Promise<boolean> {
    if (!this.journal || this.journal.grant.grantId !== grantId) return false
    if (committed(this.journal.phase)) return false
    if (terminal(this.journal.phase)) return this.journal.phase === 'canceled'
    this.abort?.abort()
    await this.active
    await this.deps.adapter.discard()
    this.transition('canceled', { detail: 'Update canceled before activation.', reasonCode: 'update-canceled' })
    return true
  }
  private run(): Promise<void> {
    if (this.active) return this.active
    const abort = new AbortController()
    this.abort = abort
    const execute = async () => {
      try {
        let journal = this.journal!
        if (journal.phase === 'accepted' || journal.phase === 'downloading') {
          this.transition('downloading')
          const prepared = await this.deps.adapter.prepare(
            journal.grant,
            abort.signal,
            (percent) => {
              if (!abort.signal.aborted) this.transition('downloading', { percent })
            },
          )
          if (abort.signal.aborted) return
          this.transition('prepared', { prepared })
        }
        if (abort.signal.aborted) return
        journal = this.journal!
        if (!journal.prepared) throw new Error('missing prepared artifact identity')
        if (journal.phase === 'prepared' && journal.activationHeld) return
        if (journal.phase === 'prepared' || journal.phase === 'activating') {
          this.transition('activating')
          await this.deps.adapter.activate(journal.grant, journal.prepared)
          this.transition('restarting')
        }
        if (this.journal!.restarts >= 2)
          throw new Error(
            'Successor failed to confirm the authorized artifact after two restart attempts.',
          )
        this.transition('restarting', { restarts: this.journal!.restarts + 1 })
        const restart = await this.deps.adapter.restart(journal.grant, journal.prepared)
        if (restart === 'handover-pending') return
        // An adapter returning is not a version witness. Confirmation requires a
        // successor's boot-captured identity and its complete service health.
        // This run already owns execution. Re-entering public admission here
        // would deadlock with a cancellation waiting for this run to settle.
        await this.confirmJournalBoot(true)
      } catch (error) {
        if (abort.signal.aborted) return
        const detail = error instanceof Error ? error.message : String(error)
        // A rollback hook may already have recorded the more specific terminal cause.
        if (terminal(this.journal!.phase)) return
        this.transition(committed(this.journal!.phase) ? 'stuck' : 'rejected', {
          detail,
          reasonCode: error instanceof UpdateGateError ? error.reasonCode : 'update-failed',
        })
      }
    }
    const done = execute().finally(() => {
      if (this.active === done) {
        this.active = undefined
        this.abort = undefined
      }
    })
    this.active = done
    return done
  }
  async recoverBeforeBoot(): Promise<void> {
    const release = await this.acquireAdmission()
    try {
      if (this.active) return this.active
      const journal = this.journal
      if (journal?.phase === 'activating' && journal.prepared) {
        try {
          await this.deps.adapter.recoverActivation?.(journal.grant, journal.prepared)
        } catch (error) {
          this.transition('stuck', { detail: String(error), reasonCode: 'activation-recovery-failed' })
        }
      }
    } finally {
      release()
    }
  }
  async confirmBoot(healthy: boolean, signal?: AbortSignal): Promise<void> {
    const release = await this.acquireAdmission()
    try {
      // A boot observer can wait behind recovery/admission while its parent is
      // stopping. It must not replay, recover, or confirm after losing ownership.
      if (signal?.aborted) return
      // A grant can arrive before parent startup finishes. Join its owner rather
      // than replacing its abort controller or touching its shared staging.
      // Return (do not await) so cancellation can acquire admission while we wait.
      if (this.active) return this.active
      return this.confirmJournalBoot(healthy)
    } finally {
      release()
    }
  }
  /** Called under admission, or by the active run after its restart completes. */
  private async confirmJournalBoot(healthy: boolean): Promise<void> {
    const journal = this.journal
    if (!journal || terminal(journal.phase)) {
      this.replay()
      return
    }
    if (committed(journal.phase)) {
      if (!healthy) return
      const identityMatches =
        this.deps.adapter.runningVersion() === journal.grant.target.version &&
        this.deps.adapter.runningDigest?.() === journal.prepared?.digest
      if (identityMatches) this.transition('current', { reasonCode: 'update-current', detail: `Update confirmed on version ${journal.grant.target.version}.` })
      else if (this.active)
        this.transition('stuck', {
          detail: 'Successor running artifact identity does not match the authorized target.',
          reasonCode: 'successor-wrong-artifact',
        })
      else return this.run()
      return
    }
    // Restarting before activation preserves the exact authorization, not a feed lookup.
    return this.run()
  }
}
