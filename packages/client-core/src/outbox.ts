/**
 * Storage-neutral client outbox (docs/spec/outbox-write-path.md §2.3): a small
 * durable FIFO of covered mutations. Writes enqueue here after optimistic local
 * apply and drain sequentially with stable mutation IDs, so replay after reload
 * or reconnect is a server-side no-op.
 *
 * DEAD-LETTER RECOVERY (POD-316, ADR 3 D9). This queue used to `shift()` a
 * poison entry and hand it to a toast — the "silent poison-drop" D9 invariant 1
 * forbids by name, and POD-279 finding 8 calls the worst gap in the write path.
 * A definitive refusal now PARKS the entry in a durable third home with a reason
 * code, and the user recovers it (retry / edit / discard) instead of watching
 * their words disappear.
 *
 * The reason and recovery vocabulary is IMPORTED from the sync kernel
 * (`@podium/sync/outbox`, POD-370) rather than restated. That is the point: the
 * kernel is where `unauthorized` is merged with `target-not-found` so the
 * failure surface carries no existence oracle (amendment property 15), and a
 * second copy of that merge on the client is a second place for it to drift
 * open. This module classifies a transport error and delegates every judgement
 * about what it MEANS.
 */

import {
  type AuthorityRefusal,
  MAX_AGE_REASON,
  normalizeRefusal,
  type OutboxRejectionReason,
  type RecoveryPlan,
  type RetrySatisfaction,
  recoveryPlanFor,
  satisfies,
} from '@podium/sync/outbox'
import { randomUUID } from './id'

/** One queued mutation. `input` is the exact tRPC input, minus `mutationId`. */
export interface OutboxEntry {
  mutationId: string
  kind: string
  input: unknown
  queuedAt: number
  /** Durable overlay stage (#263 review finding 1): absent/undefined = queued;
   *  'awaiting-truth' = the executor resolved but the caller asked (via
   *  onApplied returning true) to keep the entry until covering server truth
   *  lands — it is excluded from the drain queue and deleted only by
   *  `retireAwaiting`. Surviving in storage is the point: a reload inside the
   *  resolution→truth window restores the optimistic overlay. */
  state?: 'awaiting-truth' | 'dead-letter'
  /** Epoch ms when the executor resolved (stamped on the awaiting transition). */
  resolvedAt?: number
  /** Present exactly when `state === 'dead-letter'`: why it parked and when.
   *  Lives on the entry so the park reuses the one durable storage seam. */
  deadLetter?: {
    reason: OutboxRejectionReason
    parkedFrom: 'rejected' | 'expired'
    deadLetteredAt: number
    attempts: number
  }
  /** Opaque caller annotation captured at enqueue (#263 review finding 2): the
   *  engine stores the target row's replica fingerprint here so resolution can
   *  tell whether server truth already moved while the mutation was in flight. */
  baseline?: string
  /** True when a same-row entry (queued or awaiting) already existed at ENQUEUE
   *  time (#263 review round 2): the predecessor's echo will move the row past
   *  this entry's baseline before this one resolves, and reading that movement
   *  as "a competing writer won" would wrongly drop this entry's overlay. */
  chained?: boolean
}

/**
 * One entry parked for user recovery (ADR 3 D9 `dead-letter`).
 *
 * It carries the author's own `input` verbatim and NOTHING about the target.
 * That is a privacy requirement, not an economy: an entry can be parked
 * precisely because the principal lost visibility of the target while offline,
 * and a recovery surface that re-read the target to show "what you were editing"
 * would hand back the very content the revocation removed.
 */
export interface OutboxDeadLetterEntry {
  readonly entry: OutboxEntry
  /** Kernel-normalized: `unauthorized` here already covers rights-denied,
   *  invisible AND nonexistent, indistinguishably. */
  readonly reason: OutboxRejectionReason
  /** Which of D9's two paths parked it. */
  readonly parkedFrom: 'rejected' | 'expired'
  readonly deadLetteredAt: number
  readonly attempts: number
}

