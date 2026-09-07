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
import { join } from 'node:path'
import { UpdateGrantMessage, type UpdateStatusMessage } from '@podium/protocol'
import { z } from 'zod'

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

const Journal = z.object({
  format: z.literal(1),
  grant: UpdateGrantMessage,
  fingerprint: z.string(),
  previousVersion: z.string(),
  phase: MachineUpdatePhase,
  prepared: PreparedUpdate.optional(),
  detail: z.string().optional(),
  percent: z.number().optional(),
  updatedAt: z.number(),
  completed: z.record(
    z.object({ fingerprint: z.string(), phase: MachineUpdatePhase, detail: z.string().optional() }),
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

/** Stable identity includes URLs, signatures, schema and trust, not just VERSION. */
export function updateFingerprint(value: unknown): string {
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
  return Journal.parse(JSON.parse(readFileSync(path, 'utf8')))
}
function persist(runtimeDir: string, value: MachineUpdateJournal): void {
  mkdirSync(runtimeDir, { recursive: true, mode: 0o700 })
  const path = machineUpdateJournalPath(runtimeDir)
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
    return this.journal && structuredClone(this.journal)
  }
  private status(journal: MachineUpdateJournal): UpdateStatusMessage {
    const phase = journal.phase
    return {
      type: 'updateStatus',
      grantId: journal.grant.grantId,
      targetVersion: journal.grant.target.version,
      version: this.deps.adapter.runningVersion(),
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
        ...(this.journal.detail ? { detail: this.journal.detail } : {}),
      }
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
          version: this.deps.adapter.runningVersion(),
          state:
            completed.phase === 'current'
              ? 'current'
              : completed.phase === 'stuck'
                ? 'stuck'
                : 'rejected',
          phaseDetail: completed.phase,
          detail: completed.detail,
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
      if (prior && committed(prior.phase))
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
      this.journal = {
        format: 1,
        grant,
        fingerprint,
        previousVersion: this.deps.adapter.runningVersion(),
        phase: 'accepted',
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
    this.transition('canceled', { detail: 'Update canceled before activation.' })
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
        this.transition(committed(this.journal!.phase) ? 'stuck' : 'rejected', { detail })
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
          this.transition('stuck', { detail: String(error) })
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
      if (identityMatches) this.transition('current')
      else if (this.active)
        this.transition('stuck', {
          detail: 'Successor running artifact identity does not match the authorized target.',
        })
      else return this.run()
      return
    }
    // Restarting before activation preserves the exact authorization, not a feed lookup.
    return this.run()
  }
}