/**
 * The dead-letter home is an ordinary `OutboxStorage` over a THIRD collection,
 * for the reason spelled out on `OutboxStorage`: an older build reads a
 * collection it understands and drains every row in it, so a parked entry left
 * in the queued home would be replayed as live work — exactly the boolean-split
 * defect POD-1220 caught in the kernel's storage adapter.
 *
 * Reusing the existing seam rather than inventing a typed second one is
 * deliberate: the replica already owns durable, cross-tab, SQLite-and-
 * localStorage-backed homes of this exact shape, with a migration path and loud
 * failure logging. A parallel store would have to re-earn all of that, and the
 * durability is the whole point of parking.
 */
export function parseDeadLetterEntries(raw: string | null): OutboxDeadLetterEntry[] {
  return parseOutboxEntries(raw).flatMap((e) => {
    const parked = toDeadLetter(e)
    return parked ? [parked] : []
  })
}

/** The persisted form: an ordinary entry carrying its park metadata, marked with
 *  a `state` no drain path accepts. */
function toStoredEntry(parked: OutboxDeadLetterEntry): OutboxEntry {
  return {
    ...parked.entry,
    state: 'dead-letter',
    deadLetter: {
      reason: parked.reason,
      parkedFrom: parked.parkedFrom,
      deadLetteredAt: parked.deadLetteredAt,
      attempts: parked.attempts,
    },
  }
}

/** Reads the persisted form back, or `undefined` when the row is not a park.
 *  Returning a third value rather than a boolean is the POD-1220 rule: an
 *  unrecognised row must be visibly unhandled, never absorbed into the active
 *  arm. */
function toDeadLetter(entry: OutboxEntry): OutboxDeadLetterEntry | undefined {
  const meta = entry.deadLetter
  if (entry.state !== 'dead-letter' || !meta) return undefined
  const { deadLetter: _omit, ...rest } = entry
  return {
    entry: { ...rest, state: undefined },
    reason: meta.reason,
    parkedFrom: meta.parkedFrom,
    deadLetteredAt: meta.deadLetteredAt,
    attempts: meta.attempts,
  }
}

/** Storage seam — platform adapters own localStorage, AsyncStorage, SQLite, etc.
 *  QUEUED entries live here. Awaiting-truth entries live in a SEPARATE
 *  `awaitingStorage` (#263 review round 2): an OLD build (PWA cache rollback)
 *  reads this collection and drains EVERY row it finds — it predates the
 *  `state` field, so an awaiting-marked row left here would be replayed as a
 *  queued mutation, resurrecting stale renames/archives past the server's
 *  dedup retention. Old builds never read the awaiting home. */
export interface OutboxStorage {
  load(): OutboxEntry[]
  save(entries: OutboxEntry[]): void
}

/** Legacy web localStorage key for the pre-replica outbox blob. The replica's
 *  outbox collection migrates it in on first use (see replica/replica.ts). */
export const OUTBOX_LS_KEY = 'podium.outbox.v1'

/** Browser 'online' events when a window exists; undefined elsewhere (RN/SSR). */
export function platformOnlineEvents(): OnlineEvents | undefined {
  if (typeof window === 'undefined') return undefined
  return {
    add: (cb) => window.addEventListener('online', cb),
    remove: (cb) => window.removeEventListener('online', cb),
  }
}

/** navigator.onLine when available; optimistic (true) elsewhere. */
export function platformIsOnline(): boolean {
  return typeof navigator === 'undefined' || navigator.onLine !== false
}

export interface OnlineEvents {
  add(cb: () => void): void
  remove(cb: () => void): void
}

/** A corrupt/foreign blob reads as empty rather than wedging the queue. */
export function parseOutboxEntries(raw: string | null): OutboxEntry[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (e): e is OutboxEntry =>
        !!e &&
        typeof e === 'object' &&
        typeof (e as OutboxEntry).mutationId === 'string' &&
        typeof (e as OutboxEntry).kind === 'string' &&
        typeof (e as OutboxEntry).queuedAt === 'number',
    )
  } catch {
    return []
  }
}

/**
 * A tRPC input-validation rejection can never succeed on retry; retrying it
 * forever would wedge the queue behind a poison entry. Matched structurally
 * rather than by instanceof, so a batched/wrapped error still classifies.
 *
 * Retained as the `invalid` arm of `classifyRefusal` — it is not the whole
 * story, and believing it was is what left every OTHER definitive refusal
 * retrying forever (see below).
 */
function isPoisonError(err: unknown): boolean {
  const data = (err as { data?: { httpStatus?: number; code?: string } } | null)?.data
  return data?.httpStatus === 400 || data?.code === 'BAD_REQUEST'
}

/**
 * WHAT THE AUTHORITY TOLD US, in the kernel's vocabulary.
 *
 * ADR 3 D10 splits drain failures in two and gives them opposite handling:
 * *transient* (network, unreachable authority) retries until the age limit,
 * *definitive* (validation, policy, conflict) gets **zero** automatic retries
 * and dead-letters immediately. This function is where a transport error is
 * sorted into that split, and it was previously a one-armed test: only
 * `BAD_REQUEST` counted as definitive, so an apply-time re-authorization
 * refusal (D8/D16 — the central multi-user case) and a stale-`expectedRevision`
 * conflict (D13.3 — routine traffic once two people share a surface) both fell
 * through to `scheduleRetry()` and hammered a server that would refuse them
 * identically forever, wedging their partition behind them.
 *
 * Returning `undefined` means *transient*, and that is deliberately the arm a
 * code we do not recognise lands in: an unknown refusal must keep the user's
 * work queued and retryable rather than park it on a guess.
 */
export function classifyRefusal(err: unknown): AuthorityRefusal | undefined {
  const data = (err as { data?: { httpStatus?: number; code?: string } } | null)?.data
  const code = data?.code
  const status = data?.httpStatus
  if (code === 'UNAUTHORIZED' || code === 'FORBIDDEN' || status === 401 || status === 403) {
    // D16.4 / property 15: rights denied, target invisible and target
    // nonexistent are ONE code by the time anything durable or renderable sees
    // them. `normalizeRefusal` performs the merge; classifying `NOT_FOUND` into
    // the same arm here is what stops a 404-vs-403 split re-opening the
    // existence oracle upstream of it.
    return { kind: 'unauthorized' }
  }
  if (code === 'NOT_FOUND' || status === 404) return { kind: 'target-not-found' }
  if (code === 'CONFLICT' || status === 409) return { kind: 'conflict' }
  if (code === 'PRECONDITION_FAILED' || status === 412) {
    // ADR 3 D2's out-of-scope path: `--outside-scope`/`overrideScope` failures
    // arrive as PRECONDITION_FAILED, and D8 outcome 3 names the recovery — a
    // durable confirmation on the envelope, not an edit and not a rebase.
    return { kind: 'confirmation-required' }
  }
  if (isPoisonError(err)) return { kind: 'invalid' }
  return undefined
}

/** Kind -> tRPC-input map; executors receive the input plus the entry's mutationId. */
export type OutboxExecutors<M extends Record<string, object>> = {
  [K in keyof M]: (input: M[K] & { mutationId: string }) => Promise<unknown>
}

export interface OutboxInit<M extends Record<string, object>> {
  executors: OutboxExecutors<M>
  /**
   * A definitively-refused entry surfaces here — app adapters wire it to UI.
   *
   * The name is kept for its existing callers, but the BEHAVIOUR behind it
   * changed: the entry is no longer dropped when this fires. It is parked in the
   * dead-letter home and remains recoverable, so a listener that treated this as
   * "your change is gone" should now read it as "your change needs you".
   */
  onPoison?: (entry: OutboxEntry, error: unknown) => void
  /** Fires when an entry parks, with the recovery the reason licenses. This is
   *  the callback a dead-letter surface should use: `onPoison` cannot express
   *  the reason code, and re-deriving one from the raw error at the UI is how
   *  two answers to "why did this fail" come to exist. */
  onDeadLetter?: (parked: OutboxDeadLetterEntry) => void
  /** Fires after an entry's executor resolved and the entry left the queue,
   *  BEFORE subscribers observe the new size — so an overlay handoff (#263:
   *  queued → awaiting server truth) can happen with no intermediate state in
   *  which the entry is in neither stage. Return `true` to HOLD the entry in
   *  the durable awaiting-truth stage (kept in storage with
   *  state:'awaiting-truth' + resolvedAt; released via `retireAwaiting`);
   *  any other return value deletes it, the pre-#263-review behavior. Must not
   *  throw (guarded anyway — a throw deletes). */
  onApplied?: (entry: OutboxEntry) => unknown
  storage: OutboxStorage
  /** Durable home for the awaiting-truth stage, SEPARATE from `storage` (#263
   *  review round 2 — see the OutboxStorage note): a downgraded build reads
   *  only the queued collection, so held entries can never be re-drained as
   *  queued mutations. Any state:'awaiting-truth' rows still found in the
   *  legacy `storage` are adopted here on load and deleted there. When absent
   *  (older adapters/tests), awaiting entries are held in MEMORY only — the
   *  reload-repaint durability is lost, but the legacy collection stays clean. */
  awaitingStorage?: OutboxStorage
  /**
   * Durable home for parked entries. When ABSENT the park still happens and the
   * entry is still recoverable in this process, but it does not survive a
   * reload — so an adapter that omits it has a durability gap, not a behaviour
   * difference, and `onDeadLetter` fires either way. Platform adapters should
   * always supply one; it is optional only so that existing test doubles and
   * older adapters keep compiling rather than silently losing the park.
   */
  deadLetterStorage?: OutboxStorage
  /** Flat retry cadence while entries remain after a network failure. */
  retryMs?: number
  /** Injectable for tests/adapters; defaults to online when unknown. */
  isOnline?: () => boolean
  now?: () => number
  randomId?: () => string
  onlineEvents?: OnlineEvents
}

export class Outbox<M extends Record<string, object>> {
  /** The queued FIFO — entries still waiting for a successful send. */
  private entries: OutboxEntry[]
  /** Resolved entries held durably until covering server truth lands (#263
   *  review finding 1). Not part of the drain queue; persisted in the separate
   *  `awaitingStorage` home (never in `storage` — old builds re-drain it). */
  private awaitingEntries: OutboxEntry[]
  /** Parked for recovery (D9 `dead-letter`). Never drained, never dropped. */
  private deadLetterEntries: OutboxDeadLetterEntry[]
  private readonly storage: OutboxStorage
  private readonly awaitingStorage: OutboxStorage | undefined
  private readonly deadLetterStorage: OutboxStorage | undefined
  private readonly retryMs: number
  private readonly now: () => number
  private readonly randomId: () => string
  private readonly subs = new Set<(size: number) => void>()
  private drainPromise: Promise<void> | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  /** True after dispose() until the next attach(). Hard-stops every storage
   *  write and aborts a drain between steps: a provider recreation constructs
   *  the REPLACEMENT outbox before disposing this one over the same storage,
   *  and an in-flight drain completing after dispose must not persist its
   *  stale queue over the successor's (it could silently delete a mutation the
   *  successor just enqueued). */
  private disposed = false
  private readonly onOnline = (): void => void this.drain()

  constructor(private readonly init: OutboxInit<M>) {
    this.storage = init.storage
    this.awaitingStorage = init.awaitingStorage
    this.deadLetterStorage = init.deadLetterStorage
    this.retryMs = init.retryMs ?? 5000
    const loaded = this.storage.load()
    // ENUMERATED, not `!== 'awaiting-truth'`. The old form was a claim that the
    // queued home holds exactly two kinds of row, and the moment a third state
    // exists anywhere the `else` arm absorbs it INTO THE DRAIN QUEUE — the
    // failure POD-1220 found live in the kernel's storage adapter, where entries
    // the attribution gate had refused came back as drainable work. Dead-letter
    // rows are kept out of this home entirely, so today the enumeration is
    // total; writing it as an enumeration is what keeps it total tomorrow.
    this.entries = loaded.filter((e) => e.state === undefined)
    // Migration (#263 review round 2): a PREVIOUS build persisted awaiting
    // entries in the queued collection (state-marked). Adopt them into the
    // separate awaiting home and delete them from the legacy collection — an
    // old build reading it after a rollback must never re-drain them.
    const legacyAwaiting = loaded.filter((e) => e.state === 'awaiting-truth')
    const adopted = this.awaitingStorage?.load() ?? []
    const have = new Set(adopted.map((e) => e.mutationId))
    this.awaitingEntries = [...adopted, ...legacyAwaiting.filter((e) => !have.has(e.mutationId))]
    if (legacyAwaiting.length > 0) {
      this.storage.save(this.entries)
      this.saveAwaiting()
    }
    this.deadLetterEntries = (this.deadLetterStorage?.load() ?? []).flatMap((e) => {
      const parked = toDeadLetter(e)
      return parked ? [parked] : []
    })
    this.now = init.now ?? Date.now
    this.randomId = init.randomId ?? randomUUID
    this.attach()
  }

  /** Arm drain triggers. Idempotent as long as the adapter treats duplicate
   *  callbacks as no-ops. Re-arms persistence after a dispose() (the engine
   *  re-starts the SAME outbox across a StrictMode dispose/start cycle). */
  attach(): void {
    this.disposed = false
    this.init.onlineEvents?.add(this.onOnline)
    if (this.entries.length > 0 && this.online()) queueMicrotask(() => void this.drain())
  }

  enqueue<K extends keyof M & string>(
    kind: K,
    input: M[K],
    opts?: { baseline?: string; chained?: boolean },
  ): OutboxEntry {
    const entry: OutboxEntry = {
      mutationId: this.randomId(),
      kind,
      input,
      queuedAt: this.now(),
      ...(opts?.baseline !== undefined ? { baseline: opts.baseline } : {}),
      ...(opts?.chained === true ? { chained: true } : {}),
    }
    this.entries.push(entry)
    this.persist()
    if (this.online()) void this.drain()
    return entry
  }

  size(): number {
    return this.entries.length
  }

  /** Snapshot of the queued entries, FIFO. The pending queue IS the optimistic
   *  overlay (#263): the engine projects these into per-entity patches. */
  pending(): OutboxEntry[] {
    return [...this.entries]
  }

  /** Snapshot of the durable awaiting-truth stage (#263 review finding 1), in
   *  resolution order. The engine restores these into its overlay on boot. */
  awaiting(): OutboxEntry[] {
    return [...this.awaitingEntries]
  }

  /** Retire (delete durably) one awaiting-truth entry — covering server truth
   *  landed, or the caller gave up on it (TTL). No-op for unknown ids, so a
   *  re-entrant retirement during a repaint cascade converges. Saves WITHOUT
   *  notifying subscribers: the queued size didn't change, and a notification
   *  here would recompute the caller's overlays mid-retirement — promoting a
   *  younger same-row awaiting entry to "oldest" (escape-eligible) within the
   *  SAME pass, exactly what the oldest-first rule exists to prevent. */
  retireAwaiting(mutationId: string): void {
    const idx = this.awaitingEntries.findIndex((e) => e.mutationId === mutationId)
    if (idx === -1) return
    this.awaitingEntries.splice(idx, 1)
    this.saveAwaiting()
  }

  // ---- Dead-letter recovery (ADR 3 D9 invariants 1–3) ---------------------

  /** Everything parked for recovery, oldest first. */
  deadLetters(): OutboxDeadLetterEntry[] {
    return [...this.deadLetterEntries]
  }

  /** What the UI may offer for a parked entry. Derived from the reason CODE
   *  alone, via the kernel's own mapping — so two entries with the same code
   *  offer byte-identical affordances. That is not tidiness: withholding a
   *  button for one flavour of `unauthorized` would let the existence oracle the
   *  kernel carefully closed leak back out through the button row. */
  recoveryFor(mutationId: string): RecoveryPlan | undefined {
    const parked = this.deadLetterEntries.find((d) => d.entry.mutationId === mutationId)
    return parked ? recoveryPlanFor(parked.reason.code) : undefined
  }

  /**
   * Re-queue a parked entry once its precondition is satisfied.
   *
   * The precondition is ENFORCED, not advertised: `satisfies()` refuses a
   * mismatch, so an authorization denial cannot be waved through with a rebase
   * and the UI structurally cannot offer a button that reproduces the same
   * rejection. `max-age` demands a fresh `mutationId` (D11.4 — the old id may
   * still have a receipt) and the caller supplies it in the satisfaction.
   */
  retry(mutationId: string, satisfaction: RetrySatisfaction): OutboxEntry {
    const idx = this.deadLetterEntries.findIndex((d) => d.entry.mutationId === mutationId)
    const parked = this.deadLetterEntries[idx]
    if (idx === -1 || !parked) throw new Error(`no dead-letter entry ${mutationId}`)
    const plan = recoveryPlanFor(parked.reason.code)
    if (!satisfies(plan.retry, satisfaction)) {
      throw new Error(
        `dead-letter ${mutationId} needs ${plan.retry} before it can be retried; refusing to re-queue an entry that would be refused identically`,
      )
    }
    const requeued: OutboxEntry =
      'mutationId' in satisfaction
        ? { ...parked.entry, mutationId: satisfaction.mutationId, queuedAt: this.now() }
        : { ...parked.entry }
    this.deadLetterEntries.splice(idx, 1)
    this.saveDeadLetters()
    this.entries.push(requeued)
    this.persist()
    if (this.online()) void this.drain()
    return requeued
  }

  /**
   * Revise a parked entry's input and re-queue it. Always available for every
   * reason code (`RecoveryPlan.edit` is `true` by construction) — the ONLY
   * recovery an `invalid` entry has, and kept available for `unauthorized` so
   * the affordance set never varies with the flavour of denial.
   */
  edit(mutationId: string, input: unknown): OutboxEntry {
    const idx = this.deadLetterEntries.findIndex((d) => d.entry.mutationId === mutationId)
    const parked = this.deadLetterEntries[idx]
    if (idx === -1 || !parked) throw new Error(`no dead-letter entry ${mutationId}`)
    // A NEW id: the edited command is a different command, and re-using the id
    // would let a receipt for the original suppress it (D11.4/D11.7).
    const revised: OutboxEntry = {
      ...parked.entry,
      mutationId: this.randomId(),
      input,
      queuedAt: this.now(),
    }
    this.deadLetterEntries.splice(idx, 1)
    this.saveDeadLetters()
    this.entries.push(revised)
    this.persist()
    if (this.online()) void this.drain()
    return revised
  }

  /** The user's own decision to let the work go — D9 `cancelled`, and one of the
   *  only two licences to make it gone. Works with no read of the target, so it
   *  stays available for an entity the author can no longer see. */
  discard(mutationId: string): boolean {
    const idx = this.deadLetterEntries.findIndex((d) => d.entry.mutationId === mutationId)
    if (idx === -1) return false
    this.deadLetterEntries.splice(idx, 1)
    this.saveDeadLetters()
    this.persist()
    return true
  }

  /**
   * Park an entry that aged out (D10: `expired` → `dead-letter`, reason
   * `max-age`). Separate from a rejection because the recovery differs — an
   * expired entry needs a NEW `mutationId`, since the original may still hold a
   * receipt at the Authority (D11.4).
   */
  sweepExpired(maxAgeMs: number): OutboxDeadLetterEntry[] {
    const cutoff = this.now() - maxAgeMs
    const aged = this.entries.filter((e) => e.queuedAt < cutoff)
    if (aged.length === 0) return []
    this.entries = this.entries.filter((e) => e.queuedAt >= cutoff)
    const parked = aged.map((e) => this.park(e, MAX_AGE_REASON, 'expired'))
    this.persist()
    return parked
  }

  private park(
    entry: OutboxEntry,
    reason: OutboxRejectionReason,
    parkedFrom: 'rejected' | 'expired',
  ): OutboxDeadLetterEntry {
    const parked: OutboxDeadLetterEntry = {
      entry,
      reason,
      parkedFrom,
      deadLetteredAt: this.now(),
      attempts: 1,
    }
    this.deadLetterEntries.push(parked)
    this.saveDeadLetters()
    this.init.onDeadLetter?.(parked)
    return parked
  }

  private saveDeadLetters(): void {
    if (this.disposed) return
    this.deadLetterStorage?.save(this.deadLetterEntries.map(toStoredEntry))
  }

  /** Reactive size for pending-changes indicators. */
  subscribe(cb: (size: number) => void): () => void {
    this.subs.add(cb)
    return () => this.subs.delete(cb)
  }

  /** Call when the hub link recovers; platform online events alone miss server restarts. */
  notifyConnected(): void {
    void this.drain()
  }

  /**
   * Sequential FIFO drain, single-flight. Poison entries drop + surface; any
   * other failure keeps the entry and arms a flat retry timer.
   */
  drain(): Promise<void> {
    if (!this.drainPromise) {
      this.drainPromise = this.drainPass().finally(() => {
        this.drainPromise = null
      })
    }
    return this.drainPromise
  }

  dispose(): void {
    this.disposed = true
    this.init.onlineEvents?.remove(this.onOnline)
    this.clearRetry()
  }

  private async drainPass(): Promise<void> {
    this.clearRetry()
    while (this.entries.length > 0) {
      if (this.disposed) return
      const entry = this.entries[0] as OutboxEntry
      try {
        const exec = this.init.executors[entry.kind as keyof M]
        if (!exec) {
          throw Object.assign(new Error(`unknown outbox kind: ${entry.kind}`), {
            data: { code: 'BAD_REQUEST' },
          })
        }
        await exec({ ...(entry.input as M[keyof M]), mutationId: entry.mutationId })
      } catch (err) {
        // Disposed mid-flight: the successor owns the queue now — no writes,
        // no retry timer. The entry replays there, deduped by mutationId.
        if (this.disposed) return
        const refusal = classifyRefusal(err)
        if (refusal) {
          // DEFINITIVE (D10: zero automatic retries). The entry leaves the drain
          // queue — it would refuse identically forever and block its partition —
          // but it is PARKED, not dropped. D9 invariant 1: the only two licences
          // to make user-authored work gone are a successful apply and the user's
          // own discard, and neither of those is this.
          this.entries.shift()
          this.park(entry, normalizeRefusal(refusal), 'rejected')
          this.persist()
          this.init.onPoison?.(entry, err)
          continue
        }
        // TRANSIENT, including every refusal shape we do not recognise: keep the
        // work queued and retry (D9 invariant 4 — a network failure is not a
        // rejection).
        this.scheduleRetry()
        return
      }
      // Same abort AFTER a successful send: the mutation applied server-side,
      // but persisting the shift would clobber the successor's storage; leave
      // the entry for an idempotent (mutationId-deduped) replay instead.
      if (this.disposed) return
      this.entries.shift()
      let hold = false
      try {
        hold = this.init.onApplied?.(entry) === true
      } catch {
        // an overlay listener must never wedge the drain
      }
      if (hold) {
        // Durable awaiting-truth transition (#263 review finding 1): keep the
        // entry in the awaiting home — a reload before covering truth lands
        // restores the overlay instead of flashing stale replica truth. It
        // moves OUT of the queued collection entirely (round 2): a downgraded
        // build reading that collection must never re-drain a held entry.
        this.awaitingEntries.push({ ...entry, state: 'awaiting-truth', resolvedAt: this.now() })
        this.saveAwaiting()
      }
      this.persist()
    }
  }

  private online(): boolean {
    return this.init.isOnline?.() ?? true
  }

  /**
   * NOTIFY EVEN WHEN THE DURABLE WRITE REFUSED (POD-1231).
   *
   * `save()` throws when the store denies the write — at quota, most often. The
   * throw is deliberate and stays: a caller must not believe a queued write is
   * safe when it is not. But notifying subscribers AFTER it meant the throw
   * skipped the notification, and the entry that was already in `this.entries`
   * became invisible to every count and badge derived from it. Measured on the
   * kernel side cache at a real byte ceiling: five entries in memory, four
   * notifications, four rows on disk. The one write the user could not be told
   * about was the one that needed telling.
   *
   * The subscriber sees the in-memory size, which is the true one — the entry
   * exists and will still drain this session. Durability is a separate claim,
   * carried by the throw and by `OutboxNotDurableError`, and conflating the two
   * is what made a lost write look like a queue that had never grown.
   */
  private persist(): void {
    if (this.disposed) return
    try {
      this.save()
    } finally {
      for (const cb of this.subs) cb(this.entries.length)
    }
  }

  private save(): void {
    if (this.disposed) return
    // QUEUED entries only — the awaiting stage persists via saveAwaiting()
    // into its own storage. Subscribers see the QUEUED size only.
    this.storage.save([...this.entries])
  }

  private saveAwaiting(): void {
    if (this.disposed) return
    // FIFO = resolution order; blob-shaped storages preserve save order.
    this.awaitingStorage?.save([...this.awaitingEntries])
  }

  private scheduleRetry(): void {
    if (this.retryTimer) return
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      void this.drain()
    }, this.retryMs)
  }

  private clearRetry(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
  }
}

export function createOutbox<M extends Record<string, object>>(init: OutboxInit<M>): Outbox<M> {
  return new Outbox(init)
}
